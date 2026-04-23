import { Router, Request, Response } from 'express';
import {
  getCachedChannel,
  cacheChannel,
  getCachedOutliersForChannel,
  cacheOutliers,
  CachedChannel,
  CachedOutlier,
} from '../lib/outlier-cache';

const router = Router();

// TubeLab API key from environment
const TUBELAB_API_KEY = process.env.TUBELAB_API_KEY;
const TUBELAB_BASE_URL = 'https://public-api.tubelab.net/v1';

interface OutlierVideo {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  publishedAt: string;
  duration: string;
  durationFormatted: string;
  durationSeconds: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  outlierMultiplier: number;
  viewsPerSubscriber: number;
  zScore: number;
  isPositiveOutlier: boolean;
  isNegativeOutlier: boolean;
  monetization?: {
    rpmEstimationFrom?: number;
    rpmEstimationTo?: number;
    revenueEstimationFrom?: number;
    revenueEstimationTo?: number;
  };
  classification?: {
    isFaceless?: boolean;
    quality?: 'negative' | 'neutral' | 'positive';
  };
}

// Format seconds to duration string (e.g., 330 -> "5:30")
function formatDurationFromSeconds(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
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

// TubeLab outlier video response type
interface TubeLabOutlierHit {
  id: string;
  kind: string;
  snippet: {
    channelId: string;
    channelTitle: string;
    channelHandle?: string;
    channelSubscribers: number;
    title: string;
    publishedAt: string;
    language?: string;
    thumbnails?: {
      default?: { url: string; width: number; height: number };
      medium?: { url: string; width: number; height: number };
      high?: { url: string; width: number; height: number };
    };
    duration: number;
    monetization?: {
      rpmEstimationFrom?: number;
      rpmEstimationTo?: number;
      revenueEstimationFrom?: number;
      revenueEstimationTo?: number;
    };
    channelMonetization?: {
      adsense?: boolean;
      rpmEstimationFrom?: number;
      rpmEstimationTo?: number;
    };
  };
  statistics: {
    commentCount: number;
    likeCount: number;
    viewCount: number;
    zScore: number;
    averageViewsRatio: number;
    isPositiveOutlier: boolean;
    isNegativeOutlier: boolean;
  };
  classification?: {
    isFaceless?: boolean;
    quality?: 'negative' | 'neutral' | 'positive';
  };
}

interface TubeLabOutliersResponse {
  pagination: {
    total: number;
    from: number;
    size: number;
  };
  hits: TubeLabOutlierHit[];
}

// Convert TubeLab outlier to our OutlierVideo format
function tubeLabOutlierToVideo(video: TubeLabOutlierHit, subscriberCount: number): OutlierVideo {
  const durationSeconds = video.snippet.duration || 0;

  return {
    videoId: video.id,
    title: video.snippet.title,
    thumbnailUrl: video.snippet.thumbnails?.medium?.url
      || video.snippet.thumbnails?.high?.url
      || video.snippet.thumbnails?.default?.url
      || '',
    publishedAt: video.snippet.publishedAt,
    duration: `PT${Math.floor(durationSeconds / 60)}M${durationSeconds % 60}S`,
    durationFormatted: formatDurationFromSeconds(durationSeconds),
    durationSeconds,
    viewCount: video.statistics.viewCount,
    likeCount: video.statistics.likeCount || 0,
    commentCount: video.statistics.commentCount || 0,
    outlierMultiplier: Math.round(video.statistics.averageViewsRatio * 10) / 10,
    zScore: Math.round(video.statistics.zScore * 100) / 100,
    isPositiveOutlier: video.statistics.isPositiveOutlier,
    isNegativeOutlier: video.statistics.isNegativeOutlier,
    viewsPerSubscriber: subscriberCount > 0
      ? Math.round((video.statistics.viewCount / subscriberCount) * 100) / 100
      : 0,
    monetization: video.snippet.monetization,
    classification: video.classification,
  };
}

// Convert cached outlier to OutlierVideo format
function cachedOutlierToVideo(cached: CachedOutlier): OutlierVideo {
  return {
    videoId: cached.video_id,
    title: cached.title,
    thumbnailUrl: cached.thumbnail_url,
    publishedAt: cached.published_at,
    duration: `PT${Math.floor(cached.duration_seconds / 60)}M${cached.duration_seconds % 60}S`,
    durationFormatted: formatDurationFromSeconds(cached.duration_seconds),
    durationSeconds: cached.duration_seconds,
    viewCount: cached.view_count,
    likeCount: cached.like_count,
    commentCount: cached.comment_count,
    outlierMultiplier: cached.outlier_multiplier,
    zScore: cached.z_score,
    isPositiveOutlier: cached.is_positive_outlier,
    isNegativeOutlier: cached.is_negative_outlier,
    viewsPerSubscriber: cached.views_per_subscriber,
    monetization: cached.monetization as OutlierVideo['monetization'],
    classification: cached.classification as OutlierVideo['classification'],
  };
}

// Convert OutlierVideo to cache format
function outlierVideoToCacheFormat(video: OutlierVideo, channelId: string): Omit<CachedOutlier, 'fetched_at' | 'expires_at'> {
  return {
    video_id: video.videoId,
    channel_id: channelId,
    title: video.title,
    thumbnail_url: video.thumbnailUrl,
    published_at: video.publishedAt,
    duration_seconds: video.durationSeconds,
    view_count: video.viewCount,
    like_count: video.likeCount,
    comment_count: video.commentCount,
    outlier_multiplier: video.outlierMultiplier,
    z_score: video.zScore,
    views_per_subscriber: video.viewsPerSubscriber,
    is_positive_outlier: video.isPositiveOutlier,
    is_negative_outlier: video.isNegativeOutlier,
    monetization: video.monetization,
    classification: video.classification,
    source: 'tubelab',
  };
}

// Resolve channel input to channel ID using TubeLab channels search (with caching)
async function resolveChannelId(input: string): Promise<{ channelId: string; channelInfo: any; fromCache: boolean } | null> {
  input = input.trim();
  let searchQuery = input;

  // Check if it's a channel ID format (starts with UC)
  if (input.startsWith('UC') && input.length === 24) {
    // Check cache for this channel ID
    const cached = await getCachedChannel(input);
    if (cached) {
      console.log(`[youtube-channel-stats] Cache HIT for channel ID: ${input}`);
      return {
        channelId: input,
        channelInfo: {
          id: cached.id,
          title: cached.title,
          handle: cached.handle,
          subscriberCount: cached.subscriber_count,
          thumbnailUrl: cached.thumbnail_url,
          avgViews: cached.avg_views,
          videoCount: cached.video_count,
        },
        fromCache: true,
      };
    }
    return { channelId: input, channelInfo: null, fromCache: false };
  }

  // Parse URL to extract handle
  if (input.includes('youtube.com') || input.includes('youtu.be')) {
    try {
      const url = new URL(input.startsWith('http') ? input : `https://${input}`);
      const pathname = url.pathname;

      if (pathname.startsWith('/channel/')) {
        const channelId = pathname.split('/channel/')[1].split('/')[0];
        if (channelId) {
          const cached = await getCachedChannel(channelId);
          if (cached) {
            console.log(`[youtube-channel-stats] Cache HIT for channel URL: ${channelId}`);
            return {
              channelId,
              channelInfo: {
                id: cached.id,
                title: cached.title,
                handle: cached.handle,
                subscriberCount: cached.subscriber_count,
                thumbnailUrl: cached.thumbnail_url,
              },
              fromCache: true,
            };
          }
          return { channelId, channelInfo: null, fromCache: false };
        }
      }

      if (pathname.startsWith('/@')) {
        searchQuery = pathname.split('/@')[1].split('/')[0];
      }

      if (pathname.startsWith('/c/') || pathname.startsWith('/user/')) {
        const segments = pathname.split('/');
        searchQuery = segments[2];
      }
    } catch (e) {
      // Not a valid URL, use as-is
    }
  }

  if (searchQuery.startsWith('@')) {
    searchQuery = searchQuery.substring(1);
  }

  // Search TubeLab for this channel
  console.log(`[youtube-channel-stats] Cache MISS - searching TubeLab for: ${searchQuery}`);

  const url = new URL(`${TUBELAB_BASE_URL}/channels`);
  url.searchParams.set('query', searchQuery);
  url.searchParams.set('size', '1');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': `Api-Key ${TUBELAB_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    console.error(`[youtube-channel-stats] TubeLab search error: ${response.status}`);
    return null;
  }

  const data = await response.json() as any;

  if (data.hits && data.hits.length > 0) {
    const channel = data.hits[0];
    console.log(`[youtube-channel-stats] Found channel: ${channel.snippet?.title} (${channel.id})`);

    const channelInfo = {
      id: channel.id,
      title: channel.snippet?.title,
      handle: channel.snippet?.handle,
      subscriberCount: channel.statistics?.subscriberCount || 0,
      thumbnailUrl: channel.snippet?.thumbnails?.medium?.url
        || channel.snippet?.thumbnails?.high?.url
        || channel.snippet?.thumbnails?.default?.url
        || '',
      avgViews: channel.statistics?.avgViewsEstimate || 0,
      videoCount: channel.statistics?.videoCount || 0,
    };

    // Cache the channel
    await cacheChannel({
      id: channel.id,
      title: channelInfo.title,
      handle: channelInfo.handle,
      thumbnail_url: channelInfo.thumbnailUrl,
      subscriber_count: channelInfo.subscriberCount,
      view_count: channel.statistics?.viewCount || 0,
      video_count: channelInfo.videoCount,
      views_to_subs_ratio: channel.statistics?.avgViewsToSubscribersRatio || 0,
      avg_views: channelInfo.avgViews,
      is_breakout: (channel.statistics?.avgViewsToSubscribersRatio || 0) > 2,
      created_at: channel.snippet?.publishedAt,
      monetization: channel.monetization,
      source: 'tubelab',
    });

    return { channelId: channel.id, channelInfo, fromCache: false };
  }

  console.error(`[youtube-channel-stats] Channel not found in TubeLab: ${searchQuery}`);
  return null;
}

