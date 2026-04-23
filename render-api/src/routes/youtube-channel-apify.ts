import { Router, Request, Response } from 'express';
import { ApifyClient } from 'apify-client';
import {
  getCachedChannel,
  cacheChannel,
  getCachedOutliersForChannel,
  cacheOutliers,
  CachedOutlier,
} from '../lib/outlier-cache';

const router = Router();

// Initialize Apify client
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
const apifyClient = APIFY_API_TOKEN ? new ApifyClient({ token: APIFY_API_TOKEN }) : null;

// YouTube Channel Scraper actor ID - using free official actor
// Note: 'streamers/youtube-channel-scraper' is free and accessible with any Apify token
const YOUTUBE_SCRAPER_ACTOR_ID = 'streamers/youtube-channel-scraper';

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

// Parse ISO 8601 duration to seconds (e.g., "PT5M30S" -> 330)
function parseDuration(duration: string): number {
  if (!duration) return 0;

  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;

  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);

  return hours * 3600 + minutes * 60 + seconds;
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
  };
}

// Apify YouTube video result type
interface ApifyVideoResult {
  id: string;
  title: string;
  thumbnailUrl?: string;
  viewCount: number;
  likes?: number;
  commentsCount?: number;
  date: string;  // e.g., "2024-01-15"
  duration?: string;  // ISO 8601 or raw seconds
}

// Apify YouTube channel result type
interface ApifyChannelResult {
  channelId: string;
  channelName: string;
  channelUrl: string;
  subscriberCount?: number;
  thumbnailUrl?: string;
}

// Convert Apify video to OutlierVideo format (with calculated metrics)
function apifyVideoToOutlier(
  video: ApifyVideoResult,
  averageViews: number,
  standardDeviation: number,
  subscriberCount: number
): OutlierVideo {
  // Parse duration - could be ISO 8601 or raw seconds
  let durationSeconds = 0;
  if (video.duration) {
    if (typeof video.duration === 'number') {
      durationSeconds = video.duration;
    } else if (video.duration.startsWith('PT')) {
      durationSeconds = parseDuration(video.duration);
    } else {
      // Try parsing as seconds
      durationSeconds = parseInt(video.duration, 10) || 0;
    }
  }

  // Calculate outlier metrics
  const outlierMultiplier = averageViews > 0
    ? Math.round((video.viewCount / averageViews) * 10) / 10
    : 0;

  const zScore = standardDeviation > 0
    ? Math.round(((video.viewCount - averageViews) / standardDeviation) * 100) / 100
    : 0;

  const viewsPerSubscriber = subscriberCount > 0
    ? Math.round((video.viewCount / subscriberCount) * 100) / 100
    : 0;

  // Determine outlier classification
  const isPositiveOutlier = outlierMultiplier >= 3 || zScore >= 2;
  const isNegativeOutlier = outlierMultiplier <= 0.3 || zScore <= -1.5;

  return {
    videoId: video.id,
    title: video.title,
    thumbnailUrl: video.thumbnailUrl || `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`,
    publishedAt: video.date,
    duration: `PT${Math.floor(durationSeconds / 60)}M${durationSeconds % 60}S`,
    durationFormatted: formatDurationFromSeconds(durationSeconds),
    durationSeconds,
    viewCount: video.viewCount,
    likeCount: video.likes || 0,
    commentCount: video.commentsCount || 0,
    outlierMultiplier,
    zScore,
    isPositiveOutlier,
    isNegativeOutlier,
    viewsPerSubscriber,
  };
}

