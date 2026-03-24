import { Router, Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { ReadableStream as WebReadableStream } from 'stream/web';
import { pipeline } from 'stream/promises';
import { checkAudioIntegrity, logAudioIntegrity } from '../utils/audio-integrity';
import { saveCost } from '../lib/cost-tracker';
import { allowedAssetHosts } from '../lib/runtime-config';

const router = Router();

// Set ffmpeg and ffprobe paths
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}
if (ffprobeStatic?.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

// Helper to get audio duration using ffprobe
function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.warn('Could not probe audio duration:', err.message);
        resolve(0); // Return 0 if probe fails
      } else {
        resolve(metadata.format.duration || 0);
      }
    });
  });
}

// Configuration - balanced for speed and quality
const IMAGES_PER_CHUNK = 10;  // Reduced from 25 to prevent OOM with overlay effects
const PARALLEL_CHUNK_RENDERS_NO_EFFECTS = 2;
const PARALLEL_CHUNK_RENDERS_WITH_EFFECTS = 1;  // Effects pass is memory-intensive
const FFMPEG_PRESET = 'fast';  // Better compression than ultrafast
const FFMPEG_CRF = '26';  // Good quality (18=best, 23=high, 26=good, 30=acceptable)

// Parallel rendering configuration
const PARALLEL_WORKERS = 10;  // 10 RunPod workers for parallel video rendering
const CHUNK_POLL_INTERVAL = 3000;  // 3 seconds between status checks
const CHUNK_MAX_WAIT = 30 * 60 * 1000;  // 30 minutes max per chunk

// Progress tracking state (shared across chunks for accurate progress)
interface RenderProgress {
  totalChunks: number;
  chunksCompleted: number;
  chunkProgress: Map<number, number>;  // chunk index -> percent complete (0-100)
}

// Effect overlays
const EMBERS_OVERLAY_URL = 'https://historygenai.netlify.app/overlays/embers.mp4';
const SMOKE_GRAY_OVERLAY_URL = 'https://historygenai.netlify.app/overlays/smoke_gray.mp4';
const OVERLAY_SOURCE_DURATION = 10;  // Both overlays are 10 seconds

const allowedAssetHostSet = new Set(allowedAssetHosts);

function assertAllowedAssetUrl(rawUrl: string, context: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL for ${context}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Disallowed protocol for ${context}`);
  }

  const hostname = parsed.hostname;
  const isAllowed = Array.from(allowedAssetHostSet).some(host =>
    hostname === host || hostname.endsWith(`.${host}`)
  );

  if (!isAllowed) {
    throw new Error(`Disallowed host for ${context}`);
  }
}

// RunPod rendering configuration
const RUNPOD_VIDEO_ENDPOINT_ID = process.env.RUNPOD_VIDEO_ENDPOINT_ID || '';  // GPU endpoint
const RUNPOD_CPU_ENDPOINT_ID = process.env.RUNPOD_CPU_ENDPOINT_ID || 'bw3dx1k956cee9';  // CPU endpoint (32 vCPU)
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY || '';
const RUNPOD_VIDEO_POLL_INTERVAL = 2000;  // 2 seconds
const RUNPOD_VIDEO_MAX_WAIT = 60 * 60 * 1000;  // 60 minutes max (200 images can take 30-45 min)

type EffectType = 'none' | 'embers' | 'smoke_embers' | 'ken_burns';

interface VideoEffects {
  embers?: boolean;
  smoke_embers?: boolean;
  ken_burns?: boolean;
}

/**
 * Ken Burns effect filter generator.
 * Returns TWO filters for each image: first half + second half.
 *
 * Pattern (alternates per image):
 * - Image 0,2,4... (even): Zoom IN (15s) → Zoom OUT (15s)
 * - Image 1,3,5... (odd): Pan L→R (15s) → Pan R→L (15s)
 */
function getKenBurnsFilters(imageIndex: number, duration: number): { first: string; second: string } {
  const halfDuration = duration / 2;
  const halfFrames = Math.floor(halfDuration * 30);
  const isZoom = imageIndex % 2 === 0;  // Even index = zoom, odd = pan

  // Calculate zoom increment for 12% total zoom over halfFrames (noticeable but smooth)
  const totalZoom = 0.12;  // 12% zoom
  const zoomIncrement = (totalZoom / halfFrames).toFixed(6);
  const endZoom = (1 + totalZoom).toFixed(2);  // 1.12

  if (isZoom) {
    // Zoom: IN for first half (1.0 → 1.12), OUT for second half (1.12 → 1.0)
    // Uses Bannerbear method (scale to 8000px for smooth zoom)
    return {
      first: `scale=8000:-1,zoompan=z='zoom+${zoomIncrement}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${halfFrames}:s=1920x1080:fps=30`,
      second: `scale=8000:-1,zoompan=z='${endZoom}-${zoomIncrement}*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${halfFrames}:s=1920x1080:fps=30`
    };
  } else {
    // Pan: L→R for first half, R→L for second half
    // Scale wider than output to allow horizontal panning (2500px = 580px pan room)
    return {
      first: `scale=2500:-1,crop=1920:1080:'(in_w-1920)*t/${halfDuration}':0`,
      second: `scale=2500:-1,crop=1920:1080:'(in_w-1920)*(1-t/${halfDuration})':0`
    };
  }
}

interface ImageTiming {
  startSeconds: number;
  endSeconds: number;
}

interface IntroClip {
  url: string;
  startSeconds: number;
  endSeconds: number;
}

interface RenderVideoRequest {
  projectId: string;
  audioUrl: string;
  imageUrls: string[];
  imageTimings: ImageTiming[];
  srtContent: string;
  projectTitle: string;
  effects?: VideoEffects;
  useGpu?: boolean;  // Use RunPod GPU rendering (faster but requires endpoint)
  introClips?: IntroClip[];  // Optional intro video clips from LTX-2
}

interface RenderJob {
  id: string;
  project_id: string;
  status: 'queued' | 'downloading' | 'rendering' | 'muxing' | 'uploading' | 'complete' | 'failed';
  progress: number;
  message: string | null;
  video_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// Get Supabase client
function getSupabase(): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase configuration');
  }
  return createClient(supabaseUrl, supabaseKey);
}

// Update job status in Supabase
async function updateJobStatus(
  supabase: SupabaseClient,
  jobId: string,
  status: RenderJob['status'],
  progress: number,
  message: string,
  extras?: { video_url?: string; error?: string }
): Promise<void> {
  // Build update object - only include video_url/error if explicitly provided
  const updateData: Record<string, unknown> = {
    status,
    progress,
    message,
    updated_at: new Date().toISOString()
  };

  // Only set video_url if explicitly provided (don't overwrite with null)
  if (extras?.video_url !== undefined) {
    updateData.video_url = extras.video_url;
  }
  if (extras?.error !== undefined) {
    updateData.error = extras.error;
  }

  const { error } = await supabase
    .from('render_jobs')
    .update(updateData)
    .eq('id', jobId);

  if (error) {
    console.error(`Failed to update job ${jobId}:`, error);
  } else {
    console.log(`Job ${jobId}: ${status} ${progress}% - ${message}`);
  }
}

// Update the generation_projects table with the rendered video URL
async function updateProjectVideoUrl(
  supabase: SupabaseClient,
  projectId: string,
  videoUrl: string,
  effects?: VideoEffects
): Promise<void> {
  const column = effects?.ken_burns
    ? 'ken_burns_video_url'
    : effects?.smoke_embers
      ? 'smoke_embers_video_url'
      : effects?.embers
        ? 'embers_video_url'
        : 'video_url';

  const { error } = await supabase
    .from('generation_projects')
    .update({ [column]: videoUrl })
    .eq('id', projectId);

  if (error) {
    console.error(`Failed to update project ${projectId} ${column}:`, error);
  } else {
    console.log(`Updated project ${projectId} ${column} = ${videoUrl}`);
  }
}

