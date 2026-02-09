/**
 * Video Analysis Routes
 *
 * API endpoints for VideoRAG video intelligence system.
 *
 * Routes:
 * - POST /video-analysis/download - Download a YouTube video for analysis
 * - POST /video-analysis/analyze - Trigger analysis for a video
 * - GET /video-analysis/status/:videoId - Check analysis status
 * - POST /video-analysis/query - Ask questions about analyzed videos
 * - GET /video-analysis/insights - Get aggregated insights
 * - GET /video-analysis/:videoId - Get analysis results for a specific video
 */

import { Router, Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient, formatSystemPrompt } from '../lib/anthropic-client';
import {
  preprocessVideo,
  cleanupTempFiles,
  PreprocessResult,
} from '../lib/video-preprocessor';
import { generateDescriptions } from '../lib/opensource-vision-client';

const router = Router();

// Fetch video title from YouTube oEmbed API (no API key required)
async function fetchVideoTitle(videoId: string): Promise<string | null> {
  // Try YouTube oEmbed first (most reliable, no API key needed)
  try {
    const oEmbedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetch(oEmbedUrl);
    if (response.ok) {
      const data = await response.json() as { title?: string };
      if (data.title) {
        console.log(`[video-analysis] Got title from oEmbed: ${data.title}`);
        return data.title;
      }
    }
  } catch (err) {
    console.warn(`[video-analysis] oEmbed title fetch failed: ${err}`);
  }

  // Fallback to Supadata API
  try {
    const apiKey = process.env.SUPADATA_API_KEY;
    if (apiKey) {
      const response = await fetch(
        `https://api.supadata.ai/v1/youtube/transcript?video_id=${videoId}&text=false`,
        { headers: { 'x-api-key': apiKey } }
      );
      if (response.ok) {
        const data = await response.json() as { title?: string };
        if (data.title) {
          console.log(`[video-analysis] Got title from Supadata: ${data.title}`);
          return data.title;
        }
      }
    }
  } catch (err) {
    console.warn(`[video-analysis] Supadata title fetch failed: ${err}`);
  }

  return null;
}

// Supabase client
let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Supabase credentials not configured');
    supabase = createClient(url, key);
  }
  return supabase;
}

// In-memory job tracking (could move to Redis for production)
const analysisJobs = new Map<string, {
  status: 'pending' | 'downloading' | 'extracting' | 'analyzing' | 'complete' | 'failed';
  progress: number;
  error?: string;
  title?: string;
  startedAt: Date;
}>();

/**
 * POST /video-analysis/download
 * Download a YouTube video for analysis
 */
router.post('/download', async (req: Request, res: Response) => {
  try {
    const { videoId, videoUrl, quality = '720p' } = req.body;

    if (!videoId || !videoUrl) {
      return res.status(400).json({
        success: false,
        error: 'videoId and videoUrl are required',
      });
    }

    console.log(`[video-analysis] Download requested: ${videoId}`);

    // Check if already exists
    const supabase = getSupabase();
    const { data: existing } = await supabase
      .from('analyzed_videos')
      .select('id, status')
      .eq('video_id', videoId)
      .single();

    if (existing && existing.status === 'complete') {
      return res.json({
        success: true,
        message: 'Video already analyzed',
        videoId,
        status: 'complete',
      });
    }

    // Create or update record
    await supabase
      .from('analyzed_videos')
      .upsert({
        video_id: videoId,
        video_url: videoUrl,
        status: 'pending',
        progress: 0,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'video_id',
      });

    // Initialize job tracking
    analysisJobs.set(videoId, {
      status: 'pending',
      progress: 0,
      startedAt: new Date(),
    });

    return res.json({
      success: true,
      message: 'Video queued for download',
      videoId,
      status: 'pending',
    });

  } catch (error: any) {
    console.error('[video-analysis] Download error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to queue video download',
    });
  }
});

/**
 * POST /video-analysis/analyze
 * Trigger full analysis pipeline for a video
 */
