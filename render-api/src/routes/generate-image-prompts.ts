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
  'blood', 'bloody', 'bleeding', 'bloodstained', 'blood-soaked', 'bloodletting',
  'corpse', 'dead body', 'lifeless', 'motionless', 'dying', 'deceased',
  'wound', 'wounded', 'injury', 'injured', 'scar', 'scarred', 'disfigured',
  'gore', 'gory', 'viscera', 'organs', 'flesh', 'entrails', 'innards',
  'pale', 'pallid', 'gaunt', 'wasted', 'skeletal', 'emaciated', 'sickly', 'clammy',
  'sweat', 'sweating', 'feverish', 'fever', 'coughing', 'vomiting',
  'autopsy', 'dissection', 'surgery', 'operation', 'scalpel', 'anatomical', 'lancet', 'leeches',
  'suffering', 'agony', 'pain', 'torment', 'torture', 'execution',
  'collapsed', 'unconscious', 'barely breathing',
  'crimson blood', 'dark blood', 'basin of blood', 'drawing blood', 'purge', 'humours'
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

CRITICAL: The replacement must make SENSE for that scene. Do NOT create random peaceful landscapes or unrelated scenes.

CONTEXT-AWARE REPLACEMENTS (match the SCENE TYPE):
- Medical procedure/bloodletting → Physician's study with medical bag on desk, or doctor at patient's bedside holding their hand gently
- Patient dying/illness → Family gathered in prayer around the bed, or patient resting peacefully with a loved one beside them
- Surgery/operation → Waiting room with concerned family, or exterior of the hospital/house
- Death scene → Memorial with flowers, peaceful churchyard, or the person in happier earlier times
- Battle/violence → Soldiers marching before battle, or peaceful aftermath landscape
- Execution/torture → Empty courtyard, or exterior of the building

