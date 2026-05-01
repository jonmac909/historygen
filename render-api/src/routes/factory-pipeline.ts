/**
 * Factory Pipeline Route
 *
 * Orchestrates running up to 5 projects through pipeline steps in batches.
 * Each batch covers a phase of the pipeline:
 *   Batch 1: Script generation
 *   Batch 2: Media (audio, captions, image prompts, images)
 *   Batch 3: Clips (clip prompts, video clips)
 *   Batch 4: Render final video
 *
 * Progress is streamed via SSE events. Batches can be cancelled or
 * individual projects skipped mid-run.
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  createProject,
  updateProject,
  getSupabaseClient,
  getProjectData,
  createFactoryBatch,
  updateFactoryBatch,
  getFactoryBatch,
  FactoryBatch,
} from '../lib/supabase-project';
import {
  cleanScript,
  insertSubscribeCTA,
  gradeScript,
  COMPLETE_HISTORIES_TEMPLATE,
} from '../lib/pipeline-runner';

const DEFAULT_VOICE_SAMPLE = 'https://autoaigen.com/voices/clone_voice.wav';

const router = Router();

// ---------------------------------------------------------------------------
// In-memory tracking for running batches
// ---------------------------------------------------------------------------

const runningBatches = new Map<string, {
  aborted: boolean;
  controller: AbortController;
  currentStep: string;
  skippedProjects: Set<string>;
}>();

// ---------------------------------------------------------------------------
// Internal API helpers (copied from full-pipeline.ts, with AbortSignal support)
// ---------------------------------------------------------------------------

const getInternalApiUrl = () => {
  const port = process.env.PORT || '3000';
  return `http://localhost:${port}`;
};

const getInternalApiKey = () => process.env.INTERNAL_API_KEY || '';

/**
 * Make an internal API call to another route
 */
async function callInternalApi<T>(
  endpoint: string,
  body: Record<string, unknown>,
  timeout: number = 600000,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  // Abort our controller if the external signal fires
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

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
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * Make an internal API call using SSE streaming mode.
 * Properly reads the SSE stream and extracts the final result.
 */
async function callStreamingApi<T>(
  endpoint: string,
  body: Record<string, unknown>,
  timeout: number = 1800000,
  externalSignal?: AbortSignal,
  onProgress?: (percent: number) => void,
  onToken?: (text: string) => void,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const HEARTBEAT_INTERVAL_MS = 30000;
  let heartbeatInterval: NodeJS.Timeout | null = null;
  let lastActivityTime = Date.now();
  let eventCount = 0;

  try {
    console.log(`[Factory] Calling ${endpoint} with streaming (timeout: ${timeout / 1000}s)...`);

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

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body reader available');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let lastResult: T | null = null;
    let lastProgress = 0;

    heartbeatInterval = setInterval(() => {
      const waitTime = Math.round((Date.now() - lastActivityTime) / 1000);
      console.log(`[Factory] ${endpoint} still waiting... (${waitTime}s since last activity, ${eventCount} events received)`);
    }, HEARTBEAT_INTERVAL_MS);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      lastActivityTime = Date.now();
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            eventCount++;

            if (data.progress && data.progress > lastProgress) {
              lastProgress = data.progress;
              if (onProgress) onProgress(data.progress);
            }

            if (data.type === 'token' && data.text && onToken) {
              onToken(data.text);
            }

            if (data.type === 'keepalive') {
              console.log(`[Factory] ${endpoint} keepalive received`);
            }

            if (data.type === 'complete' || data.success === true) {
              lastResult = data as T;
            }

            if (data.type === 'error' || data.error) {
              throw new Error(data.error || 'Stream error');
            }
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) continue;
            throw parseErr;
          }
        }
      }
    }

    if (!lastResult) {
      throw new Error(`No complete response received from ${endpoint}`);
    }

    console.log(`[Factory] ${endpoint} completed successfully (${eventCount} events)`);
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
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * Make an internal API call for operations that don't support streaming.
 */
