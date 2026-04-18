import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient, formatSystemPrompt } from '../lib/anthropic-client';
import { saveCost } from '../lib/cost-tracker';

const router = Router();

// Constants
const MAX_TOKENS = 16384;  // Sonnet max tokens
const BATCH_SIZE_PARALLEL = 10; // Smaller batches for parallel processing
const MAX_CONCURRENT_BATCHES = 20; // Limit concurrent API calls to avoid rate limits
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000; // 1s → 2s → 4s exponential backoff

// Retry a function with exponential backoff
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts: number = RETRY_MAX_ATTEMPTS,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`[Retry] ${label} attempt ${attempt}/${maxAttempts} failed: ${lastError.message}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError!;
}

// Process promises with controlled concurrency to avoid rate limits
async function processBatchesWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  maxConcurrent: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];
  const executing: Promise<void>[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const promise = task()
      .then(value => {
        results[i] = { status: 'fulfilled', value };
      })
      .catch(reason => {
        results[i] = { status: 'rejected', reason };
      })
      .finally(() => {
        executing.splice(executing.indexOf(promise), 1);
      });

    executing.push(promise);

    if (executing.length >= maxConcurrent) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

// Truncate text to maxLen chars, but prefer to end at a sentence or word
// boundary so fallback image prompts read as coherent sentences instead of
// cutting mid-word. Used only by the last-resort `Historical scene depicting:`
// fallback when the LLM-generated sceneDescription is missing — when that
// fires the user sees the raw script, so at minimum don't chop mid-word.
function smartTruncate(text: string, maxLen: number): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  const window = text.slice(0, maxLen);
  // 1. Prefer the last sentence terminator (. ! ?) followed by space or EOL.
  const sentenceMatch = window.match(/.*[.!?](?:\s|$)/s);
  if (sentenceMatch && sentenceMatch[0].length > maxLen * 0.4) {
    return sentenceMatch[0].trimEnd();
  }
  // 2. Fall back to the last whitespace boundary (don't split words).
  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.4) {
    return window.slice(0, lastSpace).trimEnd();
  }
  // 3. No good boundary found — return the hard cut as before.
  return window;
}

// Robustly extract a JSON array from Claude's response text
function extractJsonArray(text: string): object[] | null {
  // 1. Try direct regex match for JSON array
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch { /* fall through */ }
  }

  // 2. Strip markdown code fences and retry
  const stripped = text
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  const strippedMatch = stripped.match(/\[[\s\S]*\]/);
  if (strippedMatch) {
    try {
      return JSON.parse(strippedMatch[0]);
    } catch { /* fall through */ }
  }

  // 3. Try to fix truncated JSON (missing closing bracket)
  const openBracket = stripped.indexOf('[');
  if (openBracket !== -1) {
    let partial = stripped.substring(openBracket);
    // Close any unclosed strings and objects, then close the array
    if (!partial.trimEnd().endsWith(']')) {
      // Attempt to close at the last complete object
      const lastCloseBrace = partial.lastIndexOf('}');
      if (lastCloseBrace > 0) {
        partial = partial.substring(0, lastCloseBrace + 1) + ']';
        try {
          return JSON.parse(partial);
        } catch { /* fall through */ }
      }
    }
  }

  return null;
}

interface SrtSegment {
  index: number;
  startTime: string;
  endTime: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

interface ImagePrompt {
  index: number;
  startTime: string;
  endTime: string;
  startSeconds: number;
  endSeconds: number;
  prompt: string;
  sceneDescription: string;
}

// CONTENT SAFETY: Banned words list for post-generation validation
const BANNED_WORDS = [
  // Violence/Gore/Death
  'blood', 'bloody', 'bleeding', 'bloodstained', 'blood-soaked', 'bloodletting',
  'corpse', 'dead body', 'lifeless', 'motionless', 'dying', 'death', 'dies', 'deceased',
  'wound', 'wounded', 'injury', 'injured', 'scar', 'scarred', 'disfigured',
  'gore', 'gory', 'viscera', 'organs', 'flesh', 'entrails', 'innards',
  'suffering', 'agony', 'pain', 'torment', 'torture', 'execution',
  'collapsed', 'unconscious', 'barely breathing', 'chest barely rises',
  'crimson blood', 'dark blood', 'basin of blood', 'drawing blood', 'purge', 'humours',
  // Illness/Medical
  'pale', 'pallid', 'gaunt', 'wasted', 'skeletal', 'emaciated', 'sickly', 'clammy',
  'sweat', 'sweating', 'feverish', 'fever', 'coughing', 'vomiting',
  'stained', 'soaked', 'drenched',
  'autopsy', 'dissection', 'surgery', 'operation', 'scalpel', 'anatomical', 'lancet', 'leeches',
  // Nudity/Romance
  'nude', 'naked', 'nudity', 'bare skin', 'unclothed', 'undressed', 'topless', 'revealing',
  'kissing', 'kiss', 'embracing', 'romantic embrace', 'passionate', 'sensual', 'seductive'
];

// Check if a prompt contains any banned words
function containsBannedWords(text: string): { hasBanned: boolean; foundWords: string[] } {
  const lowerText = text.toLowerCase();
  const foundWords: string[] = [];

  for (const word of BANNED_WORDS) {
    // Use word boundary check for single words, direct check for phrases
    if (word.includes(' ')) {
      if (lowerText.includes(word)) {
        foundWords.push(word);
      }
    } else {
      const regex = new RegExp(`\\b${word}\\b`, 'i');
      if (regex.test(text)) {
        foundWords.push(word);
      }
    }
  }

  return { hasBanned: foundWords.length > 0, foundWords };
}

// Sanitize a prompt by asking Claude to rewrite it as PG family-friendly
// IMPORTANT: The replacement must be CONTEXTUALLY APPROPRIATE - not random peaceful scenes
async function sanitizePromptWithClaude(
  anthropic: Anthropic,
  prompt: string,
  era: string,
  subjectFocus?: string,
  scriptContext?: string
): Promise<{ sanitized: string; inputTokens: number; outputTokens: number }> {
  const { hasBanned, foundWords } = containsBannedWords(prompt);

  if (!hasBanned) {
    return { sanitized: prompt, inputTokens: 0, outputTokens: 0 };
  }

  console.warn(`⚠️ CONTENT SAFETY: Found banned words: ${foundWords.join(', ')}`);
  console.warn(`   Original: ${prompt.substring(0, 100)}...`);

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 200,
      system: `You rewrite image prompts to be PG family-friendly while keeping them CONTEXTUALLY RELEVANT to the same story moment.

ERA: ${era}
${subjectFocus ? `SUBJECT FOCUS: ${subjectFocus}` : ''}
${scriptContext ? `STORY CONTEXT: ${scriptContext.substring(0, 500)}` : ''}

The replacement should make sense for that scene. Keep people in the scene IF IT MAKES SENSE.

CONTEXT-AWARE REPLACEMENTS (prefer keeping people visible):
- Medical procedure → Doctor at patient's bedside, or family member keeping vigil
- Patient dying/illness → Family gathered in prayer, or maid bringing tea to the room
- Surgery/operation → Doctor speaking with concerned family in hallway
- Death scene → Mourning wife/mother/family member, or the person in happier earlier times
- Battle/violence → Soldiers preparing before battle, or nurse in field hospital
- Execution/torture → Crowd watching from distance, or guard standing at doorway

