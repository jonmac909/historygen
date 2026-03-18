/**
 * Content Moderator - Scans images and scripts for inappropriate content
 * Uses Claude Vision API for images and Claude for text analysis
 *
 * YouTube Community Guidelines categories checked for scripts:
 * - Sexual content or nudity
 * - Graphic violence or gore
 * - Hate speech or discrimination
 * - Harassment or bullying
 * - Dangerous or harmful content
 * - Misleading information
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
        return '- NUDITY: KEEP the people but show them fully-clothed in elegant period attire (formal dress, tailcoat, etc.)';
      case 'violence':
        return '- VIOLENCE: KEEP the people but show a peaceful moment BEFORE or AFTER the violence (diplomacy, mourning, reconciliation)';
      case 'gore':
      case 'medical':
        return '- GORE/MEDICAL: KEEP the person but show them in a peaceful moment (recovering, comforted by family, or in happier times)';
      case 'disturbing':
        return '- DISTURBING: KEEP the people but show a calmer version of the scene (comforting embrace, peaceful resolution)';
      case 'wrong_clothing':
        return `- WRONG_CLOTHING: KEEP the people, just fix their clothing to match ${eraTopic} era fashion`;
      case 'wrong_architecture':
        return `- WRONG_ARCHITECTURE: KEEP the people, just fix the buildings/interiors to match ${eraTopic}`;
      case 'wrong_objects':
        return `- WRONG_OBJECTS: KEEP the people, just remove anachronistic items and add period-correct objects`;
      case 'wrong_era':
        return `- WRONG_ERA: KEEP the people, but fix ALL visual elements to match ${eraTopic}`;
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
1. KEEPS THE PEOPLE from the original scene - do NOT remove them
2. Captures the same historical MOMENT from the script
3. Completely avoids all the violations listed above
4. Is visually interesting with people DOING something
5. Specifies era-accurate details for ${eraTopic}

CRITICAL: 80-90% of prompts MUST feature people. Only remove people if absolutely necessary for safety.

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
    // Return enhanced version of original prompt as fallback - KEEP the people!
    const fallbackPrompt = `${originalPrompt} - depicted in ${eraTopic} era, fully clothed figures in elegant period attire, peaceful atmosphere`;
    return {
      newPrompt: fallbackPrompt,
      changes: `Fallback enhancement (rewrite failed: ${error instanceof Error ? error.message : 'Unknown'})`,
    };
  }
}

// ============================================================================
// SCRIPT MODERATION (YouTube Policy Compliance)
// ============================================================================

export interface ScriptContentIssue {
  category: 'sexual' | 'violence' | 'hate' | 'harassment' | 'dangerous' | 'misleading';
  severity: 'low' | 'medium' | 'high';
  excerpt: string;
  suggestion: string;
}

export interface ScriptModerationResult {
  safe: boolean;
  issues: ScriptContentIssue[];
  summary: string;
}

const SCRIPT_MODERATION_PROMPT = `You are a YouTube content policy expert. Analyze this script for potential YouTube policy violations.

Check for these categories:
1. **Sexual content**: Explicit sexual descriptions, suggestive content, or detailed nudity references
2. **Graphic violence**: Excessive gore, torture descriptions, or glorification of violence
3. **Hate speech**: Discrimination, slurs, or dehumanizing language based on race, religion, gender, etc.
4. **Harassment**: Personal attacks, bullying, or threats against individuals
5. **Dangerous content**: Instructions for harmful activities, weapons creation, drug manufacturing
6. **Misleading info**: Medical misinformation, dangerous conspiracy theories presented as fact

IMPORTANT CONTEXT: This is a HISTORICAL DOCUMENTARY script. The following are ALLOWED:
- Educational discussion of wars, battles, and historical violence (without glorifying)
- Descriptions of historical atrocities (Holocaust, slavery, etc.) for educational purposes
- Historical figures' controversial actions described factually
- Period-appropriate language when quoting historical sources

ONLY FLAG content that:
- Uses gratuitous, graphic descriptions beyond educational necessity
- Glorifies or celebrates violence/suffering
- Uses slurs NOT in direct historical quotes
- Promotes harmful ideologies rather than documenting them
- Contains explicit sexual content (rare in historical docs)

Respond in this EXACT JSON format:
{
  "safe": true/false,
  "issues": [
    {
      "category": "violence|sexual|hate|harassment|dangerous|misleading",
      "severity": "low|medium|high",
      "excerpt": "the problematic text (max 50 words)",
      "suggestion": "how to rewrite it"
    }
  ],
  "summary": "brief summary"
}

If safe, return: {"safe": true, "issues": [], "summary": "Content appropriate for YouTube"}

SCRIPT:
`;

/**
 * Scan a script for YouTube policy violations
 */