async function callNonStreamingApi<T>(
  endpoint: string,
  body: Record<string, unknown>,
  timeout: number = 300000,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    console.log(`[Factory] Calling ${endpoint} (non-streaming, timeout: ${timeout / 1000}s)...`);

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
    console.log(`[Factory] ${endpoint} completed successfully`);
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`API call to ${endpoint} timed out after ${timeout / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// Abort / skip helpers
// ---------------------------------------------------------------------------

function shouldAbort(batchId: string): boolean {
  const state = runningBatches.get(batchId);
  return state?.aborted === true;
}

function isSkipped(batchId: string, projectId: string): boolean {
  const state = runningBatches.get(batchId);
  return state?.skippedProjects.has(projectId) === true;
}

// ---------------------------------------------------------------------------
// Stale batch cleanup on module load
// ---------------------------------------------------------------------------

async function cleanupStaleRunningBatches() {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.log('[Factory Cleanup] Supabase not configured, skipping cleanup');
    return;
  }

  try {
    const { data: staleBatches, error: fetchError } = await supabase
      .from('factory_batches')
      .select('id, status, current_step')
      .like('status', '%_running');

    if (fetchError) {
      console.error('[Factory Cleanup] Failed to fetch stale batches:', fetchError);
      return;
    }

    if (!staleBatches || staleBatches.length === 0) {
      console.log('[Factory Cleanup] No stale running batches found');
      return;
    }

    console.log(`[Factory Cleanup] Found ${staleBatches.length} stale "running" batches from previous session:`);
    staleBatches.forEach(b => {
      console.log(`   - ${b.id.slice(0, 8)}: status=${b.status}, step=${b.current_step}`);
    });

    for (const batch of staleBatches) {
      const { error: updateError } = await supabase
        .from('factory_batches')
        .update({
          status: 'cancelled',
          current_step: 'server_restart',
          updated_at: new Date().toISOString(),
        })
        .eq('id', batch.id);

      if (updateError) {
        console.error(`[Factory Cleanup] Failed to update batch ${batch.id}:`, updateError);
      }
    }

    console.log(`[Factory Cleanup] Marked ${staleBatches.length} stale batches as 'cancelled' (server_restart)`);
  } catch (err) {
    console.error('[Factory Cleanup] Unexpected error:', err);
  }
}

cleanupStaleRunningBatches();

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

interface SSEProgressEvent {
  type: 'progress';
  batch: number;
  step: string;
  projectIndex: number;
  projectId: string;
  status: 'running' | 'done' | 'failed';
  error?: string;
  progress?: number;
}

interface SSEBatchCompleteEvent {
  type: 'batch_complete';
  batch: number;
  subStep?: string;
}

interface SSEErrorEvent {
  type: 'error';
  message: string;
}

interface SSEScriptTokenEvent {
  type: 'script_token';
  projectId: string;
  text: string;
}

type SSEEvent = SSEProgressEvent | SSEBatchCompleteEvent | SSEErrorEvent | SSEScriptTokenEvent;

function writeSseEvent(res: Response, event: SSEEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ---------------------------------------------------------------------------
// Timeouts (milliseconds)
// ---------------------------------------------------------------------------

const TIMEOUT = {
  TRANSCRIPT: 120000,        // 2 min
  SCRIPT: 3600000,           // 60 min
  AUDIO: 7200000,            // 2 hours
  CAPTIONS: 300000,          // 5 min
  IMAGE_PROMPTS: 1800000,    // 30 min
  IMAGES: 10800000,          // 3 hours
  CLIP_PROMPTS: 600000,      // 10 min
  VIDEO_CLIPS: 7200000,      // 2 hours
  RENDER: 14400000,          // 4 hours
} as const;

// ---------------------------------------------------------------------------
// Batch execution
// ---------------------------------------------------------------------------

async function executeBatch(
  batchId: string,
  batchNumber: number,
  res: Response,
  subStep?: string,
): Promise<void> {
  const batchData = await getFactoryBatch(batchId);
  if (!batchData) {
    writeSseEvent(res, { type: 'error', message: 'Batch not found' });
    return;
  }

  const { project_ids: projectIds, settings, step_statuses: stepStatuses, project_statuses: projectStatuses } = batchData;
  const signal = runningBatches.get(batchId)?.controller.signal;

  // Keepalive interval
  const keepaliveInterval = setInterval(() => {
    res.write(`: keepalive\n\n`);
  }, 30000);

  try {
    await updateFactoryBatch(batchId, {
      status: `batch${batchNumber}_running`,
      current_batch: batchNumber,
    });

    switch (batchNumber) {
      case 1:
        await executeBatch1Script(batchId, projectIds, settings, stepStatuses, projectStatuses, res, signal);
        break;
      case 2:
        await executeBatch2SubStep(batchId, projectIds, settings, stepStatuses, projectStatuses, res, signal, subStep || 'all');
        break;
      case 3:
        await executeBatch3Clips(batchId, projectIds, settings, stepStatuses, projectStatuses, res, signal);
        break;
      case 4:
        await executeBatch4Render(batchId, projectIds, settings, stepStatuses, projectStatuses, res, signal);
        break;
      default:
        writeSseEvent(res, { type: 'error', message: `Invalid batch number: ${batchNumber}` });
        return;
    }

    const reviewStatus = (batchNumber === 2 && subStep)
      ? `batch2_${subStep}_review`
      : `batch${batchNumber}_review`;

    await updateFactoryBatch(batchId, {
      status: reviewStatus,
      current_batch: batchNumber,
      step_statuses: stepStatuses,
      project_statuses: projectStatuses,
    });

    writeSseEvent(res, { type: 'batch_complete', batch: batchNumber, subStep: subStep || undefined });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Factory ${batchId}] Batch ${batchNumber} error:`, message);
    writeSseEvent(res, { type: 'error', message });

    await updateFactoryBatch(batchId, {
      status: `batch${batchNumber}_failed`,
      step_statuses: stepStatuses,
      project_statuses: projectStatuses,
    });
  } finally {
    clearInterval(keepaliveInterval);
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Helper: check if a project should be processed
// ---------------------------------------------------------------------------

function shouldProcessProject(
  batchId: string,
  projectId: string,
  projectStatuses: Record<string, { status: string; failedAtStep?: string; error?: string }>,
): boolean {
  if (shouldAbort(batchId)) return false;
  if (isSkipped(batchId, projectId)) return false;
  const ps = projectStatuses[projectId];
  if (ps && (ps.status === 'failed' || ps.status === 'skipped')) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Batch 1 — Script
// ---------------------------------------------------------------------------

async function executeBatch1Script(
  batchId: string,
  projectIds: string[],
  settings: Record<string, any>,
  stepStatuses: Record<string, Record<string, string>>,
  projectStatuses: Record<string, { status: string; failedAtStep?: string; error?: string }>,
  res: Response,
  signal?: AbortSignal,
): Promise<void> {
  for (let i = 0; i < projectIds.length; i++) {
    const projectId = projectIds[i];

    if (!shouldProcessProject(batchId, projectId, projectStatuses)) continue;
    if (shouldAbort(batchId)) return;

    const projectData = await getProjectData(projectId);

    // --- Transcript ---
    writeSseEvent(res, { type: 'progress', batch: 1, step: 'transcript', projectIndex: i, projectId, status: 'running' });
    stepStatuses[projectId].transcript = 'running';
    await updateFactoryBatch(batchId, { current_step: 'transcript', current_project_index: i, step_statuses: stepStatuses });

    try {
      let videoTitle = projectData.videoTitle || '';

      // If the project has a URL (not direct script), fetch transcript
      if (projectData.settings?.sourceUrl && projectData.settings.sourceUrl !== 'direct_script') {
        const transcriptResult = await callInternalApi<{
          success: boolean;
          transcript?: string;
          title?: string;
          error?: string;
        }>('/get-youtube-transcript', { url: projectData.settings.sourceUrl }, TIMEOUT.TRANSCRIPT, signal);

        if (!transcriptResult.success || !transcriptResult.transcript) {
          throw new Error(transcriptResult.error || 'Failed to get transcript');
        }

        const youtubeTitle = transcriptResult.title || '';
        const isPlaceholderTitle = (t: string) =>
          !t || /^(unknown title|untitled|project \d+)$/i.test(t.trim());
        const usableYoutubeTitle = isPlaceholderTitle(youtubeTitle) ? '' : youtubeTitle;
        videoTitle = usableYoutubeTitle || (isPlaceholderTitle(videoTitle) ? 'Historical Documentary' : videoTitle);
        await updateProject(projectId, { video_title: videoTitle });

        stepStatuses[projectId].transcript = 'done';
        writeSseEvent(res, { type: 'progress', batch: 1, step: 'transcript', projectIndex: i, projectId, status: 'done' });

        // --- Script ---
        if (!projectData.script) {
          if (shouldAbort(batchId)) return;

          writeSseEvent(res, { type: 'progress', batch: 1, step: 'script', projectIndex: i, projectId, status: 'running' });
          stepStatuses[projectId].script = 'running';
          await updateFactoryBatch(batchId, { current_step: 'script', step_statuses: stepStatuses });

          const scriptTopic = settings.topic || usableYoutubeTitle || videoTitle;

          const scriptResult = await callStreamingApi<{
            success?: boolean;
            type?: string;
            script?: string;
            wordCount?: number;
            error?: string;
          }>('/rewrite-script', {
            transcript: transcriptResult.transcript,
            template: settings.scriptTemplate || COMPLETE_HISTORIES_TEMPLATE,
            title: videoTitle,
            topic: scriptTopic,
            wordCount: settings.wordCount || 3000,
            model: settings.aiModel || 'claude-sonnet-4-6',
            projectId,
            expandWith: settings.expandWith,
            stream: true,
          }, TIMEOUT.SCRIPT, signal, (pct) => {
            writeSseEvent(res, { type: 'progress', batch: 1, step: 'script', projectIndex: i, projectId, status: 'running', progress: Math.min(pct, 99) });
          }, (text) => {
            writeSseEvent(res, { type: 'script_token', projectId, text });
          });

          if (!scriptResult.script) {
            throw new Error(scriptResult.error || 'Failed to generate script');
          }

          let script = cleanScript(scriptResult.script);
          script = insertSubscribeCTA(script);

          // Grade script — retry up to 3 times if grade is C
          const apiKey = process.env.ANTHROPIC_API_KEY || '';
          let gradeResult = await gradeScript(script, settings.topic || videoTitle, apiKey);
          let retries = 0;
          while (gradeResult.grade === 'C' && retries < 3) {
            retries++;
            console.log(`[Factory ${batchId}] Script grade C for project ${projectId}, retry ${retries}/3`);

            const retryResult = await callStreamingApi<{
              success?: boolean;
              type?: string;
              script?: string;
              error?: string;
            }>('/rewrite-script', {
              transcript: transcriptResult.transcript,
              template: settings.scriptTemplate || COMPLETE_HISTORIES_TEMPLATE,
              title: videoTitle,
              topic: scriptTopic,
              wordCount: settings.wordCount || 3000,
              model: settings.aiModel || 'claude-sonnet-4-6',
              projectId,
              expandWith: settings.expandWith,
              stream: true,
            }, TIMEOUT.SCRIPT, signal, (pct) => {
              writeSseEvent(res, { type: 'progress', batch: 1, step: 'script', projectIndex: i, projectId, status: 'running', progress: Math.min(pct, 99) });
            }, (text) => {
              writeSseEvent(res, { type: 'script_token', projectId, text });
            });

            if (retryResult.script) {
              script = cleanScript(retryResult.script);
              script = insertSubscribeCTA(script);
              gradeResult = await gradeScript(script, scriptTopic, apiKey);
            } else {
              break;
            }
          }

          console.log(`[Factory ${batchId}] Script grade ${gradeResult.grade} for project ${projectId} (${retries} retries)`);
          await updateProject(projectId, { script_content: script });

          stepStatuses[projectId].script = 'done';
          writeSseEvent(res, { type: 'progress', batch: 1, step: 'script', projectIndex: i, projectId, status: 'done' });
        } else {
          stepStatuses[projectId].script = 'done';
          writeSseEvent(res, { type: 'progress', batch: 1, step: 'script', projectIndex: i, projectId, status: 'done' });
        }
      } else {
        // Direct script — no transcript needed
        stepStatuses[projectId].transcript = 'done';
        writeSseEvent(res, { type: 'progress', batch: 1, step: 'transcript', projectIndex: i, projectId, status: 'done' });

        if (!projectData.script) {
          stepStatuses[projectId].script = 'done';
          writeSseEvent(res, { type: 'progress', batch: 1, step: 'script', projectIndex: i, projectId, status: 'done' });
        } else {
          let script = cleanScript(projectData.script);
          script = insertSubscribeCTA(script);
          await updateProject(projectId, { script_content: script });
          console.log(`[Factory ${batchId}] Cleaned pasted script for project ${projectId}: ${script.split(/\s+/).length} words`);
          stepStatuses[projectId].script = 'done';
          writeSseEvent(res, { type: 'progress', batch: 1, step: 'script', projectIndex: i, projectId, status: 'done' });
        }
      }

      await updateFactoryBatch(batchId, { step_statuses: stepStatuses, project_statuses: projectStatuses });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Factory ${batchId}] Project ${projectId} script failed:`, errorMessage);

      projectStatuses[projectId] = { status: 'failed', failedAtStep: 'script', error: errorMessage };
      stepStatuses[projectId].script = 'failed';

      writeSseEvent(res, { type: 'progress', batch: 1, step: 'script', projectIndex: i, projectId, status: 'failed', error: errorMessage });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses, project_statuses: projectStatuses });
    }
  }
}

// ---------------------------------------------------------------------------
// Batch 2 — Media (audio, captions, image prompts, images)
// ---------------------------------------------------------------------------

async function executeBatch2SubStep(
  batchId: string,
  projectIds: string[],
  settings: Record<string, any>,
  stepStatuses: Record<string, Record<string, string>>,
  projectStatuses: Record<string, { status: string; failedAtStep?: string; error?: string }>,
  res: Response,
  signal?: AbortSignal,
  subStep: string = 'all',
): Promise<void> {
  const steps = subStep === 'all'
    ? ['audio', 'captions', 'image_prompts', 'images']
    : [subStep];

  for (const step of steps) {
    switch (step) {
      case 'audio':
        await executeBatch2Audio(batchId, projectIds, settings, stepStatuses, projectStatuses, res, signal);
        break;
      case 'captions':
        await executeBatch2Captions(batchId, projectIds, stepStatuses, projectStatuses, res, signal);
        break;
      case 'image_prompts':
        await executeBatch2ImagePrompts(batchId, projectIds, settings, stepStatuses, projectStatuses, res, signal);
        break;
      case 'images':
        await executeBatch2Images(batchId, projectIds, stepStatuses, projectStatuses, res, signal);
        break;
    }
  }
}

async function executeBatch2Audio(
  batchId: string,
  projectIds: string[],
  settings: Record<string, any>,
  stepStatuses: Record<string, Record<string, string>>,
  projectStatuses: Record<string, { status: string; failedAtStep?: string; error?: string }>,
  res: Response,
  signal?: AbortSignal,
): Promise<void> {
  for (let i = 0; i < projectIds.length; i++) {
    const projectId = projectIds[i];
    if (!shouldProcessProject(batchId, projectId, projectStatuses)) continue;
    if (shouldAbort(batchId)) return;

    const projectData = await getProjectData(projectId);

    writeSseEvent(res, { type: 'progress', batch: 2, step: 'audio', projectIndex: i, projectId, status: 'running' });
    stepStatuses[projectId].audio = 'running';
    await updateFactoryBatch(batchId, { current_step: 'audio', current_project_index: i, step_statuses: stepStatuses });

    try {
      const audioResult = await callStreamingApi<{
        success?: boolean; type?: string; audioUrl?: string; duration?: number;
        segments?: any[]; totalDuration?: number; error?: string;
      }>('/generate-audio', {
        script: projectData.script, projectId,
        voiceSampleUrl: settings.voiceSampleUrl || DEFAULT_VOICE_SAMPLE,
        speed: settings.speed || 1,
        ttsProvider: settings.ttsProvider || 'voxcpm2',
        ttsSettings: { emotionMarker: settings.ttsEmotionMarker, temperature: settings.ttsTemperature, topP: settings.ttsTopP, repetitionPenalty: settings.ttsRepetitionPenalty },
        stream: true,
      }, TIMEOUT.AUDIO, signal, (pct) => {
        writeSseEvent(res, { type: 'progress', batch: 2, step: 'audio', projectIndex: i, projectId, status: 'running', progress: pct });
      });

      if (!audioResult.audioUrl) throw new Error(audioResult.error || 'Failed to generate audio');

      await updateProject(projectId, {
        audio_url: audioResult.audioUrl,
        audio_duration: audioResult.totalDuration || audioResult.duration || 0,
        audio_segments: audioResult.segments || [],
      });

      stepStatuses[projectId].audio = 'done';
      writeSseEvent(res, { type: 'progress', batch: 2, step: 'audio', projectIndex: i, projectId, status: 'done' });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Factory ${batchId}] Project ${projectId} audio failed:`, errorMessage);
      projectStatuses[projectId] = { status: 'failed', failedAtStep: 'audio', error: errorMessage };
      stepStatuses[projectId].audio = 'failed';
      writeSseEvent(res, { type: 'progress', batch: 2, step: 'audio', projectIndex: i, projectId, status: 'failed', error: errorMessage });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses, project_statuses: projectStatuses });
    }
  }
}

