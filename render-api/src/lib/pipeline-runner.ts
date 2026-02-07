/**
 * Pipeline Runner - Server-side orchestrator for full video generation pipeline
 *
 * Runs the complete pipeline for cloning a video:
 * 1. Fetch transcript from source video
 * 2. Generate script from transcript
 * 3. Generate audio (voice cloning)
 * 4. Generate captions
 * 5. Generate clip prompts (5 × 12s video intro)
 * 6. Generate video clips (Seedance 1.5 Pro)
 * 7. Generate image prompts (for remaining duration)
 * 8. Generate images
 * 9. Analyze + generate thumbnail
 * 10. Render video (clips + images)
 * 11. Upload to YouTube (title rewriting done in modal)
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createAnthropicClient } from './anthropic-client';
import { fetch, ProxyAgent } from 'undici';
import { randomUUID } from 'crypto';
import { internalApiKey } from './runtime-config';

// Proxy for YouTube requests (same as youtube-scraper)
const PROXY_URL = process.env.YTDLP_PROXY_URL || '';
function getProxyAgent() {
  if (!PROXY_URL) return undefined;
  return new ProxyAgent(PROXY_URL);
}

// Base URL for internal API calls - always use localhost to avoid SSL issues
const API_BASE_URL = `http://localhost:${process.env.PORT || 10000}`;
const internalAuthHeader: Record<string, string> = internalApiKey
  ? { 'X-Internal-Api-Key': internalApiKey }
  : {};

export interface PipelineInput {
  sourceVideoId: string;
  sourceVideoUrl: string;
  originalTitle: string;
  originalThumbnailUrl: string;
  channelName?: string;
  publishAt?: string;  // ISO timestamp for scheduled publish (5 PM PST)
  sourceDurationSeconds?: number;  // Original video duration for matching script length
  targetWordCount?: number;  // Override calculated word count (default: duration * 150 wpm)
  // Resume from a specific step (skips earlier steps if data provided)
  resumeFrom?: 'transcript' | 'script' | 'audio' | 'captions' | 'imagePrompts' | 'images' | 'clipPrompts' | 'videoClips' | 'thumbnail' | 'render' | 'upload';
  existingProjectId?: string;  // Use existing project instead of creating new one
  existingData?: {  // Pre-existing data to skip regeneration
    script?: string;
    audioUrl?: string;
    audioDuration?: number;
    audioSegments?: any[];
    srtContent?: string;
    srtUrl?: string;
    imagePrompts?: any[];
    imageUrls?: string[];
    clipPrompts?: any[];
    clips?: any[];
    thumbnailUrl?: string;
  };
}

export interface PipelineResult {
  success: boolean;
  projectId: string;
  clonedTitle?: string;
  youtubeVideoId?: string;
  youtubeUrl?: string;
  error?: string;
  steps: PipelineStepResult[];
}

interface PipelineStepResult {
  step: string;
  success: boolean;
  duration: number;
  error?: string;
  data?: any;
}

type ProgressCallback = (step: string, progress: number, message: string) => void;

function getSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  return createClient(url, key);
}

// Save/update project in generation_projects table (for Projects drawer)
async function saveProjectToDatabase(
  supabase: SupabaseClient,
  projectId: string,
  data: {
    videoTitle?: string;
    sourceUrl?: string;
    status?: 'in_progress' | 'completed' | 'archived';
    currentStep?: string;
    script?: string;
    audioUrl?: string;
    audioDuration?: number;
    audioSegments?: any[];
    srtContent?: string;
    srtUrl?: string;
    imagePrompts?: any[];
    imageUrls?: string[];
    videoUrl?: string;
    smokeEmbersVideoUrl?: string;
    clipPrompts?: any[];
    clips?: any[];
    thumbnails?: string[];
    youtubeTitle?: string;
    youtubeDescription?: string;
  }
): Promise<void> {
  const now = new Date().toISOString();

  // Check if project exists
  const { data: existing } = await supabase
    .from('generation_projects')
    .select('id')
    .eq('id', projectId)
    .single();

  const row: Record<string, unknown> = {
    id: projectId,
    updated_at: now,
  };

  // Only set fields that are provided
  if (data.videoTitle !== undefined) row.video_title = data.videoTitle;
  if (data.sourceUrl !== undefined) row.source_url = data.sourceUrl;
  if (data.status !== undefined) row.status = data.status;
  if (data.currentStep !== undefined) row.current_step = data.currentStep;
  if (data.script !== undefined) row.script_content = data.script;
  if (data.audioUrl !== undefined) row.audio_url = data.audioUrl;
  if (data.audioDuration !== undefined) row.audio_duration = data.audioDuration;
  if (data.audioSegments !== undefined) row.audio_segments = data.audioSegments;
  if (data.srtContent !== undefined) row.srt_content = data.srtContent;
  if (data.srtUrl !== undefined) row.srt_url = data.srtUrl;
  if (data.imagePrompts !== undefined) row.image_prompts = data.imagePrompts;
  if (data.imageUrls !== undefined) row.image_urls = data.imageUrls;
  if (data.videoUrl !== undefined) row.video_url = data.videoUrl;
  if (data.smokeEmbersVideoUrl !== undefined) row.smoke_embers_video_url = data.smokeEmbersVideoUrl;
  if (data.clipPrompts !== undefined) row.clip_prompts = data.clipPrompts;
  if (data.clips !== undefined) row.clips = data.clips;
  if (data.thumbnails !== undefined) row.thumbnails = data.thumbnails;
  if (data.youtubeTitle !== undefined) row.youtube_title = data.youtubeTitle;
  if (data.youtubeDescription !== undefined) row.youtube_description = data.youtubeDescription;

  // For new projects, set required defaults
  if (!existing) {
    row.created_at = now;
    row.source_type = 'youtube';
    row.version_number = 1;
    if (!row.source_url) row.source_url = '';
    if (!row.status) row.status = 'in_progress';
    if (!row.current_step) row.current_step = 'script';
  }

  const { error } = await supabase
    .from('generation_projects')
    .upsert(row, { onConflict: 'id' });

  if (error) {
    console.error(`[Pipeline] Failed to save project to database: ${error.message}`);
  } else {
    console.log(`[Pipeline] Saved project ${projectId} to generation_projects (step: ${data.currentStep || 'init'})`);
  }
}

// Clean script of markdown headers, section markers, and formatting that breaks TTS
function cleanScript(script: string): string {
  const cleaned = script
    // Remove entire lines starting with # (markdown headers)
    .replace(/^#.*$/gm, '')
    // Remove standalone ALL CAPS lines (section headers like OPENING, CONCLUSION)
    .replace(/^[A-Z][A-Z\s]{2,}$/gm, '')
    // Remove markdown horizontal rules
    .replace(/^[-*_]{3,}$/gm, '')
    // Remove bracketed content like [SCENE X], [PAUSE], etc.
    .replace(/\[.*?\]/g, '')
    // Remove markdown bold/italic markers
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    // Remove parenthetical time markers like (5-10 minutes)
    .replace(/\(\d+-?\d*\s*(?:minutes?|seconds?|mins?|secs?)\)/gi, '')
    // Remove inline hashtags
    .replace(/#\w+/g, '')
    // Collapse multiple newlines to single
    .replace(/\n{3,}/g, '\n\n')
    // Trim whitespace
    .trim();

  // Log if significant cleaning happened
  const removed = script.length - cleaned.length;
  if (removed > 50) {
    console.log(`[Pipeline] Cleaned script: removed ${removed} chars of formatting`);
  }

  return cleaned;
}

// Grade a script using Claude to check topic adherence and quality
async function gradeScript(
  script: string,
  expectedTopic: string,
  apiKey: string
): Promise<{ grade: 'A' | 'B' | 'C'; feedback: string }> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = createAnthropicClient(apiKey);

  // Sample beginning, middle, and end of script for comprehensive review
  const totalLen = script.length;
  const sampleSize = 2000;
  const beginning = script.substring(0, sampleSize);
  const middle = script.substring(Math.floor(totalLen / 2) - sampleSize / 2, Math.floor(totalLen / 2) + sampleSize / 2);
  const ending = script.substring(Math.max(0, totalLen - sampleSize));

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `Grade this script for a history documentary video.

CRITICAL: The title promises "${expectedTopic}". The script MUST deliver on this specific promise.

If the title mentions a specific concept (like "Planet-Sized Prison", "Lost Technology", "Hidden Truth"), that concept MUST be the central focus throughout the script, not just mentioned briefly.

== BEGINNING OF SCRIPT ==
${beginning}

== MIDDLE OF SCRIPT ==
${middle}

== END OF SCRIPT ==
${ending}

GRADING CRITERIA:
- A = Script FULLY delivers on the title's promise. The specific concept/angle promised is the central focus throughout.
- B = Script is on the general topic but doesn't fully deliver on the title's SPECIFIC promise. The promised angle is weak or underdeveloped.
- C = Script is off-topic, has formatting issues, or completely fails to address the title's promise.

IMPORTANT: A script about "Sumerian tablets" is NOT Grade A if the title promises "Planet-Sized Prison" but the prison concept is barely mentioned. The SPECIFIC promise matters.

Respond in JSON format: {"grade": "A/B/C", "feedback": "explanation of how well it delivers on the title's promise"}`,
    }],
  });

  try {
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return { grade: result.grade || 'C', feedback: result.feedback || 'Unknown' };
    }
  } catch (e) {
    console.warn('[Pipeline] Failed to parse grade response:', e);
  }

  return { grade: 'C', feedback: 'Failed to grade script' };
}

// Download image URL and convert to base64
// Uses proxy for YouTube URLs (ytimg.com) to avoid IP blocking
async function downloadImageAsBase64(imageUrl: string): Promise<string> {
  const isYouTubeUrl = imageUrl.includes('ytimg.com') || imageUrl.includes('youtube.com');
  const agent = isYouTubeUrl ? getProxyAgent() : undefined;

  if (isYouTubeUrl && agent) {
    console.log(`[Pipeline] Downloading YouTube image via proxy: ${imageUrl.substring(0, 60)}...`);
  }

  const response = await fetch(imageUrl, agent ? { dispatcher: agent } : undefined);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString('base64');
}

// Helper to call internal API routes
async function callInternalAPI(
  endpoint: string,
  body: any,
  timeoutMs: number = 300000  // 5 min default
): Promise<any> {
  const url = `${API_BASE_URL}${endpoint}`;
  console.log(`[Pipeline] Calling ${endpoint}...`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...internalAuthHeader },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error ${response.status}: ${errorText}`);
    }

    return await response.json();
  } catch (error: any) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw new Error(`Timeout calling ${endpoint}`);
    }
    throw error;
  }
}

// Helper for SSE streaming endpoints with real-time progress
async function callStreamingAPI(
  endpoint: string,
  body: any,
  onProgress?: (data: any) => void,
  timeoutMs: number = 600000  // 10 min default
): Promise<any> {
  const url = `${API_BASE_URL}${endpoint}`;
  console.log(`[Pipeline] Calling streaming ${endpoint}...`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...internalAuthHeader },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      clearTimeout(timeout);
      const errorText = await response.text();
      throw new Error(`API error ${response.status}: ${errorText}`);
    }

    // Stream SSE events in real-time for progress updates
    let result: any = null;
    let buffer = '';

    const responseBody = response.body;
    if (responseBody && 'getReader' in responseBody) {
      const reader = responseBody.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (onProgress) onProgress(data);
              if (data.type === 'complete') {
                result = data;
              } else if (data.type === 'error') {
                throw new Error(data.error || 'Stream error');
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      }

      if (buffer.startsWith('data: ')) {
        try {
          const data = JSON.parse(buffer.slice(6));
          if (onProgress) onProgress(data);
          if (data.type === 'complete') {
            result = data;
          }
        } catch (e) {
          // Ignore
        }
      }
    } else {
      const text = await response.text();
      const lines = text.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (onProgress) onProgress(data);
            if (data.type === 'complete') {
              result = data;
            } else if (data.type === 'error') {
              throw new Error(data.error || 'Stream error');
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    }

    clearTimeout(timeout);

    if (!result) {
      console.error(`[Pipeline] No complete event received from ${endpoint}`);
      throw new Error(`No complete event received from ${endpoint}`);
    }
    return result;
  } catch (error: any) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw new Error(`Timeout calling ${endpoint}`);
    }
    throw error;
  }
}

// Default voice sample URL
const DEFAULT_VOICE_SAMPLE = 'https://autoaigen.com/voices/clone_voice.wav';

// Auto Poster Template: Complete Histories (template-a)
const COMPLETE_HISTORIES_TEMPLATE = `THESE ARE INSTRUCTIONS FOR YOU - DO NOT INCLUDE ANY OF THIS MARKDOWN FORMATTING IN YOUR OUTPUT!

Your output must be ONLY plain text prose with zero formatting. No #, no **, no section headers, no brackets.

PROJECT INSTRUCTIONS: Complete Histories Sleep-Friendly Video Scripts

PROJECT OVERVIEW:
You are writing 2-3 hour video scripts for "Complete Histories," a YouTube channel that creates long-form historical documentaries designed as sleep-friendly content. These scripts help viewers drift peacefully through history with dreamy, time-travelly narratives.

## CORE VOICE & STYLE (NEVER COMPROMISE THESE)

### Tone
- **Dreamy and time-travelly**: Create a sense of floating through history
- **Meditative, not dramatic**: Avoid urgency, tension spikes, or cliffhangers
- **Contemplative and reflective**: Weave in philosophical observations naturally
- **Reverent without being stiff**: Show wonder and respect for the subject
- **Emotionally restrained**: Handle even tragedy with dignity, not melodrama

### Point of View
- **Primary**: Third person omniscient narrator
- **Secondary**: Second person ("you") for immersion 2-3 times per section
  - "You could walk from the harbor and see..."
  - "Stand in the marketplace and you would hear..."
  - Use this to invite viewers into the scene without forcing participation

### Sentence Structure
- **Flowing, connected sentences**: Ideas link like water moving downstream
- **Varied rhythm**: Mix longer flowing sentences with shorter grounding statements
- **Natural cadence**: Read aloud-friendly, like a bedtime story for adults
- **Example**: "The walls rose stone by stone. Each block was cut to fit its neighbor with a care that made the joint tighter than any mortar could. When rain came, the water ran down the face and found no crack to enter."

### What to AVOID
- Cliffhangers or "But what happens next?!" moments
- Dramatic music cues in writing ("suddenly!", "shockingly!")
- Forced excitement or urgency
- Modern slang or anachronistic language
- Judgment or heavy-handed moralizing
- Questions that demand alert engagement
- Lists with bullet points (use flowing prose instead)
- Excessive bolding, caps, or emphasis

## SENSORY IMMERSION REQUIREMENTS

### Include Every 2-3 Minutes
You must ground viewers with sensory details:

**Smell**: "The air carried salt and cedar and the smoke of evening fires"
**Sound**: "The only sound was the scrape of oars and the low call of a bird that fishes at dusk"
**Touch/Texture**: "The stone was warm underfoot even when the sun had set"
**Temperature**: "The cold spring ran so cold it numbed the hand"
**Taste**: "Bread made from barley on poor days, from wheat when the harvest was strong"
**Light/Color**: "The bronze took the sunset and gave it back in warm bands"

### Sensory Detail Rules
- Be specific, not generic ("cedar smoke" not "smoke")
- Anchor to human experience ("warm enough to ease tired limbs")
- Use comparisons that ground rather than elevate ("like rain on a roof")
- Integrate naturally into narrative flow, never list

STRUCTURAL TEMPLATE (THESE ARE CONTENT GUIDELINES - DO NOT WRITE "OPENING" OR "ACT 1" IN YOUR OUTPUT!):

WARNING: The labels below (OPENING, ACT 1, ACT 2, etc.) are for YOUR reference only.
DO NOT include these labels, numbers, or any brackets/formatting in your actual script.
Write everything as continuous flowing prose narration.

1. OPENING (5-10 minutes) - Begin with:
Good evening and welcome back. Tonight we're [exploring/journeying through/diving into] [TOPIC].

Then include 2-3 contemplative questions woven naturally into the prose:
- What was [this civilization/place/era]?
- Why has [this story] captured imaginations for [X] years?
- How did [key characteristic] shape their world?

Brief preview in flowing language:
We'll explore where [the story] began, what [sources/evidence] tell us, and how [it evolved/fell/transformed] over [time period].

As always, I'd love to know—where in the world are you listening from and what time is it for you? Whether you're here to drift into sleep or to follow the currents of history, I'm glad you're with me.

Now, let's begin.

Opening Tone: 4/10 energy—welcoming but already calm

2. THE BEGINNING (20-30 minutes)
Purpose: Establish the mythic/legendary foundation and earliest origins
IMPORTANT: Do not write "ACT 1" or "THE BEGINNING" as a header - just start the narration

3. THE RISE (30-45 minutes)
Purpose: Show gradual growth and development of civilization
IMPORTANT: Do not write "ACT 2" or "THE RISE" as a header - just continue the narration

4. THE GOLDEN AGE (30-45 minutes)
Purpose: Show peak achievement and prosperity
IMPORTANT: No headers - just continue narrating

5. THE TURNING (20-30 minutes)
Purpose: Show seeds of decline through accumulation of small changes
IMPORTANT: No headers - just continue narrating

6. THE CRISIS (30-40 minutes)
Purpose: The breaking point—war, disaster, or collapse
IMPORTANT: No headers - just continue narrating

7. THE AFTERMATH (20-30 minutes)
Purpose: Survival and immediate legacy
IMPORTANT: No headers - just continue narrating

8. THE LEGACY (30-45 minutes)
Purpose: Historical memory, evidence, and meaning
IMPORTANT: No headers - just continue narrating

9. CLOSING (5 minutes) - End with:
So the tale of [civilization] [how it ends—comes to us, remains in memory, completes its arc].

Include a final sensory image or scene (keep it peaceful), what remains, a final philosophical reflection, optional gentle thanks, and the softest possible end.

Energy Level: 2/10—softest point of entire script

## ESSENTIAL TECHNIQUES

### Repetitive Anchoring
Create hypnotic rhythm with 5-8 anchor phrases repeated throughout.

### Philosophical Breathers
Every 5-10 minutes, pause for 1-3 sentences of reflection.

### Human Scale Zooming
After large-scale events, zoom to individual experience.

### Time Transitions
Smooth: "In the years that followed...", "Generations later...", "The seasons turned and turned again..."`;

// Auto Poster Image Style: Dutch Golden Age (image-a)
const DUTCH_GOLDEN_AGE_STYLE = `Warm classical oil-painting style, inspired by Dutch Golden Age.. Soft, intimate chiaroscuro with lifted shadows and glowing midtones, avoiding harsh contrast. Rich, earthy palette of warm reds, ochres, umbers, and deep teal-blues. Painterly brushwork with visible texture and gentle edges. Quiet, reverent, contemplative mood. Old-world, timeless atmosphere with a sense of stillness, intimacy, and human warmth. Romantic historical painting sensibility with softened realism. Gentle, peaceful tone — not scary, not violent. no violence, no fear, no horror, no threatening mood, no nudity, no sexualized content, no flat illustration, no gouache or watercolor, no cartoon style, no Pixar or fantasy concept art, no modern cinematic lighting, no ultra-sharp realism, no high saturation`;

// Intro video clips configuration
const INTRO_CLIP_COUNT = 12;  // 12 video clips at start
const INTRO_CLIP_DURATION = 5;  // 5 seconds each
const INTRO_TOTAL_DURATION = INTRO_CLIP_COUNT * INTRO_CLIP_DURATION;  // 60 seconds total

// Step ordering for resume logic
const STEP_ORDER = ['transcript', 'script', 'audio', 'captions', 'imagePrompts', 'images', 'clipPrompts', 'videoClips', 'thumbnail', 'render', 'upload'];

function shouldSkipStep(currentStep: string, resumeFrom?: string): boolean {
  if (!resumeFrom) return false;
  const currentIndex = STEP_ORDER.indexOf(currentStep);
  const resumeIndex = STEP_ORDER.indexOf(resumeFrom);
  return currentIndex < resumeIndex;
}

/**
 * Run the full video generation pipeline
 */
