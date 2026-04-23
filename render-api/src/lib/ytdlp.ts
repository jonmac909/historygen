/**
 * yt-dlp wrapper for YouTube channel/video metadata
 * More reliable than Invidious API for resolving handles
 */

import YTDlpWrap from 'yt-dlp-wrap';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { isPotProviderAvailable, getPotProviderUrl } from './pot-provider';

// Residential proxy for bypassing YouTube bot detection
// Format: http://user:pass@host:port or socks5://user:pass@host:port
const YTDLP_PROXY_URL = process.env.YTDLP_PROXY_URL || '';

// yt-dlp binary path - will be downloaded on first use
const YTDLP_DIR = path.join(os.tmpdir(), 'ytdlp');
const YTDLP_PATH = path.join(YTDLP_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

let ytDlpInstance: YTDlpWrap | null = null;
let downloadPromise: Promise<void> | null = null;

// Semaphore to limit concurrent yt-dlp executions
// Increased to 4 for faster loading with residential proxy
// Railway has 8GB RAM, can handle 4 concurrent Python subprocesses
const MAX_CONCURRENT_YTDLP = 4;
const YTDLP_TIMEOUT_MS = 60000; // 60 second timeout per call (increased for proxy latency)
let activeYtdlpCalls = 0;
const ytdlpQueue: Array<{ resolve: () => void }> = [];

/**
 * Wrap a promise with a timeout
 */
function withTimeout<T>(promise: Promise<T>, ms: number, context: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`yt-dlp timeout after ${ms}ms: ${context}`));
    }, ms);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function acquireYtdlpSlot(): Promise<void> {
  if (activeYtdlpCalls < MAX_CONCURRENT_YTDLP) {
    activeYtdlpCalls++;
    return;
  }
  // Wait in queue
  return new Promise((resolve) => {
    ytdlpQueue.push({ resolve });
  });
}

function releaseYtdlpSlot(): void {
  activeYtdlpCalls--;
  const next = ytdlpQueue.shift();
  if (next) {
    activeYtdlpCalls++;
    next.resolve();
  }
}

/**
 * Get or initialize yt-dlp instance (downloads binary if needed)
 */
async function getYtDlp(): Promise<YTDlpWrap> {
  if (ytDlpInstance) {
    return ytDlpInstance;
  }

  // Ensure directory exists
  if (!fs.existsSync(YTDLP_DIR)) {
    fs.mkdirSync(YTDLP_DIR, { recursive: true });
  }

  // Download yt-dlp binary if not present
  if (!fs.existsSync(YTDLP_PATH)) {
    if (!downloadPromise) {
      console.log('[ytdlp] Downloading yt-dlp binary...');
      downloadPromise = YTDlpWrap.downloadFromGithub(YTDLP_PATH)
        .then(() => {
          console.log('[ytdlp] yt-dlp binary downloaded successfully');
        })
        .catch((err) => {
          console.error('[ytdlp] Failed to download yt-dlp:', err);
          throw err;
        });
    }
    await downloadPromise;
  }

  ytDlpInstance = new YTDlpWrap(YTDLP_PATH);
  return ytDlpInstance;
}

/**
 * Get PO Token provider args for yt-dlp if available
 * Returns extractor args that enable YouTube bot detection bypass
 */
function getPotArgs(): string[] {
  if (!isPotProviderAvailable()) {
    return [];
  }

  const potUrl = getPotProviderUrl();
  console.log(`[ytdlp] Using PO Token provider at ${potUrl}`);

  return [
    '--extractor-args',
    `youtubepot-bgutilhttp:base_url=${potUrl}`,
  ];
}

/**
 * Get proxy args for yt-dlp if configured
 * Residential proxies bypass YouTube's datacenter IP blocking
 */
function getProxyArgs(): string[] {
  if (!YTDLP_PROXY_URL) {
    return [];
  }

  console.log(`[ytdlp] Using proxy: ${YTDLP_PROXY_URL.replace(/:[^:@]+@/, ':***@')}`);
  return ['--proxy', YTDLP_PROXY_URL];
}