STAY IN THE SCENE:
The rewritten prompt must show the SAME SCENE, just without the graphic element.
- If the original is INDOORS → stay indoors
- If people are PRESENT → keep people present
- If it's a MEDICAL scene → keep it medical-related
- DO NOT switch to a completely different location or add random elements

RULES:
1. Keep the SAME CHARACTERS if named (e.g., "the physician" stays "the physician")
2. Keep the SAME LOCATION type (medical scene stays medical-related, just peaceful)
3. Keep the SAME TIME OF DAY and atmosphere
4. Keep it relevant to the ERA: ${era}
5. Just remove the graphic element and show a related peaceful moment
6. MAX 35 WORDS - keep it short like the original

Output ONLY the rewritten prompt, nothing else.`,
      messages: [{
        role: 'user',
        content: `Rewrite this image prompt as PG family-friendly. Keep it contextually relevant:\n\n${prompt}`
      }]
    });

    const sanitized = response.content[0].type === 'text' ? response.content[0].text.trim() : prompt;
    console.warn(`   Rewritten: ${sanitized.substring(0, 100)}...`);

    return {
      sanitized,
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0
    };
  } catch (error) {
    console.error('Error sanitizing prompt with Claude:', error);
    // On error, just remove the banned words as fallback
    let sanitized = prompt;
    for (const word of foundWords) {
      const regex = new RegExp(`\\b${word}\\b`, 'gi');
      sanitized = sanitized.replace(regex, '').replace(/\s+/g, ' ').trim();
    }
    return { sanitized, inputTokens: 0, outputTokens: 0 };
  }
}

// Time period context extracted from script
interface TimePeriodContext {
  era: string;              // e.g., "10,000 BCE - Mesolithic Period"
  region: string;           // e.g., "Ancient Near East"
  visualConstraints: string; // e.g., "Stone tools only, animal hide clothing"
  anachronisms: string[];   // Things to avoid for this era
}

// Extract time period and visual constraints from script
async function extractTimePeriod(
  anthropic: Anthropic,
  script: string
): Promise<{ context: TimePeriodContext; inputTokens: number; outputTokens: number }> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 500,
    system: formatSystemPrompt('You are a helpful assistant that analyzes historical scripts.') as Anthropic.MessageCreateParams['system'],
    messages: [{
      role: 'user',
      content: `Analyze this historical documentary script and extract the PRIMARY time period being depicted.

SCRIPT (first 4000 chars):
${script.substring(0, 4000)}

Return ONLY valid JSON with these fields:
{
  "era": "The specific time period, e.g., '10,000 BCE - Mesolithic Period' or '1347 CE - Medieval Europe'",
  "region": "Geographic region, e.g., 'Ancient Near East' or 'Western Europe'",
  "visualConstraints": "Brief description of period-accurate visual elements (clothing, tools, architecture)",
  "anachronisms": ["list", "of", "things", "that", "would", "be", "anachronistic", "for", "this", "era"]
}

IMPORTANT: 
- For prehistoric periods (before 3000 BCE), anachronisms should include: metal tools, woven textiles, brick buildings, written documents, formal clothing, agriculture (if pre-agricultural)
- For ancient periods (3000 BCE - 500 CE), anachronisms might include: gunpowder, printing, certain fabrics, architectural styles from later eras
- For medieval periods, anachronisms might include: modern uniforms, electricity, photography

Return ONLY the JSON object, no explanations.`
    }],
  });

  const inputTokens = response.usage?.input_tokens || 0;
  const outputTokens = response.usage?.output_tokens || 0;

  try {
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(`[Time Period] Extracted: ${parsed.era} in ${parsed.region}`);
      console.log(`[Time Period] Anachronisms to avoid: ${parsed.anachronisms?.join(', ')}`);
      return {
        context: {
          era: parsed.era || 'Historical Period',
          region: parsed.region || 'Unknown Region',
          visualConstraints: parsed.visualConstraints || '',
          anachronisms: parsed.anachronisms || [],
        },
        inputTokens,
        outputTokens,
      };
    }
  } catch (e) {
    console.error('[Time Period] Failed to parse response:', e);
  }

  // Default fallback
  return {
    context: {
      era: 'Historical Period',
      region: 'Unknown Region',
      visualConstraints: '',
      anachronisms: [],
    },
    inputTokens,
    outputTokens,
  };
}

// Modern/anachronistic keywords to filter from scene descriptions
const MODERN_KEYWORDS_TO_REMOVE = [
  // Museum/exhibition context
  'museum', 'exhibit', 'exhibition', 'display case', 'display cases', 'gallery', 'galleries',
  'artifact', 'artifacts', 'archaeological', 'archaeology', 'excavation', 'excavated',
  'preserved', 'preservation', 'restoration', 'restored', 'replica', 'replicas', 'reconstruction',
  'curator', 'curators', 'visitor', 'visitors', 'tourist', 'tourists',
  'specimen', 'specimens', 'diorama', 'collection', 'collections',

  // Academic/research context - expanded
  'researcher', 'researchers', 'scientist', 'scientists', 'historian', 'historians',
  'scholar', 'scholars', 'academic', 'academics', 'professor', 'professors',
  'laboratory', 'lab coat', 'lab coats', 'research facility', 'research facilities',
  'university', 'institution', 'facility', 'clinical', 'sterile',
  'study', 'studies', 'analysis', 'analyzed', 'examination', 'examined',
  'documentation', 'documented', 'records show', 'evidence suggests',
  'research', 'microscope', 'microscopes', 'magnifying glass', 'magnifying glasses',
  // Additional scientific/modern roles
  'geologist', 'geologists', 'geological', 'geology',
  'archaeologist', 'archaeologists',
  'anthropologist', 'anthropologists',
  'expert', 'experts', 'specialist', 'specialists',
  'team of', 'survey team', 'field team', 'research team',
  'taking notes', 'field notes', 'notebook', 'notebooks',
  'equipment', 'instruments', 'tools', 'measuring',
  'scientific', 'science',

  // Maps and documents (cause anachronistic imagery)
  'map', 'maps', 'parchment map', 'antique map', 'historical map', 'topographical',
  'scroll', 'scrolls', 'document', 'documents', 'manuscript', 'manuscripts',
  'chart', 'charts', 'diagram', 'diagrams', 'blueprint', 'blueprints',
  'studying', 'examining', 'inspecting', 'analyzing', 'reviewing',
  'close-up of', 'detailed view of', 'closeup of',
  'placard', 'placards', 'label', 'labels', 'caption', 'captions',

  // Modern technology/settings
  'modern', 'contemporary', 'present-day', 'present day', 'today', "today's",
  'photograph', 'photography', 'camera', 'cameras', 'digital', 'computer', 'computers',
  'electric', 'electricity', 'neon', 'fluorescent', 'led', 'spotlight', 'spotlights',
  'glass case', 'glass cases', 'plexiglass', 'acrylic',
  'tablet', 'screen', 'monitor', 'display',
  'field clothes', 'field gear', 'protective gear', 'sun hats',
  'vehicles', 'field vehicles',

  // Documentary/educational framing
  'documentary', 'educational', 'illustration', 'infographic',
  'recreation', 'reenactment', 're-enactment', 'dramatization',
  'depicting', 'representation', 'interpretation', 'imagined', 'imagining',
  "artist's", 'artistic rendering',
  'interactive', 'interactive displays',

  // Time-reference phrases that break immersion
  'centuries later', 'years later', 'in hindsight', 'looking back',
  'historical record', 'historical records', 'ancient text', 'ancient texts',
  'surviving', 'survives', 'remains of', 'ruins of', 'remnants of',
  'investigation', 'investigating',

  // 3D/CGI/reconstruction terms
  '3d', '3d model', '3d reconstruction', 'cgi', 'render', 'rendered',
  'holographic', 'hologram', 'projection', 'projected',
  'virtual', 'simulation', 'simulated',
  'laid out', 'arranged on', 'placed on',

  // Additional display/presentation terms
  'presentation', 'presented', 'showcase', 'showcased', 'showcasing',
  'on display', 'on exhibit', 'on show', 'on view',
  'pedestal', 'stand', 'platform', 'table', 'desk',
  'lit by', 'illuminated by spotlight', 'dramatic lighting on object',
];

// Check if description contains any modern keywords
function containsModernKeywords(description: string): string[] {
  const found: string[] = [];
  for (const keyword of MODERN_KEYWORDS_TO_REMOVE) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
    if (regex.test(description)) {
      found.push(keyword);
    }
  }
  return found;
}

// Filter modern keywords from a scene description
function filterModernKeywords(description: string): string {
  let filtered = description;

  for (const keyword of MODERN_KEYWORDS_TO_REMOVE) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
    filtered = filtered.replace(regex, '');
  }

  // Clean up double spaces and punctuation
  filtered = filtered
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/\.\s*\./g, '.')
    .replace(/\s+\./g, '.')
    .replace(/^\s+|\s+$/g, '')
    .replace(/^,\s*/, '')
    .replace(/,\s*$/, '');

  return filtered;
}

// Regenerate a single prompt that contains modern keywords
async function regeneratePrompt(
  anthropic: Anthropic,
  originalDescription: string,
  foundKeywords: string[],
  narrationText: string
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 500,
      system: formatSystemPrompt('You rewrite scene descriptions for historical accuracy.') as Anthropic.MessageCreateParams['system'],
      messages: [{
        role: 'user',
        content: `TASK: Completely rewrite this scene description to show the ACTUAL HISTORICAL EVENT, not a modern interpretation of it.

