import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface SrtSegment {
  index: number;
  startTime: string;
  endTime: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

interface ImagePromptRequest {
  script: string;
  srtContent: string;
  imageCount: number;
  stylePrompt: string;
  modernKeywordFilter?: boolean; // Filter anachronistic keywords (default true)
  audioDuration?: number; // Optional audio duration in seconds
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

// Modern/anachronistic keywords to filter from scene descriptions
// These words suggest modern settings (museums, research, etc.) rather than historical scenes
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
    // Case-insensitive replacement, preserve surrounding text
    const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
    filtered = filtered.replace(regex, '');
  }

  // Clean up any double spaces or awkward punctuation left behind
  filtered = filtered
    .replace(/\s+/g, ' ')           // Multiple spaces to single
    .replace(/\s+,/g, ',')          // Space before comma
    .replace(/,\s*,/g, ',')         // Double commas
    .replace(/\.\s*\./g, '.')       // Double periods
    .replace(/\s+\./g, '.')         // Space before period
    .replace(/^\s+|\s+$/g, '')      // Trim
    .replace(/^,\s*/, '')           // Leading comma
    .replace(/,\s*$/, '');          // Trailing comma

  return filtered;
}

// Regenerate a single prompt that contains modern keywords
async function regeneratePrompt(
  apiKey: string,
  originalDescription: string,
  foundKeywords: string[],
  narrationText: string
): Promise<string> {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 500,
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
      }),
    });

    if (!response.ok) {
      console.error('Regeneration API error:', response.status);
      return originalDescription;
    }

    const data = await response.json();
    const text = data.content?.[0]?.text;
    if (text) {
      // Clean up any quotes that might wrap the response
      return text.trim().replace(/^["']|["']$/g, '');
    }
    return originalDescription;
  } catch (error) {
    console.error('Failed to regenerate prompt:', error);
    return originalDescription;
  }
}

