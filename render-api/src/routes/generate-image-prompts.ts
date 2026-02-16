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
function groupSegmentsForImages(segments: SrtSegment[], imageCount: number, audioDuration?: number): { startSeconds: number; endSeconds: number; text: string }[] {
  if (segments.length === 0) return [];

  const totalDuration = audioDuration || segments[segments.length - 1].endSeconds;
  const windowDuration = totalDuration / imageCount;

  console.log(`Distributing ${imageCount} images across ${totalDuration.toFixed(2)}s`);

  const windows: { startSeconds: number; endSeconds: number; text: string }[] = [];

  for (let i = 0; i < imageCount; i++) {
    const windowStart = i * windowDuration;
    const windowEnd = (i + 1) * windowDuration;

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
  const { script, srtContent, imageCount, stylePrompt, masterStylePrompt, modernKeywordFilter, audioDuration, stream, projectId } = req.body;
  // Accept both stylePrompt (from frontend) and masterStylePrompt (from pipeline) for compatibility
  const effectiveStylePrompt = stylePrompt || masterStylePrompt || '';
  // Default to true for backward compatibility (filter enabled by default)
  const shouldFilterKeywords = modernKeywordFilter !== false;

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
    const windows = groupSegmentsForImages(segments, imageCount, audioDuration);

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
    const systemPrompt = `You are a MASTER CINEMATOGRAPHER creating stunning, museum-quality visual scenes for a premium documentary. Every image must be BREATHTAKING - the kind that makes viewers pause in awe. You MUST always output valid JSON.

=== TIME PERIOD ===
ERA: ${timePeriod.era}
REGION: ${timePeriod.region}

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

The scene should be INSPIRED BY the narration - capture its MOOD and EMOTION through visuals rather than literal depiction.

EXAMPLE - Ptolemaic Egypt (Cleopatra's era, 69-30 BCE):
- GOOD: "Ptolemaic Alexandria harbor, merchant ships with square sails, Greek and Egyptian traders, limestone lighthouse, Mediterranean sea, golden sunset"
- GOOD: "Royal palace courtyard in Alexandria, marble columns, palm trees, servants carrying amphoras, Egyptian guards in bronze armor"
- BAD: A boat scene that looks medieval European instead of Ptolemaic Egyptian

CONTENT SAFETY (CRITICAL - MUST BE FAMILY-FRIENDLY):
- NO nudity, partial nudity, bare skin, or sexually suggestive content
- ALL people must be FULLY CLOTHED in period-appropriate, modest attire
- NO revealing, tight, or suggestive clothing - use conservative, loose-fitting historical garments
- NO bathing, swimming, or changing scenes
- NO gore, blood, graphic violence, or injury depictions
- NO disturbing, shocking, or traumatic imagery
- You may depict dramatic historical scenes including warfare and conflict - avoid explicit gore
- ALWAYS describe clothing explicitly: "wearing a full-length linen robe", "dressed in formal Greek chiton", "clothed in Egyptian royal garments"

RULES:
1. EVERY image must be VISUALLY STUNNING - gorgeous colors, elegant composition, cinematic lighting
2. SHOWCASE the era's beauty: magnificent architecture, sumptuous costumes, lush landscapes
3. VARY your scenes: palaces → gardens → ballrooms → countryside → intimate chambers → grand exteriors
4. VARY your shots: wide establishing → medium group scenes → intimate close-ups → dramatic angles
5. Include RICH DETAILS: silk fabrics, candlelight reflections, morning mist, golden hour light
6. For abstract narration (emotions, politics): show a BEAUTIFUL relevant scene, not generic people talking

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
- If the narration discusses emotions, politics, or abstract concepts that are hard to visualize, DO NOT default to "people talking in a room"
- Instead, show a VISUALLY STRIKING scene relevant to the era and topic:
  * For love stories: gardens, moonlit balconies, intimate candlelit chambers
  * For political intrigue: shadowy corridors, throne rooms, secret meetings
  * For tragedy: stormy skies over palaces, lonely figures at windows, autumn landscapes
  * For triumph: grand processions, sunlit celebrations, crowds cheering

PROMPT FORMAT:
7. Keep descriptions 50-70 words - rich enough for stunning visuals
8. Start with SETTING and ATMOSPHERE (e.g., "Magnificent Georgian palace at golden hour", "Moonlit English garden")
9. Include CINEMATIC elements: dramatic lighting, rich colors, elegant details
10. Describe COSTUMES in detail: silk gowns, embroidered waistcoats, powdered wigs, jewels
11. EXAMPLE PROMPTS for Georgian England (Queen Charlotte era):
   - "Magnificent Buckingham House exterior at golden sunset, Georgian architecture gleaming, manicured gardens with fountains, horse-drawn carriages arriving, aristocrats in silk finery, warm amber light"
   - "Lavish palace ballroom, crystal chandeliers casting warm glow, couples in exquisite silk gowns and embroidered coats dancing minuet, mirrors reflecting candlelight, musicians in powdered wigs"
   - "Intimate royal bedchamber at dawn, soft morning light through silk curtains, four-poster bed with velvet drapes, elegant writing desk, personal letters, quiet contemplation"
   - "Grand English countryside estate, rolling green hills, sheep grazing, manor house in distance, aristocratic hunting party on horseback, autumn colors, misty morning"
12. Do NOT include any text, titles, or words in the image

CRITICAL: You MUST return ONLY a valid JSON array. No explanations, no questions, no commentary.

IMAGE 1 RULE (MANDATORY): The FIRST image (index 1) MUST ALWAYS be a grand establishing shot of the VIDEO SUBJECT'S primary location - their palace, their city, their court, their kingdom. For royalty: show THEIR palace exterior. For empires: show THEIR capital city. For explorers: show the starting point of THEIR journey. NO people as the main focus - just the magnificent setting that establishes WHERE this story takes place.

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

TIME-CODED SEGMENTS (use as INSPIRATION, but prioritize ERA ACCURACY):
${windowDescriptions}

PRIORITY: Create images that are VISUALLY AUTHENTIC to ${timePeriod.era} in ${timePeriod.region}. The image doesn't need to literally match the narration - it should show scenes, architecture, clothing, and activities that ACTUALLY EXISTED during that era.
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

    const sceneDescriptions: { index: number; sceneDescription: string }[] = [];
    const failedBatches: number[] = [];

    for (let i = 0; i < batchSettled.length; i++) {
      const result = batchSettled[i];
      if (result.status === 'fulfilled') {
        sceneDescriptions.push(...result.value);
      } else {
        failedBatches.push(i + 1);
        console.error(`Batch ${i + 1}/${numBatches} failed after ${RETRY_MAX_ATTEMPTS} retries: ${result.reason}`);
      }
    }

    // Warn frontend about failed batches (non-fatal — we continue with partial results)
    if (failedBatches.length > 0) {
      const failedImageRanges = failedBatches.map(b => {
        const start = (b - 1) * BATCH_SIZE_PARALLEL + 1;
        const end = Math.min(b * BATCH_SIZE_PARALLEL, imageCount);
        return `${start}-${end}`;
      });
      console.warn(`[generate-image-prompts] ${failedBatches.length} batch(es) failed: images ${failedImageRanges.join(', ')}`);
      sendEvent({
        type: 'warning',
        message: `${failedBatches.length} batch(es) failed after retries. Images ${failedImageRanges.join(', ')} will use fallback descriptions.`,
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

export default router;
