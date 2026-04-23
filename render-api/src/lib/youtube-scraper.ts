/**
 * Pure Node.js YouTube channel scraper
 * Uses YouTube's InnerTube API with continuation tokens
 * No yt-dlp binary required - works reliably on Railway
 */

import { fetch, ProxyAgent, type RequestInit } from 'undici';

const PROXY_URL = process.env.YTDLP_PROXY_URL || '';

function getAgent() {
  if (!PROXY_URL) return undefined;
  return new ProxyAgent(PROXY_URL);
}

async function fetchWithProxy(url: string, init: RequestInit = {}, timeoutMs: number = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const agent = getAgent();

  try {
    return await fetch(url, {
      ...init,
      ...(agent ? { dispatcher: agent } : {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

export interface ScrapedVideo {
  id: string;
  title: string;
  thumbnail: string;
  duration: number;
  views: number;
  publishedText?: string;
  channelId?: string;
  channelName?: string;
}

export interface ScrapedChannel {
  id: string;
  name: string;
  subscriberCount: number;
  thumbnailUrl: string;
}

/**
 * Extract channel ID from various input formats
 */
export async function resolveChannelId(input: string): Promise<string> {
  // Already a channel ID
  if (input.startsWith('UC') && input.length >= 24) {
    return input.substring(0, 24);
  }

  // Extract from URL patterns
  const channelIdMatch = input.match(/\/channel\/(UC[\w-]{22})/);
  if (channelIdMatch) {
    return channelIdMatch[1];
  }

  // Build URL from handle
  let url = input;
  if (!input.includes('youtube.com') && !input.includes('youtu.be')) {
    const handle = input.replace(/^@/, '');
    url = `https://www.youtube.com/@${handle}`;
  }

  console.log(`[youtube-scraper] Resolving channel ID from: ${url}`);

  const res = await fetchWithProxy(url, { headers: HEADERS }, 30000);

  if (!res.ok) {
    throw new Error(`Failed to fetch channel page: ${res.status}`);
  }

  const html = await res.text();

  // Extract channel ID from page
  const idMatch = html.match(/"channelId":"(UC[\w-]{22})"/);
  if (idMatch) {
    console.log(`[youtube-scraper] Resolved channel ID: ${idMatch[1]}`);
    return idMatch[1];
  }

  // Try alternate pattern
  const altMatch = html.match(/channel\/(UC[\w-]{22})/);
  if (altMatch) {
    console.log(`[youtube-scraper] Resolved channel ID (alt): ${altMatch[1]}`);
    return altMatch[1];
  }

  throw new Error(`Could not find channel: ${input}`);
}

/**
 * Get channel info (name, subscribers, thumbnail)
 */
export async function getChannelInfo(channelId: string): Promise<ScrapedChannel> {
  const url = `https://www.youtube.com/channel/${channelId}`;
  console.log(`[youtube-scraper] Fetching channel info: ${channelId}`);

  const res = await fetchWithProxy(url, { headers: HEADERS }, 30000);
  const html = await res.text();

  // Extract ytInitialData
  const match = html.match(/var ytInitialData = ({.*?});<\/script>/s);
  if (!match) {
    return {
      id: channelId,
      name: 'Unknown Channel',
      subscriberCount: 0,
      thumbnailUrl: '',
    };
  }

  try {
    const data = JSON.parse(match[1]);
    const header = data.header?.c4TabbedHeaderRenderer || data.header?.pageHeaderRenderer;

    // Try different structures
    let name = 'Unknown Channel';
    let subscriberCount = 0;
    let thumbnailUrl = '';

    if (header) {
      name = header.title || header.pageTitle || 'Unknown Channel';

      // Subscriber count
      const subText = header.subscriberCountText?.simpleText || '';
      const subMatch = subText.match(/([\d.]+)([KMB]?)/i);
      if (subMatch) {
        let count = parseFloat(subMatch[1]);
        const suffix = subMatch[2]?.toUpperCase();
        if (suffix === 'K') count *= 1000;
        else if (suffix === 'M') count *= 1000000;
        else if (suffix === 'B') count *= 1000000000;
        subscriberCount = Math.round(count);
      }

      // Thumbnail
      const avatars = header.avatar?.thumbnails || [];
      thumbnailUrl = avatars[avatars.length - 1]?.url || '';
    }

    return { id: channelId, name, subscriberCount, thumbnailUrl };
  } catch (e) {
    console.error('[youtube-scraper] Error parsing channel info:', e);
    return {
      id: channelId,
      name: 'Unknown Channel',
      subscriberCount: 0,
      thumbnailUrl: '',
    };
  }
}

/**
 * Get all videos from a channel with pagination
 */
export async function getChannelVideos(
  channelId: string,
  maxVideos: number = 50
): Promise<ScrapedVideo[]> {
  const url = `https://www.youtube.com/channel/${channelId}/videos`;
  console.log(`[youtube-scraper] Fetching videos from: ${url} (max: ${maxVideos})`);

  const res = await fetchWithProxy(url, { headers: HEADERS }, 30000);
  const html = await res.text();

  // Extract ytInitialData
  const match = html.match(/var ytInitialData = ({.*?});<\/script>/s);
  if (!match) {
    throw new Error('Could not find video data');
  }

  const data = JSON.parse(match[1]);
  const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  const videosTab = tabs.find((t: any) => t.tabRenderer?.title === 'Videos');
  const contents = videosTab?.tabRenderer?.content?.richGridRenderer?.contents || [];

  const videos: ScrapedVideo[] = [];
  let continuation: string | null = null;

  // Parse initial videos
  for (const item of contents) {
    if (item.richItemRenderer && videos.length < maxVideos) {
      const v = item.richItemRenderer.content?.videoRenderer;
      if (v) {
        videos.push(parseVideoRenderer(v, channelId));
      }
    }
    if (item.continuationItemRenderer) {
      continuation = item.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token;
    }
  }

  console.log(`[youtube-scraper] Initial fetch: ${videos.length} videos, has more: ${!!continuation}`);

  // Fetch more pages if needed (max 5 pagination attempts to avoid infinite loops)
  let paginationAttempts = 0;
  const maxPaginationAttempts = 5;

  while (continuation && videos.length < maxVideos && paginationAttempts < maxPaginationAttempts) {
    paginationAttempts++;
    await sleep(500); // Rate limiting

    try {
      const apiRes = await fetchWithProxy(
        'https://www.youtube.com/youtubei/v1/browse?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
        {
          method: 'POST',
          headers: {
            ...HEADERS,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            context: {
              client: {
                clientName: 'WEB',
                clientVersion: '2.20240101',
              },
            },
            continuation,
          }),
        },
        30000
      );

      if (!apiRes.ok) {
        console.error(`[youtube-scraper] Pagination failed: ${apiRes.status}`);
        break;
      }

      const apiData = await apiRes.json() as any;
      const items = apiData.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems || [];

      continuation = null;
      for (const item of items) {
        if (item.richItemRenderer && videos.length < maxVideos) {
          const v = item.richItemRenderer.content?.videoRenderer;
          if (v) {
            videos.push(parseVideoRenderer(v, channelId));
          }
        }
        if (item.continuationItemRenderer) {
          continuation = item.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token;
        }
      }

      console.log(`[youtube-scraper] Pagination ${paginationAttempts}: now have ${videos.length} videos`);
    } catch (paginationError) {
      console.error(`[youtube-scraper] Pagination error:`, paginationError);
      break; // Stop pagination on error, return what we have
    }
  }

  console.log(`[youtube-scraper] Total: ${videos.length} videos`);
  return videos;
}

function parseVideoRenderer(v: any, channelId?: string): ScrapedVideo {
  // Parse view count
  let views = 0;
  const viewText = v.viewCountText?.simpleText || v.viewCountText?.runs?.[0]?.text || '';
  const viewMatch = viewText.replace(/,/g, '').match(/(\d+)/);
  if (viewMatch) {
    views = parseInt(viewMatch[1], 10);
  }

  // Parse duration
  let duration = 0;
  const durationText = v.lengthText?.simpleText || '';
  const parts = durationText.split(':').reverse();
  if (parts.length >= 1) duration += parseInt(parts[0] || '0', 10);
  if (parts.length >= 2) duration += parseInt(parts[1] || '0', 10) * 60;
  if (parts.length >= 3) duration += parseInt(parts[2] || '0', 10) * 3600;

  return {
    id: v.videoId,
    title: v.title?.runs?.[0]?.text || 'Unknown',
    thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
    duration,
    views,
    publishedText: v.publishedTimeText?.simpleText,
    channelId: channelId || v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId,
    channelName: v.ownerText?.runs?.[0]?.text,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wrap a promise with a timeout
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms)
    ),
  ]);
}
