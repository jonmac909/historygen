import { Router, Request, Response } from 'express';
import {
  resolveChannelId,
  getChannelVideos,
  getChannelInfo,
  ScrapedVideo,
  withTimeout,
} from '../lib/youtube-scraper';
import {
  getCachedChannel,
  cacheChannel,
  getCachedOutliersForChannel,
  cacheOutliers,
  CachedOutlier,
} from '../lib/outlier-cache';

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

// Convert upload_date (YYYYMMDD) to ISO string
function uploadDateToISO(uploadDate: string | undefined): string {
  if (!uploadDate || uploadDate.length !== 8) {
    return new Date().toISOString();
  }
  const year = uploadDate.substring(0, 4);
  const month = uploadDate.substring(4, 6);
  const day = uploadDate.substring(6, 8);
  return `${year}-${month}-${day}T00:00:00Z`;
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

// Convert scraped video to OutlierVideo format (with calculated metrics)
function scrapedVideoToOutlier(
  video: ScrapedVideo,
  averageViews: number,
  standardDeviation: number,
  subscriberCount: number
): OutlierVideo {
  const viewCount = video.views || 0;
  const outlierMultiplier = averageViews > 0 ? viewCount / averageViews : 0;
  const zScore = standardDeviation > 0 ? (viewCount - averageViews) / standardDeviation : 0;
  const isPositiveOutlier = zScore > 2;
  const isNegativeOutlier = zScore < -1.5;
  const viewsPerSubscriber = subscriberCount > 0 ? viewCount / subscriberCount : 0;

  const durationSeconds = video.duration || 0;
  // publishedText is like "2 weeks ago" - convert to approximate ISO date
  const publishedAt = video.publishedText ? estimateDateFromRelative(video.publishedText) : new Date().toISOString();

  return {
    videoId: video.id,
    title: video.title,
    thumbnailUrl: video.thumbnail || `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`,
    publishedAt,
    duration: `PT${Math.floor(durationSeconds / 60)}M${durationSeconds % 60}S`,
    durationFormatted: formatDurationFromSeconds(durationSeconds),
    durationSeconds,
    viewCount,
    likeCount: 0, // Not available from scraper
    commentCount: 0,
    outlierMultiplier,
    zScore,
    isPositiveOutlier,
    isNegativeOutlier,
    viewsPerSubscriber,
  };
}

// Estimate date from relative text like "2 weeks ago"
function estimateDateFromRelative(text: string): string {
  const now = new Date();
  const match = text.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i);
  if (!match) return now.toISOString();

  const num = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 'second': now.setSeconds(now.getSeconds() - num); break;
    case 'minute': now.setMinutes(now.getMinutes() - num); break;
    case 'hour': now.setHours(now.getHours() - num); break;
    case 'day': now.setDate(now.getDate() - num); break;
    case 'week': now.setDate(now.getDate() - num * 7); break;
    case 'month': now.setMonth(now.getMonth() - num); break;
    case 'year': now.setFullYear(now.getFullYear() - num); break;
  }
  return now.toISOString();
}

