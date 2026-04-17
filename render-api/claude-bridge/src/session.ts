import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { EventEmitter } from 'events';
import { config } from './config';
import { log } from './log';
import type { CliEvent, CliResultEvent, CliRateLimitEvent, CliAssistantEvent } from './types';

// A single long-running Claude Code session. Wraps a spawned `claude` process
// running `--input-format stream-json --output-format stream-json --verbose`.
//
// Communication model:
//  - stdin:  one user-message JSON per line
//  - stdout: multiple event objects per turn; bridge reads until it sees a
//            `result` event matching the current turn's request id
//
// Session is single-turn-at-a-time. Pool ensures only one send() is in flight
// at a time per session.

export class RateLimitError extends Error {
  constructor(public info: CliRateLimitEvent['rate_limit_info']) {
    super(`Claude Code rate limit: ${info.status} (resets at ${new Date(info.resetsAt * 1000).toISOString()})`);
    this.name = 'RateLimitError';
  }
}

export class SessionDeadError extends Error {
  constructor(reason: string) {
    super(`Claude session exited: ${reason}`);
    this.name = 'SessionDeadError';
  }
}

export interface SessionTurnResult {
  text: string;
  usage: CliResultEvent['usage'];
  stopReason: string;
  sessionId: string;
  durationMs: number;
}

export interface SessionStreamEvent {
  type: 'text_delta' | 'done';
  text?: string;
}

interface PendingTurn {
  resolve: (r: SessionTurnResult) => void;
  reject: (e: Error) => void;
  chunks: string[];
  startedAt: number;
  streamEmitter?: EventEmitter;
  timeoutId: NodeJS.Timeout;
}

export class ClaudeSession {
  private proc: ChildProcessWithoutNullStreams;
  private dead = false;
  private turnsCompleted = 0;
  private lastCacheCreationTokens = 0;
  private currentTurn: PendingTurn | null = null;

  readonly systemPromptHash: string;
  readonly sessionTag: string;
  private readonly spawnedAt = Date.now();

  constructor(systemPrompt: string, systemPromptHash: string) {
    this.systemPromptHash = systemPromptHash;
    this.sessionTag = `${systemPromptHash.slice(0, 8)}-${Date.now().toString(36)}`;

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', config.forceModel,
      '--effort', config.forceEffort,
      '--system-prompt', systemPrompt,
      '--allowedTools', '',           // disable all tools — text-only + vision via content blocks
      '--no-session-persistence',     // don't write session files to disk
      '--disable-slash-commands',     // skip plugin slash-command discovery
      '--strict-mcp-config',          // ignore all MCP configs on disk
      '--mcp-config', '{"mcpServers":{}}', // explicit empty MCP
      '--setting-sources', '',        // no user/project/local settings merging
    ];

    log.info('session.spawn', { tag: this.sessionTag, model: config.forceModel, effort: config.forceEffort });

    // Strip ANTHROPIC_API_KEY from the child env. Claude Code prefers env API
    // keys over OAuth credentials; leaving it in forces per-token billing.
    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;

    this.proc = spawn(config.claudeBin, args, {
      cwd: config.workdir,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.wireStdout();
    this.wireStderr();
    this.wireExit();
  }

  /**
   * Claude Code emits the `init` event AFTER receiving a user message, not at
   * process spawn. The session is usable as soon as the process is alive;
   * the first turn pays whatever warm-up cost exists.
   */
  async waitReady(): Promise<void> {
    if (this.dead) throw new SessionDeadError('process died before first turn');
  }

  /** Age of the session in ms. */
  ageMs(): number {
    return Date.now() - this.spawnedAt;
  }

  /** True if the session is beyond its retirement threshold. */
  shouldRetire(): boolean {
    if (this.dead) return true;
    if (this.turnsCompleted >= config.maxTurnsPerSession) return true;
    if (this.lastCacheCreationTokens >= config.maxCacheTokens) return true;
    return false;
  }

  isAlive(): boolean {
    return !this.dead;
  }

  isBusy(): boolean {
    return this.currentTurn !== null;
  }

  turns(): number {
    return this.turnsCompleted;
  }

  /**
   * Send a user-message object (already Anthropic-shape content) and await
   * the `result` event. If `streamEmitter` is provided, deltas are also
   * emitted live via 'text_delta' / 'done' events.
   */
  async sendTurn(
    userMessageContent: string | unknown[],
    streamEmitter?: EventEmitter,
  ): Promise<SessionTurnResult> {
    if (this.dead) throw new SessionDeadError('cannot send to dead session');
    if (this.currentTurn) throw new Error('session is busy — serialize calls at the pool level');

    const event = {
      type: 'user' as const,
      message: {
        role: 'user' as const,
        content: userMessageContent,
      },
    };

    return new Promise<SessionTurnResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        log.warn('session.turn_timeout', { tag: this.sessionTag, elapsedMs: Date.now() - this.currentTurn!.startedAt });
        this.kill('turn_timeout');
        reject(new Error(`session turn timed out after ${config.requestTimeoutMs}ms`));
      }, config.requestTimeoutMs);

