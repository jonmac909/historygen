import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import crypto from 'crypto';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { saveCost } from '../lib/cost-tracker';
import { localInferenceConfig } from '../lib/runtime-config';
import { uploadAsset } from '../lib/r2-storage';
import { ltx2RequestSchema } from '../schemas/local-inference-schemas';

const execAsync = promisify(exec);

// ZG-21 / Phase 2.8: in-process cache populated by `startVideoTask`'s local
// branch (NDJSON-streamed POST yields the MP4 bytes inline) and drained by
// `checkTaskStatus`'s local short-circuit. Keyed by synthetic UUID taskId so
// the existing rolling-concurrency / retry loops in handleStreamingClips and
// handleNonStreamingClips keep their task-tracking shape unchanged.
//
// Each entry holds the already-uploaded clip URL so checkTaskStatus does not
// repeat the asset upload (the upload happens inside the local branch where
// we already have the bytes).
type LocalClipResult =
  | { state: 'success'; videoUrl: string; costTime?: number }
  | { state: 'fail'; error: string };
const localClipResultCache = new Map<string, LocalClipResult>();

// Phase 2.8 probe-and-fallback (ZG-21 / ZG-26): the per-request decision on
// whether to use the local LTX-2 server or fall back to Kie.ai is computed
// once at the top of the route handler (probeLtx2Health) and threaded
// through `useLocal` parameters to handleStreamingClips /
// handleNonStreamingClips / startVideoTask. Default expected path until
// the 5080 lands is Kie.ai.

// Use static binaries for ffmpeg/ffprobe
const FFMPEG_PATH = ffmpegStatic || 'ffmpeg';
const FFPROBE_PATH = ffprobeStatic.path || 'ffprobe';
const router = Router();

// Kie.ai API configuration
const KIE_API_URL = 'https://api.kie.ai/api/v1/jobs';
// Model for image-to-video (I2V) - generates video from static images
const KIE_MODEL_I2V = 'bytedance/v1-pro-fast-image-to-video';

// Constants for video clip generation
// 12 clips × 5s = 60 seconds total intro (image-first I2V approach)
const CLIP_DURATION = 5;  // 5 seconds per clip (v1-pro-fast supports 5/10s)
const CLIP_COUNT = 12;    // 12 clips for 60 second intro
const CLIP_RESOLUTION = '720p';
// Max concurrent clips - submit all at once, Kie.ai handles queueing
const MAX_CONCURRENT_CLIPS = parseInt(process.env.SEEDANCE_MAX_CONCURRENT_CLIPS || '12', 10);
// Fade duration in seconds for smooth transitions between clips
const FADE_DURATION = 0.5;

interface ClipPrompt {
  index: number;
  startSeconds: number;
  endSeconds: number;
  prompt: string;
  sceneDescription?: string;
  imageUrl: string;  // Required: source image for I2V (from Z-Image generation)
}

interface GenerateVideoClipsRequest {
  projectId: string;
  clips: ClipPrompt[];
  stream?: boolean;
  duration?: number;  // 4, 8, or 12 seconds
  resolution?: string;  // 480p or 720p
}

interface ClipStatus {
  taskId: string;
  index: number;
  state: 'pending' | 'success' | 'fail';
  videoUrl?: string;
  error?: string;
  filename?: string;
}

// Supabase client for copying videos to our storage
function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  return createClient(url, key);
}

// Phase 2.8 probe (ZG-21): GET ${LOCAL_LTX2_URL}/healthz with 5s timeout. If
// 200 + status: 'ready' | 'idle', return true (use local). Otherwise return
// false (fall back to Kie.ai). Cached per-request — not per-clip — to avoid
// hammering /healthz every iteration of the rolling window.
async function probeLtx2Health(): Promise<boolean> {
  if (!localInferenceConfig.enabled) return false;

  const url = `${localInferenceConfig.ltx2Url}/healthz`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);

  try {
    const response = await fetch(url, { method: 'GET', signal: ctrl.signal });
    if (!response.ok) {
      console.log(`[I2V probe] ${url} -> HTTP ${response.status}; using Kie.ai fallback`);
      return false;
    }
    const data = await response.json() as { status?: string };
    const ok = data.status === 'ready' || data.status === 'idle';
    console.log(`[I2V probe] ${url} -> status=${data.status} (local=${ok})`);
    return ok;
  } catch (err) {
    const reason = (err as { name?: string })?.name === 'AbortError' ? 'timeout (5s)' : (err as Error).message;
    console.log(`[I2V probe] ${url} -> ${reason}; using Kie.ai fallback`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Phase 2.8 / ZG-21: re-emit each NDJSON heartbeat from the LTX-2 server as a
// render-api SSE event so the frontend stage/status pipe stays consistent
// between local and remote modes. The server emits one event per JSON object
// per line; we accumulate bytes, split on `\n`, and parse each line.
//
// Reader pattern is `for await (const chunk of response.body)` — `.json()`
// or `.text()` would block until the stream ends, defeating the heartbeat
// purpose entirely (see ZG-21 in the plan).
async function streamLtx2Ndjson(
  response: Response & { body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null },
  sendEvent?: (data: any) => void,
): Promise<{ videoBytes: Buffer; durationMs?: number; error?: string }> {
  if (!response.body) {
    throw new Error('LTX-2 /i2v returned no response body to stream');
  }

  let buffer = '';
  let videoBytes: Buffer | null = null;
  let durationMs: number | undefined;
  let error: string | undefined;

  const decoder = new TextDecoder('utf-8');
  // Node's fetch returns a Web ReadableStream; iterate via the async iterator
  // exposed in Node 18+. Cast to AsyncIterable to keep TS happy across both
  // shapes (Node fetch + WHATWG-style readable streams).
  const stream = response.body as unknown as AsyncIterable<Uint8Array>;
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    // Split off complete lines; keep any trailing partial line in `buffer`.
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;

      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch (parseErr) {
        console.warn(`[I2V local] NDJSON parse error: ${(parseErr as Error).message}; line='${line.slice(0, 200)}'`);
        continue;
      }

      const type = evt.type ?? 'unknown';
      if (sendEvent) {
        // Re-emit as SSE with stage='clips' for frontend consistency
        sendEvent({ stage: 'clips', status: type, ...evt });
      }

      if (type === 'completed') {
        const b64 = evt.videoBase64;
        if (typeof b64 === 'string' && b64.length > 0) {
          videoBytes = Buffer.from(b64, 'base64');
        }
        if (typeof evt.durationMs === 'number') durationMs = evt.durationMs;
      } else if (type === 'error') {
        error = evt.error?.message ?? evt.message ?? 'LTX-2 /i2v emitted error event';
      }
    }
  }
  // Flush any trailing partial line (servers sometimes omit the final \n).
  const tail = buffer.trim();
  if (tail) {
    try {
      const evt = JSON.parse(tail);
      const type = evt.type ?? 'unknown';
      if (sendEvent) sendEvent({ stage: 'clips', status: type, ...evt });
      if (type === 'completed' && typeof evt.videoBase64 === 'string') {
        videoBytes = Buffer.from(evt.videoBase64, 'base64');
        if (typeof evt.durationMs === 'number') durationMs = evt.durationMs;
      } else if (type === 'error') {
        error = evt.error?.message ?? evt.message ?? 'LTX-2 /i2v emitted error event';
      }
    } catch {
      // Ignore — dangling whitespace etc.
    }
  }

  if (error) return { videoBytes: Buffer.alloc(0), durationMs, error };
  if (!videoBytes) {
    return { videoBytes: Buffer.alloc(0), error: 'LTX-2 /i2v stream ended without a completed event' };
  }
  return { videoBytes, durationMs };
}

