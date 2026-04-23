/**
 * Video Preprocessor for VideoRAG
 *
 * Handles CPU-based video analysis on Railway:
 * - Video download via yt-dlp
 * - Frame extraction (1 fps)
 * - Audio extraction
 * - Scene detection
 * - Color analysis
 * - Upload to Supabase
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import path from 'path';
import fs from 'fs';
import os from 'os';
import sharp from 'sharp';
import { spawn } from 'child_process';
import { downloadVideoDirectly } from './youtube-direct-download';

// Set ffmpeg/ffprobe paths
if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);
if (ffprobeStatic?.path) ffmpeg.setFfprobePath(ffprobeStatic.path);

// Supabase client (lazy init)
let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Supabase credentials not configured');
    supabase = createClient(url, key);
  }
  return supabase;
}

// Proxy for yt-dlp
const YTDLP_PROXY_URL = process.env.YTDLP_PROXY_URL || '';

// Storage bucket for analyzed videos
const BUCKET_NAME = 'analyzed-videos';

export interface PreprocessResult {
  videoId: string;
  videoPath: string;
  audioPath: string;
  framePaths: string[];
  frameUrls: string[];  // Supabase URLs
  scenes: Scene[];
  colors: ColorAnalysis[];
  duration: number;
  tier: 1 | 2 | 3;  // Which download tier was used
}

export interface Scene {
  index: number;
  startSeconds: number;
  endSeconds: number;
  frameIndex: number;  // Which frame represents this scene
}

export interface ColorAnalysis {
  sceneIndex: number;
  dominantColor: string;  // Hex color
  palette: string[];      // Top 5 colors
  brightness: number;     // 0-1
}

/**
 * Download a YouTube video with three-tier fallback strategy
 * Tier 1: InnerTube direct (no proxy) - 70-80% expected success
 * Tier 2: yt-dlp without proxy - 10-15% expected success
 * Tier 3: yt-dlp with proxy - 5-10% expected usage (final fallback)
 */
export async function downloadVideo(
  videoUrl: string,
  outputPath: string,
  quality: '720p' | '1080p' = '720p',
  onProgress?: (percent: number) => void
): Promise<{ duration: number; tier: 1 | 2 | 3 }> {
  console.log(`[video-preprocessor] Downloading video: ${videoUrl}`);

  // Tier 1: Try InnerTube direct download (no proxy)
  try {
    console.log('[video-preprocessor] Tier 1: Attempting InnerTube direct download (no proxy)');
    const result = await downloadVideoDirectly(videoUrl, outputPath, onProgress);
    console.log('[video-preprocessor] ✓ Tier 1: Success (no proxy used)');
    return { ...result, tier: 1 };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(`[video-preprocessor] ✗ Tier 1: Failed - ${errorMsg}`);
    console.log('[video-preprocessor] Falling back to Tier 2...');
  }

  // Tier 2: Try yt-dlp WITHOUT proxy
  try {
    console.log('[video-preprocessor] Tier 2: Attempting yt-dlp without proxy');
    const result = await downloadVideoWithYtDlp(videoUrl, outputPath, quality, onProgress, false);
    console.log('[video-preprocessor] ✓ Tier 2: Success (no proxy used)');
    return { ...result, tier: 2 };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(`[video-preprocessor] ✗ Tier 2: Failed - ${errorMsg}`);
    console.log('[video-preprocessor] Falling back to Tier 3...');
  }

  // Tier 3: Use yt-dlp WITH proxy (final fallback)
  console.log('[video-preprocessor] Tier 3: Using yt-dlp with proxy (final fallback)');
  const result = await downloadVideoWithYtDlp(videoUrl, outputPath, quality, onProgress, true);
  console.log('[video-preprocessor] ✓ Tier 3: Success (proxy used)');
  return { ...result, tier: 3 };
}

/**
 * Download a YouTube video using yt-dlp
 * @param useProxy - Whether to use proxy (true) or not (false)
 */
