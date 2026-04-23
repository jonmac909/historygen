#!/usr/bin/env node
/**
 * Local yt-dlp channel fetcher
 *
 * Runs on your machine to bypass YouTube's bot detection.
 * Fetches channel videos and caches them in Supabase for the Outliers page.
 *
 * Usage:
 *   cd scripts && node fetch-channels-local.mjs
 *
 * Or with specific channels:
 *   node scripts/fetch-channels-local.mjs @HistorianSleepy @SleepyHistory
 */

import { createClient } from '@supabase/supabase-js';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Supabase config
const SUPABASE_URL = 'https://udqfdeoullsxttqguupz.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_SERVICE_ROLE_KEY environment variable required');
  console.error('   Set it with: export SUPABASE_SERVICE_ROLE_KEY="your-key"');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Check if yt-dlp is installed
function checkYtdlp() {
  try {
    execSync('yt-dlp --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Resolve channel handle to channel ID
async function resolveChannelId(input) {
  // Already a channel ID
  if (input.startsWith('UC') && input.length >= 24) {
    return input.substring(0, 24);
  }

  // Extract from URL patterns
  const channelIdMatch = input.match(/\/channel\/(UC[\w-]{22})/);
  if (channelIdMatch) {
    return channelIdMatch[1];
  }

  // Build URL for yt-dlp
  let url = input;
  if (!input.includes('youtube.com') && !input.includes('youtu.be')) {
    const handle = input.replace(/^@/, '');
    url = `https://www.youtube.com/@${handle}`;
  }

  console.log(`  Resolving: ${url}`);

  const { stdout } = await execAsync(
    `yt-dlp "${url}" --dump-single-json --skip-download --no-warnings --ignore-errors --age-limit 99`,
    { maxBuffer: 50 * 1024 * 1024, timeout: 60000 }
  );

  const info = JSON.parse(stdout.trim());
  const channelId = info.channel_id || info.playlist_channel_id || info.uploader_id;

  if (!channelId || !channelId.startsWith('UC')) {
    throw new Error('Could not extract channel ID');
  }

  return channelId;
}

// Get channel info
async function getChannelInfo(channelId) {
  const url = `https://www.youtube.com/channel/${channelId}`;

  try {
    const { stdout } = await execAsync(
      `yt-dlp "${url}" --dump-single-json --skip-download --no-warnings --ignore-errors --age-limit 99`,
      { maxBuffer: 50 * 1024 * 1024, timeout: 60000 }
    );

    const info = JSON.parse(stdout.trim());
    return {
      id: channelId,
      title: info.channel || info.title || info.uploader || 'Unknown Channel',
      subscriberCount: info.channel_follower_count || 0,
      thumbnailUrl: info.thumbnails?.[0]?.url || '',
    };
  } catch {
    return {
      id: channelId,
      title: 'Unknown Channel',
      subscriberCount: 0,
      thumbnailUrl: '',
    };
  }
}

// Get channel videos
async function getChannelVideos(channelId, maxResults = 50) {
  const url = `https://www.youtube.com/channel/${channelId}/videos`;

  const { stdout } = await execAsync(
    `yt-dlp "${url}" --dump-json --flat-playlist --playlist-items 1:${maxResults} --no-warnings --ignore-errors --age-limit 99`,
    { maxBuffer: 50 * 1024 * 1024, timeout: 120000 }
  );

  const lines = stdout.trim().split('\n').filter(Boolean);
  const videos = [];

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
          channel: info.channel || info.playlist_channel || info.uploader,
        });
      }
    } catch {
      // Skip malformed lines
    }
  }

  return videos;
}

// Convert upload_date to ISO string
function uploadDateToISO(uploadDate) {
  if (!uploadDate || uploadDate.length !== 8) {
    return new Date().toISOString();
  }
  const year = uploadDate.substring(0, 4);
  const month = uploadDate.substring(4, 6);
  const day = uploadDate.substring(6, 8);
  return `${year}-${month}-${day}T00:00:00Z`;
}

