// Load .env BEFORE any other import — content-moderator.ts and other route
// modules call env-reading factories (e.g. createAnthropicClient) at module
// load time. The previous `dotenv.config()` at line ~51 ran AFTER those
// imports already executed, so env vars were always empty during boot.
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

import { initPotProvider } from './lib/pot-provider';
import {
  corsAllowedOrigins,
  apiKeyRequired,
  internalApiKey,
  rateLimitMax,
  rateLimitWindowMs,
  localInferenceConfig,
} from './lib/runtime-config';
import { ASSET_KINDS } from './lib/local-asset-writer';
import rewriteScriptRouter from './routes/rewrite-script';
import generateAudioRouter from './routes/generate-audio';
import generateImagesRouter from './routes/generate-images';
import getYoutubeTranscriptRouter from './routes/get-youtube-transcript';
import generateCaptionsRouter from './routes/generate-captions';
import renderVideoRouter from './routes/render-video';
import generateImagePromptsRouter from './routes/generate-image-prompts';
import generateThumbnailsRouter from './routes/generate-thumbnails';
import youtubeUploadRouter from './routes/youtube-upload';
import pronunciationRouter from './routes/pronunciation';
import generateYoutubeMetadataRouter from './routes/generate-youtube-metadata';
import youtubeChannelStatsRouter from './routes/youtube-channel-stats';
import youtubeChannelApifyRouter from './routes/youtube-channel-apify';
import youtubeChannelInvidiousRouter from './routes/youtube-channel-invidious';
import youtubeChannelYtdlpRouter from './routes/youtube-channel-ytdlp';
import nicheAnalyzeRouter from './routes/niche-analyze';
import generateClipPromptsRouter from './routes/generate-clip-prompts';
import generateVideoClipsRouter from './routes/generate-video-clips';
import bulkChannelsRouter from './routes/bulk-channels';
import analyzeThumbnailRouter from './routes/analyze-thumbnail';
import rewriteTitleRouter from './routes/rewrite-title';
import autoCloneRouter from './routes/auto-clone';
import costsRouter from './routes/costs';
import videoAnalysisRouter from './routes/video-analysis';
import visionTestRouter from './routes/vision-test';
import videoEditorRouter from './routes/video-editor';
import fullPipelineRouter from './routes/full-pipeline';
import scanImagesRouter from './routes/scan-images';
import generateShortHooksRouter from './routes/generate-short-hooks';
import generateShortRouter from './routes/generate-short';
import renderShortRouter from './routes/render-short';
import deleteProjectImagesRouter from './routes/delete-project-images';
import scanScriptsRouter from './routes/scan-scripts';

dotenv.config();

// -----------------------------------------------------------------------------
// Boot-time guards (Phase 2.5 of local-inference-swap)
//
// 1. Hard-fail if LOCAL_INFERENCE is enabled in production — this mode is
//    intended for the developer's local GPU host only; serving real traffic
//    from localhost-bound model servers is a footgun.
// 2. Verify each local-assets/<kind>/ subdir is creatable + writable before
//    serving requests. We mkdirSync, write/read/delete a sentinel file, and
//    process.exit(1) on any failure so misconfigured environments fail loud
//    instead of erroring on the first asset write deep inside a route.
//
// Both guards are skipped in test runs (NODE_ENV === 'test') so vitest doesn't
// touch the host filesystem; route-handler tests use the writer module's own
// path resolution (read live each call) and don't rely on these.
// -----------------------------------------------------------------------------
function runBootGuards(): void {
  if (process.env.NODE_ENV === 'test') return;

  if (process.env.NODE_ENV === 'production' && localInferenceConfig.enabled) {
    throw new Error('LOCAL_INFERENCE must not be true in production');
  }

  if (!localInferenceConfig.enabled) return;

  for (const kind of ASSET_KINDS) {
    const kindDir = path.resolve(localInferenceConfig.assetsDir, kind);
    const sentinel = path.join(kindDir, '.write-test');
    try {
      fs.mkdirSync(kindDir, { recursive: true });
      fs.writeFileSync(sentinel, 'ok');
      const back = fs.readFileSync(sentinel, 'utf8');
      if (back !== 'ok') throw new Error(`sentinel readback mismatch in ${kindDir}`);
      fs.unlinkSync(sentinel);
    } catch (err) {
      console.error(`[boot] FATAL: local-assets sentinel test failed for kind='${kind}' at ${kindDir}:`, err);
      process.exit(1);
    }
  }
}

