import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';

// Lazy load sharp - it has native dependencies that may fail on some platforms
let sharp: typeof import('sharp') | null = null;
const loadSharp = async () => {
  if (sharp) return sharp;
  try {
    const mod = await import('sharp');
    sharp = (mod.default ?? mod) as typeof import('sharp');
    return sharp;
  } catch (e) {
    console.warn('[generate-thumbnails] sharp not available, thumbnail compression disabled:', e);
    return null;
  }
};

// YouTube thumbnail dimensions (16:9 aspect ratio)
const THUMBNAIL_WIDTH = 1280;
const THUMBNAIL_HEIGHT = 720;
const TARGET_ASPECT_RATIO = 16 / 9;

// Crop image to 16:9 aspect ratio (center crop) and resize to target dimensions
async function cropTo16x9(imageBuffer: Buffer, targetWidth = THUMBNAIL_WIDTH, targetHeight = THUMBNAIL_HEIGHT): Promise<Buffer> {
  const sharpInstance = await loadSharp();
  if (!sharpInstance) {
    console.warn('[Thumbnail] sharp not available, skipping 16:9 crop');
    return imageBuffer;
  }

  try {
    const image = sharpInstance(imageBuffer);
    const metadata = await image.metadata();
    const { width, height } = metadata;

    if (!width || !height) {
      console.warn('[Thumbnail] Could not get image dimensions, skipping crop');
      return imageBuffer;
    }

    const currentAspect = width / height;
    let cropWidth = width;
    let cropHeight = height;
    let left = 0;
    let top = 0;

    if (currentAspect > TARGET_ASPECT_RATIO) {
      // Image is wider than 16:9 - crop sides
      cropWidth = Math.round(height * TARGET_ASPECT_RATIO);
      left = Math.round((width - cropWidth) / 2);
      console.log(`[Thumbnail] Cropping width: ${width}x${height} -> ${cropWidth}x${cropHeight} (removing ${left}px from each side)`);
    } else if (currentAspect < TARGET_ASPECT_RATIO) {
      // Image is taller than 16:9 - crop top/bottom
      cropHeight = Math.round(width / TARGET_ASPECT_RATIO);
      top = Math.round((height - cropHeight) / 2);
      console.log(`[Thumbnail] Cropping height: ${width}x${height} -> ${cropWidth}x${cropHeight} (removing ${top}px from top/bottom)`);
    } else {
      console.log(`[Thumbnail] Image already 16:9: ${width}x${height}`);
    }

    const result = await sharpInstance(imageBuffer)
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .resize(targetWidth, targetHeight, { fit: 'fill' })
      .png()
      .toBuffer();

    console.log(`[Thumbnail] Cropped and resized to ${targetWidth}x${targetHeight}`);
    return Buffer.from(result);
  } catch (err) {
    console.error('[Thumbnail] Error cropping to 16:9:', err);
    return imageBuffer;
  }
}

// Remove letterboxing (black bars) from image edges
async function removeLetterboxing(imageBuffer: Buffer): Promise<Buffer> {
  const sharpInstance = await loadSharp();
  if (!sharpInstance) {
    console.warn('[Thumbnail] sharp not available, skipping letterbox removal');
    return imageBuffer;
  }

  try {
    const image = sharpInstance(imageBuffer);
    const metadata = await image.metadata();
    const { width, height } = metadata;

    if (!width || !height) {
      return imageBuffer;
    }

    // Use trim to remove black borders (with small tolerance for near-black pixels)
    const trimmed = await sharpInstance(imageBuffer)
      .trim({ threshold: 10 })  // Remove pixels within 10 of black
      .toBuffer();

    // Check new dimensions
    const trimmedMeta = await sharpInstance(trimmed).metadata();
    if (trimmedMeta.width && trimmedMeta.height) {
      console.log(`[Thumbnail] Letterbox removal: ${width}x${height} -> ${trimmedMeta.width}x${trimmedMeta.height}`);
    }

    return Buffer.from(trimmed);
  } catch (err) {
    console.error('[Thumbnail] Error removing letterboxing:', err);
    return imageBuffer;
  }
}

const router = Router();

// YouTube thumbnail size limit
const MAX_THUMBNAIL_SIZE = 2 * 1024 * 1024; // 2MB

// Kie.ai API configuration for Seedream 4.5
const KIE_API_URL = 'https://api.kie.ai/api/v1/jobs';

interface GenerateThumbnailsRequest {
  exampleImageBase64: string;
  prompt: string; // User-provided prompt describing what to generate
  thumbnailCount: number;
  projectId: string;
  stream?: boolean;
}

