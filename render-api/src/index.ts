import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import { initPotProvider } from './lib/pot-provider';
import {
  corsAllowedOrigins,
  apiKeyRequired,
  internalApiKey,
  rateLimitMax,
  rateLimitWindowMs,
} from './lib/runtime-config';
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

dotenv.config();

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

  const openPaths = new Set(['/health', '/']);
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

// Health check
app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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