export interface YtDlpChannelInfo {
  id: string;
  channel: string;
  channel_id: string;
  channel_url: string;
  uploader: string;
  uploader_id: string;
  uploader_url: string;
  channel_follower_count?: number;
  thumbnails?: { url: string; width?: number; height?: number }[];
  // Playlist metadata (channel ID often here when channel_id is null)
  playlist_channel_id?: string;
  playlist_channel?: string;
  playlist_uploader?: string;
  playlist_uploader_id?: string;
}

export interface YtDlpVideoInfo {
  id: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  view_count?: number;
  like_count?: number;
  upload_date?: string;
  channel_id?: string;
  channel?: string;
}

/**
 * Resolve a YouTube handle (@handle) or URL to a channel ID
 */
export async function resolveChannelId(input: string): Promise<string> {
  // Already a channel ID (starts with UC and is 24 chars)
  if (input.startsWith('UC') && input.length >= 24) {
    return input.substring(0, 24);
  }

  // Extract from URL patterns
  const channelIdMatch = input.match(/\/channel\/(UC[\w-]{22})/);
  if (channelIdMatch) {
    return channelIdMatch[1];
  }

  // Build a proper YouTube URL for yt-dlp
  let url = input;
  if (!input.includes('youtube.com') && !input.includes('youtu.be')) {
    // Just a handle or name
    const handle = input.replace(/^@/, '');
    url = `https://www.youtube.com/@${handle}`;
  }

  console.log(`[ytdlp] Resolving channel ID from: ${url}`);
  console.log(`[ytdlp] Proxy configured: ${!!YTDLP_PROXY_URL}, URL length: ${YTDLP_PROXY_URL.length}`);

  const ytDlp = await getYtDlp();

  // Acquire semaphore slot to limit concurrent calls
  await acquireYtdlpSlot();
  try {
    // Use --dump-single-json to get channel metadata even if default tab has no videos
    // --age-limit 99 skips age-restricted videos that would otherwise fail
    const result = await withTimeout(
      ytDlp.execPromise([
        url,
        '--dump-single-json',
        '--skip-download',
        '--no-warnings',
        '--ignore-errors',
        '--age-limit', '99',
        '--socket-timeout', '60',      // Native network timeout (increased for proxy latency)
        '--retries', '3',              // Retry on failure
        '--extractor-retries', '3',    // Retry extractor errors
        '--geo-bypass',                // Bypass geo-restriction
        '--no-check-certificates',     // Skip SSL verification issues
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...getProxyArgs(),             // Residential proxy for bot detection bypass
        ...getPotArgs(),               // PO Token provider (if available)
      ]),
      YTDLP_TIMEOUT_MS,
      `resolveChannelId(${input})`
    );

    if (!result.trim()) {
      throw new Error('No data returned from yt-dlp');
    }

    const info = JSON.parse(result.trim()) as YtDlpChannelInfo;
    // Check multiple possible locations for channel ID
    const channelId = info.channel_id || info.playlist_channel_id || info.uploader_id;

    if (!channelId || !channelId.startsWith('UC')) {
      console.log('[ytdlp] Raw info keys:', Object.keys(info).filter(k => k.includes('channel') || k.includes('uploader')));
      throw new Error('Could not extract channel ID');
    }

    console.log(`[ytdlp] Resolved channel ID: ${channelId}`);
    return channelId;

  } catch (error: any) {
    console.error('[ytdlp] Error resolving channel:', error.message);
    console.error('[ytdlp] Full error:', error.stderr || error.stdout || error);
    throw new Error(`Could not find channel: ${input}`);
  } finally {
    releaseYtdlpSlot();
  }
}

/**
 * Get channel videos with metadata
 */
