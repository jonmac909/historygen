import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient, formatSystemPrompt } from '../lib/anthropic-client';
import { saveCost } from '../lib/cost-tracker';

const router = Router();

// Constants
// 12 clips × 5s = 60 seconds intro (image-first I2V approach)
const CLIP_COUNT = 12;  // 12 clips for 60 second intro
const CLIP_DURATION = 5;  // 5 seconds per clip (v1-pro-fast I2V supports 5/10s)
const TOTAL_CLIP_DURATION = CLIP_COUNT * CLIP_DURATION;  // 60 seconds

interface ClipPrompt {
  index: number;
  startSeconds: number;
  endSeconds: number;
  prompt: string;
  sceneDescription: string;
}

interface SrtSegment {
  index: number;
  startTime: string;
  endTime: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
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
// Reused from generate-image-prompts.ts
const MODERN_KEYWORDS_TO_REMOVE = [
  'museum', 'exhibit', 'exhibition', 'display case', 'display cases', 'gallery', 'galleries',
  'artifact', 'artifacts', 'archaeological', 'archaeology', 'excavation', 'excavated',
  'preserved', 'preservation', 'restoration', 'restored', 'replica', 'replicas', 'reconstruction',
  'curator', 'curators', 'visitor', 'visitors', 'tourist', 'tourists',
  'specimen', 'specimens', 'diorama', 'collection', 'collections',
  'researcher', 'researchers', 'scientist', 'scientists', 'historian', 'historians',
  'scholar', 'scholars', 'academic', 'academics', 'professor', 'professors',
  'laboratory', 'lab coat', 'lab coats', 'research facility', 'research facilities',
  'university', 'institution', 'facility', 'clinical', 'sterile',
  'study', 'studies', 'analysis', 'analyzed', 'examination', 'examined',
  'documentation', 'documented', 'records show', 'evidence suggests',
  'research', 'microscope', 'microscopes', 'magnifying glass', 'magnifying glasses',
  'geologist', 'geologists', 'geological', 'geology',
  'archaeologist', 'archaeologists',
  'anthropologist', 'anthropologists',
  'expert', 'experts', 'specialist', 'specialists',
  'team of', 'survey team', 'field team', 'research team',
  'taking notes', 'field notes', 'notebook', 'notebooks',
  'equipment', 'instruments', 'tools', 'measuring',
  'scientific', 'science',
  'map', 'maps', 'parchment map', 'antique map', 'historical map', 'topographical',
  'scroll', 'scrolls', 'document', 'documents', 'manuscript', 'manuscripts',
  'chart', 'charts', 'diagram', 'diagrams', 'blueprint', 'blueprints',
  'studying', 'examining', 'inspecting', 'analyzing', 'reviewing',
  'close-up of', 'detailed view of', 'closeup of',
  'placard', 'placards', 'label', 'labels', 'caption', 'captions',
  'modern', 'contemporary', 'present-day', 'present day', 'today', "today's",
  'photograph', 'photography', 'camera', 'cameras', 'digital', 'computer', 'computers',
  'electric', 'electricity', 'neon', 'fluorescent', 'led', 'spotlight', 'spotlights',
  'glass case', 'glass cases', 'plexiglass', 'acrylic',
  'tablet', 'screen', 'monitor', 'display',
  'field clothes', 'field gear', 'protective gear', 'sun hats',
  'vehicles', 'field vehicles',
  'documentary', 'educational', 'illustration', 'infographic',
  'recreation', 'reenactment', 're-enactment', 'dramatization',
  'depicting', 'representation', 'interpretation', 'imagined', 'imagining',
  "artist's", 'artistic rendering',
  'interactive', 'interactive displays',
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
        content: `TASK: Completely rewrite this VIDEO SCENE description to show the ACTUAL HISTORICAL EVENT, not a modern interpretation.

PROBLEMATIC ORIGINAL (contains modern framing):
"${originalDescription}"

DETECTED MODERN TERMS: ${foundKeywords.join(', ')}

WHAT THE NARRATION SAYS:
"${narrationText}"

REQUIREMENTS FOR VIDEO SCENE:
1. Show the scene AS IF YOU WERE THERE in ancient/historical times
2. NO modern people (no scientists, researchers, geologists, historians)
3. NO modern settings (no museums, labs, classrooms, excavation sites)
4. Show PEOPLE FROM THAT ERA doing things they would actually do
5. Include MOTION descriptions (what moves, how things animate)
6. Include camera movement suggestions (dolly, pan, tracking shot)
7. 50-100 words maximum

Write ONLY the description, no quotes or explanation.`
      }]
    });

    const content = response.content[0];
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    if (content.type === 'text') {
      return {
        text: content.text.trim().replace(/^["']|["']$/g, ''),
        inputTokens,
        outputTokens,
      };
    }
    return { text: originalDescription, inputTokens, outputTokens };
  } catch (error) {
    console.error('Failed to regenerate clip prompt:', error);
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

// Get SRT segments for the first 100 seconds (intro clip duration)
function getIntroSegments(segments: SrtSegment[]): SrtSegment[] {
  return segments.filter(seg => seg.startSeconds < TOTAL_CLIP_DURATION);
}

// Group intro segments into 10-second clip windows
function groupSegmentsForClips(segments: SrtSegment[]): { startSeconds: number; endSeconds: number; text: string }[] {
  const windows: { startSeconds: number; endSeconds: number; text: string }[] = [];

  for (let i = 0; i < CLIP_COUNT; i++) {
    const windowStart = i * CLIP_DURATION;
    const windowEnd = (i + 1) * CLIP_DURATION;

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
  const { script, srtContent, stylePrompt, stream, projectId } = req.body;

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

    console.log(`🎬 Generating ${CLIP_COUNT} video clip prompts for ${TOTAL_CLIP_DURATION}s intro...`);

    // Parse SRT and get intro segments (first 100 seconds)
    const allSegments = parseSrt(srtContent);
    const introSegments = getIntroSegments(allSegments);
    const windows = groupSegmentsForClips(introSegments);

    console.log(`Parsed ${allSegments.length} SRT segments, using ${introSegments.length} for intro clips`);

    // Send initial progress
    sendEvent({ type: 'progress', progress: 3, message: 'Analyzing time period...' });

    // Initialize Anthropic client
    const anthropic = createAnthropicClient(anthropicApiKey);

    // Track token usage for cost tracking
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // PHASE 0: Extract time period from script to ensure accurate imagery
    const timePeriodResult = await extractTimePeriod(anthropic, script);
    const timePeriod = timePeriodResult.context;
    totalInputTokens += timePeriodResult.inputTokens;
    totalOutputTokens += timePeriodResult.outputTokens;

    // Build anachronism list for this specific era
    const eraAnachronisms = timePeriod.anachronisms.length > 0
      ? `\n\nANACHRONISMS TO AVOID FOR ${timePeriod.era.toUpperCase()}:\n- ${timePeriod.anachronisms.join('\n- ')}`
      : '';

    // Get the intro portion of the script (approximately first 100 seconds worth)
    // Assuming ~150 words per minute = ~250 words for 100 seconds
    const introScriptWords = script.split(/\s+/).slice(0, 300).join(' ');

    // Build narration context for each clip
    const clipDescriptions = windows.map((w, i) =>
      `CLIP ${i + 1} (${w.startSeconds}s - ${w.endSeconds}s):\nNarration: "${w.text}"`
    ).join('\n\n');

    sendEvent({ type: 'progress', progress: 10, message: 'Generating video prompts...' });

    // System prompt optimized for video clip generation - SHORT prompts to avoid multiple shots
    const systemPrompt = `You create SHORT video scene descriptions for AI video generation. Each prompt must describe ONE SINGLE SHOT - not multiple shots or scenes.

=== TIME PERIOD ===
ERA: ${timePeriod.era}
REGION: ${timePeriod.region}${eraAnachronisms}

CRITICAL - READ CAREFULLY:

1. ONE SHOT PER PROMPT (20-30 words MAX)
   - Describe ONE camera angle, ONE moment, ONE action
   - DO NOT list multiple things happening
   - DO NOT describe a sequence of events
   - SHORTER IS BETTER - the AI will add detail

2. CLIP 1 = ESTABLISHING SHOT, NO PEOPLE
   - Exterior of the location (palace, castle, city)
   - NO PEOPLE. Zero people. Empty scene.
   - Example: "Ultra realistic exterior Versailles palace golden hour, French Baroque architecture, manicured gardens, slow dolly forward"

3. FORMAT (20-30 words):
   - Start with "Ultra realistic"
   - ONE subject/focus
   - ONE camera movement
   - ONE lighting condition

GOOD EXAMPLES (notice how short):
- "Ultra realistic exterior Windsor Castle dawn, morning mist, stone towers, slow pan right"
- "Ultra realistic king in throne room, candlelit, velvet robes, slow dolly in"
- "Ultra realistic courtyard fountain, nobles walking, afternoon sun, tracking shot"

BAD EXAMPLES (too long, multiple shots):
- "Ultra realistic palace exterior at dawn with mist rising, then cut to interior throne room where the king sits, servants attending" ❌ (multiple scenes)
- "Ultra realistic battle scene showing cavalry charging across field while archers fire arrows and infantry clashes" ❌ (too many actions)

FORBIDDEN:
- Multiple shots/scenes in one prompt
- Sequences of events
- Museums, exhibits, modern settings
- People in clip 1
- Nudity, partial nudity, revealing clothing
- Violence, gore, blood, weapons being used
- Anything sexual or suggestive
- Disturbing or shocking imagery

CONTENT SAFETY (MANDATORY):
- All people must be FULLY CLOTHED in modest period attire
- No battles, fights, or violent confrontations
- Family-friendly content only

Output JSON array ONLY:
[{"index": 1, "sceneDescription": "Ultra realistic..."}, ...]`;

    const systemConfig = [
      {
        type: 'text' as const,
        text: systemPrompt,
        cache_control: { type: 'ephemeral' as const }
      }
    ];

    let fullResponse = '';

    const messageStream = await anthropic.messages.stream({
      model: selectedModel,
      max_tokens: 8192,
      system: formatSystemPrompt(systemConfig) as Anthropic.MessageCreateParams['system'],
      messages: [
        {
          role: 'user',
          content: `Generate ${CLIP_COUNT} SHORT video prompts (20-30 words each). Each prompt = ONE SINGLE SHOT. No cut scenes, no sequences.

ERA: ${timePeriod.era}, ${timePeriod.region}
STYLE: ${stylePrompt || 'Historically accurate'}

SCRIPT CONTEXT:
${introScriptWords}

NARRATION TIMING:
${clipDescriptions}

RULES:
- CLIP 1: Exterior establishing shot, NO PEOPLE (zero people, empty scene)
- 20-30 words per prompt MAX
- ONE shot, ONE camera angle, ONE action per prompt
- Focus on the SCENE CONTENT (people, objects, setting, lighting)
- Include ONE camera movement (dolly, pan, tracking)
- Do NOT include style instructions (style is added separately)

Output JSON array ONLY, no explanations.`
        }
      ],
    });

    // Process stream
    for await (const event of messageStream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullResponse += event.delta.text;

        // Track progress based on completed descriptions
        const completedCount = (fullResponse.match(/\"sceneDescription\"\s*:\s*\"[^\"]+\"/g) || []).length;
        const progress = Math.min(70, 15 + Math.round((completedCount / CLIP_COUNT) * 55));
        sendEvent({ type: 'progress', progress, message: `Generated ${completedCount}/${CLIP_COUNT} video prompts...` });
      }
    }

    // Get token usage from stream
    const finalMessage = await messageStream.finalMessage();
    if (finalMessage?.usage) {
      totalInputTokens += finalMessage.usage.input_tokens || 0;
      totalOutputTokens += finalMessage.usage.output_tokens || 0;
    }

    // Parse JSON response
    const jsonMatch = fullResponse.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('No JSON array found in response');
    }
    const sceneDescriptions = JSON.parse(jsonMatch[0]) as { index: number; sceneDescription: string }[];

    console.log(`Generated ${sceneDescriptions.length} clip descriptions`);

    // Check for modern keywords and regenerate if needed
    sendEvent({ type: 'progress', progress: 75, message: 'Checking for modern keywords...' });

    interface RegenTask {
      index: number;
      sceneDesc: string;
      foundKeywords: string[];
      narrationText: string;
    }
    const regenTasks: RegenTask[] = [];

    for (let i = 0; i < windows.length; i++) {
      const scene = sceneDescriptions.find(s => s.index === i + 1);
      const sceneDesc = scene?.sceneDescription || `Historical scene: ${windows[i].text.substring(0, 200)}`;
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

    const regeneratedDescriptions = new Map<number, string>();

    if (regenTasks.length > 0) {
      console.log(`Found ${regenTasks.length} clip prompts with modern keywords, regenerating...`);
      sendEvent({ type: 'progress', progress: 80, message: `Regenerating ${regenTasks.length} prompts...` });

      // Regenerate in parallel (clips are fewer, so we can do all at once)
      const regenResults = await Promise.all(
        regenTasks.map(async (task) => {
          console.log(`Clip ${task.index + 1}: Found modern keywords [${task.foundKeywords.join(', ')}], regenerating...`);
          const regenResult = await regeneratePrompt(anthropic, task.sceneDesc, task.foundKeywords, task.narrationText);
          return { index: task.index, description: regenResult.text, inputTokens: regenResult.inputTokens, outputTokens: regenResult.outputTokens };
        })
      );

      for (const result of regenResults) {
        regeneratedDescriptions.set(result.index, result.description);
        totalInputTokens += result.inputTokens;
        totalOutputTokens += result.outputTokens;
      }
    }

    // Build final clip prompts
    const clipPrompts: ClipPrompt[] = [];

    for (let i = 0; i < CLIP_COUNT; i++) {
      const window = windows[i];
      const scene = sceneDescriptions.find(s => s.index === i + 1);

      const sceneDesc = regeneratedDescriptions.get(i)
        || scene?.sceneDescription
        || `Historical scene: ${window.text.substring(0, 200)}`;

      clipPrompts.push({
        index: i + 1,
        startSeconds: window.startSeconds,
        endSeconds: window.endSeconds,
        sceneDescription: sceneDesc,
        prompt: sceneDesc,  // Video prompts use only scene description (stylePrompt is for images)
      });
    }

    console.log(`✅ Generated ${clipPrompts.length} video clip prompts (regenerated ${regenTasks.length} with modern keywords)`);
    console.log(`Total tokens: ${totalInputTokens} input, ${totalOutputTokens} output`);

    // Save costs to Supabase if projectId provided
    if (projectId) {
      try {
        await Promise.all([
          saveCost({
            projectId,
            source: 'manual',
            step: 'clip_prompts',
            service: 'claude',
            units: totalInputTokens,
            unitType: 'input_tokens',
          }),
          saveCost({
            projectId,
            source: 'manual',
            step: 'clip_prompts',
            service: 'claude',
            units: totalOutputTokens,
            unitType: 'output_tokens',
          }),
        ]);
      } catch (costError) {
        console.error('[generate-clip-prompts] Error saving costs:', costError);
      }
    }

    const result = {
      success: true,
      prompts: clipPrompts,
      totalDuration: TOTAL_CLIP_DURATION,
      clipCount: CLIP_COUNT,
      clipDuration: CLIP_DURATION,
    };

    if (stream) {
      sendEvent({ type: 'progress', progress: 100, message: 'Complete!' });
      sendEvent({ type: 'complete', ...result });
      cleanup();
      res.end();
    } else {
      return res.json(result);
    }

  } catch (error) {
    console.error('Error generating clip prompts:', error);

    if (stream) {
      sendEvent({
        type: 'error',
        error: error instanceof Error ? error.message : 'Failed to generate clip prompts'
      });
      cleanup();
      res.end();
    } else {
      return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate clip prompts' });
    }
  }
});

export default router;