router.post('/analyze', async (req: Request, res: Response) => {
  try {
    const { videoId, videoUrl: providedUrl, options = {} } = req.body;

    if (!videoId) {
      return res.status(400).json({
        success: false,
        error: 'videoId is required',
      });
    }

    // Construct YouTube URL from videoId if not provided
    const videoUrl = providedUrl || `https://www.youtube.com/watch?v=${videoId}`;

    console.log(`[video-analysis] Analysis requested: ${videoId} (${videoUrl})`);

    // Fetch video title early
    const videoTitle = await fetchVideoTitle(videoId);
    console.log(`[video-analysis] Video title: ${videoTitle || 'Unknown'}`);

    // Initialize job with title
    analysisJobs.set(videoId, {
      status: 'downloading',
      progress: 0,
      title: videoTitle || undefined,
      startedAt: new Date(),
    });

    // Update database status with title
    const supabase = getSupabase();
    await supabase
      .from('analyzed_videos')
      .upsert({
        video_id: videoId,
        video_url: videoUrl,
        title: videoTitle,
        status: 'downloading',
        progress: 5,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'video_id',
      });

    // Start analysis in background
    processAnalysis(videoId, videoUrl, options)
      .catch(err => {
        console.error(`[video-analysis] Background analysis failed:`, err);
      });

    return res.json({
      success: true,
      message: 'Analysis started',
      videoId,
      status: 'downloading',
    });

  } catch (error: any) {
    console.error('[video-analysis] Analyze error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to start analysis',
    });
  }
});

/**
 * Background analysis pipeline
 */
