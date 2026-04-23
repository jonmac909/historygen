/**
 * ImageBind RunPod Client
 *
 * Calls the ImageBind RunPod worker to generate visual embeddings from frames.
 */

// RunPod endpoint for ImageBind worker
// TODO: Set this after deploying the worker
const IMAGEBIND_ENDPOINT_ID = process.env.RUNPOD_IMAGEBIND_ENDPOINT_ID || '';
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY || '';

const RUNPOD_BASE_URL = 'https://api.runpod.ai/v2';

export interface ImageBindRequest {
  frameUrls: string[];
}

export interface ImageBindResponse {
  embeddings: number[][];      // Array of 768-dim vectors
  failedIndices: number[];     // Indices that failed to process
  embeddingDim: number;        // Should be 768
  count: number;               // Number of embeddings
}

// RunPod API response types
interface RunPodJobStatus {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  output?: {
    embeddings?: number[][];
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
    const statusUrl = `${RUNPOD_BASE_URL}/${IMAGEBIND_ENDPOINT_ID}/status/${jobId}`;

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
 * Generate ImageBind embeddings for a batch of frame URLs
 */
export async function generateEmbeddings(
  frameUrls: string[],
  options: {
    batchSize?: number;
    maxWaitMs?: number;
    maxConcurrent?: number;
    onProgress?: (percent: number) => void;
  } = {}
): Promise<ImageBindResponse> {
  const {
    batchSize = 100,         // Process 100 frames per RunPod call
    maxWaitMs = 600000,      // 10 minute timeout
    maxConcurrent = 10,      // Match RunPod worker allocation
    onProgress,
  } = options;

  if (!IMAGEBIND_ENDPOINT_ID) {
    throw new Error('RUNPOD_IMAGEBIND_ENDPOINT_ID not configured');
  }

  if (!RUNPOD_API_KEY) {
    throw new Error('RUNPOD_API_KEY not configured');
  }

  console.log(`[imagebind-client] Generating embeddings for ${frameUrls.length} frames (${maxConcurrent} workers)`);

  // Split into batches
  const batches: string[][] = [];
  for (let i = 0; i < frameUrls.length; i += batchSize) {
    batches.push(frameUrls.slice(i, i + batchSize));
  }

  console.log(`[imagebind-client] Processing ${batches.length} batches with rolling concurrency (max ${maxConcurrent})`);

  // Process batches with rolling concurrency
  const allEmbeddings: number[][] = [];
  const allFailedIndices: number[] = [];
  let completedBatches = 0;

  const processBatch = async (batch: string[], batchIndex: number): Promise<void> => {
    const batchOffset = batchIndex * batchSize;

    // Submit job to RunPod
    const runUrl = `${RUNPOD_BASE_URL}/${IMAGEBIND_ENDPOINT_ID}/run`;

    const response = await fetch(runUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RUNPOD_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: {
          frame_urls: batch,
        },
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

    console.log(`[imagebind-client] Batch ${batchIndex + 1}/${batches.length} submitted: ${jobData.id}`);

    // Poll for completion
    const result = await pollRunPodJob(jobData.id, maxWaitMs);

    if (result?.error) {
      throw new Error(`ImageBind worker error (batch ${batchIndex + 1}): ${result.error}`);
    }

    // Collect results
    if (result?.embeddings) {
      allEmbeddings.push(...result.embeddings);
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

    console.log(`[imagebind-client] Batch ${batchIndex + 1}/${batches.length} completed (${completedBatches}/${batches.length} total)`);
  };

  // Rolling concurrency: process maxConcurrent batches at a time
  for (let i = 0; i < batches.length; i += maxConcurrent) {
    const batchChunk = batches.slice(i, i + maxConcurrent);
    const batchPromises = batchChunk.map((batch, idx) => processBatch(batch, i + idx));

    await Promise.all(batchPromises);
  }

  console.log(`[imagebind-client] Generated ${allEmbeddings.length} embeddings`);

  return {
    embeddings: allEmbeddings,
    failedIndices: allFailedIndices,
    embeddingDim: allEmbeddings[0]?.length || 768,
    count: allEmbeddings.length,
  };
}

/**
 * Check if ImageBind endpoint is configured and available
 */
export async function checkImageBindAvailability(): Promise<{
  available: boolean;
  endpointId?: string;
  error?: string;
}> {
  if (!IMAGEBIND_ENDPOINT_ID) {
    return {
      available: false,
      error: 'RUNPOD_IMAGEBIND_ENDPOINT_ID not configured',
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
    const healthUrl = `${RUNPOD_BASE_URL}/${IMAGEBIND_ENDPOINT_ID}/health`;

    const response = await fetch(healthUrl, {
      headers: {
        'Authorization': `Bearer ${RUNPOD_API_KEY}`,
      },
    });

    if (response.ok) {
      return {
        available: true,
        endpointId: IMAGEBIND_ENDPOINT_ID,
      };
    }

    return {
      available: false,
      endpointId: IMAGEBIND_ENDPOINT_ID,
      error: `Endpoint returned ${response.status}`,
    };
  } catch (err: any) {
    return {
      available: false,
      endpointId: IMAGEBIND_ENDPOINT_ID,
      error: err.message,
    };
  }
}
