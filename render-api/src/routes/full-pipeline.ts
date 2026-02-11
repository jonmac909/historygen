/**
 * Full Pipeline Route
 *
 * Server-side automation that runs the entire video generation pipeline.
 * User can start this and close their browser - work continues on the server.
 * Progress is saved to Supabase after each step.
 *
 * Pipeline steps:
 * 1. Get YouTube transcript
 * 2. Rewrite script
 * 3. Generate audio (TTS)
 * 4. Generate captions (SRT)
 * 5. Generate image prompts
 * 6. Generate images
 * 7. (Optional) Generate clip prompts
 * 8. (Optional) Generate video clips
 * 9. Render final video
 */

import { Router, Request, Response } from 'express';
import { createProject, updateProject, getSupabaseClient, ProjectUpdate } from '../lib/supabase-project';

const router = Router();

// Pipeline configuration
const DEFAULT_IMAGE_COUNT = 200;
const DEFAULT_WORD_COUNT = 3000;
const DEFAULT_CLIP_COUNT = 12;
const DEFAULT_CLIP_DURATION = 5;

interface PipelineRequest {
  projectId: string;
  youtubeUrl: string;
  title?: string;
  topic?: string;
  template?: string;
  wordCount?: number;
  imageCount?: number;
  generateClips?: boolean;
  clipCount?: number;
  clipDuration?: number;
  effects?: {
    embers?: boolean;
    smoke_embers?: boolean;
  };
}

interface PipelineStep {
  name: string;
  status: 'pending' | 'running' | 'complete' | 'failed';
  error?: string;
}

// Internal API base URL (calls to self)
const getInternalApiUrl = () => {
  const port = process.env.PORT || '3000';
  return `http://localhost:${port}`;
};

// Get internal API key for self-calls
const getInternalApiKey = () => process.env.INTERNAL_API_KEY || '';

/**
 * Make an internal API call to another route
 */
async function callInternalApi<T>(
  endpoint: string,
  body: Record<string, unknown>,
  timeout: number = 600000 // 10 min default
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${getInternalApiUrl()}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Api-Key': getInternalApiKey(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API call to ${endpoint} failed: ${response.status} - ${errorText}`);
    }

    return await response.json() as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Make a streaming internal API call and collect the full response
 */
