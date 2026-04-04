import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import crypto from 'crypto';
import { saveCost } from '../lib/cost-tracker';
import { Readable } from 'stream';
import { ReadableStream as WebReadableStream } from 'stream/web';
import { compareScriptToTranscription, compareAudioSegmentsToSRT, parseSrtToSegments, QAResult, AudioSegment, SrtSegment } from '../utils/script-qa';
import { getSupabaseClient } from '../lib/supabase-project';

const router = Router();

// WAV file constants
const SAMPLE_RATE = 44100;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const BYTES_PER_SECOND = SAMPLE_RATE * NUM_CHANNELS * BYTES_PER_SAMPLE;

// Whisper API has 25MB limit, we'll use 20MB chunks to be safe
const MAX_CHUNK_BYTES = 20 * 1024 * 1024;
const MAX_CHUNK_DURATION = Math.floor(MAX_CHUNK_BYTES / BYTES_PER_SECOND); // ~227 seconds

// Format time for SRT (HH:MM:SS,mmm)
function formatSrtTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

// Split segment text into smaller chunks with 5-7 words max, 3 words min per line
function splitSegmentIntoChunks(segment: { text: string; start: number; end: number }): { text: string; start: number; end: number }[] {
  const words = segment.text.split(/\s+/).filter(w => w.length > 0);
  const maxWords = 6; // Target 5-7 words, using 6 as sweet spot
  const minWords = 3;

  // If segment is already within limits, return as-is
  if (words.length <= maxWords && words.length >= minWords) {
    return [segment];
  }

  // If too few words, return as-is (can't split further)
  if (words.length < minWords) {
    return [segment];
  }

  const chunks: { text: string; start: number; end: number }[] = [];
  const totalDuration = segment.end - segment.start;
  const durationPerWord = totalDuration / words.length;

  let i = 0;
  while (i < words.length) {
    const remaining = words.length - i;

    // Determine chunk size: aim for 5-6 words, but ensure last chunk has at least 3
    let chunkSize = maxWords;

    // If remaining words would leave a too-small last chunk, adjust
    if (remaining > maxWords && remaining < maxWords + minWords) {
      // Split evenly to avoid small last chunk
      chunkSize = Math.ceil(remaining / 2);
    } else if (remaining <= maxWords) {
      // Take all remaining
      chunkSize = remaining;
    }

    // Ensure minimum chunk size
    chunkSize = Math.max(chunkSize, Math.min(minWords, remaining));

    const chunkWords = words.slice(i, i + chunkSize);
    chunks.push({
      text: chunkWords.join(' '),
      start: segment.start + (i * durationPerWord),
      end: segment.start + ((i + chunkSize) * durationPerWord),
    });

    i += chunkSize;
  }

  return chunks;
}

// Audio format parameters (will be set from actual WAV file)
interface AudioFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

// Create a WAV header for a chunk of PCM data with actual audio parameters
function createWavHeader(dataSize: number, format: AudioFormat): Uint8Array {
  const { sampleRate, channels, bitsPerSample } = format;
  const bytesPerSample = bitsPerSample / 8;
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;

  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  // "RIFF" chunk descriptor
  view.setUint8(0, 0x52); // R
  view.setUint8(1, 0x49); // I
  view.setUint8(2, 0x46); // F
  view.setUint8(3, 0x46); // F
  view.setUint32(4, 36 + dataSize, true); // File size - 8
  view.setUint8(8, 0x57);  // W
  view.setUint8(9, 0x41);  // A
  view.setUint8(10, 0x56); // V
  view.setUint8(11, 0x45); // E

  // "fmt " sub-chunk
  view.setUint8(12, 0x66); // f
  view.setUint8(13, 0x6d); // m
  view.setUint8(14, 0x74); // t
  view.setUint8(15, 0x20); // (space)
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true);  // AudioFormat (1 for PCM)
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true); // ByteRate
  view.setUint16(32, blockAlign, true); // BlockAlign
  view.setUint16(34, bitsPerSample, true);

  // "data" sub-chunk
  view.setUint8(36, 0x64); // d
  view.setUint8(37, 0x61); // a
  view.setUint8(38, 0x74); // t
  view.setUint8(39, 0x61); // a
  view.setUint32(40, dataSize, true);

  return new Uint8Array(header);
}