PROBLEMATIC ORIGINAL (contains modern framing):
"${originalDescription}"

DETECTED MODERN TERMS: ${foundKeywords.join(', ')}

WHAT THE NARRATION SAYS:
"${narrationText}"

REQUIREMENTS FOR YOUR REWRITE:
1. Show the scene AS IF YOU WERE THERE in ancient/historical times
2. NO modern people (no scientists, researchers, geologists, historians, students, professors)
3. NO modern settings (no museums, labs, classrooms, lecture halls, excavation sites)
4. NO modern activities (no studying, analyzing, examining, surveying, taking notes)
5. NO maps, charts, documents, scrolls, manuscripts, diagrams
6. Show PEOPLE FROM THAT ERA doing things they would actually do
7. If the narration discusses a location, show ancient people LIVING there, not modern people VISITING

EXAMPLE TRANSFORMATION:
- BAD: "A geologist examines rock formations while taking notes"
- GOOD: "Ancient travelers rest beside towering cliffs as the sun sets over the rugged landscape"

Write 50-100 words describing the scene from an immersive historical perspective. Return ONLY the description, no quotes or explanation.`
      }]
    });

    const content = response.content[0];
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    if (content.type === 'text') {
      // Clean up any quotes that might wrap the response
      return {
        text: content.text.trim().replace(/^["']|["']$/g, ''),
        inputTokens,
        outputTokens,
      };
    }
    return { text: originalDescription, inputTokens, outputTokens };
  } catch (error) {
    console.error('Failed to regenerate prompt:', error);
    return { text: originalDescription, inputTokens: 0, outputTokens: 0 };
  }
}

// Parse SRT timestamp to seconds
function parseSrtTime(timeStr: string): number {
  const match = timeStr.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
  if (!match) return 0;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  const ms = parseInt(match[4], 10);

  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

// Format seconds to timecode for filenames (HH-MM-SS)
function formatTimecodeForFilename(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  return `${hours.toString().padStart(2, '0')}-${minutes.toString().padStart(2, '0')}-${secs.toString().padStart(2, '0')}`;
}

// Parse SRT content into segments
function parseSrt(srtContent: string): SrtSegment[] {
  const segments: SrtSegment[] = [];
  const blocks = srtContent.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 3) continue;

    const index = parseInt(lines[0], 10);
    const timeLine = lines[1];
    const text = lines.slice(2).join(' ').trim();

    const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
    if (!timeMatch) continue;

    segments.push({
      index,
      startTime: timeMatch[1],
      endTime: timeMatch[2],
      startSeconds: parseSrtTime(timeMatch[1]),
      endSeconds: parseSrtTime(timeMatch[2]),
      text,
    });
  }

  return segments;
}

// Group SRT segments into time windows for images
function groupSegmentsForImages(
  segments: SrtSegment[],
  imageCount: number,
  audioDuration?: number,
  clipCount: number = 12,
  clipDuration: number = 5
): { startSeconds: number; endSeconds: number; text: string; isIntro: boolean }[] {
  if (segments.length === 0) return [];

  const totalDuration = audioDuration || segments[segments.length - 1].endSeconds;

  // CLIP-AWARE TIMING:
  // First N images are INTRO video clips (5s each) - Topic/Focus-driven, NOT script-synced
  // Remaining images are static images synced to script, starting AFTER the intro duration
  const actualClipCount = Math.min(clipCount, imageCount);
  const clipsTotalDuration = actualClipCount * clipDuration;
  const staticImageCount = imageCount - actualClipCount;
  const remainingDuration = Math.max(0, totalDuration - clipsTotalDuration);
  const staticImageDuration = staticImageCount > 0 ? remainingDuration / staticImageCount : 0;

  console.log(`Clip-aware timing: ${actualClipCount} INTRO clips × ${clipDuration}s = ${clipsTotalDuration}s (Topic/Focus-driven), then ${staticImageCount} static images across ${remainingDuration.toFixed(2)}s (script-synced)`);

  const windows: { startSeconds: number; endSeconds: number; text: string; isIntro: boolean }[] = [];

  for (let i = 0; i < imageCount; i++) {
    let windowStart: number;
    let windowEnd: number;
    let isIntro: boolean;

    if (i < actualClipCount) {
      // INTRO video clips: Topic/Focus-driven, NOT tied to script timestamps
      // These are establishing shots and thematic world-building scenes
      windowStart = i * clipDuration;
      windowEnd = (i + 1) * clipDuration;
      isIntro = true;
    } else {
      // Static images: distributed across remaining audio duration, SCRIPT-SYNCED
      // These start at 1:00 (after intro) and match narration timestamps
      const staticIndex = i - actualClipCount;
      windowStart = clipsTotalDuration + (staticIndex * staticImageDuration);
      windowEnd = clipsTotalDuration + ((staticIndex + 1) * staticImageDuration);
      isIntro = false;
    }

    // For intro images, don't pull script text - they're Topic/Focus-driven
    // For static images, sync to script at their actual timestamp (starting at 1:00)
    let text: string;
    if (isIntro) {
      // Intro images get a placeholder - actual content comes from Topic/Focus
      text = `INTRO SCENE ${i + 1}`;
    } else {
      // Static images sync to script at their timestamp
      const overlappingSegments = segments.filter(seg =>
        seg.startSeconds < windowEnd && seg.endSeconds > windowStart
      );
      text = overlappingSegments.map(s => s.text).join(' ') || `Scene ${i + 1}`;
    }

    windows.push({
      startSeconds: windowStart,
      endSeconds: windowEnd,
      text,
      isIntro,
    });
  }

  return windows;
}

router.post('/', async (req: Request, res: Response) => {
  const { script, srtContent, imageCount, stylePrompt, masterStylePrompt, modernKeywordFilter, audioDuration, stream, projectId, topic, subjectFocus, clipCount = 12, clipDuration = 5 } = req.body;
  // Accept both stylePrompt (from frontend) and masterStylePrompt (from pipeline) for compatibility
  const effectiveStylePrompt = stylePrompt || masterStylePrompt || '';
  // Default to true for backward compatibility (filter enabled by default)
  const shouldFilterKeywords = modernKeywordFilter !== false;
  // Topic is used to anchor images to a specific historical era
  const eraTopic = topic || '';
  // Subject focus specifies who the documentary is about (e.g., "servants, housemaids")
  const storySubjectFocus = subjectFocus || '';

  // Always use Sonnet for best quality scene descriptions
  const selectedModel = 'claude-sonnet-4-5-20250929';

  // Keepalive interval for SSE
  let heartbeatInterval: NodeJS.Timeout | null = null;

  // Setup SSE if streaming is enabled
  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    heartbeatInterval = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);
  }

  const sendEvent = (data: any) => {
    if (stream) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  const cleanup = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  };

  try {
    if (!script || !srtContent) {
      const error = { error: 'Script and SRT content are required' };
      if (stream) {
        sendEvent({ type: 'error', ...error });
        cleanup();
        return res.end();
      }
      return res.status(400).json(error);
    }

    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicApiKey) {
      const error = { error: 'Anthropic API key not configured' };
      if (stream) {
        sendEvent({ type: 'error', ...error });
        cleanup();
        return res.end();
      }
      return res.status(500).json(error);
    }

    console.log(`🚀 Generating ${imageCount} image prompts with ${selectedModel}...`);

    // Parse SRT and group into time windows
    const segments = parseSrt(srtContent);
    const windows = groupSegmentsForImages(segments, imageCount, audioDuration, clipCount, clipDuration);

    console.log(`Parsed ${segments.length} SRT segments into ${windows.length} time windows`);

    // Send initial progress
    sendEvent({ type: 'progress', progress: 5, message: '5%' });

    // Initialize Anthropic client
    const anthropic = createAnthropicClient(anthropicApiKey);

    // Track token usage for cost tracking
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // PHASE 0: Extract time period from script to ensure accurate imagery
    sendEvent({ type: 'progress', progress: 3, message: 'Analyzing time period...' });
    const timePeriodResult = await extractTimePeriod(anthropic, script);
    const timePeriod = timePeriodResult.context;
    totalInputTokens += timePeriodResult.inputTokens;
    totalOutputTokens += timePeriodResult.outputTokens;

    // Build anachronism list for this specific era
    const eraAnachronisms = timePeriod.anachronisms.length > 0
      ? `\n\nANACHRONISMS TO AVOID FOR ${timePeriod.era.toUpperCase()}:\n- ${timePeriod.anachronisms.join('\n- ')}`
      : '';

    // OPTIMIZATION: Use smaller batches (10) for parallel processing
    // This allows multiple API calls to run simultaneously for faster completion
    const numBatches = Math.ceil(imageCount / BATCH_SIZE_PARALLEL);

    console.log(`📊 Processing ${imageCount} prompts in ${numBatches} parallel batch(es) of ${BATCH_SIZE_PARALLEL}`);

    // Track progress across all parallel batches
    // Initial generation is 5-85%, regeneration phase is 85-98%, final 98-100%
    const batchProgress: number[] = new Array(numBatches).fill(0);
    const updateTotalProgress = () => {
      const totalCompleted = batchProgress.reduce((a, b) => a + b, 0);
      const progress = Math.min(85, 5 + Math.round((totalCompleted / imageCount) * 80));
      sendEvent({ type: 'progress', progress, message: `Generating prompts... ${Math.round((totalCompleted / imageCount) * 100)}%` });
    };

    // OPTIMIZATION: Define system prompt once for prompt caching
    // Simplified formula-based prompt generation for consistent, short image prompts
    const systemPrompt = `You write SHORT image prompts for AI image generation. Output valid JSON only.