async function downloadVideoWithYtDlp(
  videoUrl: string,
  outputPath: string,
  quality: '720p' | '1080p' = '720p',
  onProgress?: (percent: number) => void,
  useProxy: boolean = true
): Promise<{ duration: number }> {
  // Optimize quality for analysis - we only need frames at 1 fps
  // 480p is sufficient for color/scene detection and downloads 2-3x faster
  const formatSelector = quality === '1080p'
    ? 'bestvideo[height<=480]+bestaudio/best[height<=480]'  // Use 480p for faster downloads
    : 'bestvideo[height<=480]+bestaudio/best[height<=480]';  // Use 480p for faster downloads

  const args = [
    videoUrl,
    '-f', formatSelector,
    '-o', outputPath,
    '--merge-output-format', 'mp4',
    '--no-warnings',
    '--socket-timeout', '120',
    '--retries', '5',
    '--newline', // Output progress on new lines for easier parsing
    '--concurrent-fragments', '4',  // Download 4 fragments in parallel
    '--throttled-rate', '100K',     // Minimum rate to trigger throttle retry
  ];

  // Conditionally add proxy
  if (useProxy && YTDLP_PROXY_URL) {
    args.push('--proxy', YTDLP_PROXY_URL);
    console.log(`[video-preprocessor] Using proxy: ${YTDLP_PROXY_URL.replace(/:[^:@]+@/, ':***@')}`);
  } else {
    console.log(`[video-preprocessor] NOT using proxy`);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;

      // Parse download progress: [download] 45.2% of 123.45MiB
      const progressMatch = chunk.match(/\[download\]\s+(\d+\.?\d*)%/);
      if (progressMatch && onProgress) {
        const percent = parseFloat(progressMatch[1]);
        onProgress(percent);
      }
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', async (code) => {
      if (code !== 0) {
        console.error(`[video-preprocessor] yt-dlp failed:`, stderr);
        reject(new Error(`yt-dlp failed with code ${code}: ${stderr}`));
        return;
      }

      // Get video duration using ffprobe
      try {
        const duration = await getVideoDuration(outputPath);
        console.log(`[video-preprocessor] Downloaded video: ${duration}s`);
        resolve({ duration });
      } catch (err) {
        reject(err);
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
    });
  });
}

/**
 * Get video duration using ffprobe
 */
function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(metadata.format.duration || 0);
    });
  });
}

/**
 * Extract frames from video at 1 fps
 */
export async function extractFrames(
  videoPath: string,
  outputDir: string,
  fps: number = 1,
  onProgress?: (message: string, percent: number) => Promise<void>
): Promise<string[]> {
  console.log(`[video-preprocessor] Extracting frames at ${fps} fps`);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPattern = path.join(outputDir, 'frame_%04d.jpg');

  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions([
        `-vf fps=${fps}`,
        '-q:v 2',  // High quality JPEG
      ])
      .output(outputPattern)
      .on('progress', async (progress) => {
        // Log extraction progress
        if (progress.percent) {
          const message = `Frame extraction: ${progress.percent.toFixed(1)}% (${progress.frames || 0} frames)`;
          console.log(`[video-preprocessor] ${message}`);
          if (onProgress) {
            // Map frame extraction (0-100%) to overall progress (40-45%)
            const overallPercent = Math.round(40 + (progress.percent * 0.05));
            await onProgress(message, overallPercent);
          }
        } else if (progress.timemark) {
          const message = `Frame extraction: ${progress.timemark}`;
          console.log(`[video-preprocessor] ${message}`);
        }
      })
      .on('end', () => {
        // Read all generated frames
        const files = fs.readdirSync(outputDir)
          .filter(f => f.startsWith('frame_') && f.endsWith('.jpg'))
          .sort()
          .map(f => path.join(outputDir, f));

        console.log(`[video-preprocessor] Extracted ${files.length} frames`);
        resolve(files);
      })
      .on('error', (err) => {
        console.error('[video-preprocessor] Frame extraction failed:', err);
        reject(err);
      })
      .run();
  });
}

/**
 * Extract audio track from video
 */
export async function extractAudio(
  videoPath: string,
  outputPath: string
): Promise<void> {
  console.log(`[video-preprocessor] Extracting audio track`);

  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions([
        '-vn',           // No video
        '-acodec pcm_s16le',  // WAV format
        '-ar 16000',     // 16kHz for analysis
        '-ac 1',         // Mono
      ])
      .output(outputPath)
      .on('end', () => {
        console.log(`[video-preprocessor] Audio extracted`);
        resolve();
      })
      .on('error', (err) => {
        console.error('[video-preprocessor] Audio extraction failed:', err);
        reject(err);
      })
      .run();
  });
}