runBootGuards();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Middleware
const allowedOrigins = new Set(corsAllowedOrigins);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Internal-Api-Key']
}));
app.use(express.json({ limit: '50mb' }));

// -----------------------------------------------------------------------------
// Public, unauthenticated routes (whitelisted BEFORE rate limit + auth):
//   GET /health  → always available, both modes
//   GET /config  → frontend has no internal API key at boot, so this MUST be
//                  callable without auth (ZG-22). Surface is intentionally
//                  minimal: the boolean only — no URLs, no secrets, no paths.
//
// Read LOCAL_INFERENCE live so vi.stubEnv in tests takes effect even when
// runtime-config.ts was imported before the stub (mirrors the pattern in
// r2-storage.ts:isLocalInferenceEnabled).
// -----------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/config', (req, res) => {
  res.json({ localInferenceMode: process.env.LOCAL_INFERENCE === 'true' });
});

// Static asset host for local-inference mode. In remote mode we don't mount
// anything under /assets — the frontend pulls from R2/Supabase URLs instead.
if (localInferenceConfig.enabled) {
  app.use('/assets', express.static(localInferenceConfig.assetsDir));
}

const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const rateLimitMiddleware: express.RequestHandler = (req, res, next) => {
  if (req.method === 'OPTIONS') return next();

  const now = Date.now();
  const key = req.ip || 'unknown';
  const bucket = rateBuckets.get(key) ?? { count: 0, resetAt: now + rateLimitWindowMs };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + rateLimitWindowMs;
  }

  bucket.count += 1;
  rateBuckets.set(key, bucket);

  if (bucket.count > rateLimitMax) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  next();
};