// Start a Kie.ai Seedream 4.5-edit task (image-to-image)
async function startImageJob(apiKey: string, prompt: string, quality: string, aspectRatio: string, referenceImageUrl: string): Promise<string> {
  console.log(`Starting Kie.ai Seedream 4.5-edit job: ${prompt.substring(0, 80)}...`);
  console.log(`Reference image: ${referenceImageUrl}`);

  const response = await fetch(`${KIE_API_URL}/createTask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'seedream/4.5-edit',
      input: {
        prompt,
        image_urls: [referenceImageUrl],
        aspect_ratio: aspectRatio,
        quality: quality.toLowerCase(), // 'basic' for 2K, 'high' for 4K
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Kie.ai task creation error:', response.status, errorText);
    throw new Error(`Failed to start thumbnail task: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as any;

  if (data.code !== 200 || !data.data?.taskId) {
    console.error('Kie.ai task creation failed:', data);
    throw new Error(`Kie.ai task creation failed: ${data.msg || 'no task ID returned'}`);
  }

  console.log(`Kie.ai Seedream 4.5-edit task created: ${data.data.taskId}`);
  return data.data.taskId;
}

// Upload base64 image to Supabase and return public URL (for Kie.ai reference)
async function uploadReferenceImage(
  base64: string,
  supabaseUrl: string,
  supabaseKey: string,
  projectId: string
): Promise<string> {
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Decode base64 to buffer
  let imageBuffer = Buffer.from(base64, 'base64');

  // Crop reference image to 16:9 to prevent Seedream from letterboxing
  console.log(`[Thumbnail] Pre-processing reference image (${imageBuffer.length} bytes)...`);
  imageBuffer = Buffer.from(await cropTo16x9(imageBuffer));

  // Generate unique filename for reference image
  const filename = `reference_${Date.now()}.png`;
  const filePath = `${projectId}/thumbnails/${filename}`;

  console.log(`Uploading reference image to storage: ${filePath} (${imageBuffer.length} bytes)`);

  const { error } = await supabase.storage
    .from('generated-assets')
    .upload(filePath, imageBuffer, {
      contentType: 'image/png',
      upsert: true,
    });

  if (error) {
    console.error('Supabase storage upload error:', error);
    throw new Error(`Reference image upload failed: ${error.message}`);
  }

  const { data } = supabase.storage
    .from('generated-assets')
    .getPublicUrl(filePath);

  if (!data?.publicUrl) {
    throw new Error('Failed to get public URL for reference image');
  }

  console.log(`Reference image uploaded: ${data.publicUrl}`);
  return data.publicUrl;
}

// Check Kie.ai task status and download/upload image if complete
async function checkJobStatus(
  apiKey: string,
  taskId: string,
  supabaseUrl: string,
  supabaseKey: string,
  filename: string,
  projectId: string
): Promise<{ state: string; imageUrl?: string; error?: string }> {
  try {
    const response = await fetch(`${KIE_API_URL}/recordInfo?taskId=${taskId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      console.error(`Kie.ai status check failed: ${response.status}`);
      return { state: 'pending' };
    }

    const data = await response.json() as any;

    if (data.code !== 200) {
      console.error(`Kie.ai status check error:`, data);
      return { state: 'pending' };
    }

    const taskData = data.data;
    const state = taskData.state;

    if (state === 'success') {
      // Parse resultJson to get image URLs
      let resultUrls: string[] = [];
      try {
        const resultJson = JSON.parse(taskData.resultJson || '{}');
        resultUrls = resultJson.resultUrls || [];
      } catch (parseErr) {
        console.error(`Failed to parse resultJson for task ${taskId}:`, parseErr);
        return { state: 'fail', error: 'Failed to parse result' };
      }

      if (resultUrls.length === 0) {
        console.error(`Task ${taskId} completed but no image URLs in result`);
        return { state: 'fail', error: 'No image URL returned' };
      }

      const imageUrl = resultUrls[0];
      console.log(`Task ${taskId} completed, downloading from: ${imageUrl}`);

      try {
        // Download image from Kie.ai URL and upload to Supabase
        const uploadedUrl = await downloadAndUploadImage(imageUrl, supabaseUrl, supabaseKey, filename, projectId);
        console.log(`Task ${taskId} completed, uploaded to: ${uploadedUrl}`);
        return { state: 'success', imageUrl: uploadedUrl };
      } catch (uploadErr) {
        console.error(`Failed to upload thumbnail for task ${taskId}:`, uploadErr);
        return { state: 'fail', error: `Upload failed: ${uploadErr instanceof Error ? uploadErr.message : 'Unknown error'}` };
      }
    } else if (state === 'fail') {
      const errorMsg = taskData.failMsg || taskData.failCode || 'Task failed';
      console.error(`Task ${taskId} failed:`, errorMsg);
      return { state: 'fail', error: errorMsg };
    }

    // States: waiting, queuing, generating - all treated as pending
    return { state: 'pending' };
  } catch (err) {
    console.error(`Error checking task ${taskId}:`, err);
    return { state: 'pending' };
  }
}

// Compress image to JPEG under 2MB for YouTube compatibility
async function compressImageForYouTube(imageBuffer: Buffer): Promise<{ buffer: Buffer; contentType: string }> {
  const sharpInstance = await loadSharp();
  if (!sharpInstance) {
    console.warn('[Thumbnail] sharp not available, skipping compression');
    return { buffer: imageBuffer, contentType: 'image/png' };
  }

  // If already under 2MB, just convert to JPEG for consistency
  if (imageBuffer.length <= MAX_THUMBNAIL_SIZE) {
    try {
      const compressed = await sharpInstance(imageBuffer)
        .resize(1280, 720, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer();

      console.log(`[Thumbnail] Converted to JPEG: ${(imageBuffer.length / 1024).toFixed(0)}KB -> ${(compressed.length / 1024).toFixed(0)}KB`);
      return { buffer: Buffer.from(compressed), contentType: 'image/jpeg' };
    } catch (e) {
      console.warn('[Thumbnail] JPEG conversion failed, using original:', e);
      return { buffer: imageBuffer, contentType: 'image/png' };
    }
  }

  console.log(`[Thumbnail] Original size: ${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB, compressing...`);

  let quality = 90;
  let width = 1280; // YouTube recommended thumbnail width
  let compressedBuffer = imageBuffer;
  const originalBuffer = imageBuffer;

  // Try progressively lower quality until under 2MB
  while (compressedBuffer.length > MAX_THUMBNAIL_SIZE && quality > 10) {
    try {
      const compressed = await sharpInstance(originalBuffer)
        .resize(width, null, { withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      compressedBuffer = Buffer.from(compressed);

      console.log(`[Thumbnail] Compressed to ${(compressedBuffer.length / 1024).toFixed(0)}KB at quality=${quality}, width=${width}`);

      if (compressedBuffer.length > MAX_THUMBNAIL_SIZE) {
        quality -= 10;
        if (quality <= 20 && width > 640) {
          width = Math.round(width * 0.8);
          quality = 80; // Reset quality and try smaller dimensions
        }
      }
    } catch (e) {
      console.error('[Thumbnail] Compression failed:', e);
      break;
    }
  }

  console.log(`[Thumbnail] Final size: ${(compressedBuffer.length / 1024).toFixed(0)}KB`);
  return { buffer: compressedBuffer, contentType: 'image/jpeg' };
}

// Download image from URL and upload to Supabase
async function downloadAndUploadImage(
  imageUrl: string,
  supabaseUrl: string,
  supabaseKey: string,
  filename: string,
  projectId: string
): Promise<string> {
  // Download image from Kie.ai
  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(`Failed to download image: ${imageResponse.status}`);
  }

  const arrayBuffer = await imageResponse.arrayBuffer();
  let originalBuffer = Buffer.from(arrayBuffer);

  // Remove any letterboxing (black bars) that Seedream may have added
  console.log(`[Thumbnail] Post-processing generated image (${originalBuffer.length} bytes)...`);
  originalBuffer = Buffer.from(await removeLetterboxing(originalBuffer));

  // Crop to exact 16:9 and resize to YouTube thumbnail dimensions
  originalBuffer = Buffer.from(await cropTo16x9(originalBuffer));

  // Compress to JPEG under 2MB for YouTube compatibility
  const { buffer: imageBuffer, contentType } = await compressImageForYouTube(originalBuffer);

  // Update filename extension if converted to JPEG
  const finalFilename = contentType === 'image/jpeg'
    ? filename.replace(/\.png$/i, '.jpg')
    : filename;

  // Upload to Supabase
  const supabase = createClient(supabaseUrl, supabaseKey);
  const filePath = `${projectId}/thumbnails/${finalFilename}`;
  console.log(`Uploading thumbnail to storage: ${filePath} (${imageBuffer.length} bytes)`);

  const { error } = await supabase.storage
    .from('generated-assets')
    .upload(filePath, imageBuffer, {
      contentType,
      upsert: true,
    });

  if (error) {
    console.error('Supabase storage upload error:', error);
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  const { data } = supabase.storage
    .from('generated-assets')
    .getPublicUrl(filePath);

  if (!data?.publicUrl) {
    throw new Error('Failed to get public URL for uploaded thumbnail');
  }

  return data.publicUrl;
}

// Upload base64 image to Supabase storage
async function uploadThumbnailToStorage(
  base64: string,
  supabaseUrl: string,
  supabaseKey: string,
  filename: string,
  projectId: string
): Promise<string> {
  const supabase = createClient(supabaseUrl, supabaseKey);

  const binaryString = Buffer.from(base64, 'base64').toString('binary');
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const filePath = `${projectId}/thumbnails/${filename}`;
  console.log(`Uploading thumbnail to storage: ${filePath} (${bytes.length} bytes)`);

  const { error } = await supabase.storage
    .from('generated-assets')
    .upload(filePath, bytes, {
      contentType: 'image/png',
      upsert: true,
    });

  if (error) {
    console.error('Supabase storage upload error:', error);
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  const { data } = supabase.storage
    .from('generated-assets')
    .getPublicUrl(filePath);

  if (!data?.publicUrl) {
    throw new Error('Failed to get public URL for uploaded thumbnail');
  }

  return data.publicUrl;
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const kieApiKey = process.env.KIE_API_KEY;
    if (!kieApiKey) {
      return res.status(500).json({ error: 'KIE_API_KEY not configured' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: 'Supabase configuration missing' });
    }

    const { exampleImageBase64, prompt, thumbnailCount, projectId, stream = true }: GenerateThumbnailsRequest = req.body;

    if (!exampleImageBase64) {
      return res.status(400).json({ error: 'No example image provided' });
    }

    if (!prompt || prompt.trim().length === 0) {
      return res.status(400).json({ error: 'No prompt provided' });
    }

    if (!projectId) {
      return res.status(400).json({ error: 'No project ID provided' });
    }

    const count = Math.min(Math.max(thumbnailCount || 3, 1), 10); // Clamp to 1-10

    console.log(`\n=== Generating ${count} thumbnails for project ${projectId} ===`);

    if (stream) {
      return handleStreamingThumbnails(
        req, res,
        exampleImageBase64,
        prompt,
        count,
        projectId,
        kieApiKey,
        supabaseUrl,
        supabaseKey
      );
    } else {
      return res.status(400).json({ error: 'Non-streaming mode not supported' });
    }

  } catch (error) {
    console.error('Error in generate-thumbnails:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ success: false, error: errorMessage });
  }
});

async function handleStreamingThumbnails(
  req: Request,
  res: Response,
  exampleImageBase64: string,
  prompt: string,
  count: number,
  projectId: string,
  kieApiKey: string,
  supabaseUrl: string,
  supabaseKey: string
) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const heartbeatInterval = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeatInterval);
  };

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Phase 1: Upload reference image to get a public URL for Kie.ai
    sendEvent({
      type: 'progress',
      stage: 'uploading',
      percent: 22,
      message: 'Uploading reference image...'
    });

    const referenceImageUrl = await uploadReferenceImage(exampleImageBase64, supabaseUrl, supabaseKey, projectId);

    sendEvent({
      type: 'progress',
      stage: 'generating',
      percent: 25,
      message: `Starting thumbnail generation (${count} images)...`
    });

    // Use the prompt directly (user provides the full description)
    // Add constraints to prevent logos, watermarks, and ensure clean output
    const combinedPrompt = `${prompt}\n\nYouTube thumbnail, 16:9 aspect ratio, high quality, professional. No logos, no watermarks, no text overlays, no branding.`;

    // Generate thumbnails with rolling concurrency
    const MAX_CONCURRENT = 10;
    const POLL_INTERVAL = 2000;
    const MAX_POLLING_TIME = 10 * 60 * 1000; // 10 minutes

    // Use a batch timestamp to ensure unique filenames (prevents browser caching old versions)
    const batchTimestamp = Date.now();

    const results: { state: string; imageUrl?: string; error?: string }[] = [];
    const activeJobs = new Map<string, { index: number; startTime: number }>();
    let nextIndex = 0;
    const startTime = Date.now();

    const startNextJob = async (): Promise<void> => {
      if (nextIndex >= count) return;

      const index = nextIndex;
      nextIndex++;
      const filename = `thumbnail_${batchTimestamp}_${String(index + 1).padStart(3, '0')}.png`;

      try {
        const jobId = await startImageJob(kieApiKey, combinedPrompt, 'high', '16:9', referenceImageUrl);
        activeJobs.set(jobId, { index, startTime: Date.now() });
        console.log(`Started thumbnail job ${index + 1}/${count}: ${filename}`);
      } catch (err) {
        console.error(`Failed to create thumbnail job ${index + 1}:`, err);
        results[index] = { state: 'fail', error: err instanceof Error ? err.message : 'Unknown error' };
      }
    };

    // Start initial batch
    const initialBatch = Math.min(MAX_CONCURRENT, count);
    await Promise.all(Array.from({ length: initialBatch }, () => startNextJob()));

    // Poll and process results
    while (activeJobs.size > 0 && Date.now() - startTime < MAX_POLLING_TIME) {
      const jobIds = Array.from(activeJobs.keys());

      const checkResults = await Promise.all(
        jobIds.map(async (jobId) => {
          const jobData = activeJobs.get(jobId)!;
          const filename = `thumbnail_${batchTimestamp}_${String(jobData.index + 1).padStart(3, '0')}.png`;
          const status = await checkJobStatus(kieApiKey, jobId, supabaseUrl, supabaseKey, filename, projectId);
          return { jobId, jobData, status };
        })
      );

      for (const { jobId, jobData, status } of checkResults) {
        if (status.state === 'success' || status.state === 'fail') {
          results[jobData.index] = status;
          activeJobs.delete(jobId);

          if (status.state === 'success') {
            console.log(`✓ Thumbnail ${jobData.index + 1}/${count} completed`);
          } else {
            console.error(`✗ Thumbnail ${jobData.index + 1}/${count} failed: ${status.error}`);
          }

          // Start next job
          await startNextJob();

          // Update progress
          const completed = results.filter(r => r && r.state === 'success').length;
          const failed = results.filter(r => r && r.state === 'fail').length;
          const percent = 25 + Math.round((completed + failed) / count * 70);

          sendEvent({
            type: 'progress',
            stage: 'generating',
            percent,
            message: `${completed}/${count} thumbnails generated${failed > 0 ? ` (${failed} failed)` : ''}`
          });
        }
      }

      if (activeJobs.size > 0) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
      }
    }

    // Handle timeout
    if (activeJobs.size > 0) {
      console.warn(`Timeout: ${activeJobs.size} thumbnail jobs still pending`);
      for (const [jobId, jobData] of activeJobs) {
        results[jobData.index] = { state: 'fail', error: 'Job timed out' };
      }
    }

    // Collect successful thumbnails
    const thumbnails = results
      .filter(r => r && r.state === 'success' && r.imageUrl)
      .map(r => r.imageUrl!);

    const failedCount = results.filter(r => r && r.state === 'fail').length;

    console.log(`\n=== Thumbnail generation complete ===`);
    console.log(`Success: ${thumbnails.length}/${count}`);
    console.log(`Failed: ${failedCount}/${count}`);

    sendEvent({
      type: 'complete',
      success: true,
      thumbnails,
      total: thumbnails.length,
      failed: failedCount
    });

    cleanup();
    res.end();

  } catch (err) {
    console.error('Thumbnail stream error:', err);
    sendEvent({
      type: 'error',
      error: err instanceof Error ? err.message : 'Thumbnail generation failed'
    });
    cleanup();
    res.end();
  }
}

// Generate thumbnail prompt ideas from a simple topic
router.post('/suggest-prompts', async (req: Request, res: Response) => {
  try {
    const { topic } = req.body;
    if (!topic || typeof topic !== 'string') {
      return res.status(400).json({ error: 'topic is required' });
    }

    const { createAnthropicClient } = await import('../lib/anthropic-client');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    const anthropic = createAnthropicClient(apiKey);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1500,
      system: `You are a YouTube thumbnail designer. Given a topic, generate 4 creative thumbnail prompt ideas. Each prompt should describe a visually striking thumbnail composition including: subject appearance, setting, lighting, mood, color palette, and text overlay suggestions. Keep each prompt to 2-3 sentences. Focus on dramatic, eye-catching compositions that work at small sizes.

Respond as a JSON array of strings, nothing else.`,
      messages: [{
        role: 'user',
        content: `Generate 4 thumbnail prompt ideas for: "${topic}"`
      }],
    });

    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from Claude');
    }

    let prompts: string[];
    try {
      let jsonStr = textContent.text;
      const jsonMatch = jsonStr.match(/```json\s*([\s\S]*?)\s*```/) || jsonStr.match(/```\s*([\s\S]*?)\s*```/);
      if (jsonMatch) jsonStr = jsonMatch[1];
      const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
      if (arrayMatch) jsonStr = arrayMatch[0];
      prompts = JSON.parse(jsonStr);
    } catch {
      prompts = [textContent.text];
    }

    res.json({ success: true, prompts });
  } catch (error) {
    console.error('[SuggestPrompts] Error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to suggest prompts'
    });
  }
});

export default router;