// Scrape channel videos using Apify
async function scrapeChannelWithApify(
  channelUrl: string,
  maxVideos: number = 50
): Promise<{ channel: any; videos: ApifyVideoResult[] }> {
  if (!apifyClient) {
    throw new Error('Apify API token not configured');
  }

  console.log(`[youtube-channel-apify] Starting Apify scrape for: ${channelUrl}`);

  // Run the YouTube scraper actor with minimal memory to stay within free tier limits
  const run = await apifyClient.actor(YOUTUBE_SCRAPER_ACTOR_ID).call(
    {
      startUrls: [{ url: channelUrl }],
      maxResults: maxVideos,
      maxResultsShorts: 0,  // Skip shorts
      maxResultStreams: 0,  // Skip streams
    },
    {
      memory: 256,  // Use minimum memory (256MB) to stay within free tier
      timeout: 120, // 2 minute timeout per channel
    }
  );

  console.log(`[youtube-channel-apify] Apify run completed: ${run.id}`);

  // Get the results from the dataset
  const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();

  console.log(`[youtube-channel-apify] Got ${items.length} items from Apify`);

  // Separate channel info from videos
  let channelInfo: ApifyChannelResult | null = null;
  const videos: ApifyVideoResult[] = [];

  for (const item of items) {
    if (item.type === 'channel' || item.channelId && !item.id) {
      channelInfo = item as unknown as ApifyChannelResult;
    } else if (item.id && item.title) {
      videos.push(item as unknown as ApifyVideoResult);
    }
  }

  return { channel: channelInfo, videos };
}