const authMiddleware: express.RequestHandler = (req, res, next) => {
  if (!apiKeyRequired) return next();
  if (req.method === 'OPTIONS') return next();

  const openPaths = new Set(['/health', '/', '/config']);
  if (openPaths.has(req.path)) return next();

  if (!internalApiKey) {
    return res.status(500).json({ error: 'INTERNAL_API_KEY not configured' });
  }

  const headerToken = req.header('x-internal-api-key') || req.header('X-Internal-Api-Key');
  const bearerToken = req.header('Authorization')?.replace('Bearer ', '');
  const token = headerToken || bearerToken;
  if (!token || token !== internalApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
};

app.use(rateLimitMiddleware);
app.use(authMiddleware);

// Debug endpoint to check env vars (remove after debugging)
if (process.env.NODE_ENV !== 'production') {
  app.get('/debug-env', (req, res) => {
    res.json({
      proxyConfigured: !!process.env.YTDLP_PROXY_URL,
      proxyUrlLength: process.env.YTDLP_PROXY_URL?.length || 0,
      proxyUrlStart: process.env.YTDLP_PROXY_URL?.substring(0, 10) || 'not set',
      supabaseConfigured: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      timestamp: new Date().toISOString()
    });
  });

  app.get('/debug-ytdlp', async (req, res) => {
    const path = await import('path');
    const fs = await import('fs');
    const os = await import('os');

    const YTDLP_DIR = path.default.join(os.default.tmpdir(), 'ytdlp');
    const YTDLP_PATH = path.default.join(YTDLP_DIR, 'yt-dlp');

    res.json({
      tmpdir: os.default.tmpdir(),
      ytdlpDir: YTDLP_DIR,
      ytdlpPath: YTDLP_PATH,
      dirExists: fs.default.existsSync(YTDLP_DIR),
      binaryExists: fs.default.existsSync(YTDLP_PATH),
      proxyConfigured: !!process.env.YTDLP_PROXY_URL,
      proxyStart: process.env.YTDLP_PROXY_URL?.substring(0, 15) || 'not set'
    });
  });
}

// Root endpoint
app.get('/', (req, res) => {
  console.log('Root endpoint requested');
  res.json({
    message: 'HistoryVidGen API',
    status: 'running',
    timestamp: new Date().toISOString()
  });
});

// Routes
app.use('/rewrite-script', rewriteScriptRouter);
app.use('/generate-audio', generateAudioRouter);
app.use('/generate-images', generateImagesRouter);
app.use('/get-youtube-transcript', getYoutubeTranscriptRouter);
app.use('/generate-captions', generateCaptionsRouter);
app.use('/render-video', renderVideoRouter);
app.use('/generate-image-prompts', generateImagePromptsRouter);
app.use('/generate-thumbnails', generateThumbnailsRouter);
app.use('/youtube-upload', youtubeUploadRouter);
app.use('/pronunciation', pronunciationRouter);
app.use('/generate-youtube-metadata', generateYoutubeMetadataRouter);
app.use('/youtube-channel-stats', youtubeChannelStatsRouter);
app.use('/youtube-channel-apify', youtubeChannelApifyRouter);
app.use('/youtube-channel-invidious', youtubeChannelInvidiousRouter);
app.use('/youtube-channel-ytdlp', youtubeChannelYtdlpRouter);
app.use('/niche-analyze', nicheAnalyzeRouter);
app.use('/generate-clip-prompts', generateClipPromptsRouter);
app.use('/generate-video-clips', generateVideoClipsRouter);
app.use('/bulk-channels', bulkChannelsRouter);
app.use('/analyze-thumbnail', analyzeThumbnailRouter);
app.use('/rewrite-title', rewriteTitleRouter);
app.use('/auto-clone', autoCloneRouter);
app.use('/costs', costsRouter);
app.use('/video-analysis', videoAnalysisRouter);
app.use('/vision-test', visionTestRouter);
app.use('/video-editor', videoEditorRouter);
app.use('/full-pipeline', fullPipelineRouter);
app.use('/scan-images', scanImagesRouter);
app.use('/generate-short-hooks', generateShortHooksRouter);
app.use('/generate-short', generateShortRouter);
app.use('/render-short', renderShortRouter);
app.use('/delete-project-images', deleteProjectImagesRouter);
app.use('/scan-scripts', scanScriptsRouter);

// Error handling
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({
    error: err.message || 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// Prevent uncaught exceptions from crashing the server
process.on('uncaughtException', (error) => {
  console.error('🔴 Uncaught Exception:', error);
  console.error('Stack:', error.stack);
  // Don't exit - let the error handler deal with it
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔴 Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
  // Don't exit - let the error handler deal with it
});

// -----------------------------------------------------------------------------
// Server bootstrap. Only listen when this module is the process entry point —
// `node dist/index.js` (production) or `ts-node src/index.ts` (dev). Tests
// `await import('../../src/index')` and exercise routes via supertest, which
// drives the Express handler directly without binding a port.
// -----------------------------------------------------------------------------
function startServer(): void {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 HistoryVidGen API running on port ${PORT}`);
    console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🌐 Listening on 0.0.0.0:${PORT}`);
    console.log(`✅ Server successfully bound and ready for connections`);

    // PO Token provider disabled - requires git clone and npm install at runtime
    // which doesn't work in Railway's container environment
    // initPotProvider().catch(err => {
    //   console.warn('⚠️ PO Token provider init failed:', err.message);
    // });

    // Cache refresh cron DISABLED - all cron jobs removed at user request
    console.log('🔄 Cache refresh cron: DISABLED (removed from code)');

    // Auto Poster cron DISABLED - removed at user request
    // User can manually trigger via UI or API if needed
    console.log('⏰ Auto Poster cron: DISABLED (removed from code)');

    // ONE-TIME Auto Poster cron DISABLED - removed at user request
    console.log('🎯 ONE-TIME Auto Poster: DISABLED (removed from code)');
  });

  // Increase timeouts for long-running SSE connections (video rendering)
  server.keepAliveTimeout = 620000; // 10+ minutes
  server.headersTimeout = 625000; // Slightly higher than keepAliveTimeout
  server.timeout = 0; // Disable socket timeout for SSE

  server.on('error', (error: any) => {
    console.error('❌ Server error:', error);
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use`);
    }
    process.exit(1);
  });
}

// CommonJS entry-point check: when compiled with tsc to dist/index.js and
// invoked as `node dist/index.js`, require.main === module. When imported
// from a test (or any other module), it does not.
if (require.main === module) {
  startServer();
}

export { app };