=== ABSOLUTE WORD LIMIT: 30 WORDS MAXIMUM ===
CRITICAL: Count your words. If over 30 words, DELETE words until under 30. This is non-negotiable.
Prompts over 30 words will be REJECTED and you will need to regenerate.

=== FORMULA ===
[Era] [Setting], [EXACT COUNT] [Gender] [Age] [Role] in [ERA-SPECIFIC Clothing], [Single VISIBLE Action], [Lighting]

EXAMPLES (15-25 words each - notice they are SHORT):
✅ "Edwardian kitchen 1905, one woman (30s) cook in black dress with white apron, kneading bread dough, warm firelight" (18 words)
✅ "Regency drawing room 1815, one young man (20s) in dark tailcoat with cravat, reading letter by window, afternoon light" (19 words)
✅ "Victorian servants' hall 1870, one elderly man (60s) butler in black tailcoat, polishing silverware, candlelit" (15 words)
✅ "Tudor great hall 1540, three men nobles in padded doublets, raising pewter goblets at feast, torchlight" (16 words)

=== HARD RULES ===
1. **MAX 30 WORDS** - count every word, delete extras
2. **ONE LOCATION** - a single clear place (kitchen, drawing room, street, ballroom)
3. **ONE ACTION** - a single verb (standing, reading, pouring, walking) - NOT multiple actions
4. EXACT COUNT of people: "one woman", "two men" - NEVER "group", "crowd"
5. GENDER + AGE: "woman (30s)", "boy (age 5)" - always specify
6. ERA-SPECIFIC CLOTHING (see guide below)
7. ONLY VISIBLE elements - nothing you cannot photograph
8. **PLAIN VOCABULARY** - use simple words the AI understands:
   - ❌ "gilt box" → ✅ "opera balcony"
   - ❌ "escritoire" → ✅ "writing desk"
   - ❌ "chatelaine" → ✅ "keys on belt"
   - ❌ "reticule" → ✅ "small handbag"

=== VISUAL ONLY - THIS IS CRITICAL ===
You can ONLY describe what a CAMERA can capture. Delete anything invisible.

**BANNED - NON-VISUAL SENSORY DETAILS:**
❌ SCENTS: "scent of polish", "perfume of honeysuckle", "smell of bread", "aroma", "fragrance"
❌ SOUNDS: "sound of laughter", "bells ringing", "whispered words", "quiet murmurs"
❌ TEMPERATURES: "warm air", "cold breeze", "chill", "heat from the fire"
❌ TEXTURES: "soft fabric", "rough stone", "smooth wood" (unless describing visible appearance)
❌ TASTES: "sweet tea", "bitter medicine"