/**
 * Local-inference LTX-2 path (Phase 2.8 / ZG-21 / ZG-26).
 *
 * LTX-2 server streams NDJSON heartbeats from POST /i2v: `started`,
 * `in_progress` (every 30s), `completed { videoBase64 }`, `error`. To slot
 * into the existing rolling-concurrency / polling loops without rewriting
 * them, we:
 *   1. Download imageUrl, base64-encode the bytes
 *   2. Build camelCase payload (prompt, imageBase64, negativePrompt, durationSeconds, resolution, seed?)
 *   3. Validate via `ltx2RequestSchema.parse(...)`
 *   4. POST with AbortController (timeout from `localInferenceConfig.ltx2TimeoutMs`)
 *   5. Stream NDJSON via `for await` reader; re-emit heartbeats as SSE
 *   6. On `completed`, decode videoBase64 -> upload via `uploadAsset('clips', ...)`
 *   7. Stash result by synthetic UUID taskId; return the id
 *   8. `checkTaskStatus`'s local short-circuit pops it and returns success
 *
 * Errors:
 *   - Zod validation failure -> Error('VALIDATION_ERROR: ...')
 *   - HTTP 4xx/5xx          -> Error with body excerpt
 *   - AbortError on timeout -> Error('LTX-2 /i2v timed out after Nms')
 *   - NDJSON `error` event  -> stash fail in cache; return id (loop fails normally)
 */