// Parse SRT timestamp to seconds
function parseSrtTime(timeStr: string): number {
  // Format: HH:MM:SS,mmm
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

  // Use provided audio duration if available, otherwise fall back to last SRT segment end time
  const totalDuration = audioDuration || segments[segments.length - 1].endSeconds;
  const windowDuration = totalDuration / imageCount;

  console.log(`Distributing ${imageCount} images across ${totalDuration.toFixed(2)}s (audio duration: ${audioDuration?.toFixed(2) || 'N/A'}s, SRT end: ${segments[segments.length - 1].endSeconds.toFixed(2)}s)`);

  const windows: { startSeconds: number; endSeconds: number; text: string }[] = [];

  for (let i = 0; i < imageCount; i++) {
    const windowStart = i * windowDuration;
    const windowEnd = (i + 1) * windowDuration;

    // Collect text from segments that overlap with this window
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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { script, srtContent, imageCount, stylePrompt, modernKeywordFilter, audioDuration }: ImagePromptRequest = await req.json();
    // Default to true for backward compatibility (filter enabled by default)
    const shouldFilterKeywords = modernKeywordFilter !== false;

    if (!script || !srtContent) {
      return new Response(
        JSON.stringify({ error: 'Script and SRT content are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
    if (!ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'Anthropic API key not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Generating ${imageCount} image prompts from script and SRT...`);
    if (audioDuration) {
      console.log(`Using provided audio duration: ${audioDuration.toFixed(2)}s`);
    }

    // Parse SRT and group into time windows
    const segments = parseSrt(srtContent);
    const windows = groupSegmentsForImages(segments, imageCount, audioDuration);

    console.log(`Parsed ${segments.length} SRT segments into ${windows.length} time windows`);

    // Build context for Claude - include full narration text for each window
    const windowDescriptions = windows.map((w, i) =>
      `IMAGE ${i + 1} (${formatTimecodeForFilename(w.startSeconds)} to ${formatTimecodeForFilename(w.endSeconds)}):\nNarration being spoken: "${w.text}"`
    ).join('\n\n');

    // Call Claude to generate visual scene descriptions
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 8192,
        system: `You are an expert at creating visual scene descriptions for documentary video image generation. You MUST always output valid JSON - never ask questions or request clarification.

CRITICAL RULE - IMMERSIVE HISTORICAL SCENES ONLY:
You are generating prompts for an AI image generator. The resulting images must look like PAINTINGS from the historical period itself, as if an artist was present at the time witnessing events firsthand.

ABSOLUTELY FORBIDDEN (these will cause the prompt to be rejected and regenerated):
- Museums, exhibits, galleries, display cases, artifacts on display
- Scientists, researchers, historians, archaeologists, scholars studying anything
- Magnifying glasses, microscopes, laboratory equipment, scientific instruments
- Maps, documents, scrolls, books being studied or displayed
- Modern photography, documentary framing, "looking back at history" perspective
- Any contemporary/academic environments or research settings
- Anyone examining, studying, analyzing, or inspecting historical items

REQUIRED: Every scene must show events AS THEY HAPPENED in the historical moment - people LIVING history, not studying it.

YOUR TASK: Create visual scene descriptions based on the script and narration segments provided.

CONTENT SAFETY:
- NO nudity, partial nudity, or sexually suggestive content
- NO gore, blood, graphic violence, or injury depictions
- NO disturbing, shocking, or traumatic imagery
- You may depict dramatic historical scenes including warfare and conflict - avoid explicit gore

RULES:
1. READ the script context to identify the EXACT historical time period and location
2. For each image segment, create a scene that illustrates the narration content
3. ALL scenes MUST be set IN the historical period - show events as they happened
4. For war/conflict topics: show battlefields, armies, fortifications, commanders leading troops, military camps - NOT maps, museums, or artifacts
5. For medical topics: show period-appropriate healers, apothecaries, patients - NOT modern research
6. For abstract concepts: show period-appropriate scenes with settings and people from that era
7. Include specific details: setting, lighting, objects, people, actions, atmosphere
8. 50-100 words per description
9. Do NOT include any text, titles, or words in the image

CRITICAL: You MUST return ONLY a valid JSON array. No explanations, no questions, no commentary.

Output format:
[
  {"index": 1, "sceneDescription": "..."},
  {"index": 2, "sceneDescription": "..."}
]`,
        messages: [
          {
            role: 'user',
            content: `Generate exactly ${imageCount} visual scene descriptions. Return ONLY the JSON array, nothing else.

MASTER STYLE PROMPT (defines the visual art style):
${stylePrompt || 'Classical oil painting style'}

SCRIPT CONTEXT (read this to determine the historical era):
${script.substring(0, 12000)}

TIME-CODED SEGMENTS:
${windowDescriptions}

Remember:
1. Identify the historical era from the SCRIPT CONTEXT above
2. Every scene MUST be set in that exact era - not medieval unless the script is about medieval times
3. Output ONLY a JSON array with ${imageCount} items. No explanations.`
          }
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Claude API error:', response.status, errorText);
      throw new Error(`Claude API error: ${response.status}`);
    }

    const data = await response.json();
    const responseText = data.content[0]?.text || '';

    // Parse the JSON response
    let sceneDescriptions: { index: number; sceneDescription: string }[];
    try {
      // Extract JSON from response (in case there's any surrounding text)
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error('No JSON array found in response');
      }
      sceneDescriptions = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      console.error('Failed to parse Claude response:', responseText);
      throw new Error('Failed to parse image descriptions from AI');
    }

    // Build final prompts with style and timing info
    // Check for modern keywords and regenerate if found
    let regeneratedCount = 0;
    const imagePrompts: ImagePrompt[] = [];

    for (let i = 0; i < windows.length; i++) {
      const window = windows[i];
      const scene = sceneDescriptions.find(s => s.index === i + 1);
      let sceneDesc = scene?.sceneDescription || `Historical scene depicting: ${window.text.substring(0, 200)}`;

      // Check for modern keywords (only if filter is enabled)
      if (shouldFilterKeywords) {
        const foundKeywords = containsModernKeywords(sceneDesc);

        if (foundKeywords.length > 0) {
        console.log(`Image ${i + 1}: Found modern keywords [${foundKeywords.join(', ')}], regenerating...`);
        regeneratedCount++;

        // Regenerate this specific prompt
        const regeneratedDesc = await regeneratePrompt(
          ANTHROPIC_API_KEY,
          sceneDesc,
          foundKeywords,
          window.text
        );

        // Check if regeneration still has keywords
        const remainingKeywords = containsModernKeywords(regeneratedDesc);
        if (remainingKeywords.length === 0) {
          // Regeneration succeeded - use it
          sceneDesc = regeneratedDesc;
        } else {
          // Regeneration still has keywords - try one more time with stronger prompt
          console.log(`Image ${i + 1}: Regeneration still has keywords [${remainingKeywords.join(', ')}], trying again...`);
          const secondAttempt = await regeneratePrompt(
            ANTHROPIC_API_KEY,
            regeneratedDesc,
            remainingKeywords,
            window.text
          );

          const finalKeywords = containsModernKeywords(secondAttempt);
          if (finalKeywords.length === 0) {
            sceneDesc = secondAttempt;
          } else {
            // Still has keywords after 2 attempts - use regenerated version anyway
            // (better than original, don't apply filter which breaks grammar)
            console.log(`Image ${i + 1}: Warning - still has keywords after 2 regeneration attempts, using best attempt`);
            sceneDesc = secondAttempt;
          }
        }
        }
      }

      imagePrompts.push({
        index: i + 1,
        startTime: formatTimecodeForFilename(window.startSeconds),
        endTime: formatTimecodeForFilename(window.endSeconds),
        startSeconds: window.startSeconds,
        endSeconds: window.endSeconds,
        sceneDescription: sceneDesc,
        prompt: `${stylePrompt}. ${sceneDesc}`,
      });
    }

    console.log(`Generated ${imagePrompts.length} image prompts successfully (regenerated ${regeneratedCount} prompts with modern keywords)`);

    return new Response(
      JSON.stringify({
        success: true,
        prompts: imagePrompts,
        totalDuration: segments.length > 0 ? segments[segments.length - 1].endSeconds : 0,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error generating image prompts:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to generate image prompts' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