**BANNED - INTERNAL STATES:**
❌ THOUGHTS: "thinking about", "wondering", "pondering", "contemplating"
❌ FEELINGS: "feeling sad", "happy about", "worried", "anxious", "hopeful"
❌ MEMORIES: "remembering", "recalling", "her mind drifted to"
❌ INTENTIONS: "about to", "planning to", "hoping to"

**WRONG vs RIGHT EXAMPLES:**
❌ WRONG (47 words, has scents): "Victorian parlor 1865, one housemaid (25) in black dress kneels beside mahogany table rubbing beeswax into wood, the scent of polish mixing with coal smoke, golden afternoon light, the perfume of honeysuckle from the garden"
✅ RIGHT (22 words): "Victorian parlor 1865, one woman housemaid (25) in black dress with white cap, polishing mahogany table, golden afternoon light"

❌ WRONG (has temperature): "Georgian kitchen, warm air rising from the hearth as cook stirs pot"
✅ RIGHT: "Georgian kitchen 1780, one woman cook (40s) in linen cap and apron, stirring iron pot over hearth fire, morning light"

❌ WRONG (has thoughts): "She stood at the window thinking of her lost love"
✅ RIGHT: "Regency bedroom 1815, one young woman (20s) in white muslin gown, standing at window gazing out, soft morning light"

=== ERA-SPECIFIC CLOTHING GUIDE ===
- Georgian (1714-1830): wide skirts, powdered wigs, breeches, waistcoats, tricorn hats
- Regency (1811-1820): empire waists, tailcoats, cravats, high collars, bonnets
- Victorian (1837-1901): crinolines, bustles, top hats, frock coats
- Edwardian (1901-1910): S-bend corsets, high necks, boater hats, morning suits
- Tudor (1485-1603): doublets, ruffs, farthingales, slashed sleeves

=== ERA AND TOPIC (CRITICAL - READ THIS FIRST) ===
**ERA: ${timePeriod.era}** - ALL clothing, architecture, objects MUST match this era exactly
**REGION: ${timePeriod.region}**
${eraTopic ? `**TOPIC: ${eraTopic}** - This is what the documentary is ABOUT. Show scenes relevant to this topic.` : ''}
${storySubjectFocus ? `**SUBJECT FOCUS: ${storySubjectFocus}**
CRITICAL: 80% of images MUST show ${storySubjectFocus} performing TOPIC-RELEVANT actions.
- If topic is "etiquette": show curtseying, bowing, formal greetings, proper dining, card leaving
- If topic is "servants": show cleaning, serving, carrying trays, polishing, cooking
- If topic is "fashion": show dressing, fitting gowns, looking in mirrors, shopping
The action should MATCH the topic, not just generic "standing" or "sitting".` : ''}

=== CONTENT SAFETY ===
BANNED: blood, wounds, death, illness, violence, nudity, kissing
ALTERNATIVES: Death → mourning family; Illness → bedside vigil; Battle → soldiers preparing

=== OUTPUT FORMAT ===
Return ONLY valid JSON array. Each sceneDescription must be UNDER 30 WORDS:
[
  {"index": 1, "sceneDescription": "[15-25 words max]"},
  {"index": 2, "sceneDescription": "..."}
]`;

    // OPTIMIZATION: Enable prompt caching for system prompt (90% cost reduction on repeat calls)
    const systemConfig = [
      {
        type: 'text' as const,
        text: systemPrompt,
        cache_control: { type: 'ephemeral' as const }
      }
    ];

    // Create all batch tasks (functions that return promises) for controlled concurrency
    const batchTasks = Array.from({ length: numBatches }, (_, batchIndex) => async () => {
      const batchStart = batchIndex * BATCH_SIZE_PARALLEL;
      const batchEnd = Math.min((batchIndex + 1) * BATCH_SIZE_PARALLEL, imageCount);
      const batchWindows = windows.slice(batchStart, batchEnd);
      const batchSize = batchWindows.length;

      // Build context for this batch - differentiate intro vs script-synced images
      const hasIntroImages = batchWindows.some(w => w.isIntro);
      const hasScriptImages = batchWindows.some(w => !w.isIntro);

      const windowDescriptions = batchWindows.map((w, i) => {
        const imageNum = batchStart + i + 1;
        const timecode = `${formatTimecodeForFilename(w.startSeconds)} to ${formatTimecodeForFilename(w.endSeconds)}`;

        if (w.isIntro) {
          // Intro images are Topic/Focus-driven, not script-synced
          return `IMAGE ${imageNum} (${timecode}):\nINTRO SCENE - Topic/Focus-driven establishing or thematic scene (see instructions below)`;
        } else {
          // Script-synced images match narration
          return `IMAGE ${imageNum} (${timecode}):\nNarration being spoken: "${w.text}"`;
        }
      }).join('\n\n');

      // Calculate tokens needed for this batch (use model-specific limit)
      const batchTokens = Math.min(MAX_TOKENS, batchSize * 500 + 1000);

      // Retry the Claude API call + JSON parsing up to 3 times per batch
      return retryWithBackoff(async () => {
        let fullResponse = '';

        const messageStream = await anthropic.messages.stream({
          model: selectedModel,
          max_tokens: batchTokens,
          system: formatSystemPrompt(systemConfig) as Anthropic.MessageCreateParams['system'],
          messages: [
            {
              role: 'user',
              content: `Generate exactly ${batchSize} visual scene descriptions for images ${batchStart + 1} to ${batchEnd}. Return ONLY the JSON array, nothing else.

ERA: ${eraTopic || timePeriod.era}
${storySubjectFocus ? `SUBJECT FOCUS: ${storySubjectFocus}` : ''}

SCRIPT CONTEXT (for understanding the era and setting):
${script.substring(0, 12000)}

IMAGE SEGMENTS:
${windowDescriptions}