// Main endpoint - get channel videos via yt-dlp
router.post('/', async (req: Request, res: Response) => {
  try {
    const { channelInput, maxResults = 50, sortBy = 'outlier', forceRefresh = false } = req.body;

    if (!channelInput) {
      return res.status(400).json({ success: false, error: 'Channel input is required' });
    }

    console.log(`[youtube-scraper] Analyzing channel: ${channelInput} (forceRefresh: ${forceRefresh})`);

    // Resolve channel ID from input (with 20s timeout)
    let channelId: string;
    try {
      channelId = await withTimeout(
        resolveChannelId(channelInput),
        20000,
        `resolveChannelId(${channelInput})`
      );
      console.log(`[youtube-scraper] Resolved channel ID: ${channelId}`);
    } catch (error: any) {
      console.error(`[youtube-scraper] Failed to resolve channel: ${channelInput}`, error?.message);
      return res.status(404).json({
        success: false,
        error: `Could not find channel: ${channelInput}`,
      });
    }

    // Check cache first (unless forceRefresh)
    if (!forceRefresh) {
      const cachedOutliers = await getCachedOutliersForChannel(channelId);
      if (cachedOutliers.length > 0) {
        console.log(`[youtube-scraper] Cache HIT for: ${channelId} (${cachedOutliers.length} videos)`);

        let videos = cachedOutliers.map(cachedOutlierToVideo);

        // Get cached channel info
        const cachedChannel = await getCachedChannel(channelId);

        // IMPORTANT: Limit to maxResults for average calculation to match fresh fetch behavior
        // Sort by published date (most recent first) and take only first N for average
        const sortedByRecent = [...videos].sort((a, b) =>
          new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
        );
        const videosForStats = sortedByRecent.slice(0, maxResults);

        // Calculate stats (filter out 0-view videos for accurate average)
        const videosWithViews = videosForStats.filter(v => v.viewCount > 0);
        const totalViews = videosWithViews.reduce((sum, v) => sum + v.viewCount, 0);
        const averageViews = videosWithViews.length > 0 ? Math.round(totalViews / videosWithViews.length) : 0;
        const variance = videosWithViews.reduce((sum, v) => sum + Math.pow(v.viewCount - averageViews, 2), 0) / (videosWithViews.length || 1);
        const standardDeviation = Math.sqrt(variance);

        // IMPORTANT: Recalculate outlierMultiplier using the fresh averageViews
        // The cached outlier_multiplier may have been calculated with different average
        videos = videos.map(v => ({
          ...v,
          outlierMultiplier: averageViews > 0 ? v.viewCount / averageViews : 0,
          zScore: standardDeviation > 0 ? (v.viewCount - averageViews) / standardDeviation : 0,
          isPositiveOutlier: standardDeviation > 0 ? (v.viewCount - averageViews) / standardDeviation > 2 : false,
          isNegativeOutlier: standardDeviation > 0 ? (v.viewCount - averageViews) / standardDeviation < -1.5 : false,
        }));

        // Sort according to sortBy (after recalculation)
        if (sortBy === 'outlier') {
          videos.sort((a, b) => b.outlierMultiplier - a.outlierMultiplier);
        } else if (sortBy === 'views') {
          videos.sort((a, b) => b.viewCount - a.viewCount);
        } else if (sortBy === 'uploaded') {
          videos.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
        }

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
          source: 'scraper',
        });
      }
    }

    // Cache miss or forceRefresh - fetch from scraper
    console.log(`[youtube-scraper] Cache MISS - fetching: ${channelId}`);

    // Get channel info (with 30s timeout)
    const channelInfo = await withTimeout(
      getChannelInfo(channelId),
      30000,
      `getChannelInfo(${channelId})`
    );
    const subscriberCount = channelInfo.subscriberCount || 0;

    // Get channel videos (with 45s timeout)
    const scrapedVideos = await withTimeout(
      getChannelVideos(channelId, maxResults),
      45000,
      `getChannelVideos(${channelId})`
    );

    if (scrapedVideos.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No videos found for this channel',
      });
    }

    // Calculate statistics
    const videosWithViews = scrapedVideos.filter(v => v.views && v.views > 0);
    const totalViews = videosWithViews.reduce((sum, v) => sum + (v.views || 0), 0);
    const averageViews = videosWithViews.length > 0 ? Math.round(totalViews / videosWithViews.length) : 0;
    const variance = videosWithViews.reduce((sum, v) => sum + Math.pow((v.views || 0) - averageViews, 2), 0) / (videosWithViews.length || 1);
    const standardDeviation = Math.sqrt(variance);

    // Convert to OutlierVideo format
    const videos: OutlierVideo[] = scrapedVideos.map(v =>
      scrapedVideoToOutlier(v, averageViews, standardDeviation, subscriberCount)
    );

    // Sort according to sortBy
    if (sortBy === 'outlier') {
      videos.sort((a, b) => b.outlierMultiplier - a.outlierMultiplier);
    } else if (sortBy === 'views') {
      videos.sort((a, b) => b.viewCount - a.viewCount);
    } else if (sortBy === 'uploaded') {
      videos.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    }

    // Cache the results
    try {
      await cacheChannel({
        id: channelId,
        title: channelInfo.name,
        thumbnail_url: channelInfo.thumbnailUrl,
        subscriber_count: subscriberCount,
        view_count: totalViews,
        video_count: videos.length,
        views_to_subs_ratio: subscriberCount > 0 ? averageViews / subscriberCount : 0,
        avg_views: averageViews,
        is_breakout: false,
        source: 'apify', // Using 'apify' for cache compatibility
      });

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
        is_positive_outlier: v.isPositiveOutlier,
        is_negative_outlier: v.isNegativeOutlier,
        views_per_subscriber: v.viewsPerSubscriber,
        source: 'apify' as const, // Using 'apify' for cache compatibility
      })));
      console.log(`[youtube-scraper] Cached ${videos.length} videos for channel ${channelId}`);
    } catch (cacheError) {
      console.error('[youtube-scraper] Cache error (non-fatal):', cacheError);
    }

    return res.json({
      success: true,
      channel: {
        id: channelId,
        title: channelInfo.name,
        subscriberCount,
        subscriberCountFormatted: formatNumber(subscriberCount),
        thumbnailUrl: channelInfo.thumbnailUrl,
        averageViews,
        averageViewsFormatted: formatNumber(averageViews),
        standardDeviation: Math.round(standardDeviation),
        standardDeviationFormatted: formatNumber(Math.round(standardDeviation)),
        positiveOutliersCount: videos.filter(v => v.isPositiveOutlier).length,
        negativeOutliersCount: videos.filter(v => v.isNegativeOutlier).length,
        totalVideosInDatabase: videos.length,
      },
      videos: videos.slice(0, maxResults),
      fromCache: false,
      source: 'scraper',
    });

  } catch (error: any) {
    console.error('[youtube-scraper] Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    });
  }
});

export default router;