// Download file from URL to temp directory
async function downloadFile(url: string, destPath: string): Promise<void> {
  assertAllowedAssetUrl(url, 'download');
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }

  const nodeStream = Readable.fromWeb(response.body as unknown as WebReadableStream);
  await pipeline(nodeStream, fs.createWriteStream(destPath));
}

// RunPod GPU rendering function
async function processRenderJobGpu(jobId: string, params: RenderVideoRequest): Promise<void> {
  const supabase = getSupabase();
  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  try {
    const { projectId, audioUrl, imageUrls, imageTimings, effects, introClips } = params;

    // Determine if effects should be applied
    const applyEffects = effects?.smoke_embers || effects?.embers || false;

    console.log(`Job ${jobId}: Starting GPU render for project ${projectId}`);
    console.log(`Images: ${imageUrls.length}, Intro Clips: ${introClips?.length || 0}, Effects: ${applyEffects}`);

    await updateJobStatus(supabase, jobId, 'queued', 5, 'Submitting to GPU worker...');

    // Submit job to RunPod
    const runpodUrl = `https://api.runpod.ai/v2/${RUNPOD_VIDEO_ENDPOINT_ID}/run`;
    const runpodResponse = await fetch(runpodUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RUNPOD_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        input: {
          image_urls: imageUrls,
          timings: imageTimings,
          audio_url: audioUrl,
          project_id: projectId,
          apply_effects: applyEffects,
          ken_burns: effects?.ken_burns || false,  // Ken Burns zoom/pan effect
          supabase_url: supabaseUrl,
          supabase_key: supabaseKey,
          render_job_id: jobId,  // So GPU worker can update job status directly
          intro_clips: introClips || []  // LTX-2 video clips to prepend
        }
      })
    });

    if (!runpodResponse.ok) {
      const errorText = await runpodResponse.text();
      throw new Error(`RunPod submission failed: ${runpodResponse.status} - ${errorText}`);
    }

    const runpodData = await runpodResponse.json() as { id: string; status: string };
    const runpodJobId = runpodData.id;
    console.log(`Job ${jobId}: RunPod job submitted: ${runpodJobId}`);

    await updateJobStatus(supabase, jobId, 'rendering', 10, 'GPU rendering started...');

    // Poll for completion
    const statusUrl = `https://api.runpod.ai/v2/${RUNPOD_VIDEO_ENDPOINT_ID}/status/${runpodJobId}`;
    const startTime = Date.now();
    let lastProgress = 10;

    while (Date.now() - startTime < RUNPOD_VIDEO_MAX_WAIT) {
      await new Promise(resolve => setTimeout(resolve, RUNPOD_VIDEO_POLL_INTERVAL));

      const statusResponse = await fetch(statusUrl, {
        headers: { 'Authorization': `Bearer ${RUNPOD_API_KEY}` }
      });

      if (!statusResponse.ok) {
        console.warn(`Job ${jobId}: Status check failed: ${statusResponse.status}`);
        continue;
      }

      const statusData = await statusResponse.json() as {
        status: string;
        output?: { video_url?: string; error?: string; render_time_seconds?: number };
      };

      if (statusData.status === 'COMPLETED') {
        if (statusData.output?.video_url) {
          const videoUrl = statusData.output.video_url;
          const renderTime = statusData.output.render_time_seconds || 0;
          console.log(`Job ${jobId}: GPU render complete in ${renderTime.toFixed(1)}s`);
          console.log(`Video URL: ${videoUrl}`);

          await updateJobStatus(supabase, jobId, 'complete', 100,
            `Video rendered successfully (GPU: ${renderTime.toFixed(1)}s)`,
            { video_url: videoUrl });
          await updateProjectVideoUrl(supabase, params.projectId, videoUrl, params.effects);
          return;
        } else if (statusData.output?.error) {
          throw new Error(`GPU render failed: ${statusData.output.error}`);
        }
      } else if (statusData.status === 'FAILED') {
        // Check Supabase for actual status - GPU worker may have completed before being killed
        const { data: jobData } = await supabase
          .from('render_jobs')
          .select('status, progress, video_url, error')
          .eq('id', jobId)
          .single();

        if (jobData?.status === 'complete' && jobData?.video_url) {
          // GPU worker actually completed! RunPod just killed it after upload
          console.log(`Job ${jobId}: GPU worker was killed but job actually completed`);
          console.log(`Video URL: ${jobData.video_url}`);
          return;  // Success - video_url already in Supabase
        }

        // Truly failed
        const errorMsg = statusData.output?.error || jobData?.error || 'GPU worker failed';
        throw new Error(errorMsg);
      } else if (statusData.status === 'IN_PROGRESS' || statusData.status === 'IN_QUEUE') {
        // Read real progress from Supabase (GPU worker updates it directly)
        const { data: jobData } = await supabase
          .from('render_jobs')
          .select('progress, message, status')
          .eq('id', jobId)
          .single();

        if (jobData && jobData.progress > lastProgress) {
          lastProgress = jobData.progress;
          // Don't update Supabase again - GPU worker already did
          console.log(`Job ${jobId}: GPU worker progress: ${jobData.progress}% - ${jobData.message}`);
        }
      }
      // IN_QUEUE status - keep waiting
    }

    // Before timing out, check if GPU worker actually completed
    const { data: finalCheck } = await supabase
      .from('render_jobs')
      .select('status, progress, video_url')
      .eq('id', jobId)
      .single();

    if (finalCheck?.status === 'complete' && finalCheck?.video_url) {
      console.log(`Job ${jobId}: GPU worker completed (caught at timeout check)`);
      console.log(`Video URL: ${finalCheck.video_url}`);
      return;  // Success
    }

    throw new Error('GPU render timed out after 30 minutes');

  } catch (error: any) {
    console.error(`Job ${jobId} failed:`, error);
    await updateJobStatus(supabase, jobId, 'failed', 0, 'Render failed', { error: error.message });
  }
}

