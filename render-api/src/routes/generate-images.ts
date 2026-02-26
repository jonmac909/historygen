import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { saveCost } from '../lib/cost-tracker';
import { imageGenerationConfig } from '../lib/runtime-config';
import { saveImagesToProject } from '../lib/supabase-project';

const router = Router();

// RunPod Z-Image endpoint configuration
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ZIMAGE_ENDPOINT_ID;
const RUNPOD_API_URL = RUNPOD_ENDPOINT_ID ? `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}` : null;

interface ImagePromptWithTiming {
  index: number;
  prompt: string;
  startTime: string;
  endTime: string;
}

interface GenerateImagesRequest {
  prompts: string[] | ImagePromptWithTiming[];
  quality: string;
  aspectRatio?: string;
  stream?: boolean;
  projectId?: string;
  topic?: string;  // Era/period constraint (e.g., "Regency England 1810s")
  subjectFocus?: string;  // Who the story focuses on (e.g., "servants, housemaids")
}

interface JobStatus {
  jobId: string;
  index: number;
  state: 'pending' | 'success' | 'fail';
  imageUrl?: string;
  error?: string;
  filename?: string;
}

type RunpodRunResponse = { id: string };
type RunpodStatusResponse = {
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'IN_PROGRESS' | string;
  output?: { image_base64?: string; error?: string };
  error?: string;
};

const isRunpodRunResponse = (data: unknown): data is RunpodRunResponse => {
  return typeof data === 'object' && data !== null && 'id' in data && typeof (data as { id?: unknown }).id === 'string';
};

const isRunpodStatusResponse = (data: unknown): data is RunpodStatusResponse => {
  return typeof data === 'object' && data !== null && 'status' in data;
};

// Safety terms - CRITICAL for preventing inappropriate content
// Z-Image currently ignores negative_prompt but we keep it in case they add support
// SCENE COMES FIRST for priority, then style suffix
// ERA-AGNOSTIC: Works for Vikings, Regency, Ancient Egypt, etc.
const STYLE_SUFFIX = ", cinematic romantic historical oil painting style, natural period-appropriate lighting, fully clothed in modest period-appropriate attire, peaceful cozy mood, museum-quality fine art, no modern vehicles, no electricity, no streetlights, no kissing, no romantic embracing";
const NEGATIVE_PROMPT = "kissing, kiss, embracing, romantic contact, nudity, nude, naked, bare skin, revealing clothing, violence, gore, blood, horror, scary, dark, car, cars, automobile, automobiles, modern vehicles, trucks, buses, motorcycles, streetlights, electric lights";

// Detect placeholder prompts that should NOT be used for image generation
function isPlaceholderPrompt(prompt: string): boolean {
  // Match "Scene X", "Scene XX", "Scene XXX" patterns (placeholder prompts)
  const placeholderPattern = /^Scene\s+\d+$/i;
  return placeholderPattern.test(prompt.trim());
}

