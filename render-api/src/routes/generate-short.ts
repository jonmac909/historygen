import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { createAnthropicClient, formatSystemPrompt } from '../lib/anthropic-client';
import { saveCost } from '../lib/cost-tracker';

const router = Router();

// Types
type HookStyle = 'story' | 'didyouknow' | 'question' | 'contrast';

interface GenerateShortRequest {
  projectId: string;
  hookStyle: HookStyle;
  shortScript: string;
  voiceSampleUrl: string;
  settings?: {
    ttsEmotionMarker?: string;
    ttsTemperature?: number;
    ttsTopP?: number;
    ttsRepetitionPenalty?: number;
  };
}

interface ShortImagePrompt {
  index: number;
  description: string;
  searchQuery?: string;  // For real portrait search
  isRealPortrait: boolean;
}

// Supabase client
function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  return createClient(url, key);
}

// Generate image prompts from Short script
async function generateImagePrompts(script: string, apiKey: string): Promise<ShortImagePrompt[]> {
  const anthropic = createAnthropicClient(apiKey);

  const systemPrompt = `You are an expert at creating image prompts for historical YouTube Shorts.

Given a ~26 second script, create exactly 13 image descriptions (one every ~2 seconds).
Each image should be a vertical (9:16) portrait or scene.

For each image, determine:
1. If a real historical portrait/painting likely exists (e.g., "portrait of Queen Charlotte")
2. Or if it needs to be AI-generated (e.g., "ship arriving at harbor")

Return a JSON array with exactly 13 objects.`;

  const userPrompt = `Script:
"${script}"

Create 13 image descriptions. Return JSON array:
[
  {
    "index": 0,
    "description": "Portrait of Queen Charlotte in elegant royal dress, oil painting style, 9:16 vertical",
    "searchQuery": "Queen Charlotte portrait painting",
    "isRealPortrait": true
  },
  {
    "index": 1,
    "description": "Royal ship arriving at English harbor in 1761, misty morning, oil painting, 9:16 vertical",
    "searchQuery": null,
    "isRealPortrait": false
  }
  // ... 11 more
]

Return ONLY the JSON array.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    system: formatSystemPrompt(systemPrompt),
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0]?.type === 'text' ? response.content[0].text : '';

  // Parse JSON
  let jsonStr = text.trim();
  if (jsonStr.startsWith('```json')) jsonStr = jsonStr.slice(7);
  if (jsonStr.startsWith('```')) jsonStr = jsonStr.slice(3);
  if (jsonStr.endsWith('```')) jsonStr = jsonStr.slice(0, -3);

  return JSON.parse(jsonStr.trim());
}

// Search Wikimedia Commons for real portraits
async function searchWikimediaImage(query: string): Promise<string | null> {
  try {
    const searchUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query + ' painting portrait')}&srnamespace=6&srlimit=5&format=json`;

    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    if (!searchData.query?.search?.length) {
      return null;
    }

    // Get the first image's URL
    const title = searchData.query.search[0].title;
    const imageInfoUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url&format=json`;

    const infoRes = await fetch(imageInfoUrl);
    const infoData = await infoRes.json();

    const pages = infoData.query?.pages;
    if (!pages) return null;

    const pageId = Object.keys(pages)[0];
    const imageUrl = pages[pageId]?.imageinfo?.[0]?.url;

    return imageUrl || null;
  } catch (error) {
    console.error('[SearchWikimedia] Error:', error);
    return null;
  }
}

