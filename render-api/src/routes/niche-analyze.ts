import { Router, Request, Response } from 'express';
import {
  getCachedNicheSearch,
  cacheNicheSearch,
  getCachedChannels,
  cacheChannels,
  CachedChannel,
} from '../lib/outlier-cache';

const router = Router();

// TubeLab API key from environment
const TUBELAB_API_KEY = process.env.TUBELAB_API_KEY;
const TUBELAB_BASE_URL = 'https://public-api.tubelab.net/v1';

interface NicheChannel {
  id: string;
  title: string;
  handle?: string;
  thumbnailUrl: string;
  subscriberCount: number;
  subscriberCountFormatted: string;
  viewCount: number;
  videoCount: number;
  viewsToSubsRatio: number;
  isBreakout: boolean;
  createdAt?: string;
  // TubeLab-specific fields
  avgViews?: number;
  avgViewsFormatted?: string;
  monetization?: {
    adsense: boolean;
    rpmEstimationFrom?: number;
    rpmEstimationTo?: number;
  };
}

interface NicheMetrics {
  channelCount: number;
  avgSubscribers: number;
  avgViewsPerVideo: number;
  avgViewsToSubsRatio: number;
  saturationLevel: 'low' | 'medium' | 'high';
  saturationScore: number;
}

// Format large numbers (e.g., 1234567 -> "1.2M")
function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return num.toString();
}

// Calculate saturation level based on channel count and views-to-subs ratio
function calculateSaturation(channelCount: number, avgViewsToSubsRatio: number): { level: 'low' | 'medium' | 'high'; score: number } {
  let score = 50;

  if (channelCount < 10) score -= 30;
  else if (channelCount < 20) score -= 20;
  else if (channelCount < 30) score -= 10;
  else if (channelCount > 40) score += 15;
  else if (channelCount > 50) score += 25;

  if (avgViewsToSubsRatio > 3) score -= 25;
  else if (avgViewsToSubsRatio > 2) score -= 15;
  else if (avgViewsToSubsRatio > 1.5) score -= 10;
  else if (avgViewsToSubsRatio < 0.5) score += 20;
  else if (avgViewsToSubsRatio < 1) score += 10;

  score = Math.max(0, Math.min(100, score));

  let level: 'low' | 'medium' | 'high';
  if (score < 35) level = 'low';
  else if (score < 65) level = 'medium';
  else level = 'high';

  return { level, score };
}

// TubeLab channel response type
interface TubeLabChannelHit {
  id: string;
  snippet: {
    title: string;
    handle?: string;
    publishedAt?: string;
    thumbnails?: {
      default?: { url: string };
      medium?: { url: string };
      high?: { url: string };
    };
  };
  statistics: {
    subscriberCount: number;
    viewCount: number;
    videoCount: number;
    avgViewsToSubscribersRatio?: number;
    avgViewsEstimate?: number;
  };
  monetization?: {
    adsense?: boolean;
    rpmEstimationFrom?: number;
    rpmEstimationTo?: number;
  };
}

interface TubeLabChannelsResponse {
  pagination: {
    total: number;
    from: number;
    size: number;
  };
  hits: TubeLabChannelHit[];
}

// Convert TubeLab hit to our NicheChannel format
function tubeLabHitToNicheChannel(hit: TubeLabChannelHit): NicheChannel {
  const subscriberCount = hit.statistics.subscriberCount || 0;
  const viewCount = hit.statistics.viewCount || 0;
  const videoCount = hit.statistics.videoCount || 0;
  const avgViews = hit.statistics.avgViewsEstimate || 0;

  const viewsToSubsRatio = hit.statistics.avgViewsToSubscribersRatio
    || (subscriberCount > 0 ? Math.round((viewCount / subscriberCount) * 100) / 100 : 0);

  const isBreakout = viewsToSubsRatio > 2;

  return {
    id: hit.id,
    title: hit.snippet.title,
    handle: hit.snippet.handle,
    thumbnailUrl: hit.snippet.thumbnails?.medium?.url
      || hit.snippet.thumbnails?.high?.url
      || hit.snippet.thumbnails?.default?.url
      || '',
    subscriberCount,
    subscriberCountFormatted: formatNumber(subscriberCount),
    viewCount,
    videoCount,
    viewsToSubsRatio,
    isBreakout,
    createdAt: hit.snippet.publishedAt,
    avgViews,
    avgViewsFormatted: formatNumber(avgViews),
    monetization: hit.monetization ? {
      adsense: hit.monetization.adsense || false,
      rpmEstimationFrom: hit.monetization.rpmEstimationFrom,
      rpmEstimationTo: hit.monetization.rpmEstimationTo,
    } : undefined,
  };
}