async function executeBatch2Captions(
  batchId: string,
  projectIds: string[],
  stepStatuses: Record<string, Record<string, string>>,
  projectStatuses: Record<string, { status: string; failedAtStep?: string; error?: string }>,
  res: Response,
  signal?: AbortSignal,
): Promise<void> {
  for (let i = 0; i < projectIds.length; i++) {
    const projectId = projectIds[i];
    if (!shouldProcessProject(batchId, projectId, projectStatuses)) continue;
    if (shouldAbort(batchId)) return;

    const projectData = await getProjectData(projectId);

    writeSseEvent(res, { type: 'progress', batch: 2, step: 'captions', projectIndex: i, projectId, status: 'running' });
    stepStatuses[projectId].captions = 'running';
    await updateFactoryBatch(batchId, { current_step: 'captions', current_project_index: i, step_statuses: stepStatuses });

    try {
      const captionsResult = await callInternalApi<{
        success: boolean; srtContent?: string; error?: string;
      }>('/generate-captions', { audioUrl: projectData.audioUrl, projectId }, TIMEOUT.CAPTIONS, signal);

      if (!captionsResult.success || !captionsResult.srtContent) throw new Error(captionsResult.error || 'Failed to generate captions');

      await updateProject(projectId, { srt_content: captionsResult.srtContent });

      stepStatuses[projectId].captions = 'done';
      writeSseEvent(res, { type: 'progress', batch: 2, step: 'captions', projectIndex: i, projectId, status: 'done' });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Factory ${batchId}] Project ${projectId} captions failed:`, errorMessage);
      projectStatuses[projectId] = { status: 'failed', failedAtStep: 'captions', error: errorMessage };
      stepStatuses[projectId].captions = 'failed';
      writeSseEvent(res, { type: 'progress', batch: 2, step: 'captions', projectIndex: i, projectId, status: 'failed', error: errorMessage });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses, project_statuses: projectStatuses });
    }
  }
}

async function executeBatch2ImagePrompts(
  batchId: string,
  projectIds: string[],
  settings: Record<string, any>,
  stepStatuses: Record<string, Record<string, string>>,
  projectStatuses: Record<string, { status: string; failedAtStep?: string; error?: string }>,
  res: Response,
  signal?: AbortSignal,
): Promise<void> {
  for (let i = 0; i < projectIds.length; i++) {
    const projectId = projectIds[i];
    if (!shouldProcessProject(batchId, projectId, projectStatuses)) continue;
    if (shouldAbort(batchId)) return;

    const projectData = await getProjectData(projectId);

    writeSseEvent(res, { type: 'progress', batch: 2, step: 'image_prompts', projectIndex: i, projectId, status: 'running' });
    stepStatuses[projectId].image_prompts = 'running';
    await updateFactoryBatch(batchId, { current_step: 'image_prompts', current_project_index: i, step_statuses: stepStatuses });

    try {
      const promptsResult = await callStreamingApi<{
        success?: boolean; type?: string; prompts?: any[]; error?: string;
      }>('/generate-image-prompts', {
        script: projectData.script, srtContent: projectData.srtContent, audioDuration: projectData.audioDuration,
        imageCount: settings.imageCount || 200, projectId, masterStylePrompt: settings.customStylePrompt,
        topic: settings.topic, subjectFocus: settings.subjectFocus,
        clipCount: settings.clipCount || 12, clipDuration: settings.clipDuration || 5, stream: true,
      }, TIMEOUT.IMAGE_PROMPTS, signal, (pct) => {
        writeSseEvent(res, { type: 'progress', batch: 2, step: 'image_prompts', projectIndex: i, projectId, status: 'running', progress: pct });
      });

      if (!promptsResult.prompts || promptsResult.prompts.length === 0) throw new Error(promptsResult.error || 'Failed to generate image prompts');

      await updateProject(projectId, { image_prompts: promptsResult.prompts });

      stepStatuses[projectId].image_prompts = 'done';
      writeSseEvent(res, { type: 'progress', batch: 2, step: 'image_prompts', projectIndex: i, projectId, status: 'done' });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Factory ${batchId}] Project ${projectId} image prompts failed:`, errorMessage);
      projectStatuses[projectId] = { status: 'failed', failedAtStep: 'image_prompts', error: errorMessage };
      stepStatuses[projectId].image_prompts = 'failed';
      writeSseEvent(res, { type: 'progress', batch: 2, step: 'image_prompts', projectIndex: i, projectId, status: 'failed', error: errorMessage });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses, project_statuses: projectStatuses });
    }
  }
}