export async function getChannelVideos(
  channelId: string,
  maxResults: number = 50
): Promise<YtDlpVideoInfo[]> {
  const ytDlp = await getYtDlp();
  // Explicitly use /videos tab to get video list
  const url = `https://www.youtube.com/channel/${channelId}/videos`;

  console.log(`[ytdlp] Fetching videos from: ${url}`);

  // Acquire semaphore slot to limit concurrent calls
  await acquireYtdlpSlot();
  try {
    const result = await withTimeout(
      ytDlp.execPromise([
        url,
        '--dump-json',
        '--flat-playlist',
        '--playlist-items', `1:${maxResults}`,
        '--no-warnings',
        '--ignore-errors',
        '--age-limit', '99',
        '--socket-timeout', '60',      // Native network timeout (longer for video list)
        '--retries', '3',              // Retry on failure
        '--extractor-retries', '3',    // Retry extractor errors
        '--geo-bypass',                // Bypass geo-restriction
        '--no-check-certificates',     // Skip SSL verification issues
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...getProxyArgs(),             // Residential proxy for bot detection bypass
        ...getPotArgs(),               // PO Token provider (if available)
      ]),
      YTDLP_TIMEOUT_MS * 2, // 60s for video list (more data)
      `getChannelVideos(${channelId})`
    );

    const lines = result.trim().split('\n').filter(Boolean);
    const videos: YtDlpVideoInfo[] = [];

    for (const line of lines) {
      try {
        const info = JSON.parse(line);
        if (info.id && info.title) {
          videos.push({
            id: info.id,
            title: info.title,
            thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${info.id}/mqdefault.jpg`,
            duration: info.duration,
            view_count: info.view_count,
            like_count: info.like_count,
            upload_date: info.upload_date,
            channel_id: info.channel_id || info.playlist_channel_id || channelId,
            channel: info.channel || info.playlist_channel || info.uploader || info.playlist_uploader,
          });
        }
      } catch {
        // Skip malformed JSON lines
      }
    }

    console.log(`[ytdlp] Found ${videos.length} videos`);
    return videos;

  } catch (error: any) {
    console.error('[ytdlp] Error fetching videos:', error.message);
    throw new Error('Failed to fetch channel videos');
  } finally {
    releaseYtdlpSlot();
  }
}

/**
 * Get channel info (subscriber count, etc)
 */
export async function getChannelInfo(channelId: string): Promise<{
  id: string;
  title: string;
  subscriberCount: number;
  thumbnailUrl: string;
}> {
  const ytDlp = await getYtDlp();
  const url = `https://www.youtube.com/channel/${channelId}`;

  console.log(`[ytdlp] Fetching channel info: ${url}`);

  // Acquire semaphore slot to limit concurrent calls
  await acquireYtdlpSlot();
  try {
    // Use --dump-single-json to get channel metadata reliably
    // --age-limit 99 skips age-restricted videos that would otherwise fail
    const result = await withTimeout(
      ytDlp.execPromise([
        url,
        '--dump-single-json',
        '--skip-download',
        '--no-warnings',
        '--ignore-errors',
        '--age-limit', '99',
        '--socket-timeout', '60',      // Native network timeout (increased for proxy latency)
        '--retries', '3',              // Retry on failure
        '--extractor-retries', '3',    // Retry extractor errors
        '--geo-bypass',                // Bypass geo-restriction
        '--no-check-certificates',     // Skip SSL verification issues
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...getProxyArgs(),             // Residential proxy for bot detection bypass
        ...getPotArgs(),               // PO Token provider (if available)
      ]),
      YTDLP_TIMEOUT_MS,
      `getChannelInfo(${channelId})`
    );

    if (!result.trim()) {
      throw new Error('No data returned');
    }

    const info = JSON.parse(result.trim());

    return {
      id: channelId,
      // Check multiple sources for channel name
      title: info.channel || info.title || info.uploader || 'Unknown Channel',
      subscriberCount: info.channel_follower_count || 0,
      thumbnailUrl: info.thumbnails?.[0]?.url || '',
    };

  } catch (error: any) {
    console.error('[ytdlp] Error fetching channel info:', error.message);
    // Return minimal info if we can't get full details
    return {
      id: channelId,
      title: 'Unknown Channel',
      subscriberCount: 0,
      thumbnailUrl: '',
    };
  } finally {
    releaseYtdlpSlot();
  }
}