// Start a RunPod job for Z-Image generation
async function startImageJob(apiKey: string, prompt: string, quality: string, aspectRatio: string): Promise<string> {
  // SCENE FIRST: Put the actual scene description first so Z-Image prioritizes it
  // Style suffix comes after to add the oil painting aesthetic without overriding the scene
  const safePrompt = `${prompt}${STYLE_SUFFIX}`;
  console.log(`Starting RunPod job for: ${safePrompt.substring(0, 80)}...`);

  const response = await fetch(`${RUNPOD_API_URL}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: {
        prompt: safePrompt,
        negative_prompt: NEGATIVE_PROMPT,  // Currently ignored by Z-Image but kept for future
        quality: quality === "high" ? "high" : "basic",
        aspectRatio,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('RunPod job creation error:', response.status, errorText);
    throw new Error(`Failed to start image job: ${response.status}`);
  }

  const data = await response.json();

  if (!isRunpodRunResponse(data)) {
    throw new Error('RunPod job creation failed: no job ID returned');
  }

  console.log(`RunPod job created: ${data.id}`);
  return data.id;
}

// Check RunPod job status and upload image if complete
async function checkJobStatus(
  apiKey: string,
  jobId: string,
  supabaseUrl: string,
  supabaseKey: string,
  customFilename?: string,
  projectId?: string
): Promise<{ state: string; imageUrl?: string; error?: string }> {
  try {
    const response = await fetch(`${RUNPOD_API_URL}/status/${jobId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      console.error(`RunPod status check failed: ${response.status}`);
      return { state: 'pending' };
    }

    const data = await response.json();

    if (!isRunpodStatusResponse(data)) {
      return { state: 'fail', error: 'Invalid RunPod status response' };
    }

    if (data.status === 'COMPLETED' && data.output) {
      if (data.output.error) {
        console.error(`Job ${jobId} completed with error:`, data.output.error);
        return { state: 'fail', error: data.output.error };
      }

      const imageBase64 = data.output.image_base64;
      if (!imageBase64) {
        console.error(`Job ${jobId} completed but no image_base64 in output`);
        return { state: 'fail', error: 'No image data returned' };
      }

      try {
        const imageUrl = await uploadImageToStorage(imageBase64, supabaseUrl, supabaseKey, customFilename, projectId);
        console.log(`Job ${jobId} completed, uploaded to: ${imageUrl}`);
        return { state: 'success', imageUrl };
      } catch (uploadErr) {
        console.error(`Failed to upload image for job ${jobId}:`, uploadErr);
        return { state: 'fail', error: `Upload failed: ${uploadErr instanceof Error ? uploadErr.message : 'Unknown error'}` };
      }
    } else if (data.status === 'FAILED') {
      const errorMsg = data.error || data.output?.error || 'Job failed';
      console.error(`Job ${jobId} failed:`, errorMsg);
      return { state: 'fail', error: errorMsg };
    } else if (data.status === 'CANCELLED' || data.status === 'TIMED_OUT') {
      console.error(`Job ${jobId} ${data.status.toLowerCase()}`);
      return { state: 'fail', error: `Job ${data.status.toLowerCase()}` };
    }

    return { state: 'pending' };
  } catch (err) {
    console.error(`Error checking job ${jobId}:`, err);
    return { state: 'pending' };
  }
}

// Upload base64 image to Supabase storage
async function uploadImageToStorage(
  base64: string,
  supabaseUrl: string,
  supabaseKey: string,
  customFilename?: string,
  projectId?: string
): Promise<string> {
  const supabase = createClient(supabaseUrl, supabaseKey);

  const binaryString = Buffer.from(base64, 'base64').toString('binary');
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  let fileName: string;
  if (customFilename && projectId) {
    fileName = `${projectId}/images/${customFilename}`;
  } else if (customFilename) {
    fileName = `generated-images/${customFilename}`;
  } else {
    fileName = `generated-images/${crypto.randomUUID()}.png`;
  }

  console.log(`Uploading image to storage: ${fileName} (${bytes.length} bytes)`);

  const { error } = await supabase.storage
    .from('generated-assets')
    .upload(fileName, bytes, {
      contentType: 'image/png',
      upsert: true,
    });

  if (error) {
    console.error('Supabase storage upload error:', error);
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  const { data } = supabase.storage
    .from('generated-assets')
    .getPublicUrl(fileName);

  if (!data?.publicUrl) {
    throw new Error('Failed to get public URL for uploaded image');
  }

  return data.publicUrl;
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const runpodApiKey = process.env.RUNPOD_API_KEY;
    if (!runpodApiKey) {
      return res.status(500).json({ error: 'RUNPOD_API_KEY not configured' });
    }

    if (!RUNPOD_ENDPOINT_ID || !RUNPOD_API_URL) {
      return res.status(500).json({ error: 'RUNPOD_ZIMAGE_ENDPOINT_ID not configured' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: 'Supabase configuration missing' });
    }

    const { prompts, quality, aspectRatio = "16:9", stream = false, projectId, topic, subjectFocus }: GenerateImagesRequest = req.body;

    if (!prompts || prompts.length === 0) {
      return res.status(400).json({ error: 'No prompts provided' });
    }

    // Build era prefix for prompts (if provided)
    // This ensures images are anchored to the correct historical period
    let eraPrefix = '';
    if (topic) {
      eraPrefix = `${topic}. `;
      console.log(`[GenerateImages] Era prefix: "${eraPrefix}"`);
    }
    if (subjectFocus) {
      eraPrefix += `Depicting ${subjectFocus}. `;
      console.log(`[GenerateImages] Subject focus added to prefix`);
    }

    // Normalize prompts and prepend era prefix
    const isTimedPrompts = typeof prompts[0] === 'object' && 'prompt' in prompts[0];
    const normalizedPrompts: { prompt: string; filename: string }[] = isTimedPrompts
      ? (prompts as ImagePromptWithTiming[]).map(p => ({
          prompt: `${eraPrefix}${p.prompt}`,
          filename: `image_${String(p.index).padStart(3, '0')}_${p.startTime}_to_${p.endTime}.png`
        }))
      : (prompts as string[]).map((prompt, i) => ({
          prompt: `${eraPrefix}${prompt}`,
          filename: `image_${String(i + 1).padStart(3, '0')}.png`
        }));

    // CRITICAL: Validate prompts - reject placeholder prompts that would generate random/inappropriate content
    const placeholderPrompts = normalizedPrompts.filter(p => isPlaceholderPrompt(p.prompt));
    if (placeholderPrompts.length > 0) {
      const placeholderIndices = placeholderPrompts.map(p => p.filename).join(', ');
      console.error(`[BLOCKED] ${placeholderPrompts.length} placeholder prompts detected: ${placeholderIndices}`);
      return res.status(400).json({
        error: `Cannot generate images with placeholder prompts. ${placeholderPrompts.length} prompt(s) are missing descriptions (e.g., "Scene 46"). Please regenerate image prompts first.`,
        placeholderCount: placeholderPrompts.length,
        examples: placeholderPrompts.slice(0, 3).map(p => p.prompt)
      });
    }

    const total = normalizedPrompts.length;
    console.log(`Generating ${total} images with Z-Image (quality: ${quality}, aspect: ${aspectRatio}, stream: ${stream}, timed: ${isTimedPrompts})`);

    if (stream) {
      return handleStreamingImages(req, res, normalizedPrompts, total, runpodApiKey, quality, aspectRatio, supabaseUrl, supabaseKey, projectId);
    } else {
      return handleNonStreamingImages(req, res, normalizedPrompts, runpodApiKey, quality, aspectRatio, supabaseUrl, supabaseKey, projectId);
    }

  } catch (error) {
    console.error('Error in generate-images:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ success: false, error: errorMessage });
  }
});