/**
 * Detect scene changes using ffmpeg scene filter
 */
export async function detectScenes(
  videoPath: string,
  threshold: number = 0.3,
  options: {
    durationSeconds?: number;
    onProgress?: (percent: number, message: string) => void | Promise<void>;
  } = {}
): Promise<Scene[]> {
  console.log(`[video-preprocessor] Detecting scenes (threshold: ${threshold})`);

  return new Promise((resolve, reject) => {
    const { durationSeconds, onProgress } = options;
    const scenes: Scene[] = [];
    let lastTime = 0;
    let sceneIndex = 0;
    let lastProgressPercent = -1;
    let lastProgressAt = 0;
    let stderrTail = '';
    let stderrBuffer = '';

    const parseTimestampToSeconds = (timestamp: string): number | null => {
      const parts = timestamp.trim().split(':');
      if (parts.length !== 3) return null;
      const [hours, minutes, seconds] = parts.map(Number);
      if ([hours, minutes, seconds].some((value) => Number.isNaN(value))) return null;
      return hours * 3600 + minutes * 60 + seconds;
    };

    const reportProgress = (currentSeconds: number, timeLabel: string) => {
      if (!onProgress || !durationSeconds || durationSeconds <= 0) return;
      const percent = Math.min(100, Math.max(0, Math.round((currentSeconds / durationSeconds) * 100)));
      const now = Date.now();
      const progressDelta = percent - lastProgressPercent;
      if (percent !== 100 && progressDelta < 5 && now - lastProgressAt < 10000) return;
      lastProgressPercent = percent;
      lastProgressAt = now;
      const message = `Scene detection: ${percent}% (${timeLabel})`;
      void Promise.resolve(onProgress(percent, message)).catch((err) => {
        console.warn('[video-preprocessor] Scene progress callback failed:', err);
      });
    };

    // Use ffmpeg's scene detection filter
    const proc = spawn(ffmpegStatic || 'ffmpeg', [
      '-i', videoPath,
      '-vf', `select='gt(scene,${threshold})',showinfo`,
      '-f', 'null',
      '-',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stderr?.on('data', (data) => {
      const chunk = data.toString();
      stderrTail = (stderrTail + chunk).slice(-4000);
      stderrBuffer += chunk;
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() || '';

      // Parse scene change timestamps from showinfo output
      // Format: [Parsed_showinfo_1 @ ...] n:123 pts:12345 pts_time:12.345 ...
      for (const line of lines) {
        const match = line.match(/pts_time:(\d+\.?\d*)/);
        if (match) {
          const time = parseFloat(match[1]);
          if (time > lastTime + 0.5) {  // Minimum 0.5s between scenes
            // Close previous scene
            if (scenes.length > 0) {
              scenes[scenes.length - 1].endSeconds = time;
            }

            // Start new scene
            scenes.push({
              index: sceneIndex++,
              startSeconds: time,
              endSeconds: time,  // Will be updated
              frameIndex: Math.floor(time),  // Frame at 1fps
            });

            // Log progress every 10 scenes
            if (scenes.length % 10 === 0) {
              console.log(`[video-preprocessor] Scene detection: ${scenes.length} scenes detected so far (at ${time.toFixed(1)}s)`);
            }

            lastTime = time;
          }
        }

        const timeMatch = line.match(/time=(\d+:\d+:\d+\.?\d*)/);
        if (timeMatch) {
          const parsedSeconds = parseTimestampToSeconds(timeMatch[1]);
          if (parsedSeconds !== null) {
            reportProgress(parsedSeconds, timeMatch[1]);
          }
        }
      }
    });

    proc.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg scene detection failed with code ${code}: ${stderrTail}`));
        return;
      }

      // Get video duration for final scene
      try {
        const duration = await getVideoDuration(videoPath);

        // Add initial scene if none detected
        if (scenes.length === 0) {
          scenes.push({
            index: 0,
            startSeconds: 0,
            endSeconds: duration,
            frameIndex: 0,
          });
        } else {
          // Add first scene starting at 0
          scenes.unshift({
            index: -1,  // Will be reindexed
            startSeconds: 0,
            endSeconds: scenes[0].startSeconds,
            frameIndex: 0,
          });

          // Update final scene end time
          scenes[scenes.length - 1].endSeconds = duration;
        }

        // Reindex scenes
        scenes.forEach((s, i) => {
          s.index = i;
        });

        console.log(`[video-preprocessor] Detected ${scenes.length} scenes`);
        resolve(scenes);
      } catch (err) {
        reject(err);
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Analyze colors in a frame using sharp
 */
export async function analyzeFrameColors(framePath: string): Promise<{
  dominantColor: string;
  palette: string[];
  brightness: number;
}> {
  const image = sharp(framePath);

  // Resize for faster processing
  const resized = await image
    .resize(100, 100, { fit: 'cover' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data, info } = resized;
  const pixels = [];

  // Sample pixels
  for (let i = 0; i < data.length; i += 3) {
    pixels.push({
      r: data[i],
      g: data[i + 1],
      b: data[i + 2],
    });
  }

  // Calculate average brightness
  const brightness = pixels.reduce((sum, p) => {
    return sum + (0.299 * p.r + 0.587 * p.g + 0.114 * p.b) / 255;
  }, 0) / pixels.length;

  // Simple color quantization for palette
  const colorCounts = new Map<string, number>();

  for (const pixel of pixels) {
    // Quantize to 32 levels per channel
    const r = Math.round(pixel.r / 8) * 8;
    const g = Math.round(pixel.g / 8) * 8;
    const b = Math.round(pixel.b / 8) * 8;
    const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;

    colorCounts.set(hex, (colorCounts.get(hex) || 0) + 1);
  }

  // Sort by frequency
  const sortedColors = Array.from(colorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([color]) => color);

  return {
    dominantColor: sortedColors[0] || '#000000',
    palette: sortedColors.slice(0, 5),
    brightness,
  };
}

/**
 * Analyze colors for each scene
 */
export async function analyzeSceneColors(
  framePaths: string[],
  scenes: Scene[]
): Promise<ColorAnalysis[]> {
  console.log(`[video-preprocessor] Analyzing colors for ${scenes.length} scenes`);

  const results: ColorAnalysis[] = [];

  for (const scene of scenes) {
    const frameIndex = Math.min(scene.frameIndex, framePaths.length - 1);
    const framePath = framePaths[frameIndex];

    if (!framePath || !fs.existsSync(framePath)) {
      results.push({
        sceneIndex: scene.index,
        dominantColor: '#000000',
        palette: ['#000000'],
        brightness: 0.5,
      });
      continue;
    }

    try {
      const colors = await analyzeFrameColors(framePath);
      results.push({
        sceneIndex: scene.index,
        ...colors,
      });
    } catch (err) {
      console.warn(`[video-preprocessor] Color analysis failed for scene ${scene.index}:`, err);
      results.push({
        sceneIndex: scene.index,
        dominantColor: '#000000',
        palette: ['#000000'],
        brightness: 0.5,
      });
    }
  }

  return results;
}

/**
 * Upload frames to Supabase storage
 */
export async function uploadFramesToSupabase(
  videoId: string,
  framePaths: string[]
): Promise<string[]> {
  console.log(`[video-preprocessor] Uploading ${framePaths.length} frames to Supabase`);

  const supabase = getSupabase();
  const urls: string[] = [];

  // Upload in batches of 10 for efficiency
  const batchSize = 10;
  for (let i = 0; i < framePaths.length; i += batchSize) {
    const batch = framePaths.slice(i, i + batchSize);
    const uploadPromises = batch.map(async (framePath, idx) => {
      const frameIndex = i + idx;
      const storagePath = `${videoId}/frames/frame_${frameIndex.toString().padStart(4, '0')}.jpg`;

      const fileBuffer = fs.readFileSync(framePath);

      const { data, error } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(storagePath, fileBuffer, {
          contentType: 'image/jpeg',
          upsert: true,
        });

      if (error) {
        console.error(`[video-preprocessor] Frame upload failed:`, error);
        return null;
      }

      // Get public URL
      const { data: urlData } = supabase.storage
        .from(BUCKET_NAME)
        .getPublicUrl(storagePath);

      return urlData.publicUrl;
    });

    const batchUrls = await Promise.all(uploadPromises);
    urls.push(...batchUrls.filter((url): url is string => url !== null));
  }

  console.log(`[video-preprocessor] Uploaded ${urls.length} frames`);
  return urls;
}

/**
 * Upload audio to Supabase storage
 */
export async function uploadAudioToSupabase(
  videoId: string,
  audioPath: string
): Promise<string> {
  console.log(`[video-preprocessor] Uploading audio to Supabase`);

  const supabase = getSupabase();
  const storagePath = `${videoId}/audio.wav`;

  const fileBuffer = fs.readFileSync(audioPath);

  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(storagePath, fileBuffer, {
      contentType: 'audio/wav',
      upsert: true,
    });

  if (error) {
    throw new Error(`Audio upload failed: ${error.message}`);
  }

  const { data: urlData } = supabase.storage
    .from(BUCKET_NAME)
    .getPublicUrl(storagePath);

  return urlData.publicUrl;
}

/**
 * Main preprocessing function
 */
export async function preprocessVideo(
  videoId: string,
  videoUrl: string,
  options: {
    quality?: '720p' | '1080p';
    fps?: number;
    sceneThreshold?: number;
    uploadFrames?: boolean;
    onDownloadProgress?: (percent: number) => void;
    onProgress?: (status: string, percent: number, message?: string) => Promise<void>;
  } = {}
): Promise<PreprocessResult> {
  const {
    quality = '720p',
    fps = 1,
    sceneThreshold = 0.3,
    uploadFrames = true,
    onDownloadProgress,
    onProgress,
  } = options;

  console.log(`[video-preprocessor] Starting preprocessing for video: ${videoId}`);

  // Create temp directory for this video
  const tempDir = path.join(os.tmpdir(), 'videorag', videoId);
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const videoPath = path.join(tempDir, 'video.mp4');
  const audioPath = path.join(tempDir, 'audio.wav');
  const framesDir = path.join(tempDir, 'frames');

  try {
    // 1. Download video (5-40%)
    const { duration, tier } = await downloadVideo(videoUrl, videoPath, quality, onDownloadProgress);
    if (onProgress) await onProgress('extracting', 40, 'Starting frame extraction');

    // 2. Extract frames (40-45%)
    const framePaths = await extractFrames(videoPath, framesDir, fps, async (message, percent) => {
      if (onProgress) await onProgress('extracting', percent, message);
    });
    if (onProgress) await onProgress('extracting', 45, 'Frame extraction complete');

    // 3. Extract audio (45-46%)
    await extractAudio(videoPath, audioPath);
    if (onProgress) await onProgress('analyzing', 46);

    // 4. Detect scenes (46-48%)
    const scenes = await detectScenes(videoPath, sceneThreshold, {
      durationSeconds: duration,
      onProgress: async (percent, message) => {
        if (!onProgress) return;
        const overallPercent = Math.min(48, Math.max(46, Math.round(46 + (percent * 0.02))));
        await onProgress('analyzing', overallPercent, message);
      },
    });
    if (onProgress) await onProgress('analyzing', 48);

    // 5. Analyze colors (48-49%)
    const colors = await analyzeSceneColors(framePaths, scenes);
    if (onProgress) await onProgress('analyzing', 49);

    // 6. Upload frames to Supabase (49-50%)
    let frameUrls: string[] = [];
    if (uploadFrames) {
      frameUrls = await uploadFramesToSupabase(videoId, framePaths);
    }
    if (onProgress) await onProgress('analyzing', 50);

    console.log(`[video-preprocessor] Preprocessing complete for: ${videoId}`);

    return {
      videoId,
      videoPath,
      audioPath,
      framePaths,
      frameUrls,
      scenes,
      colors,
      duration,
      tier,
    };
  } catch (error) {
    // Clean up on failure
    console.error(`[video-preprocessor] Preprocessing failed:`, error);
    throw error;
  }
}

/**
 * Clean up temporary files after processing
 */
export function cleanupTempFiles(videoId: string): void {
  const tempDir = path.join(os.tmpdir(), 'videorag', videoId);
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`[video-preprocessor] Cleaned up temp files for: ${videoId}`);
  }
}
