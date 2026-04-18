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
import { createProject, updateProject, getSupabaseClient, getProjectData, ProjectUpdate } from '../lib/supabase-project';
import { cleanScript, insertSubscribeCTA, COMPLETE_HISTORIES_TEMPLATE } from '../lib/pipeline-runner';

const router = Router();

// Track running pipelines for cancellation
const runningPipelines = new Map<string, { aborted: boolean; currentStep: string }>();

/**
 * Clean up stale "running" entries on server startup.
 * When the server restarts, any previously "running" pipelines are no longer running.
 * This prevents ghost entries showing "running" status when they're not.
 */
async function cleanupStaleRunningProjects() {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.log('[Pipeline Cleanup] Supabase not configured, skipping cleanup');
    return;
  }

  try {
    // Find all projects with status 'running' that aren't tracked in memory
    const { data: staleProjects, error: fetchError } = await supabase
      .from('generation_projects')
      .select('id, video_title, current_step')
      .eq('status', 'running');

    if (fetchError) {
      console.error('[Pipeline Cleanup] Failed to fetch stale projects:', fetchError);
      return;
    }

    if (!staleProjects || staleProjects.length === 0) {
      console.log('[Pipeline Cleanup] No stale running projects found');
      return;
    }

    console.log(`[Pipeline Cleanup] Found ${staleProjects.length} stale "running" projects from previous session:`);
    staleProjects.forEach(p => {
      console.log(`   - ${p.id.slice(0, 8)}: "${p.video_title}" (was at step: ${p.current_step})`);
    });

    // Mark them as 'cancelled' since they were interrupted by server restart
    const { error: updateError } = await supabase
      .from('generation_projects')
      .update({
        status: 'cancelled',
        current_step: 'server_restart',
        updated_at: new Date().toISOString(),
      })
      .eq('status', 'running');

    if (updateError) {
      console.error('[Pipeline Cleanup] Failed to update stale projects:', updateError);
      return;
    }

    console.log(`[Pipeline Cleanup] Marked ${staleProjects.length} stale projects as 'cancelled' (server_restart)`);
  } catch (err) {
    console.error('[Pipeline Cleanup] Unexpected error:', err);
  }
}

// Run cleanup on module load (server startup)
cleanupStaleRunningProjects();

// Pipeline configuration
const DEFAULT_IMAGE_COUNT = 200;
const DEFAULT_WORD_COUNT = 3000;
const DEFAULT_CLIP_COUNT = 12;
const DEFAULT_CLIP_DURATION = 5;