// Handle streaming image generation with rolling concurrency window
async function handleStreamingImages(
  req: Request,
  res: Response,
  normalizedPrompts: { prompt: string; filename: string }[],
  total: number,
  runpodApiKey: string,
  quality: string,
  aspectRatio: string,
  supabaseUrl: string,
  supabaseKey: string,
  projectId?: string
) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Keepalive heartbeat to prevent connection timeout
  const heartbeatInterval = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeatInterval);
  };

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const MAX_CONCURRENT_JOBS = imageGenerationConfig.maxConcurrentJobs;
  const POLL_INTERVAL = imageGenerationConfig.pollIntervalMs;
  const MAX_POLLING_TIME = imageGenerationConfig.maxPollingTimeMs;
  const MAX_RETRIES = imageGenerationConfig.maxRetries;

  try {
    console.log(`\n=== Generating ${total} images with rolling concurrency (max ${MAX_CONCURRENT_JOBS} concurrent) ===`);

    sendEvent({
      type: 'progress',
      completed: 0,
      total,
      message: `Starting image generation (${MAX_CONCURRENT_JOBS} workers)...`
    });

    const allResults: JobStatus[] = [];
    let nextPromptIndex = 0;
    const activeJobs = new Map<string, { index: number; filename: string; startTime: number; retryCount: number }>();
    const startTime = Date.now();
    const retryQueue: { index: number; prompt: string; filename: string; retryCount: number }[] = [];

    // Helper to start next job (from queue or retry queue)
    const startNextJob = async (): Promise<void> => {
      let jobData: { index: number; prompt: string; filename: string; retryCount: number } | null = null;

      // First try retry queue, then main queue
      if (retryQueue.length > 0) {
        jobData = retryQueue.shift()!;
        console.log(`Retrying job ${jobData.index + 1} (attempt ${jobData.retryCount + 1})`);
      } else if (nextPromptIndex < normalizedPrompts.length) {
        const promptData = normalizedPrompts[nextPromptIndex];
        jobData = { index: nextPromptIndex, prompt: promptData.prompt, filename: promptData.filename, retryCount: 0 };
        nextPromptIndex++;
      }

      if (!jobData) return;

      try {
        const jobId = await startImageJob(runpodApiKey, jobData.prompt, quality, aspectRatio);
        activeJobs.set(jobId, { index: jobData.index, filename: jobData.filename, startTime: Date.now(), retryCount: jobData.retryCount });
        console.log(`Started job ${jobData.index + 1}/${total} (${activeJobs.size} active): ${jobData.filename}`);
      } catch (err) {
        console.error(`Failed to create job ${jobData.index + 1}:`, err);
        // Queue for retry if not exceeded max retries
        if (jobData.retryCount < MAX_RETRIES) {
          retryQueue.push({ ...jobData, retryCount: jobData.retryCount + 1 });
        } else {
          allResults.push({
            jobId: '',
            index: jobData.index,
            state: 'fail',
            error: err instanceof Error ? err.message : 'Failed to create job after retries',
            filename: jobData.filename
          });
        }
      }
    };

    // Fill initial window with jobs
    const initialBatch = Math.min(MAX_CONCURRENT_JOBS, normalizedPrompts.length);
    console.log(`Starting initial batch of ${initialBatch} jobs...`);
    await Promise.all(Array.from({ length: initialBatch }, () => startNextJob()));

    // Poll active jobs and start new ones as they complete
    while ((activeJobs.size > 0 || retryQueue.length > 0) && Date.now() - startTime < MAX_POLLING_TIME) {
      const jobIds = Array.from(activeJobs.keys());

      // Check all active jobs in parallel
      const checkResults = await Promise.all(
        jobIds.map(async (jobId) => {
          const jobData = activeJobs.get(jobId)!;
          const status = await checkJobStatus(
            runpodApiKey,
            jobId,
            supabaseUrl,
            supabaseKey,
            jobData.filename,
            projectId
          );
          return { jobId, jobData, status };
        })
      );

      // Process completed jobs
      for (const { jobId, jobData, status } of checkResults) {
        if (status.state === 'success') {
          const duration = ((Date.now() - jobData.startTime) / 1000).toFixed(1);
          console.log(`✓ Job ${jobData.index + 1}/${total} completed in ${duration}s: ${jobData.filename}`);

          allResults.push({
            jobId,
            index: jobData.index,
            state: 'success',
            imageUrl: status.imageUrl,
            filename: jobData.filename
          });

          activeJobs.delete(jobId);

          // Start next job in the queue
          await startNextJob();

          // Send progress update
          const completed = allResults.length;
          const batchNum = Math.floor(completed / MAX_CONCURRENT_JOBS) + 1;
          sendEvent({
            type: 'progress',
            completed,
            total,
            message: `Batch ${batchNum}: ${completed}/${total} images done`
          });

        } else if (status.state === 'fail') {
          console.error(`✗ Job ${jobData.index + 1}/${total} failed (attempt ${jobData.retryCount + 1}): ${status.error}`);

          activeJobs.delete(jobId);

          // Retry if not exceeded max retries
          if (jobData.retryCount < MAX_RETRIES) {
            const promptData = normalizedPrompts[jobData.index];
            retryQueue.push({
              index: jobData.index,
              prompt: promptData.prompt,
              filename: jobData.filename,
              retryCount: jobData.retryCount + 1
            });
            console.log(`Queued job ${jobData.index + 1} for retry (attempt ${jobData.retryCount + 2})`);
          } else {
            allResults.push({
              jobId,
              index: jobData.index,
              state: 'fail',
              error: status.error,
              filename: jobData.filename
            });
          }

          // Start next job
          await startNextJob();

          // Send progress update
          const completed = allResults.filter(r => r.state === 'success').length;
          const failed = allResults.filter(r => r.state === 'fail').length;
          const pending = retryQueue.length;
          sendEvent({
            type: 'progress',
            completed,
            total,
            message: `${completed}/${total} done${failed > 0 ? `, ${failed} failed` : ''}${pending > 0 ? `, ${pending} retrying` : ''}`
          });
        }
      }

      // Wait before next poll if there are still active jobs or retries pending
      if (activeJobs.size > 0 || retryQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

        // If no active jobs but retries pending, start them
        while (activeJobs.size < MAX_CONCURRENT_JOBS && retryQueue.length > 0) {
          await startNextJob();
        }
      }
    }

    // Timeout check
    if (activeJobs.size > 0) {
      console.warn(`Timeout: ${activeJobs.size} jobs still pending after ${MAX_POLLING_TIME / 1000}s`);
      for (const [jobId, jobData] of activeJobs) {
        allResults.push({
          jobId,
          index: jobData.index,
          state: 'fail',
          error: 'Job timed out',
          filename: jobData.filename
        });
      }
    }

    // Sort results by original index
    const sortedResults = [...allResults].sort((a, b) => a.index - b.index);

    // IMPORTANT: Preserve array positions - use null for failed images
    // This ensures clip N always maps to image N, even if some images failed
    const imagesWithPositions: (string | null)[] = new Array(total).fill(null);
    for (const r of sortedResults) {
      if (r.state === 'success' && r.imageUrl) {
        imagesWithPositions[r.index] = r.imageUrl;
      }
    }

    // For backward compatibility, also provide filtered array
    const successfulImages = imagesWithPositions.filter((url): url is string => url !== null);
    const failedCount = imagesWithPositions.filter(url => url === null).length;

    console.log(`\n=== Image generation complete ===`);
    console.log(`Success: ${successfulImages.length}/${total}`);
    console.log(`Failed: ${failedCount}/${total}`);

    // Save cost to Supabase (Z-Image: $0.035/image)
    if (projectId && successfulImages.length > 0) {
      saveCost({
        projectId,
        source: 'manual',
        step: 'images',
        service: 'z_image',
        units: successfulImages.length,
        unitType: 'images',
      }).catch(err => console.error('[cost-tracker] Failed to save images cost:', err));
    }

    // Save to project database (fire-and-forget - allows user to close browser)
    if (projectId && successfulImages.length > 0) {
      saveImagesToProject(projectId, successfulImages)
        .then(result => {
          if (result.success) {
            console.log(`[Images] Saved ${successfulImages.length} images to project ${projectId}`);
          } else {
            console.warn(`[Images] Failed to save to project: ${result.error}`);
          }
        })
        .catch(err => console.error(`[Images] Error saving to project:`, err));
    }

    sendEvent({
      type: 'complete',
      success: true,
      images: successfulImages,
      imagesWithPositions,  // Array with nulls preserving indices - use this for clip mapping
      total: successfulImages.length,
      failed: failedCount
    });

    cleanup();
    res.end();

  } catch (err) {
    console.error('Stream error:', err);
    sendEvent({
      type: 'error',
      error: err instanceof Error ? err.message : 'Generation failed'
    });
    cleanup();
    res.end();
  }
}