async function processAnalysis(
  videoId: string,
  videoUrl: string,
  options: any
): Promise<void> {
  const supabase = getSupabase();

  try {
    // Update status helper
    const updateStatus = async (status: string, progress: number, extra: any = {}) => {
      analysisJobs.set(videoId, {
        ...analysisJobs.get(videoId)!,
        status: status as any,
        progress,
      });

      await supabase
        .from('analyzed_videos')
        .update({
          status,
          progress,
          ...extra,
          updated_at: new Date().toISOString(),
        })
        .eq('video_id', videoId);
    };

    // Step 1: Preprocess video (download, extract frames, detect scenes)
    await updateStatus('downloading', 5);

    console.log(`[video-analysis] Preprocessing video: ${videoId}`);
    const preprocessResult = await preprocessVideo(videoId, videoUrl, {
      quality: options.quality || '720p',
      fps: options.fps || 1,
      uploadFrames: true,
      onDownloadProgress: async (percent) => {
        // Map download 0-100% to overall progress 5-40%
        const overallProgress = Math.round(5 + (percent * 0.35));
        console.log(`[video-analysis] Download progress: ${percent.toFixed(1)}% (overall: ${overallProgress}%)`);
        await updateStatus('downloading', overallProgress);
      },
      onProgress: async (status, percent, message) => {
        // Update status for each preprocessing step
        const logMessage = message ? `${status} ${percent}% - ${message}` : `${status} ${percent}%`;
        console.log(`[video-analysis] Preprocessing: ${logMessage}`);
        await updateStatus(status, percent, message ? { status_message: message } : {});
      },
    });

    // Log download tier metrics
    console.log(`[video-analysis] Download metrics: { videoId: ${videoId}, tier: ${preprocessResult.tier}, duration: ${preprocessResult.duration}s }`);

    await updateStatus('analyzing', 50, {
      duration_seconds: Math.round(preprocessResult.duration),
      download_tier: preprocessResult.tier,
    });

    // Step 2: Generate visual descriptions using LLaVA-NeXT v1.6
    console.log(`[video-analysis] Using LLaVA-NeXT v1.6 for frame descriptions`);

    const descriptions: Map<number, string> = new Map();
    if (preprocessResult.frameUrls.length > 0) {
      console.log(`[video-analysis] Generating visual descriptions for ${preprocessResult.frameUrls.length} frames`);
      try {
        const descriptionResult = await generateDescriptions(preprocessResult.frameUrls, {
          batchSize: 5,         // 5 frames per batch (reduced from 10 to avoid CUDA OOM)
          maxConcurrent: 10,    // 10 concurrent workers (RunPod allocation)
          useBase64: true,      // Base64 mode enabled with smaller batch size (5 images × 100MB = 500MB VRAM)
          onProgress: async (descriptionPercent) => {
            const overallProgress = Math.round(50 + (descriptionPercent * 0.2));
            console.log(`[video-analysis] Description progress: ${descriptionPercent}% (overall: ${overallProgress}%)`);
            await updateStatus('analyzing', overallProgress);
          },
        });

        // Build map of frameIndex -> description
        for (let i = 0; i < descriptionResult.descriptions.length; i++) {
          descriptions.set(i, descriptionResult.descriptions[i]);
        }

        console.log(`[video-analysis] Generated ${descriptions.size} descriptions using LLaVA-NeXT v1.6`);
      } catch (err: any) {
        console.warn(`[video-analysis] Description generation failed:`, err.message);
        // Continue without descriptions
      }
    }

    await updateStatus('analyzing', 70);

    // Step 3: Save scene data with descriptions
    console.log(`[video-analysis] Saving ${preprocessResult.scenes.length} scenes`);
    for (let i = 0; i < preprocessResult.scenes.length; i++) {
      const scene = preprocessResult.scenes[i];
      const colors = preprocessResult.colors[i];
      const frameUrl = preprocessResult.frameUrls[scene.frameIndex] || null;
      const description = descriptions.get(scene.frameIndex) || null;

      await supabase
        .from('analyzed_scenes')
        .upsert({
          video_id: videoId,
          scene_index: scene.index,
          start_seconds: scene.startSeconds,
          end_seconds: scene.endSeconds,
          dominant_color: colors?.dominantColor || null,
          brightness: colors?.brightness || null,
          frame_url: frameUrl,
          scene_description: description,
        }, {
          onConflict: 'video_id,scene_index',
        });
    }

    await updateStatus('analyzing', 75);

    // Step 4: Compute aggregate metrics
    const avgSceneDuration = preprocessResult.scenes.reduce(
      (sum, s) => sum + (s.endSeconds - s.startSeconds),
      0
    ) / preprocessResult.scenes.length;

    const cutsPerMinute = (preprocessResult.scenes.length / preprocessResult.duration) * 60;

    const dominantColors = preprocessResult.colors
      .map(c => c.dominantColor)
      .filter(c => c !== '#000000')
      .slice(0, 5);

    // Step 5: Update final analysis results
    await supabase
      .from('analyzed_videos')
      .update({
        status: 'complete',
        progress: 100,
        analyzed_at: new Date().toISOString(),
        avg_scene_duration: avgSceneDuration,
        cuts_per_minute: cutsPerMinute,
        dominant_colors: dominantColors,
        download_tier: preprocessResult.tier,
        visual_analysis: {
          frameCount: preprocessResult.framePaths.length,
          sceneCount: preprocessResult.scenes.length,
          colors: preprocessResult.colors,
        },
        pacing_analysis: {
          scenes: preprocessResult.scenes,
          avgSceneDuration,
          cutsPerMinute,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('video_id', videoId);

    analysisJobs.set(videoId, {
      ...analysisJobs.get(videoId)!,
      status: 'complete',
      progress: 100,
    });

    console.log(`[video-analysis] Analysis complete: ${videoId}`);

    // Cleanup temp files
    cleanupTempFiles(videoId);

  } catch (error: any) {
    console.error(`[video-analysis] Analysis failed for ${videoId}:`, error);

    analysisJobs.set(videoId, {
      ...analysisJobs.get(videoId)!,
      status: 'failed',
      error: error.message,
    });

    await supabase
      .from('analyzed_videos')
      .update({
        status: 'failed',
        error_message: error.message,
        updated_at: new Date().toISOString(),
      })
      .eq('video_id', videoId);

    // Cleanup temp files on failure
    cleanupTempFiles(videoId);
  }
}

/**
 * GET /video-analysis/status/:videoId
 * Check analysis status
 */
router.get('/status/:videoId', async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;

    // Check in-memory first (more current)
    const job = analysisJobs.get(videoId);
    if (job) {
      return res.json({
        success: true,
        videoId,
        title: job.title,
        status: job.status,
        progress: job.progress,
        error: job.error,
      });
    }

    // Fall back to database
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('analyzed_videos')
      .select('status, progress, error_message, title')
      .eq('video_id', videoId)
      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        error: 'Video not found',
      });
    }

    return res.json({
      success: true,
      videoId,
      title: data.title,
      status: data.status,
      progress: data.progress,
      error: data.error_message,
    });

  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /video-analysis/query
 * Ask questions about analyzed videos using Claude
 */
router.post('/query', async (req: Request, res: Response) => {
  try {
    const { query, videoIds, maxResults = 5 } = req.body;

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'query is required',
      });
    }

    console.log(`[video-analysis] Query: "${query}"`);

    const supabase = getSupabase();

    // Build query for analyzed videos
    let videoQuery = supabase
      .from('analyzed_videos')
      .select('*')
      .eq('status', 'complete');

    if (videoIds && videoIds.length > 0) {
      videoQuery = videoQuery.in('video_id', videoIds);
    }

    const { data: videos, error: videosError } = await videoQuery.limit(50);

    if (videosError || !videos || videos.length === 0) {
      return res.json({
        success: true,
        answer: 'No analyzed videos found to query.',
        sources: [],
      });
    }

    const videoIdsForScenes = videos.map(video => video.video_id);
    const { data: scenes, error: scenesError } = await supabase
      .from('analyzed_scenes')
      .select('video_id, scene_index, start_seconds, end_seconds, dominant_color, scene_description')
      .in('video_id', videoIdsForScenes)
      .order('scene_index', { ascending: true });

    if (scenesError) {
      console.warn('[video-analysis] Failed to fetch scenes:', scenesError);
    }

    const scenesByVideo = new Map<string, typeof scenes>();
    for (const scene of scenes || []) {
      const list = scenesByVideo.get(scene.video_id) || [];
      list.push(scene);
      scenesByVideo.set(scene.video_id, list);
    }

    const videoContext: any[] = videos.map(video => {
      const videoScenes = scenesByVideo.get(video.video_id) || [];

      return {
        id: video.video_id,
        title: video.title || 'Unknown',
        channel: video.channel_name || 'Unknown',
        duration: video.duration_seconds,
        avgSceneDuration: video.avg_scene_duration,
        cutsPerMinute: video.cuts_per_minute,
        dominantColors: video.dominant_colors,
        viewCount: video.view_count,
        scenes: videoScenes.map(s => ({
          sceneIndex: s.scene_index,
          timestamp: `${Math.floor(s.start_seconds / 60)}:${String(Math.floor(s.start_seconds % 60)).padStart(2, '0')}`,
          color: s.dominant_color,
          description: s.scene_description,
        })),
      };
    });

    // Query Claude
    const anthropic = createAnthropicClient();

    const systemPrompt = `You are a video production analysis assistant helping recreate successful video styles.

You have detailed scene-by-scene analysis of ${videos.length} YouTube videos, including:
- Visual production details (camera angles, effects, color grading, composition)
- Pacing metrics (cuts per minute, scene duration)
- Color palettes and dominant colors
- Frame-by-frame descriptions with production notes

Video analysis data:
${JSON.stringify(videoContext, null, 2)}

When answering questions:
1. Focus on ACTIONABLE production details that can be replicated
2. Cite specific scenes with timestamps as examples
3. Describe visual elements (effects, camera work, colors, composition)
4. Be specific about what makes the style effective
5. Suggest how to recreate similar visuals

Your goal is to help the Auto Poster system recreate videos in the same style as successful originals.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: formatSystemPrompt(systemPrompt) as Anthropic.MessageCreateParams['system'],
      messages: [
        {
          role: 'user',
          content: query,
        },
      ],
    });

    const textContent = response.content.find(block => block.type === 'text');
    const answer = textContent?.type === 'text' ? textContent.text : 'No response generated';

    // Return top relevant videos as sources
    const sources = videos.slice(0, maxResults).map(v => ({
      videoId: v.video_id,
      title: v.title,
      channelName: v.channel_name,
      metric: `${Math.round(v.avg_scene_duration || 0)}s avg scene`,
    }));

    return res.json({
      success: true,
      answer,
      sources,
      videoCount: videos.length,
    });

  } catch (error: any) {
    console.error('[video-analysis] Query error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /video-analysis/insights
 * Get aggregated insights across all analyzed videos
 */
router.get('/insights', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();

    // Get all completed analyses
    const { data: videos, error } = await supabase
      .from('analyzed_videos')
      .select('*')
      .eq('status', 'complete');

    if (error || !videos || videos.length === 0) {
      return res.json({
        success: true,
        insights: null,
        message: 'No analyzed videos found',
      });
    }

    // Aggregate metrics
    const avgSceneDurations = videos
      .filter(v => v.avg_scene_duration)
      .map(v => v.avg_scene_duration);

    const cutsPerMinuteValues = videos
      .filter(v => v.cuts_per_minute)
      .map(v => v.cuts_per_minute);

    // Count color frequencies
    const colorCounts = new Map<string, number>();
    for (const video of videos) {
      for (const color of (video.dominant_colors || [])) {
        colorCounts.set(color, (colorCounts.get(color) || 0) + 1);
      }
    }

    const topColors = Array.from(colorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([color, count]) => ({ color, frequency: count / videos.length }));

    const insights = {
      videoCount: videos.length,
      avgSceneDuration: avgSceneDurations.length > 0
        ? avgSceneDurations.reduce((a, b) => a + b, 0) / avgSceneDurations.length
        : null,
      avgCutsPerMinute: cutsPerMinuteValues.length > 0
        ? cutsPerMinuteValues.reduce((a, b) => a + b, 0) / cutsPerMinuteValues.length
        : null,
      topColors,
      sceneRange: avgSceneDurations.length > 0
        ? [Math.min(...avgSceneDurations), Math.max(...avgSceneDurations)]
        : null,
    };

    return res.json({
      success: true,
      insights,
    });

  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /video-analysis/videos
 * List all analyzed videos with basic metadata
 */
router.get('/videos', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const parsedLimit = parseInt(String(req.query.limit || '50'), 10);
    const parsedOffset = parseInt(String(req.query.offset || '0'), 10);
    const limit = Number.isNaN(parsedLimit) ? 50 : Math.min(parsedLimit, 200);
    const offset = Number.isNaN(parsedOffset) ? 0 : Math.max(parsedOffset, 0);

    const { data: videos, error } = await supabase
      .from('analyzed_videos')
      .select('video_id, video_url, title, channel_name, duration_seconds, status, progress, avg_scene_duration, cuts_per_minute, dominant_colors, analyzed_at, created_at')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw error;
    }

    return res.json({
      success: true,
      videos: videos || [],
    });

  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /video-analysis/health
 * Check if video analysis services are available
 */
router.get('/health', async (req: Request, res: Response) => {
  try {
    return res.json({
      success: true,
      services: {
        claudeVision: !!process.env.ANTHROPIC_API_KEY,
        supabase: !!process.env.SUPABASE_URL,
      },
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /video-analysis/backfill-titles
 * Fetch and update titles for videos that have null titles
 */
router.post('/backfill-titles', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();

    // Get videos with null titles
    const { data: videos, error } = await supabase
      .from('analyzed_videos')
      .select('video_id')
      .is('title', null);

    if (error) throw error;

    if (!videos || videos.length === 0) {
      return res.json({
        success: true,
        message: 'No videos need title updates',
        updated: 0,
      });
    }

    console.log(`[video-analysis] Backfilling titles for ${videos.length} videos`);

    let updated = 0;
    for (const video of videos) {
      const title = await fetchVideoTitle(video.video_id);
      if (title) {
        await supabase
          .from('analyzed_videos')
          .update({ title })
          .eq('video_id', video.video_id);
        updated++;
        console.log(`[video-analysis] Updated title for ${video.video_id}: ${title}`);
      }
    }

    return res.json({
      success: true,
      message: `Updated ${updated} of ${videos.length} videos`,
      updated,
      total: videos.length,
    });

  } catch (error: any) {
    console.error('[video-analysis] Backfill titles error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * DELETE /video-analysis/:videoId
 * Delete a video analysis and its scenes
 */
router.delete('/:videoId', async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;

    const supabase = getSupabase();

    // Delete scenes first (foreign key constraint)
    await supabase
      .from('analyzed_scenes')
      .delete()
      .eq('video_id', videoId);

    // Delete the video record
    const { error } = await supabase
      .from('analyzed_videos')
      .delete()
      .eq('video_id', videoId);

    if (error) throw error;

    // Remove from in-memory jobs if exists
    analysisJobs.delete(videoId);

    console.log(`[video-analysis] Deleted video: ${videoId}`);

    return res.json({
      success: true,
      message: `Video ${videoId} deleted`,
    });

  } catch (error: any) {
    console.error('[video-analysis] Delete error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /video-analysis/:videoId
 * Get full analysis results for a video
 * NOTE: This must be LAST as it's a catch-all route
 */
router.get('/:videoId', async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;

    const supabase = getSupabase();

    // Get video analysis
    const { data: video, error: videoError } = await supabase
      .from('analyzed_videos')
      .select('*')
      .eq('video_id', videoId)
      .single();

    if (videoError || !video) {
      return res.status(404).json({
        success: false,
        error: 'Video not found',
      });
    }

    // Get scenes
    const { data: scenes } = await supabase
      .from('analyzed_scenes')
      .select('*')
      .eq('video_id', videoId)
      .order('scene_index', { ascending: true });

    // Get style profile if exists
    const { data: styleProfile } = await supabase
      .from('video_style_profiles')
      .select('*')
      .eq('video_id', videoId)
      .single();

    return res.json({
      success: true,
      video,
      scenes: scenes || [],
      styleProfile: styleProfile || null,
    });

  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