interface PipelineRequest {
  projectId: string;
  youtubeUrl?: string;  // Optional - either youtubeUrl or script must be provided
  script?: string;      // Direct script input - skips transcript extraction and rewriting
  title?: string;
  topic?: string;
  subjectFocus?: string;  // Visual focus for images (e.g., "servants, housemaids")
  expandWith?: string;    // Optional expansion topics for short source videos
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
 * Make an internal API call using SSE streaming mode
 * Properly reads the SSE stream and extracts the final result
 */
async function callStreamingApi<T>(
  endpoint: string,
  body: Record<string, unknown>,
  timeout: number = 1800000 // 30 min default
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  // Heartbeat interval to keep Railway alive during long waits
  const HEARTBEAT_INTERVAL_MS = 30000; // Log every 30 seconds
  let heartbeatInterval: NodeJS.Timeout | null = null;
  let lastActivityTime = Date.now();
  let eventCount = 0;

  try {
    console.log(`[Pipeline] Calling ${endpoint} with streaming (timeout: ${timeout / 1000}s)...`);

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
      throw new Error(`API call to ${endpoint} failed: ${response.status} - ${errorText}`);
    }

    // Read SSE stream and find the final complete event
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body reader available');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let lastResult: T | null = null;
    let lastProgress = 0;

    // Start heartbeat to keep Railway alive
    heartbeatInterval = setInterval(() => {
      const waitTime = Math.round((Date.now() - lastActivityTime) / 1000);
      console.log(`[Pipeline] ${endpoint} still waiting... (${waitTime}s since last activity, ${eventCount} events received)`);
    }, HEARTBEAT_INTERVAL_MS);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Update activity timestamp
      lastActivityTime = Date.now();

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            eventCount++;

            // Log progress updates
            if (data.progress && data.progress > lastProgress) {
              lastProgress = data.progress;
              console.log(`[Pipeline] ${endpoint} progress: ${data.progress}%`);
            }

            // Log keepalive events to show we're receiving data
            if (data.type === 'keepalive') {
              console.log(`[Pipeline] ${endpoint} keepalive received`);
            }

            // Check for complete event
            if (data.type === 'complete' || data.success === true) {
              lastResult = data as T;
            }

            // Check for error
            if (data.type === 'error' || data.error) {
              throw new Error(data.error || 'Stream error');
            }
          } catch (parseErr) {
            // Ignore JSON parse errors for incomplete data
            if (parseErr instanceof SyntaxError) continue;
            throw parseErr;
          }
        }
      }
    }

    if (!lastResult) {
      throw new Error(`No complete response received from ${endpoint}`);
    }

    console.log(`[Pipeline] ${endpoint} completed successfully (${eventCount} events)`);
    return lastResult;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`API call to ${endpoint} timed out after ${timeout / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
  }
}

/**
 * Make an internal API call for operations that don't support streaming
 * Uses non-streaming JSON response
 */
async function callNonStreamingApi<T>(
  endpoint: string,
  body: Record<string, unknown>,
  timeout: number = 300000 // 5 min default
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    console.log(`[Pipeline] Calling ${endpoint} (non-streaming, timeout: ${timeout / 1000}s)...`);

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

    const result = await response.json() as T;
    console.log(`[Pipeline] ${endpoint} completed successfully`);
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`API call to ${endpoint} timed out after ${timeout / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Check if pipeline should abort
 */
function shouldAbort(projectId: string): boolean {
  const state = runningPipelines.get(projectId);
  return state?.aborted === true;
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
    script: providedScript,  // Direct script input (skips transcript + rewrite)
    title,
    topic,
    subjectFocus,  // Visual focus for images
    expandWith,    // Optional expansion topics for short sources
    template,
    wordCount = DEFAULT_WORD_COUNT,
    imageCount = DEFAULT_IMAGE_COUNT,
    generateClips = false,
    clipCount = DEFAULT_CLIP_COUNT,
    clipDuration = DEFAULT_CLIP_DURATION,
    effects,
  } = config;

  const isDirectScript = !!providedScript && !youtubeUrl;

  console.log(`\n🚀 [Pipeline ${projectId}] Starting full pipeline...`);
  console.log(`   Mode: ${isDirectScript ? 'Direct Script' : 'YouTube URL'}`);
  if (youtubeUrl) console.log(`   YouTube URL: ${youtubeUrl}`);
  if (providedScript) console.log(`   Script provided: ${providedScript.length} chars, ${providedScript.split(/\s+/).length} words`);
  console.log(`   Title: ${title || 'auto-detect'}`);
  console.log(`   Word count: ${wordCount}`);
  console.log(`   Image count: ${imageCount}`);
  console.log(`   Generate clips: ${generateClips}`);
  if (expandWith) console.log(`   Expand With: ${expandWith}`);

  // Register this pipeline as running
  runningPipelines.set(projectId, { aborted: false, currentStep: 'init' });

  let transcript = '';
  let videoTitle = title || '';
  let script = providedScript || '';  // Use provided script if available
  let audioUrl = '';
  let audioDuration = 0;
  let audioSegments: any[] = [];
  let srtContent = '';
  let imagePrompts: any[] = [];
  let imageUrls: string[] = [];
  let clipPrompts: any[] = [];
  let clips: any[] = [];
  let customStylePrompt = '';  // Style prompt for image generation

  try {
    // =========================================================================
    // STEP 0: Check existing data for checkpoint/resume
    // =========================================================================
    if (shouldAbort(projectId)) throw new Error('Pipeline cancelled by user');
    runningPipelines.set(projectId, { aborted: false, currentStep: 'checkpoint' });

    console.log(`\n🔍 [Pipeline ${projectId}] Checking for existing data (checkpoint)...`);
    const existingData = await getProjectData(projectId);

    if (existingData.exists) {
      console.log(`   Found existing project:`);
      console.log(`   - Script: ${existingData.script ? `${existingData.script.length} chars` : 'none'}`);
      console.log(`   - Audio: ${existingData.audioUrl || 'none'}`);
      console.log(`   - Captions: ${existingData.srtContent ? `${existingData.srtContent.length} chars` : 'none'}`);
      console.log(`   - Images: ${existingData.imageUrls?.length || 0}`);

      // Use existing data
      if (existingData.script) script = existingData.script;
      if (existingData.videoTitle) videoTitle = existingData.videoTitle;
      if (existingData.audioUrl) audioUrl = existingData.audioUrl;
      if (existingData.audioDuration) audioDuration = existingData.audioDuration;
      if (existingData.audioSegments) audioSegments = existingData.audioSegments;
      if (existingData.srtContent) srtContent = existingData.srtContent;
      if (existingData.imagePrompts) imagePrompts = existingData.imagePrompts;
      if (existingData.imageUrls) imageUrls = existingData.imageUrls;
      // Load customStylePrompt from settings
      if (existingData.settings?.customStylePrompt) {
        customStylePrompt = existingData.settings.customStylePrompt;
        console.log(`   - Style prompt: ${customStylePrompt.substring(0, 50)}...`);
      }
    }

    // =========================================================================
    // STEP 0b: Create/update project in database
    // =========================================================================
    runningPipelines.set(projectId, { aborted: false, currentStep: 'creating' });

    console.log(`\n📦 [Pipeline ${projectId}] Creating/updating project in database...`);
    // Use 'direct_script' as source when no YouTube URL provided
    const sourceUrl = youtubeUrl || 'direct_script';
    const createResult = await createProject(projectId, sourceUrl, title);
    if (!createResult.success) {
      throw new Error(createResult.error || 'Failed to create project');
    }
    console.log(`   ✓ Project ready`);

    // =========================================================================
    // STEP 1: Get YouTube Transcript (skip if we have script or no YouTube URL)
    // =========================================================================
    if (!script && youtubeUrl) {
      if (shouldAbort(projectId)) throw new Error('Pipeline cancelled by user');
      runningPipelines.set(projectId, { aborted: false, currentStep: 'transcript' });
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
      // User-provided title takes precedence over YouTube-fetched title
      videoTitle = title || transcriptResult.title || 'Untitled';

      console.log(`   ✓ Got transcript: ${transcript.length} chars, title: "${videoTitle}"`);

      // Update video title in database
      await updateProject(projectId, { video_title: videoTitle });
    } else if (script) {
      console.log(`\n⏭️  [Pipeline ${projectId}] Skipping transcript (script provided directly)`);
      // Make sure videoTitle is set when using direct script
      if (!videoTitle) videoTitle = title || 'Untitled';
      await updateProject(projectId, { video_title: videoTitle });
    } else {
      throw new Error('Either youtubeUrl or script must be provided');
    }

    // =========================================================================
    // STEP 2: Rewrite Script (skip if script provided directly or already exists)
    // =========================================================================
    if (!script && transcript) {
      // Only rewrite if we have a transcript (from YouTube) but no script yet
      if (shouldAbort(projectId)) throw new Error('Pipeline cancelled by user');
      runningPipelines.set(projectId, { aborted: false, currentStep: 'script' });
      await updatePipelineStatus(projectId, 'script', 'running');

      console.log(`\n✍️  [Pipeline ${projectId}] Step 2: Rewriting script (${wordCount} words)...`);

      // Use COMPLETE_HISTORIES_TEMPLATE if no custom template provided (same as full auto)
      const scriptTemplate = template || COMPLETE_HISTORIES_TEMPLATE;

      const scriptResult = await callStreamingApi<{
        success?: boolean;
        type?: string;
        script?: string;
        wordCount?: number;
        error?: string;
      }>('/rewrite-script', {
        transcript,
        template: scriptTemplate,
        title: videoTitle,
        topic: topic || videoTitle,
        wordCount,
        model: 'claude-sonnet-4-5',
        projectId,
        expandWith,  // Pass expansion topics if provided
      }, 3600000); // 60 min for 20k+ word scripts

      if (!scriptResult.script) {
        throw new Error(scriptResult.error || 'Failed to generate script');
      }

      // Clean the script of markdown headers and formatting (same as full auto)
      script = cleanScript(scriptResult.script);

      // Insert subscribe CTA after 3rd/4th sentence (same as full auto)
      script = insertSubscribeCTA(script);

      console.log(`   ✓ Generated script: ${script.split(/\s+/).length} words (cleaned + CTA inserted)`);

      // Save script to project (database column is script_content, not script)
      await updateProject(projectId, { script_content: script });
    } else if (providedScript) {
      // Script was provided directly - clean it and add CTA (same as full auto)
      console.log(`\n⏭️  [Pipeline ${projectId}] Using provided script (${script.length} chars, ${script.split(/\s+/).length} words)`);
      script = cleanScript(script);
      script = insertSubscribeCTA(script);
      console.log(`   ✓ Cleaned + CTA inserted: ${script.split(/\s+/).length} words`);
      await updateProject(projectId, { script_content: script });
    } else {
      console.log(`\n⏭️  [Pipeline ${projectId}] Skipping script generation (${script.length} chars already saved)`);
    }

    // =========================================================================
    // STEP 3: Generate Audio (skip if already exists)
    // =========================================================================
    if (!audioUrl) {
      if (shouldAbort(projectId)) throw new Error('Pipeline cancelled by user');
      runningPipelines.set(projectId, { aborted: false, currentStep: 'audio' });
      await updatePipelineStatus(projectId, 'audio', 'running');

      console.log(`\n🔊 [Pipeline ${projectId}] Step 3: Generating audio...`);
      console.log(`   Script to send: ${script?.length || 0} chars, ${script?.split(/\s+/).length || 0} words`);
      const audioResult = await callStreamingApi<{
        success?: boolean;
        type?: string;
        audioUrl?: string;
        duration?: number;
        segments?: any[];
        totalDuration?: number;
        error?: string;
      }>('/generate-audio', {
        script,  // FIXED: audio endpoint expects 'script', not 'text'
        projectId,
      }, 7200000); // 2 hours for long audio (20k+ words)

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
    } else {
      console.log(`\n⏭️  [Pipeline ${projectId}] Skipping audio generation (${audioDuration.toFixed(1)}s already saved)`);
    }

    // =========================================================================
    // STEP 4: Generate Captions (skip if already exists)
    // =========================================================================
    if (!srtContent) {
      if (shouldAbort(projectId)) throw new Error('Pipeline cancelled by user');
      runningPipelines.set(projectId, { aborted: false, currentStep: 'captions' });
      await updatePipelineStatus(projectId, 'captions', 'running');

      console.log(`\n📄 [Pipeline ${projectId}] Step 4: Generating captions...`);
      const captionsResult = await callInternalApi<{
        success: boolean;
        srtContent?: string;
        error?: string;
      }>('/generate-captions', {
        audioUrl,  // Captions endpoint needs audioUrl, not segments
        projectId,
      }, 300000); // 5 min for transcription

      if (!captionsResult.success || !captionsResult.srtContent) {
        throw new Error(captionsResult.error || 'Failed to generate captions');
      }

      srtContent = captionsResult.srtContent;
      console.log(`   ✓ Generated captions: ${srtContent.length} chars`);

      // Save captions to project
      await updateProject(projectId, { srt_content: srtContent });
    } else {
      console.log(`\n⏭️  [Pipeline ${projectId}] Skipping captions (${srtContent.length} chars already saved)`);
    }

    // =========================================================================
    // STEP 5: Generate Image Prompts (skip if already exists)
    // =========================================================================
    if (!imagePrompts || imagePrompts.length === 0) {
      if (shouldAbort(projectId)) throw new Error('Pipeline cancelled by user');
      runningPipelines.set(projectId, { aborted: false, currentStep: 'prompts' });
      await updatePipelineStatus(projectId, 'prompts', 'running');

      console.log(`\n🎨 [Pipeline ${projectId}] Step 5: Generating ${imageCount} image prompts...`);
      if (customStylePrompt) {
        console.log(`   Using custom style prompt: ${customStylePrompt.substring(0, 80)}...`);
      }
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
        masterStylePrompt: customStylePrompt,  // Pass custom style prompt for image generation
        topic: topic || videoTitle,  // Era for images
        subjectFocus,  // Visual focus for images
        clipCount,  // How many intro clips (first N images are Topic/Focus-driven)
        clipDuration,  // Duration of each clip (default 5s)
      }, 1800000); // 30 min for 200+ prompts

      if (!promptsResult.prompts || promptsResult.prompts.length === 0) {
        throw new Error(promptsResult.error || 'Failed to generate image prompts');
      }

      imagePrompts = promptsResult.prompts;
      console.log(`   ✓ Generated ${imagePrompts.length} image prompts`);

      // Save prompts to project
      await updateProject(projectId, { image_prompts: imagePrompts });
    } else {
      console.log(`\n⏭️  [Pipeline ${projectId}] Skipping prompts (${imagePrompts.length} prompts already saved)`);
    }

    // =========================================================================
    // STEP 6: Generate Images (skip if already exists)
    // =========================================================================
    if (!imageUrls || imageUrls.length === 0) {
      if (shouldAbort(projectId)) throw new Error('Pipeline cancelled by user');
      runningPipelines.set(projectId, { aborted: false, currentStep: 'images' });
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
      }, 10800000); // 3 hours for 200+ images

      if (!imagesResult.images || imagesResult.images.length === 0) {
        throw new Error(imagesResult.error || 'Failed to generate images');
      }

      imageUrls = imagesResult.images;
      console.log(`   ✓ Generated ${imageUrls.length} images`);

      // Save images to project
      await updateProject(projectId, { image_urls: imageUrls });
    } else {
      console.log(`\n⏭️  [Pipeline ${projectId}] Skipping images (${imageUrls.length} images already saved)`);
    }

    // =========================================================================
    // STEP 7 (Optional): Generate Clip Prompts
    // =========================================================================
    if (generateClips) {
      if (shouldAbort(projectId)) throw new Error('Pipeline cancelled by user');
      runningPipelines.set(projectId, { aborted: false, currentStep: 'clip_prompts' });
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
      }, 600000); // 10 min for clip prompts

      if (clipPromptsResult.prompts && clipPromptsResult.prompts.length > 0) {
        clipPrompts = clipPromptsResult.prompts;
        console.log(`   ✓ Generated ${clipPrompts.length} clip prompts`);
        await updateProject(projectId, { clip_prompts: clipPrompts });
      }

      // =========================================================================
      // STEP 8 (Optional): Generate Video Clips
      // =========================================================================
      if (clipPrompts.length > 0) {
        if (shouldAbort(projectId)) throw new Error('Pipeline cancelled by user');
        runningPipelines.set(projectId, { aborted: false, currentStep: 'clips' });
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
        }, 7200000); // 2 hours for video clips

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
    if (shouldAbort(projectId)) throw new Error('Pipeline cancelled by user');
    runningPipelines.set(projectId, { aborted: false, currentStep: 'render' });
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
    }, 14400000); // 4 hours for 2+ hour video render

    if (!renderResult.videoUrl) {
      throw new Error(renderResult.error || 'Failed to render video');
    }

    console.log(`   ✓ Rendered video: ${renderResult.videoUrl}`);

    // Save final video URLs
    const finalUpdates: ProjectUpdate = {
      video_url: renderResult.videoUrl,
      current_step: 'complete',
      status: 'completed',  // Must be 'completed' not 'complete' to match frontend
    };
    if (renderResult.smokeEmbersVideoUrl) {
      finalUpdates.smoke_embers_video_url = renderResult.smokeEmbersVideoUrl;
    }
    await updateProject(projectId, finalUpdates);

    console.log(`\n✅ [Pipeline ${projectId}] Pipeline complete!`);

    // Clean up tracking
    runningPipelines.delete(projectId);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : '';
    const wasCancelled = errorMessage.includes('cancelled by user');
    const currentStep = runningPipelines.get(projectId)?.currentStep || 'unknown';

    console.error(`\n❌ [Pipeline ${projectId}] Pipeline ${wasCancelled ? 'cancelled' : 'failed'} at step "${currentStep}":`);
    console.error(`   Error: ${errorMessage}`);
    if (errorStack) {
      console.error(`   Stack: ${errorStack.split('\n').slice(0, 5).join('\n   ')}`);
    }

    try {
      await updateProject(projectId, {
        status: wasCancelled ? 'cancelled' : 'failed',
        current_step: currentStep,
      });
    } catch (dbError) {
      console.error(`[Pipeline ${projectId}] Failed to update status in database:`, dbError);
    }

    // Clean up tracking
    runningPipelines.delete(projectId);

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
  if (!config.youtubeUrl && !config.script) {
    return res.status(400).json({ error: 'Either youtubeUrl or script is required' });
  }

  // Validate Supabase is configured
  const supabase = getSupabaseClient();
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  // Check if pipeline is already running for this project (prevent duplicates)
  const existingPipeline = runningPipelines.get(config.projectId);
  if (existingPipeline && !existingPipeline.aborted) {
    console.log(`⚠️ Pipeline already running for project ${config.projectId} (step: ${existingPipeline.currentStep})`);
    return res.json({
      success: true,
      message: 'Pipeline already running for this project.',
      projectId: config.projectId,
      alreadyRunning: true,
      currentStep: existingPipeline.currentStep,
    });
  }

  console.log(`\n🚀 Starting full pipeline for project ${config.projectId}...`);

  // Start pipeline in background (fire and forget)
  // IMPORTANT: Use setImmediate to truly detach from the request lifecycle
  setImmediate(() => {
    runPipeline(config).catch(error => {
      console.error(`[Pipeline ${config.projectId}] Background execution failed:`, error);
      // Make sure error is saved to database
      updateProject(config.projectId, {
        status: 'failed',
        current_step: 'error',
      }).catch(dbErr => {
        console.error(`[Pipeline ${config.projectId}] Failed to save error status:`, dbErr);
      });
    });
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

/**
 * DELETE /full-pipeline/:projectId
 *
 * Stop a running pipeline. The pipeline will stop at the next step boundary.
 */
router.delete('/:projectId', async (req: Request, res: Response) => {
  const { projectId } = req.params;

  const pipelineState = runningPipelines.get(projectId);
  const supabase = getSupabaseClient();

  // Always force DB status to 'cancelled' so a page refresh reflects the
  // user's stop intent. Without this, if the in-memory pipeline state is
  // missing (Railway redeploy, or the full-pipeline controller finished
  // while an internal /generate-audio call is still running), the stop
  // would silently no-op and the DB would keep showing 'running'.
  if (supabase) {
    const { data: project } = await supabase
      .from('generation_projects')
      .select('id, status')
      .eq('id', projectId)
      .single();

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    await supabase
      .from('generation_projects')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', projectId);
  }

  if (!pipelineState) {
    return res.json({
      success: true,
      message: 'Pipeline marked cancelled. Any in-flight audio/image step will finish its current batch before stopping.',
      projectId,
      status: 'cancelled',
    });
  }

  // Mark in-memory pipeline for cancellation at the next step boundary.
  console.log(`\n[Pipeline ${projectId}] Stopping at step: ${pipelineState.currentStep}`);
  runningPipelines.set(projectId, { ...pipelineState, aborted: true });

  res.json({
    success: true,
    message: `Pipeline will stop after current step (${pipelineState.currentStep})`,
    projectId,
    currentStep: pipelineState.currentStep,
  });
});

/**
 * GET /full-pipeline/running
 *
 * List all currently running pipelines.
 */
router.get('/running', async (req: Request, res: Response) => {
  const running: { projectId: string; currentStep: string }[] = [];

  runningPipelines.forEach((state, projectId) => {
    if (!state.aborted) {
      running.push({ projectId, currentStep: state.currentStep });
    }
  });

  res.json({
    count: running.length,
    pipelines: running,
  });
});

export default router;