async function executeBatch2Images(
  batchId: string,
  projectIds: string[],
  stepStatuses: Record<string, Record<string, string>>,
  projectStatuses: Record<string, { status: string; failedAtStep?: string; error?: string }>,
  res: Response,
  signal?: AbortSignal,
): Promise<void> {
  for (let i = 0; i < projectIds.length; i++) {
    const projectId = projectIds[i];
    if (!shouldProcessProject(batchId, projectId, projectStatuses)) continue;
    if (shouldAbort(batchId)) return;

    const projectData = await getProjectData(projectId);

    writeSseEvent(res, { type: 'progress', batch: 2, step: 'images', projectIndex: i, projectId, status: 'running' });
    stepStatuses[projectId].images = 'running';
    await updateFactoryBatch(batchId, { current_step: 'images', current_project_index: i, step_statuses: stepStatuses });

    try {
      const imagePrompts = projectData.imagePrompts || [];
      const imagesResult = await callStreamingApi<{
        success?: boolean; type?: string; images?: string[]; error?: string;
      }>('/generate-images', {
        prompts: imagePrompts.map((p: any) => p.sceneDescription || p.prompt), projectId, stream: true,
      }, TIMEOUT.IMAGES, signal, (pct) => {
        writeSseEvent(res, { type: 'progress', batch: 2, step: 'images', projectIndex: i, projectId, status: 'running', progress: pct });
      });

      if (!imagesResult.images || imagesResult.images.length === 0) throw new Error(imagesResult.error || 'Failed to generate images');

      await updateProject(projectId, { image_urls: imagesResult.images });

      stepStatuses[projectId].images = 'done';
      writeSseEvent(res, { type: 'progress', batch: 2, step: 'images', projectIndex: i, projectId, status: 'done' });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Factory ${batchId}] Project ${projectId} images failed:`, errorMessage);
      projectStatuses[projectId] = { status: 'failed', failedAtStep: 'images', error: errorMessage };
      stepStatuses[projectId].images = 'failed';
      writeSseEvent(res, { type: 'progress', batch: 2, step: 'images', projectIndex: i, projectId, status: 'failed', error: errorMessage });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses, project_statuses: projectStatuses });
    }
  }
}

// Legacy: runs all batch 2 sub-steps sequentially (unused but kept for reference)
async function executeBatch2Media(
  batchId: string,
  projectIds: string[],
  settings: Record<string, any>,
  stepStatuses: Record<string, Record<string, string>>,
  projectStatuses: Record<string, { status: string; failedAtStep?: string; error?: string }>,
  res: Response,
  signal?: AbortSignal,
): Promise<void> {
  // Sub-step 1: Audio (all projects)
  for (let i = 0; i < projectIds.length; i++) {
    const projectId = projectIds[i];
    if (!shouldProcessProject(batchId, projectId, projectStatuses)) continue;
    if (shouldAbort(batchId)) return;

    const projectData = await getProjectData(projectId);

    writeSseEvent(res, { type: 'progress', batch: 2, step: 'audio', projectIndex: i, projectId, status: 'running' });
    stepStatuses[projectId].audio = 'running';
    await updateFactoryBatch(batchId, { current_step: 'audio', current_project_index: i, step_statuses: stepStatuses });

    try {
      const audioResult = await callStreamingApi<{
        success?: boolean;
        type?: string;
        audioUrl?: string;
        duration?: number;
        segments?: any[];
        totalDuration?: number;
        error?: string;
      }>('/generate-audio', {
        script: projectData.script,
        projectId,
        voiceSampleUrl: settings.voiceSampleUrl || DEFAULT_VOICE_SAMPLE,
        speed: settings.speed || 1,
        ttsSettings: {
          emotionMarker: settings.ttsEmotionMarker,
          temperature: settings.ttsTemperature,
          topP: settings.ttsTopP,
          repetitionPenalty: settings.ttsRepetitionPenalty,
        },
        stream: true,
      }, TIMEOUT.AUDIO, signal, (pct) => {
        writeSseEvent(res, { type: 'progress', batch: 2, step: 'audio', projectIndex: i, projectId, status: 'running', progress: pct });
      });

      if (!audioResult.audioUrl) {
        throw new Error(audioResult.error || 'Failed to generate audio');
      }

      await updateProject(projectId, {
        audio_url: audioResult.audioUrl,
        audio_duration: audioResult.totalDuration || audioResult.duration || 0,
        audio_segments: audioResult.segments || [],
      });

      stepStatuses[projectId].audio = 'done';
      writeSseEvent(res, { type: 'progress', batch: 2, step: 'audio', projectIndex: i, projectId, status: 'done' });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Factory ${batchId}] Project ${projectId} audio failed:`, errorMessage);
      projectStatuses[projectId] = { status: 'failed', failedAtStep: 'audio', error: errorMessage };
      stepStatuses[projectId].audio = 'failed';
      writeSseEvent(res, { type: 'progress', batch: 2, step: 'audio', projectIndex: i, projectId, status: 'failed', error: errorMessage });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses, project_statuses: projectStatuses });
    }
  }

  // Sub-step 2: Captions (all projects)
  for (let i = 0; i < projectIds.length; i++) {
    const projectId = projectIds[i];
    if (!shouldProcessProject(batchId, projectId, projectStatuses)) continue;
    if (shouldAbort(batchId)) return;

    const projectData = await getProjectData(projectId);

    writeSseEvent(res, { type: 'progress', batch: 2, step: 'captions', projectIndex: i, projectId, status: 'running' });
    stepStatuses[projectId].captions = 'running';
    await updateFactoryBatch(batchId, { current_step: 'captions', current_project_index: i, step_statuses: stepStatuses });

    try {
      const captionsResult = await callInternalApi<{
        success: boolean;
        srtContent?: string;
        error?: string;
      }>('/generate-captions', {
        audioUrl: projectData.audioUrl,
        projectId,
      }, TIMEOUT.CAPTIONS, signal);

      if (!captionsResult.success || !captionsResult.srtContent) {
        throw new Error(captionsResult.error || 'Failed to generate captions');
      }

      await updateProject(projectId, { srt_content: captionsResult.srtContent });

      stepStatuses[projectId].captions = 'done';
      writeSseEvent(res, { type: 'progress', batch: 2, step: 'captions', projectIndex: i, projectId, status: 'done' });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Factory ${batchId}] Project ${projectId} captions failed:`, errorMessage);
      projectStatuses[projectId] = { status: 'failed', failedAtStep: 'captions', error: errorMessage };
      stepStatuses[projectId].captions = 'failed';
      writeSseEvent(res, { type: 'progress', batch: 2, step: 'captions', projectIndex: i, projectId, status: 'failed', error: errorMessage });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses, project_statuses: projectStatuses });
    }
  }

  // Sub-step 3: Image Prompts (all projects)
  for (let i = 0; i < projectIds.length; i++) {
    const projectId = projectIds[i];
    if (!shouldProcessProject(batchId, projectId, projectStatuses)) continue;
    if (shouldAbort(batchId)) return;

    const projectData = await getProjectData(projectId);

    writeSseEvent(res, { type: 'progress', batch: 2, step: 'image_prompts', projectIndex: i, projectId, status: 'running' });
    stepStatuses[projectId].image_prompts = 'running';
    await updateFactoryBatch(batchId, { current_step: 'image_prompts', current_project_index: i, step_statuses: stepStatuses });

    try {
      const promptsResult = await callStreamingApi<{
        success?: boolean;
        type?: string;
        prompts?: any[];
        error?: string;
      }>('/generate-image-prompts', {
        script: projectData.script,
        srtContent: projectData.srtContent,
        audioDuration: projectData.audioDuration,
        imageCount: settings.imageCount || 200,
        projectId,
        masterStylePrompt: settings.customStylePrompt,
        topic: settings.topic,
        subjectFocus: settings.subjectFocus,
        clipCount: settings.clipCount || 12,
        clipDuration: settings.clipDuration || 5,
        stream: true,
      }, TIMEOUT.IMAGE_PROMPTS, signal, (pct) => {
        writeSseEvent(res, { type: 'progress', batch: 2, step: 'image_prompts', projectIndex: i, projectId, status: 'running', progress: pct });
      });

      if (!promptsResult.prompts || promptsResult.prompts.length === 0) {
        throw new Error(promptsResult.error || 'Failed to generate image prompts');
      }

      await updateProject(projectId, { image_prompts: promptsResult.prompts });

      stepStatuses[projectId].image_prompts = 'done';
      writeSseEvent(res, { type: 'progress', batch: 2, step: 'image_prompts', projectIndex: i, projectId, status: 'done' });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Factory ${batchId}] Project ${projectId} image prompts failed:`, errorMessage);
      projectStatuses[projectId] = { status: 'failed', failedAtStep: 'image_prompts', error: errorMessage };
      stepStatuses[projectId].image_prompts = 'failed';
      writeSseEvent(res, { type: 'progress', batch: 2, step: 'image_prompts', projectIndex: i, projectId, status: 'failed', error: errorMessage });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses, project_statuses: projectStatuses });
    }
  }

  // Sub-step 4: Images (all projects)
  for (let i = 0; i < projectIds.length; i++) {
    const projectId = projectIds[i];
    if (!shouldProcessProject(batchId, projectId, projectStatuses)) continue;
    if (shouldAbort(batchId)) return;

    const projectData = await getProjectData(projectId);

    writeSseEvent(res, { type: 'progress', batch: 2, step: 'images', projectIndex: i, projectId, status: 'running' });
    stepStatuses[projectId].images = 'running';
    await updateFactoryBatch(batchId, { current_step: 'images', current_project_index: i, step_statuses: stepStatuses });

    try {
      const imagePrompts = projectData.imagePrompts || [];

      const imagesResult = await callStreamingApi<{
        success?: boolean;
        type?: string;
        images?: string[];
        error?: string;
      }>('/generate-images', {
        prompts: imagePrompts.map((p: any) => p.sceneDescription || p.prompt),
        projectId,
        stream: true,
      }, TIMEOUT.IMAGES, signal, (pct) => {
        writeSseEvent(res, { type: 'progress', batch: 2, step: 'images', projectIndex: i, projectId, status: 'running', progress: pct });
      });

      if (!imagesResult.images || imagesResult.images.length === 0) {
        throw new Error(imagesResult.error || 'Failed to generate images');
      }

      await updateProject(projectId, { image_urls: imagesResult.images });

      stepStatuses[projectId].images = 'done';
      writeSseEvent(res, { type: 'progress', batch: 2, step: 'images', projectIndex: i, projectId, status: 'done' });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Factory ${batchId}] Project ${projectId} images failed:`, errorMessage);
      projectStatuses[projectId] = { status: 'failed', failedAtStep: 'images', error: errorMessage };
      stepStatuses[projectId].images = 'failed';
      writeSseEvent(res, { type: 'progress', batch: 2, step: 'images', projectIndex: i, projectId, status: 'failed', error: errorMessage });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses, project_statuses: projectStatuses });
    }
  }
}

// ---------------------------------------------------------------------------
// Batch 3 — Clips (clip prompts, video clips)
// ---------------------------------------------------------------------------

async function executeBatch3Clips(
  batchId: string,
  projectIds: string[],
  settings: Record<string, any>,
  stepStatuses: Record<string, Record<string, string>>,
  projectStatuses: Record<string, { status: string; failedAtStep?: string; error?: string }>,
  res: Response,
  signal?: AbortSignal,
): Promise<void> {
  // Sub-step 1: Clip Prompts (all projects)
  for (let i = 0; i < projectIds.length; i++) {
    const projectId = projectIds[i];
    if (!shouldProcessProject(batchId, projectId, projectStatuses)) continue;
    if (shouldAbort(batchId)) return;

    const projectData = await getProjectData(projectId);

    writeSseEvent(res, { type: 'progress', batch: 3, step: 'clip_prompts', projectIndex: i, projectId, status: 'running' });
    stepStatuses[projectId].clip_prompts = 'running';
    await updateFactoryBatch(batchId, { current_step: 'clip_prompts', current_project_index: i, step_statuses: stepStatuses });

    try {
      const clipPromptsResult = await callStreamingApi<{
        success?: boolean;
        type?: string;
        prompts?: any[];
        error?: string;
      }>('/generate-clip-prompts', {
        script: projectData.script,
        srtContent: projectData.srtContent,
        audioDuration: projectData.audioDuration,
        clipCount: settings.clipCount || 12,
        clipDuration: settings.clipDuration || 5,
        imageUrls: (projectData.imageUrls || []).slice(0, settings.clipCount || 12),
        projectId,
        stream: true,
      }, TIMEOUT.CLIP_PROMPTS, signal, (pct) => {
        writeSseEvent(res, { type: 'progress', batch: 3, step: 'clip_prompts', projectIndex: i, projectId, status: 'running', progress: pct });
      });

      if (clipPromptsResult.prompts && clipPromptsResult.prompts.length > 0) {
        await updateProject(projectId, { clip_prompts: clipPromptsResult.prompts });
      }

      stepStatuses[projectId].clip_prompts = 'done';
      writeSseEvent(res, { type: 'progress', batch: 3, step: 'clip_prompts', projectIndex: i, projectId, status: 'done' });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Factory ${batchId}] Project ${projectId} clip prompts failed:`, errorMessage);
      projectStatuses[projectId] = { status: 'failed', failedAtStep: 'clip_prompts', error: errorMessage };
      stepStatuses[projectId].clip_prompts = 'failed';
      writeSseEvent(res, { type: 'progress', batch: 3, step: 'clip_prompts', projectIndex: i, projectId, status: 'failed', error: errorMessage });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses, project_statuses: projectStatuses });
    }
  }

  // Sub-step 2: Video Clips (all projects)
  for (let i = 0; i < projectIds.length; i++) {
    const projectId = projectIds[i];
    if (!shouldProcessProject(batchId, projectId, projectStatuses)) continue;
    if (shouldAbort(batchId)) return;

    const projectData = await getProjectData(projectId);
    const clipPrompts = projectData.clipPrompts || [];

    if (clipPrompts.length === 0) {
      stepStatuses[projectId].clips = 'done';
      writeSseEvent(res, { type: 'progress', batch: 3, step: 'clips', projectIndex: i, projectId, status: 'done' });
      continue;
    }

    writeSseEvent(res, { type: 'progress', batch: 3, step: 'clips', projectIndex: i, projectId, status: 'running' });
    stepStatuses[projectId].clips = 'running';
    await updateFactoryBatch(batchId, { current_step: 'clips', current_project_index: i, step_statuses: stepStatuses });

    try {
      const imageUrls = projectData.imageUrls || [];

      const clipsResult = await callStreamingApi<{
        success?: boolean;
        type?: string;
        clips?: any[];
        error?: string;
      }>('/generate-video-clips', {
        clipPrompts: clipPrompts.map((p: any, idx: number) => ({
          ...p,
          imageUrl: imageUrls[idx] || imageUrls[0],
        })),
        projectId,
        stream: true,
      }, TIMEOUT.VIDEO_CLIPS, signal, (pct) => {
        writeSseEvent(res, { type: 'progress', batch: 3, step: 'clips', projectIndex: i, projectId, status: 'running', progress: pct });
      });

      if (clipsResult.clips && clipsResult.clips.length > 0) {
        await updateProject(projectId, { clips: clipsResult.clips });
      }

      stepStatuses[projectId].clips = 'done';
      writeSseEvent(res, { type: 'progress', batch: 3, step: 'clips', projectIndex: i, projectId, status: 'done' });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Factory ${batchId}] Project ${projectId} clips failed:`, errorMessage);
      projectStatuses[projectId] = { status: 'failed', failedAtStep: 'clips', error: errorMessage };
      stepStatuses[projectId].clips = 'failed';
      writeSseEvent(res, { type: 'progress', batch: 3, step: 'clips', projectIndex: i, projectId, status: 'failed', error: errorMessage });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses, project_statuses: projectStatuses });
    }
  }
}

// ---------------------------------------------------------------------------
// Batch 4 — Render
// ---------------------------------------------------------------------------

async function executeBatch4Render(
  batchId: string,
  projectIds: string[],
  settings: Record<string, any>,
  stepStatuses: Record<string, Record<string, string>>,
  projectStatuses: Record<string, { status: string; failedAtStep?: string; error?: string }>,
  res: Response,
  signal?: AbortSignal,
): Promise<void> {
  for (let i = 0; i < projectIds.length; i++) {
    const projectId = projectIds[i];
    if (!shouldProcessProject(batchId, projectId, projectStatuses)) continue;
    if (shouldAbort(batchId)) return;

    const projectData = await getProjectData(projectId);

    writeSseEvent(res, { type: 'progress', batch: 4, step: 'render', projectIndex: i, projectId, status: 'running' });
    stepStatuses[projectId].render = 'running';
    await updateFactoryBatch(batchId, { current_step: 'render', current_project_index: i, step_statuses: stepStatuses });

    try {
      const imageTimings = (projectData.imagePrompts || []).map((p: any) => ({
        startSeconds: p.startSeconds || 0,
        endSeconds: p.endSeconds || 0,
      }));

      const clips = projectData.clips || [];
      const introClips = (clips.length > 0)
        ? clips.map((c: any) => ({
            url: c.videoUrl,
            startSeconds: c.startSeconds,
            endSeconds: c.endSeconds,
          }))
        : undefined;

      const renderResult = await callStreamingApi<{
        success?: boolean;
        type?: string;
        videoUrl?: string;
        smokeEmbersVideoUrl?: string;
        error?: string;
      }>('/render-video', {
        projectId,
        audioUrl: projectData.audioUrl,
        imageUrls: projectData.imageUrls,
        imageTimings,
        srtContent: projectData.srtContent,
        projectTitle: projectData.videoTitle || 'Untitled',
        effects: settings.effects || { smoke_embers: true },
        introClips,
      }, TIMEOUT.RENDER, signal, (pct) => {
        writeSseEvent(res, { type: 'progress', batch: 4, step: 'render', projectIndex: i, projectId, status: 'running', progress: pct });
      });

      if (!renderResult.videoUrl) {
        throw new Error(renderResult.error || 'Failed to render video');
      }

      const finalUpdates: Record<string, any> = {
        video_url: renderResult.videoUrl,
        current_step: 'complete',
        status: 'completed',
      };
      if (renderResult.smokeEmbersVideoUrl) {
        finalUpdates.smoke_embers_video_url = renderResult.smokeEmbersVideoUrl;
      }
      await updateProject(projectId, finalUpdates);

      stepStatuses[projectId].render = 'done';
      writeSseEvent(res, { type: 'progress', batch: 4, step: 'render', projectIndex: i, projectId, status: 'done' });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Factory ${batchId}] Project ${projectId} render failed:`, errorMessage);
      projectStatuses[projectId] = { status: 'failed', failedAtStep: 'render', error: errorMessage };
      stepStatuses[projectId].render = 'failed';
      writeSseEvent(res, { type: 'progress', batch: 4, step: 'render', projectIndex: i, projectId, status: 'failed', error: errorMessage });
      await updateFactoryBatch(batchId, { step_statuses: stepStatuses, project_statuses: projectStatuses });
    }
  }
}

