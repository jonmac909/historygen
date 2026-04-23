
const RUNPOD_REST_API = 'https://rest.runpod.io/v1';

interface EndpointUpdateConfig {
  workersMax: number;
  workersMin?: number;
}

/**
 * Updates a RunPod endpoint's worker configuration
 * Used to dynamically allocate all 10 workers to the active endpoint
 */
export async function updateEndpointWorkers(
  endpointId: string,
  config: EndpointUpdateConfig,
  apiKey: string
): Promise<void> {
  const url = `${RUNPOD_REST_API}/endpoints/${endpointId}/update`;

  console.log(`Updating endpoint ${endpointId} to ${config.workersMax} max workers...`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      workersMax: config.workersMax,
      workersMin: config.workersMin ?? 0,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Failed to update endpoint ${endpointId}:`, response.status, errorText);
    throw new Error(`RunPod endpoint update failed: ${response.status}`);
  }

  const result = await response.json();
  console.log(`✓ Endpoint ${endpointId} updated to ${config.workersMax} max workers`);
}

/**
 * Allocates all 10 workers to audio endpoint, sets image endpoint to 0
 * Call this before audio generation starts
 */
export async function allocateWorkersForAudio(apiKey: string): Promise<void> {
  const audioEndpointId = process.env.RUNPOD_ENDPOINT_ID; // Fish Speech TTS
  const imageEndpointId = process.env.RUNPOD_ZIMAGE_ENDPOINT_ID; // Z-Image

  if (!audioEndpointId || !imageEndpointId) {
    console.warn('Missing endpoint IDs, skipping worker allocation');
    return;
  }

  console.log('\n=== Allocating all 10 workers to audio generation ===');

  // Set both endpoints in parallel
  await Promise.all([
    updateEndpointWorkers(audioEndpointId, { workersMax: 10 }, apiKey),
    updateEndpointWorkers(imageEndpointId, { workersMax: 0 }, apiKey),
  ]);

  console.log('✓ Worker allocation complete: Audio=10, Images=0\n');
}

/**
 * Allocates all 10 workers to image endpoint, sets audio endpoint to 0
 * Call this before image generation starts
 */
export async function allocateWorkersForImages(apiKey: string): Promise<void> {
  const audioEndpointId = process.env.RUNPOD_ENDPOINT_ID; // Fish Speech TTS
  const imageEndpointId = process.env.RUNPOD_ZIMAGE_ENDPOINT_ID; // Z-Image

  if (!audioEndpointId || !imageEndpointId) {
    console.warn('Missing endpoint IDs, skipping worker allocation');
    return;
  }

  console.log('\n=== Allocating all 10 workers to image generation ===');

  // Set both endpoints in parallel
  await Promise.all([
    updateEndpointWorkers(audioEndpointId, { workersMax: 0 }, apiKey),
    updateEndpointWorkers(imageEndpointId, { workersMax: 10 }, apiKey),
  ]);

  console.log('✓ Worker allocation complete: Audio=0, Images=10\n');
}
