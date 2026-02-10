/**
 * Auto-Clone Route - Daily automated video cloning system
 *
 * POST /auto-clone - Trigger daily clone (cron job)
 * GET /auto-clone/status - View run history
 * GET /auto-clone/processed - View processed videos
 * POST /auto-clone/retry/:videoId - Retry a failed video
 */

import { Router, Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { runPipeline, getNext5pmPST } from '../lib/pipeline-runner';
import { getChannelVideos, ScrapedVideo } from '../lib/youtube-scraper';
import { getCachedOutliersForChannel, CachedOutlier, cacheOutliers } from '../lib/outlier-cache';

const router = Router();

// Fetch video info (title, duration) from YouTube using InnerTube API
async function getVideoInfo(videoId: string): Promise<{ title: string; durationSeconds: number } | null> {
  try {
    const response = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20240101.00.00',
          },
        },
      }),
    });

    if (!response.ok) {
      console.log(`[AutoClone] Failed to fetch video info: ${response.status}`);
      return null;
    }

    const data = await response.json() as any;
    const videoDetails = data?.videoDetails;

    if (!videoDetails) {
      console.log('[AutoClone] No video details in response');
      return null;
    }

    return {
      title: videoDetails.title || 'Unknown Title',
      durationSeconds: parseInt(videoDetails.lengthSeconds || '0', 10),
    };
  } catch (error) {
    console.error('[AutoClone] Error fetching video info:', error);
    return null;
  }
}

// WhatsApp notification via TextMeBot (https://www.textmebot.com)
// Retries up to 5 times with 3-second delays to handle TextMeBot timeouts
async function sendWhatsAppNotification(message: string): Promise<void> {
  const phone = process.env.WHATSAPP_PHONE;
  const apiKey = process.env.WHATSAPP_API_KEY;

  if (!phone || !apiKey) {
    console.log('[AutoClone] WhatsApp notifications not configured (missing WHATSAPP_PHONE or WHATSAPP_API_KEY)');
    return;
  }

  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 3000; // 3 seconds between retries

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const encodedMessage = encodeURIComponent(message);
      const url = `https://api.textmebot.com/send.php?recipient=${phone}&apikey=${apiKey}&text=${encodedMessage}`;

      const response = await fetch(url);
      const responseText = await response.text();

      // TextMeBot can return 200 but with "Failed" in the response body
      if (response.ok && !responseText.includes('Failed')) {
        console.log(`[AutoClone] WhatsApp notification sent (attempt ${attempt}):`, responseText);
        return; // Success - exit
      }

      console.warn(`[AutoClone] WhatsApp attempt ${attempt}/${MAX_RETRIES} failed: ${response.status} - ${responseText}`);
    } catch (error) {
      console.warn(`[AutoClone] WhatsApp attempt ${attempt}/${MAX_RETRIES} error:`, error);
    }

    // Wait before retry (except on last attempt)
    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  console.error('[AutoClone] WhatsApp notification failed after 5 attempts');
}

// Minimum video duration for outlier selection (1 hour)
const MIN_DURATION_SECONDS = 3600;

// Days to look back for outliers (35 days to catch "about 1 month" videos)
const OUTLIER_DAYS = 35;

// Whitelist of channel handles to scan for outliers
const CHANNEL_WHITELIST = [
  'sleepinghistory',
  'sleepytimehistory',
  'sleeplesshomo',
  'vaticanmysteriesforsleep',
  'boringhistory',
  'hollertales',
  'thesleepingstoryvault',
  'comfyhistory',
  'thehistorytrip',
  'dustandglory',
  'sleepandhistory',
  'thesleeproom',
  'historiansleepy',
  'thesnoozetorian',
  'mysteryhistoryforsleep',
  'nightpsalms',
  'godsandmortals',
];

// Check if channel is in whitelist (by handle from input field)
function isWhitelistedChannel(channel: SavedChannel): boolean {
  const input = (channel.input || '').toLowerCase().replace('@', '');
  return CHANNEL_WHITELIST.some(handle => input.includes(handle));
}

interface SavedChannel {
  id: string;  // This IS the YouTube channel ID (e.g., UCxxxxxx)
  title: string;  // Channel name
  thumbnail_url: string | null;
  input: string;  // Original input used to find channel
  subscriber_count_formatted: string | null;  // e.g., "1.2M"
}

interface OutlierVideo {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  channelId: string;
  channelName: string;
  subscriberCountFormatted: string;  // e.g., "1.2M subs"
  viewCount: number;
  durationSeconds: number;
  publishedAt: string;
  outlierMultiplier: number;
}

function getSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  return createClient(url, key);
}

// Get today's date in YYYY-MM-DD format
function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

// Check if already ran today
async function checkAlreadyRanToday(supabase: SupabaseClient): Promise<boolean> {
  const today = getTodayDate();
  const { data } = await supabase
    .from('auto_clone_runs')
    .select('id, status')
    .eq('run_date', today)
    .single();

  return !!data;
}