// Parallel rendering using 10 RunPod workers for ~10x speedup
async function processRenderJobParallel(jobId: string, params: RenderVideoRequest): Promise<void> {
  const supabase = getSupabase();
  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  try {
    const { projectId, audioUrl, imageUrls, imageTimings, effects, introClips } = params;
    const applyEffects = effects?.smoke_embers || effects?.embers || false;

    console.log(`Job ${jobId}: Starting PARALLEL render for project ${projectId}`);
    console.log(`Images: ${imageUrls.length}, Intro Clips: ${introClips?.length || 0}, Workers: ${PARALLEL_WORKERS}, Effects: ${applyEffects}`);

    await updateJobStatus(supabase, jobId, 'queued', 2, 'Preparing parallel render...');

    // Calculate chunk distribution
    const numChunks = Math.min(PARALLEL_WORKERS, imageUrls.length);
    const imagesPerChunk = Math.ceil(imageUrls.length / numChunks);

    interface ChunkInfo {
      index: number;
      imageUrls: string[];
      timings: ImageTiming[];
      runpodJobId?: string;
      status: 'pending' | 'submitted' | 'completed' | 'failed';
      chunkUrl?: string;
      error?: string;
    }

    // Split images into chunks
    const chunks: ChunkInfo[] = [];
    for (let i = 0; i < numChunks; i++) {
      const start = i * imagesPerChunk;
      const end = Math.min(start + imagesPerChunk, imageUrls.length);
      if (start < imageUrls.length) {
        chunks.push({
          index: i,
          imageUrls: imageUrls.slice(start, end),
          timings: imageTimings.slice(start, end),
          status: 'pending'
        });
      }
    }

    console.log(`Split into ${chunks.length} chunks: ${chunks.map(c => c.imageUrls.length).join(', ')} images each`);
    await updateJobStatus(supabase, jobId, 'rendering', 5, `Submitting ${chunks.length} parallel jobs...`);

    // Submit all chunks to RunPod in parallel
    const runpodUrl = `https://api.runpod.ai/v2/${RUNPOD_CPU_ENDPOINT_ID}/run`;

    await Promise.all(chunks.map(async (chunk) => {
      try {
        const response = await fetch(runpodUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RUNPOD_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            input: {
              image_urls: chunk.imageUrls,
              timings: chunk.timings,
              project_id: projectId,
              apply_effects: applyEffects,
              supabase_url: supabaseUrl,
              supabase_key: supabaseKey,
              render_job_id: jobId,
              // Chunk mode parameters
              chunk_mode: true,
              chunk_index: chunk.index,
              total_chunks: chunks.length
            }
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`RunPod submission failed: ${response.status} - ${errorText}`);
        }

        const data = await response.json() as { id: string };
        chunk.runpodJobId = data.id;
        chunk.status = 'submitted';
        console.log(`Chunk ${chunk.index}: Submitted (RunPod job ${data.id})`);
      } catch (err: any) {
        chunk.status = 'failed';
        chunk.error = err.message;
        console.error(`Chunk ${chunk.index}: Submit failed - ${err.message}`);
      }
    }));

    // Check if any submissions failed
    const failedSubmissions = chunks.filter(c => c.status === 'failed');
    if (failedSubmissions.length > 0) {
      throw new Error(`Failed to submit ${failedSubmissions.length} chunk(s): ${failedSubmissions[0].error}`);
    }

    await updateJobStatus(supabase, jobId, 'rendering', 10, `All ${chunks.length} chunks submitted, rendering...`);

    // Poll all jobs until complete
    const startTime = Date.now();
    let lastProgressUpdate = Date.now();

    while (Date.now() - startTime < CHUNK_MAX_WAIT) {
      await new Promise(resolve => setTimeout(resolve, CHUNK_POLL_INTERVAL));

      // Poll each chunk's status
      await Promise.all(chunks.map(async (chunk) => {
        if (chunk.status !== 'submitted' || !chunk.runpodJobId) return;

        try {
          const statusUrl = `https://api.runpod.ai/v2/${RUNPOD_CPU_ENDPOINT_ID}/status/${chunk.runpodJobId}`;
          const response = await fetch(statusUrl, {
            headers: { 'Authorization': `Bearer ${RUNPOD_API_KEY}` }
          });

          if (!response.ok) {
            console.warn(`Chunk ${chunk.index}: Poll failed ${response.status}`);
            return;
          }

          const data = await response.json() as {
            status: string;
            output?: { chunk_url?: string; error?: string; chunk_index?: number };
          };

          if (data.status === 'COMPLETED') {
            console.log(`Chunk ${chunk.index}: RunPod COMPLETED, output:`, JSON.stringify(data.output || {}).substring(0, 200));
            if (data.output?.chunk_url) {
              chunk.status = 'completed';
              chunk.chunkUrl = data.output.chunk_url;
              console.log(`Chunk ${chunk.index}: Completed - ${chunk.chunkUrl}`);
            } else if (data.output?.error) {
              chunk.status = 'failed';
              chunk.error = data.output.error;
              console.error(`Chunk ${chunk.index}: Failed with error - ${chunk.error}`);
            } else {
              // Unexpected - COMPLETED but no chunk_url or error
              console.error(`Chunk ${chunk.index}: COMPLETED but no chunk_url! Output:`, data.output);
              chunk.status = 'failed';
              chunk.error = 'Worker completed but returned no chunk_url';
            }
          } else if (data.status === 'FAILED') {
            chunk.status = 'failed';
            chunk.error = data.output?.error || 'Worker failed';
            console.error(`Chunk ${chunk.index}: FAILED - ${chunk.error}`);
          } else if (data.status === 'IN_PROGRESS') {
            // Log progress periodically
            console.log(`Chunk ${chunk.index}: IN_PROGRESS`);
          }
        } catch (err: any) {
          console.warn(`Chunk ${chunk.index}: Poll error - ${err.message}`);
        }
      }));

      // Calculate progress
      const completedChunks = chunks.filter(c => c.status === 'completed').length;
      const failedChunks = chunks.filter(c => c.status === 'failed').length;

      // Update progress (10-70% range for rendering)
      if (Date.now() - lastProgressUpdate > 3000) {
        lastProgressUpdate = Date.now();
        const renderProgress = 10 + Math.round((completedChunks / chunks.length) * 60);
        await updateJobStatus(supabase, jobId, 'rendering', renderProgress,
          `Rendered ${completedChunks}/${chunks.length} chunks...`);
      }

      // Check if all done
      if (completedChunks + failedChunks === chunks.length) {
        if (failedChunks > 0) {
          const failedChunk = chunks.find(c => c.status === 'failed');
          throw new Error(`${failedChunks} chunk(s) failed: ${failedChunk?.error}`);
        }
        console.log(`All ${chunks.length} chunks completed!`);
        break;
      }
    }

    // Verify all chunks completed
    const completedChunks = chunks.filter(c => c.status === 'completed');
    if (completedChunks.length !== chunks.length) {
      throw new Error(`Timeout: Only ${completedChunks.length}/${chunks.length} chunks completed`);
    }

    // Stage 2: Dispatch finalize job to RunPod (concat + audio encode + mux + upload)
    // This moves audio encoding to RunPod's 32 cores instead of Railway's slower CPUs
    await updateJobStatus(supabase, jobId, 'muxing', 72, 'Dispatching finalize job to RunPod...');

    // Get chunk URLs in order
    const sortedChunks = chunks.sort((a, b) => a.index - b.index);
    const chunkUrls = sortedChunks.map(c => c.chunkUrl!);
    console.log(`Dispatching finalize job with ${chunkUrls.length} chunks`);

    // Submit finalize job to RunPod CPU endpoint
    const finalizeResponse = await fetch(`https://api.runpod.ai/v2/${RUNPOD_CPU_ENDPOINT_ID}/run`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RUNPOD_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: {
          finalize_mode: true,
          chunk_urls: chunkUrls,
          audio_url: audioUrl,
          project_id: projectId,
          supabase_url: supabaseUrl,
          supabase_key: supabaseKey,
          render_job_id: jobId,
          intro_clips: introClips || [],  // Video clips to prepend with effects
          apply_effects: applyEffects,    // Whether to apply smoke+embers to intro clips
        },
      }),
    });

    if (!finalizeResponse.ok) {
      const errorText = await finalizeResponse.text();
      throw new Error(`Failed to dispatch finalize job: ${finalizeResponse.status} - ${errorText}`);
    }

    const finalizeData = await finalizeResponse.json() as { id: string };
    const finalizeJobId = finalizeData.id;
    console.log(`Finalize job dispatched: ${finalizeJobId}`);

    // Poll for finalize job completion (RunPod updates Supabase directly, but we poll for result)
    const finalizeStartTime = Date.now();
    const FINALIZE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes for long audio encoding
    let finalizeResult: any = null;

    while (Date.now() - finalizeStartTime < FINALIZE_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, 3000)); // Poll every 3s

      const statusResponse = await fetch(`https://api.runpod.ai/v2/${RUNPOD_CPU_ENDPOINT_ID}/status/${finalizeJobId}`, {
        headers: { 'Authorization': `Bearer ${RUNPOD_API_KEY}` },
      });

      if (!statusResponse.ok) continue;

      const statusData = await statusResponse.json() as { status: string; output?: any };

      if (statusData.status === 'COMPLETED') {
        finalizeResult = statusData.output;
        break;
      } else if (statusData.status === 'FAILED') {
        // Log full status data for debugging
        console.error('Finalize job FAILED, full status:', JSON.stringify(statusData, null, 2));
        const errorMsg = statusData.output?.error || (statusData as any).error || 'Unknown error';
        throw new Error(`Finalize job failed: ${errorMsg}`);
      }
      // PENDING, IN_PROGRESS - continue polling
    }

    if (!finalizeResult) {
      throw new Error('Finalize job timed out after 30 minutes');
    }

    if (finalizeResult.error) {
      throw new Error(`Finalize error: ${finalizeResult.error}`);
    }

    const videoUrl = finalizeResult.video_url;
    const totalTimeSeconds = (Date.now() - startTime) / 1000;
    const totalTime = totalTimeSeconds.toFixed(1);
    console.log(`Video finalized: ${videoUrl}`);
    console.log(`Total parallel render time: ${totalTime}s (finalize: ${finalizeResult.finalize_time_seconds?.toFixed(1)}s)`);

    // Save cost to Supabase (RunPod CPU: $0.0003733/second)
    if (projectId && totalTimeSeconds > 0) {
      saveCost({
        projectId,
        source: 'manual',
        step: 'render',
        service: 'runpod_cpu',
        units: totalTimeSeconds,
        unitType: 'seconds',
      }).catch(err => console.error('[cost-tracker] Failed to save render cost:', err));
    }

    // Clean up chunk files from Supabase storage
    const chunkStoragePaths = chunks.map(c => `${projectId}/chunks/chunk_${c.index.toString().padStart(2, '0')}.mp4`);
    await supabase.storage.from('generated-assets').remove(chunkStoragePaths);
    console.log(`Cleaned up ${chunkStoragePaths.length} chunk files from storage`);

    // Status is already updated by RunPod finalize job, but ensure it's complete
    await updateJobStatus(supabase, jobId, 'complete', 100,
      `Video rendered successfully (Parallel: ${totalTime}s)`,
      { video_url: videoUrl });
    await updateProjectVideoUrl(supabase, params.projectId, videoUrl, params.effects);

  } catch (error: any) {
    console.error(`Job ${jobId} failed:`, error);
    await updateJobStatus(supabase, jobId, 'failed', 0, 'Render failed', { error: error.message });
  }
}

