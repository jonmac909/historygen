import { Router, Request, Response } from 'express';
import {
  resolveChannelId as invidiousResolveChannelId,
  getChannel,
  getChannelVideos,
  InvidiousChannel,
  InvidiousVideo,
} from '../lib/invidious';
import {
  resolveChannelId as ytdlpResolveChannelId,
} from '../lib/ytdlp';
import {
  getCachedChannel,
  cacheChannel,
  getCachedOutliersForChannel,
  cacheOutliers,
  CachedOutlier,
} from '../lib/outlier-cache';

// Try Invidious first, fall back to yt-dlp if it fails
async function resolveChannelId(input: string): Promise<string> {
  try {
    return await invidiousResolveChannelId(input);
  } catch (invidiousError) {
    console.log(`[youtube-invidious] Invidious resolve failed, trying yt-dlp...`);
    return await ytdlpResolveChannelId(input);
  }
}

const router = Router();

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

// Convert Invidious video to OutlierVideo format (with calculated metrics)
function invidiousVideoToOutlier(
  video: InvidiousVideo,
  averageViews: number,
  standardDeviation: number,
  subscriberCount: number
): OutlierVideo {
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

  // Always use direct YouTube thumbnail URL (more reliable than Invidious proxy)
  const thumbnailUrl = `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`;

  // Convert Unix timestamp to ISO date
  const publishedAt = video.published
    ? new Date(video.published * 1000).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];

  return {
    videoId: video.videoId,
    title: video.title,
    thumbnailUrl,
    publishedAt,
    duration: `PT${Math.floor(video.lengthSeconds / 60)}M${video.lengthSeconds % 60}S`,
    durationFormatted: formatDurationFromSeconds(video.lengthSeconds),
    durationSeconds: video.lengthSeconds,
    viewCount: video.viewCount || 0,
    likeCount: video.likeCount || 0,
    commentCount: 0, // Invidious doesn't provide comment count in list
    outlierMultiplier,
    zScore,
    isPositiveOutlier,
    isNegativeOutlier,
    viewsPerSubscriber,
  };
}

// Main endpoint - get channel videos via Invidious
router.post('/', async (req: Request, res: Response) => {
  try {
    const { channelInput, maxResults = 50, sortBy = 'outlier', forceRefresh = false } = req.body;

    if (!channelInput) {
      return res.status(400).json({ success: false, error: 'Channel input is required' });
    }

    console.log(`[youtube-invidious] Analyzing channel: ${channelInput} (forceRefresh: ${forceRefresh})`);

    // Resolve channel ID from input
    let channelId: string;
    try {
      channelId = await resolveChannelId(channelInput);
      console.log(`[youtube-invidious] Resolved channel ID: ${channelId}`);
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: `Could not find channel: ${channelInput}`,
      });
    }

    // Check cache first (unless forceRefresh)
    if (!forceRefresh) {
      const cachedOutliers = await getCachedOutliersForChannel(channelId);
      if (cachedOutliers.length > 0) {
        console.log(`[youtube-invidious] Cache HIT for: ${channelId} (${cachedOutliers.length} videos)`);

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
          source: 'invidious',
        });
      }
    }

    // Cache miss or forceRefresh - fetch from Invidious
    console.log(`[youtube-invidious] Cache MISS - fetching from Invidious: ${channelId}`);

    // Get channel info
    let channelInfo: InvidiousChannel;
    try {
      channelInfo = await getChannel(channelId);
    } catch (error) {
      console.error('[youtube-invidious] Failed to get channel:', error);
      return res.status(404).json({
        success: false,
        error: `Could not fetch channel data: ${channelInput}`,
      });
    }

    // Get channel videos
    let invidiousVideos: InvidiousVideo[];
    try {
      invidiousVideos = await getChannelVideos(channelId, { maxResults, sortBy: 'newest' });
    } catch (error) {
      console.error('[youtube-invidious] Failed to get videos:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch channel videos',
      });
    }

    if (invidiousVideos.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No videos found for this channel',
      });
    }

    // Filter out shorts, live streams, and deleted/private videos
    const regularVideos = invidiousVideos.filter(v =>
      !v.liveNow &&
      !v.isUpcoming &&
      v.lengthSeconds > 60 && // Exclude shorts (< 60s)
      v.viewCount > 0 && // Exclude deleted/private videos (0 views)
      v.videoId // Must have valid video ID
    );

    if (regularVideos.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No regular videos found (only shorts/streams)',
      });
    }

    // Calculate statistics for outlier metrics
    const totalViews = regularVideos.reduce((sum, v) => sum + (v.viewCount || 0), 0);
    const averageViews = Math.round(totalViews / regularVideos.length);
    const variance = regularVideos.reduce((sum, v) => sum + Math.pow((v.viewCount || 0) - averageViews, 2), 0) / regularVideos.length;
    const standardDeviation = Math.sqrt(variance);
    const subscriberCount = channelInfo.subCount || 0;

    // Convert to OutlierVideo format with calculated metrics
    const videos = regularVideos.map(v =>
      invidiousVideoToOutlier(v, averageViews, standardDeviation, subscriberCount)
    );

    // Sort according to sortBy
    if (sortBy === 'outlier') {
      videos.sort((a, b) => b.outlierMultiplier - a.outlierMultiplier);
    } else if (sortBy === 'views') {
      videos.sort((a, b) => b.viewCount - a.viewCount);
    } else if (sortBy === 'uploaded') {
      videos.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    }

    // Get channel thumbnail
    const channelThumbnail = channelInfo.authorThumbnails?.find(t => t.width >= 100)
      || channelInfo.authorThumbnails?.[0];

    // Cache the results
    try {
      // Cache channel info
      await cacheChannel({
        id: channelId,
        title: channelInfo.author || 'Unknown Channel',
        handle: channelInfo.authorUrl?.replace('https://www.youtube.com/', ''),
        thumbnail_url: channelThumbnail?.url || '',
        subscriber_count: subscriberCount,
        view_count: channelInfo.totalViews || totalViews,
        video_count: videos.length,
        views_to_subs_ratio: subscriberCount > 0 ? averageViews / subscriberCount : 0,
        avg_views: averageViews,
        is_breakout: false,
        source: 'apify', // Using 'apify' for cache compatibility with existing data
      });

      // Cache outliers
      await cacheOutliers(videos.map(v => ({
        video_id: v.videoId,
        channel_id: channelId,
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
        source: 'apify', // Using 'apify' for cache compatibility
      })));

      console.log(`[youtube-invidious] Cached ${videos.length} videos for channel: ${channelId}`);
    } catch (cacheError) {
      console.error('[youtube-invidious] Cache error (non-fatal):', cacheError);
    }

    const positiveOutliersCount = videos.filter(v => v.isPositiveOutlier).length;
    const negativeOutliersCount = videos.filter(v => v.isNegativeOutlier).length;

    console.log(`[youtube-invidious] Analysis complete. ${videos.length} videos, ${positiveOutliersCount} positive outliers`);

    return res.json({
      success: true,
      channel: {
        id: channelId,
        title: channelInfo.author || 'Unknown Channel',
        handle: channelInfo.authorUrl?.replace('https://www.youtube.com/', ''),
        subscriberCount,
        subscriberCountFormatted: formatNumber(subscriberCount),
        thumbnailUrl: channelThumbnail?.url || '',
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
      source: 'invidious',
    });

  } catch (error) {
    console.error('[youtube-invidious] Error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to analyze channel',
    });
  }
});

export default router;