${hasIntroImages ? `
=== INTRO IMAGES (First ${clipCount || 12} images become VIDEO CLIPS) ===
CRITICAL: These images become animated video clips. They must work as STANDALONE visuals.

**IMAGE 1 MUST BE A WIDE ESTABLISHING SHOT:**
- Wide/aerial view of the era's world - a street, cityscape, estate exterior, landscape
- Shows the TIME PERIOD and SETTING at a glance
- Can include tiny distant people for scale, but NO close-ups of faces
- Example: "Victorian London 1870, wide view of foggy cobblestone street with horse carriages and gas lamps, distant pedestrians in period dress, morning mist"
- NOT a close-up, NOT people doing specific actions, NOT an interior room

**IMAGES 2-${clipCount || 12} - VARIED THEMATIC SCENES:**
- Mix of exteriors and interiors
- Show PEOPLE in the era doing activities (but not the specific script narration yet)
${storySubjectFocus ? `- Feature ${storySubjectFocus} doing era-appropriate activities: working, walking, interacting` : ''}
- 80-90% should include VISIBLE PEOPLE
- Vary the compositions: some wide shots, some medium shots, some with one person, some with groups
` : ''}
${hasScriptImages ? `
=== SCRIPT-SYNCED IMAGES ===
Images with "Narration being spoken" should illustrate THE SPECIFIC MOMENT from the narration.
Show the people, places, and events being discussed at that exact timestamp.
Use era-appropriate clothing, architecture, and settings for ${timePeriod.era}.
` : ''}
Remember: Output ONLY a JSON array with ${batchSize} items, starting with index ${batchStart + 1}. No explanations.`
            }
          ],
        });

        // Process stream and track progress
        for await (const event of messageStream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            fullResponse += event.delta.text;

            // Count completed scenes in this batch
            const completedInBatch = (fullResponse.match(/\"sceneDescription\"\s*:\s*\"[^\"]+\"/g) || []).length;
            batchProgress[batchIndex] = completedInBatch;
            updateTotalProgress();
          }
        }

        // Get token usage from this batch
        const finalMessage = await messageStream.finalMessage();

        // Debug: log finalMessage when response is too short
        if (fullResponse.length < 200) {
          console.error(`[Batch ${batchIndex + 1}] Short response (${fullResponse.length} chars). Stop reason: ${finalMessage?.stop_reason}`);
          console.error(`[Batch ${batchIndex + 1}] Full response: "${fullResponse}"`);
          console.error(`[Batch ${batchIndex + 1}] Message content:`, JSON.stringify(finalMessage?.content?.slice(0, 1), null, 2));
        }
        if (finalMessage?.usage) {
          totalInputTokens += finalMessage.usage.input_tokens || 0;
          totalOutputTokens += finalMessage.usage.output_tokens || 0;
        }

        // Parse the JSON response for this batch (robust extraction)
        const batchDescriptions = extractJsonArray(fullResponse) as { index: number; sceneDescription: string }[] | null;
        if (!batchDescriptions || !Array.isArray(batchDescriptions) || batchDescriptions.length === 0) {
          console.error(`[Batch ${batchIndex + 1}] Invalid response (${fullResponse.length} chars): ${fullResponse.substring(0, 500)}`);
          throw new Error(`No valid JSON array found in batch ${batchIndex + 1} response (length=${fullResponse.length})`);
        }

        // Adjust indices if needed (Claude might start from 1 in each batch)
        for (const desc of batchDescriptions) {
          // If index is within batch range (1 to batchSize), adjust to global index
          if (desc.index >= 1 && desc.index <= batchSize) {
            desc.index = batchStart + desc.index;
          }
        }

        console.log(`Batch ${batchIndex + 1}/${numBatches}: generated ${batchDescriptions.length} descriptions`);
        return batchDescriptions;
      }, `batch ${batchIndex + 1}/${numBatches}`);
    });

    // Run batches with controlled concurrency to avoid rate limits
    console.log(`📊 Processing batches with max ${MAX_CONCURRENT_BATCHES} concurrent requests`);
    const batchSettled = await processBatchesWithConcurrency(batchTasks, MAX_CONCURRENT_BATCHES);

    // FIX: Don't trust Claude's indices - use array position instead
    // Each batch returns items that should correspond to its window range
    const sceneDescriptions: { index: number; sceneDescription: string }[] = [];
    const failedBatches: number[] = [];

    for (let batchIndex = 0; batchIndex < batchSettled.length; batchIndex++) {
      const result = batchSettled[batchIndex];
      if (result.status === 'fulfilled') {
        const batchStart = batchIndex * BATCH_SIZE_PARALLEL;
        // Assign correct indices based on batch position, not Claude's returned index
        const batchResults = result.value.map((item, itemIndex) => ({
          index: batchStart + itemIndex + 1, // Force correct 1-based index
          sceneDescription: item.sceneDescription,
        }));
        sceneDescriptions.push(...batchResults);
        console.log(`Batch ${batchIndex + 1}: assigned indices ${batchStart + 1} to ${batchStart + batchResults.length}`);
      } else {
        failedBatches.push(batchIndex + 1);
        console.error(`Batch ${batchIndex + 1}/${numBatches} failed after ${RETRY_MAX_ATTEMPTS} retries: ${result.reason}`);
      }
    }

    // RETRY FAILED BATCHES: Give them 2 more attempts
    let retryAttempt = 0;
    while (failedBatches.length > 0 && retryAttempt < 2) {
      retryAttempt++;
      console.log(`🔄 Retrying ${failedBatches.length} failed batch(es) (attempt ${retryAttempt}/2)...`);
      sendEvent({ type: 'progress', progress: 82 + retryAttempt, message: `Retrying ${failedBatches.length} failed batches...` });

      const retryResults = await Promise.allSettled(
        failedBatches.map(async (batchNum) => {
          const batchIndex = batchNum - 1;
          const batchStart = batchIndex * BATCH_SIZE_PARALLEL;
          const batchEnd = Math.min(batchStart + BATCH_SIZE_PARALLEL, windows.length);
          const batchWindows = windows.slice(batchStart, batchEnd);
          const batchSize = batchWindows.length;

          const batchWindowDescriptions = batchWindows.map((w, i) => {
            const imageNum = batchStart + i + 1;
            if (w.isIntro) {
              return `IMAGE ${imageNum}: INTRO - thematic establishing scene for ${eraTopic || timePeriod.era}`;
            } else {
              return `IMAGE ${imageNum}: "${w.text}"`;
            }
          }).join('\n');

          const response = await anthropic.messages.create({
            model: selectedModel,
            max_tokens: Math.min(MAX_TOKENS, batchSize * 500 + 1000),
            system: formatSystemPrompt(systemPrompt) as Anthropic.MessageCreateParams['system'],
            messages: [{ role: 'user', content: `Generate prompts for images ${batchStart + 1} to ${batchEnd}:\n\n${batchWindowDescriptions}` }],
          });

          const text = response.content[0].type === 'text' ? response.content[0].text : '';
          const batchDescriptions = extractJsonArray(text) as { index: number; sceneDescription: string }[] | null;

          if (!batchDescriptions || batchDescriptions.length === 0) {
            throw new Error('Empty or invalid response');
          }

          return { batchNum, batchStart, descriptions: batchDescriptions };
        })
      );

      // Process retry results
      const successfulRetries: number[] = [];
      for (const result of retryResults) {
        if (result.status === 'fulfilled') {
          const { batchNum, batchStart, descriptions } = result.value;
          const batchResults = descriptions.map((item, itemIndex) => ({
            index: batchStart + itemIndex + 1,
            sceneDescription: item.sceneDescription,
          }));
          sceneDescriptions.push(...batchResults);
          successfulRetries.push(batchNum);
          console.log(`✅ Batch ${batchNum} retry succeeded: ${descriptions.length} prompts`);
        }
      }

      // Remove successful batches from failed list
      for (const batchNum of successfulRetries) {
        const idx = failedBatches.indexOf(batchNum);
        if (idx !== -1) failedBatches.splice(idx, 1);
      }
    }

    // Warn frontend about any remaining failed batches
    if (failedBatches.length > 0) {
      const failedImageRanges = failedBatches.map(b => {
        const start = (b - 1) * BATCH_SIZE_PARALLEL + 1;
        const end = Math.min(b * BATCH_SIZE_PARALLEL, imageCount);
        return `${start}-${end}`;
      });
      console.warn(`[generate-image-prompts] ${failedBatches.length} batch(es) still failed after retries: images ${failedImageRanges.join(', ')}`);
      sendEvent({
        type: 'warning',
        message: `${failedBatches.length} batch(es) failed after all retries. Images ${failedImageRanges.join(', ')} will use fallback descriptions.`,
      });
    }

    // If ALL batches failed, that's a hard error
    if (sceneDescriptions.length === 0) {
      throw new Error(`All ${numBatches} batch(es) failed to generate image prompts after retries`);
    }

    // Phase 2: Check and regenerate prompts with modern keywords IN PARALLEL
    // This happens after initial generation and can take significant time
    sendEvent({ type: 'progress', progress: 85, message: 'Checking for modern keywords...' });

    // First pass: identify which prompts need regeneration
    interface RegenTask {
      index: number;
      sceneDesc: string;
      foundKeywords: string[];
      narrationText: string;
    }
    const regenTasks: RegenTask[] = [];

    // Only check for modern keywords if filter is enabled
    if (shouldFilterKeywords) {
      for (let i = 0; i < windows.length; i++) {
        const scene = sceneDescriptions.find(s => s.index === i + 1);
        const sceneDesc = scene?.sceneDescription || `Historical scene depicting: ${smartTruncate(windows[i].text, 200)}`;
        const foundKeywords = containsModernKeywords(sceneDesc);

        if (foundKeywords.length > 0) {
          regenTasks.push({
            index: i,
            sceneDesc,
            foundKeywords,
            narrationText: windows[i].text,
          });
        }
      }
    }

    // Map to store regenerated descriptions by index
    const regeneratedDescriptions = new Map<number, string>();

    if (shouldFilterKeywords && regenTasks.length > 0) {
      console.log(`Found ${regenTasks.length} prompts with modern keywords, regenerating in parallel...`);
      sendEvent({ type: 'progress', progress: 86, message: `Regenerating ${regenTasks.length} prompts with modern keywords...` });

      // Process regeneration tasks in parallel batches of 5
      const REGEN_BATCH_SIZE = 5;
      let completedRegen = 0;

      for (let batchStart = 0; batchStart < regenTasks.length; batchStart += REGEN_BATCH_SIZE) {
        const batch = regenTasks.slice(batchStart, batchStart + REGEN_BATCH_SIZE);

        // Process batch in parallel
        const batchResults = await Promise.all(
          batch.map(async (task) => {
            console.log(`Image ${task.index + 1}: Found modern keywords [${task.foundKeywords.join(', ')}], regenerating...`);

            // First attempt
            const regenResult = await regeneratePrompt(
              anthropic,
              task.sceneDesc,
              task.foundKeywords,
              task.narrationText
            );
            let finalDesc = regenResult.text;
            let taskInputTokens = regenResult.inputTokens;
            let taskOutputTokens = regenResult.outputTokens;

            // Check if regeneration still has keywords
            const remainingKeywords = containsModernKeywords(finalDesc);
            if (remainingKeywords.length > 0) {
              console.log(`Image ${task.index + 1}: Regeneration still has keywords [${remainingKeywords.join(', ')}], trying again...`);
              const secondAttempt = await regeneratePrompt(
                anthropic,
                finalDesc,
                remainingKeywords,
                task.narrationText
              );
              taskInputTokens += secondAttempt.inputTokens;
              taskOutputTokens += secondAttempt.outputTokens;

              const finalKeywords = containsModernKeywords(secondAttempt.text);
              if (finalKeywords.length > 0) {
                console.log(`Image ${task.index + 1}: Warning - still has keywords after 2 regeneration attempts, using best attempt`);
              }
              finalDesc = secondAttempt.text;
            }

            return { index: task.index, description: finalDesc, inputTokens: taskInputTokens, outputTokens: taskOutputTokens };
          })
        );

        // Store results and accumulate token usage
        for (const result of batchResults) {
          regeneratedDescriptions.set(result.index, result.description);
          totalInputTokens += result.inputTokens;
          totalOutputTokens += result.outputTokens;
        }

        completedRegen += batch.length;
        const regenProgress = 86 + Math.round((completedRegen / regenTasks.length) * 12);
        sendEvent({ type: 'progress', progress: Math.min(regenProgress, 98), message: `Regenerated ${completedRegen}/${regenTasks.length} prompts...` });
      }
    }

    // Build final prompts with style and timing info
    const imagePrompts: ImagePrompt[] = [];

    for (let i = 0; i < windows.length; i++) {
      const window = windows[i];
      const scene = sceneDescriptions.find(s => s.index === i + 1);

      // Use regenerated description if available, otherwise use original
      const sceneDesc = regeneratedDescriptions.get(i)
        || scene?.sceneDescription
        || `Historical scene depicting: ${smartTruncate(window.text, 200)}`;

      imagePrompts.push({
        index: i + 1,
        startTime: formatTimecodeForFilename(window.startSeconds),
        endTime: formatTimecodeForFilename(window.endSeconds),
        startSeconds: window.startSeconds,
        endSeconds: window.endSeconds,
        sceneDescription: sceneDesc,
        prompt: `${sceneDesc}. ${effectiveStylePrompt}`,  // Scene FIRST so Z-Image truncation keeps scene
      });
    }

    // CONTENT SAFETY: Find prompts with banned words and ask Claude to rewrite them
    const promptsNeedingSanitization = imagePrompts.filter(p => containsBannedWords(p.sceneDescription).hasBanned);

    if (promptsNeedingSanitization.length > 0) {
      console.log(`🔍 Found ${promptsNeedingSanitization.length} prompts with banned words, asking Claude to rewrite...`);
      sendEvent({ type: 'progress', progress: 96, message: `Sanitizing ${promptsNeedingSanitization.length} prompts...` });

      // Process in parallel batches of 5
      const SANITIZE_BATCH_SIZE = 5;
      for (let i = 0; i < promptsNeedingSanitization.length; i += SANITIZE_BATCH_SIZE) {
        const batch = promptsNeedingSanitization.slice(i, i + SANITIZE_BATCH_SIZE);
        const results = await Promise.all(
          batch.map(p => sanitizePromptWithClaude(anthropic, p.sceneDescription, timePeriod.era, storySubjectFocus, script))
        );

        // Update the prompts with sanitized versions
        for (let j = 0; j < batch.length; j++) {
          const prompt = batch[j];
          const result = results[j];
          prompt.sceneDescription = result.sanitized;
          prompt.prompt = `${result.sanitized}. ${effectiveStylePrompt}`;  // Scene FIRST
          totalInputTokens += result.inputTokens;
          totalOutputTokens += result.outputTokens;
        }
      }

      console.log(`✅ Sanitized ${promptsNeedingSanitization.length} prompts with Claude`);
    }

    console.log(`Generated ${imagePrompts.length} image prompts successfully (regenerated ${regenTasks.length} prompts with modern keywords)`);
    console.log(`Total tokens: ${totalInputTokens} input, ${totalOutputTokens} output`);

    // Save costs to Supabase if projectId provided
    if (projectId) {
      try {
        await Promise.all([
          saveCost({
            projectId,
            source: 'manual',
            step: 'image_prompts',
            service: 'claude',
            units: totalInputTokens,
            unitType: 'input_tokens',
          }),
          saveCost({
            projectId,
            source: 'manual',
            step: 'image_prompts',
            service: 'claude',
            units: totalOutputTokens,
            unitType: 'output_tokens',
          }),
        ]);
      } catch (costError) {
        console.error('[generate-image-prompts] Error saving costs:', costError);
      }
    }

    const result = {
      success: true,
      prompts: imagePrompts,
      totalDuration: segments.length > 0 ? segments[segments.length - 1].endSeconds : 0,
    };

    if (stream) {
      sendEvent({ type: 'progress', progress: 100, message: '100%' });
      sendEvent({ type: 'complete', ...result });
      cleanup();
      res.end();
    } else {
      return res.json(result);
    }

  } catch (error) {
    console.error('Error generating image prompts:', error);

    if (stream) {
      sendEvent({
        type: 'error',
        error: error instanceof Error ? error.message : 'Failed to generate image prompts'
      });
      cleanup();
      res.end();
    } else {
      return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate image prompts' });
    }
  }
});

// Extend existing prompts by adding N more at the end
router.post('/extend', async (req: Request, res: Response) => {
  const {
    script,
    srtContent,
    count,  // How many prompts to add
    startFromSeconds,  // Starting time (end of last existing prompt)
    audioDuration,  // Total audio duration
    stylePrompt,
    topic,
    subjectFocus,
    projectId
  } = req.body;

  // Validate inputs
  if (!count || count < 1 || count > 50) {
    return res.status(400).json({ error: 'Count must be between 1 and 50' });
  }
  if (!startFromSeconds || !audioDuration || startFromSeconds >= audioDuration) {
    return res.status(400).json({ error: 'Invalid time range for new prompts' });
  }

  console.log(`[extend] Adding ${count} prompts from ${startFromSeconds.toFixed(2)}s to ${audioDuration.toFixed(2)}s`);

  try {
    const anthropic = createAnthropicClient();
    const selectedModel = 'claude-sonnet-4-5-20250929';

    // Parse SRT to get text content for the time range
    const segments = parseSrt(srtContent);

    // Calculate windows for new prompts
    const timeRange = audioDuration - startFromSeconds;
    const windowDuration = timeRange / count;

    const windows: { startSeconds: number; endSeconds: number; text: string }[] = [];
    for (let i = 0; i < count; i++) {
      const windowStart = startFromSeconds + (i * windowDuration);
      const windowEnd = startFromSeconds + ((i + 1) * windowDuration);

      // Get overlapping text from SRT
      const overlappingSegments = segments.filter(seg =>
        seg.startSeconds < windowEnd && seg.endSeconds > windowStart
      );
      const text = overlappingSegments.map(s => s.text).join(' ') || `Scene continuation ${i + 1}`;

      windows.push({ startSeconds: windowStart, endSeconds: windowEnd, text });
    }

    console.log(`[extend] Created ${windows.length} windows from ${windows[0]?.startSeconds.toFixed(2)}s to ${windows[windows.length - 1]?.endSeconds.toFixed(2)}s`);

    // Extract time period context
    const { context: timePeriod, inputTokens: contextTokens, outputTokens: contextOutTokens } =
      await extractTimePeriod(anthropic, script.substring(0, 8000));

    let totalInputTokens = contextTokens;
    let totalOutputTokens = contextOutTokens;

    // Generate scene descriptions
    const windowDescriptions = windows.map((w, i) =>
      `IMAGE ${i + 1} (${formatTimecodeForFilename(w.startSeconds)} to ${formatTimecodeForFilename(w.endSeconds)}):\nNarration: "${w.text}"`
    ).join('\n\n');

    const systemPrompt = `You are an expert at creating gorgeous, historically accurate visual descriptions for documentary images.