async function callStreamingApi<T>(
  endpoint: string,
  body: Record<string, unknown>,
  timeout: number = 1800000 // 30 min default for streaming
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${getInternalApiUrl()}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Api-Key': getInternalApiKey(),
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Streaming API call to ${endpoint} failed: ${response.status} - ${errorText}`);
    }

    // Parse SSE stream to get final result
    const text = await response.text();
    const lines = text.split('\n');
    let lastData: T | null = null;

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          // Look for complete/done events
          if (data.type === 'complete' || data.type === 'done' || data.success !== undefined) {
            lastData = data;
          }
        } catch {
          // Ignore parse errors for partial data
        }
      }
    }

    if (!lastData) {
      throw new Error(`No complete response from streaming endpoint ${endpoint}`);
    }

    return lastData;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Update project status in Supabase
 */
async function updatePipelineStatus(
  projectId: string,
  currentStep: string,
  status: string,
  error?: string
): Promise<void> {
  const updates: ProjectUpdate = {
    current_step: currentStep,
    status,
  };

  await updateProject(projectId, updates);
  console.log(`[Pipeline ${projectId}] Step: ${currentStep}, Status: ${status}${error ? `, Error: ${error}` : ''}`);
}

/**
 * Main pipeline execution
 */
async function runPipeline(config: PipelineRequest): Promise<void> {
  const {
    projectId,
    youtubeUrl,
    title,
    topic,
    template,
    wordCount = DEFAULT_WORD_COUNT,
    imageCount = DEFAULT_IMAGE_COUNT,
    generateClips = false,
    clipCount = DEFAULT_CLIP_COUNT,
    clipDuration = DEFAULT_CLIP_DURATION,
    effects,
  } = config;

  console.log(`\n🚀 [Pipeline ${projectId}] Starting full pipeline...`);
  console.log(`   YouTube URL: ${youtubeUrl}`);
  console.log(`   Title: ${title || 'auto-detect'}`);
  console.log(`   Word count: ${wordCount}`);
  console.log(`   Image count: ${imageCount}`);
  console.log(`   Generate clips: ${generateClips}`);

  let transcript = '';
  let videoTitle = title || '';
  let script = '';
  let audioUrl = '';
  let audioDuration = 0;
  let audioSegments: any[] = [];
  let srtContent = '';
  let imagePrompts: any[] = [];
  let imageUrls: string[] = [];
  let clipPrompts: any[] = [];
  let clips: any[] = [];

  try {
    // =========================================================================
    // STEP 0: Create project in database
    // =========================================================================
    console.log(`\n📦 [Pipeline ${projectId}] Creating project in database...`);
    const createResult = await createProject(projectId, youtubeUrl, title);
    if (!createResult.success) {
      throw new Error(createResult.error || 'Failed to create project');
    }
    console.log(`   ✓ Project created`);

    // =========================================================================
    // STEP 1: Get YouTube Transcript
    // =========================================================================
    await updatePipelineStatus(projectId, 'transcript', 'running');

    console.log(`\n📝 [Pipeline ${projectId}] Step 1: Getting YouTube transcript...`);
    const transcriptResult = await callInternalApi<{
      success: boolean;
      transcript?: string;
      title?: string;
      error?: string;
    }>('/get-youtube-transcript', { url: youtubeUrl }, 120000);

    if (!transcriptResult.success || !transcriptResult.transcript) {
      throw new Error(transcriptResult.error || 'Failed to get transcript');
    }

    transcript = transcriptResult.transcript;
    videoTitle = transcriptResult.title || title || 'Untitled';

    console.log(`   ✓ Got transcript: ${transcript.length} chars, title: "${videoTitle}"`);

    // =========================================================================
    // STEP 2: Rewrite Script
    // =========================================================================
    await updatePipelineStatus(projectId, 'script', 'running');

    console.log(`\n✍️  [Pipeline ${projectId}] Step 2: Rewriting script (${wordCount} words)...`);
    const scriptResult = await callStreamingApi<{
      success?: boolean;
      type?: string;
      script?: string;
      wordCount?: number;
      error?: string;
    }>('/rewrite-script', {
      transcript,
      template: template || '',
      title: videoTitle,
      topic: topic || videoTitle,
      wordCount,
      model: 'claude-sonnet-4-5',
      projectId,
    }, 1800000); // 30 min for long scripts

    if (!scriptResult.script) {
      throw new Error(scriptResult.error || 'Failed to generate script');
    }

    script = scriptResult.script;
    console.log(`   ✓ Generated script: ${scriptResult.wordCount || script.split(/\s+/).length} words`);

    // Save script to project
    await updateProject(projectId, { script });

    // =========================================================================
    // STEP 3: Generate Audio
    // =========================================================================
    await updatePipelineStatus(projectId, 'audio', 'running');

    console.log(`\n🔊 [Pipeline ${projectId}] Step 3: Generating audio...`);
    const audioResult = await callStreamingApi<{
      success?: boolean;
      type?: string;
      audioUrl?: string;
      duration?: number;
      segments?: any[];
      totalDuration?: number;
      error?: string;
    }>('/generate-audio', {
      text: script,
      projectId,
    }, 1200000); // 20 min for audio

    if (!audioResult.audioUrl) {
      throw new Error(audioResult.error || 'Failed to generate audio');
    }

    audioUrl = audioResult.audioUrl;
    audioDuration = audioResult.totalDuration || audioResult.duration || 0;
    audioSegments = audioResult.segments || [];
    console.log(`   ✓ Generated audio: ${audioDuration.toFixed(1)}s, ${audioSegments.length} segments`);

    // Save audio to project
    await updateProject(projectId, {
      audio_url: audioUrl,
      audio_duration: audioDuration,
      audio_segments: audioSegments,
    });

    // =========================================================================
    // STEP 4: Generate Captions
    // =========================================================================
    await updatePipelineStatus(projectId, 'captions', 'running');

    console.log(`\n📄 [Pipeline ${projectId}] Step 4: Generating captions...`);
    const captionsResult = await callInternalApi<{
      success: boolean;
      srtContent?: string;
      error?: string;
    }>('/generate-captions', {
      segments: audioSegments,
      projectId,
    }, 60000);

    if (!captionsResult.success || !captionsResult.srtContent) {
      throw new Error(captionsResult.error || 'Failed to generate captions');
    }

    srtContent = captionsResult.srtContent;
    console.log(`   ✓ Generated captions: ${srtContent.length} chars`);

    // Save captions to project
    await updateProject(projectId, { srt_content: srtContent });

    // =========================================================================
    // STEP 5: Generate Image Prompts
    // =========================================================================
    await updatePipelineStatus(projectId, 'prompts', 'running');

    console.log(`\n🎨 [Pipeline ${projectId}] Step 5: Generating ${imageCount} image prompts...`);
    const promptsResult = await callStreamingApi<{
      success?: boolean;
      type?: string;
      prompts?: any[];
      error?: string;
    }>('/generate-image-prompts', {
      script,
      srtContent,
      audioDuration,
      imageCount,
      projectId,
    }, 600000); // 10 min for prompts

    if (!promptsResult.prompts || promptsResult.prompts.length === 0) {
      throw new Error(promptsResult.error || 'Failed to generate image prompts');
    }

    imagePrompts = promptsResult.prompts;
    console.log(`   ✓ Generated ${imagePrompts.length} image prompts`);

    // Save prompts to project
    await updateProject(projectId, { image_prompts: imagePrompts });

    // =========================================================================
    // STEP 6: Generate Images
    // =========================================================================
    await updatePipelineStatus(projectId, 'images', 'running');

    console.log(`\n🖼️  [Pipeline ${projectId}] Step 6: Generating ${imagePrompts.length} images...`);
    const imagesResult = await callStreamingApi<{
      success?: boolean;
      type?: string;
      images?: string[];
      error?: string;
    }>('/generate-images', {
      prompts: imagePrompts.map(p => p.sceneDescription || p.prompt),
      projectId,
    }, 3600000); // 60 min for images

    if (!imagesResult.images || imagesResult.images.length === 0) {
      throw new Error(imagesResult.error || 'Failed to generate images');
    }

    imageUrls = imagesResult.images;
    console.log(`   ✓ Generated ${imageUrls.length} images`);

    // Save images to project
    await updateProject(projectId, { image_urls: imageUrls });

    // =========================================================================
    // STEP 7 (Optional): Generate Clip Prompts
    // =========================================================================
    if (generateClips) {
      await updatePipelineStatus(projectId, 'clip_prompts', 'running');

      console.log(`\n🎬 [Pipeline ${projectId}] Step 7: Generating ${clipCount} clip prompts...`);
      const clipPromptsResult = await callStreamingApi<{
        success?: boolean;
        type?: string;
        prompts?: any[];
        error?: string;
      }>('/generate-clip-prompts', {
        script,
        srtContent,
        audioDuration,
        clipCount,
        clipDuration,
        imageUrls: imageUrls.slice(0, clipCount), // Use first N images as sources
        projectId,
      }, 300000);

      if (clipPromptsResult.prompts && clipPromptsResult.prompts.length > 0) {
        clipPrompts = clipPromptsResult.prompts;
        console.log(`   ✓ Generated ${clipPrompts.length} clip prompts`);
        await updateProject(projectId, { clip_prompts: clipPrompts });
      }

      // =========================================================================
      // STEP 8 (Optional): Generate Video Clips
      // =========================================================================
      if (clipPrompts.length > 0) {
        await updatePipelineStatus(projectId, 'clips', 'running');

        console.log(`\n🎥 [Pipeline ${projectId}] Step 8: Generating ${clipPrompts.length} video clips...`);
        const clipsResult = await callStreamingApi<{
          success?: boolean;
          type?: string;
          clips?: any[];
          error?: string;
        }>('/generate-video-clips', {
          clipPrompts: clipPrompts.map((p, i) => ({
            ...p,
            imageUrl: imageUrls[i] || imageUrls[0],
          })),
          projectId,
        }, 3600000); // 60 min for clips

        if (clipsResult.clips && clipsResult.clips.length > 0) {
          clips = clipsResult.clips;
          console.log(`   ✓ Generated ${clips.length} video clips`);
          await updateProject(projectId, { clips });
        }
      }
    }

    // =========================================================================
    // STEP 9: Render Final Video
    // =========================================================================
    await updatePipelineStatus(projectId, 'render', 'running');

    console.log(`\n🎬 [Pipeline ${projectId}] Step 9: Rendering final video...`);

    // Calculate image timings from prompts
    const imageTimings = imagePrompts.map(p => ({
      startSeconds: p.startSeconds || 0,
      endSeconds: p.endSeconds || 0,
    }));

    // Prepare intro clips if we have them
    const introClips = clips.length > 0 ? clips.map(c => ({
      url: c.videoUrl,
      startSeconds: c.startSeconds,
      endSeconds: c.endSeconds,
    })) : undefined;

    const renderResult = await callStreamingApi<{
      success?: boolean;
      type?: string;
      videoUrl?: string;
      smokeEmbersVideoUrl?: string;
      error?: string;
    }>('/render-video', {
      projectId,
      audioUrl,
      imageUrls,
      imageTimings,
      srtContent,
      projectTitle: videoTitle,
      effects: effects || { smoke_embers: true },
      introClips,
    }, 7200000); // 2 hours for render

    if (!renderResult.videoUrl) {
      throw new Error(renderResult.error || 'Failed to render video');
    }

    console.log(`   ✓ Rendered video: ${renderResult.videoUrl}`);

    // Save final video URLs
    const finalUpdates: ProjectUpdate = {
      video_url: renderResult.videoUrl,
      current_step: 'complete',
      status: 'complete',
    };
    if (renderResult.smokeEmbersVideoUrl) {
      finalUpdates.smoke_embers_video_url = renderResult.smokeEmbersVideoUrl;
    }
    await updateProject(projectId, finalUpdates);

    console.log(`\n✅ [Pipeline ${projectId}] Pipeline complete!`);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`\n❌ [Pipeline ${projectId}] Pipeline failed:`, errorMessage);

    await updateProject(projectId, {
      status: 'failed',
    });

    throw error;
  }
}

/**
 * POST /full-pipeline
 *
 * Start a full pipeline run. Returns immediately with job ID.
 * Pipeline runs in background and saves progress to Supabase.
 */
router.post('/', async (req: Request, res: Response) => {
  const config = req.body as PipelineRequest;

  // Validate required fields
  if (!config.projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }
  if (!config.youtubeUrl) {
    return res.status(400).json({ error: 'youtubeUrl is required' });
  }

  // Validate Supabase is configured
  const supabase = getSupabaseClient();
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  console.log(`\n🚀 Starting full pipeline for project ${config.projectId}...`);

  // Start pipeline in background (fire and forget)
  runPipeline(config).catch(error => {
    console.error(`[Pipeline ${config.projectId}] Background execution failed:`, error);
  });

  // Return immediately
  res.json({
    success: true,
    message: 'Pipeline started. Progress will be saved to project.',
    projectId: config.projectId,
  });
});

/**
 * GET /full-pipeline/status/:projectId
 *
 * Check the status of a pipeline run.
 */
router.get('/status/:projectId', async (req: Request, res: Response) => {
  const { projectId } = req.params;

  const supabase = getSupabaseClient();
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  try {
    const { data: project, error } = await supabase
      .from('generation_projects')
      .select('current_step, status, video_url, smoke_embers_video_url')
      .eq('id', projectId)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json({
      projectId,
      currentStep: project.current_step,
      status: project.status,
      videoUrl: project.video_url,
      smokeEmbersVideoUrl: project.smoke_embers_video_url,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get status' });
  }
});

export default router;