// Convert cached channel to NicheChannel format
function cachedChannelToNicheChannel(cached: CachedChannel): NicheChannel {
  return {
    id: cached.id,
    title: cached.title,
    handle: cached.handle,
    thumbnailUrl: cached.thumbnail_url,
    subscriberCount: cached.subscriber_count,
    subscriberCountFormatted: formatNumber(cached.subscriber_count),
    viewCount: cached.view_count,
    videoCount: cached.video_count,
    viewsToSubsRatio: cached.views_to_subs_ratio,
    isBreakout: cached.is_breakout,
    createdAt: cached.created_at,
    avgViews: cached.avg_views,
    avgViewsFormatted: formatNumber(cached.avg_views),
    monetization: cached.monetization as NicheChannel['monetization'],
  };
}

// Convert NicheChannel to cache format
function nicheChannelToCacheFormat(channel: NicheChannel): Omit<CachedChannel, 'fetched_at' | 'expires_at'> {
  return {
    id: channel.id,
    title: channel.title,
    handle: channel.handle,
    thumbnail_url: channel.thumbnailUrl,
    subscriber_count: channel.subscriberCount,
    view_count: channel.viewCount,
    video_count: channel.videoCount,
    views_to_subs_ratio: channel.viewsToSubsRatio,
    avg_views: channel.avgViews || 0,
    is_breakout: channel.isBreakout,
    created_at: channel.createdAt,
    monetization: channel.monetization,
    source: 'tubelab',
  };
}

