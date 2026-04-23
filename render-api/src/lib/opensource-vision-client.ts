/**
 * Open-Source Vision RunPod Client
 *
 * Calls the LLaVA-NeXT-Video RunPod worker to generate visual descriptions from frames.
 * Provides drop-in replacement for Claude Vision API with 98% cost savings.
 */

// RunPod endpoint for LLaVA-NeXT-Video worker
const VISION_ENDPOINT_ID = process.env.RUNPOD_VISION_ENDPOINT_ID || '';
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY || '';

const RUNPOD_BASE_URL = 'https://api.runpod.ai/v2';

export interface VisionDescriptionRequest {
  frameUrls: string[];
}

export interface VisionDescriptionResponse {
  descriptions: string[];      // Array of description strings
  failedIndices: number[];      // Indices that failed to process
  count: number;                // Number of descriptions
}

// RunPod API response types
interface RunPodJobStatus {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  output?: {
    descriptions?: string[];
    failed_indices?: number[];
    error?: string;
  };
  error?: string;
}

interface RunPodJobSubmission {
  id?: string;
  status?: string;
}

/**
 * Poll for RunPod job completion
 */
async function pollRunPodJob(jobId: string, maxWaitMs: number = 600000): Promise<RunPodJobStatus['output']> {
  const startTime = Date.now();
  const pollInterval = 2000; // 2 seconds

  while (Date.now() - startTime < maxWaitMs) {
    const statusUrl = `${RUNPOD_BASE_URL}/${VISION_ENDPOINT_ID}/status/${jobId}`;

    const response = await fetch(statusUrl, {
      headers: {
        'Authorization': `Bearer ${RUNPOD_API_KEY}`,
      },
    });

    if (!response.ok) {
      throw new Error(`RunPod status check failed: ${response.status}`);
    }

    const data = await response.json() as RunPodJobStatus;

    if (data.status === 'COMPLETED') {
      return data.output;
    }

    if (data.status === 'FAILED') {
      throw new Error(`RunPod job failed: ${data.error || 'Unknown error'}`);
    }

    // Wait before polling again
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new Error(`RunPod job timed out after ${maxWaitMs}ms`);
}

/**
 * Generate visual descriptions for a batch of frame URLs
 *
 * @param frameUrls - Array of publicly accessible frame image URLs
 * @param options - Configuration options
 * @returns Array of visual descriptions with metadata
 */
export async function generateDescriptions(
  frameUrls: string[],
  options: {
    batchSize?: number;
    maxWaitMs?: number;
    maxConcurrent?: number;
    onProgress?: (percent: number) => void;
    useBase64?: boolean;        // Encode frames as base64 (eliminates network I/O in worker)
  } = {}
): Promise<VisionDescriptionResponse> {
  const {
    batchSize = 10,             // Process 10 frames per RunPod call (match Claude Vision)
    maxWaitMs = 600000,         // 10 minute timeout
    maxConcurrent = 10,         // Match worker allocation (updated to 10)
    onProgress,
    useBase64 = true,           // Default to base64 mode (faster)
  } = options;

  if (!VISION_ENDPOINT_ID) {
    throw new Error('RUNPOD_VISION_ENDPOINT_ID not configured');
  }

  if (!RUNPOD_API_KEY) {
    throw new Error('RUNPOD_API_KEY not configured');
  }

  console.log(`[opensource-vision-client] Generating descriptions for ${frameUrls.length} frames (${maxConcurrent} workers)`);

  // Split into batches
  const batches: string[][] = [];
  for (let i = 0; i < frameUrls.length; i += batchSize) {
    batches.push(frameUrls.slice(i, i + batchSize));
  }

  console.log(`[opensource-vision-client] Processing ${batches.length} batches with rolling concurrency (max ${maxConcurrent})`);

  // Process batches with rolling concurrency
  const allDescriptions: string[] = [];
  const allFailedIndices: number[] = [];
  let completedBatches = 0;

  const processBatch = async (batch: string[], batchIndex: number): Promise<void> => {
    const batchOffset = batchIndex * batchSize;

    let payload: any;

    if (useBase64) {
      // Download frames from Supabase and convert to base64 (eliminates worker network I/O)
      console.log(`[opensource-vision-client] Downloading and encoding batch ${batchIndex + 1}/${batches.length}`);
      const frameDataArray: string[] = [];

      for (const frameUrl of batch) {
        const response = await fetch(frameUrl);
        if (!response.ok) {
          throw new Error(`Failed to download frame: ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        frameDataArray.push(base64);
      }

      payload = {
        frame_data: frameDataArray,
        format: 'base64'
      };
    } else {
      // Pass URLs directly (existing behavior)
      payload = {
        frame_urls: batch
      };
    }

    // Submit job to RunPod
    const runUrl = `${RUNPOD_BASE_URL}/${VISION_ENDPOINT_ID}/run`;

    const response = await fetch(runUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RUNPOD_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: payload,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`RunPod submission failed (batch ${batchIndex + 1}): ${response.status} - ${errorText}`);
    }

    const jobData = await response.json() as RunPodJobSubmission;

    if (!jobData.id) {
      throw new Error(`RunPod did not return a job ID (batch ${batchIndex + 1})`);
    }

    console.log(`[opensource-vision-client] Batch ${batchIndex + 1}/${batches.length} submitted: ${jobData.id}`);

    // Poll for completion
    const result = await pollRunPodJob(jobData.id, maxWaitMs);

    if (result?.error) {
      throw new Error(`Vision worker error (batch ${batchIndex + 1}): ${result.error}`);
    }

    // Collect results
    if (result?.descriptions) {
      allDescriptions.push(...result.descriptions);
    }

    if (result?.failed_indices) {
      // Adjust indices for batch offset
      allFailedIndices.push(...result.failed_indices.map((idx: number) => idx + batchOffset));
    }

    // Report progress
    completedBatches++;
    if (onProgress) {
      const percent = Math.round((completedBatches / batches.length) * 100);
      onProgress(percent);
    }

    console.log(`[opensource-vision-client] Batch ${batchIndex + 1}/${batches.length} completed (${completedBatches}/${batches.length} total)`);
  };

  // Rolling concurrency: process maxConcurrent batches at a time
  for (let i = 0; i < batches.length; i += maxConcurrent) {
    const batchChunk = batches.slice(i, i + maxConcurrent);
    const batchPromises = batchChunk.map((batch, idx) => processBatch(batch, i + idx));

    await Promise.all(batchPromises);
  }

  console.log(`[opensource-vision-client] Generated ${allDescriptions.length} descriptions`);

  return {
    descriptions: allDescriptions,
    failedIndices: allFailedIndices,
    count: allDescriptions.length,
  };
}

/**
 * Check if open-source vision endpoint is configured and available
 */
export async function checkVisionAvailability(): Promise<{
  available: boolean;
  endpointId?: string;
  error?: string;
}> {
  if (!VISION_ENDPOINT_ID) {
    return {
      available: false,
      error: 'RUNPOD_VISION_ENDPOINT_ID not configured',
    };
  }

  if (!RUNPOD_API_KEY) {
    return {
      available: false,
      error: 'RUNPOD_API_KEY not configured',
    };
  }

  try {
    // Check endpoint health
    const healthUrl = `${RUNPOD_BASE_URL}/${VISION_ENDPOINT_ID}/health`;

    const response = await fetch(healthUrl, {
      headers: {
        'Authorization': `Bearer ${RUNPOD_API_KEY}`,
      },
    });

    if (response.ok) {
      return {
        available: true,
        endpointId: VISION_ENDPOINT_ID,
      };
    }

    return {
      available: false,
      endpointId: VISION_ENDPOINT_ID,
      error: `Endpoint returned ${response.status}`,
    };
  } catch (err: any) {
    return {
      available: false,
      endpointId: VISION_ENDPOINT_ID,
      error: err.message,
    };
  }
}