// Generate image with Z-Image (vertical 9:16)
async function generateZImage(prompt: string, projectId: string): Promise<string> {
  const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
  const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ZIMAGE_ENDPOINT_ID;

  if (!RUNPOD_API_KEY || !RUNPOD_ENDPOINT_ID) {
    throw new Error('RunPod Z-Image not configured');
  }

  const RUNPOD_API_URL = `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}`;

  // Style suffix for historical oil painting look
  const STYLE_SUFFIX = ", cinematic romantic historical oil painting style, warm lighting, fully clothed in modest period-appropriate attire, peaceful cozy mood, museum-quality fine art";
  const safePrompt = `${prompt}${STYLE_SUFFIX}`;

  // Start job
  const runRes = await fetch(`${RUNPOD_API_URL}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RUNPOD_API_KEY}`,
    },
    body: JSON.stringify({
      input: {
        prompt: safePrompt,
        negative_prompt: "nudity, nude, naked, violence, gore, blood, horror, scary, dark, modern vehicles",
        aspect_ratio: "9:16",  // Vertical for Shorts
        num_inference_steps: 28,
        guidance_scale: 7.5,
      },
    }),
  });

  const runData = await runRes.json();
  const jobId = runData.id;

  // Poll for completion
  let attempts = 0;
  const maxAttempts = 60;

  while (attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 2000));

    const statusRes = await fetch(`${RUNPOD_API_URL}/status/${jobId}`, {
      headers: { 'Authorization': `Bearer ${RUNPOD_API_KEY}` },
    });

    const statusData = await statusRes.json();

    if (statusData.status === 'COMPLETED') {
      const base64 = statusData.output?.image_base64;
      if (!base64) throw new Error('No image in response');

      // Upload to Supabase
      const supabase = getSupabaseClient();
      const filename = `shorts/${projectId}/${Date.now()}_${Math.random().toString(36).slice(2)}.png`;
      const buffer = Buffer.from(base64, 'base64');

      const { error } = await supabase.storage
        .from('generations')
        .upload(filename, buffer, { contentType: 'image/png' });

      if (error) throw error;

      const { data: urlData } = supabase.storage
        .from('generations')
        .getPublicUrl(filename);

      return urlData.publicUrl;
    }

    if (statusData.status === 'FAILED') {
      throw new Error(statusData.error || 'Z-Image generation failed');
    }

    attempts++;
  }

  throw new Error('Z-Image generation timed out');
}

// Generate TTS audio with Fish Speech
async function generateTTS(
  script: string,
  voiceSampleUrl: string,
  projectId: string,
  settings?: GenerateShortRequest['settings']
): Promise<{ audioUrl: string; duration: number }> {
  const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
  const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_FISH_ENDPOINT_ID;

  if (!RUNPOD_API_KEY || !RUNPOD_ENDPOINT_ID) {
    throw new Error('RunPod Fish Speech not configured');
  }

  const RUNPOD_API_URL = `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}`;

  // Prepend emotion marker if set
  const emotionMarker = settings?.ttsEmotionMarker || '(sincere) (soft tone)';
  const textWithEmotion = `${emotionMarker} ${script}`;

  const runRes = await fetch(`${RUNPOD_API_URL}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RUNPOD_API_KEY}`,
    },
    body: JSON.stringify({
      input: {
        text: textWithEmotion,
        reference_audio_url: voiceSampleUrl,
        temperature: settings?.ttsTemperature || 0.9,
        top_p: settings?.ttsTopP || 0.85,
        repetition_penalty: settings?.ttsRepetitionPenalty || 1.1,
      },
    }),
  });

  const runData = await runRes.json();
  const jobId = runData.id;

  // Poll for completion
  let attempts = 0;
  const maxAttempts = 120;

  while (attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 2000));

    const statusRes = await fetch(`${RUNPOD_API_URL}/status/${jobId}`, {
      headers: { 'Authorization': `Bearer ${RUNPOD_API_KEY}` },
    });

    const statusData = await statusRes.json();

    if (statusData.status === 'COMPLETED') {
      const audioBase64 = statusData.output?.audio_base64;
      const duration = statusData.output?.duration || 26;

      if (!audioBase64) throw new Error('No audio in response');

      // Upload to Supabase
      const supabase = getSupabaseClient();
      const filename = `shorts/${projectId}/audio_${Date.now()}.wav`;
      const buffer = Buffer.from(audioBase64, 'base64');

      const { error } = await supabase.storage
        .from('generations')
        .upload(filename, buffer, { contentType: 'audio/wav' });

      if (error) throw error;

      const { data: urlData } = supabase.storage
        .from('generations')
        .getPublicUrl(filename);

      return { audioUrl: urlData.publicUrl, duration };
    }

    if (statusData.status === 'FAILED') {
      throw new Error(statusData.error || 'TTS generation failed');
    }

    attempts++;
  }

  throw new Error('TTS generation timed out');
}