// Handle non-streaming image generation
async function handleNonStreamingImages(
  req: Request,
  res: Response,
  normalizedPrompts: { prompt: string; filename: string }[],
  runpodApiKey: string,
  quality: string,
  aspectRatio: string,
  supabaseUrl: string,
  supabaseKey: string,
  projectId?: string
) {
  const jobData: Array<{ jobId: string; filename: string; index: number }> = new Array(normalizedPrompts.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(imageGenerationConfig.maxConcurrentJobs, normalizedPrompts.length) }, async () => {
    while (nextIndex < normalizedPrompts.length) {
      const current = nextIndex++;
      const item = normalizedPrompts[current];
      const jobId = await startImageJob(runpodApiKey, item.prompt, quality, aspectRatio);
      jobData[current] = { jobId, filename: item.filename, index: current };
    }
  });
  await Promise.all(workers);

  // Poll all in parallel
  const maxPollingTime = 5 * 60 * 1000;
  const pollInterval = 3000;
  const startTime = Date.now();
  const results: (string | null)[] = new Array(jobData.length).fill(null);
  const completed: boolean[] = new Array(jobData.length).fill(false);

  while (Date.now() - startTime < maxPollingTime) {
    const pendingIndices = completed.map((c, i) => c ? -1 : i).filter(i => i >= 0);

    if (pendingIndices.length === 0) break;

    const checks = await Promise.all(
      pendingIndices.map(async (i) => {
        const { jobId, filename } = jobData[i];
        const status = await checkJobStatus(runpodApiKey, jobId, supabaseUrl, supabaseKey, filename, projectId);
        return { index: i, status };
      })
    );

    for (const { index, status } of checks) {
      if (status.state === 'success' || status.state === 'fail') {
        completed[index] = true;
        results[index] = status.imageUrl || null;
      }
    }

    if (pendingIndices.length > 0) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  // results array already preserves positions with null for failures
  const imageUrls = results.filter((url): url is string => url !== null);
  console.log(`Z-Image generated ${imageUrls.length} images`);

  // Save cost to Supabase (Z-Image: $0.035/image)
  if (projectId && imageUrls.length > 0) {
    saveCost({
      projectId,
      source: 'manual',
      step: 'images',
      service: 'z_image',
      units: imageUrls.length,
      unitType: 'images',
    }).catch(err => console.error('[cost-tracker] Failed to save images cost:', err));
  }

  return res.json({
    success: true,
    images: imageUrls,
    imagesWithPositions: results,  // Array with nulls preserving indices
  });
}

export default router;
