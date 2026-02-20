/**
 * Content Moderator - Scans images for inappropriate content and historical inaccuracies
 * Uses Claude Vision API to analyze images and rewrite prompts
 */

import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient, formatSystemPrompt } from './anthropic-client';

// Fetch image and convert to base64
async function fetchImageAsBase64(imageUrl: string): Promise<{ data: string; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }> {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || 'image/png';
  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');

  // Map content type to allowed media types
  let mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' = 'image/png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) {
    mediaType = 'image/jpeg';
  } else if (contentType.includes('gif')) {
    mediaType = 'image/gif';
  } else if (contentType.includes('webp')) {
    mediaType = 'image/webp';
  }

  return { data: base64, mediaType };
}

const anthropic = createAnthropicClient();

export interface ModerationResult {
  safe: boolean;
  violations: string[];
  confidence: number;
  details: string;
}

export interface PromptRewriteResult {
  newPrompt: string;
  changes: string;
}

// Violation categories
export const VIOLATION_TYPES = {
  // Content violations
  nudity: 'Nudity or partial nudity detected',
  violence: 'Graphic violence detected',
  gore: 'Gore or disturbing imagery detected',
  medical: 'Medical/surgical scene detected',
  disturbing: 'Disturbing or traumatic content detected',
  // Historical accuracy violations
  wrong_clothing: 'Clothing from wrong time period',
  wrong_architecture: 'Architecture from wrong era',
  wrong_objects: 'Anachronistic objects detected',
  wrong_era: 'General era mismatch',
} as const;

export type ViolationType = keyof typeof VIOLATION_TYPES;

/**
 * Moderate a single image using Claude Vision API
 * @param imageUrl - Public URL of the image to scan
 * @param eraTopic - The expected era/topic (e.g., "Regency England 1810s")
 * @returns Moderation result with violations and confidence
 */