async function startVideoTaskLocal(
  prompt: string,
  clipIndex: number,
  imageUrl: string,
  projectId: string,
  duration: number,
  resolution: string,
  sendEvent?: (data: any) => void,
): Promise<string> {
  // 1. Download the source image and base64-encode it. The LTX-2 server's
  //    I2VRequest schema requires `imageBase64`, not a URL, so we resolve the
  //    URL on the render-api side. Errors here surface as a normal task
  //    failure and feed the existing retry queue.
  let imageBase64 = '';
  try {
    const imgRes = await fetch(imageUrl);
    if (imgRes.ok) {
      const arr = await imgRes.arrayBuffer();
      imageBase64 = Buffer.from(arr).toString('base64');
    } else {
      console.warn(`[I2V local] image download HTTP ${imgRes.status} for ${imageUrl.substring(0, 80)}; sending empty imageBase64`);
    }
  } catch (err) {
    console.warn(`[I2V local] image download failed for ${imageUrl.substring(0, 80)}: ${(err as Error).message}`);
  }

  // Negative prompt mirrors the Kie.ai path's content safety constraints so
  // local + remote produce visually consistent results.
  const negativePrompt = `kissing, lips touching, romantic embrace, leaning in to kiss, faces moving together, violence, fighting, blood, gore, nudity, modern elements, text, watermark`;

  // Build the wire payload. We include `imageUrl` alongside `imageBase64`
  // (zod strips it on .parse but we POST the original object — see below)
  // so the server has a debuggable URL trail and so the Layer 3 contract
  // test can assert on the camelCase imageUrl key.
  const wirePayload: Record<string, unknown> = {
    prompt,
    imageUrl,
    imageBase64,
    negativePrompt,
    durationSeconds: duration,
    resolution: resolution === '480p' ? '480p' : '720p',
  };

  // Zod-validate (but POST the original wirePayload so unknown-but-useful
  // fields like imageUrl survive the trip — the LTX-2 schema is permissive
  // toward extras via Pydantic `extra='ignore'`).
  try {
    ltx2RequestSchema.parse({
      prompt: wirePayload.prompt,
      imageBase64: wirePayload.imageBase64,
      negativePrompt: wirePayload.negativePrompt,
      durationSeconds: wirePayload.durationSeconds,
      resolution: wirePayload.resolution,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`VALIDATION_ERROR: ltx2RequestSchema rejected payload — ${message}`);
  }

  const url = `${localInferenceConfig.ltx2Url}/i2v`;
  const timeoutMs = localInferenceConfig.ltx2TimeoutMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  console.log(`[I2V local] POST ${url} (clip ${clipIndex + 1}, ${duration}s, ${resolution}, prompt="${prompt.substring(0, 60)}...")`);

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wirePayload),
      signal: ctrl.signal,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new Error(`LTX-2 /i2v timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[I2V local] /i2v ${response.status}: ${errorText.substring(0, 500)}`);
    throw new Error(`LTX-2 /i2v failed: HTTP ${response.status} - ${errorText.substring(0, 200)}`);
  }

  const taskId = `local-ltx2:${crypto.randomUUID()}`;

  // Detect NDJSON vs raw bytes. The locked LTX-2 server emits
  // `application/x-ndjson`; some test mocks return `video/mp4` raw bytes.
  // Both are valid here.
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const isNdjson = contentType.includes('ndjson') || contentType.includes('json');

  let mp4Buffer: Buffer;
  try {
    if (isNdjson) {
      const result = await streamLtx2Ndjson(response as any, sendEvent);
      if (result.error) {
        localClipResultCache.set(taskId, { state: 'fail', error: result.error });
        return taskId;
      }
      mp4Buffer = result.videoBytes;
    } else {
      // Raw mp4 bytes — emit synthetic started/completed SSE events for
      // consistency with the NDJSON path so the frontend timeline still
      // sees stage transitions in this branch.
      if (sendEvent) sendEvent({ stage: 'clips', status: 'started' });
      const arrayBuffer = await response.arrayBuffer();
      mp4Buffer = Buffer.from(arrayBuffer);
      if (sendEvent) {
        sendEvent({ stage: 'clips', status: 'completed', videoBytes: mp4Buffer.length });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    localClipResultCache.set(taskId, { state: 'fail', error: `NDJSON read failed: ${message}` });
    return taskId;
  }

  if (mp4Buffer.length === 0) {
    localClipResultCache.set(taskId, { state: 'fail', error: 'LTX-2 returned 0 bytes' });
    return taskId;
  }

  // 6. Upload via uploadAsset('clips', ...) — local mode writes under
  //    `${LOCAL_ASSETS_DIR}/clips/<key>` and returns the /assets URL.
  const filename = `clip_${String(clipIndex).padStart(3, '0')}.mp4`;
  const key = projectId ? `${projectId}/${filename}` : `${crypto.randomUUID()}/${filename}`;
  try {
    const videoUrl = await uploadAsset('clips', key, mp4Buffer, 'video/mp4');
    localClipResultCache.set(taskId, { state: 'success', videoUrl });
    console.log(`[I2V local] clip ${clipIndex + 1} uploaded -> ${videoUrl} (${mp4Buffer.length} bytes)`);
  } catch (uploadErr) {
    const message = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
    localClipResultCache.set(taskId, { state: 'fail', error: `upload failed: ${message}` });
  }

  return taskId;
}

// Start a Kie.ai I2V task
// Uses v1-pro-fast-image-to-video to animate source images
async function startVideoTask(
  apiKey: string,
  prompt: string,
  clipIndex: number,
  imageUrl: string,  // Required: source image from Z-Image
  duration: number = CLIP_DURATION,
  resolution: string = CLIP_RESOLUTION,
  // Phase 2.8 additions: probe-driven local routing + SSE re-emission for
  // the LTX-2 NDJSON heartbeats. Defaults preserve the existing Kie.ai
  // contract for all callers that haven't been updated.
  useLocal: boolean = false,
  projectId: string = '',
  sendEvent?: (data: any) => void,
): Promise<string> {
  // ZG-21 / ZG-26: probe-driven branch lives at the first executable line.
  // When the LTX-2 healthz probe came back ready/idle we use the local path;
  // otherwise we fall through to the Kie.ai code below (byte-identical to
  // baseline, Layer 5 regression).
  if (useLocal) {
    return startVideoTaskLocal(prompt, clipIndex, imageUrl, projectId, duration, resolution, sendEvent);
  }

  // Per ZG-26 / Phase 2.8: pass through the per-clip prompt instead of a
  // hard-coded motion prompt. The previous override discarded scene-specific
  // camera/movement cues from upstream and produced visually identical
  // motion across all 12 clips. Negative prompt stays for content safety.
  const negativePrompt = `kissing, lips touching, romantic embrace, leaning in to kiss, faces moving together, violence, fighting, blood, gore, nudity, modern elements, text, watermark`;
  console.log(`[I2V] Starting task for clip ${clipIndex + 1}: "${prompt.substring(0, 60)}..."`);

  // v1-pro-fast-image-to-video: animates static images, supports 5s/10s
  const input = {
    prompt,
    negative_prompt: negativePrompt,
    image_url: imageUrl,
    resolution,
    duration: String(duration),
  };
  console.log(`[I2V] Using image: ${imageUrl.substring(0, 60)}...`);

  const response = await fetch(`${KIE_API_URL}/createTask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: KIE_MODEL_I2V,
      input,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[I2V] Task creation error:', response.status, errorText);
    throw new Error(`Failed to start video task: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as any;

  if (data.code !== 200 || !data.data?.taskId) {
    console.error('[I2V] Task creation failed:', data);
    throw new Error(data.message || 'Task creation failed: no taskId returned');
  }

  console.log(`[I2V] Task created: ${data.data.taskId}`);
  return data.data.taskId;
}

// Check Kie.ai task status
async function checkTaskStatus(
  apiKey: string,
  taskId: string
): Promise<{ state: string; videoUrl?: string; error?: string; costTime?: number }> {
  // ZG-21: in local-inference mode startVideoTask did the sync NDJSON
  // streaming + upload and stashed the result keyed by taskId. Short-circuit:
  // pop, return. No HTTP roundtrip. Keeps the surrounding rolling-concurrency
  // loop intact.
  if (taskId.startsWith('local-ltx2:')) {
    const cached = localClipResultCache.get(taskId);
    if (!cached) {
      return { state: 'fail', error: `local clip result not found for task ${taskId} (cache miss — startVideoTask did not run or already drained)` };
    }
    localClipResultCache.delete(taskId);
    if (cached.state === 'success') {
      return { state: 'success', videoUrl: cached.videoUrl, costTime: cached.costTime };
    }
    return { state: 'fail', error: cached.error };
  }

  try {
    const response = await fetch(`${KIE_API_URL}/recordInfo?taskId=${taskId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      console.error(`[I2V] Status check failed: ${response.status}`);
      return { state: 'pending' };
    }

    const data = await response.json() as any;

    if (data.code !== 200 || !data.data) {
      return { state: 'pending' };
    }

    const task = data.data;

    if (task.state === 'success') {
      // Parse resultJson to get video URL
      let videoUrl: string | undefined;
      try {
        const result = JSON.parse(task.resultJson);
        videoUrl = result.resultUrls?.[0];
      } catch {
        console.error(`[I2V] Failed to parse resultJson for task ${taskId}`);
      }

      if (!videoUrl) {
        console.error(`[I2V] Task ${taskId} completed but no video URL`);
        return { state: 'fail', error: 'No video URL in result' };
      }

      console.log(`[I2V] Task ${taskId} completed: ${videoUrl}`);
      return {
        state: 'success',
        videoUrl,
        costTime: task.costTime
      };
    } else if (task.state === 'fail') {
      const errorMsg = task.failMsg || 'Task failed';
      console.error(`[I2V] Task ${taskId} failed:`, errorMsg);
      return { state: 'fail', error: errorMsg };
    } else if (['waiting', 'queuing', 'generating'].includes(task.state)) {
      return { state: 'pending' };
    }

    return { state: 'pending' };
  } catch (err) {
    console.error(`[I2V] Error checking task ${taskId}:`, err);
    return { state: 'pending' };
  }
}

// Copy video from Kie.ai URL to our Supabase storage with fade in/out effects
async function copyToSupabase(
  videoUrl: string,
  projectId: string,
  clipIndex: number
): Promise<string> {
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `clip_input_${clipIndex}_${Date.now()}.mp4`);
  const outputPath = path.join(tempDir, `clip_output_${clipIndex}_${Date.now()}.mp4`);

  try {
    const supabase = getSupabaseClient();

    // Download video from Kie.ai
    const response = await fetch(videoUrl);
    if (!response.ok) {
      throw new Error(`Failed to download video: ${response.status}`);
    }

    const videoBuffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(inputPath, videoBuffer);

    // Get video duration for fade out timing
    const { stdout: durationOutput } = await execAsync(
      `"${FFPROBE_PATH}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`
    );
    const duration = parseFloat(durationOutput.trim());

    if (!isNaN(duration) && duration > FADE_DURATION * 2) {
      // Apply fade in at start and fade out at end
      const fadeOutStart = duration - FADE_DURATION;
      console.log(`[I2V] Applying ${FADE_DURATION}s fade in/out to clip ${clipIndex + 1}`);

      await execAsync(
        `"${FFMPEG_PATH}" -y -i "${inputPath}" -vf "fade=t=in:st=0:d=${FADE_DURATION},fade=t=out:st=${fadeOutStart}:d=${FADE_DURATION}" -c:a copy "${outputPath}"`
      );
    } else {
      // Video too short for fades, just copy
      console.log(`[I2V] Clip ${clipIndex + 1} too short for fades, skipping`);
      fs.copyFileSync(inputPath, outputPath);
    }

    // Read processed video
    const processedBuffer = fs.readFileSync(outputPath);
    const filename = `clip_${String(clipIndex).padStart(3, '0')}.mp4`;
    const storagePath = `${projectId}/clips/${filename}`;

    // Upload to Supabase
    const { error } = await supabase.storage
      .from('generated-assets')
      .upload(storagePath, processedBuffer, {
        contentType: 'video/mp4',
        upsert: true
      });

    if (error) {
      console.error(`[I2V] Failed to upload to Supabase:`, error);
      return videoUrl;
    }

    // Get public URL with cache-busting timestamp
    const { data: urlData } = supabase.storage
      .from('generated-assets')
      .getPublicUrl(storagePath);

    // Add timestamp to bust browser/CDN cache on regeneration
    const urlWithCacheBust = `${urlData.publicUrl}?t=${Date.now()}`;
    console.log(`[I2V] Copied to Supabase: ${urlWithCacheBust}`);
    return urlWithCacheBust;
  } catch (err) {
    console.error(`[I2V] Error copying to Supabase:`, err);
    // Return original URL if copy fails
    return videoUrl;
  } finally {
    // Cleanup temp files
    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

// Extract the last frame from a video for seamless clip continuity
async function extractLastFrame(
  videoUrl: string,
  projectId: string,
  clipIndex: number
): Promise<string | null> {
  const tempDir = os.tmpdir();
  const videoPath = path.join(tempDir, `clip_${clipIndex}_${Date.now()}.mp4`);
  const framePath = path.join(tempDir, `frame_${clipIndex}_${Date.now()}.jpg`);

  try {
    console.log(`[I2V] Extracting last frame from clip ${clipIndex + 1}...`);

    // Download video to temp file
    const response = await fetch(videoUrl);
    if (!response.ok) {
      throw new Error(`Failed to download video: ${response.status}`);
    }
    const videoBuffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(videoPath, videoBuffer);

    // Get video duration using ffprobe (static binary)
    const { stdout: durationOutput } = await execAsync(
      `"${FFPROBE_PATH}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
    );
    const duration = parseFloat(durationOutput.trim());

    if (isNaN(duration) || duration <= 0) {
      throw new Error('Could not determine video duration');
    }

    // Extract the last frame (0.1 seconds before end for safety) using ffmpeg (static binary)
    const frameTime = Math.max(0, duration - 0.1);
    await execAsync(
      `"${FFMPEG_PATH}" -y -ss ${frameTime} -i "${videoPath}" -vframes 1 -q:v 2 "${framePath}"`
    );

    // Verify frame was created
    if (!fs.existsSync(framePath)) {
      throw new Error('Frame extraction failed - no output file');
    }

    // Upload frame to Supabase
    const supabase = getSupabaseClient();
    const frameBuffer = fs.readFileSync(framePath);
    const storagePath = `${projectId}/clips/frames/frame_${String(clipIndex).padStart(3, '0')}.jpg`;

    const { error: uploadError } = await supabase.storage
      .from('generated-assets')
      .upload(storagePath, frameBuffer, {
        contentType: 'image/jpeg',
        upsert: true
      });

    if (uploadError) {
      console.error(`[I2V] Failed to upload frame:`, uploadError);
      return null;
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('generated-assets')
      .getPublicUrl(storagePath);

    console.log(`[I2V] Extracted last frame: ${urlData.publicUrl}`);
    return urlData.publicUrl;

  } catch (err) {
    console.error(`[I2V] Error extracting last frame:`, err);
    return null;
  } finally {
    // Cleanup temp files
    try {
      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      if (fs.existsSync(framePath)) fs.unlinkSync(framePath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      projectId,
      clips,
      stream = true,
      duration = CLIP_DURATION,
      resolution = CLIP_RESOLUTION
    }: GenerateVideoClipsRequest = req.body ?? {};

    // Layer 3 contract: error envelope { error: { code, message } } so the
    // boundary shape matches the local-inference Python servers. Validate
    // request shape BEFORE the KIE_API_KEY gate so empty/invalid inputs in
    // local mode return 400 (not 500 KIE_API_KEY missing).
    if (!clips || !Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'clips is required and must be a non-empty array' },
      });
    }

    if (!projectId) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'projectId is required' },
      });
    }

    // Validate that each clip has an imageUrl (required for I2V)
    const missingImages = clips.filter(c => !c.imageUrl);
    if (missingImages.length > 0) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `Missing imageUrl for clips: ${missingImages.map(c => c.index).join(', ')}. Generate images first.`,
        },
      });
    }

    // ZG-21 / Phase 2.8: probe LOCAL_LTX2_URL/healthz once per request. If
    // the local server is up + ready, route this request through it; if the
    // probe times out / is refused / returns non-2xx / non-ready, fall back
    // to Kie.ai (the default expected path until Monday 5080 lands). The
    // probe runs even when LOCAL_INFERENCE=false because callers may set
    // the env var asymmetrically; probeLtx2Health short-circuits in that
    // case via its localInferenceConfig.enabled guard.
    const useLocal = await probeLtx2Health();

    // Kie.ai credentials are only needed for the remote (queue) code path.
    // Local mode talks to the on-device LTX-2 server and does not require
    // any Kie.ai credentials. Pass an empty string downstream so handler
    // signatures don't have to widen — startVideoTask's local branch
    // ignores the apiKey argument.
    const envKieKey = process.env.KIE_API_KEY;
    if (!envKieKey && !useLocal) {
      return res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'KIE_API_KEY not configured (and local LTX-2 probe failed)' },
      });
    }
    const kieApiKey: string = envKieKey ?? '';

    // Validate duration (v1-pro-fast supports 5 or 10 seconds)
    const validDuration = [5, 10].includes(duration) ? duration : CLIP_DURATION;

    const total = clips.length;
    console.log(`\n=== Generating ${total} video clips (image-first I2V) ===`);
    console.log(`Mode: ${useLocal ? 'LOCAL LTX-2' : 'Kie.ai (remote)'}, Duration: ${validDuration}s, Resolution: ${resolution}`);

    if (stream) {
      return handleStreamingClips(req, res, projectId, clips, total, kieApiKey, validDuration, resolution, useLocal);
    } else {
      return handleNonStreamingClips(req, res, projectId, clips, kieApiKey, validDuration, resolution, useLocal);
    }

  } catch (error) {
    console.error('[I2V] Error in generate-video-clips:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ success: false, error: errorMessage });
  }
});

// Handle streaming video clip generation with rolling concurrency
async function handleStreamingClips(
  req: Request,
  res: Response,
  projectId: string,
  clips: ClipPrompt[],
  total: number,
  kieApiKey: string,
  duration: number,
  resolution: string,
  useLocal: boolean = false,
) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Keepalive heartbeat
  const heartbeatInterval = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeatInterval);
  };

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const POLL_INTERVAL = 3000; // 3 seconds
  const MAX_POLLING_TIME = 10 * 60 * 1000; // 10 minutes total
  const MAX_RETRIES = 5;  // Retry failed clips up to 5 times

  try {
    sendEvent({
      type: 'progress',
      completed: 0,
      total,
      message: `Starting video generation from images (I2V)...`
    });

    const allResults: ClipStatus[] = [];
    let nextClipIndex = 0;
    const activeTasks = new Map<string, { index: number; startTime: number; retryCount: number; clip: ClipPrompt }>();
    const startTime = Date.now();
    const retryQueue: { clip: ClipPrompt; retryCount: number }[] = [];

    // Helper to start next task
    const startNextTask = async (): Promise<void> => {
      let taskData: { clip: ClipPrompt; retryCount: number } | null = null;

      // First try retry queue, then main queue
      if (retryQueue.length > 0) {
        taskData = retryQueue.shift()!;
        console.log(`[I2V] Retrying clip ${taskData.clip.index} (attempt ${taskData.retryCount + 1})`);
      } else if (nextClipIndex < clips.length) {
        taskData = { clip: clips[nextClipIndex], retryCount: 0 };
        nextClipIndex++;
      }

      if (!taskData) return;

      try {
        const taskId = await startVideoTask(
          kieApiKey,
          taskData.clip.prompt,
          taskData.clip.index - 1,  // Convert to 0-indexed for filename
          taskData.clip.imageUrl,   // Source image for I2V
          duration,
          resolution,
          useLocal,
          projectId,
          sendEvent,
        );
        activeTasks.set(taskId, {
          index: taskData.clip.index,
          startTime: Date.now(),
          retryCount: taskData.retryCount,
          clip: taskData.clip
        });
        console.log(`[I2V] Started clip ${taskData.clip.index}/${total} (${activeTasks.size} active)`);
      } catch (err) {
        console.error(`[I2V] Failed to create task for clip ${taskData.clip.index}:`, err);
        if (taskData.retryCount < MAX_RETRIES) {
          retryQueue.push({ clip: taskData.clip, retryCount: taskData.retryCount + 1 });
        } else {
          allResults.push({
            taskId: '',
            index: taskData.clip.index,
            state: 'fail',
            error: err instanceof Error ? err.message : 'Failed to create task after retries',
            filename: `clip_${String(taskData.clip.index - 1).padStart(3, '0')}.mp4`
          });
        }
      }
    };

    // Fill initial window with tasks
    const initialBatch = Math.min(MAX_CONCURRENT_CLIPS, clips.length);
    console.log(`[I2V] Starting initial batch of ${initialBatch} clips...`);
    await Promise.all(Array.from({ length: initialBatch }, () => startNextTask()));

    // Poll active tasks and start new ones as they complete
    while ((activeTasks.size > 0 || retryQueue.length > 0) && Date.now() - startTime < MAX_POLLING_TIME) {
      const taskIds = Array.from(activeTasks.keys());

      // Check all active tasks in parallel
      const checkResults = await Promise.all(
        taskIds.map(async (taskId) => {
          const taskData = activeTasks.get(taskId)!;
          const status = await checkTaskStatus(kieApiKey, taskId);
          return { taskId, taskData, status };
        })
      );

      // Process completed tasks
      for (const { taskId, taskData, status } of checkResults) {
        if (status.state === 'success') {
          const durationSec = ((Date.now() - taskData.startTime) / 1000).toFixed(1);
          console.log(`[I2V] ✓ Clip ${taskData.index}/${total} completed in ${durationSec}s`);

          // Local mode: bytes were already uploaded inside startVideoTaskLocal
          // and `status.videoUrl` is the final /assets URL — skip the
          // Kie.ai-specific copyToSupabase fade-in/out pipeline (it would try
          // to re-fetch the local URL and re-upload to Supabase).
          const finalVideoUrl = useLocal
            ? status.videoUrl!
            : await copyToSupabase(status.videoUrl!, projectId, taskData.index - 1);

          allResults.push({
            taskId,
            index: taskData.index,
            state: 'success',
            videoUrl: finalVideoUrl,
            filename: `clip_${String(taskData.index - 1).padStart(3, '0')}.mp4`
          });

          activeTasks.delete(taskId);

          // Start next task in the queue
          await startNextTask();

          // Send progress update
          const completed = allResults.filter(r => r.state === 'success').length;
          sendEvent({
            type: 'progress',
            completed,
            total,
            message: `${completed}/${total} clips generated`,
            latestClip: {
              index: taskData.index,
              videoUrl: finalVideoUrl,
              generationTime: status.costTime
            }
          });

        } else if (status.state === 'fail') {
          console.error(`[I2V] ✗ Clip ${taskData.index}/${total} failed (attempt ${taskData.retryCount + 1}): ${status.error}`);

          activeTasks.delete(taskId);

          // Retry if not exceeded max retries
          if (taskData.retryCount < MAX_RETRIES) {
            retryQueue.push({ clip: taskData.clip, retryCount: taskData.retryCount + 1 });
            console.log(`[I2V] Queued clip ${taskData.index} for retry`);
          } else {
            allResults.push({
              taskId,
              index: taskData.index,
              state: 'fail',
              error: status.error,
              filename: `clip_${String(taskData.index - 1).padStart(3, '0')}.mp4`
            });
          }

          // Start next task
          await startNextTask();

          // Send progress update
          const completed = allResults.filter(r => r.state === 'success').length;
          const failed = allResults.filter(r => r.state === 'fail').length;
          sendEvent({
            type: 'progress',
            completed,
            total,
            message: `${completed}/${total} done${failed > 0 ? `, ${failed} failed` : ''}`
          });
        }
      }

      // Wait before next poll
      if (activeTasks.size > 0 || retryQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

        // If no active tasks but retries pending, start them
        while (activeTasks.size < MAX_CONCURRENT_CLIPS && retryQueue.length > 0) {
          await startNextTask();
        }
      }
    }

    // Timeout check
    if (activeTasks.size > 0) {
      console.warn(`[I2V] Timeout: ${activeTasks.size} clips still pending after ${MAX_POLLING_TIME / 1000}s`);
      for (const [taskId, taskData] of activeTasks) {
        allResults.push({
          taskId,
          index: taskData.index,
          state: 'fail',
          error: 'Task timed out',
          filename: `clip_${String(taskData.index - 1).padStart(3, '0')}.mp4`
        });
      }
    }

    // Sort results by original index
    const sortedResults = [...allResults].sort((a, b) => a.index - b.index);
    // Layer 6 lifecycle expects `clip.clipUrl`; legacy callers read `clip.videoUrl`.
    // Emit both so neither breaks.
    const successfulClips = sortedResults
      .filter(r => r.state === 'success' && r.videoUrl)
      .map(r => ({
        index: r.index,
        clipUrl: r.videoUrl!,
        videoUrl: r.videoUrl!,
        filename: r.filename,
        startSeconds: (r.index - 1) * duration,
        endSeconds: r.index * duration
      }));

    const failedCount = sortedResults.filter(r => r.state === 'fail').length;

    console.log(`\n=== Video clip generation complete (${useLocal ? 'local LTX-2' : 'Kie.ai'}) ===`);
    console.log(`Success: ${successfulClips.length}/${total}`);
    console.log(`Failed: ${failedCount}/${total}`);

    // Save cost to Supabase (Seedance: $0.08/clip flat rate; cost-tracker
    // applies LOCAL_INFERENCE=0 when useLocal is true via its own rate map).
    if (projectId && successfulClips.length > 0) {
      saveCost({
        projectId,
        source: 'manual',
        step: 'video_clips',
        service: 'seedance',
        units: successfulClips.length,
        unitType: 'clips',
      }).catch(err => console.error('[cost-tracker] Failed to save video clips cost:', err));
    }

    sendEvent({
      type: 'complete',
      success: true,
      clips: successfulClips,
      total: successfulClips.length,
      failed: failedCount,
      clipDuration: duration,
      totalDuration: successfulClips.length * duration
    });

    cleanup();
    res.end();

  } catch (err) {
    console.error('[I2V] Stream error:', err);
    sendEvent({
      type: 'error',
      error: err instanceof Error ? err.message : 'Clip generation failed'
    });
    cleanup();
    res.end();
  }
}

// Handle non-streaming video clip generation
async function handleNonStreamingClips(
  req: Request,
  res: Response,
  projectId: string,
  clips: ClipPrompt[],
  kieApiKey: string,
  duration: number,
  resolution: string,
  useLocal: boolean = false,
) {
  try {
    // Start all tasks
    const taskData = await Promise.all(
      clips.map(async (clip) => {
        const taskId = await startVideoTask(
          kieApiKey,
          clip.prompt,
          clip.index - 1,
          clip.imageUrl,  // Source image for I2V
          duration,
          resolution,
          useLocal,
          projectId,
          // No SSE channel in non-streaming mode; per-clip heartbeats are
          // dropped (the JSON response carries the final result anyway).
          undefined,
        );
        return { taskId, clip };
      })
    );

    // Poll all in parallel
    const maxPollingTime = 10 * 60 * 1000; // 10 minutes
    const pollInterval = 3000;
    const startTime = Date.now();
    const results: { index: number; videoUrl: string | null; error?: string }[] = [];
    const completed: boolean[] = new Array(taskData.length).fill(false);

    while (Date.now() - startTime < maxPollingTime) {
      const pendingIndices = completed.map((c, i) => c ? -1 : i).filter(i => i >= 0);

      if (pendingIndices.length === 0) break;

      const checks = await Promise.all(
        pendingIndices.map(async (i) => {
          const { taskId, clip } = taskData[i];
          const status = await checkTaskStatus(kieApiKey, taskId);
          return { index: i, clip, taskId, status };
        })
      );

      for (const { index, clip, taskId, status } of checks) {
        if (status.state === 'success' || status.state === 'fail') {
          completed[index] = true;

          let videoUrl = status.videoUrl || null;
          if (videoUrl && !useLocal) {
            // Local mode: bytes already uploaded inside startVideoTaskLocal,
            // status.videoUrl is the final /assets URL — skip Kie.ai's
            // copyToSupabase pipeline.
            videoUrl = await copyToSupabase(videoUrl, projectId, clip.index - 1);
          }

          results.push({
            index: clip.index,
            videoUrl,
            error: status.error
          });
        }
      }

      if (pendingIndices.length > 0) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }

    // Sort by index
    results.sort((a, b) => a.index - b.index);

    // Layer 6 lifecycle expects `clip.clipUrl`; legacy callers read `clip.videoUrl`.
    const successfulClips = results
      .filter(r => r.videoUrl)
      .map(r => ({
        index: r.index,
        clipUrl: r.videoUrl!,
        videoUrl: r.videoUrl!,
        filename: `clip_${String(r.index - 1).padStart(3, '0')}.mp4`,
        startSeconds: (r.index - 1) * duration,
        endSeconds: r.index * duration
      }));

    console.log(`[I2V] Generated ${successfulClips.length}/${clips.length} video clips (${useLocal ? 'local' : 'Kie.ai'})`);

    // Save cost to Supabase (Seedance: $0.08/clip flat rate)
    if (projectId && successfulClips.length > 0) {
      saveCost({
        projectId,
        source: 'manual',
        step: 'video_clips',
        service: 'seedance',
        units: successfulClips.length,
        unitType: 'clips',
      }).catch(err => console.error('[cost-tracker] Failed to save video clips cost:', err));
    }

    return res.json({
      success: true,
      clips: successfulClips,
      total: successfulClips.length,
      failed: results.filter(r => !r.videoUrl).length
    });

  } catch (err) {
    console.error('[I2V] Non-streaming clip generation error:', err);
    return res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Clip generation failed'
    });
  }
}

// Handle sequential video clip generation with frame continuity
// Each clip's last frame becomes the next clip's start frame for seamless flow
async function handleSequentialClipsWithContinuity(
  req: Request,
  res: Response,
  projectId: string,
  clips: ClipPrompt[],
  total: number,
  kieApiKey: string,
  duration: number,
  resolution: string
) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const heartbeatInterval = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeatInterval);
  };

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const POLL_INTERVAL = 3000;
  const MAX_POLL_TIME_PER_CLIP = 5 * 60 * 1000; // 5 minutes per clip

  try {
    console.log(`\n=== Sequential clip generation with frame continuity ===`);
    console.log(`Generating ${total} clips sequentially (last frame → next clip's start frame)`);

    sendEvent({
      type: 'progress',
      completed: 0,
      total,
      message: `Starting sequential generation (seamless flow mode)...`
    });

    const successfulClips: { index: number; videoUrl: string; filename: string; startSeconds: number; endSeconds: number }[] = [];
    let lastFrameUrl: string | null = null;
    let failedCount = 0;

    // Process clips one at a time, passing last frame to next clip
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const clipIndex = clip.index - 1; // 0-indexed for filename

      sendEvent({
        type: 'progress',
        completed: successfulClips.length,
        total,
        message: `Generating clip ${i + 1}/${total}${lastFrameUrl ? ' (with continuity frame)' : ''}...`
      });

      try {
        // Start task with source image (image-first I2V approach)
        const taskId = await startVideoTask(
          kieApiKey,
          clip.prompt,
          clipIndex,
          clip.imageUrl,  // Source image for I2V
          duration,
          resolution
        );

        console.log(`[I2V] Started clip ${i + 1}/${total}${lastFrameUrl ? ' (with start frame)' : ''}`);

        // Poll until complete
        const pollStart = Date.now();
        let videoUrl: string | null = null;

        while (Date.now() - pollStart < MAX_POLL_TIME_PER_CLIP) {
          const status = await checkTaskStatus(kieApiKey, taskId);

          if (status.state === 'success' && status.videoUrl) {
            videoUrl = status.videoUrl;
            const durationSec = ((Date.now() - pollStart) / 1000).toFixed(1);
            console.log(`[I2V] ✓ Clip ${i + 1}/${total} completed in ${durationSec}s`);
            break;
          } else if (status.state === 'fail') {
            console.error(`[I2V] ✗ Clip ${i + 1}/${total} failed: ${status.error}`);
            break;
          }

          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        }

        if (videoUrl) {
          // Copy video to Supabase
          const supabaseUrl = await copyToSupabase(videoUrl, projectId, clipIndex);

          successfulClips.push({
            index: clip.index,
            videoUrl: supabaseUrl,
            filename: `clip_${String(clipIndex).padStart(3, '0')}.mp4`,
            startSeconds: (clip.index - 1) * duration,
            endSeconds: clip.index * duration
          });

          // Extract last frame for next clip (except for the last clip)
          if (i < clips.length - 1) {
            sendEvent({
              type: 'progress',
              completed: successfulClips.length,
              total,
              message: `Extracting continuity frame from clip ${i + 1}...`
            });

            lastFrameUrl = await extractLastFrame(supabaseUrl, projectId, clipIndex);

            if (lastFrameUrl) {
              console.log(`[I2V] Extracted continuity frame for clip ${i + 2}`);
            } else {
              console.warn(`[I2V] Failed to extract frame, next clip will start fresh`);
            }
          }

          sendEvent({
            type: 'progress',
            completed: successfulClips.length,
            total,
            message: `${successfulClips.length}/${total} clips generated`,
            latestClip: {
              index: clip.index,
              videoUrl: supabaseUrl
            }
          });

        } else {
          console.error(`[I2V] Clip ${i + 1} timed out or failed`);
          failedCount++;
          // Continue to next clip without frame continuity
          lastFrameUrl = null;
        }

      } catch (err) {
        console.error(`[I2V] Error generating clip ${i + 1}:`, err);
        failedCount++;
        lastFrameUrl = null; // Reset frame continuity on error
      }
    }

    console.log(`\n=== Sequential generation complete ===`);
    console.log(`Success: ${successfulClips.length}/${total}`);
    console.log(`Failed: ${failedCount}/${total}`);

    // Save cost to Supabase (Seedance: $0.08/clip flat rate)
    if (projectId && successfulClips.length > 0) {
      saveCost({
        projectId,
        source: 'manual',
        step: 'video_clips',
        service: 'seedance',
        units: successfulClips.length,
        unitType: 'clips',
      }).catch(err => console.error('[cost-tracker] Failed to save video clips cost:', err));
    }

    sendEvent({
      type: 'complete',
      success: true,
      clips: successfulClips,
      total: successfulClips.length,
      failed: failedCount,
      clipDuration: duration,
      totalDuration: successfulClips.length * duration,
      mode: 'sequential_with_continuity'
    });

    cleanup();
    res.end();

  } catch (err) {
    console.error('[I2V] Sequential generation error:', err);
    sendEvent({
      type: 'error',
      error: err instanceof Error ? err.message : 'Sequential clip generation failed'
    });
    cleanup();
    res.end();
  }
}

export default router;
