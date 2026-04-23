/**
 * Direct YouTube video download using InnerTube API
 * No yt-dlp, no proxy (for most videos)
 * Designed to minimize proxy bandwidth usage
 */

import fs from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { ReadableStream as WebReadableStream } from 'stream/web';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

// Set ffmpeg paths
if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);
if (ffprobeStatic?.path) ffmpeg.setFfprobePath(ffprobeStatic.path);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': '*/*',
};

interface StreamFormat {
  url: string;
  itag: number;
  mimeType: string;
  quality: string;
  qualityLabel?: string;
  bitrate: number;
  contentLength?: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

interface PlayerResponse {
  streamingData?: {
    formats?: StreamFormat[];
    adaptiveFormats?: StreamFormat[];
  };
  videoDetails?: {
    videoId: string;
    title: string;
    lengthSeconds: string;
  };
}

/**
 * Extract video ID from URL or return as-is if already an ID
 */
function extractVideoId(input: string): string {
  // Already a video ID
  if (input.length === 11 && !input.includes('/') && !input.includes('.')) {
    return input;
  }

  // Extract from various URL formats
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) return match[1];
  }

  throw new Error(`Could not extract video ID from: ${input}`);
}

/**
 * Get video stream URLs from InnerTube player endpoint
 */
async function getVideoStreamUrls(videoId: string): Promise<{ videoUrl: string; audioUrl: string; duration: number }> {
  console.log(`[youtube-direct-download] Fetching stream URLs for: ${videoId}`);

  const url = 'https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

  const body = {
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20240101',
      },
    },
    videoId,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...HEADERS,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  clearTimeout(timeout);

  if (!response.ok) {
    throw new Error(`Player endpoint failed: ${response.status}`);
  }

  const data = await response.json() as PlayerResponse;

  if (!data.streamingData) {
    throw new Error('No streaming data available (video may be unavailable or age-restricted)');
  }

  const formats = [
    ...(data.streamingData.formats || []),
    ...(data.streamingData.adaptiveFormats || []),
  ];

  // Find best video stream (prefer 480p for faster downloads, sufficient for analysis)
  const videoFormats = formats
    .filter(f => f.hasVideo && f.url)
    .sort((a, b) => {
      // Prefer 480p or closest
      const aIs480 = a.qualityLabel === '480p';
      const bIs480 = b.qualityLabel === '480p';
      if (aIs480 && !bIs480) return -1;
      if (!aIs480 && bIs480) return 1;
      return (b.bitrate || 0) - (a.bitrate || 0);
    });

  // Find best audio stream
  const audioFormats = formats
    .filter(f => f.hasAudio && !f.hasVideo && f.url)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  if (videoFormats.length === 0) {
    throw new Error('No video stream found');
  }

  if (audioFormats.length === 0) {
    throw new Error('No audio stream found');
  }

  const videoFormat = videoFormats[0];
  const audioFormat = audioFormats[0];

  const duration = parseInt(data.videoDetails?.lengthSeconds || '0', 10);

  console.log(`[youtube-direct-download] Video: ${videoFormat.qualityLabel || videoFormat.quality}, Audio: ${audioFormat.bitrate}bps, Duration: ${duration}s`);

  return {
    videoUrl: videoFormat.url,
    audioUrl: audioFormat.url,
    duration,
  };
}

/**
 * Download a stream to a file with progress tracking
 */
async function downloadStream(
  streamUrl: string,
  outputPath: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  const response = await fetch(streamUrl, {
    headers: HEADERS,
    signal: controller.signal,
  });

  clearTimeout(timeout);

  if (!response.ok) {
    throw new Error(`Stream download failed: ${response.status}`);
  }

  const totalBytes = parseInt(response.headers.get('content-length') || '0', 10);
  let downloadedBytes = 0;

  if (!response.body) {
    throw new Error('No response body to download');
  }

  const fileStream = fs.createWriteStream(outputPath);
  const nodeStream = Readable.fromWeb(response.body as unknown as WebReadableStream);

  // Track progress
  if (onProgress && totalBytes > 0) {
    nodeStream.on('data', (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      const percent = (downloadedBytes / totalBytes) * 100;
      onProgress(percent);
    });
  }

  await pipeline(nodeStream, fileStream);
  console.log(`[youtube-direct-download] Downloaded: ${outputPath} (${(downloadedBytes / 1024 / 1024).toFixed(1)} MB)`);
}

/**
 * Merge video and audio streams using ffmpeg
 */
async function mergeStreams(
  videoPath: string,
  audioPath: string,
  outputPath: string
): Promise<void> {
  console.log(`[youtube-direct-download] Merging streams to: ${outputPath}`);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-c:v copy',     // Copy video codec (no re-encode)
        '-c:a aac',      // Re-encode audio to AAC
        '-strict -2',    // Allow experimental AAC encoder
      ])
      .output(outputPath)
      .on('end', () => {
        console.log(`[youtube-direct-download] Merge complete`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`[youtube-direct-download] Merge error:`, err);
        reject(err);
      })
      .run();
  });
}

/**
 * Get video duration using ffprobe
 */
async function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata.format.duration || 0;
      resolve(duration);
    });
  });
}

/**
 * Main entry point - download video directly via InnerTube
 */
export async function downloadVideoDirectly(
  videoUrlOrId: string,
  outputPath: string,
  onProgress?: (percent: number) => void
): Promise<{ duration: number }> {
  const videoId = extractVideoId(videoUrlOrId);

  // Get stream URLs
  const { videoUrl, audioUrl, duration } = await getVideoStreamUrls(videoId);

  // Temp paths for video and audio
  const videoTempPath = outputPath.replace('.mp4', '_video.mp4');
  const audioTempPath = outputPath.replace('.mp4', '_audio.m4a');

  try {
    // Download video stream (0-60% progress)
    console.log(`[youtube-direct-download] Downloading video stream...`);
    await downloadStream(videoUrl, videoTempPath, (percent) => {
      if (onProgress) onProgress(percent * 0.6);
    });

    // Download audio stream (60-90% progress)
    console.log(`[youtube-direct-download] Downloading audio stream...`);
    await downloadStream(audioUrl, audioTempPath, (percent) => {
      if (onProgress) onProgress(60 + percent * 0.3);
    });

    // Merge streams (90-100% progress)
    if (onProgress) onProgress(90);
    await mergeStreams(videoTempPath, audioTempPath, outputPath);
    if (onProgress) onProgress(100);

    console.log(`[youtube-direct-download] Download complete: ${outputPath}`);

    return { duration };
  } finally {
    // Cleanup temp files
    try {
      if (fs.existsSync(videoTempPath)) fs.unlinkSync(videoTempPath);
      if (fs.existsSync(audioTempPath)) fs.unlinkSync(audioTempPath);
    } catch (cleanupErr) {
      console.warn(`[youtube-direct-download] Cleanup warning:`, cleanupErr);
    }
  }
}