export async function moderateImage(
  imageUrl: string,
  eraTopic: string
): Promise<ModerationResult> {
  const startTime = Date.now();

  try {
    // Fetch image and convert to base64
    const { data: imageBase64, mediaType } = await fetchImageAsBase64(imageUrl);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: imageBase64,
              },
            },
            {
              type: 'text',
              text: `Analyze this image for a historical documentary about: ${eraTopic}

CHECK FOR CONTENT ISSUES:
1. NUDITY: Any bare skin beyond face/hands, partial nudity, revealing clothing
2. VIOLENCE: Graphic violence, weapons being actively used, combat
3. GORE: Blood, injuries, corpses, medical procedures, autopsies
4. DISTURBING: Shocking, traumatic, or unsettling imagery

CHECK FOR HISTORICAL ACCURACY (expected era: ${eraTopic}):
5. WRONG_CLOTHING: Clothing from wrong time period (e.g., Victorian in Roman scene)
6. WRONG_ARCHITECTURE: Buildings/interiors from wrong era
7. WRONG_OBJECTS: Anachronistic items (modern technology, wrong tools)

Return ONLY a JSON object, no other text:
{
  "safe": true or false,
  "violations": ["nudity", "wrong_clothing", etc] or [],
  "confidence": 0.0 to 1.0,
  "details": "Brief explanation of what's wrong, or 'No issues found'"
}`,
            },
          ],
        },
      ],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from Claude Vision');
    }

    // Parse the JSON response
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[content-moderator] Failed to parse response:', content.text);
      // Default to safe if parsing fails (don't block legitimate content)
      return {
        safe: true,
        violations: [],
        confidence: 0.5,
        details: 'Unable to parse moderation response',
      };
    }

    const result = JSON.parse(jsonMatch[0]) as ModerationResult;
    const elapsed = Date.now() - startTime;
    console.log(`[content-moderator] Scanned image in ${elapsed}ms: safe=${result.safe}, violations=${result.violations.join(',') || 'none'}`);

    return result;
  } catch (error) {
    console.error('[content-moderator] Error scanning image:', error);
    // Default to safe on error (don't block due to API issues)
    return {
      safe: true,
      violations: [],
      confidence: 0,
      details: `Scan error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Rewrite a prompt to avoid detected violations
 * @param originalPrompt - The original image prompt
 * @param scriptContext - The narration text for this scene
 * @param violations - Array of violation types detected
 * @param eraTopic - The expected era/topic
 * @returns Rewritten prompt and summary of changes
 */
export async function rewritePromptForSafety(
  originalPrompt: string,
  scriptContext: string,
  violations: ViolationType[],
  eraTopic: string
): Promise<PromptRewriteResult> {
  const violationGuidance = violations.map(v => {
    switch (v) {
      case 'nudity':
        return '- NUDITY: Show fully-clothed figures in formal period attire, OR focus on architecture/landscape instead of people';
      case 'violence':
        return '- VIOLENCE: Show a peaceful moment, diplomatic scene, or the aftermath (empty battlefield, quiet aftermath)';
      case 'gore':
      case 'medical':
        return '- GORE/MEDICAL: Show the building exterior, a peaceful room, or symbolic elements (crown, flag) - NOT the procedure';
      case 'disturbing':
        return '- DISTURBING: Show a calm, peaceful version of the moment, different camera angle, or architectural focus';
      case 'wrong_clothing':
        return `- WRONG_CLOTHING: Specify correct era garments for ${eraTopic} (research exact fashion of that period)`;
      case 'wrong_architecture':
        return `- WRONG_ARCHITECTURE: Specify correct era buildings/interiors for ${eraTopic}`;
      case 'wrong_objects':
        return `- WRONG_OBJECTS: Remove anachronistic items, add only period-correct objects for ${eraTopic}`;
      case 'wrong_era':
        return `- WRONG_ERA: Ensure ALL visual elements match ${eraTopic} - clothing, architecture, objects, cultural elements`;
      default:
        return '';
    }
  }).filter(Boolean).join('\n');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 500,
      system: formatSystemPrompt('You are an expert at writing image prompts for historical documentaries. You rewrite prompts to be visually interesting while avoiding content issues.') as Anthropic.MessageCreateParams['system'],
      messages: [
        {
          role: 'user',
          content: `Rewrite this image prompt to avoid the detected issues.

ERA/TOPIC: ${eraTopic}

SCRIPT CONTEXT FOR THIS SCENE:
"${scriptContext}"

ORIGINAL PROMPT:
"${originalPrompt}"

VIOLATIONS TO FIX:
${violationGuidance}

Write a new 50-80 word prompt that:
1. Captures the same historical MOMENT from the script
2. Completely avoids all the violations listed above
3. Is visually interesting (not just "person standing in room")
4. Specifies era-accurate details for ${eraTopic}
5. Focuses on setting/architecture if content issues are hard to avoid

Return ONLY the new prompt text, no quotes, no explanation.`,
        },
      ],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type');
    }

    const newPrompt = content.text.trim().replace(/^["']|["']$/g, '');

    console.log(`[content-moderator] Rewrote prompt for violations: ${violations.join(', ')}`);
    console.log(`[content-moderator] Original: ${originalPrompt.substring(0, 50)}...`);
    console.log(`[content-moderator] New: ${newPrompt.substring(0, 50)}...`);

    return {
      newPrompt,
      changes: `Fixed: ${violations.join(', ')}`,
    };
  } catch (error) {
    console.error('[content-moderator] Error rewriting prompt:', error);
    // Return enhanced version of original prompt as fallback
    const fallbackPrompt = `Family-friendly historical scene, ${eraTopic}, fully clothed figures in period attire, elegant architecture, peaceful atmosphere. ${originalPrompt}`;
    return {
      newPrompt: fallbackPrompt,
      changes: `Fallback enhancement (rewrite failed: ${error instanceof Error ? error.message : 'Unknown'})`,
    };
  }
}
