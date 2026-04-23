/**
 * Vision Describer - Generates text descriptions of video frames using Claude Vision API
 */

import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient, formatSystemPrompt } from './anthropic-client';

const anthropic = createAnthropicClient();

export interface SceneDescription {
  frameIndex: number;
  description: string;
  error?: string;
}

/**
 * Describe a batch of frames using Claude Vision API
 * @param frameUrls - Array of publicly accessible frame image URLs
 * @param options - Configuration options
 * @returns Array of scene descriptions
 */
export async function describeFrames(
  frameUrls: string[],
  options: {
    batchSize?: number;
    maxConcurrent?: number;
    onProgress?: (percent: number) => void;
  } = {}
): Promise<SceneDescription[]> {
  const {
    batchSize = 10,      // Process 10 frames per Claude API call
    maxConcurrent = 3,   // Max 3 concurrent API calls to avoid rate limits
    onProgress,
  } = options;

  console.log(`[vision-describer] Describing ${frameUrls.length} frames (batch size: ${batchSize})`);

  const results: SceneDescription[] = [];
  let processedCount = 0;

  // Process in batches
  const batches: { frameUrl: string; frameIndex: number }[][] = [];
  for (let i = 0; i < frameUrls.length; i += batchSize) {
    const batch = frameUrls.slice(i, i + batchSize).map((url, idx) => ({
      frameUrl: url,
      frameIndex: i + idx,
    }));
    batches.push(batch);
  }

  console.log(`[vision-describer] Processing ${batches.length} batches with max ${maxConcurrent} concurrent`);

  // Process batches with rolling concurrency
  for (let i = 0; i < batches.length; i += maxConcurrent) {
    const batchChunk = batches.slice(i, i + maxConcurrent);
    const batchPromises = batchChunk.map(batch => describeBatch(batch));

    const batchResults = await Promise.all(batchPromises);

    // Flatten and collect results
    for (const batchResult of batchResults) {
      results.push(...batchResult);
    }

    processedCount += batchChunk.reduce((sum, batch) => sum + batch.length, 0);

    // Report progress
    if (onProgress) {
      const percent = Math.round((processedCount / frameUrls.length) * 100);
      onProgress(percent);
    }

    console.log(`[vision-describer] Progress: ${processedCount}/${frameUrls.length} frames`);
  }

  console.log(`[vision-describer] Generated ${results.length} descriptions`);
  return results;
}

/**
 * Describe a single batch of frames with one API call
 */
async function describeBatch(
  frames: { frameUrl: string; frameIndex: number }[]
): Promise<SceneDescription[]> {
  try {
    // Build content array with all frame images
    const content: (Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam)[] = [
      {
        type: 'text',
        text: `Analyze each frame for video production recreation. Focus on VISUAL PRODUCTION DETAILS that can be replicated:

**Must Include:**
- Camera angle/framing (wide, close-up, overhead, etc.)
- Visual effects (smoke, fire, particles, glow, blur)
- Color grading (warm/cool tones, contrast, saturation)
- Composition (rule of thirds, symmetry, depth)
- Text overlays (font style, size, position, animation)
- Background elements (solid color, gradient, image, video)
- Lighting (dramatic, soft, high-key, low-key)
- Transitions (if visible between frames)

**Format:**
Frame N: [2-3 sentence description covering camera, effects, colors, composition, text]

**Example:**
Frame 1: Wide shot with dark gradient background (#1a1a2e to #16213e). White sans-serif text centered, large bold title. Subtle particle effects floating. High contrast, cinematic color grading with cooler tones.`,
      },
    ];

    for (let i = 0; i < frames.length; i++) {
      content.push({
        type: 'image',
        source: {
          type: 'url',
          url: frames[i].frameUrl,
        } as any, // Claude API supports URL type but TypeScript types are outdated
      });
    }

    // Call Claude Vision API
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: formatSystemPrompt('You describe video frames for documentary production.') as Anthropic.MessageCreateParams['system'],
      messages: [
        {
          role: 'user',
          content,
        },
      ],
    });

    // Extract text response
    const textContent = response.content.find(block => block.type === 'text');
    const fullText = textContent?.type === 'text' ? textContent.text : '';

    // Parse descriptions (format: "Frame N: description")
    const descriptions: SceneDescription[] = [];
    const lines = fullText.split('\n').filter(line => line.trim().length > 0);

    for (const line of lines) {
      const match = line.match(/Frame (\d+):\s*(.+)/i);
      if (match) {
        const frameNum = parseInt(match[1], 10);
        const description = match[2].trim();

        if (frameNum >= 0 && frameNum < frames.length) {
          descriptions.push({
            frameIndex: frames[frameNum].frameIndex,
            description,
          });
        }
      }
    }

    // If parsing failed, create generic descriptions
    if (descriptions.length === 0) {
      console.warn('[vision-describer] Failed to parse descriptions, using fallback');
      for (const frame of frames) {
        descriptions.push({
          frameIndex: frame.frameIndex,
          description: fullText.substring(0, 200) || 'Video frame',
        });
      }
    }

    return descriptions;

  } catch (error: any) {
    console.error('[vision-describer] Error describing batch:', error);

    // Return error descriptions
    return frames.map(frame => ({
      frameIndex: frame.frameIndex,
      description: 'Failed to generate description',
      error: error.message,
    }));
  }
}

/**
 * Describe a single frame (simpler API for single-frame use cases)
 */
export async function describeFrame(frameUrl: string): Promise<string> {
  const results = await describeFrames([frameUrl], { batchSize: 1 });
  return results[0]?.description || 'Failed to generate description';
}