// RunPod CPU rendering function (32 vCPU worker - reliable, no GPU lottery)
async function processRenderJobCpuRunpod(jobId: string, params: RenderVideoRequest): Promise<void> {
  const supabase = getSupabase();
  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  try {
    const { projectId, audioUrl, imageUrls, imageTimings, effects, introClips } = params;

    // Determine if effects should be applied
    const applyEffects = effects?.smoke_embers || effects?.embers || false;

    console.log(`Job ${jobId}: Starting CPU RunPod render for project ${projectId}`);
    console.log(`Images: ${imageUrls.length}, Intro Clips: ${introClips?.length || 0}, Effects: ${applyEffects}`);

    await updateJobStatus(supabase, jobId, 'queued', 5, 'Submitting to CPU worker...');

    // Submit job to RunPod CPU endpoint
    const runpodUrl = `https://api.runpod.ai/v2/${RUNPOD_CPU_ENDPOINT_ID}/run`;
    const runpodResponse = await fetch(runpodUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RUNPOD_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        input: {
          image_urls: imageUrls,
          timings: imageTimings,
          audio_url: audioUrl,
          project_id: projectId,
          apply_effects: applyEffects,
          supabase_url: supabaseUrl,
          supabase_key: supabaseKey,
          render_job_id: jobId,
          intro_clips: introClips || []  // LTX-2 video clips to prepend
        }
      })
    });

    if (!runpodResponse.ok) {
      const errorText = await runpodResponse.text();
      throw new Error(`RunPod CPU submission failed: ${runpodResponse.status} - ${errorText}`);
    }

    const runpodData = await runpodResponse.json() as { id: string; status: string };
    const runpodJobId = runpodData.id;
    console.log(`Job ${jobId}: RunPod CPU job submitted: ${runpodJobId}`);

    await updateJobStatus(supabase, jobId, 'rendering', 10, 'CPU rendering started (32 vCPU)...');

    // Poll for completion
    const statusUrl = `https://api.runpod.ai/v2/${RUNPOD_CPU_ENDPOINT_ID}/status/${runpodJobId}`;
    const startTime = Date.now();
    let lastProgress = 10;

    while (Date.now() - startTime < RUNPOD_VIDEO_MAX_WAIT) {
      await new Promise(resolve => setTimeout(resolve, RUNPOD_VIDEO_POLL_INTERVAL));

      const statusResponse = await fetch(statusUrl, {
        headers: { 'Authorization': `Bearer ${RUNPOD_API_KEY}` }
      });

      if (!statusResponse.ok) {
        console.warn(`Job ${jobId}: Status check failed: ${statusResponse.status}`);
        continue;
      }

      const statusData = await statusResponse.json() as {
        status: string;
        output?: { video_url?: string; error?: string; render_time_seconds?: number };
      };

      if (statusData.status === 'COMPLETED') {
        if (statusData.output?.video_url) {
          const videoUrl = statusData.output.video_url;
          const renderTime = statusData.output.render_time_seconds || 0;
          console.log(`Job ${jobId}: CPU render complete in ${renderTime.toFixed(1)}s`);
          console.log(`Video URL: ${videoUrl}`);

          // Save cost to Supabase (RunPod CPU: $0.0003733/second)
          if (projectId && renderTime > 0) {
            saveCost({
              projectId,
              source: 'manual',
              step: 'render',
              service: 'runpod_cpu',
              units: renderTime,
              unitType: 'seconds',
            }).catch(err => console.error('[cost-tracker] Failed to save render cost:', err));
          }

          await updateJobStatus(supabase, jobId, 'complete', 100,
            `Video rendered successfully (CPU: ${renderTime.toFixed(1)}s)`,
            { video_url: videoUrl });
          await updateProjectVideoUrl(supabase, params.projectId, videoUrl, params.effects);
          return;
        } else if (statusData.output?.error) {
          throw new Error(`CPU render failed: ${statusData.output.error}`);
        }
      } else if (statusData.status === 'FAILED') {
        // Check Supabase for actual status - worker may have completed before being killed
        const { data: jobData } = await supabase
          .from('render_jobs')
          .select('status, progress, video_url, error')
          .eq('id', jobId)
          .single();

        if (jobData?.status === 'complete' && jobData?.video_url) {
          console.log(`Job ${jobId}: CPU worker was killed but job actually completed`);
          console.log(`Video URL: ${jobData.video_url}`);
          return;
        }

        const errorMsg = statusData.output?.error || jobData?.error || 'CPU worker failed';
        throw new Error(errorMsg);
      } else if (statusData.status === 'IN_PROGRESS' || statusData.status === 'IN_QUEUE') {
        // Read real progress from Supabase (CPU worker updates it directly)
        const { data: jobData } = await supabase
          .from('render_jobs')
          .select('progress, message, status')
          .eq('id', jobId)
          .single();

        if (jobData && jobData.progress > lastProgress) {
          lastProgress = jobData.progress;
          console.log(`Job ${jobId}: CPU worker progress: ${jobData.progress}% - ${jobData.message}`);
        }
      }
    }

    // Before timing out, check if worker actually completed
    const { data: finalCheck } = await supabase
      .from('render_jobs')
      .select('status, progress, video_url')
      .eq('id', jobId)
      .single();

    if (finalCheck?.status === 'complete' && finalCheck?.video_url) {
      console.log(`Job ${jobId}: CPU worker completed (caught at timeout check)`);
      console.log(`Video URL: ${finalCheck.video_url}`);
      return;
    }

    throw new Error('CPU render timed out after 30 minutes');

  } catch (error: any) {
    console.error(`Job ${jobId} failed:`, error);
    await updateJobStatus(supabase, jobId, 'failed', 0, 'Render failed', { error: error.message });
  }
}