// Find a chunk in WAV data by its fourcc identifier
function findWavChunk(wavData: Uint8Array, fourcc: string): number {
  const needle = new TextEncoder().encode(fourcc);
  for (let i = 0; i <= wavData.length - 4; i++) {
    if (wavData[i] === needle[0] && wavData[i+1] === needle[1] &&
        wavData[i+2] === needle[2] && wavData[i+3] === needle[3]) {
      return i;
    }
  }
  return -1;
}

// Extract PCM data from WAV file by finding the actual 'data' chunk
function extractPcmFromWav(wavData: Uint8Array): { pcmData: Uint8Array; sampleRate: number; channels: number; bitsPerSample: number } {
  // Find fmt chunk to get audio parameters
  const fmtIdx = findWavChunk(wavData, 'fmt ');
  if (fmtIdx === -1) {
    console.warn('No fmt chunk found, using defaults');
    // Fallback to old behavior
    return {
      pcmData: wavData.slice(44),
      sampleRate: SAMPLE_RATE,
      channels: NUM_CHANNELS,
      bitsPerSample: BITS_PER_SAMPLE
    };
  }

  // Parse fmt chunk (starts 8 bytes after 'fmt ')
  const fmtDataStart = fmtIdx + 8;
  const view = new DataView(wavData.buffer, wavData.byteOffset, wavData.byteLength);
  const channels = view.getUint16(fmtDataStart + 2, true);
  const sampleRate = view.getUint32(fmtDataStart + 4, true);
  const bitsPerSample = view.getUint16(fmtDataStart + 14, true);

  // Find data chunk
  const dataIdx = findWavChunk(wavData, 'data');
  if (dataIdx === -1) {
    console.warn('No data chunk found, using offset 44');
    return {
      pcmData: wavData.slice(44),
      sampleRate,
      channels,
      bitsPerSample
    };
  }

  // Read data chunk size and extract PCM
  const dataSize = view.getUint32(dataIdx + 4, true);
  const dataStart = dataIdx + 8;
  const dataEnd = Math.min(wavData.length, dataStart + dataSize);

  console.log(`WAV parsing: fmt@${fmtIdx}, data@${dataIdx}, dataSize=${dataSize}, actual=${dataEnd - dataStart}`);
  console.log(`WAV format: ${sampleRate}Hz, ${channels}ch, ${bitsPerSample}bit`);

  return {
    pcmData: wavData.slice(dataStart, dataEnd),
    sampleRate,
    channels,
    bitsPerSample
  };
}

// Create a WAV file from PCM data with correct format
function createWavFromPcm(pcmData: Uint8Array, format: AudioFormat): Uint8Array {
  const header = createWavHeader(pcmData.length, format);
  const wavData = new Uint8Array(header.length + pcmData.length);
  wavData.set(header, 0);
  wavData.set(pcmData, header.length);
  return wavData;
}

