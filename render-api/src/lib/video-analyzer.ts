/**
 * Video Analyzer - Analyze raw videos for editing
 * Simplified version for edit decision generation
 */

import { downloadVideo, detectScenes, extractAudio } from './video-preprocessor';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { randomUUID } from 'crypto';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
});

export interface VideoAnalysisResult {
  duration: number;
  scenes: SceneInfo[];
  transcript: TranscriptSegment[];
  keyMoments: KeyMoment[];
  audioBeats: number[];
}

export interface SceneInfo {
  start: number;
  end: number;
  description: string;
}

export interface TranscriptSegment {
  text: string;
  start: number;
  end: number;
}

export interface KeyMoment {
  timestamp: number;
  type: 'hook' | 'highlight' | 'cta' | 'transition' | 'emphasis';
  description?: string;
}

/**
 * Analyze a raw video for editing
 */
export async function analyzeRawVideo(
  videoUrl: string,
  onProgress?: (progress: number, message: string) => void
): Promise<VideoAnalysisResult> {
  const tempDir = path.join(os.tmpdir(), `video-analyze-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // Step 1: Download video (0-30%)
    onProgress?.(0, 'Downloading video...');
    const videoPath = path.join(tempDir, 'video.mp4');
    const { duration } = await downloadVideo(videoUrl, videoPath, '720p', (percent) => {
      onProgress?.(percent * 0.3, `Downloading... ${percent.toFixed(0)}%`);
    });

    // Step 2: Scene detection (30-50%)
    onProgress?.(30, 'Detecting scenes...');
    const scenes = await detectScenes(videoPath);
    const sceneInfo: SceneInfo[] = scenes.map((scene, i) => ({
      start: scene.startSeconds,
      end: scene.endSeconds,
      description: `Scene ${i + 1}`,
    }));
    onProgress?.(50, `Detected ${scenes.length} scenes`);

    // Step 3: Extract audio for transcription (50-60%)
    onProgress?.(50, 'Extracting audio...');
    const audioPath = path.join(tempDir, 'audio.wav');
    await extractAudio(videoPath, audioPath);
    onProgress?.(60, 'Audio extracted');

    // Step 4: Transcribe with Whisper (60-90%)
    onProgress?.(60, 'Transcribing audio...');
    const transcript = await transcribeAudio(audioPath, (percent) => {
      onProgress?.(60 + percent * 0.3, 'Transcribing...');
    });
    onProgress?.(90, 'Transcription complete');

    // Step 5: Detect key moments (90-100%)
    onProgress?.(90, 'Identifying key moments...');
    const keyMoments = identifyKeyMoments(transcript, duration);
    onProgress?.(100, 'Analysis complete');

    return {
      duration,
      scenes: sceneInfo,
      transcript,
      keyMoments,
      audioBeats: [], // TODO: Audio beat detection
    };
  } finally {
    // Cleanup
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.error('Failed to cleanup temp directory:', error);
    }
  }
}

/**
 * Transcribe audio using OpenAI Whisper
 */
async function transcribeAudio(
  audioPath: string,
  onProgress?: (percent: number) => void
): Promise<TranscriptSegment[]> {
  onProgress?.(0);

  try {
    const audioStream = fs.createReadStream(audioPath);

    const response = await openai.audio.transcriptions.create({
      file: audioStream,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });

    onProgress?.(100);

    // Convert Whisper segments to our format
    const segments: TranscriptSegment[] = [];
    if ('segments' in response && Array.isArray(response.segments)) {
      for (const segment of response.segments) {
        segments.push({
          text: segment.text.trim(),
          start: segment.start,
          end: segment.end,
        });
      }
    }

    return segments;
  } catch (error: any) {
    console.error('Whisper transcription failed:', error);
    // Return empty transcript on failure
    return [];
  }
}

/**
 * Identify key moments from transcript
 */
function identifyKeyMoments(
  transcript: TranscriptSegment[],
  duration: number
): KeyMoment[] {
  const moments: KeyMoment[] = [];

  // Hook: First 5 seconds
  if (transcript.length > 0 && transcript[0].start < 5) {
    moments.push({
      timestamp: 2,
      type: 'hook',
      description: 'Video opening',
    });
  }

  // Highlights: Detect question words or emphasis
  const emphasisWords = ['important', 'key', 'critical', 'amazing', 'incredible'];
  const questionWords = ['what', 'why', 'how', 'when', 'where'];

  transcript.forEach((segment) => {
    const lowerText = segment.text.toLowerCase();

    // Check for emphasis
    if (emphasisWords.some((word) => lowerText.includes(word))) {
      moments.push({
        timestamp: segment.start,
        type: 'emphasis',
        description: segment.text.substring(0, 50),
      });
    }

    // Check for questions
    if (questionWords.some((word) => lowerText.startsWith(word))) {
      moments.push({
        timestamp: segment.start,
        type: 'highlight',
        description: segment.text.substring(0, 50),
      });
    }
  });

  // CTA: Last 10 seconds
  if (duration > 10) {
    moments.push({
      timestamp: duration - 5,
      type: 'cta',
      description: 'Call to action',
    });
  }

  return moments;
}
