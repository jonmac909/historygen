// DEPRECATED — 2026-04-17.
// The frontend no longer invokes this function. Image-prompt generation is
// served by render-api at POST /generate-image-prompts, which routes through
// the Claude Code CLI bridge so requests bill against the user's Claude.ai
// subscription instead of api.anthropic.com (see plan humming-munching-platypus.md).
//
// This file still calls api.anthropic.com directly. Do NOT re-wire any
// caller to this edge function. When convenient, run:
//   supabase functions delete generate-image-prompts --project-ref udqfdeoullsxttqguupz
// to remove the deployed version.

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
  topic?: string; // User-specified era/topic to anchor images (e.g., "Regency England 1810s")
  subjectFocus?: string; // Who the story focuses on (e.g., "Jane Austen")
  clipCount?: number; // Number of images that will become video clips (default 12)
  clipDuration?: number; // Duration of each video clip in seconds (default 5)
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
// First N images are video clips with fixed duration, remaining are static images
function groupSegmentsForImages(
  segments: SrtSegment[],
  imageCount: number,
  audioDuration?: number,
  clipCount: number = 12,
  clipDuration: number = 5
): { startSeconds: number; endSeconds: number; text: string }[] {
  if (segments.length === 0) return [];

  // Use provided audio duration if available, otherwise fall back to last SRT segment end time
  const totalDuration = audioDuration || segments[segments.length - 1].endSeconds;

  // Calculate timing: first N images are clips (5s each), rest are static images
  const actualClipCount = Math.min(clipCount, imageCount);
  const clipsTotalDuration = actualClipCount * clipDuration; // e.g., 12 * 5 = 60 seconds
  const staticImageCount = imageCount - actualClipCount;
  const remainingDuration = totalDuration - clipsTotalDuration;
  const staticImageDuration = staticImageCount > 0 ? remainingDuration / staticImageCount : 0;

  console.log(`Distributing ${imageCount} images across ${totalDuration.toFixed(2)}s`);
  console.log(`  - First ${actualClipCount} images: video clips @ ${clipDuration}s each = ${clipsTotalDuration}s`);
  console.log(`  - Remaining ${staticImageCount} images: static @ ${staticImageDuration.toFixed(2)}s each = ${remainingDuration.toFixed(2)}s`);

  const windows: { startSeconds: number; endSeconds: number; text: string }[] = [];

  for (let i = 0; i < imageCount; i++) {
    let windowStart: number;
    let windowEnd: number;

    if (i < actualClipCount) {
      // This is a video clip - fixed 5 second duration
      windowStart = i * clipDuration;
      windowEnd = (i + 1) * clipDuration;
    } else {
      // This is a static image - distributed across remaining duration
      const staticIndex = i - actualClipCount;
      windowStart = clipsTotalDuration + (staticIndex * staticImageDuration);
      windowEnd = clipsTotalDuration + ((staticIndex + 1) * staticImageDuration);
    }

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
    const { script, srtContent, imageCount, stylePrompt, modernKeywordFilter, audioDuration, topic, subjectFocus, clipCount, clipDuration }: ImagePromptRequest = await req.json();
    // Default to true for backward compatibility (filter enabled by default)
    const shouldFilterKeywords = modernKeywordFilter !== false;
    // Topic is used to anchor images to a specific historical era
    const eraTopic = topic || '';
    // Subject focus is who the story is about (used to intelligently include them in relevant scenes)
    const subject = subjectFocus || '';
    // Clip settings - default to 12 clips at 5 seconds each
    const effectiveClipCount = clipCount ?? 12;
    const effectiveClipDuration = clipDuration ?? 5;

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
    // First N images are video clips (5s each), remaining are static images
    const segments = parseSrt(srtContent);
    const windows = groupSegmentsForImages(segments, imageCount, audioDuration, effectiveClipCount, effectiveClipDuration);

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

REQUIRED: Every scene must be set IN the historical moment itself - NOT modern people studying history. Show the era as it was, whether that's landscapes, interiors, or people going about their lives.
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

IMPORTANT: Generate scenes INSPIRED BY THE TOPIC more than the literal narration.
For example, if the topic is "Regency Debutante Season", focus on TYPICAL DEBUTANTE SCENES:
- Grand balls with dancing (being asked to dance, waltzing couples, dance cards)
- Morning calls in elegant drawing rooms
- Promenading in Hyde Park
- Tea parties and card games
- Grand Georgian townhouses and country estates
- Ladies being presented at court
- Intimate parlor conversations about suitors
- Garden parties and picnics

The narration provides MOOD and TIMING, but the TOPIC provides the VISUAL CONTENT.
Do NOT try to literally visualize abstract script passages - show BEAUTIFUL SCENES from the topic's world instead.
` : ''}
${subject ? `
=== SUBJECT FOCUS (INFORMATIONAL) ===
This story is about: ${subject}

This tells you the THEME/WORLD of the story - use it for visual inspiration:
- If "${subject}" is a named person → they should appear in 40-50% of character shots
- If "${subject}" is a group (e.g., "Regency debutantes") → show typical activities of that group
- If "${subject}" is a setting (e.g., "Regency ballrooms") → show scenes FROM that world

This is GUIDANCE, not a rule. The story being "about ballrooms" doesn't mean every shot is a ballroom.
Use your judgment to create visual variety while staying thematically connected.
` : ''}
YOUR TASK: Create visual scene descriptions inspired by the topic and mood of the narration.

CONTENT SAFETY (STRICTLY ENFORCED - VIOLATIONS WILL BE REJECTED):

BANNED WORDS - NEVER USE THESE IN ANY PROMPT:
Violence/Gore/Death:
blood, bloody, bleeding, bloodstained, blood-soaked, bloodletting, crimson blood, dark blood, basin of blood, drawing blood, purge, humours
corpse, dead body, lifeless, motionless, dying, death, dies, deceased
wound, wounded, injury, injured, scar, scarred, disfigured
gore, gory, viscera, organs, flesh, entrails, innards
suffering, agony, pain, torment, torture, execution
collapsed, unconscious, barely breathing, chest barely rises

Illness/Medical:
pale, pallid, gaunt, wasted, skeletal, emaciated, sickly, clammy
sweat, sweating, feverish, fever, coughing, vomiting
stained, soaked, drenched (with bodily fluids)
autopsy, dissection, surgery, operation, scalpel, anatomical, lancet, leeches

Nudity/Romance:
nude, naked, nudity, bare skin, unclothed, undressed, topless, revealing
kissing, kiss, embracing, romantic embrace, passionate, sensual, seductive

FOR DARK TOPICS (illness, death, tragedy):
IF IT MAKES SENSE, show a living person who fits the context:
- A mourning wife, mother, or family member
- A doctor or physician attending
- A servant or maid in the room
- A friend or companion keeping vigil
- The person BEFORE they became ill (in happier times)

The figure should be realistic for the story - someone who would actually be there.

EXAMPLES OF CORRECT ALTERNATIVES:
❌ "Woman lies motionless, blood-soaked handkerchief beside her"
✅ "Maid standing by the bedside, holding a tray of tea, soft afternoon light through curtains"

❌ "Patient's wasted frame, skin stretched over bones"
✅ "Doctor in frock coat speaking gently to the patient's wife in the hallway"

❌ "Dying soldier on battlefield, wounds visible"
✅ "Nurse tending to soldiers in field hospital, lantern light, concerned expression"

=== SHOT TYPE SYSTEM ===

STEP 1 - ANALYZE THE SCRIPT:
Before generating any prompts, read the FULL script and identify:
- MAIN CHARACTER(S): Who is this story about? (e.g., "Jane Austen", "Queen Victoria and Prince Albert")
- If characters are GROUP-BASED (e.g., "Regency debutantes", "Victorian servants"), the "main character" scenes should show typical activities of that group (dancing couples, servants working, etc.)
- SETTING: Where and when? (e.g., "Hampshire countryside, Regency England")
- KEY LOCATIONS: Places mentioned (estates, ballrooms, London streets, etc.)

STEP 2 - SHOT DISTRIBUTION (STRICTLY ENFORCED):

CRITICAL: 80-90% OF ALL IMAGES MUST HAVE PEOPLE AS THE SUBJECT.
Only 10-20% can be pure landscape/building shots without people.

For a 12-image set:
- Image 1: ESTABLISHING (landscape or building) - this is the ONLY guaranteed no-people shot
- Image 2 or 3: MUST show the main character/focus - no more than 2 establishing shots before introducing people
- Images 2-12: 80-90% people shots. Maximum 1-2 additional establishing shots allowed.

CONCRETE EXAMPLE for 12 images:
- 1 establishing (required first image)
- 5-6 main character shots (protagonist doing things)
- 4-5 lifestyle shots (crowds, servants, secondary characters)
- 0-1 additional establishing shot (OPTIONAL, only if narratively needed)

DO NOT generate multiple consecutive landscape/building shots.
DO NOT exceed 2 establishing shots total for 12 images.
The main character/focus MUST appear by image 3 at the latest.

STEP 3 - SHOT TYPES:

| SHOT TYPE | SUBJECT | DISTRIBUTION |
|-----------|---------|--------------|
| ESTABLISHING_LANDSCAPE | LOCATION is subject | Part of 10-20% establishing |
| ESTABLISHING_BUILDING | BUILDING is subject | Part of 10-20% establishing |
| MAIN_CHARACTER_FOCUS | PERSON is subject (1) | Part of 40-50% main character |
| MAIN_CHARACTERS_PLURAL | PEOPLE are subject (2+) | Part of 40-50% main character |
| MULTI_CHARACTER_SECONDARY | CROWD/GROUP is subject | Part of 30-40% lifestyle |
| SECONDARY_CHARACTERS | SUPPORTING CAST is subject | Part of 30-40% lifestyle |

ESTABLISHING SHOTS - WHAT MAKES THEM "ESTABLISHING":
The LOCATION must be the subject, NOT the people. Background/contextual people are FINE:
- GOOD: "Carriage pulling up to grand estate, footmen waiting at entrance" (estate is subject)
- GOOD: "Busy London street, distant figures, Georgian townhouses" (street is subject)
- GOOD: "Sweeping hills with shepherd and flock in distance" (landscape is subject)
- BAD: "Jane Austen walking up to estate" (person is subject - this is MAIN_CHARACTER_FOCUS)

SHOT TYPE EXAMPLES:
- ESTABLISHING_LANDSCAPE: "Rolling Hampshire hills at dawn, morning mist in valleys, distant village church spire"
- ESTABLISHING_BUILDING: "Grand Georgian manor exterior, carriage arriving on gravel drive, servants at entrance"
- MAIN_CHARACTER_FOCUS: "Jane Austen seated at small writing desk, quill in hand, candlelight illuminating her focused expression"
- MAIN_CHARACTERS_PLURAL: "Queen Victoria and Prince Albert walking arm-in-arm through palace gardens"
- MULTI_CHARACTER_SECONDARY: "Crowded Regency ballroom, couples waltzing, chandeliers glittering, musicians in gallery"
- SECONDARY_CHARACTERS: "Household servants preparing breakfast in manor kitchen, copper pots on range"

GROUP-BASED SUBJECTS (when no specific named character):
If the subject is a GROUP (e.g., "Regency debutantes", "Victorian factory workers", "Medieval peasants"):
- MAIN CHARACTER shots should show TYPICAL ACTIVITIES of that group
- Example: For "Regency debutantes" → show dancing couples, ladies at tea, promenading in parks
- Example: For "Victorian servants" → show maids cleaning, footmen serving, cooks in kitchen
- These count toward the 40-50% main character quota

RULES:
1. IMAGE 1 = ALWAYS establishing (landscape or building) - LOCATION must be the subject
2. 40-50% of images must feature the main subject/character(s) as the focus
3. Only 10-20% should be establishing shots (location as subject)
4. Use FULL CHARACTER NAMES when including specific named characters
5. ESTABLISHING vs CHARACTER distinction: What is the SUBJECT of the shot?
   - ESTABLISHING: "Estate at sunset, carriage arriving" (estate is subject, carriage is background)
   - CHARACTER: "Jane Austen stepping out of carriage" (person is subject)
6. 50-100 words per description
7. NO text, titles, or words in the image
8. Vary shot types - don't use same type for 3+ consecutive images

CRITICAL: You MUST return ONLY a valid JSON array. No explanations, no questions, no commentary.

Output format (include shotType for each):
[
  {"index": 1, "shotType": "ESTABLISHING_LANDSCAPE", "sceneDescription": "..."},
  {"index": 2, "shotType": "MAIN_CHARACTER_FOCUS", "sceneDescription": "..."}
]

Valid shotType values: ESTABLISHING_LANDSCAPE, ESTABLISHING_BUILDING, MAIN_CHARACTER_FOCUS, MAIN_CHARACTERS_PLURAL, MULTI_CHARACTER_SECONDARY, SECONDARY_CHARACTERS`,
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
        prompt: `${eraTopic ? eraTopic + '. ' : ''}${stylePrompt}. ${sceneDesc}`,
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
