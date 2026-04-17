import express, { Request, Response } from 'express';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import * as path from 'path';
import { config } from './config';
import { log } from './log';
import { SessionPool } from './pool';
import { RateLimitError } from './session';
import type { CreateRequest } from './types';
import {
  buildSystemPrompt,
  extractUserContent,
  toSdkResponse,
  wantsJson,
} from './request-mapper';

const pool = new SessionPool();
let prewarmedAt = 0;

const app = express();
app.use(express.json({ limit: '50mb' })); // images arrive as base64 in body

// Health gates on pool warm-up having completed recently. Render-api proxies
// this via GET /bridge/health for Railway's liveness check.
app.get('/health', (_req, res) => {
  const fresh = prewarmedAt > 0 && Date.now() - prewarmedAt < 120_000;
  if (fresh) return res.json({ status: 'ok', prewarmedAt });
  return res.status(503).json({ status: 'warming', prewarmedAt });
});

// Non-streaming path. Mirrors anthropic.messages.create() in + out shape.
app.post('/messages', async (req: Request, res: Response) => {
  const body = req.body as CreateRequest;
  const reqId = randomId();
  const startedAt = Date.now();
  try {
    const systemPrompt = buildSystemPrompt(body);
    const userContent = extractUserContent(body.messages);
    log.info('req.start', {
      req_id: reqId,
      route: '/messages',
      system_hash: hashPreview(systemPrompt),
      messages: body.messages.length,
      wants_json: wantsJson(body),
    });

    const turn = await pool.run(systemPrompt, userContent);
    const sdkResponse = toSdkResponse(turn, config.forceModel);
    log.info('req.ok', {
      req_id: reqId,
      duration_ms: Date.now() - startedAt,
      claude_duration_ms: turn.durationMs,
      input_tokens: sdkResponse.usage.input_tokens,
      output_tokens: sdkResponse.usage.output_tokens,
      cache_read: sdkResponse.usage.cache_read_input_tokens ?? 0,
    });
    res.json(sdkResponse);
  } catch (err) {
    handleError(res, err, reqId, startedAt);
  }
});

// Streaming path. Emits Server-Sent Events matching SDK stream async-iterator
// events (message_start, content_block_delta, message_stop).
app.post('/messages/stream', async (req: Request, res: Response) => {
  const body = req.body as CreateRequest;
  const reqId = randomId();
  const startedAt = Date.now();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const sse = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    const systemPrompt = buildSystemPrompt(body);
    const userContent = extractUserContent(body.messages);
    log.info('req.start', { req_id: reqId, route: '/messages/stream' });

    const emitter = new EventEmitter();
    const msgId = `msg_bridge_${randomId()}`;
    sse({ type: 'message_start', message: { id: msgId, role: 'assistant', model: config.forceModel } });
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });

    emitter.on('event', (ev: { type: 'text_delta' | 'done'; text?: string }) => {
      if (ev.type === 'text_delta' && ev.text) {
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: ev.text },
        });
      }
    });

    const turn = await pool.run(systemPrompt, userContent, emitter);
    sse({ type: 'content_block_stop', index: 0 });
    sse({
      type: 'message_delta',
      delta: { stop_reason: turn.stopReason },
      usage: { output_tokens: turn.usage.output_tokens ?? 0 },
    });
    sse({ type: 'message_stop' });
    res.end();

    log.info('req.ok', { req_id: reqId, duration_ms: Date.now() - startedAt });
  } catch (err) {
    // Emit a best-effort error frame; caller needs to detect.
    const message = err instanceof Error ? err.message : 'unknown error';
    sse({ type: 'error', error: { type: err instanceof RateLimitError ? 'rate_limit' : 'bridge_error', message } });
    res.end();
    log.error('req.err', { req_id: reqId, duration_ms: Date.now() - startedAt, err: message });
  }
});

function handleError(res: Response, err: unknown, reqId: string, startedAt: number) {
  const duration = Date.now() - startedAt;
  if (err instanceof RateLimitError) {
    const retryAfter = Math.max(1, err.info.resetsAt - Math.floor(Date.now() / 1000));
    log.warn('req.rate_limit', { req_id: reqId, duration_ms: duration, retry_after_sec: retryAfter });
    res.status(429).set('Retry-After', String(retryAfter)).json({
      error: { type: 'rate_limit_error', message: err.message, retry_after: retryAfter },
    });
    return;
  }
  const message = err instanceof Error ? err.message : 'unknown error';
  log.error('req.err', { req_id: reqId, duration_ms: duration, err: message });
  res.status(500).json({ error: { type: 'bridge_error', message } });
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function hashPreview(s: string): string {
  return s.length > 20 ? s.slice(0, 20) + '…' : s;
}

async function ensureTmpDirs() {
  await fs.mkdir(config.workdir, { recursive: true });
  await fs.mkdir(config.tmpDir, { recursive: true });
}

// Write ~/.claude/.credentials.json from $CLAUDE_CODE_OAUTH_TOKEN so the CLI
// authenticates against the user's Claude.ai subscription (not a per-token
// API key). On macOS, Claude Code reads credentials from the keychain under
// the entry "Claude Code-credentials"; on Linux it falls back to the dotfile.
// Schema matches what `claude setup-token` actually writes:
//   { "claudeAiOauth": { "accessToken", "refreshToken", "expiresAt", ... } }
async function writeOAuthCredentials() {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (!token) {
    log.warn('bridge.no_oauth_token', { hint: 'set CLAUDE_CODE_OAUTH_TOKEN on Railway to enable subscription auth' });
    return;
  }
  const home = process.env.HOME || '/root';
  const dir = path.join(home, '.claude');
  const file = path.join(dir, '.credentials.json');
  const payload = {
    claudeAiOauth: {
      accessToken: token,
      refreshToken: '',
      // `claude setup-token` issues long-lived tokens. Stamp a far-future expiry
      // so the CLI doesn't short-circuit on an apparent expiration.
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      scopes: [
        'user:file_upload',
        'user:inference',
        'user:mcp_servers',
        'user:profile',
        'user:sessions:claude_code',
      ],
      subscriptionType: 'max',
    },
  };
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(payload), { mode: 0o600 });
  log.info('bridge.credentials_written', { path: file, mode: '0600' });
}

async function main() {
  await ensureTmpDirs();
  await writeOAuthCredentials();

  const server = app.listen(config.port, config.host, () => {
    log.info('bridge.listening', { host: config.host, port: config.port });
  });

  // Pre-warm one session so the first real request skips cold boot.
  pool
    .prewarm()
    .then(() => {
      prewarmedAt = Date.now();
    })
    .catch((err) => log.warn('bridge.prewarm_failed', { err: err.message }));

  // Graceful drain on SIGTERM (Railway deploy).
  const shutdown = async (signal: string) => {
    log.info('bridge.shutdown', { signal });
    server.close();
    await pool.drain(60_000);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Hourly temp sweep (gap #8).
  setInterval(() => {
    sweepTmp(config.tmpDir).catch((err) => log.warn('tmp.sweep_failed', { err: err.message }));
  }, 60 * 60 * 1000).unref();
}

async function sweepTmp(dir: string) {
  const now = Date.now();
  const cutoff = 30 * 60 * 1000;
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return;
  }
  let removed = 0;
  for (const name of files) {
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      if (stat.isFile() && now - stat.mtimeMs > cutoff) {
        await fs.unlink(full);
        removed += 1;
      }
    } catch {
      // ignore individual file errors
    }
  }
  if (removed > 0) log.info('tmp.swept', { removed });
}

main().catch((err) => {
  log.error('bridge.fatal', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
