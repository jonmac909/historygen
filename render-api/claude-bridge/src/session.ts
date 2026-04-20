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
  lastActivityAt: number;
  streamEmitter?: EventEmitter;
  // Absolute cap — never resets. Catches pathologically long turns.
  maxTimeoutId: NodeJS.Timeout;
  // Resets on every stdout line from Claude. Catches real stuck sessions
  // without killing slow-but-streaming ones.
  idleTimeoutId: NodeJS.Timeout;
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

  readonly model: string;

  constructor(systemPrompt: string, systemPromptHash: string, model?: string) {
    this.systemPromptHash = systemPromptHash;
    this.model = model || config.defaultModel;
    this.sessionTag = `${systemPromptHash.slice(0, 8)}-${Date.now().toString(36)}`;

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', this.model,
      '--effort', config.defaultEffort,
      '--system-prompt', systemPrompt,
      '--allowedTools', '',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '',
    ];

    log.info('session.spawn', { tag: this.sessionTag, model: this.model, effort: config.defaultEffort });

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
      const maxTimeoutId = setTimeout(() => {
        const turn = this.currentTurn;
        if (!turn) return;
        log.warn('session.max_timeout', {
          tag: this.sessionTag,
          elapsedMs: Date.now() - turn.startedAt,
        });
        this.kill('max_timeout');
        reject(new Error(`session turn exceeded max duration ${config.requestTimeoutMs}ms`));
      }, config.requestTimeoutMs);

      const idleTimeoutId = setTimeout(() => {
        const turn = this.currentTurn;
        if (!turn) return;
        log.warn('session.idle_timeout', {
          tag: this.sessionTag,
          silentMs: Date.now() - turn.lastActivityAt,
          elapsedMs: Date.now() - turn.startedAt,
        });
        this.kill('idle_timeout');
        reject(new Error(`session idle for ${config.idleTimeoutMs}ms — no output from Claude`));
      }, config.idleTimeoutMs);

      const now = Date.now();
      this.currentTurn = {
        resolve,
        reject,
        chunks: [],
        startedAt: now,
        lastActivityAt: now,
        streamEmitter,
        maxTimeoutId,
        idleTimeoutId,
      };

      try {
        this.proc.stdin.write(JSON.stringify(event) + '\n');
      } catch (err) {
        clearTimeout(maxTimeoutId);
        clearTimeout(idleTimeoutId);
        this.currentTurn = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Reset the idle (no-activity) timer. Called on every stdout line from
   * Claude so that slow-but-streaming turns are not mistaken for stuck ones.
   * The absolute max timer is NOT reset — it remains the hard ceiling.
   */
  private resetIdleTimer(): void {
    const turn = this.currentTurn;
    if (!turn) return;
    clearTimeout(turn.idleTimeoutId);
    turn.lastActivityAt = Date.now();
    turn.idleTimeoutId = setTimeout(() => {
      if (!this.currentTurn) return;
      log.warn('session.idle_timeout', {
        tag: this.sessionTag,
        silentMs: Date.now() - this.currentTurn.lastActivityAt,
        elapsedMs: Date.now() - this.currentTurn.startedAt,
      });
      this.kill('idle_timeout');
      this.currentTurn.reject(new Error(`session idle for ${config.idleTimeoutMs}ms — no output from Claude`));
    }, config.idleTimeoutMs);
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
      // Any line from Claude's stdout — parseable or not, text or system
      // event — counts as activity and resets the idle timer. Treats
      // "streaming slowly" as distinct from "stuck".
      this.resetIdleTimer();
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
        clearTimeout(turn.maxTimeoutId);
        clearTimeout(turn.idleTimeoutId);
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
    clearTimeout(turn.maxTimeoutId);
    clearTimeout(turn.idleTimeoutId);
    this.currentTurn = null;
    turn.reject(new RateLimitError(ev.rate_limit_info));
  }

  private handleResult(ev: CliResultEvent) {
    const turn = this.currentTurn!;
    clearTimeout(turn.maxTimeoutId);
    clearTimeout(turn.idleTimeoutId);
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