// Download a file to a temp location using streams (memory efficient)
async function downloadToTempFile(url: string, onProgress?: (percent: number) => void): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }

  const contentLength = response.headers.get('content-length');
  const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

  const tempDir = os.tmpdir();
  const tempFile = path.join(tempDir, `audio-${Date.now()}.wav`);
  const writeStream = fs.createWriteStream(tempFile);

  let downloadedBytes = 0;
  let lastProgressPercent = 0;

  return new Promise((resolve, reject) => {
    if (!response.body) {
      reject(new Error('No response body'));
      return;
    }

    const nodeStream = Readable.fromWeb(response.body as unknown as WebReadableStream);

    nodeStream.on('data', (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      writeStream.write(chunk);

      if (totalBytes > 0 && onProgress) {
        const percent = Math.floor((downloadedBytes / totalBytes) * 100);
        if (percent > lastProgressPercent) {
          lastProgressPercent = percent;
          onProgress(percent);
        }
      }
    });

    nodeStream.on('end', () => {
      writeStream.end();
    });

    nodeStream.on('error', (err: Error) => {
      writeStream.end();
      fs.unlinkSync(tempFile);
      reject(err);
    });

    // Wait for write stream to fully flush to disk before resolving
    writeStream.on('finish', () => {
      console.log(`Downloaded ${downloadedBytes} bytes to ${tempFile}`);
      resolve(tempFile);
    });

    writeStream.on('error', (err: Error) => {
      fs.unlinkSync(tempFile);
      reject(err);
    });
  });
}

// Parse WAV header from file to get audio format info
function parseWavHeaderFromFile(filePath: string): { format: AudioFormat; dataOffset: number; dataSize: number } {
  const fd = fs.openSync(filePath, 'r');
  try {
    // Read first 1KB to find headers (should be plenty)
    const headerBuffer = Buffer.alloc(1024);
    fs.readSync(fd, headerBuffer, 0, 1024, 0);

    // Find fmt chunk
    let fmtIdx = -1;
    for (let i = 0; i <= headerBuffer.length - 4; i++) {
      if (headerBuffer.toString('ascii', i, i + 4) === 'fmt ') {
        fmtIdx = i;
        break;
      }
    }

    if (fmtIdx === -1) {
      console.warn('No fmt chunk found, using defaults');
      return {
        format: { sampleRate: SAMPLE_RATE, channels: NUM_CHANNELS, bitsPerSample: BITS_PER_SAMPLE },
        dataOffset: 44,
        dataSize: fs.statSync(filePath).size - 44
      };
    }

    // Parse fmt chunk
    const channels = headerBuffer.readUInt16LE(fmtIdx + 10);
    const sampleRate = headerBuffer.readUInt32LE(fmtIdx + 12);
    const bitsPerSample = headerBuffer.readUInt16LE(fmtIdx + 22);

    // Find data chunk
    let dataIdx = -1;
    for (let i = 0; i <= headerBuffer.length - 4; i++) {
      if (headerBuffer.toString('ascii', i, i + 4) === 'data') {
        dataIdx = i;
        break;
      }
    }

    if (dataIdx === -1) {
      console.warn('No data chunk found in header, using offset 44');
      return {
        format: { sampleRate, channels, bitsPerSample },
        dataOffset: 44,
        dataSize: fs.statSync(filePath).size - 44
      };
    }

    const dataSize = headerBuffer.readUInt32LE(dataIdx + 4);
    const dataOffset = dataIdx + 8;

    console.log(`WAV from file: fmt@${fmtIdx}, data@${dataIdx}, dataSize=${dataSize}`);
    console.log(`WAV format: ${sampleRate}Hz, ${channels}ch, ${bitsPerSample}bit`);

    return {
      format: { sampleRate, channels, bitsPerSample },
      dataOffset,
      dataSize
    };
  } finally {
    fs.closeSync(fd);
  }
}

// Read a PCM chunk from file at specific byte offset
function readPcmChunkFromFile(filePath: string, dataOffset: number, startByte: number, endByte: number): Buffer {
  const chunkSize = endByte - startByte;
  const buffer = Buffer.alloc(chunkSize);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, chunkSize, dataOffset + startByte);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

// Create a WAV buffer from PCM buffer with correct format
function createWavBufferFromPcm(pcmData: Buffer, format: AudioFormat): Buffer {
  const header = createWavHeader(pcmData.length, format);
  return Buffer.concat([Buffer.from(header), pcmData]);
}