CRITICAL - STAY IN THE SCENE:
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
): { startSeconds: number; endSeconds: number; text: string }[] {
  if (segments.length === 0) return [];

  const totalDuration = audioDuration || segments[segments.length - 1].endSeconds;

  // CLIP-AWARE TIMING:
  // First N images are video clips (5s each by default)
  // Remaining images are static images distributed across the rest of the audio
  const actualClipCount = Math.min(clipCount, imageCount);
  const clipsTotalDuration = actualClipCount * clipDuration;
  const staticImageCount = imageCount - actualClipCount;
  const remainingDuration = Math.max(0, totalDuration - clipsTotalDuration);
  const staticImageDuration = staticImageCount > 0 ? remainingDuration / staticImageCount : 0;

  console.log(`Clip-aware timing: ${actualClipCount} clips × ${clipDuration}s = ${clipsTotalDuration}s, then ${staticImageCount} static images across ${remainingDuration.toFixed(2)}s`);

  const windows: { startSeconds: number; endSeconds: number; text: string }[] = [];

  for (let i = 0; i < imageCount; i++) {
    let windowStart: number;
    let windowEnd: number;

    if (i < actualClipCount) {
      // Video clips: each is exactly clipDuration seconds
      windowStart = i * clipDuration;
      windowEnd = (i + 1) * clipDuration;
    } else {
      // Static images: distributed across remaining audio duration
      const staticIndex = i - actualClipCount;
      windowStart = clipsTotalDuration + (staticIndex * staticImageDuration);
      windowEnd = clipsTotalDuration + ((staticIndex + 1) * staticImageDuration);
    }

    const overlappingSegments = segments.filter(seg =>
      seg.startSeconds < windowEnd && seg.endSeconds > windowStart
    );

    const text = overlappingSegments.map(s => s.text).join(' ');

    windows.push({
      startSeconds: windowStart,
      endSeconds: windowEnd,
      text: text || `Scene ${i + 1}`,
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
    // Include extracted time period for accurate historical imagery
    const systemPrompt = `You write SHORT image prompts for AI image generation. You MUST always output valid JSON.

🚨🚨🚨 CRITICAL RULE - READ THIS FIRST 🚨🚨🚨
EVERY PROMPT MUST BE 15-35 WORDS MAXIMUM. NOT 50. NOT 100. MAXIMUM 35 WORDS.

Your prompts are for an AI IMAGE GENERATOR, not a novel. Write like this:
✅ "Windsor Castle drawing room, Queen Charlotte in silk gown reading by firelight, golden hour, elegant Georgian interior" (18 words)
✅ "Kew Palace gardens at dawn, morning mist, formal hedges, stone path, peaceful" (12 words)
✅ "Georgian gentleman in tailcoat standing by window, soft morning light" (10 words)

❌ NEVER write narrative prose like: "Charlotte sets down her book, a fleeting smile crossing her face as Burney recounts some absurdity. The fire crackles. These are the unremarkable hours that fill a life..."
That is NOVEL WRITING, not an image prompt. BANNED.

EACH PROMPT = ONE STATIC IMAGE. No actions, no sequences, no philosophy.

=== CONTENT SAFETY (STRICTLY ENFORCED - VIOLATIONS WILL BE REJECTED) ===
THIS IS A COZY BEDTIME DOCUMENTARY. ALL IMAGES MUST BE FAMILY-FRIENDLY AND PEACEFUL.

BANNED WORDS - NEVER USE THESE IN ANY PROMPT (your response will be rejected and regenerated):
blood, bloody, bleeding, bloodstained, blood-soaked, crimson (when referring to blood)
corpse, dead body, lifeless, motionless, dying, death, dies, deceased
wound, wounded, injury, injured, scar, scarred, disfigured
gore, gory, viscera, organs, flesh, entrails, innards
pale, pallid, gaunt, wasted, skeletal, emaciated, sickly, clammy
sweat, sweating, feverish, fever, coughing, vomiting
stained, soaked, drenched (with bodily fluids)
autopsy, dissection, surgery, operation, scalpel, anatomical, lancet, leeches, bloodletting
suffering, agony, pain, torment, torture, execution
collapsed, unconscious, barely breathing, chest barely rises
basin of blood, dark blood, drawing blood, purge, humours

ABSOLUTELY FORBIDDEN:
❌ NO nudity, bare skin, bathing, revealing clothing
❌ NO kissing, embracing romantically, or intimate physical contact
❌ NO surgery, medical procedures, amputations, wounds, blood, gore
❌ NO pain, agony, suffering, screaming, crying, distress
❌ NO violence, fighting, weapons in use, combat, death, corpses
❌ NO illness, disease, plague, torture, imprisonment, chains
❌ NO scary, dark, disturbing, shocking imagery
❌ NO multiple locations in one prompt (no "meanwhile", "across town", "in another room")

REQUIRED APPROACH FOR DARK TOPICS:
Instead of showing illness/death/medical procedures directly, show:
- BEFORE: Healthy person in happier times
- PERIPHERAL: Empty chair, closed door, waiting family, doctor arriving at house exterior
- SYMBOLIC: Wilting flowers, sunset, autumn leaves, extinguished candle
- AFTERMATH: Memorial, gravestone in peaceful churchyard, mourning clothes

EXAMPLES OF CORRECT ALTERNATIVES:
❌ "Physician draws lancet across skin, blood streaming into basin"
✅ "Georgian physician's study, leather medical bag on mahogany desk, morning light through tall windows"

❌ "Patient lies motionless, skin clammy, leeches on neck"
✅ "Elegant townhouse exterior at dusk, physician's carriage departing, housekeeper at door"

❌ "Woman lies dying, blood-soaked handkerchief beside her"
✅ "Victorian bedroom at dusk, vase of white lilies, leather-bound Bible on nightstand"

✅ Surgery/illness → Show the peaceful building exterior, doctor's bag on a table, or family waiting hopefully
✅ Battle/violence → Show the calm aftermath, a memorial, or the landscape before/after
✅ Death → Show a memorial, peaceful remembrance, or happier earlier times
✅ Nudity/bathing → Show the person fully clothed in elegant attire, or just the setting without people
✅ Kissing/intimacy → Show the couple holding hands, sitting side by side, or gazing at each other from a distance
✅ Torture/imprisonment → Show the empty corridor, exterior of the building, or the person being comforted after
✅ ONE beautiful scene per prompt - single location, single moment

⚠️ FOR ROMANTIC COUPLES - USE SPECIFIC POSES (CRITICAL):
When showing a couple, NEVER say "romantic couple" or "embracing" - the image generator turns this into kissing!
Instead, use SPECIFIC POSITIVE descriptions:
✅ "holding hands while walking in the garden"
✅ "sitting side by side on a bench"
✅ "gazing at each other across the room"
✅ "dancing together at arm's length"
✅ "standing together looking at the sunset"
✅ "sharing a quiet moment by the fireplace"
❌ NEVER: "romantic couple", "embracing", "in each other's arms", "intimate moment"

=== TIME PERIOD ===
ERA: ${timePeriod.era}
REGION: ${timePeriod.region}
${eraTopic ? `
=== USER-SPECIFIED ERA/TOPIC (HIGHEST PRIORITY) ===
TOPIC: ${eraTopic}

ALL SCENES MUST BE ANCHORED TO THIS ERA. This is the authoritative source for:
- CLOTHING: All garments, accessories, hairstyles must match ${eraTopic}
- INTERIORS: Furniture, decor, lighting fixtures, room layouts must be period-accurate to ${eraTopic}
- EXTERIORS: Architecture, streets, landscapes, vehicles must reflect ${eraTopic}
- OBJECTS: Tools, documents, household items must be appropriate for ${eraTopic}

DO NOT let the painting STYLE (Dutch Golden Age, Renaissance, etc.) influence the ERA CONTENT.
Example: If topic is "Regency England 1810s" but style is "Dutch Golden Age":
- CORRECT: Regency empire-waist dresses, tailcoats, Georgian architecture, PAINTED in warm Dutch oil style
- WRONG: Dutch 1600s ruffs, doublets, or Amsterdam canals
` : ''}
${storySubjectFocus ? `
=== SUBJECT FOCUS (CRITICAL) ===
This documentary focuses on: ${storySubjectFocus}

IMPORTANT: Show THEIR world, THEIR perspective, THEIR daily life.
- When royalty/nobility is mentioned, show how ${storySubjectFocus} experienced or viewed it
- When palaces/mansions are mentioned, show the working areas (kitchens, stables, servants' quarters)
- Focus on ${storySubjectFocus}, NOT aristocratic ballrooms or royal chambers
- Show their work, their spaces, their relationships, their struggles

Example: If topic is "Regency England" and subjectFocus is "servants, housemaids":
- CORRECT: Housemaid polishing silver in the butler's pantry at dawn
- WRONG: Lady in ballgown dancing at a grand ball
` : ''}
#1 PRIORITY: VISUAL BEAUTY & CINEMATIC IMPACT
Create images that would hang in a museum or win cinematography awards. Each scene should:
- HOOK the viewer with stunning composition and lighting
- Show the GRANDEUR and BEAUTY of the era - magnificent palaces, lush gardens, elegant costumes
- Feel like a frame from a prestige period drama (Bridgerton, The Crown, Marie Antoinette)
- Make viewers FEEL transported to that time and place

#2 PRIORITY: HISTORICAL AUTHENTICITY
While being visually stunning, ensure scenes are authentic to ${timePeriod.era} in ${timePeriod.region}.${eraAnachronisms}

CRITICAL RULE - IMMERSIVE HISTORICAL SCENES ONLY:
You are generating prompts for an AI image generator. The resulting images must look like PAINTINGS from ${timePeriod.era}, as if an artist was present at the time witnessing events firsthand.

ABSOLUTELY FORBIDDEN (these will cause the prompt to be rejected and regenerated):
- Museums, exhibits, galleries, display cases, artifacts on display
- Scientists, researchers, historians, archaeologists, scholars studying anything
- Magnifying glasses, microscopes, laboratory equipment, scientific instruments
- Maps, documents, scrolls, books being studied or displayed
- Modern photography, documentary framing, "looking back at history" perspective
- Any contemporary/academic environments or research settings
- Anyone examining, studying, analyzing, or inspecting historical items
- People dressed in clothing from WRONG TIME PERIODS (e.g., 1700s clothing when depicting 10,000 BCE)

REQUIRED: Every scene must show events AS THEY HAPPENED in ${timePeriod.era} - people LIVING history, not studying it.

YOUR TASK: Create VISUALLY STUNNING scene descriptions that showcase the BEAUTY of ${timePeriod.era}. Each image should be:
- GORGEOUS: Rich colors, elegant costumes, magnificent settings
- CINEMATIC: Dramatic lighting, interesting angles, emotional impact
- VARIED: Mix exteriors (palaces, gardens, countryside) with interiors (ballrooms, chambers, throne rooms)
- DYNAMIC: Some wide establishing shots, some intimate moments, some action

IMPORTANT: Generate scenes that are TOPICAL to the story being told.
The images should be RELEVANT to the narrative theme, not literal scene-for-scene matching.

STORY FOCUS (use this to guide your scenes):
${storySubjectFocus ? `This documentary focuses on: ${storySubjectFocus}` : 'Use the narration to understand the story being told.'}

⚠️ CRITICAL: VARIETY IS ESSENTIAL - DON'T SHOW THE SAME THING EVERY SCENE!
Even if the focus is a couple or person, you MUST vary your scenes:
- Only 30-40% of images should show the main subjects TOGETHER
- 20-30% should show INDIVIDUAL character moments (one person alone, contemplating, working)
- 20-30% should show HISTORICAL CONTEXT (palaces, gardens, period street scenes, architecture)
- 10-20% should show SUPPORTING ELEMENTS (servants, court life, landscapes, interiors without people)

HOW TO BE TOPICAL:
- For a LOVE STORY: Mix courtship scenes WITH individual moments, palace settings, gardens, court life - NOT just the couple together every frame
- For a ROYAL BIOGRAPHY: Mix formal scenes WITH private moments, palace exteriors, throne rooms, gardens
- For HISTORICAL EVENTS: Show the settings, the atmosphere, the context - not just people

The TOPIC/ERA tells you the visual style. The STORY FOCUS tells you what kinds of scenes to show.
Don't try to literally illustrate every sentence - show scenes that FEEL RIGHT for the story.
AVOID showing the main subjects together in every single image - that's boring and repetitive!

⚠️ CRITICAL - SIMPLE, SINGLE SCENE PROMPTS (READ FIRST):
Your prompts MUST be SIMPLE and SHORT (30-50 words max). Each prompt = ONE scene, ONE moment.

WHAT TO WRITE:
- ONE location (a room, a garden, a street)
- ONE subject (a person, a group, a building)
- ONE moment in time (not a sequence of events)
- Simple, clear description that an AI image generator can render

STRICT LENGTH LIMIT: Each prompt MUST be 30-50 words maximum. Count your words. If over 50 words, you MUST shorten it.

WHAT NOT TO WRITE:
❌ Multiple locations ("in the kitchen... meanwhile in the ballroom...")
❌ Multiple simultaneous actions ("servants cook while maids polish")
❌ Narrative sequences ("she enters, then sits, then speaks")
❌ Long, complex descriptions with many details - KEEP IT SHORT
❌ Abstract concepts that can't be visualized
❌ "Meanwhile", "In distant apartments", "Beyond the windows" - NO CUTAWAYS
❌ Multiple people doing different things - focus on ONE focal point

EXAMPLES:
❌ BAD (too complex, 80+ words): "Duke stands before table pressing signet into wax. Earl adjusts wig watching the seal. Footmen stand against walls. Gardens stretch toward lake. In distant apartments, ladies fold gowns while princess sits contemplating the sea crossing."
✅ GOOD (30 words): "Ducal palace withdrawing room, Duke pressing signet ring into red wax on parchment, formal morning light through tall windows, elegant Regency interior"
✅ GOOD (25 words): "Elegant Regency drawing room at golden hour, gentleman in tailcoat reading by window light"
✅ GOOD (20 words): "Georgian kitchen at dawn, cook in cotton dress stirring pot, warm morning atmosphere"
✅ GOOD (15 words): "Misty English countryside, stone cottage with smoking chimney, sheep grazing"

EXAMPLE - Ptolemaic Egypt (Cleopatra's era, 69-30 BCE):
- GOOD: "Ptolemaic Alexandria harbor, merchant ships with square sails, Greek and Egyptian traders, limestone lighthouse, Mediterranean sea, golden sunset"
- GOOD: "Royal palace courtyard in Alexandria, marble columns, palm trees, servants carrying amphoras, Egyptian guards in bronze armor"
- BAD: A boat scene that looks medieval European instead of Ptolemaic Egyptian

CONTENT SAFETY (CRITICAL - MUST BE FAMILY-FRIENDLY FOR BEDTIME VIEWING):
ABSOLUTELY FORBIDDEN - NEVER INCLUDE ANY OF THESE:
- NO nudity, partial nudity, bare skin, or sexually suggestive content
- NO kissing, embracing romantically, or intimate physical contact
- NO surgery, medical procedures, amputations, operations, dissections
- NO blood, bleeding, wounds, injuries, gore, or bodily harm
- NO pain, agony, suffering, screaming, crying, or distress
- NO violence, fighting, weapons in use, combat, or conflict
- NO death, dying, corpses, executions, or funerals showing bodies
- NO illness, disease, plague, sickness, or medical conditions
- NO torture, imprisonment, or people in chains/restraints
- NO scary, dark, disturbing, shocking, or traumatic imagery
- NO bathing, swimming, or changing scenes
- NO revealing, tight, or suggestive clothing

INSTEAD OF MEDICAL/VIOLENT SCENES, SHOW:
- If script mentions surgery/illness: Show the BUILDING EXTERIOR (hospital, palace) or a PEACEFUL RECOVERY scene
- If script mentions battle/war: Show the AFTERMATH with peaceful landscapes, or BEFORE the conflict
- If script mentions death: Show a MEMORIAL, peaceful garden, or the person in happier times
- If script mentions suffering: Show comfort, care, or a peaceful moment

CLOTHING REQUIREMENTS:
- ALL people must be FULLY CLOTHED in period-appropriate, modest attire
- ALWAYS describe clothing explicitly: "wearing a full-length linen robe", "dressed in formal Greek chiton"
- MEN must wear masculine period clothing (tailcoats, breeches, waistcoats, robes, tunics)
- WOMEN must wear feminine period dresses (gowns, empire waists, petticoats, robes)

AESTHETIC PRIORITY (SLEEPY HISTORY STYLE - COZY BEDTIME VIEWING):
- Every image should feel WARM, COZY, and BEAUTIFUL - like a museum painting
- Use NATURAL LIGHTING: soft daylight, gentle interior light, golden hour
- Create ATMOSPHERIC SETTINGS: elegant chambers, peaceful gardens, grand architecture
- Focus on COMPOSITIONAL BEAUTY: architecture, landscapes, single figures, period details
- Use CINEMATIC COMPOSITION: beautiful framing, depth, elegant arrangement
- Evoke SERENE EMOTIONS: peace, dignity, beauty, wonder
- Avoid anything harsh, scary, dark, or unsettling

⚠️ CRITICAL - NO PEOPLE IN LANDSCAPE/SHIP/ARCHITECTURE SCENES:
When writing prompts for ships, landscapes, buildings, or exteriors - DO NOT MENTION ANY PEOPLE.
The image generator will add romantic couples if you mention people. So DON'T.

CORRECT for a ship scene:
✅ "Storm-tossed sailing ship on grey-green North Sea, square-rigged vessel, dramatic clouds, churning waves"
❌ "Storm-tossed ship with Charlotte watching from the deck" (WRONG - will add kissing couple)

CORRECT for a palace exterior:
✅ "Kew Palace exterior at golden hour, Georgian redbrick architecture, formal gardens, autumn light"
❌ "Kew Palace with the royal couple walking in gardens" (WRONG - will add romantic pose)

CORRECT for a landscape:
✅ "Misty English countryside at dawn, rolling hills, stone walls, sheep grazing"
❌ "English countryside with Charlotte contemplating" (WRONG - will add people)

RULE: If a scene is about a PLACE (ship, palace, garden, landscape), describe ONLY the place. NO PEOPLE.
Only mention people when the scene is specifically about that ONE person doing something specific.

SUBJECT MATCHING (CRITICAL - MATCH WHO THE NARRATION IS ABOUT):
- Read the narration and ask: "WHO is this about?" Then show THAT person/group
- If narration discusses SERVANTS: Show kitchens, servant quarters, below-stairs life, laundry, cooking
- If narration discusses WORKERS: Show workshops, farms, mills, markets, working-class cottages
- If narration discusses COMMON PEOPLE: Show villages, taverns, countryside homes, market squares
- If narration discusses ROYALTY/NOBILITY: Show palaces, grand halls, elegant interiors
- Do NOT default to aristocracy - match the ACTUAL SUBJECT of the narration
- The scene should show WHO the story is about, not just "pretty palace imagery"

RULES:
1. EVERY image must be BEAUTIFUL - warm colors, cozy composition, soft lighting
2. MATCH THE SUBJECT: Show the people and places the narration actually discusses
3. VARY your scenes: interiors → exteriors → landscapes → close-ups
4. VARY your shots: wide establishing → medium scenes → intimate details
5. Include ATMOSPHERIC DETAILS appropriate to the setting and time of day
6. Keep it SIMPLE: One clear scene, one moment, easy to visualize

VISUAL VARIETY (CRITICAL - AVOID REPETITION):
- NEVER generate 3+ consecutive images of "people sitting/standing in a room talking"
- Alternate between these scene types to maintain visual interest:
  * EXTERIOR LANDSCAPES: palaces, gardens, harbors, battlefields, countryside, city streets
  * INTERIOR GRANDEUR: throne rooms, ballrooms, cathedrals, libraries, grand halls
  * ATMOSPHERIC MOMENTS: candlelit scenes, storms, sunsets, moonlight, fog, rain
  * ACTION/DRAMA: horses galloping, ships sailing, processions, ceremonies, hunts
  * INTIMATE CLOSE-UPS: hands writing letters, objects on tables, details of clothing/jewelry
  * NATURE/SEASONS: winter snow, autumn leaves, spring gardens, summer fields
- If the narration is abstract (emotions, politics, relationships), show a VISUALLY STRIKING scene from the era rather than generic people talking
- Each image should feel like a distinct painting, not a variation of the previous one

VISUAL PACING (DOCUMENTARY FLOW):
- IMAGE 1-2: ALWAYS start with ESTABLISHING SHOTS - grand panoramic views WITHOUT people in focus
- Every 8-10 images: Include a SCENIC/ARCHITECTURAL shot for visual breathing room
- Vary shot types: WIDE (landscapes) → MEDIUM (groups) → CLOSE (details) → repeat
- Include atmospheric variety: different times of day, weather, lighting moods

ATMOSPHERIC QUALITY (MAKE EACH IMAGE A MASTERPIECE):
- Every image should evoke EMOTION and ATMOSPHERE, not just show "people in a room"
- Include LIGHTING and MOOD: "dramatic chiaroscuro", "soft golden hour", "moonlit", "candlelit intimacy", "stormy skies"
- Include SENSORY DETAILS: "velvet curtains", "marble floors reflecting light", "mist rising from gardens"
- Think like a master painter: What would Vermeer, Rembrandt, or Turner capture in this moment?

FALLBACK RULE (for abstract/unclear narration):
- If the narration is abstract, show a SIMPLE BEAUTIFUL scene related to the story's subject
- Ask: "Who is this story about?" and show THEIR world:
  * Story about servants? Show warm kitchen, servants' quarters, domestic work
  * Story about farmers? Show fields, barns, village life
  * Story about royalty? Show palace interiors, gardens
- For emotions/abstract concepts, show:
  * Peaceful landscapes at golden hour
  * Cozy interiors with soft natural light
  * Simple figure by a window, gazing thoughtfully
- ALWAYS keep scenes WARM, COZY, and SIMPLE - never dark or scary

PROMPT FORMAT (KEEP IT SIMPLE):
- MAX 30-50 WORDS per prompt - brevity is key
- Format: "[Setting], [subject], [lighting/mood]"
- Start with the LOCATION, then the SUBJECT, then the ATMOSPHERE
- NO narrative, NO actions sequences, NO "and then..."

GOOD EXAMPLES (notice how SHORT and SIMPLE they are):
- "Georgian kitchen at dawn, cook in cotton dress preparing breakfast, copper pans, soft morning light"
- "Village blacksmith at work, smith in leather apron at forge, warm workshop atmosphere"
- "English cottage interior, family gathered together, peaceful evening, soft lamplight"
- "Rolling farmland at sunset, stone walls, grazing sheep, thatched cottage, golden light"
- "Grand palace drawing room, afternoon light through tall windows, elegant figures in fine period dress"

Do NOT include any text, titles, or words in the image.

CRITICAL: You MUST return ONLY a valid JSON array. No explanations, no questions, no commentary.

IMAGE 1 RULE (MANDATORY): The FIRST image MUST be an establishing shot of WHERE this story takes place. Match the story's subject:
- Story about servants/common people: Show the town, village, or estate exterior
- Story about royalty: Show the palace or grand estate
- Story about workers: Show the town, factory district, or countryside
NO people as the main focus - just the setting that establishes the world of the story.

Output format:
[
  {"index": 1, "sceneDescription": "Grand panoramic view of [era-specific iconic location], [architectural details], [atmospheric lighting], [time of day] - ESTABLISHING SHOT, no people in focus"},
  {"index": 2, "sceneDescription": "..."},
  {"index": 3, "sceneDescription": "..."}
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

      // Build context for this batch
      const windowDescriptions = batchWindows.map((w, i) =>
        `IMAGE ${batchStart + i + 1} (${formatTimecodeForFilename(w.startSeconds)} to ${formatTimecodeForFilename(w.endSeconds)}):\nNarration being spoken: "${w.text}"`
      ).join('\n\n');

      // Calculate tokens needed for this batch (use model-specific limit)
      const batchTokens = Math.min(MAX_TOKENS, batchSize * 150 + 500);

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

SCRIPT CONTEXT (for understanding the era and setting):
${script.substring(0, 12000)}

TIME-CODED SEGMENTS (MATCH THESE - show what each segment describes):
${windowDescriptions}

PRIORITY: Illustrate THE ACTUAL STORY from the narration using visually authentic ${timePeriod.era} imagery. Each image should show the SPECIFIC MOMENT described in that time segment - the people, places, and events being discussed. Use era-appropriate clothing, architecture, and settings.
${batchStart === 0 ? `
CRITICAL FOR THIS BATCH: Images 1-2 MUST be ESTABLISHING SHOTS - grand panoramic views of palaces, cities, or landscapes that set the scene. NO close-ups of people in the first 2 images. Show the WORLD first before showing the people in it.` : ''}
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

          const batchWindowDescriptions = batchWindows.map((w, i) =>
            `IMAGE ${batchStart + i + 1}: "${w.text}"`
          ).join('\n');

          const response = await anthropic.messages.create({
            model: selectedModel,
            max_tokens: Math.min(MAX_TOKENS, batchSize * 150 + 500),
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
        const sceneDesc = scene?.sceneDescription || `Historical scene depicting: ${windows[i].text.substring(0, 200)}`;
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
        || `Historical scene depicting: ${window.text.substring(0, 200)}`;

      imagePrompts.push({
        index: i + 1,
        startTime: formatTimecodeForFilename(window.startSeconds),
        endTime: formatTimecodeForFilename(window.endSeconds),
        startSeconds: window.startSeconds,
        endSeconds: window.endSeconds,
        sceneDescription: sceneDesc,
        prompt: `${effectiveStylePrompt}. ${sceneDesc}`,
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
          prompt.prompt = `${effectiveStylePrompt}. ${result.sanitized}`;
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
Show THEIR world, THEIR perspective, THEIR daily life.
When royalty/palaces are mentioned, show how ${subjectFocus} experienced it (kitchens, stables, servants' quarters).
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
      max_tokens: Math.min(MAX_TOKENS, count * 150 + 500),
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
      const sceneDesc = scene?.sceneDescription || `Historical scene depicting: ${window.text.substring(0, 200)}`;

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
