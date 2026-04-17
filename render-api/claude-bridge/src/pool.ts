import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import pLimit, { LimitFunction } from 'p-limit';
import { EventEmitter } from 'events';
import { config } from './config';
import { log } from './log';
import { ClaudeSession, SessionTurnResult, SessionStreamEvent } from './session';

// Session pool keyed by sha256(system_prompt). Each unique system prompt gets
// its own warm Claude session. LRU evicts idle sessions past poolSize.
//
// A single session handles turns serially (the CLI is a REPL). Cross-session
// parallelism is capped by a global p-limit so we don't blow subscription
// concurrency.

export function hashSystemPrompt(system: string): string {
  return createHash('sha256').update(system).digest('hex');
}

export class SessionPool {
  private cache: LRUCache<string, ClaudeSession>;
  private concurrency: LimitFunction;

  constructor() {
    this.cache = new LRUCache<string, ClaudeSession>({
      max: config.poolSize,
      dispose: (session, key, reason) => {
        if (reason === 'evict' || reason === 'delete') {
          log.info('pool.evict', { hash: key.slice(0, 8), reason, turns: session.turns() });
          session.kill(`evicted:${reason}`);
        }
      },
    });
    this.concurrency = pLimit(config.concurrency);
  }

  /** Pre-warm one session with an empty-ish system prompt. */
  async prewarm(): Promise<void> {
    const warmer = 'You are a helpful assistant.';
    const hash = hashSystemPrompt(warmer);
    const session = this.getOrCreate(warmer, hash);
    await session.waitReady();
    // Fire a tiny ping turn to ensure the full pipeline works.
    try {
      await this.concurrency(() => session.sendTurn('ping'));
      log.info('pool.prewarm_ok');
    } catch (err) {
      log.warn('pool.prewarm_failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Run a turn against the session keyed by this system prompt. */
  async run(
    systemPrompt: string,
    userContent: string | unknown[],
    streamEmitter?: EventEmitter,
  ): Promise<SessionTurnResult> {
    const hash = hashSystemPrompt(systemPrompt);
    return this.concurrency(() => this.runOn(systemPrompt, hash, userContent, streamEmitter));
  }

  private async runOn(
    systemPrompt: string,
    hash: string,
    userContent: string | unknown[],
    streamEmitter?: EventEmitter,
  ): Promise<SessionTurnResult> {
    // Retire if needed, then get or create a fresh session.
    let session = this.cache.get(hash);
    if (session && session.shouldRetire()) {
      log.info('pool.retire', { hash: hash.slice(0, 8), turns: session.turns() });
      this.cache.delete(hash); // triggers dispose → kill
      session = undefined;
    }
    if (!session) session = this.getOrCreate(systemPrompt, hash);
    await session.waitReady();

    try {
      return await session.sendTurn(userContent, streamEmitter);
    } catch (err) {
      // If the session died, drop it so the next caller gets a fresh one.
      if (!session.isAlive()) {
        this.cache.delete(hash);
      }
      throw err;
    }
  }

  private getOrCreate(systemPrompt: string, hash: string): ClaudeSession {
    const existing = this.cache.get(hash);
    if (existing && existing.isAlive()) return existing;
    const session = new ClaudeSession(systemPrompt, hash);
    this.cache.set(hash, session);
    return session;
  }

  /** Gracefully shut down every session. */
  async drain(timeoutMs: number = 60000): Promise<void> {
    const start = Date.now();
    log.info('pool.drain_start', { size: this.cache.size });
    while (this.cache.size > 0 && Date.now() - start < timeoutMs) {
      // Wait for any busy session to finish before killing.
      const anyBusy = [...this.cache.values()].some((s) => s.isBusy());
      if (!anyBusy) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    for (const key of [...this.cache.keys()]) this.cache.delete(key);
    log.info('pool.drain_done', { elapsedMs: Date.now() - start });
  }
}

export type { SessionStreamEvent };