// Create a new run record
async function createRunRecord(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase
    .from('auto_clone_runs')
    .insert({
      run_date: getTodayDate(),
      status: 'running',
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create run record: ${error.message}`);
  return data.id;
}

// Update run record
async function updateRunRecord(
  supabase: SupabaseClient,
  runId: string,
  updates: any
): Promise<void> {
  const { error } = await supabase
    .from('auto_clone_runs')
    .update(updates)
    .eq('id', runId);

  if (error) console.error(`Failed to update run record: ${error.message}`);
}

// Check if video was already processed
async function isVideoProcessed(supabase: SupabaseClient, videoId: string): Promise<boolean> {
  const { data } = await supabase
    .from('processed_videos')
    .select('id')
    .eq('video_id', videoId)
    .single();

  return !!data;
}

// Record processed video
async function recordProcessedVideo(
  supabase: SupabaseClient,
  video: OutlierVideo,
  status: 'pending' | 'processing' | 'completed' | 'failed',
  extras?: {
    projectId?: string;
    clonedTitle?: string;
    youtubeVideoId?: string;
    youtubeUrl?: string;
    errorMessage?: string;
  }
): Promise<string> {
  const { data, error } = await supabase
    .from('processed_videos')
    .upsert({
      video_id: video.videoId,
      channel_id: video.channelId,
      original_title: video.title,
      original_thumbnail_url: video.thumbnailUrl,
      outlier_multiplier: video.outlierMultiplier,
      duration_seconds: video.durationSeconds,
      status,
      project_id: extras?.projectId,
      cloned_title: extras?.clonedTitle,
      youtube_video_id: extras?.youtubeVideoId,
      youtube_url: extras?.youtubeUrl,
      error_message: extras?.errorMessage,
      completed_at: status === 'completed' ? new Date().toISOString() : null,
    }, { onConflict: 'video_id' })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to record processed video: ${error.message}`);
  return data.id;
}

// Fetch all saved channels
async function fetchSavedChannels(supabase: SupabaseClient): Promise<SavedChannel[]> {
  const { data, error } = await supabase
    .from('saved_channels')
    .select('id, title, thumbnail_url, input, subscriber_count_formatted')
    .order('saved_at', { ascending: false });

  if (error) throw new Error(`Failed to fetch saved channels: ${error.message}`);
  return data || [];
}

// Calculate average views for a channel (only videos with views > 0, matching Outliers page)
function calculateAverageViews(videos: ScrapedVideo[]): number {
  const videosWithViews = videos.filter(v => v.views && v.views > 0);
  if (videosWithViews.length === 0) return 0;
  const totalViews = videosWithViews.reduce((sum, v) => sum + (v.views || 0), 0);
  return totalViews / videosWithViews.length;
}

// Parse relative time like "2 days ago" to check if within cutoff
function isWithinDays(publishedText: string | undefined, days: number): boolean {
  if (!publishedText) return false;

  const text = publishedText.toLowerCase();

  // Check for hours/minutes (definitely recent)
  if (text.includes('hour') || text.includes('minute') || text.includes('second')) {
    return true;
  }

  // Check for days
  const dayMatch = text.match(/(\d+)\s*day/);
  if (dayMatch) {
    return parseInt(dayMatch[1]) <= days;
  }

  // Check for weeks
  const weekMatch = text.match(/(\d+)\s*week/);
  if (weekMatch) {
    return parseInt(weekMatch[1]) * 7 <= days;
  }

  // Check for months (1 month = ~30 days)
  const monthMatch = text.match(/(\d+)\s*month/);
  if (monthMatch) {
    return parseInt(monthMatch[1]) * 30 <= days;
  }

  // If it says "year", it's too old
  if (text.includes('year')) {
    return false;
  }

  // Default to false for unknown formats
  return false;
}

// Progress callback type for scanning
type ScanProgressCallback = (channelIndex: number, totalChannels: number, channelName: string, outliersFound: number) => void;

// Scan channels for outliers - returns outliers and count of channels scanned
// Uses cached data when available for consistency with Outliers page
async function scanForOutliers(
  channels: SavedChannel[],
  onProgress?: ScanProgressCallback
): Promise<{ outliers: OutlierVideo[]; scannedCount: number }> {
  const allOutliers: OutlierVideo[] = [];

  // Filter to only whitelisted channels
  const whitelistedChannels = channels.filter(isWhitelistedChannel);
  console.log(`[AutoClone] Filtered to ${whitelistedChannels.length} whitelisted channels out of ${channels.length} total`);

  for (let i = 0; i < whitelistedChannels.length; i++) {
    const channel = whitelistedChannels[i];
    try {
      console.log(`[AutoClone] Scanning channel: ${channel.title}`);

      // Report progress
      if (onProgress) {
        onProgress(i + 1, whitelistedChannels.length, channel.title, allOutliers.length);
      }

      // Try to use cached data first for consistency with Outliers page
      const cachedOutliers = await getCachedOutliersForChannel(channel.id);

      if (cachedOutliers.length > 0) {
        console.log(`[AutoClone] Using cached data for ${channel.title} (${cachedOutliers.length} videos)`);

        // Sort by recent and limit to 50 to match fresh fetch behavior
        const sortedByRecent = [...cachedOutliers].sort((a, b) =>
          new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
        );
        const videosForStats = sortedByRecent.slice(0, 50);

        // Calculate average from cached videos (filter 0-view videos)
        const videosWithViews = videosForStats.filter(v => v.view_count > 0);
        const totalViews = videosWithViews.reduce((sum, v) => sum + v.view_count, 0);
        const avgViews = videosWithViews.length > 0 ? totalViews / videosWithViews.length : 0;

        if (avgViews === 0) continue;

        // Find outliers from cached data
        for (const cached of cachedOutliers) {
          // Skip short videos
          if (cached.duration_seconds < MIN_DURATION_SECONDS) continue;

          // Skip old videos (check published_at date)
          const publishedDate = new Date(cached.published_at);
          const daysSincePublish = (Date.now() - publishedDate.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSincePublish > OUTLIER_DAYS) continue;

          // Recalculate outlier multiplier with consistent average
          const multiplier = cached.view_count / avgViews;

          if (multiplier >= 2.0) {
            allOutliers.push({
              videoId: cached.video_id,
              title: cached.title,
              thumbnailUrl: cached.thumbnail_url,
              channelId: channel.id,
              channelName: channel.title,
              subscriberCountFormatted: channel.subscriber_count_formatted || '',
              viewCount: cached.view_count,
              durationSeconds: cached.duration_seconds,
              publishedAt: cached.published_at,
              outlierMultiplier: multiplier,
            });
          }
        }
      } else {
        // Fallback to fresh fetch if no cache
        console.log(`[AutoClone] No cache for ${channel.title}, fetching fresh...`);
        const videos = await getChannelVideos(channel.id, 50);

        if (!videos || videos.length === 0) {
          console.log(`[AutoClone] No videos found for ${channel.title}`);
          continue;
        }

        // Calculate average views
        const avgViews = calculateAverageViews(videos);
        if (avgViews === 0) continue;

        // Find outliers (videos with significantly more views than average)
        for (const video of videos) {
          // Skip short videos (less than 1 hour)
          if ((video.duration || 0) < MIN_DURATION_SECONDS) continue;

          // Skip videos not in last 35 days
          if (!isWithinDays(video.publishedText, OUTLIER_DAYS)) continue;

          // Calculate outlier multiplier
          const multiplier = (video.views || 0) / avgViews;

          // Consider it an outlier if 2x+ average views
          if (multiplier >= 2.0) {
            allOutliers.push({
              videoId: video.id,
              title: video.title,
              thumbnailUrl: video.thumbnail || `https://i.ytimg.com/vi/${video.id}/maxresdefault.jpg`,
              channelId: channel.id,
              channelName: channel.title,
              subscriberCountFormatted: channel.subscriber_count_formatted || '',
              viewCount: video.views || 0,
              durationSeconds: video.duration || 0,
              publishedAt: video.publishedText || '',
              outlierMultiplier: multiplier,
            });
          }
        }
      }
    } catch (error: any) {
      console.error(`[AutoClone] Error scanning channel ${channel.title}: ${error.message}`);
    }
  }

  // Sort by outlier multiplier (highest first)
  allOutliers.sort((a, b) => b.outlierMultiplier - a.outlierMultiplier);

  return { outliers: allOutliers, scannedCount: whitelistedChannels.length };
}

// Get best outlier (for modal auto-selection) - streams progress via SSE
router.get('/best-outlier', async (req: Request, res: Response) => {
  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const supabase = getSupabaseClient();

    // Fetch saved channels
    sendEvent({ type: 'progress', message: 'Loading channels...' });
    const channels = await fetchSavedChannels(supabase);

    if (channels.length === 0) {
      sendEvent({
        type: 'complete',
        success: true,
        outlier: null,
        channelsScanned: 0,
        reason: 'No saved channels found',
      });
      res.end();
      return;
    }

    // Scan for outliers with progress callback
    console.log(`[AutoClone] Scanning for best outlier...`);
    const { outliers, scannedCount } = await scanForOutliers(channels, (index, total, channelName, foundCount) => {
      sendEvent({
        type: 'progress',
        channelIndex: index,
        totalChannels: total,
        channelName,
        outliersFound: foundCount,
        message: `Scanning ${channelName}... (${index}/${total})`,
      });
    });

    if (outliers.length === 0) {
      sendEvent({
        type: 'complete',
        success: true,
        outlier: null,
        channelsScanned: scannedCount,
        reason: 'No qualifying outliers found (need 1+ hour, 2x+ views, last 35 days)',
      });
      res.end();
      return;
    }

    // Find first unprocessed outlier (they're already sorted by score desc)
    sendEvent({ type: 'progress', message: 'Checking processed videos...' });
    let bestOutlier: OutlierVideo | null = null;
    for (const outlier of outliers) {
      if (!await isVideoProcessed(supabase, outlier.videoId)) {
        bestOutlier = outlier;
        break;
      }
    }

    if (!bestOutlier) {
      sendEvent({
        type: 'complete',
        success: true,
        outlier: null,
        channelsScanned: scannedCount,
        outliersFound: outliers.length,
        reason: 'All recent outliers already processed',
      });
      res.end();
      return;
    }

    // Calculate scheduled publish time
    const publishAt = getNext5pmPST();

    sendEvent({
      type: 'complete',
      success: true,
      outlier: bestOutlier,
      channelsScanned: scannedCount,
      outliersFound: outliers.length,
      publishAt,
    });
    res.end();

  } catch (error: any) {
    console.error(`[AutoClone] Error getting best outlier: ${error.message}`);
    sendEvent({
      type: 'error',
      success: false,
      error: error.message,
    });
    res.end();
  }
});