// Get outlier videos for a channel from TubeLab (with caching)
async function getChannelOutliersWithCache(
  channelId: string,
  maxResults: number = 40,
  sortBy: string = 'averageViewsRatio',
  subscriberCount: number = 0,
  forceRefresh: boolean = false
): Promise<{ videos: OutlierVideo[]; total: number; fromCache: boolean }> {

  // Check cache first (unless forceRefresh is true)
  if (!forceRefresh) {
    const cachedOutliers = await getCachedOutliersForChannel(channelId);
    if (cachedOutliers.length > 0) {
      console.log(`[youtube-channel-stats] Cache HIT for outliers: ${channelId} (${cachedOutliers.length} videos)`);

      let videos = cachedOutliers.map(cachedOutlierToVideo);

      // Sort according to sortBy
      if (sortBy === 'outlier' || sortBy === 'averageViewsRatio') {
        videos.sort((a, b) => b.outlierMultiplier - a.outlierMultiplier);
      } else if (sortBy === 'views') {
        videos.sort((a, b) => b.viewCount - a.viewCount);
      } else if (sortBy === 'uploaded' || sortBy === 'publishedAt') {
        videos.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
      }

      // Limit results
      if (videos.length > maxResults) {
        videos = videos.slice(0, maxResults);
      }

      return {
        videos,
        total: cachedOutliers.length,
        fromCache: true,
      };
    }
  }

  // Cache miss (or forceRefresh) - call TubeLab API
  console.log(`[youtube-channel-stats] Cache MISS - calling TubeLab outliers API for: ${channelId}`);

  const url = new URL(`${TUBELAB_BASE_URL}/outliers`);
  url.searchParams.set('channelId', channelId);
  url.searchParams.set('size', maxResults.toString());
  url.searchParams.set('sortBy', sortBy === 'outlier' ? 'averageViewsRatio' : sortBy === 'views' ? 'views' : 'publishedAt');
  url.searchParams.set('sortOrder', 'desc');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': `Api-Key ${TUBELAB_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[youtube-channel-stats] TubeLab API error: ${response.status} ${errorText}`);
    throw new Error(`TubeLab API error: ${response.status}`);
  }

  const data = await response.json() as TubeLabOutliersResponse;

  console.log(`[youtube-channel-stats] TubeLab returned ${data.hits?.length || 0} outliers (total: ${data.pagination?.total || 0})`);

  if (!data.hits || data.hits.length === 0) {
    return { videos: [], total: 0, fromCache: false };
  }

  const videos = data.hits.map(hit => tubeLabOutlierToVideo(hit, subscriberCount));
  const total = data.pagination?.total || videos.length;

  // Cache the outliers
  await cacheOutliers(videos.map(v => outlierVideoToCacheFormat(v, channelId)));

  return { videos, total, fromCache: false };
}

