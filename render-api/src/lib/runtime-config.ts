const splitList = (value: string | undefined, fallback: string[]): string[] => {
  if (!value) return fallback;
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
};

const isProduction = process.env.NODE_ENV === 'production';

export const corsAllowedOrigins = splitList(
  process.env.CORS_ALLOWED_ORIGINS,
  [
    'https://autoaigen.com',
    'https://history-gen-ai.pages.dev',
    'https://historygenai.netlify.app',
    ...(isProduction ? [] : ['http://localhost:8080', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000']),
  ]
);

export const apiKeyRequired = process.env.REQUIRE_API_KEY === 'true' || isProduction;
export const internalApiKey = process.env.INTERNAL_API_KEY || '';

export const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
export const rateLimitMax = Number(process.env.RATE_LIMIT_MAX ?? 60);

export const imageGenerationConfig = {
  maxConcurrentJobs: Number(process.env.ZIMAGE_MAX_CONCURRENCY ?? 4),  // Back to 4 concurrent jobs
  pollIntervalMs: Number(process.env.ZIMAGE_POLL_INTERVAL_MS ?? 2000),
  maxPollingTimeMs: Number(process.env.ZIMAGE_POLL_TIMEOUT_MS ?? 20 * 60 * 1000),  // Increased to 20 min
  maxRetries: Number(process.env.ZIMAGE_MAX_RETRIES ?? 4),  // Increased from 2 to 4 (5 total attempts)
};

export const localInferenceConfig = {
  enabled: process.env.LOCAL_INFERENCE === 'true',
  voxcpm2Url: process.env.LOCAL_VOXCPM2_URL ?? 'http://localhost:7861',
  zimageUrl: process.env.LOCAL_ZIMAGE_URL ?? 'http://localhost:7862',
  ltx2Url: process.env.LOCAL_LTX2_URL ?? 'http://localhost:7863',
  assetsDir: process.env.LOCAL_ASSETS_DIR ?? 'D:\\historygen\\local-assets',
  assetsBaseUrl: process.env.LOCAL_ASSETS_BASE_URL ?? 'http://localhost:3000/assets',
  ffmpegPath: process.env.FFMPEG_PATH ?? '',
  voxcpm2TimeoutMs: Number(process.env.VOXCPM2_TIMEOUT_MS ?? 60_000),
  zimageTimeoutMs: Number(process.env.ZIMAGE_TIMEOUT_MS ?? 5 * 60_000),
  ltx2TimeoutMs: Number(process.env.LTX2_TIMEOUT_MS ?? 15 * 60_000),
};

export const allowedAssetHosts = splitList(
  process.env.ALLOWED_ASSET_HOSTS,
  [
    'udqfdeoullsxttqguupz.supabase.co',
    'autoaigen.com',
    'history-gen-ai.pages.dev',
    'historygenai.netlify.app',
    // Video generation services (Kie.ai, etc.)
    'kie.ai',
    'aiquickdraw.com',   // Kie.ai temp file CDN
    'piapi.ai',
    'r2.cloudflarestorage.com',
    'cloudflare-ipfs.com',
    'replicate.delivery',
    // Chinese cloud CDNs (used by Kie.ai and similar services)
    'aliyuncs.com',      // Alibaba Cloud OSS
    'myqcloud.com',      // Tencent Cloud COS
    'qiniucdn.com',      // Qiniu CDN
    'qiniudn.com',       // Qiniu CDN (alternate)
    'volccdn.com',       // ByteDance/Volcengine CDN
    'bcebos.com',        // Baidu Cloud BOS
  ]
);