// Main auto-clone trigger
router.post('/', async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  let runId: string | null = null;

  try {
    console.log('[AutoClone] Starting daily auto-clone run...');

    // Check if already ran today (unless force=true)
    const force = req.body.force === true;
    const targetWordCount = req.body.targetWordCount ? parseInt(req.body.targetWordCount, 10) : undefined;
    const videoUrl = req.body.videoUrl as string | undefined;  // Optional: run specific video
    const outlierMultiplier = req.body.outlierMultiplier ? parseFloat(req.body.outlierMultiplier) : 1;  // For direct URLs
    const today = getTodayDate();

    // Check if cron is enabled (unless force=true which bypasses this check)
    if (!force) {
      const { data: setting } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'auto_poster_cron_enabled')
        .single();

      const isEnabled = setting?.value === 'true';

      // Default to enabled if setting doesn't exist (backward compatibility)
      if (setting && !isEnabled) {
        console.log('[AutoClone] Cron is disabled - skipping run');
        return res.status(200).json({
          success: false,
          message: 'Auto Poster cron is disabled. Enable it in the UI to resume daily runs.',
        });
      }
    }

    // Check if there's already a video processing (prevent parallel runs)
    const { data: processingVideos } = await supabase
      .from('processed_videos')
      .select('video_id')
      .eq('status', 'processing')
      .limit(1);

    if (processingVideos && processingVideos.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Another video is already processing. Wait for it to complete.',
      });
    }

    if (force) {
      // Delete existing run record for today to allow re-run
      await supabase.from('auto_clone_runs').delete().eq('run_date', today);
      console.log('[AutoClone] Force flag set - deleted existing run record');
    } else if (await checkAlreadyRanToday(supabase)) {
      return res.status(400).json({
        success: false,
        error: 'Already ran today. Use force=true to run again.',
      });
    }

    // Create run record
    runId = await createRunRecord(supabase);

    // If specific videoUrl provided, bypass outlier scanning
    if (videoUrl) {
      console.log(`[AutoClone] Direct video URL provided: ${videoUrl}`);

      // Extract video ID from URL
      const videoIdMatch = videoUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      if (!videoIdMatch) {
        return res.status(400).json({ success: false, error: 'Invalid YouTube URL' });
      }
      const videoId = videoIdMatch[1];

      // Check if already processed
      if (await isVideoProcessed(supabase, videoId)) {
        // Delete from processed_videos to allow re-run
        await supabase.from('processed_videos').delete().eq('video_id', videoId);
        console.log(`[AutoClone] Deleted previous processed record for ${videoId}`);
      }

      // Get video info from YouTube (title + duration)
      let videoTitle = req.body.videoTitle || 'Unknown Title';
      let videoDurationSeconds = 0;

      const videoInfo = await getVideoInfo(videoId);
      if (videoInfo) {
        videoTitle = videoInfo.title;
        videoDurationSeconds = videoInfo.durationSeconds;
        console.log(`[AutoClone] Video info: "${videoTitle}" (${Math.round(videoDurationSeconds / 60)} min)`);
      } else {
        // Fallback to oEmbed for title only
        try {
          const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`);
          if (oembedRes.ok) {
            const oembed = await oembedRes.json() as { title?: string };
            videoTitle = oembed.title || videoTitle;
          }
        } catch (e) {
          console.log(`[AutoClone] Could not fetch video info, using provided title: ${videoTitle}`);
        }
      }

      const selectedVideo: OutlierVideo = {
        videoId,
        title: videoTitle,
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        channelId: 'direct-url',
        channelName: 'Direct URL',
        subscriberCountFormatted: 'N/A',
        viewCount: 0,
        outlierMultiplier,  // Use value from request (default 1)
        durationSeconds: videoDurationSeconds,
        publishedAt: new Date().toISOString(),
      };

      await updateRunRecord(supabase, runId, { video_selected_id: videoId });
      console.log(`[AutoClone] Direct video: "${videoTitle}"`);

      // Record as processing
      await recordProcessedVideo(supabase, selectedVideo, 'processing');

      // Calculate publish time (5 PM PST)
      const publishAt = getNext5pmPST();
      console.log(`[AutoClone] Scheduled publish: ${publishAt}`);

      // Start pipeline
      res.json({
        success: true,
        message: 'Auto-clone started (direct URL)',
        runId,
        selectedVideo: { videoId, title: videoTitle },
        publishAt,
      });

      // Run pipeline in background
      runPipeline({
        sourceVideoId: videoId,
        sourceVideoUrl: videoUrl,
        originalTitle: videoTitle,
        originalThumbnailUrl: selectedVideo.thumbnailUrl,
        channelName: 'Direct URL',
        publishAt,
        sourceDurationSeconds: videoDurationSeconds,  // Pass duration for word count calculation
        targetWordCount,  // Manual override if specified
      }, async (step, progress, message) => {
        console.log(`[AutoClone] Pipeline ${step}: ${message} (${progress}%)`);
        const stepStr = message.includes('%') ? message : `${message} (${progress}%)`;
        await updateRunRecord(supabase, runId!, { current_step: stepStr });
        await supabase
          .from('processed_videos')
          .update({ current_step: stepStr })
          .eq('video_id', videoId);
      }).then(async (result) => {
        console.log(`[AutoClone] Pipeline complete for ${videoId}:`, result.success ? 'SUCCESS' : result.error);
        await updateRunRecord(supabase, runId!, {
          status: result.success ? 'completed' : 'failed',
          error_message: result.error || null,
          completed_at: new Date().toISOString(),
        });
        await supabase
          .from('processed_videos')
          .update({
            status: result.success ? 'completed' : 'failed',
            error_message: result.error || null,
            completed_at: new Date().toISOString(),
            project_id: result.projectId || null,
            youtube_video_id: result.youtubeVideoId || null,
          })
          .eq('video_id', videoId);

        // Send notification
        const emoji = result.success ? '✅' : '❌';
        const statusMsg = result.success ? 'completed' : 'failed';
        await sendWhatsAppNotification(`${emoji} Auto Poster ${statusMsg}: ${videoTitle}\n${result.error || ''}`);
      }).catch(async (error) => {
        console.error(`[AutoClone] Pipeline crashed for ${videoId}:`, error);
        await updateRunRecord(supabase, runId!, {
          status: 'failed',
          error_message: error.message,
          completed_at: new Date().toISOString(),
        });
        await supabase
          .from('processed_videos')
          .update({
            status: 'failed',
            error_message: error.message,
            completed_at: new Date().toISOString(),
          })
          .eq('video_id', videoId);
        await sendWhatsAppNotification(`💥 Auto Poster CRASHED: ${videoTitle}\n${error.message}`);
      });

      return;  // Early return - don't continue to outlier scanning
    }

    // Fetch saved channels
    const channels = await fetchSavedChannels(supabase);
    if (channels.length === 0) {
      await updateRunRecord(supabase, runId, {
        status: 'no_candidates',
        error_message: 'No saved channels found',
        completed_at: new Date().toISOString(),
      });
      return res.status(400).json({
        success: false,
        error: 'No saved channels found. Add channels first.',
      });
    }

    // Scan for outliers (only whitelisted channels)
    console.log(`[AutoClone] Scanning channels for outliers...`);
    const { outliers, scannedCount } = await scanForOutliers(channels);

    await updateRunRecord(supabase, runId, {
      channels_scanned: scannedCount,
      outliers_found: outliers.length
    });

    if (outliers.length === 0) {
      await updateRunRecord(supabase, runId, {
        status: 'no_candidates',
        error_message: 'No qualifying outliers found (need 1+ hour, 2x+ views)',
        completed_at: new Date().toISOString(),
      });
      return res.status(200).json({
        success: true,
        message: 'No qualifying outliers found',
        channelsScanned: scannedCount,
      });
    }

    // Find first unprocessed outlier
    let selectedVideo: OutlierVideo | null = null;
    for (const outlier of outliers) {
      if (!await isVideoProcessed(supabase, outlier.videoId)) {
        selectedVideo = outlier;
        break;
      }
    }

    if (!selectedVideo) {
      await updateRunRecord(supabase, runId, {
        status: 'no_candidates',
        error_message: 'All outliers already processed',
        completed_at: new Date().toISOString(),
      });
      return res.status(200).json({
        success: true,
        message: 'All outliers already processed',
        channelsScanned: channels.length,
        outliersFound: outliers.length,
      });
    }

    await updateRunRecord(supabase, runId, { video_selected_id: selectedVideo.videoId });

    console.log(`[AutoClone] Selected video: "${selectedVideo.title}" (${selectedVideo.outlierMultiplier.toFixed(1)}x views)`);

    // Record as processing
    await recordProcessedVideo(supabase, selectedVideo, 'processing');

    // Calculate publish time (5 PM PST)
    const publishAt = getNext5pmPST();
    console.log(`[AutoClone] Scheduled publish: ${publishAt}`);

    // Start pipeline (async - respond immediately)
    res.json({
      success: true,
      message: 'Auto-clone started',
      runId,
      selectedVideo: {
        videoId: selectedVideo.videoId,
        title: selectedVideo.title,
        channel: selectedVideo.channelName,
        outlierMultiplier: selectedVideo.outlierMultiplier,
        duration: Math.round(selectedVideo.durationSeconds / 60) + ' min',
      },
      publishAt,
    });

    // Run pipeline in background
    runPipeline({
      sourceVideoId: selectedVideo.videoId,
      sourceVideoUrl: `https://www.youtube.com/watch?v=${selectedVideo.videoId}`,
      originalTitle: selectedVideo.title,
      originalThumbnailUrl: selectedVideo.thumbnailUrl,
      channelName: selectedVideo.channelName,
      publishAt,
      sourceDurationSeconds: selectedVideo.durationSeconds,
      targetWordCount,  // Optional manual override from request
    }, async (step, progress, message) => {
      console.log(`[AutoClone] Pipeline ${step}: ${message} (${progress}%)`);
      // Progress message without step prefix - just show the message with percentage
      const stepStr = message.includes('%') ? message : `${message} (${progress}%)`;
      // Update current step in both tables for UI polling
      await updateRunRecord(supabase, runId!, { current_step: stepStr });
      await supabase
        .from('processed_videos')
        .update({ current_step: stepStr })
        .eq('video_id', selectedVideo!.videoId);
    }).then(async (result) => {
      if (result.success) {
        console.log(`[AutoClone] Pipeline completed! YouTube: ${result.youtubeUrl}`);
        await recordProcessedVideo(supabase, selectedVideo!, 'completed', {
          projectId: result.projectId,
          clonedTitle: result.clonedTitle,
          youtubeVideoId: result.youtubeVideoId,
          youtubeUrl: result.youtubeUrl,
        });
        await updateRunRecord(supabase, runId!, {
          status: 'completed',
          completed_at: new Date().toISOString(),
        });

        // Send WhatsApp notification
        await sendWhatsAppNotification(
          `✅ Auto-Clone Complete!\n\n` +
          `📺 "${result.clonedTitle}"\n` +
          `🔗 ${result.youtubeUrl}\n\n` +
          `Original: "${selectedVideo!.title}" (${selectedVideo!.outlierMultiplier.toFixed(1)}x views)`
        );
      } else {
        console.error(`[AutoClone] Pipeline failed: ${result.error}`);
        await recordProcessedVideo(supabase, selectedVideo!, 'failed', {
          projectId: result.projectId,
          errorMessage: result.error,
        });
        await updateRunRecord(supabase, runId!, {
          status: 'failed',
          error_message: result.error,
          completed_at: new Date().toISOString(),
        });

        // Send WhatsApp notification for failure
        await sendWhatsAppNotification(
          `❌ Auto-Clone Failed\n\n` +
          `Video: "${selectedVideo!.title}"\n` +
          `Error: ${result.error}`
        );
      }
    }).catch(async (error) => {
      console.error(`[AutoClone] Pipeline crashed: ${error.message}`);
      await recordProcessedVideo(supabase, selectedVideo!, 'failed', {
        errorMessage: error.message,
      });
      await updateRunRecord(supabase, runId!, {
        status: 'failed',
        error_message: error.message,
        completed_at: new Date().toISOString(),
      });

      // Send WhatsApp notification for crash
      await sendWhatsAppNotification(
        `💥 Auto-Clone Crashed\n\n` +
        `Video: "${selectedVideo!.title}"\n` +
        `Error: ${error.message}`
      );
    });

  } catch (error: any) {
    console.error(`[AutoClone] Error: ${error.message}`);
    if (runId) {
      await updateRunRecord(supabase, runId, {
        status: 'failed',
        error_message: error.message,
        completed_at: new Date().toISOString(),
      });
    }
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get run history
router.get('/status', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabaseClient();
    const limit = parseInt(req.query.limit as string) || 10;

    const { data, error } = await supabase
      .from('auto_clone_runs')
      .select('*')
      .order('run_date', { ascending: false })
      .limit(limit);

    if (error) throw error;

    return res.json({
      success: true,
      runs: data,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Get processed videos
router.get('/processed', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabaseClient();
    const limit = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as string;

    let query = supabase
      .from('processed_videos')
      .select('*')
      .order('processed_at', { ascending: false })
      .limit(limit);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) throw error;

    return res.json({
      success: true,
      videos: data,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Delete a processed video record
router.delete('/processed/:videoId', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabaseClient();
    const { videoId } = req.params;

    const { error } = await supabase
      .from('processed_videos')
      .delete()
      .eq('video_id', videoId);

    if (error) throw error;

    console.log(`[AutoClone] Deleted processed video: ${videoId}`);
    return res.json({ success: true, message: 'Video deleted' });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Manually add a processed video record (for debugging/recovery)
router.post('/processed', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabaseClient();
    const { videoId, title, thumbnailUrl, channelId, channelName, outlierMultiplier, durationSeconds, status } = req.body;

    if (!videoId || !title) {
      return res.status(400).json({ success: false, error: 'videoId and title are required' });
    }

    const { data, error } = await supabase
      .from('processed_videos')
      .upsert({
        video_id: videoId,
        original_title: title,
        original_thumbnail_url: thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        channel_id: channelId || 'unknown',
        outlier_multiplier: outlierMultiplier || null,
        duration_seconds: durationSeconds || null,
        status: status || 'failed',
        error_message: 'Manually added for recovery',
      }, { onConflict: 'video_id' })
      .select('*')
      .single();

    if (error) throw error;

    console.log(`[AutoClone] Manually added processed video: ${videoId}`);
    return res.json({ success: true, video: data });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Retry a failed video
router.post('/retry/:videoId', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabaseClient();
    const { videoId } = req.params;

    // Get the processed video record
    const { data: video, error } = await supabase
      .from('processed_videos')
      .select('*')
      .eq('video_id', videoId)
      .single();

    if (error || !video) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }

    if (video.status !== 'failed') {
      return res.status(400).json({
        success: false,
        error: `Video status is '${video.status}', can only retry failed videos`,
      });
    }

    // Check if we have existing project data to resume from
    let project: Record<string, any> | null = null;
    let resumeFrom: string | undefined;
    
    if (video.project_id) {
      const { data: projectData } = await supabase
        .from('generation_projects')
        .select('*')
        .eq('id', video.project_id)
        .single();
      
      if (projectData) {
        project = projectData;
        // Determine resume point based on existing data
        // Actual pipeline order: transcript → script → audio → captions → imagePrompts → images → clipPrompts → videoClips → thumbnail → render → upload
        if (projectData.smoke_embers_video_url) {
          resumeFrom = 'upload';
        } else if (projectData.thumbnails?.length > 0) {
          resumeFrom = 'render';
        } else if (projectData.clips?.length > 0) {
          resumeFrom = 'thumbnail';
        } else if (projectData.clip_prompts?.length > 0) {
          resumeFrom = 'videoClips';
        } else if (projectData.image_urls?.length > 0) {
          resumeFrom = 'clipPrompts';
        } else if (projectData.image_prompts?.length > 0) {
          resumeFrom = 'images';
        } else if (projectData.srt_url) {
          resumeFrom = 'imagePrompts';
        } else if (projectData.audio_url) {
          resumeFrom = 'captions';
        } else if (projectData.script_content) {
          resumeFrom = 'audio';
        }
        
        if (resumeFrom) {
          console.log(`[AutoClone Retry] Found existing project ${video.project_id} - resuming from ${resumeFrom}`);
          console.log(`  - Script: ${projectData.script_content?.length || 0} chars`);
          console.log(`  - Audio: ${projectData.audio_url || 'N/A'}`);
          console.log(`  - SRT: ${projectData.srt_url || 'N/A'}`);
          console.log(`  - Clip prompts: ${projectData.clip_prompts?.length || 0}`);
          console.log(`  - Clips: ${projectData.clips?.length || 0}`);
          console.log(`  - Image prompts: ${projectData.image_prompts?.length || 0}`);
          console.log(`  - Images: ${projectData.image_urls?.length || 0}`);
        }
      }
    }

    // Reset status to processing
    await supabase
      .from('processed_videos')
      .update({
        status: 'processing',
        error_message: null,
        completed_at: null,
        current_step: resumeFrom ? `Resuming from ${resumeFrom}...` : 'Starting fresh...',
      })
      .eq('video_id', videoId);

    // Calculate publish time
    const publishAt = getNext5pmPST();

    // Start pipeline response
    res.json({
      success: true,
      message: resumeFrom ? `Retry started (resuming from ${resumeFrom})` : 'Retry started (fresh)',
      videoId,
      publishAt,
      resumeFrom: resumeFrom || null,
      existingData: project ? {
        hasScript: !!project.script_content,
        hasAudio: !!project.audio_url,
        hasCaptions: !!project.srt_url,
        clipPromptsCount: project.clip_prompts?.length || 0,
        clipsCount: project.clips?.length || 0,
        imagePromptsCount: project.image_prompts?.length || 0,
        imagesCount: project.image_urls?.length || 0,
      } : null,
    });

    // Run in background
    console.log(`[AutoClone Retry] Starting pipeline for ${video.video_id}...`);
    runPipeline({
      sourceVideoId: video.video_id,
      sourceVideoUrl: `https://www.youtube.com/watch?v=${video.video_id}`,
      originalTitle: video.original_title,
      originalThumbnailUrl: video.original_thumbnail_url,
      publishAt,
      sourceDurationSeconds: video.duration_seconds,
      // Resume options (if we have existing data)
      ...(resumeFrom && project ? {
        resumeFrom: resumeFrom as any,
        existingProjectId: video.project_id,
        existingData: {
          script: project.script_content,
          audioUrl: project.audio_url,
          audioDuration: project.audio_duration,
          audioSegments: project.audio_segments,
          srtUrl: project.srt_url,
          srtContent: project.srt_content,
          clipPrompts: project.clip_prompts,
          clips: project.clips,
          imagePrompts: project.image_prompts,
          imageUrls: project.image_urls,
          thumbnailUrl: project.thumbnails?.[0],
        },
      } : {}),
    }, async (step, progress, message) => {
      console.log(`[AutoClone Retry] ${step}: ${message} (${progress}%)`);
      // Don't duplicate % if message already contains it
      const stepStr = message.includes('%') ? `${step}: ${message}` : `${step}: ${message} (${progress}%)`;
      // Update current step in processed_videos for UI polling
      await supabase
        .from('processed_videos')
        .update({ current_step: stepStr })
        .eq('video_id', videoId);
    }).then(async (result) => {
      console.log(`[AutoClone Retry] Pipeline completed. Success: ${result.success}`);
      if (result.success) {
        await supabase
          .from('processed_videos')
          .update({
            status: 'completed',
            project_id: result.projectId,
            cloned_title: result.clonedTitle,
            youtube_video_id: result.youtubeVideoId,
            youtube_url: result.youtubeUrl,
            error_message: null,
            current_step: null,
            completed_at: new Date().toISOString(),
          })
          .eq('video_id', videoId);
      } else {
        await supabase
          .from('processed_videos')
          .update({
            status: 'failed',
            project_id: result.projectId,
            error_message: result.error,
            current_step: null,
          })
          .eq('video_id', videoId);
      }
    }).catch(async (error) => {
      console.error(`[AutoClone Retry] Pipeline crashed:`, error);
      await supabase
        .from('processed_videos')
        .update({
          status: 'failed',
          error_message: error.message || 'Pipeline crashed',
          current_step: null,
        })
        .eq('video_id', videoId);
    });

  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Resume a failed video from a specific step (skips already-completed steps)
router.post('/resume/:videoId', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabaseClient();
    const { videoId } = req.params;
    const resumeFrom = req.body.resumeFrom as string;  // e.g., 'imagePrompts', 'images', 'render'

    if (!resumeFrom) {
      return res.status(400).json({ success: false, error: 'resumeFrom is required (e.g., "imagePrompts", "images", "render")' });
    }

    // Get the processed video record
    const { data: video, error } = await supabase
      .from('processed_videos')
      .select('*')
      .eq('video_id', videoId)
      .single();

    if (error || !video) {
      return res.status(404).json({ success: false, error: 'Video not found in processed_videos' });
    }

    // Get the existing project data to reuse
    const projectId = video.project_id;
    if (!projectId) {
      return res.status(400).json({ success: false, error: 'No project_id found - cannot resume without existing project' });
    }

    // Fetch existing project data
    const { data: project, error: projectError } = await supabase
      .from('generation_projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      return res.status(404).json({ success: false, error: 'Project not found in generation_projects' });
    }

    console.log(`[AutoClone Resume] Found project ${projectId} with:`);
    console.log(`  - Script: ${project.script_content?.length || 0} chars`);
    console.log(`  - Audio: ${project.audio_url || 'N/A'}`);
    console.log(`  - SRT: ${project.srt_url || 'N/A'}`);
    console.log(`  - Image prompts: ${project.image_prompts?.length || 0}`);
    console.log(`  - Images: ${project.image_urls?.length || 0}`);

    // Update status to processing
    await supabase
      .from('processed_videos')
      .update({
        status: 'processing',
        error_message: null,
        completed_at: null,
        current_step: `Resuming from ${resumeFrom}...`,
      })
      .eq('video_id', videoId);

    // Calculate publish time
    const publishAt = getNext5pmPST();

    res.json({
      success: true,
      message: `Resume started from ${resumeFrom}`,
      videoId,
      projectId,
      publishAt,
      existingData: {
        hasScript: !!project.script_content,
        hasAudio: !!project.audio_url,
        hasCaptions: !!project.srt_url,
        imagePromptsCount: project.image_prompts?.length || 0,
        imagesCount: project.image_urls?.length || 0,
      },
    });

    // Run pipeline in background with resume
    console.log(`[AutoClone Resume] Starting pipeline from ${resumeFrom} for ${video.video_id}...`);
    runPipeline({
      sourceVideoId: video.video_id,
      sourceVideoUrl: `https://www.youtube.com/watch?v=${video.video_id}`,
      originalTitle: video.original_title,
      originalThumbnailUrl: video.original_thumbnail_url || `https://i.ytimg.com/vi/${video.video_id}/maxresdefault.jpg`,
      publishAt,
      sourceDurationSeconds: video.duration_seconds,
      // Resume options
      resumeFrom: resumeFrom as any,
      existingProjectId: projectId,
      existingData: {
        script: project.script_content,
        audioUrl: project.audio_url,
        audioDuration: project.audio_duration,
        audioSegments: project.audio_segments,
        srtUrl: project.srt_url,
        srtContent: project.srt_content,
        imagePrompts: project.image_prompts,
        imageUrls: project.image_urls,
        clipPrompts: project.clip_prompts,
        clips: project.clips,
        thumbnailUrl: project.thumbnails?.[0],
      },
    }, async (step, progress, message) => {
      console.log(`[AutoClone Resume] ${step}: ${message} (${progress}%)`);
      const stepStr = message.includes('%') ? message : `${message} (${progress}%)`;
      await supabase
        .from('processed_videos')
        .update({ current_step: stepStr })
        .eq('video_id', videoId);
    }).then(async (result) => {
      console.log(`[AutoClone Resume] Pipeline completed. Success: ${result.success}`);
      if (result.success) {
        await supabase
          .from('processed_videos')
          .update({
            status: 'completed',
            project_id: result.projectId,
            cloned_title: result.clonedTitle,
            youtube_video_id: result.youtubeVideoId,
            youtube_url: result.youtubeUrl,
            error_message: null,
            current_step: null,
            completed_at: new Date().toISOString(),
          })
          .eq('video_id', videoId);

        await sendWhatsAppNotification(
          `✅ Auto-Clone Resume Complete!\n\n` +
          `📺 "${result.clonedTitle}"\n` +
          `🔗 ${result.youtubeUrl}`
        );
      } else {
        await supabase
          .from('processed_videos')
          .update({
            status: 'failed',
            project_id: result.projectId,
            error_message: result.error,
            current_step: null,
          })
          .eq('video_id', videoId);

        await sendWhatsAppNotification(`❌ Auto-Clone Resume Failed: ${result.error}`);
      }
    }).catch(async (error) => {
      console.error(`[AutoClone Resume] Pipeline crashed:`, error);
      await supabase
        .from('processed_videos')
        .update({
          status: 'failed',
          error_message: error.message || 'Pipeline crashed',
          current_step: null,
        })
        .eq('video_id', videoId);

      await sendWhatsAppNotification(`💥 Auto-Clone Resume CRASHED: ${error.message}`);
    });

  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Resume pipeline by project ID (for UI-created projects)
router.post('/resume-project/:projectId', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabaseClient();
    const { projectId } = req.params;
    const resumeFrom = (req.body.resumeFrom || 'captions') as string;
    const modernKeywordFilter = req.body.modernKeywordFilter !== false;  // Default true

    // Fetch existing project data
    const { data: project, error: projectError } = await supabase
      .from('generation_projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    // Extract video ID from source URL
    const urlMatch = project.source_url?.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    const sourceVideoId = urlMatch?.[1] || projectId;

    console.log(`[Resume Project] Found project ${projectId}: "${project.video_title}"`);
    console.log(`  - Script: ${project.script_content?.length || 0} chars`);
    console.log(`  - Audio: ${project.audio_url || 'N/A'}`);
    console.log(`  - SRT: ${project.srt_url || 'N/A'}`);
    console.log(`  - Image prompts: ${project.image_prompts?.length || 0}`);
    console.log(`  - Images: ${project.image_urls?.length || 0}`);
    console.log(`  - Resuming from: ${resumeFrom}`);

    res.json({
      success: true,
      message: `Resume started from ${resumeFrom}`,
      projectId,
      title: project.video_title,
    });

    // Run pipeline in background
    runPipeline({
      sourceVideoId,
      sourceVideoUrl: project.source_url,
      originalTitle: project.video_title,
      originalThumbnailUrl: `https://i.ytimg.com/vi/${sourceVideoId}/maxresdefault.jpg`,
      modernKeywordFilter,
      resumeFrom: resumeFrom as any,
      existingProjectId: projectId,
      existingData: {
        script: project.script_content,
        audioUrl: project.audio_url,
        audioDuration: project.audio_duration,
        audioSegments: project.audio_segments,
        srtUrl: project.srt_url,
        srtContent: project.srt_content,
        imagePrompts: project.image_prompts,
        imageUrls: project.image_urls,
        clipPrompts: project.clip_prompts,
        clips: project.clips,
        thumbnailUrl: project.thumbnails?.[0],
      },
    }).then(async (result) => {
      console.log(`[Resume Project] Pipeline completed. Success: ${result.success}`);
      if (!result.success) {
        console.error(`[Resume Project] Pipeline failed: ${result.error}`);
      }
    }).catch((error) => {
      console.error(`[Resume Project] Pipeline crashed:`, error);
    });

  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Get cron enabled status
router.get('/cron-status', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'auto_poster_cron_enabled')
      .single();

    if (error && error.code !== 'PGRST116') {
      // PGRST116 = no rows returned, which is fine (defaults to enabled)
      throw error;
    }

    // Default to enabled if no setting exists
    const enabled = data?.value !== 'false';
    
    return res.json({ success: true, enabled });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Set cron enabled status
router.post('/cron-status', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabaseClient();
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
    }

    const { error } = await supabase
      .from('app_settings')
      .upsert({
        key: 'auto_poster_cron_enabled',
        value: enabled ? 'true' : 'false',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });

    if (error) throw error;

    console.log(`[AutoClone] Cron job ${enabled ? 'enabled' : 'disabled'}`);
    return res.json({ success: true, enabled });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Cleanup stale running records
router.post('/cleanup-stale', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabaseClient();

    // Find and update stale "running" runs (older than 3 hours)
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    
    const { data: staleRuns, error: runsError } = await supabase
      .from('auto_clone_runs')
      .update({ 
        status: 'failed', 
        error_message: 'Cleaned up stale running record',
        completed_at: new Date().toISOString()
      })
      .eq('status', 'running')
      .lt('started_at', threeHoursAgo)
      .select('id, run_date, video_selected_id');

    if (runsError) throw runsError;

    // Find and update stale "processing" videos (older than 3 hours)
    const { data: staleVideos, error: videosError } = await supabase
      .from('processed_videos')
      .update({ 
        status: 'failed', 
        error_message: 'Cleaned up stale processing record',
        completed_at: new Date().toISOString()
      })
      .eq('status', 'processing')
      .lt('processed_at', threeHoursAgo)
      .select('video_id, original_title');

    if (videosError) throw videosError;

    console.log(`[AutoClone] Cleaned up ${staleRuns?.length || 0} stale runs and ${staleVideos?.length || 0} stale videos`);
    
    return res.json({
      success: true,
      cleanedRuns: staleRuns || [],
      cleanedVideos: staleVideos || [],
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Test WhatsApp notification
router.post('/test-whatsapp', async (req: Request, res: Response) => {
  const phone = process.env.WHATSAPP_PHONE;
  const apiKey = process.env.WHATSAPP_API_KEY;

  if (!phone || !apiKey) {
    return res.status(400).json({
      success: false,
      error: 'WhatsApp not configured',
      phoneConfigured: !!phone,
      apiKeyConfigured: !!apiKey,
    });
  }

  try {
    const message = req.body.message || '🧪 Test notification from AutoAIGen';
    await sendWhatsAppNotification(message);
    return res.json({
      success: true,
      message: 'Test notification sent',
      phoneNumber: phone,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Refresh outlier cache - scrapes fresh videos from all whitelisted channels
// Called daily by cron job (1 hour before Auto Poster)
router.post('/refresh-cache', async (req: Request, res: Response) => {
  console.log('[AutoClone] Starting daily cache refresh...');
  const startTime = Date.now();

  try {
    const supabase = getSupabaseClient();

    // Fetch all saved channels
    const channels = await fetchSavedChannels(supabase);
    const whitelistedChannels = channels.filter(isWhitelistedChannel);

    console.log(`[AutoClone] Refreshing cache for ${whitelistedChannels.length} whitelisted channels`);

    let totalVideosScraped = 0;
    let totalOutliersFound = 0;
    const errors: string[] = [];

    for (const channel of whitelistedChannels) {
      try {
        console.log(`[AutoClone] Scraping ${channel.title} (${channel.id})...`);

        // Fresh scrape from YouTube
        const videos = await getChannelVideos(channel.id);
        totalVideosScraped += videos.length;

        if (videos.length === 0) {
          console.log(`[AutoClone] No videos found for ${channel.title}`);
          continue;
        }

        // Calculate average views
        const avgViews = calculateAverageViews(videos);
        if (avgViews === 0) continue;

        // Find outliers and prepare for caching
        const outliersToCache: Array<Omit<CachedOutlier, 'fetched_at' | 'expires_at'>> = [];

        for (const video of videos) {
          const multiplier = (video.views || 0) / avgViews;

          // Cache ALL videos with 2x+ views (not just 1hr+ duration)
          // Duration filter happens at selection time, not cache time
          if (multiplier >= 2.0) {
            outliersToCache.push({
              video_id: video.id,
              channel_id: channel.id,
              title: video.title,
              thumbnail_url: video.thumbnail || `https://i.ytimg.com/vi/${video.id}/maxresdefault.jpg`,
              view_count: video.views || 0,
              like_count: 0,  // Not available from scraper
              comment_count: 0,  // Not available from scraper
              duration_seconds: video.duration || 0,
              published_at: video.publishedText || new Date().toISOString(),
              outlier_multiplier: multiplier,
              z_score: 0,  // Not calculated
              views_per_subscriber: 0,  // Not available
              is_positive_outlier: true,  // We only cache 2x+ outliers
              is_negative_outlier: false,
              source: 'scraper',
            });
          }
        }

        if (outliersToCache.length > 0) {
          await cacheOutliers(outliersToCache);
          totalOutliersFound += outliersToCache.length;
          console.log(`[AutoClone] Cached ${outliersToCache.length} outliers for ${channel.title}`);
        }

        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 1000));

      } catch (error: any) {
        console.error(`[AutoClone] Error scraping ${channel.title}: ${error.message}`);
        errors.push(`${channel.title}: ${error.message}`);
      }
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`[AutoClone] Cache refresh complete in ${duration}s: ${totalVideosScraped} videos, ${totalOutliersFound} outliers`);

    return res.json({
      success: true,
      channelsScanned: whitelistedChannels.length,
      videosScraped: totalVideosScraped,
      outliersFound: totalOutliersFound,
      durationSeconds: duration,
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (error: any) {
    console.error('[AutoClone] Cache refresh failed:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