ERA: ${topic || timePeriod.era}
REGION: ${timePeriod.region}
VISUAL CONSTRAINTS: ${timePeriod.visualConstraints}
${subjectFocus ? `
SUBJECT FOCUS: This documentary focuses on ${subjectFocus}.
CRITICAL: Most images MUST include ${subjectFocus} as VISIBLE PEOPLE in the scene - not empty rooms!
Show THEIR world WITH THEM IN IT - at work, in action, interacting.
When royalty/palaces are mentioned, show ${subjectFocus} working in those spaces (kitchens, stables, servants' quarters).
` : ''}
Create ${count} stunning scene descriptions that continue a documentary video. These are ADDITIONAL images being added to an existing set, so:
- Do NOT include establishing shots (those exist at the start)
- Focus on varied, interesting scenes that complement the narrative
- Mix exteriors, interiors, action, and intimate moments

RULES:
1. Each scene 50-70 words
2. VISUALLY STUNNING - dramatic lighting, rich colors, elegant details
3. Period-accurate clothing and settings
4. NO modern elements (museums, researchers, etc.)
5. Return ONLY a JSON array

Output format:
[
  {"index": 1, "sceneDescription": "..."},
  {"index": 2, "sceneDescription": "..."}
]`;

    const userPrompt = `Generate ${count} visual scene descriptions for these time segments.

