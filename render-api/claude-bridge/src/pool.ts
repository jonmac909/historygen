import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { EventEmitter } from 'events';
import { config } from './config';
import { log } from './log';
import { ClaudeSession, SessionTurnResult, SessionStreamEvent } from './session';

// Session pool keyed by sha256(system_prompt). Each unique system prompt gets
// its own warm Claude session. LRU evicts idle sessions past poolSize.
//
// Sessions handle turns serially (the CLI is a REPL). When multiple callers
// target the same system prompt, a per-session queue serializes them so they
// wait in line instead of failing with "session is busy".

export function hashSystemPrompt(system: string): string {
  return createHash('sha256').update(system).digest('hex');
}

export class SessionPool {
  private cache: LRUCache<string, ClaudeSession>;
  private queues = new Map<string, Promise<unknown>>();

  constructor() {
    this.cache = new LRUCache<string, ClaudeSession>({
      max: config.poolSize,
      dispose: (session, key, reason) => {
        if (reason === 'evict' || reason === 'delete') {
          log.info('pool.evict', { hash: key.slice(0, 8), reason, turns: session.turns() });
          session.kill(`evicted:${reason}`);
          this.queues.delete(key);
        }
      },
    });
  }

  /** Pre-warm one session with an empty-ish system prompt. */
  async prewarm(): Promise<void> {
    const warmer = 'You are a helpful assistant.';
    const hash = hashSystemPrompt(warmer);
    const session = this.getOrCreate(warmer, hash);
    await session.waitReady();
    try {
      await this.enqueue(hash, () => session.sendTurn('ping'));
      log.info('pool.prewarm_ok');
    } catch (err) {
      log.warn('pool.prewarm_failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Run a turn against the session keyed by system prompt + model. */
  async run(
    systemPrompt: string,
    userContent: string | unknown[],
    streamEmitter?: EventEmitter,
    model?: string,
  ): Promise<SessionTurnResult> {
    const hash = hashSystemPrompt(systemPrompt + (model ?? ''));
    return this.enqueue(hash, () => this.runOn(systemPrompt, hash, userContent, streamEmitter, model));
  }

  /**
   * Per-session serial queue. Chains each call onto the previous one so
   * callers wait in line instead of throwing "session is busy". Different
   * system-prompt hashes run independently (true parallelism across sessions).
   */
  private enqueue<T>(hash: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(hash) ?? Promise.resolve();
    const depth = this.queueDepth(hash);
    if (depth > 0) {
      log.info('pool.queued', { hash: hash.slice(0, 8), depth });
    }
    const next = prev.catch(() => {}).then(fn);
    this.queues.set(hash, next);
    next.finally(() => {
      if (this.queues.get(hash) === next) this.queues.delete(hash);
    });
    return next;
  }

  private queueDepth(hash: string): number {
    return this.queues.has(hash) ? 1 : 0;
  }

  private async runOn(
    systemPrompt: string,
    hash: string,
    userContent: string | unknown[],
    streamEmitter?: EventEmitter,
    model?: string,
  ): Promise<SessionTurnResult> {
    let session = this.cache.get(hash);
    if (session && session.shouldRetire()) {
      log.info('pool.retire', { hash: hash.slice(0, 8), turns: session.turns() });
      this.cache.delete(hash);
      session = undefined;
    }
    if (!session) session = this.getOrCreate(systemPrompt, hash, model);
    await session.waitReady();

    try {
      return await session.sendTurn(userContent, streamEmitter);
    } catch (err) {
      if (!session.isAlive()) {
        this.cache.delete(hash);
      }
      throw err;
    }
  }

  private getOrCreate(systemPrompt: string, hash: string, model?: string): ClaudeSession {
    const existing = this.cache.get(hash);
    if (existing && existing.isAlive()) return existing;
    const session = new ClaudeSession(systemPrompt, hash, model);
    this.cache.set(hash, session);
    return session;
  }

  /** Gracefully shut down every session. */
  async drain(timeoutMs: number = 60000): Promise<void> {
    const start = Date.now();
    log.info('pool.drain_start', { size: this.cache.size });
    while (this.cache.size > 0 && Date.now() - start < timeoutMs) {
      const anyBusy = [...this.cache.values()].some((s) => s.isBusy());
      if (!anyBusy) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    for (const key of [...this.cache.keys()]) this.cache.delete(key);
    this.queues.clear();
    log.info('pool.drain_done', { elapsedMs: Date.now() - start });
  }
}

export type { SessionStreamEvent };