// Cache channel and videos to Supabase
async function cacheResults(channelId, channelInfo, videos) {
  // Calculate statistics
  const videosWithViews = videos.filter(v => v.view_count && v.view_count > 0);
  const totalViews = videosWithViews.reduce((sum, v) => sum + (v.view_count || 0), 0);
  const averageViews = videosWithViews.length > 0 ? Math.round(totalViews / videosWithViews.length) : 0;
  const variance = videosWithViews.reduce((sum, v) => sum + Math.pow((v.view_count || 0) - averageViews, 2), 0) / (videosWithViews.length || 1);
  const standardDeviation = Math.sqrt(variance);

  // Cache channel
  const { error: channelError } = await supabase
    .from('cached_channels')
    .upsert({
      id: channelId,
      title: channelInfo.title,
      thumbnail_url: channelInfo.thumbnailUrl,
      subscriber_count: channelInfo.subscriberCount,
      view_count: totalViews,
      video_count: videos.length,
      views_to_subs_ratio: channelInfo.subscriberCount > 0 ? averageViews / channelInfo.subscriberCount : 0,
      avg_views: averageViews,
      is_breakout: false,
      source: 'apify',
      fetched_at: new Date().toISOString(),
    }, { onConflict: 'id' });

  if (channelError) {
    console.error(`  ❌ Failed to cache channel: ${channelError.message}`);
  }

  // Cache outlier videos
  const outliers = videos.map(v => {
    const viewCount = v.view_count || 0;
    const outlierMultiplier = averageViews > 0 ? viewCount / averageViews : 0;
    const zScore = standardDeviation > 0 ? (viewCount - averageViews) / standardDeviation : 0;
    const isPositiveOutlier = zScore > 2;
    const isNegativeOutlier = zScore < -1.5;
    const viewsPerSubscriber = channelInfo.subscriberCount > 0 ? viewCount / channelInfo.subscriberCount : 0;

    return {
      video_id: v.id,
      channel_id: channelId,
      title: v.title,
      thumbnail_url: v.thumbnail || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
      published_at: uploadDateToISO(v.upload_date),
      duration_seconds: v.duration || 0,
      view_count: viewCount,
      like_count: v.like_count || 0,
      comment_count: 0,
      outlier_multiplier: outlierMultiplier,
      z_score: zScore,
      is_positive_outlier: isPositiveOutlier,
      is_negative_outlier: isNegativeOutlier,
      views_per_subscriber: viewsPerSubscriber,
      source: 'apify',
      fetched_at: new Date().toISOString(),
    };
  });

  // Delete old outliers for this channel first
  await supabase
    .from('cached_outliers')
    .delete()
    .eq('channel_id', channelId);

  // Insert new outliers
  const { error: outliersError } = await supabase
    .from('cached_outliers')
    .insert(outliers);

  if (outliersError) {
    console.error(`  ❌ Failed to cache outliers: ${outliersError.message}`);
  }
}

// Get saved channels from Supabase
async function getSavedChannels() {
  const { data, error } = await supabase
    .from('saved_channels')
    .select('id, title, input')
    .order('title');

  if (error) {
    throw new Error(`Failed to get saved channels: ${error.message}`);
  }

  return data || [];
}

// Main function
async function main() {
  console.log('🎬 Local yt-dlp Channel Fetcher\n');

  // Check yt-dlp
  if (!checkYtdlp()) {
    console.error('❌ yt-dlp not found. Install with: brew install yt-dlp');
    process.exit(1);
  }
  console.log('✅ yt-dlp found\n');

  // Get channels to process
  const args = process.argv.slice(2);
  let channelsToProcess;

  if (args.length > 0) {
    // Process specific channels from command line
    channelsToProcess = args.map(input => ({
      id: '',
      title: input,
      input: input,
    }));
    console.log(`📋 Processing ${args.length} channels from command line\n`);
  } else {
    // Process all saved channels
    channelsToProcess = await getSavedChannels();
    console.log(`📋 Found ${channelsToProcess.length} saved channels\n`);
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < channelsToProcess.length; i++) {
    const channel = channelsToProcess[i];
    const progress = `[${i + 1}/${channelsToProcess.length}]`;

    console.log(`${progress} ${channel.title || channel.input}`);

    try {
      // Resolve channel ID
      const channelId = await resolveChannelId(channel.input);
      console.log(`  Channel ID: ${channelId}`);

      // Get channel info
      const channelInfo = await getChannelInfo(channelId);
      console.log(`  Subscribers: ${channelInfo.subscriberCount.toLocaleString()}`);

      // Get videos
      const videos = await getChannelVideos(channelId, 50);
      console.log(`  Videos: ${videos.length}`);

      // Cache results
      await cacheResults(channelId, channelInfo, videos);
      console.log(`  ✅ Cached successfully\n`);

      successCount++;

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 1000));

    } catch (error) {
      console.log(`  ❌ Failed: ${error.message}\n`);
      failCount++;
    }
  }

  console.log('\n📊 Summary:');
  console.log(`  ✅ Success: ${successCount}`);
  console.log(`  ❌ Failed: ${failCount}`);
  console.log(`  Total: ${channelsToProcess.length}`);
}

main().catch(console.error);