// Generate captions from audio
async function generateCaptions(audioUrl: string): Promise<string> {
  // Call existing captions endpoint
  const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001';

  const res = await fetch(`${API_BASE}/generate-captions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioUrl }),
  });

  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Captions generation failed');

  return data.srtContent;
}

// Main streaming endpoint
router.post('/', async (req: Request, res: Response) => {
  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendProgress = (step: string, progress: number, message: string) => {
    res.write(`event: progress\ndata: ${JSON.stringify({ step, progress, message })}\n\n`);
  };

  const sendComplete = (data: any) => {
    res.write(`event: complete\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  };

  const sendError = (error: string) => {
    res.write(`event: error\ndata: ${JSON.stringify({ error })}\n\n`);
    res.end();
  };

  try {
    const { projectId, hookStyle, shortScript, voiceSampleUrl, settings } = req.body as GenerateShortRequest;

    if (!projectId || !shortScript || !voiceSampleUrl) {
      return sendError('Missing required fields: projectId, shortScript, voiceSampleUrl');
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return sendError('ANTHROPIC_API_KEY not configured');
    }

    const supabase = getSupabaseClient();

    // Step 1: Generate TTS audio (0-20%)
    sendProgress('tts', 5, 'Generating voiceover...');
    const { audioUrl, duration } = await generateTTS(shortScript, voiceSampleUrl, projectId, settings);
    sendProgress('tts', 20, 'Voiceover complete');

    // Step 2: Generate captions (20-30%)
    sendProgress('captions', 25, 'Generating captions...');
    const srtContent = await generateCaptions(audioUrl);
    sendProgress('captions', 30, 'Captions complete');

    // Step 3: Generate image prompts (30-35%)
    sendProgress('prompts', 32, 'Planning images...');
    const imagePrompts = await generateImagePrompts(shortScript, apiKey);
    sendProgress('prompts', 35, `Planned ${imagePrompts.length} images`);

    // Step 4: Source images (35-85%)
    sendProgress('images', 35, 'Sourcing images...');
    const imageUrls: string[] = [];

    for (let i = 0; i < imagePrompts.length; i++) {
      const prompt = imagePrompts[i];
      const progress = 35 + (i / imagePrompts.length) * 50;

      sendProgress('images', progress, `Sourcing image ${i + 1}/${imagePrompts.length}...`);

      let imageUrl: string | null = null;

      // Try Wikimedia first for real portraits
      if (prompt.isRealPortrait && prompt.searchQuery) {
        imageUrl = await searchWikimediaImage(prompt.searchQuery);
        if (imageUrl) {
          console.log(`[GenerateShort] Found real portrait: ${prompt.searchQuery}`);
        }
      }

      // Fall back to Z-Image generation
      if (!imageUrl) {
        imageUrl = await generateZImage(prompt.description, projectId);
        console.log(`[GenerateShort] Generated image: ${prompt.description.substring(0, 50)}...`);
      }

      imageUrls.push(imageUrl);
    }

    sendProgress('images', 85, `All ${imageUrls.length} images ready`);

    // Step 5: Render Short video (85-95%)
    sendProgress('render', 87, 'Rendering Short video...');

    // Call render-short endpoint
    const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001';
    const renderRes = await fetch(`${API_BASE}/render-short`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        imageUrls,
        audioUrl,
        srtContent,
        duration,
      }),
    });

    const renderData = await renderRes.json();
    if (!renderData.success) {
      throw new Error(renderData.error || 'Render failed');
    }

    const shortUrl = renderData.videoUrl;
    sendProgress('render', 95, 'Render complete');

    // Step 6: Save to database (95-100%)
    sendProgress('save', 97, 'Saving...');

    await supabase
      .from('generation_projects')
      .update({
        short_url: shortUrl,
        short_script: shortScript,
        short_audio_url: audioUrl,
        short_srt_content: srtContent,
        short_vertical_images: imageUrls,
        short_hook_style: hookStyle,
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId);

    sendProgress('complete', 100, 'Short ready!');

    // Send completion
    sendComplete({
      success: true,
      shortUrl,
      audioUrl,
      srtContent,
      imageUrls,
      duration,
    });

  } catch (error) {
    console.error('[GenerateShort] Error:', error);
    sendError(error instanceof Error ? error.message : 'Unknown error');
  }
});

export default router;