export async function moderateScript(
  script: string,
  apiKey?: string
): Promise<ScriptModerationResult> {
  const ANTHROPIC_API_KEY = apiKey || process.env.ANTHROPIC_API_KEY;

  if (!ANTHROPIC_API_KEY) {
    console.warn('[content-moderator] No API key, skipping script moderation');
    return { safe: true, issues: [], summary: 'Moderation skipped (no API key)' };
  }

  // Skip moderation for very short scripts
  if (script.length < 100) {
    return { safe: true, issues: [], summary: 'Script too short to moderate' };
  }

  try {
    // Use Haiku for fast, cheap moderation (~$0.001 per script)
    const response = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: SCRIPT_MODERATION_PROMPT + script.substring(0, 20000) // Limit to ~20k chars
      }]
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[content-moderator] Could not parse script moderation response');
      return { safe: true, issues: [], summary: 'Could not parse moderation response' };
    }

    const result = JSON.parse(jsonMatch[0]) as ScriptModerationResult;

    console.log(`[content-moderator] Script scan: safe=${result.safe}, issues=${result.issues.length}`);
    if (!result.safe && result.issues.length > 0) {
      console.log('[content-moderator] Script issues:', result.issues.map(i => `${i.category}(${i.severity})`).join(', '));
    }

    return result;
  } catch (error) {
    console.error('[content-moderator] Script moderation error:', error);
    // On error, assume safe to not block content
    return { safe: true, issues: [], summary: 'Moderation error, assuming safe' };
  }
}

/**
 * Quick keyword-based pre-filter for scripts
 * Returns true if script contains potential red-flag words that need full moderation
 */
export function scriptNeedsModeration(script: string): boolean {
  const lowerScript = script.toLowerCase();

  // Red-flag keywords that warrant full Claude moderation
  const redFlags = [
    // Sexual
    'sexual', 'explicit', 'nude', 'naked', 'erotic', 'porn', 'genitals',
    // Extreme violence
    'torture', 'mutilat', 'decapitat', 'dismember', 'disembowel',
    // Hate
    'exterminate', 'inferior race', 'subhuman', 'n-word', 'k*ke',
    // Dangerous
    'how to make a bomb', 'how to kill someone', 'suicide method',
    // Drug manufacturing
    'how to make meth', 'cook drugs', 'synthesize',
  ];

  return redFlags.some(flag => lowerScript.includes(flag));
}

/**
 * Auto-sanitize a script by rewriting problematic sections
 */
export async function sanitizeScript(
  script: string,
  issues: ScriptContentIssue[],
  apiKey?: string
): Promise<{ sanitized: string; changes: string[] }> {
  const ANTHROPIC_API_KEY = apiKey || process.env.ANTHROPIC_API_KEY;

  if (!ANTHROPIC_API_KEY || issues.length === 0) {
    return { sanitized: script, changes: [] };
  }

  // Only auto-fix low/medium severity issues; high severity needs manual review
  const fixableIssues = issues.filter(i => i.severity !== 'high');
  if (fixableIssues.length === 0) {
    return { sanitized: script, changes: [] };
  }

  try {
    const issuesList = fixableIssues.map(i =>
      `- ISSUE (${i.category}): "${i.excerpt}"\n  FIX: ${i.suggestion}`
    ).join('\n\n');

    const response = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 16000,
      messages: [{
        role: 'user',
        content: `Rewrite this historical documentary script to fix YouTube policy issues. Keep the same educational content, style, and length. Make ONLY the specific changes needed.

ISSUES TO FIX:
${issuesList}

ORIGINAL SCRIPT:
${script}

OUTPUT THE COMPLETE FIXED SCRIPT ONLY, NO EXPLANATIONS:`
      }]
    });

    const sanitized = response.content[0]?.type === 'text' ? response.content[0].text : script;
    const changes = fixableIssues.map(i => `Fixed ${i.category}: ${i.excerpt.substring(0, 30)}...`);

    console.log(`[content-moderator] Sanitized script, fixed ${changes.length} issues`);

    return { sanitized, changes };
  } catch (error) {
    console.error('[content-moderator] Sanitize script error:', error);
    return { sanitized: script, changes: [] };
  }
}