// Main endpoint
router.post('/', async (req: Request, res: Response) => {
  try {
    const { channelInput, maxResults = 40, sortBy = 'outlier', forceRefresh = false } = req.body;

    if (!channelInput) {
      return res.status(400).json({ success: false, error: 'Channel input is required' });
    }

    if (!TUBELAB_API_KEY) {
      return res.status(500).json({ success: false, error: 'TubeLab API key not configured' });
    }

    console.log(`[youtube-channel-stats] Analyzing channel: ${channelInput} (forceRefresh: ${forceRefresh})`);

    // Step 1: Resolve channel ID and get channel info (with caching)
    const resolved = await resolveChannelId(channelInput);
    if (!resolved) {
      return res.status(404).json({ success: false, error: 'Channel not found in TubeLab database' });
    }

    const { channelId, channelInfo, fromCache: channelFromCache } = resolved;

    // Step 2: Get outlier videos (with caching, or force refresh)
    const { videos: outlierVideos, total, fromCache: videosFromCache } = await getChannelOutliersWithCache(
      channelId,
      maxResults,
      sortBy,
      channelInfo?.subscriberCount || 0,
      forceRefresh
    );

    if (outlierVideos.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No videos found for this channel in TubeLab database'
      });
    }

    // Extract channel info from first video if we don't have it
    const channel = channelInfo || {
      id: channelId,
      title: 'Unknown Channel',
      handle: undefined,
      subscriberCount: 0,
      thumbnailUrl: '',
    };

    // Calculate average views from the videos
    const totalViews = outlierVideos.reduce((sum, v) => sum + v.viewCount, 0);
    const averageViews = Math.round(totalViews / outlierVideos.length);

    // Calculate standard deviation
    const variance = outlierVideos.reduce((sum, v) =>
      sum + Math.pow(v.viewCount - averageViews, 2), 0
    ) / outlierVideos.length;
    const standardDeviation = Math.sqrt(variance);

    // Count positive and negative outliers
    const positiveOutliersCount = outlierVideos.filter(v => v.isPositiveOutlier).length;
    const negativeOutliersCount = outlierVideos.filter(v => v.isNegativeOutlier).length;

    const fromCache = channelFromCache && videosFromCache;
    console.log(`[youtube-channel-stats] Analysis complete. ${outlierVideos.length} videos, ${positiveOutliersCount} positive outliers, fromCache: ${fromCache}`);

    return res.json({
      success: true,
      channel: {
        id: channel.id,
        title: channel.title,
        handle: channel.handle,
        subscriberCount: channel.subscriberCount,
        subscriberCountFormatted: formatNumber(channel.subscriberCount),
        thumbnailUrl: channel.thumbnailUrl,
        averageViews,
        averageViewsFormatted: formatNumber(averageViews),
        standardDeviation: Math.round(standardDeviation),
        standardDeviationFormatted: formatNumber(Math.round(standardDeviation)),
        positiveOutliersCount,
        negativeOutliersCount,
        totalVideosInDatabase: total,
      },
      videos: outlierVideos,
      fromCache,
    });

  } catch (error) {
    console.error('[youtube-channel-stats] Error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to analyze channel',
    });
  }
});

export default router;