// ============================================================================
// Routes
// ============================================================================

/**
 * POST / — Create factory batch
 *
 * Body: { projects: [{url?, script?, title, settingsOverrides?}], settings }
 */
router.post('/', async (req: Request, res: Response) => {
  const { projects, settings } = req.body;

  if (!projects || !Array.isArray(projects) || projects.length === 0) {
    return res.status(400).json({ error: 'projects array is required and must not be empty' });
  }
  if (projects.length > 5) {
    return res.status(400).json({ error: 'Maximum 5 projects per batch' });
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  try {
    const batchId = uuidv4();
    const projectIds: string[] = [];
    const projectSettingsOverrides: Record<string, Record<string, any>> = {};
    const projectScripts: Record<string, string> = {};
    const projectSettingsMap: Record<string, Record<string, any>> = {};

    // Step 1: Create all generation_projects rows (without factory_batch_id)
    for (const project of projects) {
      const projectId = uuidv4();
      projectIds.push(projectId);

      const sourceUrl = project.url || 'direct_script';
      const createResult = await createProject(projectId, sourceUrl, project.title);
      if (!createResult.success) {
        throw new Error(`Failed to create project: ${createResult.error}`);
      }

      if (project.script) {
        projectScripts[projectId] = project.script;
      }

      const projectSettings: Record<string, any> = { ...settings, sourceUrl };
      if (project.settingsOverrides) {
        Object.assign(projectSettings, project.settingsOverrides);
        projectSettingsOverrides[projectId] = project.settingsOverrides;
      }
      projectSettingsMap[projectId] = projectSettings;
    }

    // Step 2: Create factory_batches row FIRST (before FK references)
    const batchResult = await createFactoryBatch({
      id: batchId,
      project_ids: projectIds,
      settings: settings || {},
      project_settings_overrides: projectSettingsOverrides,
      total_projects: projectIds.length,
    });

    if (!batchResult.success) {
      throw new Error(`Failed to create factory batch: ${batchResult.error}`);
    }

    // Step 3: Update projects with factory_batch_id + script + settings
    for (const projectId of projectIds) {
      const projectUpdates: Record<string, any> = {
        factory_batch_id: batchId,
        settings: projectSettingsMap[projectId],
      };
      if (projectScripts[projectId]) {
        projectUpdates.script_content = projectScripts[projectId];
      }
      const updateResult = await updateProject(projectId, projectUpdates);
      if (!updateResult.success) {
        console.error(`[Factory] Failed to update project ${projectId}:`, updateResult.error);
      }
    }

    res.json({ batchId, projectIds });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Factory] Failed to create batch:', message);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /:batchId/run-batch — Execute a batch (SSE stream)
 *
 * Body: { batchNumber: 1|2|3|4, subStep?: string }
 * For batch 2, subStep can be: "audio", "captions", "image_prompts", "images"
 * If subStep is provided, only that sub-step runs then pauses for review.
 */
router.post('/:batchId/run-batch', async (req: Request, res: Response) => {
  const { batchId } = req.params;
  const { batchNumber, subStep } = req.body;

  if (![1, 2, 3, 4].includes(batchNumber)) {
    return res.status(400).json({ error: 'batchNumber must be 1, 2, 3, or 4' });
  }

  const validSubSteps = ['audio', 'captions', 'image_prompts', 'images'];
  if (batchNumber === 2 && subStep && !validSubSteps.includes(subStep)) {
    return res.status(400).json({ error: `subStep must be one of: ${validSubSteps.join(', ')}` });
  }

  // Reject if any batch is already running
  for (const [existingBatchId, state] of Array.from(runningBatches.entries())) {
    if (!state.aborted) {
      return res.status(409).json({
        error: 'A batch is already running',
        runningBatchId: existingBatchId,
        currentStep: state.currentStep,
      });
    }
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Register the running batch
  const controller = new AbortController();
  runningBatches.set(batchId, {
    aborted: false,
    controller,
    currentStep: 'init',
    skippedProjects: new Set<string>(),
  });

  // Handle client disconnect
  req.on('close', () => {
    const state = runningBatches.get(batchId);
    if (state && !state.aborted) {
      console.log(`[Factory ${batchId}] Client disconnected during batch ${batchNumber}`);
    }
  });

  // Run batch execution detached from request lifecycle
  setImmediate(() => {
    executeBatch(batchId, batchNumber, res, subStep).catch(error => {
      console.error(`[Factory ${batchId}] Background execution failed:`, error);
      updateFactoryBatch(batchId, {
        status: `batch${batchNumber}_failed`,
      }).catch(dbErr => {
        console.error(`[Factory ${batchId}] Failed to save error status:`, dbErr);
      });
    }).finally(() => {
      runningBatches.delete(batchId);
    });
  });
});

/**
 * GET /:batchId/status — Poll progress
 */
router.get('/:batchId/status', async (req: Request, res: Response) => {
  const { batchId } = req.params;

  const batchData = await getFactoryBatch(batchId);
  if (!batchData) {
    return res.status(404).json({ error: 'Batch not found' });
  }

  res.json(batchData);
});

/**
 * PUT /:batchId/cancel — Cancel batch
 */
router.put('/:batchId/cancel', async (req: Request, res: Response) => {
  const { batchId } = req.params;

  const state = runningBatches.get(batchId);
  if (state) {
    state.aborted = true;
    state.controller.abort();
  }

  await updateFactoryBatch(batchId, { status: 'cancelled' });

  res.json({
    success: true,
    message: state
      ? `Batch cancellation requested (was at step: ${state.currentStep})`
      : 'Batch marked as cancelled',
    batchId,
  });
});

/**
 * PUT /:batchId/skip/:projectId — Skip one project
 */
router.put('/:batchId/skip/:projectId', async (req: Request, res: Response) => {
  const { batchId, projectId } = req.params;

  const state = runningBatches.get(batchId);
  if (state) {
    state.skippedProjects.add(projectId);
  }

  // Also update the project_statuses in DB
  const batchData = await getFactoryBatch(batchId);
  if (batchData) {
    const updatedStatuses = { ...batchData.project_statuses };
    updatedStatuses[projectId] = { status: 'skipped' };
    await updateFactoryBatch(batchId, { project_statuses: updatedStatuses });
  }

  res.json({
    success: true,
    message: `Project ${projectId} marked as skipped`,
    batchId,
    projectId,
  });
});

export default router;