SCRIPT CONTEXT:
${script.substring(0, 6000)}

TIME-CODED SEGMENTS:
${windowDescriptions}

Return ONLY a JSON array with ${count} items.`;

    const messageStream = await anthropic.messages.stream({
      model: selectedModel,
      max_tokens: Math.min(MAX_TOKENS, count * 500 + 1000),
      system: formatSystemPrompt(systemPrompt) as Anthropic.MessageCreateParams['system'],
      messages: [{ role: 'user', content: userPrompt }],
    });

    let fullResponse = '';
    for await (const event of messageStream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullResponse += event.delta.text;
      }
    }

    const finalMessage = await messageStream.finalMessage();
    if (finalMessage?.usage) {
      totalInputTokens += finalMessage.usage.input_tokens || 0;
      totalOutputTokens += finalMessage.usage.output_tokens || 0;
    }

    // Parse response
    const sceneDescriptions = extractJsonArray(fullResponse) as { index: number; sceneDescription: string }[] | null;
    if (!sceneDescriptions || sceneDescriptions.length === 0) {
      throw new Error('Failed to parse scene descriptions from response');
    }

    // Build final prompts with timing
    const newPrompts: ImagePrompt[] = [];
    for (let i = 0; i < windows.length; i++) {
      const window = windows[i];
      const scene = sceneDescriptions.find(s => s.index === i + 1);
      const sceneDesc = scene?.sceneDescription || `Historical scene depicting: ${smartTruncate(window.text, 200)}`;

      newPrompts.push({
        index: i + 1,  // Will be renumbered by frontend
        startTime: formatTimecodeForFilename(window.startSeconds),
        endTime: formatTimecodeForFilename(window.endSeconds),
        startSeconds: window.startSeconds,
        endSeconds: window.endSeconds,
        sceneDescription: sceneDesc,
        prompt: `${stylePrompt || ''}. ${sceneDesc}`,
      });
    }

    console.log(`[extend] Generated ${newPrompts.length} new prompts`);
    console.log(`[extend] Tokens: ${totalInputTokens} input, ${totalOutputTokens} output`);

    // Save costs if projectId provided
    if (projectId) {
      try {
        await Promise.all([
          saveCost({ projectId, source: 'manual', step: 'image_prompts_extend', service: 'claude', units: totalInputTokens, unitType: 'input_tokens' }),
          saveCost({ projectId, source: 'manual', step: 'image_prompts_extend', service: 'claude', units: totalOutputTokens, unitType: 'output_tokens' }),
        ]);
      } catch (costError) {
        console.error('[extend] Error saving costs:', costError);
      }
    }

    return res.json({
      success: true,
      prompts: newPrompts,
    });

  } catch (error) {
    console.error('[extend] Error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to extend prompts'
    });
  }
});

export default router;