// Main endpoint - scrape channel with Apify
router.post('/', async (req: Request, res: Response) => {
  try {
    const { channelInput, maxResults = 50, sortBy = 'outlier', forceRefresh = false } = req.body;

    if (!channelInput) {
      return res.status(400).json({ success: false, error: 'Channel input is required' });
    }

    if (!APIFY_API_TOKEN) {
      return res.status(500).json({ success: false, error: 'Apify API token not configured' });
    }

    console.log(`[youtube-channel-apify] Analyzing channel: ${channelInput} (forceRefresh: ${forceRefresh})`);

    // Build channel URL from input
    let channelUrl = channelInput;
    if (!channelInput.includes('youtube.com')) {
      if (channelInput.startsWith('@')) {
        channelUrl = `https://www.youtube.com/${channelInput}`;
      } else if (channelInput.startsWith('UC')) {
        channelUrl = `https://www.youtube.com/channel/${channelInput}`;
      } else {
        channelUrl = `https://www.youtube.com/@${channelInput}`;
      }
    }

    // Extract channel ID from URL for caching
    let channelId = '';
    if (channelInput.startsWith('UC') && channelInput.length >= 24) {
      channelId = channelInput.substring(0, 24);
    }

    // Check cache first (unless forceRefresh)
    if (!forceRefresh && channelId) {
      const cachedOutliers = await getCachedOutliersForChannel(channelId);
      if (cachedOutliers.length > 0) {
        console.log(`[youtube-channel-apify] Cache HIT for: ${channelId} (${cachedOutliers.length} videos)`);

        const videos = cachedOutliers.map(cachedOutlierToVideo);

        // Sort according to sortBy
        if (sortBy === 'outlier') {
          videos.sort((a, b) => b.outlierMultiplier - a.outlierMultiplier);
        } else if (sortBy === 'views') {
          videos.sort((a, b) => b.viewCount - a.viewCount);
        } else if (sortBy === 'uploaded') {
          videos.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
        }

        // Get cached channel info
        const cachedChannel = await getCachedChannel(channelId);

        // Calculate stats from cached videos
        const totalViews = videos.reduce((sum, v) => sum + v.viewCount, 0);
        const averageViews = Math.round(totalViews / videos.length);
        const variance = videos.reduce((sum, v) => sum + Math.pow(v.viewCount - averageViews, 2), 0) / videos.length;
        const standardDeviation = Math.sqrt(variance);

        return res.json({
          success: true,
          channel: {
            id: channelId,
            title: cachedChannel?.title || 'Unknown Channel',
            handle: cachedChannel?.handle,
            subscriberCount: cachedChannel?.subscriber_count || 0,
            subscriberCountFormatted: formatNumber(cachedChannel?.subscriber_count || 0),
            thumbnailUrl: cachedChannel?.thumbnail_url || '',
            averageViews,
            averageViewsFormatted: formatNumber(averageViews),
            standardDeviation: Math.round(standardDeviation),
            standardDeviationFormatted: formatNumber(Math.round(standardDeviation)),
            positiveOutliersCount: videos.filter(v => v.isPositiveOutlier).length,
            negativeOutliersCount: videos.filter(v => v.isNegativeOutlier).length,
            totalVideosInDatabase: videos.length,
          },
          videos: videos.slice(0, maxResults),
          fromCache: true,
          source: 'apify',
        });
      }
    }

    // Cache miss or forceRefresh - scrape with Apify
    console.log(`[youtube-channel-apify] Cache MISS - scraping with Apify: ${channelUrl}`);

    const { channel: apifyChannel, videos: apifyVideos } = await scrapeChannelWithApify(channelUrl, maxResults);

    if (apifyVideos.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No videos found for this channel',
      });
    }

    // Calculate statistics for outlier metrics
    const totalViews = apifyVideos.reduce((sum, v) => sum + v.viewCount, 0);
    const averageViews = Math.round(totalViews / apifyVideos.length);
    const variance = apifyVideos.reduce((sum, v) => sum + Math.pow(v.viewCount - averageViews, 2), 0) / apifyVideos.length;
    const standardDeviation = Math.sqrt(variance);
    const subscriberCount = apifyChannel?.subscriberCount || 0;

    // Convert to OutlierVideo format with calculated metrics
    const videos = apifyVideos.map(v =>
      apifyVideoToOutlier(v, averageViews, standardDeviation, subscriberCount)
    );

    // Sort according to sortBy
    if (sortBy === 'outlier') {
      videos.sort((a, b) => b.outlierMultiplier - a.outlierMultiplier);
    } else if (sortBy === 'views') {
      videos.sort((a, b) => b.viewCount - a.viewCount);
    } else if (sortBy === 'uploaded') {
      videos.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    }

    // Get channel ID from first video or Apify result
    const resolvedChannelId = apifyChannel?.channelId || (apifyVideos[0] as any)?.channelId || channelId;

    // Cache the results
    if (resolvedChannelId) {
      // Cache channel info
      await cacheChannel({
        id: resolvedChannelId,
        title: apifyChannel?.channelName || 'Unknown Channel',
        handle: apifyChannel?.channelUrl?.replace('https://www.youtube.com/', ''),
        thumbnail_url: apifyChannel?.thumbnailUrl || '',
        subscriber_count: subscriberCount,
        view_count: totalViews,
        video_count: videos.length,
        views_to_subs_ratio: subscriberCount > 0 ? averageViews / subscriberCount : 0,
        avg_views: averageViews,
        is_breakout: false,
        source: 'apify',
      });

      // Cache outliers
      await cacheOutliers(videos.map(v => ({
        video_id: v.videoId,
        channel_id: resolvedChannelId,
        title: v.title,
        thumbnail_url: v.thumbnailUrl,
        published_at: v.publishedAt,
        duration_seconds: v.durationSeconds,
        view_count: v.viewCount,
        like_count: v.likeCount,
        comment_count: v.commentCount,
        outlier_multiplier: v.outlierMultiplier,
        z_score: v.zScore,
        views_per_subscriber: v.viewsPerSubscriber,
        is_positive_outlier: v.isPositiveOutlier,
        is_negative_outlier: v.isNegativeOutlier,
        source: 'apify',
      })));

      console.log(`[youtube-channel-apify] Cached ${videos.length} videos for channel: ${resolvedChannelId}`);
    }

    const positiveOutliersCount = videos.filter(v => v.isPositiveOutlier).length;
    const negativeOutliersCount = videos.filter(v => v.isNegativeOutlier).length;

    console.log(`[youtube-channel-apify] Analysis complete. ${videos.length} videos, ${positiveOutliersCount} positive outliers`);

    return res.json({
      success: true,
      channel: {
        id: resolvedChannelId || 'unknown',
        title: apifyChannel?.channelName || 'Unknown Channel',
        handle: apifyChannel?.channelUrl?.replace('https://www.youtube.com/', ''),
        subscriberCount,
        subscriberCountFormatted: formatNumber(subscriberCount),
        thumbnailUrl: apifyChannel?.thumbnailUrl || '',
        averageViews,
        averageViewsFormatted: formatNumber(averageViews),
        standardDeviation: Math.round(standardDeviation),
        standardDeviationFormatted: formatNumber(Math.round(standardDeviation)),
        positiveOutliersCount,
        negativeOutliersCount,
        totalVideosInDatabase: videos.length,
      },
      videos: videos.slice(0, maxResults),
      fromCache: false,
      source: 'apify',
    });

  } catch (error) {
    console.error('[youtube-channel-apify] Error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to analyze channel',
    });
  }
});

export default router;