// Background render processing function (CPU)
async function processRenderJob(jobId: string, params: RenderVideoRequest): Promise<void> {
  const supabase = getSupabase();
  let tempDir: string | null = null;

  try {
    const {
      projectId,
      audioUrl,
      imageUrls,
      imageTimings,
      srtContent,
      effects,
      introClips
    } = params;

    // Determine which effect to use (ken_burns takes priority, then smoke_embers, then embers)
    const effectType: EffectType = effects?.ken_burns
      ? 'ken_burns'
      : effects?.smoke_embers
        ? 'smoke_embers'
        : effects?.embers
          ? 'embers'
          : 'none';
    console.log(`Job ${jobId}: Starting render for project ${projectId}`);
    console.log(`Effects: ${effectType}, Images: ${imageUrls.length}`);

    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
    console.log(`Temp directory: ${tempDir}`);

    // Stage 1: Download files
    await updateJobStatus(supabase, jobId, 'downloading', 5, 'Downloading assets...');

    const audioPath = path.join(tempDir, 'voiceover.wav');
    await downloadFile(audioUrl, audioPath);
    console.log('Audio downloaded');

    // Check audio integrity before rendering
    const audioBuffer = fs.readFileSync(audioPath);
    const integrityResult = checkAudioIntegrity(audioBuffer, {
      silenceThresholdMs: 1500,
      glitchThresholdDb: 25,
      sampleWindowMs: 50,
    });
    logAudioIntegrity(integrityResult, `video render ${jobId}`);

    // Log warning if issues detected but continue rendering
    const audioIssues = integrityResult.issues.filter(i => i.type === 'skip' || i.type === 'discontinuity');
    if (audioIssues.length > 0) {
      console.warn(`[WARN] Audio has ${audioIssues.length} potential issues - video may have audio glitches`);
      audioIssues.slice(0, 3).forEach(issue => {
        console.warn(`[WARN]   ${issue.type} at ${issue.timestamp.toFixed(2)}s`);
      });
    }

    // Pre-encode WAV to AAC (makes muxing instant with -c:a copy)
    await updateJobStatus(supabase, jobId, 'downloading', 8, 'Encoding audio...');
    const audioAacPath = path.join(tempDir, 'voiceover.m4a');
    let lastAudioPct = 0;
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(audioPath)
        .outputOptions([
          '-c:a', 'aac',
          '-ar', '48000',
          '-b:a', '192k',
          '-threads', '0',  // Use all CPU cores
          '-y'
        ])
        .output(audioAacPath)
        .on('start', (cmd) => console.log('Audio encode:', cmd.substring(0, 100) + '...'))
        .on('progress', async (p) => {
          const pct = Math.round(p.percent || 0);
          if (pct > lastAudioPct + 5) { // Update every 5%
            console.log(`Audio encode: ${pct}%`);
            lastAudioPct = pct;
            // Update job status so frontend sees progress
            await updateJobStatus(supabase, jobId, 'downloading', 8, `Encoding audio... ${pct}%`);
          }
        })
        .on('error', reject)
        .on('end', () => {
          console.log('Audio pre-encoded to AAC (100%)');
          resolve();
        })
        .run();
    });

    // Download overlay(s) based on effect type
    const embersOverlayPath = path.join(tempDir, 'embers_overlay.mp4');
    const smokeOverlayPath = path.join(tempDir, 'smoke_overlay.mp4');
    let hasEmbersOverlay = false;
    let hasSmokeOverlay = false;

    if (effectType !== 'none') {
      // Always download embers for both 'embers' and 'smoke_embers' effects
      try {
        await downloadFile(EMBERS_OVERLAY_URL, embersOverlayPath);
        hasEmbersOverlay = true;
        console.log('Embers overlay downloaded');
      } catch (err) {
        console.warn('Failed to download embers overlay:', err);
      }

      // Download smoke overlay only for 'smoke_embers' effect
      if (effectType === 'smoke_embers') {
        try {
          await downloadFile(SMOKE_GRAY_OVERLAY_URL, smokeOverlayPath);
          hasSmokeOverlay = true;
          console.log('Smoke overlay downloaded');
        } catch (err) {
          console.warn('Failed to download smoke overlay:', err);
        }
      }
    }

    const imagePaths: string[] = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const filename = `image_${String(i + 1).padStart(3, '0')}.png`;
      const imagePath = path.join(tempDir, filename);
      await downloadFile(imageUrls[i], imagePath);
      imagePaths.push(imagePath);

      if (i % 10 === 0 || i === imageUrls.length - 1) {
        const downloadPercent = 5 + Math.round((i + 1) / imageUrls.length * 20);
        await updateJobStatus(supabase, jobId, 'downloading', downloadPercent, `Downloaded image ${i + 1}/${imageUrls.length}`);
      }
    }
    console.log('All images downloaded');

    // Download intro clips if any
    const introClipPaths: string[] = [];
    if (introClips && introClips.length > 0) {
      console.log(`Downloading ${introClips.length} intro clips...`);
      for (let i = 0; i < introClips.length; i++) {
        const clip = introClips[i];
        const clipPath = path.join(tempDir, `intro_clip_${i}.mp4`);
        try {
          await downloadFile(clip.url, clipPath);
          introClipPaths.push(clipPath);
          console.log(`Downloaded intro clip ${i + 1}/${introClips.length}`);
        } catch (err) {
          console.error(`Failed to download intro clip ${i}:`, err);
        }
      }
      console.log(`Downloaded ${introClipPaths.length} intro clips`);
    }

    fs.writeFileSync(path.join(tempDir, 'captions.srt'), srtContent, 'utf8');

    // Stage 2: Prepare chunks
    await updateJobStatus(supabase, jobId, 'rendering', 28, 'Preparing timeline...');

    const totalImages = imagePaths.length;
    const numChunks = Math.ceil(totalImages / IMAGES_PER_CHUNK);

    // Choose parallelism based on whether effects are enabled (effects are memory-intensive)
    const parallelChunks = effectType !== 'none' ? PARALLEL_CHUNK_RENDERS_WITH_EFFECTS : PARALLEL_CHUNK_RENDERS_NO_EFFECTS;
    console.log(`Processing ${totalImages} images in ${numChunks} chunk(s) (${parallelChunks} parallel, effects: ${effectType}, ${FFMPEG_PRESET} preset)`);

    interface ChunkData {
      index: number;
      concatPath: string;
      outputPath: string;
    }
    const chunkDataList: ChunkData[] = [];

    for (let chunkIndex = 0; chunkIndex < numChunks; chunkIndex++) {
      const chunkStart = chunkIndex * IMAGES_PER_CHUNK;
      const chunkEnd = Math.min((chunkIndex + 1) * IMAGES_PER_CHUNK, totalImages);
      const chunkImages = imagePaths.slice(chunkStart, chunkEnd);
      const chunkTimings = imageTimings.slice(chunkStart, chunkEnd);

      const concatContent = chunkImages.map((imgPath, i) => {
        const duration = chunkTimings[i].endSeconds - chunkTimings[i].startSeconds;
        const safeDuration = Math.max(duration, 0.1);
        return `file '${imgPath}'\nduration ${safeDuration.toFixed(3)}`;
      }).join('\n');

      const lastImagePath = chunkImages[chunkImages.length - 1];
      const concatFile = concatContent + `\nfile '${lastImagePath}'`;

      const concatPath = path.join(tempDir, `concat_chunk_${chunkIndex}.txt`);
      fs.writeFileSync(concatPath, concatFile, 'utf8');

      chunkDataList.push({
        index: chunkIndex,
        concatPath,
        outputPath: path.join(tempDir, `chunk_${chunkIndex}.mp4`)
      });
    }

    const chunkVideoPaths = chunkDataList.map(c => c.outputPath);

    // Check which overlays are available (not for ken_burns which is handled differently)
    const overlayAvailable = effectType !== 'none' && effectType !== 'ken_burns' && (hasEmbersOverlay || hasSmokeOverlay);
    const isKenBurns = effectType === 'ken_burns';

    // Progress tracking
    const progress: RenderProgress = {
      totalChunks: numChunks,
      chunksCompleted: 0,
      chunkProgress: new Map()
    };

    // Calculate overall render progress (30-70% range = 40% spread)
    const calculateOverallProgress = (): number => {
      let totalProgress = 0;
      for (let i = 0; i < numChunks; i++) {
        const chunkPct = progress.chunkProgress.get(i) || 0;
        totalProgress += chunkPct;
      }
      const avgProgress = totalProgress / numChunks;
      // Map 0-100 chunk progress to 30-70% overall progress
      return 30 + Math.round(avgProgress * 0.4);
    };

    // Throttle progress updates to avoid DB spam
    let lastProgressUpdate = 0;
    const updateProgressThrottled = async (message: string) => {
      const now = Date.now();
      if (now - lastProgressUpdate > 1000) {  // Max 1 update per second
        lastProgressUpdate = now;
        const pct = calculateOverallProgress();
        await updateJobStatus(supabase, jobId, 'rendering', pct, message);
      }
    };

    // Render chunk function
    const renderChunk = async (chunk: ChunkData): Promise<void> => {
      const chunkStart = chunk.index * IMAGES_PER_CHUNK;
      const chunkEnd = Math.min((chunk.index + 1) * IMAGES_PER_CHUNK, totalImages);
      const chunkTimingsSlice = imageTimings.slice(chunkStart, chunkEnd);
      const chunkImages = imagePaths.slice(chunkStart, chunkEnd);
      const chunkDuration = chunkTimingsSlice[chunkTimingsSlice.length - 1].endSeconds - chunkTimingsSlice[0].startSeconds;

      console.log(`Rendering chunk ${chunk.index + 1}/${numChunks} (${chunkDuration.toFixed(1)}s)`);
      progress.chunkProgress.set(chunk.index, 0);

      // Ken Burns: Render each image with zoom/pan effect (two clips per image: first half + second half)
      if (isKenBurns) {
        const clipPaths: string[] = [];
        const totalClips = chunkImages.length * 2;  // Two clips per image

        for (let i = 0; i < chunkImages.length; i++) {
          const imagePath = chunkImages[i];
          const globalImageIndex = chunkStart + i;  // Global index for alternating zoom/pan
          const duration = chunkTimingsSlice[i].endSeconds - chunkTimingsSlice[i].startSeconds;
          const halfDuration = duration / 2;
          const filters = getKenBurnsFilters(globalImageIndex, duration);

          // Render first half clip
          const clip1Path = path.join(tempDir!, `kb_${chunk.index}_${i}_1.mp4`);
          await new Promise<void>((resolve, reject) => {
            ffmpeg()
              .input(imagePath)
              .inputOptions(['-loop', '1'])
              .outputOptions([
                '-vf', filters.first,
                '-t', halfDuration.toString(),
                '-c:v', 'libx264',
                '-preset', FFMPEG_PRESET,
                '-crf', FFMPEG_CRF,
                '-pix_fmt', 'yuv420p',
                '-r', '30',
                '-y'
              ])
              .output(clip1Path)
              .on('error', reject)
              .on('end', () => resolve())
              .run();
          });
          clipPaths.push(clip1Path);

          // Render second half clip
          const clip2Path = path.join(tempDir!, `kb_${chunk.index}_${i}_2.mp4`);
          await new Promise<void>((resolve, reject) => {
            ffmpeg()
              .input(imagePath)
              .inputOptions(['-loop', '1'])
              .outputOptions([
                '-vf', filters.second,
                '-t', halfDuration.toString(),
                '-c:v', 'libx264',
                '-preset', FFMPEG_PRESET,
                '-crf', FFMPEG_CRF,
                '-pix_fmt', 'yuv420p',
                '-r', '30',
                '-y'
              ])
              .output(clip2Path)
              .on('error', reject)
              .on('end', () => resolve())
              .run();
          });
          clipPaths.push(clip2Path);

          // Update progress
          const clipProgress = ((i + 1) * 2 / totalClips) * 100;
          progress.chunkProgress.set(chunk.index, clipProgress);
          await updateProgressThrottled(`Ken Burns: chunk ${chunk.index + 1}, image ${i + 1}/${chunkImages.length}`);
        }

        // Concatenate all clips into chunk video
        const clipsConcatPath = path.join(tempDir!, `kb_concat_${chunk.index}.txt`);
        fs.writeFileSync(clipsConcatPath, clipPaths.map(p => `file '${p}'`).join('\n'), 'utf8');

        await new Promise<void>((resolve, reject) => {
          ffmpeg()
            .input(clipsConcatPath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .outputOptions(['-c', 'copy', '-y'])
            .output(chunk.outputPath)
            .on('error', reject)
            .on('end', () => resolve())
            .run();
        });

        // Cleanup clip files
        for (const clipPath of clipPaths) {
          try { fs.unlinkSync(clipPath); } catch (e) { /* ignore */ }
        }
        try { fs.unlinkSync(clipsConcatPath); } catch (e) { /* ignore */ }

        progress.chunkProgress.set(chunk.index, 100);
        progress.chunksCompleted++;
        console.log(`Chunk ${chunk.index + 1} Ken Burns complete (${progress.chunksCompleted}/${numChunks})`);
        return;
      }

      const rawChunkPath = path.join(tempDir!, `chunk_raw_${chunk.index}.mp4`);

      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(chunk.concatPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions([
            '-threads', '2',  // Limit threads to reduce memory (was 0 = all cores)
            '-c:v', 'libx264',
            '-preset', FFMPEG_PRESET,
            '-crf', FFMPEG_CRF,
            '-pix_fmt', 'yuv420p',
            '-bufsize', '512k',  // Limit frame buffering
            '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1',
            '-y'
          ])
          .output(rawChunkPath)
          .on('start', (cmd) => {
            console.log(`Chunk ${chunk.index + 1} Pass 1:`, cmd.substring(0, 120) + '...');
          })
          .on('progress', (p) => {
            // Pass 1 is 0-50% of chunk progress (Pass 2 with overlay is 50-100%)
            const pass1Pct = overlayAvailable ? Math.min(p.percent || 0, 100) * 0.5 : Math.min(p.percent || 0, 100);
            progress.chunkProgress.set(chunk.index, pass1Pct);
            updateProgressThrottled(`Rendering chunk ${chunk.index + 1}/${numChunks} (${Math.round(pass1Pct)}%)`);
          })
          .on('error', reject)
          .on('end', () => {
            console.log(`Chunk ${chunk.index + 1} Pass 1 complete`);
            progress.chunkProgress.set(chunk.index, overlayAvailable ? 50 : 100);
            resolve();
          })
          .run();
      });

      if (overlayAvailable) {
        try {
          const overlayLoopCount = Math.ceil(chunkDuration / OVERLAY_SOURCE_DURATION) + 1;

          // Create concat files for looping overlays
          const smokeLoopPath = path.join(tempDir!, `smoke_concat_${chunk.index}.txt`);
          const embersLoopPath = path.join(tempDir!, `embers_concat_${chunk.index}.txt`);

          if (hasSmokeOverlay) {
            fs.writeFileSync(smokeLoopPath, Array(overlayLoopCount).fill(`file '${smokeOverlayPath}'`).join('\n'), 'utf8');
          }
          if (hasEmbersOverlay) {
            fs.writeFileSync(embersLoopPath, Array(overlayLoopCount).fill(`file '${embersOverlayPath}'`).join('\n'), 'utf8');
          }

          await new Promise<void>((resolve, reject) => {
            const cmd = ffmpeg().input(rawChunkPath);

            // Build filter chain based on available overlays
            let filterChain: string[];

            if (hasSmokeOverlay && hasEmbersOverlay) {
              // Both smoke and embers: smoke (multiply grayscale) + embers (colorkey)
              // Note: flags=full_chroma_int+accurate_rnd fixes green tint on Linux ffmpeg-static
              cmd.input(smokeLoopPath).inputOptions(['-f', 'concat', '-safe', '0']);
              cmd.input(embersLoopPath).inputOptions(['-f', 'concat', '-safe', '0']);
              filterChain = [
                // Scale base video with accurate color conversion flags
                '[0:v]scale=1920:1080:flags=full_chroma_int+accurate_rnd[base]',
                // Smoke: convert to grayscale, multiply blend for darkening effect
                '[1:v]scale=1920:1080:flags=full_chroma_int+accurate_rnd,colorchannelmixer=.3:.59:.11:0:.3:.59:.11:0:.3:.59:.11:0[smoke_gray]',
                '[base][smoke_gray]blend=all_mode=multiply[with_smoke]',
                // Embers: colorkey to remove black, overlay on top
                '[2:v]scale=1920:1080,colorkey=black:similarity=0.2:blend=0.2[embers_keyed]',
                '[with_smoke][embers_keyed]overlay=0:0:shortest=1[out]'
              ];
            } else if (hasEmbersOverlay) {
              // Embers only: colorkey overlay
              cmd.input(embersLoopPath).inputOptions(['-f', 'concat', '-safe', '0']);
              filterChain = [
                '[1:v]scale=1920:1080,colorkey=black:similarity=0.2:blend=0.2[embers_keyed]',
                '[0:v][embers_keyed]overlay=0:0:shortest=1[out]'
              ];
            } else {
              // Smoke only (shouldn't happen with current logic, but handle it)
              // Note: flags=full_chroma_int+accurate_rnd fixes green tint on Linux ffmpeg-static
              cmd.input(smokeLoopPath).inputOptions(['-f', 'concat', '-safe', '0']);
              filterChain = [
                '[0:v]scale=1920:1080:flags=full_chroma_int+accurate_rnd[base]',
                '[1:v]scale=1920:1080:flags=full_chroma_int+accurate_rnd,colorchannelmixer=.3:.59:.11:0:.3:.59:.11:0:.3:.59:.11:0[smoke_gray]',
                '[base][smoke_gray]blend=all_mode=multiply[out]'
              ];
            }

            // Log the filter chain for debugging
            console.log(`[Chunk ${chunk.index}] Filter chain:`, filterChain.join('; '));

            cmd
              .complexFilter(filterChain)
              .outputOptions([
                '-map', '[out]',
                '-c:v', 'libx264',
                '-preset', 'faster',  // Use faster preset for overlay pass (less memory)
                '-crf', FFMPEG_CRF,
                '-pix_fmt', 'yuv420p',
                '-filter_complex_threads', '1',  // Serialize filter execution
                '-threads', '2',  // Limit encoding threads
                '-bufsize', '512k',  // Limit frame buffering
                '-y'
              ])
              .output(chunk.outputPath)
              .on('start', (cmdLine) => {
                console.log(`[Chunk ${chunk.index}] FFmpeg command:`, cmdLine);
              })
              .on('progress', (p) => {
                // Pass 2 is 50-100% of chunk progress
                const pass2Pct = 50 + Math.min(p.percent || 0, 100) * 0.5;
                progress.chunkProgress.set(chunk.index, pass2Pct);
                updateProgressThrottled(`Adding effects to chunk ${chunk.index + 1}/${numChunks}`);
              })
              .on('error', reject)
              .on('end', () => {
                try { fs.unlinkSync(rawChunkPath); } catch (e) { console.warn(`[Chunk ${chunk.index}] Failed to remove raw chunk`, e); }
                try { fs.unlinkSync(smokeLoopPath); } catch (e) { console.warn(`[Chunk ${chunk.index}] Failed to remove smoke loop`, e); }
                try { fs.unlinkSync(embersLoopPath); } catch (e) { console.warn(`[Chunk ${chunk.index}] Failed to remove embers loop`, e); }
                progress.chunkProgress.set(chunk.index, 100);
                resolve();
              })
              .run();
          });
        } catch (err) {
          console.error(`Chunk ${chunk.index + 1} overlay effect failed:`, err);
          if (fs.existsSync(rawChunkPath)) {
            fs.renameSync(rawChunkPath, chunk.outputPath);
          }
        }
      } else {
        fs.renameSync(rawChunkPath, chunk.outputPath);
        progress.chunkProgress.set(chunk.index, 100);
      }

      progress.chunksCompleted++;
      const pct = calculateOverallProgress();
      await updateJobStatus(supabase, jobId, 'rendering', pct, `Rendered ${progress.chunksCompleted}/${numChunks} chunks`);
      console.log(`Chunk ${chunk.index + 1} fully complete (${progress.chunksCompleted}/${numChunks})`);
    };

    // Render chunks in parallel batches
    await updateJobStatus(supabase, jobId, 'rendering', 30, `Rendering ${numChunks} chunks...`);

    for (let i = 0; i < chunkDataList.length; i += parallelChunks) {
      const batch = chunkDataList.slice(i, i + parallelChunks);
      console.log(`Starting batch: chunks ${batch.map(c => c.index + 1).join(', ')}`);
      await Promise.all(batch.map(chunk => renderChunk(chunk)));
    }

    // Stage 3: Re-encode intro clips to match chunk format (if any)
    const reEncodedIntroPaths: string[] = [];
    if (introClipPaths.length > 0) {
      await updateJobStatus(supabase, jobId, 'muxing', 70, 'Re-encoding intro clips...');
      for (let i = 0; i < introClipPaths.length; i++) {
        const introPath = introClipPaths[i];
        const reEncodedPath = path.join(tempDir!, `intro_reencoded_${i}.mp4`);
        await new Promise<void>((resolve, reject) => {
          ffmpeg()
            .input(introPath)
            .outputOptions([
              '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
              '-c:v', 'libx264',
              '-preset', FFMPEG_PRESET,
              '-crf', FFMPEG_CRF,
              '-pix_fmt', 'yuv420p',
              '-r', '30',
              '-an',  // Remove audio from intro clips (we'll add voiceover later)
              '-y'
            ])
            .output(reEncodedPath)
            .on('error', reject)
            .on('end', () => resolve())
            .run();
        });
        reEncodedIntroPaths.push(reEncodedPath);
        console.log(`Re-encoded intro clip ${i + 1}/${introClipPaths.length}`);
      }
    }

    // Stage 4: Concatenate intro clips + chunks
    await updateJobStatus(supabase, jobId, 'muxing', 72, 'Joining video segments...');

    // Combine intro clips (at start) + image chunks
    const allVideoPaths = [...reEncodedIntroPaths, ...chunkVideoPaths];
    const chunksListPath = path.join(tempDir, 'chunks_list.txt');
    fs.writeFileSync(chunksListPath, allVideoPaths.map(p => `file '${p}'`).join('\n'), 'utf8');
    console.log(`Concatenating ${reEncodedIntroPaths.length} intro clips + ${chunkVideoPaths.length} image chunks`);

    const concatenatedPath = path.join(tempDir, 'concatenated.mp4');

    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(chunksListPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c', 'copy', '-y'])
        .output(concatenatedPath)
        .on('error', reject)
        .on('end', () => {
          console.log('Video concatenation complete');
          resolve();
        })
        .run();
    });

    // Stage 4: Add audio
    await updateJobStatus(supabase, jobId, 'muxing', 75, 'Adding audio...');

    const withAudioPath = path.join(tempDir, 'with_audio.mp4');

    // Mux is instant since audio is pre-encoded (-c:a copy)
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(concatenatedPath)
        .input(audioAacPath)
        .outputOptions([
          '-c:v', 'copy',
          '-c:a', 'copy',
          '-shortest',
          '-y'
        ])
        .output(withAudioPath)
        .on('start', (cmd) => {
          console.log('Audio mux (copy):', cmd.substring(0, 100) + '...');
        })
        .on('error', reject)
        .on('end', () => {
          console.log('Audio muxed successfully');
          resolve();
        })
        .run();
    });

    const withAudioStats = fs.statSync(withAudioPath);
    console.log(`Video with audio: ${(withAudioStats.size / 1024 / 1024).toFixed(2)} MB`);

    if (withAudioStats.size === 0) {
      throw new Error('FFmpeg produced empty video file');
    }

    // Stage 5: Scrub metadata (after effects are applied)
    await updateJobStatus(supabase, jobId, 'muxing', 78, 'Scrubbing metadata...');

    const finalPath = path.join(tempDir, 'final.mp4');
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(withAudioPath)
        .outputOptions([
          '-map_metadata', '-1',
          '-fflags', '+bitexact',
          '-flags:v', '+bitexact',
          '-flags:a', '+bitexact',
          '-c:v', 'copy',
          '-c:a', 'copy',
          '-movflags', '+faststart',
          '-y'
        ])
        .output(finalPath)
        .on('start', (cmd) => console.log('Metadata scrub:', cmd.substring(0, 100) + '...'))
        .on('error', (err) => {
          // If scrub fails, use the with-audio version
          console.warn('Metadata scrub failed, using original:', err.message);
          fs.copyFileSync(withAudioPath, finalPath);
          resolve();
        })
        .on('end', () => {
          console.log('Metadata scrubbed');
          resolve();
        })
        .run();
    });

    // Stage 6: Upload using streaming to avoid memory issues with large files
    await updateJobStatus(supabase, jobId, 'uploading', 80, 'Uploading video...');

    const videoUploadPath = `${params.projectId}/video.mp4`;
    const fileStats = fs.statSync(finalPath);
    const fileSizeBytes = fileStats.size;
    const uploadSizeMB = (fileSizeBytes / 1024 / 1024).toFixed(1);
    console.log(`Uploading ${uploadSizeMB} MB video...`);

    // Delete any existing file first
    await supabase.storage.from('generated-assets').remove([videoUploadPath]);

    // Use direct REST API upload with streaming for memory efficiency
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase credentials not configured');
    }

    // Stream upload using fetch with file stream + progress tracking
    const uploadUrl = `${supabaseUrl}/storage/v1/object/generated-assets/${videoUploadPath}`;
    const fileStream = fs.createReadStream(finalPath);

    // Track upload progress
    let bytesUploaded = 0;
    let lastUploadProgressUpdate = 0;
    fileStream.on('data', async (chunk: Buffer | string) => {
      const chunkLength = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      bytesUploaded += chunkLength;
      const now = Date.now();
      if (now - lastUploadProgressUpdate > 2000) {  // Update every 2 seconds
        lastUploadProgressUpdate = now;
        const uploadPct = Math.round((bytesUploaded / fileSizeBytes) * 100);
        // Map upload progress to 80-98% overall
        const overallPct = 80 + Math.round(uploadPct * 0.18);
        const mbUploaded = (bytesUploaded / 1024 / 1024).toFixed(1);
        await updateJobStatus(supabase, jobId, 'uploading', overallPct, `Uploading ${mbUploaded}/${uploadSizeMB} MB`);
      }
    });

    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'video/mp4',
        'Content-Length': fileSizeBytes.toString(),
        'x-upsert': 'true',
      },
      body: fileStream as any,
      // @ts-expect-error duplex is needed for streaming
      duplex: 'half',
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Failed to upload video: ${uploadResponse.status} - ${errorText}`);
    }

    console.log(`Video uploaded successfully via streaming`)

    const { data: urlData } = supabase.storage
      .from('generated-assets')
      .getPublicUrl(videoUploadPath);

    const videoUrl = urlData.publicUrl;
    console.log(`Video uploaded: ${videoUrl}`);

    // Complete!
    await updateJobStatus(supabase, jobId, 'complete', 100, 'Video rendering complete!', { video_url: videoUrl });
    await updateProjectVideoUrl(supabase, params.projectId, videoUrl, params.effects);

  } catch (error: any) {
    console.error(`Job ${jobId} failed:`, error);
    await updateJobStatus(supabase, jobId, 'failed', 0, 'Render failed', { error: error.message || 'Unknown error' });
  } finally {
    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log('Temp directory cleaned up');
      } catch (cleanupError) {
        console.error('Failed to clean up temp directory:', cleanupError);
      }
    }
  }
}

// POST /render-video - Start a new render job
router.post('/', async (req: Request, res: Response) => {
  try {
    const params = req.body as RenderVideoRequest;

    // Validate input
    if (!params.projectId || !params.audioUrl || !params.imageUrls || params.imageUrls.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!params.imageTimings || params.imageTimings.length !== params.imageUrls.length) {
      return res.status(400).json({ error: 'Image timings must match image count' });
    }

    try {
      assertAllowedAssetUrl(params.audioUrl, 'audioUrl');
      params.imageUrls.forEach((url, index) => assertAllowedAssetUrl(url, `imageUrls[${index}]`));
      params.introClips?.forEach((clip, index) => assertAllowedAssetUrl(clip.url, `introClips[${index}]`));
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid asset URL' });
    }

    const supabase = getSupabase();

    // Create job in database
    const jobId = randomUUID();
    const { error: insertError } = await supabase
      .from('render_jobs')
      .insert({
        id: jobId,
        project_id: params.projectId,
        status: 'queued',
        progress: 0,
        message: 'Job queued'
      });

    if (insertError) {
      console.error('Failed to create job:', insertError);
      return res.status(500).json({ error: 'Failed to create render job' });
    }

    console.log(`Created render job ${jobId} for project ${params.projectId}`);

    // Determine rendering strategy
    const imageCount = params.imageUrls.length;
    const isKenBurns = params.effects?.ken_burns === true;
    const hasGpuEndpoint = !!RUNPOD_VIDEO_ENDPOINT_ID && !!RUNPOD_API_KEY;

    // Ken Burns is GPU-intensive - use GPU if available, otherwise fall back to CPU
    if (isKenBurns && hasGpuEndpoint) {
      console.log(`Job ${jobId}: Using GPU rendering for Ken Burns (${imageCount} images)`);
      processRenderJobGpu(jobId, params).catch(err => {
        console.error(`GPU render job ${jobId} crashed:`, err);
      });
    } else if (isKenBurns) {
      // No GPU configured - fall back to Railway CPU (slower)
      console.log(`Job ${jobId}: Using RAILWAY CPU rendering for Ken Burns (${imageCount} images) - no GPU configured`);
      processRenderJob(jobId, params).catch(err => {
        console.error(`Railway CPU render job ${jobId} crashed:`, err);
      });
    } else if (imageCount >= 5) {
      // Use parallel mode for efficiency (10 workers render chunks simultaneously)
      console.log(`Job ${jobId}: Using PARALLEL rendering (${PARALLEL_WORKERS} workers)`);
      processRenderJobParallel(jobId, params).catch(err => {
        console.error(`Parallel render job ${jobId} crashed:`, err);
      });
    } else {
      console.log(`Job ${jobId}: Using single CPU job (${imageCount} images)`);
      processRenderJobCpuRunpod(jobId, params).catch(err => {
        console.error(`CPU RunPod render job ${jobId} crashed:`, err);
      });
    }

    // Return immediately with job ID
    res.json({
      success: true,
      jobId,
      status: 'queued',
      message: 'Render job started. Poll /render-video/status/:jobId for progress.'
    });

  } catch (error: any) {
    console.error('Error starting render job:', error);
    res.status(500).json({ error: error.message || 'Failed to start render job' });
  }
});

// GET /render-video/status/:jobId - Poll job status
router.get('/status/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    if (!jobId) {
      return res.status(400).json({ error: 'Job ID required' });
    }

    const supabase = getSupabase();

    const { data: job, error } = await supabase
      .from('render_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (error || !job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json(job);

  } catch (error: any) {
    console.error('Error fetching job status:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch job status' });
  }
});

export default router;