// Quality issue from Whisper
interface QualityIssue {
  segmentIndex: number;
  chunkIndex: number;
  start: number;
  end: number;
  text: string;
  issue: 'silence' | 'garbled' | 'repetitive';
  value: number;
}

// Transcribe a single audio chunk with retry logic (using Groq Whisper)
async function transcribeChunk(audioData: Uint8Array | Buffer, groqApiKey: string, chunkIndex: number): Promise<{ chunkIndex: number; segments: Array<{ text: string; start: number; end: number }>; duration: number; qualityIssues: QualityIssue[] }> {
  const MAX_RETRIES = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const formData = new FormData();
      const audioBlob = new Blob([new Uint8Array(audioData)], { type: 'audio/wav' });
      formData.append('file', audioBlob, 'audio.wav');
      formData.append('model', 'whisper-large-v3-turbo'); // Groq's fastest Whisper model
      formData.append('response_format', 'verbose_json');
      formData.append('language', 'en'); // Speed optimization: skip language detection
      // Note: verbose_json returns segments by default, timestamp_granularities not needed

      console.log(`Transcribing chunk ${chunkIndex + 1}, size: ${audioData.length} bytes${attempt > 1 ? ` (attempt ${attempt})` : ''}`);

      const whisperResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqApiKey}`,
        },
        body: formData,
      });

      if (!whisperResponse.ok) {
        const errorText = await whisperResponse.text();
        console.error('Groq Whisper API error:', whisperResponse.status, errorText);

        // Handle rate limiting (429) with retry
        if (whisperResponse.status === 429) {
          const retryMatch = errorText.match(/try again in (\d+)m?(\d*)s?/i);
          let waitTime = 60000;
          if (retryMatch) {
            const minutes = parseInt(retryMatch[1]) || 0;
            const seconds = parseInt(retryMatch[2]) || 0;
            waitTime = (minutes * 60 + seconds) * 1000 + 5000;
          }
          console.log(`Rate limited, waiting ${waitTime/1000}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }

        // Handle server errors (500+) with retry
        if (whisperResponse.status >= 500 && attempt < MAX_RETRIES) {
          const waitTime = attempt * 5000;
          console.log(`Server error ${whisperResponse.status}, retrying in ${waitTime/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }

        throw new Error(`Groq Whisper API error: ${whisperResponse.status}`);
      }

      const result = await whisperResponse.json() as any;
      console.log(`Chunk ${chunkIndex + 1} transcribed:`, {
        duration: result.duration,
        segmentCount: result.segments?.length || 0,
        hasText: !!result.text,
        keys: Object.keys(result)
      });

      // Extract quality issues from Whisper verbose_json response
      // NOTE: Stricter thresholds to catch garbled audio that sounds bad
      const qualityIssues: QualityIssue[] = [];
      if (result.segments) {
        result.segments.forEach((seg: any, idx: number) => {
          // Check for likely silence/noise (high no_speech_prob)
          // Lowered from 0.8 to 0.5 - be more sensitive
          if (seg.no_speech_prob > 0.5) {
            qualityIssues.push({
              segmentIndex: idx,
              chunkIndex,
              start: seg.start,
              end: seg.end,
              text: seg.text?.substring(0, 50) || '',
              issue: 'silence',
              value: seg.no_speech_prob,
            });
          }
          // Check for garbled/unclear speech
          // STRICTER: raised from -1.0 to -0.7 (good speech is around -0.3 to -0.5)
          if (seg.avg_logprob < -0.7) {
            qualityIssues.push({
              segmentIndex: idx,
              chunkIndex,
              start: seg.start,
              end: seg.end,
              text: seg.text?.substring(0, 50) || '',
              issue: 'garbled',
              value: seg.avg_logprob,
            });
          }
          // Check for repetitive/hallucinated content
          // Lowered from 2.4 to 2.0 - be more sensitive
          if (seg.compression_ratio > 2.0) {
            qualityIssues.push({
              segmentIndex: idx,
              chunkIndex,
              start: seg.start,
              end: seg.end,
              text: seg.text?.substring(0, 50) || '',
              issue: 'repetitive',
              value: seg.compression_ratio,
            });
          }
        });
      }

      if (qualityIssues.length > 0) {
        console.log(`Chunk ${chunkIndex + 1}: ${qualityIssues.length} quality issues detected`);
      }

      return {
        chunkIndex,
        segments: result.segments || [],
        duration: result.duration || 0,
        qualityIssues,
      };
    } catch (error: any) {
      lastError = error;
      const isRetryable = error.code === 'ECONNRESET' ||
                          error.code === 'ETIMEDOUT' ||
                          error.message?.includes('socket hang up') ||
                          error.message?.includes('network');

      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // 1s, 2s, 4s... max 10s
        console.log(`Chunk ${chunkIndex + 1} failed (${error.code || error.message}), retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }

  throw lastError || new Error('Transcription failed after retries');
}