      this.currentTurn = {
        resolve,
        reject,
        chunks: [],
        startedAt: Date.now(),
        streamEmitter,
        timeoutId,
      };

      try {
        this.proc.stdin.write(JSON.stringify(event) + '\n');
      } catch (err) {
        clearTimeout(timeoutId);
        this.currentTurn = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  kill(reason: string): void {
    if (this.dead) return;
    log.warn('session.kill', { tag: this.sessionTag, reason });
    try {
      this.proc.kill('SIGTERM');
      setTimeout(() => {
        if (!this.dead) this.proc.kill('SIGKILL');
      }, 5000).unref();
    } catch {
      // ignore
    }
  }

  private wireStdout() {
    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let ev: CliEvent;
      try {
        ev = JSON.parse(line);
      } catch {
        log.warn('session.parse_error', { tag: this.sessionTag, bytes: line.length });
        return;
      }
      this.handleEvent(ev);
    });
  }

  private wireStderr() {
    this.proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) log.warn('session.stderr', { tag: this.sessionTag, preview: text.slice(0, 200) });
    });
  }

  private wireExit() {
    this.proc.on('exit', (code, signal) => {
      this.dead = true;
      log.info('session.exit', { tag: this.sessionTag, code, signal: signal ?? null, turns: this.turnsCompleted });

      const turn = this.currentTurn;
      this.currentTurn = null;
      if (turn) {
        clearTimeout(turn.timeoutId);
        turn.reject(new SessionDeadError(`exit code=${code ?? 'null'} signal=${signal ?? 'null'}`));
      }
    });

    this.proc.on('error', (err) => {
      log.error('session.process_error', { tag: this.sessionTag, err: err.message });
    });
  }

  private handleEvent(ev: CliEvent) {
    if (!this.currentTurn) {
      // stray event outside a turn — fine, just ignore
      return;
    }

    switch (ev.type) {
      case 'assistant':
        this.handleAssistant(ev as CliAssistantEvent);
        break;
      case 'rate_limit_event':
        this.handleRateLimit(ev as CliRateLimitEvent);
        break;
      case 'result':
        this.handleResult(ev as CliResultEvent);
        break;
      default:
        // system hooks, init, etc. — ignore
        break;
    }
  }

  private handleAssistant(ev: CliAssistantEvent) {
    const turn = this.currentTurn!;
    for (const block of ev.message.content) {
      if (block.type === 'text') {
        turn.chunks.push(block.text);
        turn.streamEmitter?.emit('event', {
          type: 'text_delta',
          text: block.text,
        } satisfies SessionStreamEvent);
      }
      // thinking blocks are intentionally dropped
    }
  }

  private handleRateLimit(ev: CliRateLimitEvent) {
    if (ev.rate_limit_info.status === 'allowed') return; // informational
    const turn = this.currentTurn!;
    clearTimeout(turn.timeoutId);
    this.currentTurn = null;
    turn.reject(new RateLimitError(ev.rate_limit_info));
  }

  private handleResult(ev: CliResultEvent) {
    const turn = this.currentTurn!;
    clearTimeout(turn.timeoutId);
    this.currentTurn = null;
    this.turnsCompleted += 1;
    this.lastCacheCreationTokens = ev.usage.cache_creation_input_tokens ?? this.lastCacheCreationTokens;

    if (ev.is_error) {
      turn.reject(new Error(`claude session error: ${ev.subtype} — ${ev.result}`));
      return;
    }

    const text = ev.result ?? turn.chunks.join('');
    turn.streamEmitter?.emit('event', { type: 'done' } satisfies SessionStreamEvent);
    turn.resolve({
      text,
      usage: ev.usage,
      stopReason: ev.stop_reason,
      sessionId: ev.session_id,
      durationMs: ev.duration_ms,
    });
  }
}