// Search for channels using TubeLab API (with caching)
async function searchChannelsTubeLab(
  topic: string,
  subscriberMin?: number,
  subscriberMax?: number,
  size: number = 40
): Promise<{ channels: NicheChannel[]; total: number; fromCache: boolean }> {

  // Check cache first (only for searches without subscriber filters)
  if (subscriberMin === undefined && subscriberMax === undefined) {
    const cached = await getCachedNicheSearch(topic);
    if (cached) {
      console.log(`[niche-analyze] Cache HIT for niche "${topic}" (${cached.channel_ids.length} channels)`);

      // Get the cached channel details
      const cachedChannels = await getCachedChannels(cached.channel_ids);

      if (cachedChannels.length > 0) {
        const channels = cachedChannels.map(cachedChannelToNicheChannel);
        // Sort by views-to-subs ratio (descending)
        channels.sort((a, b) => b.viewsToSubsRatio - a.viewsToSubsRatio);

        return {
          channels,
          total: cached.total_in_database,
          fromCache: true,
        };
      }
      // If channel details not found, fall through to API
      console.log(`[niche-analyze] Cache partial - channel details missing, fetching from API`);
    }
  }

  // Cache miss - call TubeLab API
  if (!TUBELAB_API_KEY) {
    throw new Error('TubeLab API key not configured');
  }

  const url = new URL(`${TUBELAB_BASE_URL}/channels`);
  url.searchParams.set('query', topic);
  url.searchParams.set('size', size.toString());
  url.searchParams.set('sortBy', 'avgViewsToSubscribersRatio');
  url.searchParams.set('sortOrder', 'desc');

  if (subscriberMin !== undefined) {
    url.searchParams.set('subscribersCountFrom', subscriberMin.toString());
  }
  if (subscriberMax !== undefined) {
    url.searchParams.set('subscribersCountTo', subscriberMax.toString());
  }

  console.log(`[niche-analyze] Cache MISS - calling TubeLab API for "${topic}"`);

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': `Api-Key ${TUBELAB_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[niche-analyze] TubeLab API error: ${response.status} ${errorText}`);
    throw new Error(`TubeLab API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as TubeLabChannelsResponse;

  console.log(`[niche-analyze] TubeLab returned ${data.hits?.length || 0} channels (total: ${data.pagination?.total || 0})`);

  if (!data.hits || data.hits.length === 0) {
    return { channels: [], total: 0, fromCache: false };
  }

  const channels = data.hits.map(tubeLabHitToNicheChannel);
  const total = data.pagination?.total || channels.length;

  // Cache the results (only for searches without filters)
  if (subscriberMin === undefined && subscriberMax === undefined) {
    // Calculate metrics for caching
    const channelCount = channels.length;
    const totalSubscribers = channels.reduce((sum, c) => sum + c.subscriberCount, 0);
    const totalViews = channels.reduce((sum, c) => sum + c.viewCount, 0);
    const totalVideos = channels.reduce((sum, c) => sum + c.videoCount, 0);
    const totalViewsToSubsRatio = channels.reduce((sum, c) => sum + c.viewsToSubsRatio, 0);

    const avgSubscribers = Math.round(totalSubscribers / channelCount);
    const avgViewsPerVideo = totalVideos > 0 ? Math.round(totalViews / totalVideos) : 0;
    const avgViewsToSubsRatio = Math.round((totalViewsToSubsRatio / channelCount) * 100) / 100;
    const saturation = calculateSaturation(total, avgViewsToSubsRatio);

    // Cache niche search result
    await cacheNicheSearch(
      topic,
      channels.map(c => c.id),
      {
        channelCount,
        avgSubscribers,
        avgViewsPerVideo,
        avgViewsToSubsRatio,
        saturationLevel: saturation.level,
        saturationScore: saturation.score,
      },
      total,
      'tubelab'
    );

    // Cache individual channels
    await cacheChannels(channels.map(nicheChannelToCacheFormat));
  }

  return { channels, total, fromCache: false };
}

// Main endpoint
router.post('/', async (req: Request, res: Response) => {
  try {
    const { topic, subscriberMin, subscriberMax } = req.body;

    if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Topic is required' });
    }

    console.log(`[niche-analyze] Analyzing niche: "${topic}"`);

    // Search for channels (with caching)
    const { channels, total, fromCache } = await searchChannelsTubeLab(
      topic.trim(),
      subscriberMin,
      subscriberMax,
      40
    );

    if (channels.length === 0) {
      return res.json({
        success: true,
        topic: topic.trim(),
        metrics: {
          channelCount: 0,
          avgSubscribers: 0,
          avgViewsPerVideo: 0,
          avgViewsToSubsRatio: 0,
          saturationLevel: 'low',
          saturationScore: 0,
        },
        channels: [],
        totalInDatabase: 0,
        fromCache: false,
      });
    }

    // Calculate metrics
    const channelCount = channels.length;
    const totalSubscribers = channels.reduce((sum, c) => sum + c.subscriberCount, 0);
    const totalViews = channels.reduce((sum, c) => sum + c.viewCount, 0);
    const totalVideos = channels.reduce((sum, c) => sum + c.videoCount, 0);
    const totalViewsToSubsRatio = channels.reduce((sum, c) => sum + c.viewsToSubsRatio, 0);

    const avgSubscribers = Math.round(totalSubscribers / channelCount);
    const avgViewsPerVideo = totalVideos > 0 ? Math.round(totalViews / totalVideos) : 0;
    const avgViewsToSubsRatio = Math.round((totalViewsToSubsRatio / channelCount) * 100) / 100;

    const saturation = calculateSaturation(total, avgViewsToSubsRatio);

    const breakoutCount = channels.filter(c => c.isBreakout).length;
    console.log(`[niche-analyze] Analysis complete. ${channelCount} channels, ${total} total, ${breakoutCount} breakouts, saturation: ${saturation.level}, fromCache: ${fromCache}`);

    return res.json({
      success: true,
      topic: topic.trim(),
      metrics: {
        channelCount,
        avgSubscribers,
        avgViewsPerVideo,
        avgViewsToSubsRatio,
        saturationLevel: saturation.level,
        saturationScore: saturation.score,
      },
      channels,
      totalInDatabase: total,
      fromCache,
    });

  } catch (error) {
    console.error('[niche-analyze] Error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to analyze niche',
    });
  }
});

export default router;