router.post('/', async (req: Request, res: Response) => {
  const { audioUrl, projectId, stream } = req.body;

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

    // Send keepalive every 15 seconds to prevent connection timeout
    heartbeatInterval = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);
  }

  const sendEvent = (data: any) => {
    if (stream) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  // Cleanup function to clear heartbeat
  const cleanup = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  };

  try {
    if (!audioUrl) {
      const error = { error: 'Audio URL is required' };
      if (stream) {
        sendEvent({ type: 'error', ...error });
        cleanup();
        return res.end();
      }
      return res.status(400).json(error);
    }

    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      const error = { error: 'GROQ_API_KEY is not configured' };
      if (stream) {
        sendEvent({ type: 'error', ...error });
        cleanup();
        return res.end();
      }
      return res.status(500).json(error);
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      const error = { error: 'Supabase credentials not configured' };
      if (stream) {
        sendEvent({ type: 'error', ...error });
        cleanup();
        return res.end();
      }
      return res.status(500).json(error);
    }

    console.log('Fetching audio from:', audioUrl);

    // Send downloading progress
    sendEvent({
      type: 'progress',
      progress: 1,
      message: '1%'
    });

    // Download the audio file to temp file (memory efficient streaming)
    let tempFilePath: string | null = null;
    try {
      tempFilePath = await downloadToTempFile(audioUrl, (percent) => {
        // Map download progress to 1-3%
        const mappedProgress = 1 + Math.floor(percent * 0.02);
        sendEvent({
          type: 'progress',
          progress: mappedProgress,
          message: `${mappedProgress}%`
        });
      });
    } catch (downloadError) {
      throw new Error(`Failed to download audio: ${downloadError instanceof Error ? downloadError.message : 'Unknown error'}`);
    }

    // Send download complete message
    sendEvent({
      type: 'progress',
      progress: 3,
      message: '3%'
    });

    const fileStats = fs.statSync(tempFilePath);
    console.log('Audio file size:', fileStats.size, 'bytes');

    sendEvent({
      type: 'progress',
      progress: 4,
      message: '4%'
    });

    // Parse WAV header from file (only reads 1KB, not the whole file)
    const { format: audioFormat, dataOffset, dataSize } = parseWavHeaderFromFile(tempFilePath);
    const bytesPerSecond = audioFormat.sampleRate * audioFormat.channels * (audioFormat.bitsPerSample / 8);
    const totalDuration = dataSize / bytesPerSecond;
    console.log('Total audio duration:', totalDuration.toFixed(2), 's');

    // Calculate chunk size in bytes using actual audio parameters
    const maxChunkDuration = Math.floor(MAX_CHUNK_BYTES / bytesPerSecond);
    const chunkSizeBytes = maxChunkDuration * bytesPerSecond;
    const numChunks = Math.ceil(dataSize / chunkSizeBytes);
    console.log(`Splitting into ${numChunks} chunks of ~${maxChunkDuration}s each`);

    // Process each chunk and collect segments
    const allSegments: Array<{ text: string; start: number; end: number }> = [];

    // Send initial progress
    sendEvent({
      type: 'progress',
      progress: 5,
      message: '5%'
    });
    console.log(`Starting transcription: ${numChunks} chunks (processing sequentially, reading from disk)`);

    // Process chunks sequentially, reading each chunk from disk (minimal memory usage)
    const chunkResults: { chunkIndex: number; segments: Array<{ text: string; start: number; end: number }>; duration: number; qualityIssues: QualityIssue[] }[] = [];
    const allQualityIssues: QualityIssue[] = [];

    for (let i = 0; i < numChunks; i++) {
      const currentProgress = 5 + Math.round((i / numChunks) * 85);
      sendEvent({
        type: 'progress',
        progress: currentProgress,
        message: `${currentProgress}%`
      });

      // Read chunk directly from file (only one chunk in memory at a time)
      const startByte = i * chunkSizeBytes;
      const endByte = Math.min((i + 1) * chunkSizeBytes, dataSize);
      const chunkPcm = readPcmChunkFromFile(tempFilePath, dataOffset, startByte, endByte);
      const chunkWav = createWavBufferFromPcm(chunkPcm, audioFormat);

      // Transcribe this chunk
      const result = await transcribeChunk(chunkWav, groqApiKey, i);
      chunkResults.push(result);

      // Collect quality issues (adjust timestamps with chunk offset later)
      if (result.qualityIssues.length > 0) {
        allQualityIssues.push(...result.qualityIssues);
      }

      const newProgress = 5 + Math.round(((i + 1) / numChunks) * 85);
      sendEvent({
        type: 'progress',
        progress: newProgress,
        message: `${newProgress}%`
      });
    }

    // Clean up temp file
    try {
      fs.unlinkSync(tempFilePath);
      console.log('Cleaned up temp file:', tempFilePath);
    } catch (cleanupErr) {
      console.warn('Failed to clean up temp file:', cleanupErr);
    }

    // Sort results by chunk index and merge with proper time offsets
    chunkResults.sort((a, b) => a.chunkIndex - b.chunkIndex);

    let timeOffset = 0;
    for (const result of chunkResults) {
      for (const seg of result.segments) {
        allSegments.push({
          text: seg.text.trim(),
          start: seg.start + timeOffset,
          end: seg.end + timeOffset,
        });
      }
      timeOffset += result.duration;
    }

    console.log('Total segments from all chunks:', allSegments.length);

    // Split segments into smaller chunks for captions (5-7 words max, 3 min)
    const allChunks: { text: string; start: number; end: number }[] = [];
    for (const seg of allSegments) {
      const chunks = splitSegmentIntoChunks(seg);
      allChunks.push(...chunks);
    }
    console.log('Generated', allChunks.length, 'caption segments');

    // Generate SRT content
    let srtContent = '';
    allChunks.forEach((segment: { text: string; start: number; end: number }, index: number) => {
      srtContent += `${index + 1}\n`;
      srtContent += `${formatSrtTime(segment.start)} --> ${formatSrtTime(segment.end)}\n`;
      srtContent += `${segment.text}\n\n`;
    });

    // Upload to Supabase Storage
    const supabase = createClient(supabaseUrl, supabaseKey);

    const fileName = `${projectId || crypto.randomUUID()}/captions.srt`;

    const { error: uploadError } = await supabase.storage
      .from('generated-assets')
      .upload(fileName, Buffer.from(srtContent), {
        contentType: 'text/plain',
        upsert: true,
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      if (stream) {
        sendEvent({ type: 'error', error: 'Failed to upload captions file' });
        cleanup();
        return res.end();
      }
      return res.status(500).json({ error: 'Failed to upload captions file' });
    }

    const { data: urlData } = supabase.storage
      .from('generated-assets')
      .getPublicUrl(fileName);

    console.log('Captions uploaded successfully:', urlData.publicUrl);

    // Save cost to Supabase (Whisper: $0.006/minute of audio input)
    if (projectId && totalDuration > 0) {
      const durationMinutes = totalDuration / 60;
      saveCost({
        projectId,
        source: 'manual',
        step: 'captions',
        service: 'whisper',
        units: durationMinutes,
        unitType: 'minutes',
      }).catch(err => console.error('[cost-tracker] Failed to save captions cost:', err));
    }

    // Log quality issues summary
    if (allQualityIssues.length > 0) {
      console.log(`[Captions] ${allQualityIssues.length} quality issues detected:`,
        allQualityIssues.reduce((acc, q) => {
          acc[q.issue] = (acc[q.issue] || 0) + 1;
          return acc;
        }, {} as Record<string, number>)
      );
    }

    // Script QA: Compare transcription to original script
    let scriptQa: QAResult | undefined;
    if (projectId) {
      try {
        // Fetch original script from database
        const { data: project } = await supabase
          .from('generation_projects')
          .select('script_content')
          .eq('id', projectId)
          .single();

        if (project?.script_content) {
          // Combine all transcription segments into full text
          const fullTranscription = allSegments.map(s => s.text).join(' ');

          // Run QA comparison
          scriptQa = compareScriptToTranscription(project.script_content, fullTranscription);

          console.log(`[Captions] Script QA: ${scriptQa.score}% match (${scriptQa.matchedSentences}/${scriptQa.totalScriptSentences} sentences)`);
          if (scriptQa.issues.length > 0) {
            console.log(`[Captions] Script QA sentence issues:`, scriptQa.issues.slice(0, 5));
          }
          if (scriptQa.wordIssues && scriptQa.wordIssues.length > 0) {
            console.log(`[Captions] Script QA word issues (${scriptQa.wordIssues.length}):`, scriptQa.wordIssues.slice(0, 10));
            // Log clipped words specifically as they indicate TTS quality problems
            const clippedWords = scriptQa.wordIssues.filter(i => i.type === 'clipped_word');
            if (clippedWords.length > 0) {
              console.warn(`[Captions] ⚠️ CLIPPED WORDS DETECTED: ${clippedWords.map(w => `"${w.transcribedWord}" should be "${w.scriptWord}"`).join(', ')}`);
            }
          }
        }
      } catch (qaErr) {
        console.error('[Captions] Script QA error (non-fatal):', qaErr);
      }
    }

    const result = {
      success: true,
      captionsUrl: urlData.publicUrl,
      srtContent,
      segmentCount: allChunks.length,
      audioDuration: totalDuration,
      // Include quality issues if any were found
      qualityIssues: allQualityIssues.length > 0 ? allQualityIssues : undefined,
      qualityWarning: allQualityIssues.length > 0
        ? `${allQualityIssues.length} potential audio quality issue${allQualityIssues.length > 1 ? 's' : ''} detected`
        : undefined,
      // Script QA results
      scriptQa,
    };

    if (stream) {
      sendEvent({
        type: 'complete',
        ...result
      });
      cleanup();
      res.end();
    } else {
      return res.json(result);
    }

  } catch (error) {
    console.error('Error generating captions:', error);

    // Clean up temp file if it exists (defined earlier in the try block)
    // Note: tempFilePath may not be defined if error occurred before download
    try {
      const tempDir = os.tmpdir();
      const tempFiles = fs.readdirSync(tempDir).filter(f => f.startsWith('audio-') && f.endsWith('.wav'));
      for (const file of tempFiles) {
        const filePath = path.join(tempDir, file);
        const stats = fs.statSync(filePath);
        // Clean up files older than 5 minutes to avoid cleaning up other processes' files
        if (Date.now() - stats.mtimeMs > 5 * 60 * 1000) {
          fs.unlinkSync(filePath);
          console.log('Cleaned up old temp file:', filePath);
        }
      }
    } catch (cleanupErr) {
      // Ignore cleanup errors
    }

    if (stream) {
      sendEvent({
        type: 'error',
        error: error instanceof Error ? error.message : 'Failed to generate captions'
      });
      cleanup();
      res.end();
    } else {
      return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate captions' });
    }
  }
});