export async function runPipeline(
  input: PipelineInput,
  onProgress?: ProgressCallback
): Promise<PipelineResult> {
  // Use existing project ID or create new one
  const projectId = input.existingProjectId || randomUUID();
  const steps: PipelineStepResult[] = [];
  const supabase = getSupabaseClient();
  const resumeFrom = input.resumeFrom;
  const existing = input.existingData || {};

  const reportProgress = (step: string, progress: number, message: string) => {
    console.log(`[Pipeline] ${step}: ${message} (${progress}%)`);
    if (onProgress) onProgress(step, progress, message);
  };

  try {
    if (resumeFrom) {
      reportProgress('init', 0, `Resuming pipeline from ${resumeFrom}...`);
      console.log(`[Pipeline] Resume mode: skipping steps before ${resumeFrom}`);
    } else {
      reportProgress('init', 0, 'Starting pipeline...');
    }

    // Create/update project in database at start
    await saveProjectToDatabase(supabase, projectId, {
      videoTitle: input.originalTitle,
      sourceUrl: input.sourceVideoUrl,
      status: 'in_progress',
      currentStep: resumeFrom || 'script',
    });

    // Step 1: Fetch transcript (skip if resuming past this step)
    let transcript: string = '';
    if (shouldSkipStep('transcript', resumeFrom)) {
      console.log(`[Pipeline] Skipping transcript fetch (resuming from ${resumeFrom})`);
      steps.push({ step: 'transcript', success: true, duration: 0, data: { skipped: true } });
    } else {
      reportProgress('transcript', 5, 'Fetching source transcript...');
      const transcriptStart = Date.now();
      try {
        const transcriptRes = await callInternalAPI('/get-youtube-transcript', {
          url: input.sourceVideoUrl,  // Route expects 'url', not 'videoId'
        });
        transcript = transcriptRes.transcript;
        steps.push({
          step: 'transcript',
          success: true,
          duration: Date.now() - transcriptStart,
          data: { length: transcript.length },
        });
      } catch (error: any) {
        steps.push({ step: 'transcript', success: false, duration: Date.now() - transcriptStart, error: error.message });
        throw new Error(`Failed to fetch transcript: ${error.message}`);
      }
    }

    // Use original title (title rewriting happens in YouTube upload modal)
    const clonedTitle = input.originalTitle;

    // Step 2: Generate script (skip if resuming past this step or existing script provided)
    let script: string = existing.script || '';
    let calculatedImageCount: number = 10;  // Will be recalculated based on actual word count

    if (shouldSkipStep('script', resumeFrom) && existing.script) {
      console.log(`[Pipeline] Using existing script (${existing.script.length} chars)`);
      const actualWordCount = existing.script.split(/\s+/).length;
      calculatedImageCount = Math.min(300, Math.max(10, Math.round(actualWordCount / 100)));
      console.log(`[Pipeline] Image count: ${calculatedImageCount} (${actualWordCount} words / 100)`);
      steps.push({ step: 'script', success: true, duration: 0, data: { skipped: true, wordCount: actualWordCount } });
    } else {
      reportProgress('script', 15, 'Generating script...');
      const scriptStart = Date.now();

      // Calculate target word count based on source video duration (or use manual override)
      // 150 words/minute is typical documentary narration pace
      const WORDS_PER_MINUTE = 150;
      const durationMinutes = input.sourceDurationSeconds ? Math.round(input.sourceDurationSeconds / 60) : 20;
      const calculatedWordCount = durationMinutes * WORDS_PER_MINUTE;
      const targetWordCount = input.targetWordCount || calculatedWordCount;
      console.log(`[Pipeline] Target word count: ${targetWordCount}${input.targetWordCount ? ' (manual override)' : ` (${durationMinutes} min @ ${WORDS_PER_MINUTE} wpm)`}`);

      const MAX_SCRIPT_RETRIES = 3;  // Give 3 chances to generate on-topic script
      let scriptAttempt = 0;
      let scriptGrade: 'A' | 'B' | 'C' = 'C';
      let scriptFeedback = '';

      try {
        while (scriptAttempt < MAX_SCRIPT_RETRIES && scriptGrade !== 'A') {
          scriptAttempt++;
          const attemptLabel = scriptAttempt > 1 ? ` (attempt ${scriptAttempt})` : '';
          reportProgress('script', 15, `Generating script${attemptLabel}...`);

          // Add feedback to template if regenerating
          let templateWithFeedback = COMPLETE_HISTORIES_TEMPLATE;
          if (scriptAttempt > 1 && scriptFeedback) {
            templateWithFeedback = `CRITICAL: Previous script was rejected. Fix these issues:
${scriptFeedback}

The topic is: "${input.originalTitle}"
Stay focused on this specific topic. Do not go off on tangents about documentary filmmaking or unrelated subjects.

${COMPLETE_HISTORIES_TEMPLATE}`;
            console.log(`[Pipeline] Regenerating script with feedback: ${scriptFeedback}`);
          }

          const scriptRes = await callStreamingAPI('/rewrite-script', {
            transcript,
            projectId,
            title: input.originalTitle,  // CRITICAL: Pass title for topic enforcement
            topic: input.originalTitle,  // CRITICAL: Pass topic for topic enforcement
            voiceStyle: '(sincere) (soft tone)',
            wordCount: targetWordCount,
            template: templateWithFeedback,
            stream: true,
          }, (data) => {
            if (data.type === 'progress') {
              reportProgress('script', 15 + Math.round(data.progress * 0.1), `Generating script${attemptLabel}... ${data.progress}%`);
            }
          }, 1800000);

          script = scriptRes.script;

          // Clean the script of markdown headers and formatting
          script = cleanScript(script);
          console.log(`[Pipeline] Script cleaned, length: ${script.length} chars`);

          // Grade the script for topic adherence
          const anthropicKey = process.env.ANTHROPIC_API_KEY;
          if (anthropicKey) {
            reportProgress('script', 24, 'Grading script...');
            const gradeResult = await gradeScript(script, input.originalTitle, anthropicKey);
            scriptGrade = gradeResult.grade;
            scriptFeedback = gradeResult.feedback;
            console.log(`[Pipeline] Script grade: ${scriptGrade} - ${scriptFeedback}`);

            if (scriptGrade !== 'A' && scriptAttempt < MAX_SCRIPT_RETRIES) {
              console.log(`[Pipeline] Script grade ${scriptGrade}, will regenerate...`);
            }
          } else {
            // No API key for grading, assume OK
            scriptGrade = 'A';
            console.log(`[Pipeline] Skipping script grading (no ANTHROPIC_API_KEY)`);
          }
        }

        // Fail if script is still off-topic after all retries
        if (scriptGrade === 'C') {
          throw new Error(`Script failed quality check after ${scriptAttempt} attempts. Feedback: ${scriptFeedback}`);
        }

        const actualWordCount = script.split(/\s+/).length;
        steps.push({
          step: 'script',
          success: true,
          duration: Date.now() - scriptStart,
          data: { wordCount: actualWordCount, grade: scriptGrade, attempts: scriptAttempt },
        });

        // Calculate image count: 1 image per 100 words (min 10, max 300)
        calculatedImageCount = Math.min(300, Math.max(10, Math.round(actualWordCount / 100)));
        console.log(`[Pipeline] Image count: ${calculatedImageCount} (${actualWordCount} words / 100)`);

      // Save script to project
      await saveProjectToDatabase(supabase, projectId, {
        script,
        currentStep: 'audio',
      });
    } catch (error: any) {
      steps.push({ step: 'script', success: false, duration: Date.now() - scriptStart, error: error.message });
      throw new Error(`Failed to generate script: ${error.message}`);
    }
    }  // End of else block for script generation

    // Step 4: Generate audio (skip if resuming past this step or existing audio provided)
    let audioUrl: string = existing.audioUrl || '';
    let audioDuration: number = existing.audioDuration || 0;

    if (shouldSkipStep('audio', resumeFrom) && existing.audioUrl) {
      console.log(`[Pipeline] Using existing audio: ${existing.audioUrl}`);
      steps.push({ step: 'audio', success: true, duration: 0, data: { skipped: true, audioUrl: existing.audioUrl } });
    } else {
      reportProgress('audio', 25, 'Generating audio...');
      const audioStart = Date.now();

      // Debug: Log script info before audio generation
      console.log(`[Pipeline] Script length: ${script?.length || 0} chars, type: ${typeof script}`);
      console.log(`[Pipeline] Script first 500 chars: "${script?.substring(0, 500)}..."`);
      console.log(`[Pipeline] Script last 200 chars: "...${script?.slice(-200)}"`);
      if (!script || script.trim().length < 100) {
        console.error(`[Pipeline] ERROR: Script is empty or too short! Length: ${script?.length || 0}`);
      }

      try {
        const audioRes = await callStreamingAPI('/generate-audio', {
          script,
          projectId,
          voiceSampleUrl: DEFAULT_VOICE_SAMPLE,
          voiceStyle: '(sincere) (soft tone)',
          ttsSettings: {
            // Match UI defaults - these worked before
            temperature: 0.9,
            topP: 0.85,
            repetitionPenalty: 1.1,
          },
          stream: true,
        }, (data) => {
          if (data.type === 'progress') {
            reportProgress('audio', 25 + Math.round(data.progress * 0.15), `Generating audio... ${data.progress}%`);
          }
        }, 1200000);  // 20 min timeout
        audioUrl = audioRes.audioUrl;
        audioDuration = audioRes.totalDuration;
        steps.push({
          step: 'audio',
          success: true,
          duration: Date.now() - audioStart,
          data: { audioUrl, audioDuration },
        });

        // Save audio to project
        await saveProjectToDatabase(supabase, projectId, {
          audioUrl,
          audioDuration,
          audioSegments: audioRes.segments,
          currentStep: 'captions',
        });
      } catch (error: any) {
        steps.push({ step: 'audio', success: false, duration: Date.now() - audioStart, error: error.message });
        throw new Error(`Failed to generate audio: ${error.message}`);
      }
    }

    // Step 5: Generate captions (skip if resuming past this step or existing SRT provided)
    let captionsUrl: string = existing.srtUrl || '';
    let srtContent: string = existing.srtContent || '';

    if (shouldSkipStep('captions', resumeFrom) && existing.srtUrl) {
      console.log(`[Pipeline] Using existing captions: ${existing.srtUrl}`);
      // Download existing SRT content if not provided
      if (!srtContent && existing.srtUrl) {
        try {
          const srtResponse = await fetch(existing.srtUrl);
          if (srtResponse.ok) {
            srtContent = await srtResponse.text();
            console.log(`[Pipeline] Downloaded existing SRT: ${srtContent.length} chars`);
          }
        } catch (e) {
          console.warn('[Pipeline] Could not download existing SRT');
        }
      }
      steps.push({ step: 'captions', success: true, duration: 0, data: { skipped: true, captionsUrl: existing.srtUrl } });
    } else {
      reportProgress('captions', 40, 'Generating captions...');
      const captionsStart = Date.now();
      try {
        const captionsRes = await callStreamingAPI('/generate-captions', {
          audioUrl,
          projectId,
          stream: true,
        }, (data) => {
          if (data.type === 'progress') {
            reportProgress('captions', 40 + Math.round(data.progress * 0.05), `Generating captions... ${data.progress}%`);
          }
        });
        captionsUrl = captionsRes.captionsUrl;
        steps.push({
          step: 'captions',
          success: true,
          duration: Date.now() - captionsStart,
          data: { captionsUrl },
        });

        // Download SRT content for later steps
        try {
          const srtResponse = await fetch(captionsUrl);
          if (srtResponse.ok) {
            srtContent = await srtResponse.text();
            console.log(`[Pipeline] Downloaded SRT: ${srtContent.length} chars`);
          }
        } catch (e) {
          console.warn('[Pipeline] Could not download SRT, continuing...');
        }

        // Save captions to project
        await saveProjectToDatabase(supabase, projectId, {
          srtUrl: captionsUrl,
          srtContent,
          currentStep: 'prompts',
        });
      } catch (error: any) {
        steps.push({ step: 'captions', success: false, duration: Date.now() - captionsStart, error: error.message });
        throw new Error(`Failed to generate captions: ${error.message}`);
      }
    }

    // Step 6: Generate image prompts (streaming) - MOVED BEFORE clip prompts/video clips
    // because video clips use I2V mode which requires source images
    const imagePromptsStart = Date.now();
    let imagePrompts: any[] = existing.imagePrompts || [];
    
    if (shouldSkipStep('imagePrompts', resumeFrom) && (existing.imagePrompts?.length ?? 0) > 0) {
      console.log(`[Pipeline] Using existing image prompts (${existing.imagePrompts!.length} prompts)`);
      steps.push({ step: 'imagePrompts', success: true, duration: 0, data: { skipped: true, count: existing.imagePrompts!.length } });
    } else {
      reportProgress('imagePrompts', 45, 'Generating image prompts...');
      try {
        const promptsRes = await callStreamingAPI('/generate-image-prompts', {
          script,
          srtContent,  // Reuse SRT downloaded earlier
          projectId,
          imageCount: calculatedImageCount,
          masterStylePrompt: DUTCH_GOLDEN_AGE_STYLE,  // Use Dutch Golden Age style for Auto Poster
          stream: true,
        }, (data) => {
          if (data.type === 'progress') {
            reportProgress('imagePrompts', 45 + Math.round(data.progress * 0.03), `Generating image prompts...`);
          }
        });
        imagePrompts = promptsRes.prompts;
        steps.push({
          step: 'imagePrompts',
          success: true,
          duration: Date.now() - imagePromptsStart,
          data: { count: imagePrompts.length },
        });
      } catch (error: any) {
        steps.push({ step: 'imagePrompts', success: false, duration: Date.now() - imagePromptsStart, error: error.message });
        throw new Error(`Failed to generate image prompts: ${error.message}`);
      }
    }

    // Step 7: Generate images (streaming) - MOVED BEFORE clip prompts/video clips
    // Retry logic for long videos with many images (can timeout on first attempt)
    const imagesStart = Date.now();
    let imageUrls: string[] = existing.imageUrls || [];
    
    if (shouldSkipStep('images', resumeFrom) && (existing.imageUrls?.length ?? 0) > 0) {
      console.log(`[Pipeline] Using existing images (${existing.imageUrls!.length} images)`);
      steps.push({ step: 'images', success: true, duration: 0, data: { skipped: true, count: existing.imageUrls!.length } });
    } else {
      reportProgress('images', 48, 'Generating images...');
      const MAX_IMAGE_RETRIES = 3;
      let imageAttempt = 0;
      let lastImageError: string = '';

      // Calculate timeout based on image count (2 min per image + 5 min buffer)
      const imageTimeout = Math.max(600000, (calculatedImageCount * 120000) + 300000);
      console.log(`[Pipeline] Image generation: ${calculatedImageCount} images, timeout ${Math.round(imageTimeout / 60000)} min`);

      while (imageAttempt < MAX_IMAGE_RETRIES) {
        imageAttempt++;
        try {
          const attemptLabel = imageAttempt > 1 ? ` (attempt ${imageAttempt})` : '';
          reportProgress('images', 48, `Generating images${attemptLabel}...`);

          const imagesRes = await callStreamingAPI('/generate-images', {
            prompts: imagePrompts,
            projectId,
            stream: true,
          }, (data) => {
            if (data.type === 'progress') {
              reportProgress('images', 48 + Math.round((data.completed / data.total) * 10), `Generating images ${data.completed}/${data.total}${attemptLabel}...`);
            }
          }, imageTimeout);
          // imagesRes.images is already an array of URL strings, not objects
          imageUrls = imagesRes.images as string[];
          steps.push({
            step: 'images',
            success: true,
            duration: Date.now() - imagesStart,
            data: { count: imageUrls.length, attempts: imageAttempt },
          });
          break;  // Success - exit retry loop
        } catch (error: any) {
          lastImageError = error.message;
          console.warn(`[Pipeline] Image generation attempt ${imageAttempt} failed: ${error.message}`);
          if (imageAttempt < MAX_IMAGE_RETRIES) {
            console.log(`[Pipeline] Retrying image generation in 5 seconds...`);
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      }

      if (imageUrls.length === 0) {
        steps.push({ step: 'images', success: false, duration: Date.now() - imagesStart, error: lastImageError });
        throw new Error(`Failed to generate images after ${MAX_IMAGE_RETRIES} attempts: ${lastImageError}`);
      }
    }

    // Step 8: Generate clip prompts (12 × 5s intro videos)
    const clipPromptsStart = Date.now();
    let clipPrompts: any[] = existing.clipPrompts || [];
    
    if (shouldSkipStep('clipPrompts', resumeFrom) && (existing.clipPrompts?.length ?? 0) > 0) {
      console.log(`[Pipeline] Using existing clip prompts (${existing.clipPrompts!.length} prompts)`);
      steps.push({ step: 'clipPrompts', success: true, duration: 0, data: { skipped: true, count: existing.clipPrompts!.length } });
    } else {
      reportProgress('clipPrompts', 58, 'Generating video clip prompts...');
      try {
        const clipPromptsRes = await callStreamingAPI('/generate-clip-prompts', {
          script,
          srtContent,
          projectId,
          clipCount: INTRO_CLIP_COUNT,
          clipDuration: INTRO_CLIP_DURATION,
          stream: true,
        }, (data) => {
          if (data.type === 'progress') {
            reportProgress('clipPrompts', 58 + Math.round(data.progress * 0.02), `Generating clip prompts...`);
          }
        });
        clipPrompts = clipPromptsRes.prompts;
        steps.push({
          step: 'clipPrompts',
          success: true,
          duration: Date.now() - clipPromptsStart,
          data: { count: clipPrompts.length },
        });
      } catch (error: any) {
        // Clip prompts failure is non-fatal - continue without intro clips
        console.warn(`[Pipeline] Clip prompts failed, continuing without intro clips: ${error.message}`);
        clipPrompts = [];
        steps.push({ step: 'clipPrompts', success: false, duration: Date.now() - clipPromptsStart, error: error.message });
      }
    }

    // Step 9: Generate video clips (Kie.ai I2V - Image-to-Video)
    // Uses the first N generated images as source frames for I2V animation
    const videoClipsStart = Date.now();
    let introClips: { index: number; videoUrl: string; startSeconds: number; endSeconds: number }[] = existing.clips || [];
    
    if (shouldSkipStep('videoClips', resumeFrom) && (existing.clips?.length ?? 0) > 0) {
      console.log(`[Pipeline] Using existing video clips (${existing.clips!.length} clips)`);
      steps.push({ step: 'videoClips', success: true, duration: 0, data: { skipped: true, count: existing.clips!.length } });
    } else if (clipPrompts.length > 0 && imageUrls.length > 0) {
      reportProgress('videoClips', 60, 'Generating intro video clips...');
      try {
        // Map clip prompts to clips with imageUrl from generated images
        // Use first N images for N clips (cycle if needed)
        const clipsWithImages = clipPrompts.map((p: any, i: number) => ({
          index: i + 1,
          startSeconds: i * INTRO_CLIP_DURATION,
          endSeconds: (i + 1) * INTRO_CLIP_DURATION,
          prompt: p.prompt || p,
          imageUrl: imageUrls[i % imageUrls.length],  // Use generated images as source for I2V
        }));

        console.log(`[Pipeline] Sending ${clipsWithImages.length} clips with imageUrls to generate-video-clips`);

        const clipsRes = await callStreamingAPI('/generate-video-clips', {
          projectId,
          clips: clipsWithImages,
          duration: INTRO_CLIP_DURATION,
          stream: true,
        }, (data) => {
          if (data.type === 'progress') {
            reportProgress('videoClips', 60 + Math.round((data.completed / data.total) * 8), `Generating clips ${data.completed}/${data.total}...`);
          }
        }, 1800000);  // 30 min timeout for 12 clips

        introClips = (clipsRes.clips || []).map((c: any) => ({
          index: c.index,
          videoUrl: c.videoUrl,  // Use videoUrl to match GeneratedClip interface
          startSeconds: (c.index - 1) * INTRO_CLIP_DURATION,
          endSeconds: c.index * INTRO_CLIP_DURATION,
        }));
        steps.push({
          step: 'videoClips',
          success: true,
          duration: Date.now() - videoClipsStart,
          data: { count: introClips.length, totalDuration: introClips.length * INTRO_CLIP_DURATION },
        });
      } catch (error: any) {
        // Video clips failure is non-fatal - continue without intro clips
        console.warn(`[Pipeline] Video clips failed, continuing without intro clips: ${error.message}`);
        introClips = [];
        steps.push({ step: 'videoClips', success: false, duration: Date.now() - videoClipsStart, error: error.message });
      }
    } else {
      const skipReason = clipPrompts.length === 0 ? 'no clip prompts' : 'no images available';
      console.log(`[Pipeline] Skipping video clips: ${skipReason}`);
      steps.push({
        step: 'videoClips',
        success: false,
        duration: 0,
        error: `Skipped - ${skipReason}`,
      });
    }

    // Save images, clip prompts, and clips to project
    await saveProjectToDatabase(supabase, projectId, {
      imagePrompts,
      imageUrls,
      clipPrompts,
      clips: introClips,
      currentStep: 'images',
    });

    // Step 10: Analyze thumbnail + generate using original as reference
    reportProgress('thumbnail', 68, 'Analyzing and generating thumbnail...');
    const thumbnailStart = Date.now();
    let thumbnailUrl: string = '';
    const MAX_THUMBNAIL_ATTEMPTS = 5;
    let thumbnailAttempt = 0;
    let lastThumbnailError: string = '';

    while (!thumbnailUrl && thumbnailAttempt < MAX_THUMBNAIL_ATTEMPTS) {
      thumbnailAttempt++;
      try {
        reportProgress('thumbnail', 68, `Generating thumbnail (attempt ${thumbnailAttempt})...`);
        console.log(`[Pipeline] Thumbnail generation attempt ${thumbnailAttempt}/${MAX_THUMBNAIL_ATTEMPTS}`);

        // Download original thumbnail as base64 for image-to-image generation
        console.log(`[Pipeline] Downloading original thumbnail: ${input.originalThumbnailUrl}`);
        const originalThumbnailBase64 = await downloadImageAsBase64(input.originalThumbnailUrl);

        // Analyze original thumbnail style
        const analysisRes = await callInternalAPI('/analyze-thumbnail', {
          thumbnailUrl: input.originalThumbnailUrl,
          videoTitle: input.originalTitle,
        });

        // Build a prompt for original recreation inspired by the source
        const enhancedPrompt = `Create an original thumbnail inspired by this image. Use the same style, color palette, text placement, and mood - but make it a unique, original composition. Keep similar visual elements and aesthetic but don't copy directly.`;

        // Generate new thumbnail using original as reference image (image-to-image)
        const thumbnailRes = await callStreamingAPI('/generate-thumbnails', {
          projectId,
          exampleImageBase64: originalThumbnailBase64,
          prompt: enhancedPrompt,
          thumbnailCount: 1,
          stream: true,
        }, undefined, 120000);

        if (thumbnailRes.thumbnails?.[0]) {
          thumbnailUrl = thumbnailRes.thumbnails[0];
          console.log(`[Pipeline] Thumbnail generated successfully on attempt ${thumbnailAttempt}`);
        } else {
          throw new Error('No thumbnail URL in response');
        }
      } catch (error: any) {
        lastThumbnailError = error.message;
        console.warn(`[Pipeline] Thumbnail attempt ${thumbnailAttempt} failed: ${error.message}`);
        if (thumbnailAttempt < MAX_THUMBNAIL_ATTEMPTS) {
          console.log(`[Pipeline] Retrying thumbnail generation...`);
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
        }
      }
    }

    if (!thumbnailUrl) {
      // All attempts failed - this is now a fatal error
      throw new Error(`Thumbnail generation failed after ${MAX_THUMBNAIL_ATTEMPTS} attempts: ${lastThumbnailError}`);
    }

    steps.push({
      step: 'thumbnail',
      success: true,
      duration: Date.now() - thumbnailStart,
      data: { thumbnailUrl, attempts: thumbnailAttempt },
    });

    // Step 11: Render video (streaming) - with intro clips if available
    reportProgress('render', 72, 'Rendering video...');
    const renderStart = Date.now();
    let videoUrl: string = '';

    // Skip images that were used for intro video clips (I2V mode)
    // Use clipPrompts.length (attempted), not introClips.length (successful) - a failed clip still used the image
    const imagesUsedForClips = clipPrompts.length;  // All images used as I2V source, even if clip failed
    const slideshowImageUrls = imagesUsedForClips > 0
      ? imageUrls.slice(imagesUsedForClips)
      : imageUrls;
    const slideshowImagePrompts = imagesUsedForClips > 0
      ? imagePrompts.slice(imagesUsedForClips)
      : imagePrompts;

    console.log(`[Pipeline] Render: ${introClips.length} intro clips (${imagesUsedForClips} images used), ${slideshowImageUrls.length} images remaining for slideshow`);

    // Build image timings from the prompts (each prompt has startSeconds/endSeconds)
    const imageTimings = slideshowImagePrompts.map((p: any) => ({
      startSeconds: p.startSeconds,
      endSeconds: p.endSeconds,
    }));

    try {
      // Start render job (returns immediately with job ID)
      // Transform clips to use 'url' property for render-video route (worker expects 'url')
      const renderClips = introClips.length > 0
        ? introClips.map(c => ({ url: c.videoUrl, startSeconds: c.startSeconds, endSeconds: c.endSeconds }))
        : undefined;
      const startRes = await callInternalAPI('/render-video', {
        projectId,
        audioUrl,
        imageUrls: slideshowImageUrls,  // Only images NOT used for video clips
        imageTimings,
        srtContent,
        effects: { smoke_embers: true },
        introClips: renderClips,
      });

      const jobId = startRes.jobId;
      console.log(`[Pipeline] Render job started: ${jobId}`);

      // Poll for completion (render-video uses polling, not SSE)
      const POLL_INTERVAL = 3000;  // 3 seconds
      const MAX_POLL_TIME = 60 * 60 * 1000;  // 1 hour
      const pollStart = Date.now();
      let lastProgress = 0;

      while (Date.now() - pollStart < MAX_POLL_TIME) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL));

        const statusRes = await fetch(`${API_BASE_URL}/render-video/status/${jobId}`);
        if (!statusRes.ok) {
          console.warn(`[Pipeline] Render status poll failed: ${statusRes.status}`);
          continue;
        }

        const job = await statusRes.json() as { status: string; progress: number; message: string; video_url?: string; error?: string };

        // Update progress if changed
        if (job.progress !== lastProgress) {
          lastProgress = job.progress;
          reportProgress('render', 72 + Math.round(job.progress * 0.18), `Rendering video... ${job.progress}%`);
        }

        if (job.status === 'complete') {
          videoUrl = job.video_url!;
          console.log(`[Pipeline] Render complete: ${videoUrl}`);
          break;
        } else if (job.status === 'failed') {
          throw new Error(job.error || 'Render job failed');
        }
        // Continue polling for queued, rendering, muxing, uploading statuses
      }

      if (!videoUrl) {
        throw new Error('Render job timed out after 1 hour');
      }
      steps.push({
        step: 'render',
        success: true,
        duration: Date.now() - renderStart,
        data: { videoUrl },
      });

      // Save video URL and thumbnail immediately after render (before YouTube upload)
      // Use smokeEmbersVideoUrl since pipeline always renders with smoke+embers effects
      await saveProjectToDatabase(supabase, projectId, {
        smokeEmbersVideoUrl: videoUrl,
        thumbnails: [thumbnailUrl],
        currentStep: 'upload',
      });
    } catch (error: any) {
      steps.push({ step: 'render', success: false, duration: Date.now() - renderStart, error: error.message });
      throw new Error(`Failed to render video: ${error.message}`);
    }

    // Step 12: Upload to YouTube (streaming)
    reportProgress('upload', 85, 'Generating YouTube metadata...');
    const uploadStart = Date.now();
    let youtubeVideoId: string;
    let youtubeUrl: string;
    try {
      // First, get a fresh access token from stored refresh token
      console.log('[Pipeline] Getting YouTube access token...');
      const tokenRes = await fetch(`http://localhost:${process.env.PORT || 10000}/youtube-upload/token`, {
        method: 'GET',
      });
      const tokenData = await tokenRes.json() as { success?: boolean; accessToken?: string; error?: string; needsAuth?: boolean };

      if (!tokenRes.ok || !tokenData.accessToken) {
        throw new Error(tokenData.needsAuth
          ? 'YouTube not authenticated. Please connect YouTube account in the app first.'
          : tokenData.error || 'Failed to get YouTube access token');
      }
      console.log('[Pipeline] Got YouTube access token');

      // Generate AI metadata for YouTube
      let youtubeDescription = `${clonedTitle}\n\nGenerated with AI`;
      // Fixed default tags - always use these
      const DEFAULT_YOUTUBE_TAGS = ['history for sleep', 'ancient history', 'ancient civilizations'];
      const youtubeTags = [...DEFAULT_YOUTUBE_TAGS];
      try {
        console.log('[Pipeline] Generating YouTube metadata with AI...');
        const metadataRes = await fetch(`http://localhost:${process.env.PORT || 10000}/generate-youtube-metadata`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...internalAuthHeader },
          body: JSON.stringify({ title: clonedTitle, script }),
        });
        const metadataData = await metadataRes.json() as { success?: boolean; description?: string; tags?: string[]; error?: string };
        if (metadataRes.ok && metadataData.success) {
          youtubeDescription = metadataData.description || youtubeDescription;
          // Always use fixed tags - ignore AI-generated tags
          console.log(`[Pipeline] AI description generated, using fixed tags: ${youtubeTags.join(', ')}`);
        } else {
          console.log('[Pipeline] AI metadata failed, using default:', metadataData.error);
        }
      } catch (metaError) {
        console.log('[Pipeline] AI metadata error, using default:', metaError);
      }

      // Fetch playlists and find "Complete Histories"
      reportProgress('upload', 88, 'Finding playlist...');
      let playlistId: string | undefined;
      
      // Hardcoded fallback playlist ID for "Complete Histories"
      // TODO: Get the actual playlist ID from YouTube and update here
      // This ensures playlist is always set even if fetch fails
      const COMPLETE_HISTORIES_PLAYLIST_ID = process.env.YOUTUBE_COMPLETE_HISTORIES_PLAYLIST_ID || '';
      
      try {
        console.log('[Pipeline] Fetching YouTube playlists...');
        const playlistRes = await fetch(`http://localhost:${process.env.PORT || 10000}/youtube-upload/playlists`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${tokenData.accessToken}` },
        });
        const playlistData = await playlistRes.json() as { playlists?: { id: string; title: string }[]; error?: string };
        console.log(`[Pipeline] Playlist fetch response: status=${playlistRes.status}, ok=${playlistRes.ok}`);

        if (playlistRes.ok && playlistData.playlists && playlistData.playlists.length > 0) {
          // Log all available playlists for debugging
          console.log(`[Pipeline] Found ${playlistData.playlists.length} playlists:`);
          playlistData.playlists.forEach((p, i) => {
            console.log(`  [${i}] "${p.title}" (id: ${p.id})`);
          });

          // Search for "Complete Histories" playlist (flexible matching)
          const completeHistories = playlistData.playlists.find(
            p => p.title.toLowerCase().includes('complete histories') ||
                 p.title.toLowerCase().includes('complete history')
          );
          if (completeHistories) {
            playlistId = completeHistories.id;
            console.log(`[Pipeline] ✓ Found playlist: "${completeHistories.title}" (id: ${playlistId})`);
          } else {
            console.warn('[Pipeline] ✗ "Complete Histories" not found in playlist names');
            if (COMPLETE_HISTORIES_PLAYLIST_ID) {
              console.log('[Pipeline] Using hardcoded playlist ID as fallback');
              playlistId = COMPLETE_HISTORIES_PLAYLIST_ID;
            }
          }
        } else {
          console.error(`[Pipeline] Playlist fetch failed or empty:`, playlistData);
          if (COMPLETE_HISTORIES_PLAYLIST_ID) {
            console.log('[Pipeline] Using hardcoded playlist ID as fallback');
            playlistId = COMPLETE_HISTORIES_PLAYLIST_ID;
          }
        }
      } catch (playlistError) {
        console.error('[Pipeline] Playlist fetch error:', playlistError);
        if (COMPLETE_HISTORIES_PLAYLIST_ID) {
          console.log('[Pipeline] Using hardcoded playlist ID as fallback');
          playlistId = COMPLETE_HISTORIES_PLAYLIST_ID;
        }
      }
      
      // Double-check playlistId is set
      if (!playlistId && COMPLETE_HISTORIES_PLAYLIST_ID) {
        console.warn('[Pipeline] playlistId still undefined, forcing hardcoded ID');
        playlistId = COMPLETE_HISTORIES_PLAYLIST_ID;
      }
      console.log(`[Pipeline] Final playlistId for upload: ${playlistId || 'NOT SET - VIDEO WILL NOT BE ADDED TO PLAYLIST'}`);

      reportProgress('upload', 90, 'Uploading to YouTube...');
      const uploadRes = await callStreamingAPI('/youtube-upload', {
        videoUrl,
        accessToken: tokenData.accessToken,
        title: clonedTitle,
        description: youtubeDescription,
        tags: youtubeTags,
        categoryId: '27',  // Education
        privacyStatus: input.publishAt ? 'private' : 'unlisted',
        publishAt: input.publishAt,
        thumbnailUrl,
        playlistId,
      }, (data) => {
        if (data.type === 'progress') {
          const pct = data.percent ?? data.progress ?? 0;  // youtube-upload uses 'percent'
          reportProgress('upload', 90 + Math.round(pct * 0.1), `Uploading... ${pct}%`);
        }
      }, 1200000);  // 20 min timeout
      youtubeVideoId = uploadRes.videoId;
      youtubeUrl = uploadRes.youtubeUrl;
      steps.push({
        step: 'upload',
        success: true,
        duration: Date.now() - uploadStart,
        data: { youtubeVideoId, youtubeUrl, publishAt: input.publishAt },
      });
    } catch (error: any) {
      steps.push({ step: 'upload', success: false, duration: Date.now() - uploadStart, error: error.message });
      throw new Error(`Failed to upload to YouTube: ${error.message}`);
    }

    reportProgress('complete', 100, 'Pipeline complete!');

    // Save final project state
    // Use smokeEmbersVideoUrl since pipeline always renders with smoke+embers effects
    await saveProjectToDatabase(supabase, projectId, {
      smokeEmbersVideoUrl: videoUrl,
      thumbnails: [thumbnailUrl],
      status: 'completed',
      currentStep: 'complete',
      youtubeTitle: clonedTitle,
    });

    return {
      success: true,
      projectId,
      clonedTitle,
      youtubeVideoId,
      youtubeUrl,
      steps,
    };

  } catch (error: any) {
    console.error(`[Pipeline] Failed: ${error.message}`);
    return {
      success: false,
      projectId,
      error: error.message,
      steps,
    };
  }
}

/**
 * Calculate the next 5 PM PST publish time
 */
export function getNext5pmPST(): string {
  const now = new Date();

  // Convert to PST (UTC-8)
  const pstOffset = -8 * 60;  // minutes
  const utcNow = now.getTime() + (now.getTimezoneOffset() * 60000);
  const pstNow = new Date(utcNow + (pstOffset * 60000));

  // Set to 5 PM PST today
  const target = new Date(pstNow);
  target.setHours(17, 0, 0, 0);

  // If already past 5 PM PST today, schedule for tomorrow
  if (pstNow >= target) {
    target.setDate(target.getDate() + 1);
  }

  // Convert back to UTC for API
  const utcTarget = new Date(target.getTime() - (pstOffset * 60000));

  return utcTarget.toISOString();
}
