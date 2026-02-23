import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import ffmpegStatic from 'ffmpeg-static';

const execAsync = promisify(exec);
const router = Router();

const FFMPEG_PATH = ffmpegStatic || 'ffmpeg';

// Short video specs
const SHORT_WIDTH = 1080;
const SHORT_HEIGHT = 1920;
const FPS = 30;

interface RenderShortRequest {
  projectId: string;
  imageUrls: string[];
  audioUrl: string;
  srtContent: string;
  duration: number;
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

// Download file to temp location
async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${url}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(destPath, buffer);
}

// Generate Ken Burns effect filter for an image
function kenBurnsFilter(
  imageIndex: number,
  startTime: number,
  duration: number,
  imageCount: number
): string {
  // Alternate between zoom-in and zoom-out effects
  const zoomIn = imageIndex % 2 === 0;

  // Calculate zoom parameters
  const startZoom = zoomIn ? 1.0 : 1.15;
  const endZoom = zoomIn ? 1.15 : 1.0;

  // Use zoompan filter with smooth interpolation
  // Each image gets its own zoompan, then they're concatenated
  const frames = Math.floor(duration * FPS);

  // zoom: interpolate from startZoom to endZoom over frames
  // d: duration in frames
  // s: output size
  // fps: frame rate
  const zoom = `'if(lte(on,1),${startZoom},min(${endZoom},${startZoom}+(${endZoom}-${startZoom})*on/${frames}))'`;

  return `zoompan=z=${zoom}:d=${frames}:s=${SHORT_WIDTH}x${SHORT_HEIGHT}:fps=${FPS}`;
}

// Create SRT file from content
async function createSrtFile(srtContent: string, destPath: string): Promise<void> {
  await fs.promises.writeFile(destPath, srtContent, 'utf8');
}

// POST /render-short
router.post('/', async (req: Request, res: Response) => {
  const startTime = Date.now();
  console.log('[RenderShort] Starting render...');

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'short-render-'));

  try {
    const { projectId, imageUrls, audioUrl, srtContent, duration } = req.body as RenderShortRequest;

    if (!projectId || !imageUrls?.length || !audioUrl) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: projectId, imageUrls, audioUrl',
      });
    }

    const imageCount = imageUrls.length;
    const imageDuration = duration / imageCount;  // Time per image

    console.log(`[RenderShort] ${imageCount} images, ${imageDuration.toFixed(2)}s each, total ${duration}s`);

    // Download all images
    console.log('[RenderShort] Downloading images...');
    const imagePaths: string[] = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const imagePath = path.join(tempDir, `image_${i.toString().padStart(3, '0')}.png`);
      await downloadFile(imageUrls[i], imagePath);
      imagePaths.push(imagePath);
    }

    // Download audio
    console.log('[RenderShort] Downloading audio...');
    const audioPath = path.join(tempDir, 'audio.wav');
    await downloadFile(audioUrl, audioPath);

    // Create SRT file for subtitles
    const srtPath = path.join(tempDir, 'captions.srt');
    if (srtContent) {
      await createSrtFile(srtContent, srtPath);
    }

    // Output path
    const outputPath = path.join(tempDir, 'short_output.mp4');

    // Build FFmpeg command with Ken Burns effect on each image
    // Strategy: Create each image segment with zoompan, then concat
    const segmentPaths: string[] = [];

    console.log('[RenderShort] Rendering image segments with Ken Burns...');
    for (let i = 0; i < imagePaths.length; i++) {
      const segmentPath = path.join(tempDir, `segment_${i.toString().padStart(3, '0')}.mp4`);
      const imagePath = imagePaths[i];

      // Ken Burns filter for this segment
      const frames = Math.floor(imageDuration * FPS);
      const zoomIn = i % 2 === 0;
      const startZoom = zoomIn ? 1.0 : 1.12;
      const endZoom = zoomIn ? 1.12 : 1.0;

      // zoompan with smooth zoom transition
      const zoomExpr = `'min(max(zoom,pzoom)+0.001,${endZoom})'`;
      const zFilter = `zoompan=z=${zoomExpr}:d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${SHORT_WIDTH}x${SHORT_HEIGHT}:fps=${FPS}`;

      const segmentCmd = `"${FFMPEG_PATH}" -y -loop 1 -i "${imagePath}" -vf "scale=${SHORT_WIDTH * 2}:${SHORT_HEIGHT * 2}:force_original_aspect_ratio=increase,crop=${SHORT_WIDTH * 2}:${SHORT_HEIGHT * 2},${zFilter},format=yuv420p" -t ${imageDuration} -c:v libx264 -preset fast -crf 23 "${segmentPath}"`;

      await execAsync(segmentCmd, { maxBuffer: 50 * 1024 * 1024 });
      segmentPaths.push(segmentPath);
    }

    // Create concat file
    console.log('[RenderShort] Concatenating segments...');
    const concatListPath = path.join(tempDir, 'concat.txt');
    const concatContent = segmentPaths.map(p => `file '${p}'`).join('\n');
    await fs.promises.writeFile(concatListPath, concatContent, 'utf8');

    // Concat all segments into one video
    const concatPath = path.join(tempDir, 'concat_output.mp4');
    const concatCmd = `"${FFMPEG_PATH}" -y -f concat -safe 0 -i "${concatListPath}" -c copy "${concatPath}"`;
    await execAsync(concatCmd, { maxBuffer: 50 * 1024 * 1024 });

    // Add audio and subtitles
    console.log('[RenderShort] Adding audio and captions...');
    let finalCmd: string;

    if (srtContent && fs.existsSync(srtPath)) {
      // With subtitles - use drawtext for better control
      // Parse SRT and create drawtext filter (simplified - just burn in captions)
      finalCmd = `"${FFMPEG_PATH}" -y -i "${concatPath}" -i "${audioPath}" -vf "subtitles='${srtPath.replace(/'/g, "\\'")}':force_style='FontSize=48,FontName=Arial,Bold=1,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=3,Alignment=2,MarginV=100'" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -shortest "${outputPath}"`;
    } else {
      // Without subtitles
      finalCmd = `"${FFMPEG_PATH}" -y -i "${concatPath}" -i "${audioPath}" -c:v copy -c:a aac -b:a 192k -shortest "${outputPath}"`;
    }

    await execAsync(finalCmd, { maxBuffer: 50 * 1024 * 1024 });

    // Verify output exists
    if (!fs.existsSync(outputPath)) {
      throw new Error('FFmpeg did not produce output file');
    }

    const stats = await fs.promises.stat(outputPath);
    console.log(`[RenderShort] Output file: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    // Upload to Supabase
    console.log('[RenderShort] Uploading to Supabase...');
    const supabase = getSupabaseClient();
    const filename = `shorts/${projectId}/short_${Date.now()}.mp4`;
    const videoBuffer = await fs.promises.readFile(outputPath);

    const { error: uploadError } = await supabase.storage
      .from('generations')
      .upload(filename, videoBuffer, { contentType: 'video/mp4' });

    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage
      .from('generations')
      .getPublicUrl(filename);

    const videoUrl = urlData.publicUrl;

    // Clean up temp files
    await fs.promises.rm(tempDir, { recursive: true, force: true });

    const renderDuration = Date.now() - startTime;
    console.log(`[RenderShort] Complete in ${(renderDuration / 1000).toFixed(1)}s`);

    return res.json({
      success: true,
      videoUrl,
      duration,
      width: SHORT_WIDTH,
      height: SHORT_HEIGHT,
    });

  } catch (error) {
    console.error('[RenderShort] Error:', error);

    // Clean up on error
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {}

    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