/**
 * POST /quality-check
 * Run QA comparison between script and existing captions
 * Uses audio_segments with durations for accurate time-range based comparison
 */
router.post('/quality-check', async (req: Request, res: Response) => {
  const { projectId, srtContent } = req.body;

  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }

  if (!srtContent) {
    return res.status(400).json({ error: 'srtContent is required' });
  }

  try {
    // Use shared Supabase client with service role key (required for database access)
    const supabase = getSupabaseClient();
    if (!supabase) {
      console.error('[QA Check] Supabase not configured - missing SUPABASE_SERVICE_ROLE_KEY');
      return res.status(500).json({ error: 'Server configuration error: Supabase not configured' });
    }

    console.log(`[QA Check] Looking up project: ${projectId}`);

    // Fetch both script_content AND audio_segments
    const { data: project, error: projectError } = await supabase
      .from('generation_projects')
      .select('script_content, audio_segments')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      console.error(`[QA Check] Project lookup failed for ${projectId}:`, projectError?.message || 'No data');
      return res.status(404).json({ error: `Project not found: ${projectId}` });
    }

    // Parse SRT into segments with timestamps
    const srtSegments = parseSrtToSegments(srtContent);
    const transcription = srtSegments.map(s => s.text).join(' ');

    let qaResult: QAResult;

    // If we have audio_segments with durations, use time-range based comparison (ACCURATE)
    // Otherwise fall back to old sentence-matching method (less accurate but works)
    if (project.audio_segments && Array.isArray(project.audio_segments) && project.audio_segments.length > 0) {
      // Map database audio_segments to our interface
      const audioSegments: AudioSegment[] = project.audio_segments.map((seg: any) => ({
        index: seg.index,
        text: seg.text,
        duration: seg.duration || 0,
        audioUrl: seg.audioUrl,
      }));

      console.log(`[QA Check] Using time-range comparison: ${audioSegments.length} audio segments → ${srtSegments.length} SRT segments`);
      qaResult = compareAudioSegmentsToSRT(audioSegments, srtSegments);
    } else if (project.script_content) {
      // Fallback: use old sentence-matching method
      console.log(`[QA Check] No audio_segments found, falling back to sentence matching`);
      qaResult = compareScriptToTranscription(project.script_content, transcription);

      // Try to map issues to SRT segments by text search
      for (const issue of qaResult.issues) {
        if (issue.transcribedText) {
          const searchText = issue.transcribedText.toLowerCase().replace(/[^\w\s]/g, '').slice(0, 40);
          for (const seg of srtSegments) {
            const segText = seg.text.toLowerCase().replace(/[^\w\s]/g, '');
            if (segText.includes(searchText) || searchText.includes(segText.slice(0, 40))) {
              issue.segmentNumber = seg.index;
              break;
            }
          }
        }
      }
    } else {
      return res.status(400).json({ error: 'Project has no script content or audio segments' });
    }

    console.log(`[QA Check] Project ${projectId}: ${qaResult.score}% match, ${qaResult.issues.length} issues, ${qaResult.wordIssues.length} word issues`);

    return res.json({
      success: true,
      // Include full texts for side-by-side comparison
      scriptText: project.script_content || '',
      transcriptText: transcription,
      scriptQa: qaResult,
      // Include audio segments info for regen modal
      audioSegmentCount: project.audio_segments?.length || 0,
    });
  } catch (error) {
    console.error('[QA Check] Error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to run quality check' });
  }
});

export default router;
