import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';

const exec = promisify(execCallback);
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getPronunciationFixesRecord } from './pronunciation';
import { saveCost } from '../lib/cost-tracker';
import { saveAudioToProject, saveAudioProgress, getProjectData, markAudioGenerationStarted } from '../lib/supabase-project';

// Set FFmpeg and FFprobe paths
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}
if (ffprobeStatic?.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

const router = Router();

const DEBUG = process.env.DEBUG === 'true';
const logger = {
  debug: (...args: unknown[]) => DEBUG && console.log('[DEBUG]', ...args),
  info: (...args: unknown[]) => console.log('[INFO]', ...args),
  error: (...args: unknown[]) => console.error('[ERROR]', ...args),
  warn: (...args: unknown[]) => console.warn('[WARN]', ...args),
};

// TTS Configuration Constants
const MAX_TTS_CHUNK_LENGTH = 250; // Reduced from 500 to prevent repetition buildup within chunks
const MIN_TEXT_LENGTH = 5;
const MAX_TEXT_LENGTH = 500; // Match chunk length
const MAX_VOICE_SAMPLE_SIZE = 10 * 1024 * 1024;
const TTS_JOB_POLL_INTERVAL_INITIAL = 250; // Fast initial polling (250ms)
const TTS_JOB_POLL_INTERVAL_MAX = 1000; // Max 1 second between polls for faster detection
const TTS_JOB_TIMEOUT = 120000;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_INITIAL_DELAY = 1000;
const RETRY_MAX_DELAY = 10000;

// Audio pause durations (in seconds) for different punctuation marks
const PAUSE_DURATIONS = {
  SENTENCE_END: 0.4,      // Period (.), exclamation (!), question (?)
  PARAGRAPH: 0.8,         // Double newline or explicit paragraph break
  ELLIPSIS: 0.6,          // Ellipsis (...) - dramatic pause
  COMMA: 0.15,            // Comma (,) - brief pause
  SEMICOLON: 0.25,        // Semicolon (;) or colon (:)
  DASH: 0.2,              // Em dash (—) or double dash (--)
};

const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID || "7gv5y0snx5xiwk";
const RUNPOD_API_URL = `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}`;

// Helper function to safely get Supabase credentials
function getSupabaseCredentials(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error('Supabase credentials not configured');
    return null;
  }

  return { url, key };
}

// SSRF protection: Validate that URL is from trusted sources
function validateVoiceSampleUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsedUrl = new URL(url);

    if (parsedUrl.protocol !== 'https:') {
      return { valid: false, error: 'Voice sample URL must use HTTPS protocol' };
    }

    // Allow Supabase storage and our own domains
    const allowedDomains = ['supabase.co', 'supabase.com', 'autoaigen.com', 'history-gen-ai.pages.dev'];
    const hostname = parsedUrl.hostname;
    const isAllowed = allowedDomains.some(domain =>
      hostname === domain || hostname.endsWith(`.${domain}`)
    );

    if (!isAllowed) {
      return { valid: false, error: 'Voice sample URL must be from Supabase storage or app domain' };
    }

    if (hostname === 'localhost' || hostname === '127.0.0.1' ||
        hostname.startsWith('192.168.') || hostname.startsWith('10.') ||
        hostname.startsWith('172.16.') || hostname === '[::1]') {
      return { valid: false, error: 'Voice sample URL cannot point to internal resources' };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, error: 'Invalid voice sample URL format' };
  }
}

// Hard validation - reject early if text is unsafe
function validateTTSInput(text: string): boolean {
  if (!text) return false;
  if (text.trim().length < MIN_TEXT_LENGTH) return false;
  if (text.length > MAX_TEXT_LENGTH) return false;
  if (/[^\x00-\x7F]/.test(text)) return false;
  if (!/[a-zA-Z0-9]/.test(text)) return false;
  return true;
}

// Convert numbers to words for better TTS pronunciation
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORDINALS: Record<string, string> = {
  '1st': 'first', '2nd': 'second', '3rd': 'third', '4th': 'fourth', '5th': 'fifth',
  '6th': 'sixth', '7th': 'seventh', '8th': 'eighth', '9th': 'ninth', '10th': 'tenth',
  '11th': 'eleventh', '12th': 'twelfth', '13th': 'thirteenth', '14th': 'fourteenth',
  '15th': 'fifteenth', '16th': 'sixteenth', '17th': 'seventeenth', '18th': 'eighteenth',
  '19th': 'nineteenth', '20th': 'twentieth', '21st': 'twenty-first'
};

function numberToWords(n: number): string {
  if (n < 0) return 'negative ' + numberToWords(-n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + numberToWords(n % 100) : '');
  if (n < 10000) {
    // For years like 1347, say "thirteen forty-seven" not "one thousand..."
    const century = Math.floor(n / 100);
    const remainder = n % 100;
    if (remainder === 0) return numberToWords(century) + ' hundred';
    return numberToWords(century) + ' ' + (remainder < 10 ? 'oh-' + ONES[remainder] : numberToWords(remainder));
  }
  if (n < 1000000) return numberToWords(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + numberToWords(n % 1000) : '');
  return numberToWords(Math.floor(n / 1000000)) + ' million' + (n % 1000000 ? ' ' + numberToWords(n % 1000000) : '');
}

function convertNumbersToWords(text: string): string {
  // Convert ordinals first (1st, 2nd, 3rd, etc.)
  text = text.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (match) => {
    const lower = match.toLowerCase();
    return ORDINALS[lower] || match;
  });

  // Convert "ACT 5" patterns to "Act Five" (case-insensitive, preserve case of ACT)
  text = text.replace(/\b(ACT|Act|act)\s+(\d+)\b/gi, (_, word, num) => {
    const n = parseInt(num, 10);
    const wordForm = numberToWords(n);
    // Capitalize first letter of number word
    const capitalizedWord = wordForm.charAt(0).toUpperCase() + wordForm.slice(1);
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() + ' ' + capitalizedWord;
  });

  // Convert standalone numbers (but not in URLs or technical contexts)
  text = text.replace(/\b(\d{1,7})\b/g, (match) => {
    const n = parseInt(match, 10);
    if (n > 9999999) return match; // Keep very large numbers as-is
    return numberToWords(n);
  });

  return text;
}

// Mandatory normalization before sending to API
// Pause timing guide:
// - Comma (,): Short pause (~200ms) - handled naturally by Fish Speech
// - Period (.): Medium pause (~400ms) - handled naturally by Fish Speech
// - Ellipsis (...): Longer pause (~600ms) - handled naturally by Fish Speech
// - Paragraph breaks: Converted to "..." to create longer pauses
function normalizeText(text: string): string {
  let result = text
    .normalize("NFKD")
    // IMPORTANT: Convert smart quotes/dashes BEFORE removing non-ASCII
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...");

  // Convert paragraph breaks (double newlines) to ellipsis for longer pauses
  // This ensures paragraph breaks create audible pauses in TTS output
  // Pattern: end of sentence followed by paragraph break -> add ellipsis
  result = result.replace(/([.!?])\s*\n\s*\n+\s*/g, '$1...\n\n');

  // Also handle paragraph breaks without ending punctuation (add period + ellipsis)
  result = result.replace(/([^.!?\n])\s*\n\s*\n+\s*/g, '$1....\n\n');

  // NOTE: Pronunciation fixes are NOT applied here - they're applied in applyPronunciationFixes()
  // This keeps the display text readable ("Regency" not "REE-jen-see")

  // DISABLED: Number-to-words conversion removed - Fish Speech handles numbers naturally
  // and the conversion was making dates sound unnatural ("seventeen eighty-three" instead of "1783")
  // result = convertNumbersToWords(result);

  return result
    .replace(/[^\x00-\x7F]/g, "") // Remove remaining non-ASCII AFTER conversions
    .replace(/\s+/g, " ")
    .trim();
}

// Pronunciation system DISABLED - let Fish Speech handle everything naturally
function applyPronunciationFixes(text: string): string {
  return text;
}

// Phonetic dictionary for automatic pronunciation lookup
// These are common English words that TTS systems often mispronounce
const PHONETIC_DICTIONARY: Record<string, string> = {
  // Common words with tricky vowels
  'bond': 'bahnd',
  'fond': 'fahnd',
  'pond': 'pahnd',
  'wand': 'wahnd',
  'want': 'wahnt',
  'wash': 'wahsh',
  'watch': 'wahtch',
  'was': 'wuz',
  'what': 'wuht',
  'love': 'luv',
  'dove': 'duv',
  'move': 'moov',
  'prove': 'proov',
  'done': 'dun',
  'gone': 'gawn',
  'none': 'nun',
  'one': 'wun',
  'once': 'wunce',
  'come': 'kum',
  'some': 'sum',
  'home': 'hohm',
  'give': 'giv',
  'live': 'liv',
  'have': 'hav',
  'says': 'sez',
  'said': 'sed',
  'again': 'uh-gen',
  'against': 'uh-genst',
  'been': 'bin',
  'women': 'wimin',
  'woman': 'woo-mun',
  // Historical/formal terms
  'heir': 'air',
  'honour': 'on-er',
  'honest': 'on-ist',
  'hour': 'our',
  'sword': 'sord',
  'answer': 'an-ser',
  'castle': 'kas-ul',
  'listen': 'lis-en',
  'often': 'off-en',
  'soften': 'soff-en',
  'fasten': 'fas-en',
  'whistle': 'wis-ul',
  'thistle': 'this-ul',
  'wrestle': 'res-ul',
  'island': 'eye-lund',
  'aisle': 'eye-ul',
  'corps': 'core',
  'debris': 'duh-bree',
  'rendezvous': 'ron-day-voo',
  'liaison': 'lee-ay-zon',
  'regime': 'reh-zheem',
  'elite': 'eh-leet',
  'facade': 'fuh-sahd',
  'fiancé': 'fee-on-say',
  'fiancée': 'fee-on-say',
  // Names that often get mangled
  'colonel': 'ker-nel',
  'lieutenant': 'loo-ten-ant',
  'sergeant': 'sar-jent',
  // Common contractions/sounds
  'clothes': 'klohz',
  'months': 'munths',
  'sixth': 'siksth',
  'twelfth': 'twelfth',
  'eighth': 'aytth',
  'fifth': 'fifth',
  'width': 'width',
  'length': 'length',
  'strength': 'strength',
};

// Look up phonetic spelling for a word
function lookupPhonetic(word: string): string {
  const lowerWord = word.toLowerCase();
  // First check the dynamic pronunciation fixes (from pronunciation.ts)
  const dynamicFixes = getPronunciationFixesRecord();
  if (dynamicFixes[lowerWord]) {
    return dynamicFixes[lowerWord];
  }
  // Then check our built-in phonetic dictionary
  if (PHONETIC_DICTIONARY[lowerWord]) {
    return PHONETIC_DICTIONARY[lowerWord];
  }
  // If not found, return the original word
  return word;
}

// ============================================================
// POST-PROCESSING: Detect and remove repeated audio segments
// ============================================================


interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

interface WhisperSegment {
  text: string;
  start: number;
  end: number;
  // Populated when Whisper is asked for word-level granularity. Gives
  // precise per-word start/end times so cut boundaries don't drift.
  words?: WhisperWord[];
}

interface RepetitionRange {
  start: number;
  end: number;
  text: string;
}

// Whisper API limit - chunk audio to stay under this
const WHISPER_MAX_BYTES = 20 * 1024 * 1024; // 20MB to be safe (limit is 25MB)

// Extract audio format and PCM data from WAV
function extractWavInfo(wavBuffer: Buffer): { pcmData: Buffer; sampleRate: number; channels: number; bitsPerSample: number; dataOffset: number } {
  const findChunk = (fourcc: string) => {
    const needle = Buffer.from(fourcc, 'ascii');
    for (let i = 0; i <= wavBuffer.length - 4; i++) {
      if (wavBuffer.slice(i, i + 4).equals(needle)) return i;
    }
    return -1;
  };

  const fmtIdx = findChunk('fmt ');
  const dataIdx = findChunk('data');
  if (fmtIdx === -1 || dataIdx === -1) throw new Error('Invalid WAV format');

  const fmtDataStart = fmtIdx + 8;
  const sampleRate = wavBuffer.readUInt32LE(fmtDataStart + 4);
  const channels = wavBuffer.readUInt16LE(fmtDataStart + 2);
  const bitsPerSample = wavBuffer.readUInt16LE(fmtDataStart + 14);

  const dataSize = wavBuffer.readUInt32LE(dataIdx + 4);
  const dataOffset = dataIdx + 8;
  const pcmData = wavBuffer.slice(dataOffset, Math.min(wavBuffer.length, dataOffset + dataSize));

  return { pcmData, sampleRate, channels, bitsPerSample, dataOffset };
}

// Create WAV from PCM chunk
function createWavFromPcm(pcmData: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const bytesPerSample = bitsPerSample / 8;
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20);  // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmData.length, 40);

  return Buffer.concat([header, pcmData]);
}

// Generate silence WAV buffer of specified duration
function generateSilence(durationSeconds: number, sampleRate: number = 24000, channels: number = 1, bitsPerSample: number = 16): Buffer {
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor(sampleRate * durationSeconds * channels);
  const pcmData = Buffer.alloc(numSamples * bytesPerSample); // All zeros = silence
  return createWavFromPcm(pcmData, sampleRate, channels, bitsPerSample);
}

// Audio integrity check result
interface AudioIntegrityResult {
  valid: boolean;
  issues: AudioIssue[];
  stats: {
    durationSeconds: number;
    avgAmplitude: number;
    maxAmplitude: number;
    silencePercent: number;
    discontinuities: number;
  };
}

interface AudioIssue {
  type: 'glitch' | 'skip' | 'discontinuity' | 'silence_gap' | 'clipping';
  timestamp: number;  // seconds
  severity: 'warning' | 'error';
  description: string;
}

// Check audio integrity - detect glitches, skips, and discontinuities
function checkAudioIntegrity(wavBuffer: Buffer, options: {
  silenceThresholdMs?: number;  // Max acceptable silence gap (default 1000ms)
  glitchThresholdDb?: number;   // dB change threshold for glitch detection (default 20)
  sampleWindowMs?: number;      // Analysis window size (default 50ms)
} = {}): AudioIntegrityResult {
  const {
    silenceThresholdMs = 1000,
    glitchThresholdDb = 20,
    sampleWindowMs = 50,
  } = options;

  const issues: AudioIssue[] = [];
  const stats = {
    durationSeconds: 0,
    avgAmplitude: 0,
    maxAmplitude: 0,
    silencePercent: 0,
    discontinuities: 0,
  };

  try {
    // Find data chunk
    const dataMarker = Buffer.from('data', 'ascii');
    let dataIdx = -1;
    for (let i = 0; i <= wavBuffer.length - 4; i++) {
      if (wavBuffer.slice(i, i + 4).equals(dataMarker)) {
        dataIdx = i;
        break;
      }
    }

    if (dataIdx === -1) {
      return {
        valid: false,
        issues: [{ type: 'glitch', timestamp: 0, severity: 'error', description: 'Invalid WAV: no data chunk' }],
        stats,
      };
    }

    // Get format info
    const fmtMarker = Buffer.from('fmt ', 'ascii');
    let fmtIdx = -1;
    for (let i = 0; i <= wavBuffer.length - 4; i++) {
      if (wavBuffer.slice(i, i + 4).equals(fmtMarker)) {
        fmtIdx = i;
        break;
      }
    }

    const sampleRate = fmtIdx !== -1 ? wavBuffer.readUInt32LE(fmtIdx + 12) : 24000;
    const channels = fmtIdx !== -1 ? wavBuffer.readUInt16LE(fmtIdx + 10) : 1;
    const bitsPerSample = fmtIdx !== -1 ? wavBuffer.readUInt16LE(fmtIdx + 22) : 16;
    const bytesPerSample = bitsPerSample / 8;

    const dataSize = wavBuffer.readUInt32LE(dataIdx + 4);
    const dataStart = dataIdx + 8;
    const dataEnd = Math.min(wavBuffer.length, dataStart + dataSize);

    // Read samples
    const samples: number[] = [];
    for (let i = dataStart; i < dataEnd - (bytesPerSample - 1); i += bytesPerSample) {
      if (bytesPerSample === 2) {
        samples.push(wavBuffer.readInt16LE(i));
      } else {
        samples.push(wavBuffer.readInt8(i) * 256);
      }
    }

    if (samples.length === 0) {
      return {
        valid: false,
        issues: [{ type: 'glitch', timestamp: 0, severity: 'error', description: 'No audio samples found' }],
        stats,
      };
    }

    stats.durationSeconds = samples.length / (sampleRate * channels);

    // Analyze in windows
    const windowSize = Math.floor(sampleRate * (sampleWindowMs / 1000));
    const numWindows = Math.floor(samples.length / windowSize);
    const silenceThreshold = 300;  // RMS below this is silence
    const clippingThreshold = 32000;  // Near max for 16-bit

    let totalAmplitude = 0;
    let silentWindows = 0;
    const windowRms: number[] = [];
    let prevRms = 0;

    for (let w = 0; w < numWindows; w++) {
      const start = w * windowSize;
      const end = start + windowSize;
      const window = samples.slice(start, end);

      // Calculate RMS
      const sumSquares = window.reduce((sum, s) => sum + s * s, 0);
      const rms = Math.sqrt(sumSquares / window.length);
      windowRms.push(rms);

      totalAmplitude += rms;
      stats.maxAmplitude = Math.max(stats.maxAmplitude, rms);

      // Detect silence
      if (rms < silenceThreshold) {
        silentWindows++;
      }

      // Detect sudden amplitude changes (glitches/skips)
      if (w > 0 && prevRms > silenceThreshold) {
        const ratio = rms / Math.max(prevRms, 1);
        const dbChange = 20 * Math.log10(ratio);

        // Sudden drop to silence (potential skip)
        if (rms < silenceThreshold && prevRms > silenceThreshold * 3) {
          const timestamp = (w * windowSize) / sampleRate;
          issues.push({
            type: 'skip',
            timestamp,
            severity: 'warning',
            description: `Sudden drop to silence at ${timestamp.toFixed(2)}s (${Math.abs(dbChange).toFixed(1)}dB drop)`,
          });
        }
        // Large amplitude discontinuity
        else if (Math.abs(dbChange) > glitchThresholdDb) {
          const timestamp = (w * windowSize) / sampleRate;
          stats.discontinuities++;
          issues.push({
            type: 'discontinuity',
            timestamp,
            severity: dbChange < -glitchThresholdDb ? 'warning' : 'warning',
            description: `Amplitude discontinuity at ${timestamp.toFixed(2)}s (${dbChange.toFixed(1)}dB change)`,
          });
        }
      }

      // Detect clipping
      const maxInWindow = Math.max(...window.map(Math.abs));
      if (maxInWindow >= clippingThreshold) {
        const timestamp = (w * windowSize) / sampleRate;
        issues.push({
          type: 'clipping',
          timestamp,
          severity: 'warning',
          description: `Potential clipping at ${timestamp.toFixed(2)}s (amplitude ${maxInWindow})`,
        });
      }

      prevRms = rms;
    }

    stats.avgAmplitude = numWindows > 0 ? totalAmplitude / numWindows : 0;
    stats.silencePercent = numWindows > 0 ? (silentWindows / numWindows) * 100 : 0;

    // NEW: Detect sample-level discontinuities (clicks/pops at segment boundaries)
    // Check for large jumps between consecutive samples
    const clickThreshold = 5000;  // Absolute amplitude change threshold (lowered to catch more subtle glitches)
    for (let i = 1; i < samples.length; i++) {
      const diff = Math.abs(samples[i] - samples[i - 1]);
      if (diff > clickThreshold) {
        const timestamp = i / (sampleRate * channels);
        issues.push({
          type: 'glitch',
          timestamp,
          severity: 'error',
          description: `Click/pop detected at ${timestamp.toFixed(2)}s (sample jump: ${diff})`,
        });
        // Limit to first 10 clicks to avoid spam
        if (issues.filter(i => i.type === 'glitch').length >= 10) break;
      }
    }

    // Detect extended silence gaps (potential segment boundary issues)
    let consecutiveSilent = 0;
    const silenceThresholdWindows = Math.ceil((silenceThresholdMs / 1000) / (sampleWindowMs / 1000));

    for (let w = 0; w < numWindows; w++) {
      if (windowRms[w] < silenceThreshold) {
        consecutiveSilent++;
        if (consecutiveSilent === silenceThresholdWindows) {
          const timestamp = ((w - consecutiveSilent + 1) * windowSize) / sampleRate;
          issues.push({
            type: 'silence_gap',
            timestamp,
            severity: 'warning',
            description: `Extended silence gap starting at ${timestamp.toFixed(2)}s (>${silenceThresholdMs}ms)`,
          });
        }
      } else {
        consecutiveSilent = 0;
      }
    }

    // Determine if audio is valid (no errors, only warnings)
    const hasErrors = issues.some(i => i.severity === 'error');
    const criticalIssues = issues.filter(i =>
      i.type === 'skip' || (i.type === 'discontinuity' && i.severity === 'error')
    );

    return {
      valid: !hasErrors && criticalIssues.length === 0,
      issues,
      stats,
    };
  } catch (err) {
    return {
      valid: false,
      issues: [{
        type: 'glitch',
        timestamp: 0,
        severity: 'error',
        description: `Analysis error: ${err instanceof Error ? err.message : 'Unknown error'}`,
      }],
      stats,
    };
  }
}

// Log audio integrity check results
function logAudioIntegrity(result: AudioIntegrityResult, context: string): void {
  const { valid, issues, stats } = result;

  logger.info(`Audio integrity check [${context}]:`);
  logger.info(`  Duration: ${stats.durationSeconds.toFixed(2)}s`);
  logger.info(`  Avg amplitude: ${stats.avgAmplitude.toFixed(0)}, Max: ${stats.maxAmplitude.toFixed(0)}`);
  logger.info(`  Silence: ${stats.silencePercent.toFixed(1)}%`);
  logger.info(`  Discontinuities: ${stats.discontinuities}`);
  logger.info(`  Valid: ${valid ? 'YES' : 'NO'}`);

  if (issues.length > 0) {
    logger.warn(`  Issues (${issues.length}):`);
    // Only log first 10 issues to avoid spam
    const displayIssues = issues.slice(0, 10);
    displayIssues.forEach(issue => {
      const prefix = issue.severity === 'error' ? '  ❌' : '  ⚠️';
      logger.warn(`${prefix} [${issue.type}] ${issue.description}`);
    });
    if (issues.length > 10) {
      logger.warn(`  ... and ${issues.length - 10} more issues`);
    }
  }
}

/**
 * Smooth audio by detecting and crossfading large amplitude discontinuities
 * Uses FFmpeg highpass/lowpass filters to reduce click artifacts
 * @param wavBuffer - Input WAV buffer
 * @param options - Smoothing options
 * @returns Smoothed WAV buffer
 */
async function smoothAudioWithFFmpeg(
  wavBuffer: Buffer,
  options: {
    highpassFreq?: number;  // Remove DC offset and subsonic rumble
    lowpassFreq?: number;   // Remove ultrasonic artifacts
  } = {}
): Promise<Buffer> {
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `audio-input-${Date.now()}.wav`);
  const outputPath = path.join(tempDir, `audio-output-${Date.now()}.wav`);

  try {
    // Write input WAV to temp file
    fs.writeFileSync(inputPath, wavBuffer);

    // Apply gentle audio smoothing filters
    const filters = [];

    // Remove DC offset and very low frequencies (reduces pops)
    if (options.highpassFreq && options.highpassFreq > 0) {
      filters.push(`highpass=f=${options.highpassFreq}`);
    }

    // Remove very high frequencies (reduces clicks)
    if (options.lowpassFreq && options.lowpassFreq > 0) {
      filters.push(`lowpass=f=${options.lowpassFreq}`);
    }

    const filterChain = filters.length > 0 ? filters.join(',') : 'anull';

    // Run FFmpeg with smoothing filters
    const ffmpegPath = ffmpegStatic || 'ffmpeg';
    await exec(
      `"${ffmpegPath}" -y -i "${inputPath}" -af "${filterChain}" "${outputPath}"`
    );

    // Read output
    const smoothedBuffer = fs.readFileSync(outputPath);

    // Cleanup
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

    return smoothedBuffer;
  } catch (err) {
    // Cleanup on error
    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch (cleanupError) {
      logger.warn('FFmpeg smoothing cleanup failed:', cleanupError);
    }
    throw new Error(`FFmpeg smoothing failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
}

// Determine pause duration based on text ending punctuation
function getPauseDuration(text: string, isLastChunk: boolean = false): number {
  if (isLastChunk) return 0; // No pause after last chunk

  const trimmed = text.trim();
  if (!trimmed) return 0;

  // Check for paragraph break marker (we'll add this during text processing)
  if (trimmed.endsWith('[PARA]')) {
    return PAUSE_DURATIONS.PARAGRAPH;
  }

  // Check ending punctuation
  const lastChar = trimmed.slice(-1);
  const lastThree = trimmed.slice(-3);
  const lastTwo = trimmed.slice(-2);

  // Ellipsis (... or …)
  if (lastThree === '...' || lastChar === '…') {
    return PAUSE_DURATIONS.ELLIPSIS;
  }

  // Em dash or double dash
  if (lastChar === '—' || lastTwo === '--') {
    return PAUSE_DURATIONS.DASH;
  }

  // Sentence-ending punctuation
  if (lastChar === '.' || lastChar === '!' || lastChar === '?') {
    return PAUSE_DURATIONS.SENTENCE_END;
  }

  // Semicolon or colon
  if (lastChar === ';' || lastChar === ':') {
    return PAUSE_DURATIONS.SEMICOLON;
  }

  // Comma - TTS usually handles this, but add small pause at chunk boundary
  if (lastChar === ',') {
    return PAUSE_DURATIONS.COMMA;
  }

  // Default: small pause between chunks that don't end with punctuation
  return 0.1;
}

// Transcribe a single audio chunk via Groq Whisper.
// Requests both segment and word-level timestamps so the loop detector
// can cut on word boundaries (no interpolation drift).
async function transcribeChunk(audioBuffer: Buffer, apiKey: string): Promise<WhisperSegment[]> {
  const formData = new FormData();
  const audioBlob = new Blob([new Uint8Array(audioBuffer)], { type: 'audio/wav' });
  formData.append('file', audioBlob, 'audio.wav');
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('response_format', 'verbose_json');
  formData.append('language', 'en');
  // Ask for word-level timestamps in addition to segment-level.
  // Groq mirrors the OpenAI Whisper API for this parameter.
  formData.append('timestamp_granularities[]', 'segment');
  formData.append('timestamp_granularities[]', 'word');

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Whisper API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json() as any;
  const segments: WhisperSegment[] = result.segments || [];
  const words: WhisperWord[] = result.words || [];

  // Attach each word to its containing segment by timestamp overlap.
  // Falls back gracefully if Groq returns no words array (older deploys,
  // or if the request parameter is ignored).
  if (words.length > 0 && segments.length > 0) {
    let wi = 0;
    for (const seg of segments) {
      seg.words = [];
      while (wi < words.length && words[wi].start < seg.end - 1e-6) {
        if (words[wi].end <= seg.start + 1e-6) { wi++; continue; }
        seg.words.push(words[wi]);
        wi++;
      }
    }
  }
  return segments;
}

// Transcribe audio using Groq Whisper to get segments with timestamps
async function transcribeForRepetitionDetection(audioBuffer: Buffer): Promise<WhisperSegment[]> {
  const groqApiKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
  if (!groqApiKey) {
    logger.warn('No Groq/OpenAI API key for repetition detection, skipping post-processing');
    return [];
  }

  try {
    logger.info(`Transcribing audio for repetition detection (${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB)...`);

    // If audio is small enough, transcribe directly
    if (audioBuffer.length <= WHISPER_MAX_BYTES) {
      const segments = await transcribeChunk(audioBuffer, groqApiKey);
      logger.info(`Transcription complete: ${segments.length} segments`);
      return segments;
    }

    // Audio too large - need to chunk it
    logger.info('Audio exceeds 20MB, chunking for transcription...');

    const { pcmData, sampleRate, channels, bitsPerSample } = extractWavInfo(audioBuffer);
    const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
    const maxChunkPcmBytes = WHISPER_MAX_BYTES - 1000; // Leave room for header
    const chunkDuration = maxChunkPcmBytes / bytesPerSecond;

    const totalDuration = pcmData.length / bytesPerSecond;
    const numChunks = Math.ceil(pcmData.length / maxChunkPcmBytes);

    logger.info(`Splitting ${totalDuration.toFixed(1)}s audio into ${numChunks} chunks (~${chunkDuration.toFixed(0)}s each)`);

    const allSegments: WhisperSegment[] = [];

    for (let i = 0; i < numChunks; i++) {
      const startByte = i * maxChunkPcmBytes;
      const endByte = Math.min((i + 1) * maxChunkPcmBytes, pcmData.length);
      const chunkPcm = pcmData.slice(startByte, endByte);
      const chunkWav = createWavFromPcm(chunkPcm, sampleRate, channels, bitsPerSample);

      const timeOffset = startByte / bytesPerSecond;
      logger.info(`Transcribing chunk ${i + 1}/${numChunks} (offset: ${timeOffset.toFixed(1)}s)...`);

      try {
        const chunkSegments = await transcribeChunk(chunkWav, groqApiKey);

        // Adjust timestamps by chunk offset (segment AND word level)
        for (const seg of chunkSegments) {
          const offsetWords = seg.words?.map(w => ({
            word: w.word,
            start: w.start + timeOffset,
            end: w.end + timeOffset,
          }));
          allSegments.push({
            text: seg.text,
            start: seg.start + timeOffset,
            end: seg.end + timeOffset,
            words: offsetWords,
          });
        }
      } catch (err) {
        logger.warn(`Chunk ${i + 1} transcription failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }

    logger.info(`Transcription complete: ${allSegments.length} segments from ${numChunks} chunks`);
    return allSegments;

  } catch (error) {
    logger.error('Transcription for repetition detection failed:', error);
    return [];
  }
}

// Normalize text for comparison (lowercase, remove punctuation)
function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Detect TTS loop hallucinations: the EXACT same sentence (after
// lowercase/punctuation normalization) repeated back-to-back 2+ times.
// We require exact equality (not fuzzy similarity) so natural rhetoric
// like anaphora never triggers.
// `consecutiveSimilarityThreshold` is retained for back-compat but is
// only applied if < 1.0; the default 1.0 means EXACT match only.
// Exported for offline scanning/debug scripts.
export function detectRepetitions(
  segments: WhisperSegment[],
  minWords: number = 4,
  consecutiveSimilarityThreshold: number = 1.0,
  inSegmentMinPhraseLen: number = 6,
  inSegmentMinOccurrences: number = 2,  // 2× back-to-back = loop (1x repeat)
): RepetitionRange[] {
  if (segments.length < 2) return [];

  const repetitions: RepetitionRange[] = [];
  const processedRanges = new Set<string>();

  // Rebuild sentences across Whisper segment boundaries so a loop that
  // spans multiple segments is caught correctly. For per-word timing we
  // prefer Whisper's own word-level timestamps (when available); fall
  // back to char-level interpolation from segment boundaries if not.
  type WordTime = { normalized: string; startTime: number; endTime: number };
  type Sentence = { text: string; normalized: string; start: number; end: number; words: WordTime[] };
  const sentences: Sentence[] = [];

  const hasWordTimestamps = segments.some(s => s.words && s.words.length > 0);
  logger.info(`Sentence rebuild: ${segments.length} segs, word-level timestamps=${hasWordTimestamps ? 'yes' : 'no (falling back to char interpolation)'}`);

  if (hasWordTimestamps) {
    // Use Whisper's word-level timestamps directly — no drift.
    // Build a flat ordered list of (word, normalizedWord, start, end) then
    // group into sentences by .!? terminators seen in the original word text.
    type FlatWord = { raw: string; normalized: string; start: number; end: number };
    const flat: FlatWord[] = [];
    for (const seg of segments) {
      if (!seg.words) continue;
      for (const w of seg.words) {
        const raw = w.word.trim();
        if (!raw) continue;
        const normalized = normalizeForComparison(raw);
        if (!normalized) continue;
        flat.push({ raw, normalized, start: w.start, end: w.end });
      }
    }

    // Walk flat list, accumulating into a sentence until we see a word
    // ending in .!? (that's the sentence terminator from Whisper's view).
    let cur: FlatWord[] = [];
    const flush = () => {
      if (cur.length === 0) return;
      const text = cur.map(w => w.raw).join(' ');
      const words: WordTime[] = cur.map(w => ({
        normalized: w.normalized,
        startTime: w.start,
        endTime: w.end,
      }));
      sentences.push({
        text,
        normalized: normalizeForComparison(text),
        start: cur[0].start,
        end: cur[cur.length - 1].end,
        words,
      });
      cur = [];
    };
    for (const w of flat) {
      cur.push(w);
      if (/[.!?]$/.test(w.raw)) flush();
    }
    flush();
  } else {
    // Fallback: old char-interpolation path when word timestamps aren't
    // available (older Groq deploys or if the request parameter was ignored).
    const joinedParts: string[] = [];
    const charStarts: number[] = [];
    const charEnds: number[] = [];
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      const segText = seg.text;
      if (!segText) continue;
      const segDuration = Math.max(0.01, seg.end - seg.start);
      const timePerChar = segDuration / Math.max(1, segText.length);
      for (let c = 0; c < segText.length; c++) {
        charStarts.push(seg.start + c * timePerChar);
        charEnds.push(seg.start + (c + 1) * timePerChar);
      }
      joinedParts.push(segText);
      if (si < segments.length - 1) {
        joinedParts.push(' ');
        charStarts.push(seg.end);
        charEnds.push(segments[si + 1].start);
      }
    }
    const joined = joinedParts.join('');
    const sentenceMatches = joined.matchAll(/[^.!?]+[.!?]?/g);
    const wordPattern = /\S+/g;
    for (const match of sentenceMatches) {
      const raw = match[0];
      const matchIndex = match.index ?? 0;
      const leftTrim = raw.search(/\S/);
      if (leftTrim === -1) continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const rightTrim = raw.length - (raw.length - raw.replace(/\s+$/, '').length);
      const startChar = matchIndex + leftTrim;
      const endChar = Math.min(matchIndex + rightTrim - 1, charEnds.length - 1);
      const start = charStarts[startChar] ?? segments[0].start;
      const end = charEnds[endChar] ?? segments[segments.length - 1].end;
      const words: WordTime[] = [];
      const wordMatches = raw.matchAll(wordPattern);
      for (const wMatch of wordMatches) {
        const wRaw = wMatch[0];
        const wStartChar = matchIndex + (wMatch.index ?? 0);
        const wEndChar = Math.min(wStartChar + wRaw.length - 1, charEnds.length - 1);
        const wStart = charStarts[wStartChar] ?? start;
        const wEnd = charEnds[wEndChar] ?? end;
        const normalized = normalizeForComparison(wRaw);
        if (normalized.length === 0) continue;
        words.push({ normalized, startTime: wStart, endTime: wEnd });
      }
      sentences.push({
        text: trimmed,
        normalized: normalizeForComparison(trimmed),
        start,
        end,
        words,
      });
    }
  }

  logger.info(`Analyzing ${sentences.length} sentences for back-to-back repeats (minWords=${minWords}, simThreshold=${consecutiveSimilarityThreshold})...`);

  // Find runs of identical/near-identical ADJACENT sentences (j = i+1 only).
  // No lookback window — this is how we avoid false-positives on natural anaphora.
  let i = 0;
  while (i < sentences.length - 1) {
    const current = sentences[i];
    const currWords = current.normalized.split(' ').filter(w => w.length > 0);

    if (currWords.length < minWords) { i++; continue; }

    // Extend the run while the consecutive sentence exactly matches (or
    // meets the legacy similarity threshold when it's been set below 1.0)
    let runEnd = i;
    while (runEnd + 1 < sentences.length) {
      const next = sentences[runEnd + 1];
      const nextWords = next.normalized.split(' ').filter(w => w.length > 0);
      if (nextWords.length < minWords) break;

      const matches = consecutiveSimilarityThreshold >= 1.0
        ? current.normalized === next.normalized
        : calculateSimilarity(current.normalized, next.normalized) >= consecutiveSimilarityThreshold;

      if (matches) runEnd++;
      else break;
    }

    if (runEnd > i) {
      // Flag every repeat after the first (keep one copy)
      for (let k = i + 1; k <= runEnd; k++) {
        const rep = sentences[k];
        const rangeKey = `${rep.start.toFixed(2)}-${rep.end.toFixed(2)}`;
        if (!processedRanges.has(rangeKey)) {
          processedRanges.add(rangeKey);
          repetitions.push({ start: rep.start, end: rep.end, text: rep.text });
        }
      }
      logger.info(`Adjacent repeat × ${runEnd - i + 1}: "${current.text.substring(0, 80)}" starting ${current.start.toFixed(2)}s`);
      i = runEnd + 1;
    } else {
      i++;
    }
  }

  // In-sentence phrase repetition (chunk-internal loops).
  // Uses per-word timestamps (from charStarts/charEnds lookup) for precise
  // FFmpeg cut boundaries. Requires ≥inSegmentMinOccurrences non-overlapping
  // CONSECUTIVE occurrences of a ≥inSegmentMinPhraseLen-word phrase.
  for (const sent of sentences) {
    const words = sent.words; // normalized+timestamped
    if (words.length < inSegmentMinPhraseLen * inSegmentMinOccurrences) continue;
    const maxPhraseLen = Math.min(12, Math.floor(words.length / inSegmentMinOccurrences));
    if (maxPhraseLen < inSegmentMinPhraseLen) continue;

    for (let phraseLen = inSegmentMinPhraseLen; phraseLen <= maxPhraseLen; phraseLen++) {
      let foundAtThisLen = false;
      for (let start = 0; start <= words.length - phraseLen * inSegmentMinOccurrences; start++) {
        const phrase = words.slice(start, start + phraseLen).map(w => w.normalized).join(' ');
        const occurrences: number[] = [start];
        let pos = start + phraseLen;
        while (pos <= words.length - phraseLen) {
          const candidate = words.slice(pos, pos + phraseLen).map(w => w.normalized).join(' ');
          if (candidate === phrase) {
            occurrences.push(pos);
            pos += phraseLen;
          } else {
            break; // must be CONSECUTIVE (no gaps)
          }
        }
        if (occurrences.length < inSegmentMinOccurrences) continue;

        // Flag every repeat after the first, using real word timestamps.
        // No pad on start — would cut into the preceding word's trailing
        // audio. Small pad on end catches any residual decay of the last
        // repeated word so the cut doesn't leave a phantom half-word.
        const endPad = 0.02;
        for (let k = 1; k < occurrences.length; k++) {
          const occPos = occurrences[k];
          const repStart = words[occPos].startTime;
          const repEnd = words[occPos + phraseLen - 1].endTime + endPad;
          const rangeKey = `${repStart.toFixed(2)}-${repEnd.toFixed(2)}`;
          if (!processedRanges.has(rangeKey)) {
            processedRanges.add(rangeKey);
            repetitions.push({ start: repStart, end: repEnd, text: phrase });
          }
        }
        logger.info(`In-sentence loop: "${phrase}" × ${occurrences.length} at ${words[occurrences[0]].startTime.toFixed(2)}s (phraseLen=${phraseLen})`);
        foundAtThisLen = true;
        break;
      }
      if (foundAtThisLen) break;
    }
  }

  // Sort by start time and merge overlapping ranges
  repetitions.sort((a, b) => a.start - b.start);

  const merged: RepetitionRange[] = [];
  for (const rep of repetitions) {
    if (merged.length === 0) {
      merged.push(rep);
    } else {
      const last = merged[merged.length - 1];
      if (rep.start <= last.end + 0.1) {
        // Merge overlapping ranges
        last.end = Math.max(last.end, rep.end);
        last.text += ' ' + rep.text;
      } else {
        merged.push(rep);
      }
    }
  }

  logger.info(`Detected ${merged.length} repetition ranges to remove`);
  return merged;
}

// Calculate similarity between two strings (Jaccard-like similarity)
function calculateSimilarity(str1: string, str2: string): number {
  const words1 = new Set(str1.split(' '));
  const words2 = new Set(str2.split(' '));

  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

// Check if one sentence is contained within another (catches subset duplicates)
// This fixes cases where Jaccard fails due to extra words in the longer sentence
function isContainedIn(shorter: string, longer: string, minWords: number = 4): boolean {
  const shortWords = shorter.split(' ').filter(w => w.length > 0);
  const longWords = longer.split(' ').filter(w => w.length > 0);

  // Ensure shorter is actually shorter and has enough words
  if (shortWords.length < minWords) return false;
  if (shortWords.length >= longWords.length) return false;

  // Check if 80%+ of shorter's words appear in longer
  const longSet = new Set(longWords);
  const matchCount = shortWords.filter(w => longSet.has(w)).length;

  return matchCount / shortWords.length >= 0.80;
}

// Remove audio segments using FFmpeg
async function removeAudioSegments(audioBuffer: Buffer, repetitions: RepetitionRange[]): Promise<Buffer> {
  if (repetitions.length === 0) {
    return audioBuffer;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-cleanup-'));
  const inputPath = path.join(tempDir, 'input.wav');
  const outputPath = path.join(tempDir, 'output.wav');

  try {
    // Write input buffer to temp file
    fs.writeFileSync(inputPath, audioBuffer);

    // Get audio duration
    const duration = await getAudioDuration(inputPath);
    logger.info(`Audio duration: ${duration.toFixed(2)}s, removing ${repetitions.length} segments`);

    // Build list of segments to KEEP (inverse of repetitions)
    const keepSegments: { start: number; end: number }[] = [];
    let currentStart = 0;

    for (const rep of repetitions) {
      if (rep.start > currentStart + 0.05) {
        keepSegments.push({ start: currentStart, end: rep.start });
      }
      currentStart = rep.end;
    }

    // Add final segment if there's remaining audio
    if (currentStart < duration - 0.05) {
      keepSegments.push({ start: currentStart, end: duration });
    }

    if (keepSegments.length === 0) {
      logger.warn('No segments to keep after repetition removal, returning original');
      return audioBuffer;
    }

    logger.info(`Keeping ${keepSegments.length} segments, total removed: ${repetitions.reduce((sum, r) => sum + (r.end - r.start), 0).toFixed(2)}s`);

    // Build FFmpeg filter to select and concatenate kept segments
    const filterParts: string[] = [];
    const concatInputs: string[] = [];

    for (let i = 0; i < keepSegments.length; i++) {
      const seg = keepSegments[i];
      filterParts.push(`[0:a]atrim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
      concatInputs.push(`[a${i}]`);
    }

    const filterComplex = filterParts.join(';') + `;${concatInputs.join('')}concat=n=${keepSegments.length}:v=0:a=1[out]`;

    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .complexFilter(filterComplex)
        .outputOptions(['-map', '[out]'])
        .output(outputPath)
        .on('error', (err) => reject(err))
        .on('end', () => resolve())
        .run();
    });

    const outputBuffer = fs.readFileSync(outputPath);
    logger.info(`Post-processed audio: ${audioBuffer.length} -> ${outputBuffer.length} bytes`);

    return outputBuffer;

  } finally {
    // Cleanup temp files
    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      fs.rmdirSync(tempDir);
    } catch (e) {
      logger.warn('Failed to cleanup temp files:', e);
    }
  }
}

// Get audio duration using FFmpeg
function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration || 0);
    });
  });
}

// ============================================================
// PER-CHUNK TRANSCRIPTION VERIFICATION (Whisper-based)
// ============================================================

// Detect and remove repeated phrases in source text BEFORE TTS generation
function removeTextRepetitions(text: string, minWords: number = 4): { cleaned: string; removedCount: number } {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
  const normalized = sentences.map(s => normalizeForComparison(s));
  const toRemove = new Set<number>();

  // Find repeated sentences
  for (let i = 0; i < sentences.length - 1; i++) {
    const currentWords = normalized[i].split(' ').filter(Boolean);
    if (currentWords.length < minWords) continue;

    // Check next few sentences for repetition
    for (let j = i + 1; j < Math.min(i + 3, sentences.length); j++) {
      const nextWords = normalized[j].split(' ').filter(Boolean);
      if (nextWords.length < minWords) continue;

      // Check for similarity OR containment (catches subset duplicates)
      const similarity = calculateSimilarity(normalized[i], normalized[j]);
      const contained = isContainedIn(normalized[j], normalized[i], minWords) ||
                        isContainedIn(normalized[i], normalized[j], minWords);

      if (similarity > 0.70 || contained) {
        toRemove.add(j); // Remove the duplicate occurrence
        const detectionType = contained && similarity <= 0.70 ? 'containment' : 'similarity';
        logger.info(`Removing duplicate sentence before TTS: "${sentences[j].substring(0, 50)}..." (${detectionType}: ${(similarity * 100).toFixed(0)}%)`);
      }
    }
  }

  // Also check for repeated phrases within sentences
  const cleanedSentences: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    if (toRemove.has(i)) continue; // Skip removed sentences

    const sentence = sentences[i];
    const words = sentence.split(/\s+/);
    const cleanedWords: string[] = [];
    const seen = new Set<string>();

    // Look for repeated 4+ word phrases
    for (let w = 0; w < words.length; w++) {
      const phrase = words.slice(w, Math.min(w + 6, words.length)).join(' ').toLowerCase();

      // Check if this phrase was seen recently (within last 10 words)
      let isDuplicate = false;
      const recentPhrases = cleanedWords.slice(-10).join(' ').toLowerCase();

      for (let len = 4; len <= 6 && w + len <= words.length; len++) {
        const checkPhrase = words.slice(w, w + len).join(' ').toLowerCase();
        if (recentPhrases.includes(checkPhrase) && checkPhrase.split(' ').length >= 4) {
          isDuplicate = true;
          logger.info(`Removing in-sentence repetition: "${checkPhrase}"`);
          w += len - 1; // Skip these words
          break;
        }
      }

      if (!isDuplicate) {
        cleanedWords.push(words[w]);
      }
    }

    cleanedSentences.push(cleanedWords.join(' '));
  }

  const cleaned = cleanedSentences.join(' ');
  return { cleaned, removedCount: toRemove.size };
}

export type SegmentationMode = 'legacy' | 'progressive';

export interface ProgressiveOpts {
  fastRegionSec?: number;   // seconds of audio from start treated as "fast region" (default 1800 = 30 min)
  fastSegmentSec?: number;  // target segment duration inside fast region (default 10)
  slowSegmentSec?: number;  // target segment duration after fast region (default 30)
}

// Split a sleep-friendly script into TTS segments.
//
// Legacy mode (default — current production behavior):
//   First divide into 10 equal chunks (like original 10-segment system)
//   Then subdivide early chunks for finer control where it matters most:
//   Chunk 1: 5 segments, Chunk 2: 4, Chunks 3-4: 2 each, Chunks 5-10: 1 each.
//   Total ≈ 19 segments for any script length.
//
// Progressive mode (opt-in via segmentationMode='progressive'):
//   Duration-targeted, front-weighted. First `fastRegionSec` of estimated
//   audio gets chopped into `fastSegmentSec`-second segments; rest into
//   `slowSegmentSec`-second segments. Estimated audio time per sentence
//   uses word count at ~2.5 wps × speed. Retention-critical opening gets
//   much finer regeneration granularity (e.g. 10s vs current ~2 min).
export function splitIntoSegments(
  text: string,
  speed: number = 1.0,
  mode: SegmentationMode = 'legacy',
  opts: ProgressiveOpts = {}
): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length === 0) return [];

  if (mode === 'progressive') {
    return splitProgressive(sentences, speed, opts);
  }

  return splitLegacy(sentences);
}

function splitLegacy(sentences: string[]): string[] {
  const total = sentences.length;
  const chunkSize = Math.ceil(total / 10);

  // Create 10 chunks
  const chunks: string[][] = [];
  for (let c = 0; c < 10; c++) {
    const start = c * chunkSize;
    const end = Math.min(start + chunkSize, total);
    if (start < total) {
      chunks.push(sentences.slice(start, end));
    }
  }

  const segments: string[] = [];

  // Chunk 1: subdivide into 5 segments
  if (chunks[0]) {
    const subSize = Math.ceil(chunks[0].length / 5);
    for (let i = 0; i < chunks[0].length; i += subSize) {
      const sub = chunks[0].slice(i, i + subSize);
      if (sub.length > 0) segments.push(sub.join(' '));
    }
  }

  // Chunk 2: subdivide into 4 segments
  if (chunks[1]) {
    const subSize = Math.ceil(chunks[1].length / 4);
    for (let i = 0; i < chunks[1].length; i += subSize) {
      const sub = chunks[1].slice(i, i + subSize);
      if (sub.length > 0) segments.push(sub.join(' '));
    }
  }

  // Chunk 3: subdivide into 2 segments
  if (chunks[2]) {
    const subSize = Math.ceil(chunks[2].length / 2);
    for (let i = 0; i < chunks[2].length; i += subSize) {
      const sub = chunks[2].slice(i, i + subSize);
      if (sub.length > 0) segments.push(sub.join(' '));
    }
  }

  // Chunk 4: subdivide into 2 segments
  if (chunks[3]) {
    const subSize = Math.ceil(chunks[3].length / 2);
    for (let i = 0; i < chunks[3].length; i += subSize) {
      const sub = chunks[3].slice(i, i + subSize);
      if (sub.length > 0) segments.push(sub.join(' '));
    }
  }

  // Chunks 5-10: keep as single segments
  for (let c = 4; c < chunks.length; c++) {
    if (chunks[c] && chunks[c].length > 0) {
      segments.push(chunks[c].join(' '));
    }
  }

  return segments;
}

function splitProgressive(
  sentences: string[],
  speed: number,
  opts: ProgressiveOpts,
): string[] {
  const FAST_REGION = opts.fastRegionSec ?? 1800;
  const FAST_TARGET = opts.fastSegmentSec ?? 10;
  const SLOW_TARGET = opts.slowSegmentSec ?? 30;

  // Fish Speech narrates ~2.5 words/sec at speed=1.0. Speed param stretches
  // audio proportionally, so effective wps scales with speed.
  const WPS = 2.5 * Math.max(0.1, speed);

  const estimateSec = (sentence: string): number => {
    const wc = sentence.split(/\s+/).filter(Boolean).length;
    return wc / WPS;
  };

  const segments: string[] = [];
  let buf: string[] = [];
  let bufSec = 0;
  let cumulativeSec = 0;

  const currentTarget = () =>
    cumulativeSec < FAST_REGION ? FAST_TARGET : SLOW_TARGET;

  const flush = () => {
    if (buf.length > 0) {
      segments.push(buf.join(' '));
      cumulativeSec += bufSec;
      buf = [];
      bufSec = 0;
    }
  };

  for (const sentence of sentences) {
    const sentSec = estimateSec(sentence);
    // If adding this sentence would push us past the target, flush first.
    // Exception: empty buffer always takes the sentence even if oversized,
    // since a single sentence cannot be split without mid-sentence TTS cuts
    // (which degrade prosody badly).
    if (buf.length > 0 && bufSec + sentSec > currentTarget()) {
      flush();
    }
    buf.push(sentence);
    bufSec += sentSec;
  }
  flush();
  return segments;
}

// Split text into safe chunks at sentence boundaries, preserving paragraph markers
function splitIntoChunks(text: string, maxLength: number = MAX_TTS_CHUNK_LENGTH): string[] {
  // First, mark paragraph breaks with a special token
  // Paragraph = 2+ newlines, or newline followed by indentation
  const withParagraphMarkers = text
    .replace(/\n{2,}/g, ' [PARA] ')  // Double+ newlines become paragraph marker
    .replace(/\n\s{2,}/g, ' [PARA] ') // Newline + indentation = paragraph
    .replace(/\n/g, ' ');  // Single newlines become spaces

  const sentences = withParagraphMarkers.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const sentence of sentences) {
    // Check if this sentence starts with paragraph marker
    const startsWithPara = sentence.trim().startsWith('[PARA]');
    const cleanSentence = sentence.replace(/\[PARA\]\s*/g, '').trim();

    if (!cleanSentence) continue;

    // If starting new paragraph and we have content, mark previous chunk
    if (startsWithPara && currentChunk) {
      chunks.push(currentChunk.trim() + ' [PARA]');
      currentChunk = "";
    }

    if (cleanSentence.length > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }
      const parts = cleanSentence.split(/,\s*/);
      let partChunk = "";
      for (const part of parts) {
        if (part.length > maxLength) {
          if (partChunk) {
            chunks.push(partChunk.trim());
            partChunk = "";
          }
          for (let i = 0; i < part.length; i += maxLength) {
            chunks.push(part.slice(i, i + maxLength).trim());
          }
        } else if ((partChunk + ", " + part).length > maxLength) {
          if (partChunk) chunks.push(partChunk.trim());
          partChunk = part;
        } else {
          partChunk = partChunk ? partChunk + ", " + part : part;
        }
      }
      if (partChunk) chunks.push(partChunk.trim());
    } else if ((currentChunk + " " + cleanSentence).length > maxLength) {
      if (currentChunk) chunks.push(currentChunk.trim());
      currentChunk = cleanSentence;
    } else {
      currentChunk = currentChunk ? currentChunk + " " + cleanSentence : cleanSentence;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks.filter(c => c.length > 0 && c !== '[PARA]');
}

// Download voice sample and convert to base64
async function downloadVoiceSample(url: string): Promise<string> {
  logger.debug(`Downloading voice sample from: ${url}`);

  const validation = validateVoiceSampleUrl(url);
  if (!validation.valid) {
    throw new Error(`Security error: ${validation.error}`);
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download voice sample: HTTP ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type');
    logger.debug(`Voice sample content-type: ${contentType}`);

    if (contentType && !contentType.includes('audio')) {
      logger.warn(`Unexpected content-type: ${contentType}. Expected audio/* type.`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    if (bytes.length === 0) {
      throw new Error('Voice sample is empty (0 bytes)');
    }

    if (bytes.length > MAX_VOICE_SAMPLE_SIZE) {
      throw new Error(`Voice sample too large: ${bytes.length} bytes (max ${MAX_VOICE_SAMPLE_SIZE / 1024 / 1024}MB)`);
    }

    // Validate audio format
    const header = Buffer.from(bytes.subarray(0, 4)).toString('ascii');
    let format = 'Unknown';
    let needsConversion = false;

    if (header === 'RIFF') {
      format = 'WAV';
    } else if (header.startsWith('ID3') || header.startsWith('\xFF\xFB')) {
      format = 'MP3';
      needsConversion = true;
      logger.info(`Voice sample is MP3 format - converting to WAV for reliability.`);
    } else {
      logger.warn(`Unknown audio format. First 4 bytes: ${Array.from(bytes.subarray(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
      needsConversion = true; // Try to convert anyway
    }

    let finalBytes = Buffer.from(bytes);

    // Convert non-WAV formats to WAV using ffmpeg
    if (needsConversion) {
      logger.info(`Converting ${format} voice sample to WAV format...`);

      const tempInputPath = path.join(os.tmpdir(), `voice_input_${crypto.randomBytes(8).toString('hex')}.${format.toLowerCase()}`);
      const tempOutputPath = path.join(os.tmpdir(), `voice_output_${crypto.randomBytes(8).toString('hex')}.wav`);

      try {
        // Write input file
        fs.writeFileSync(tempInputPath, bytes);

        // Convert to WAV using ffmpeg (Fish Speech accepts various formats but WAV is most reliable)
        await new Promise<void>((resolve, reject) => {
          ffmpeg(tempInputPath)
            .audioChannels(1)       // Mono
            .audioCodec('pcm_s16le') // 16-bit PCM
            .format('wav')
            .on('error', (err) => {
              logger.error('FFmpeg conversion error:', err);
              reject(new Error(`Failed to convert voice sample to WAV: ${err.message}`));
            })
            .on('end', () => {
              logger.debug('Voice sample conversion complete');
              resolve();
            })
            .save(tempOutputPath);
        });

        // Read converted WAV
        finalBytes = fs.readFileSync(tempOutputPath);
        format = 'WAV (converted)';
        logger.info(`✓ Converted to WAV: ${finalBytes.length} bytes`);

      } finally {
        // Cleanup temp files
        try {
          if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
          if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);
        } catch (cleanupErr) {
          logger.warn('Failed to cleanup temp files:', cleanupErr);
        }
      }
    }

    // Log WAV info for debugging (Fish Speech handles various sample rates)
    if (format.includes('WAV')) {
      const wavInfo = extractWavInfo(finalBytes);
      const durationSeconds = wavInfo.pcmData.length / (wavInfo.sampleRate * wavInfo.channels * (wavInfo.bitsPerSample / 8));
      logger.info(`Voice sample: ${format}, ${wavInfo.sampleRate}Hz, ${wavInfo.channels}ch, ${wavInfo.bitsPerSample}-bit, ${durationSeconds.toFixed(1)}s`);

      if (durationSeconds < 3) {
        logger.warn(`⚠️  Voice sample is very short (${durationSeconds.toFixed(1)}s). Recommend 10-30 seconds for best voice cloning quality.`);
      }

      // Fish Speech accepts various sample rates - no resampling needed
    }

    const base64 = finalBytes.toString('base64');

    console.log(`Voice sample ready for TTS:`);
    console.log(`  - Format: ${format}`);
    console.log(`  - Size: ${finalBytes.length} bytes (${(finalBytes.length / 1024).toFixed(2)} KB)`);
    console.log(`  - Base64 length: ${base64.length} chars`);

    return base64;
  } catch (error) {
    console.error('Error downloading voice sample:', error);
    throw new Error(`Voice sample download failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// TTS settings interface
interface TTSJobSettings {
  emotionMarker?: string;
  temperature?: number;
  topP?: number;
  repetitionPenalty?: number;
  seed?: number;  // Fixed seed for deterministic/consistent voice output
}

// Start TTS job
async function startTTSJob(
  text: string,
  apiKey: string,
  referenceAudioBase64?: string,
  ttsSettings?: TTSJobSettings
): Promise<string> {
  const payloadSizeKB = referenceAudioBase64
    ? ((referenceAudioBase64.length * 0.75) / 1024).toFixed(2)
    : '0';

  logger.debug(`Starting TTS job (text: ${text.length} chars, voice sample: ${payloadSizeKB}KB)`);

  const inputPayload: Record<string, unknown> = {
    text: text,
  };

  if (referenceAudioBase64) {
    inputPayload.reference_audio_base64 = referenceAudioBase64;
  }

  // Pass TTS settings to RunPod worker
  if (ttsSettings) {
    if (ttsSettings.emotionMarker !== undefined) {
      // Convert "none" (used for Radix Select compatibility) to empty string
      inputPayload.emotion_marker = ttsSettings.emotionMarker === "none" ? "" : ttsSettings.emotionMarker;
    }
    if (ttsSettings.temperature !== undefined) {
      inputPayload.temperature = ttsSettings.temperature;
    }
    if (ttsSettings.topP !== undefined) {
      inputPayload.top_p = ttsSettings.topP;
    }
    if (ttsSettings.repetitionPenalty !== undefined) {
      inputPayload.repetition_penalty = ttsSettings.repetitionPenalty;
    }
    if (ttsSettings.seed !== undefined) {
      inputPayload.seed = ttsSettings.seed;
    }
  }

  try {
    const requestBody = JSON.stringify({ input: inputPayload });
    const requestSizeMB = (requestBody.length / 1024 / 1024).toFixed(2);

    if (parseFloat(requestSizeMB) > 50) {
      throw new Error(`Request payload too large: ${requestSizeMB}MB (RunPod limit is ~50MB). Try using a smaller voice sample.`);
    }

    logger.info(`[RunPod] POST /run (${requestSizeMB}MB, ${text.length} chars)...`);

    // Abort if the POST hangs — prevents the whole regen from silently stalling
    // on a dead TCP connection to RunPod.
    const ctrl = new AbortController();
    const timeoutMs = 45_000;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(`${RUNPOD_API_URL}/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: requestBody,
        signal: ctrl.signal,
      });
    } catch (err) {
      if ((err as any)?.name === 'AbortError') {
        throw new Error(`RunPod /run timed out after ${timeoutMs}ms (hung connection)`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`RunPod API error: ${response.status} ${response.statusText}`);
      logger.error(`Error response: ${errorText.substring(0, 500)}`);
      throw new Error(`Failed to start TTS job: HTTP ${response.status} - ${errorText.substring(0, 200)}`);
    }

    const result = await response.json() as any;

    if (!result.id) {
      throw new Error('No job ID returned from RunPod');
    }

    logger.info(`[RunPod] job ${result.id} accepted`);
    return result.id;
  } catch (error) {
    logger.error(`Failed to start TTS job: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

// Poll job status with adaptive polling and delayTime optimization
async function pollJobStatus(jobId: string, apiKey: string): Promise<{ audio_base64: string; sample_rate: number }> {
  const maxAttempts = 300; // Increased from 120 to handle slower workers (5 min timeout)
  let pollInterval = TTS_JOB_POLL_INTERVAL_INITIAL;

  logger.debug(`Polling job ${jobId}`);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(`${RUNPOD_API_URL}/status/${jobId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Poll failed: HTTP ${response.status} - ${errorText}`);
      throw new Error(`Failed to poll job status: ${response.status}`);
    }

    const result = await response.json() as any;

    if (result.status === 'COMPLETED') {
      if (!result.output?.audio_base64) {
        logger.error('Missing audio_base64 in output:', result.output);
        throw new Error('No audio_base64 in completed job output');
      }
      logger.debug(`Job ${jobId} completed: ${result.output.audio_base64.length} chars`);
      return result.output;
    }

    if (result.status === 'FAILED') {
      logger.error(`TTS job ${jobId} failed: ${result.error || 'Unknown error'}`);
      throw new Error(`TTS job failed: ${result.error || 'Unknown error'}`);
    }

    // Use delayTime hint from RunPod if available (smarter polling)
    let sleepTime = pollInterval;
    if (result.delayTime && result.delayTime > pollInterval) {
      // Use RunPod's estimate, capped at 1.5 seconds
      sleepTime = Math.min(result.delayTime, 1500);
    }

    // Adaptive polling: gradually increase interval after first 3 attempts
    if (attempt >= 3) {
      pollInterval = Math.min(pollInterval * 1.15, TTS_JOB_POLL_INTERVAL_MAX);
    }

    await new Promise(resolve => setTimeout(resolve, sleepTime));
  }

  logger.error(`Job ${jobId} timed out after ${maxAttempts} attempts`);
  throw new Error('TTS job timed out after 5 minutes');
}

// Retry TTS chunk generation with exponential backoff
async function generateTTSChunkWithRetry(
  chunkText: string,
  apiKey: string,
  referenceAudioBase64: string | undefined,
  chunkIndex: number,
  totalChunks: number,
  ttsSettings?: TTSJobSettings
): Promise<Buffer> {
  let lastError: Error | null = null;

  // Apply pronunciation fixes RIGHT before TTS (not stored in display text)
  const ttsText = applyPronunciationFixes(chunkText);

  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 0) {
        const delay = Math.min(
          RETRY_INITIAL_DELAY * Math.pow(2, attempt - 1),
          RETRY_MAX_DELAY
        );
        logger.info(`Retry attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS} for chunk ${chunkIndex + 1}/${totalChunks} after ${delay}ms delay`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      logger.debug(`Starting TTS job for chunk ${chunkIndex + 1}/${totalChunks} (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS})`);
      const jobId = await startTTSJob(ttsText, apiKey, referenceAudioBase64, ttsSettings);
      const output = await pollJobStatus(jobId, apiKey);
      const audioData = base64ToBuffer(output.audio_base64);

      // Check for excessive silence in the generated audio
      const silenceCheck = detectSilentAudio(audioData);
      if (silenceCheck.isSilent) {
        // Treat excessive silence as a failure and retry
        logger.warn(`⚠️  Chunk ${chunkIndex + 1}/${totalChunks} has ${silenceCheck.silencePercent.toFixed(0)}% silence (${silenceCheck.durationSeconds.toFixed(1)}s) - retrying...`);
        logger.debug(`Silent chunk text: "${chunkText.substring(0, 100)}..."`);

        // If this is not the last attempt, throw to trigger retry
        if (attempt < RETRY_MAX_ATTEMPTS - 1) {
          throw new Error(`Chunk produced ${silenceCheck.silencePercent.toFixed(0)}% silence`);
        }
        // On last attempt, log warning but accept the result
        logger.warn(`⚠️  Chunk ${chunkIndex + 1}/${totalChunks} still has ${silenceCheck.silencePercent.toFixed(0)}% silence after ${RETRY_MAX_ATTEMPTS} attempts - accepting result`);
      }

      if (attempt > 0) {
        logger.info(`✓ Chunk ${chunkIndex + 1}/${totalChunks} succeeded on attempt ${attempt + 1}`);
      }

      return audioData;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logger.warn(`Attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS} failed for chunk ${chunkIndex + 1}/${totalChunks}: ${lastError.message}`);
      // Loop will continue and delay is handled at the start of next iteration
    }
  }

  // All retries exhausted - return null to skip this chunk rather than failing entirely
  logger.error(`✗ Chunk ${chunkIndex + 1}/${totalChunks} FAILED after ${RETRY_MAX_ATTEMPTS} attempts: ${lastError?.message}`);
  throw lastError || new Error('TTS chunk generation failed after all retries');
}

// Convert base64 to buffer
function base64ToBuffer(base64: string): Buffer {
  return Buffer.from(base64, 'base64');
}

// Detect if a WAV chunk contains excessive silence (>50% of duration)
// Returns { isSilent: boolean, silencePercent: number, durationSeconds: number }
function detectSilentAudio(wavBuffer: Buffer): { isSilent: boolean; silencePercent: number; durationSeconds: number } {
  try {
    // Find the data chunk
    const dataMarker = Buffer.from('data', 'ascii');
    let dataIdx = -1;
    for (let i = 0; i <= wavBuffer.length - 4; i++) {
      if (wavBuffer.slice(i, i + 4).equals(dataMarker)) {
        dataIdx = i;
        break;
      }
    }
    if (dataIdx === -1) return { isSilent: false, silencePercent: 0, durationSeconds: 0 };

    const dataStart = dataIdx + 8;
    const dataSize = wavBuffer.readUInt32LE(dataIdx + 4);
    const dataEnd = Math.min(wavBuffer.length, dataStart + dataSize);

    // Read PCM samples (16-bit signed)
    const samples: number[] = [];
    for (let i = dataStart; i < dataEnd - 1; i += 2) {
      samples.push(wavBuffer.readInt16LE(i));
    }

    if (samples.length === 0) return { isSilent: false, silencePercent: 0, durationSeconds: 0 };

    // Calculate RMS in 100ms windows, count silent windows
    const sampleRate = 24000; // Chatterbox outputs 24kHz
    const windowSize = Math.floor(sampleRate * 0.1); // 100ms
    const numWindows = Math.floor(samples.length / windowSize);
    const silenceThreshold = 500; // RMS below this is considered silence

    let silentWindows = 0;
    for (let w = 0; w < numWindows; w++) {
      const start = w * windowSize;
      const end = start + windowSize;
      const window = samples.slice(start, end);

      // Calculate RMS
      const sumSquares = window.reduce((sum, s) => sum + s * s, 0);
      const rms = Math.sqrt(sumSquares / window.length);

      if (rms < silenceThreshold) {
        silentWindows++;
      }
    }

    const silencePercent = numWindows > 0 ? (silentWindows / numWindows) * 100 : 0;
    const durationSeconds = samples.length / sampleRate;
    const isSilent = silencePercent > 50; // More than 50% silence is problematic

    return { isSilent, silencePercent, durationSeconds };
  } catch (err) {
    // If we can't analyze, assume it's fine
    return { isSilent: false, silencePercent: 0, durationSeconds: 0 };
  }
}

// Concatenate multiple WAV files
function concatenateWavFiles(audioChunks: Buffer[]): { wav: Buffer; durationSeconds: number } {
  if (audioChunks.length === 0) {
    throw new Error('No audio chunks to concatenate');
  }

  const findChunk = (bytes: Buffer, fourcc: string) => {
    const needle = Buffer.from(fourcc, 'ascii');
    for (let i = 0; i <= bytes.length - 4; i++) {
      if (bytes.slice(i, i + 4).equals(needle)) {
        return i;
      }
    }
    return -1;
  };

  const extract = (wav: Buffer) => {
    if (wav.length < 16) throw new Error('WAV chunk too small');

    const riff = wav.slice(0, 4).toString('ascii');
    const wave = wav.slice(8, 12).toString('ascii');
    if (riff !== 'RIFF' || wave !== 'WAVE') {
      console.warn('Unexpected WAV header (not RIFF/WAVE); attempting to parse anyway');
    }

    const fmtIdx = findChunk(wav, 'fmt ');
    const dataIdx = findChunk(wav, 'data');
    if (fmtIdx === -1) throw new Error('Missing fmt chunk in WAV');
    if (dataIdx === -1) throw new Error('Missing data chunk in WAV');

    const fmtDataStart = fmtIdx + 8;
    const audioFormat = wav.readUInt16LE(fmtDataStart + 0);
    const channels = wav.readUInt16LE(fmtDataStart + 2);
    const sampleRate = wav.readUInt32LE(fmtDataStart + 4);
    const byteRate = wav.readUInt32LE(fmtDataStart + 8);
    const bitsPerSample = wav.readUInt16LE(fmtDataStart + 14);

    if (audioFormat !== 1) {
      console.warn(`Non-PCM WAV detected (audioFormat=${audioFormat}). Browser playback may fail.`);
    }

    const dataSizeOffset = dataIdx + 4;
    const dataSize = wav.readUInt32LE(dataSizeOffset);
    const dataStart = dataIdx + 8;
    const dataEnd = Math.min(wav.length, dataStart + dataSize);

    const header = wav.slice(0, dataStart);
    const data = wav.slice(dataStart, dataEnd);

    return { header, data, dataIdx, dataSizeOffset, sampleRate, channels, bitsPerSample, byteRate };
  };

  const first = extract(audioChunks[0]);
  const extracted = audioChunks.map(extract);
  const totalDataSize = extracted.reduce((sum, e) => sum + e.data.length, 0);

  const output = Buffer.alloc(first.header.length + totalDataSize);
  first.header.copy(output, 0);

  output.writeUInt32LE(output.length - 8, 4);
  output.writeUInt32LE(totalDataSize, first.dataSizeOffset);

  // Simple concatenation without crossfading - crossfading causes memory corruption
  // TODO: Implement proper crossfading algorithm
  let offset = first.header.length;
  for (const e of extracted) {
    e.data.copy(output, offset);
    offset += e.data.length;
  }

  const safeByteRate = first.byteRate || (first.sampleRate * first.channels * (first.bitsPerSample / 8));
  const durationSeconds = safeByteRate > 0 ? totalDataSize / safeByteRate : 0;

  return { wav: output, durationSeconds };
}

// Concatenate WAV files with automatic pause insertion based on text punctuation
function concatenateWavFilesWithPauses(
  audioChunks: Buffer[],
  textChunks: string[]
): { wav: Buffer; durationSeconds: number } {
  if (audioChunks.length === 0) {
    throw new Error('No audio chunks to concatenate');
  }

  // Build array of buffers including silence between chunks
  const buffersWithPauses: Buffer[] = [];

  for (let i = 0; i < audioChunks.length; i++) {
    // Add the audio chunk
    buffersWithPauses.push(audioChunks[i]);

    // Add silence after chunk based on punctuation (except for last chunk)
    const isLastChunk = i === audioChunks.length - 1;
    const chunkText = textChunks[i] || '';
    const pauseDuration = getPauseDuration(chunkText, isLastChunk);

    if (pauseDuration > 0) {
      // Get audio format from first chunk to match silence format
      const wavInfo = extractWavInfo(audioChunks[0]);
      const silenceBuffer = generateSilence(
        pauseDuration,
        wavInfo.sampleRate,
        wavInfo.channels,
        wavInfo.bitsPerSample
      );
      buffersWithPauses.push(silenceBuffer);
      logger.debug(`Added ${pauseDuration}s pause after chunk ${i + 1} ending with: "${chunkText.slice(-20)}"`);
    }
  }

  // Use existing concatenation logic
  return concatenateWavFiles(buffersWithPauses);
}

// Adjust audio speed using FFmpeg.
// speed < 1.0 = slower (longer duration), speed > 1.0 = faster (shorter duration).
//
// Writes input/output through temp files rather than piping. FFmpeg's WAV muxer
// emits 0xFFFFFFFF for RIFF and data size fields when it can't seek back on its
// output stream — non-seekable pipes always trip this. File paths are seekable,
// so FFmpeg patches the size fields correctly.
async function adjustAudioSpeed(wavBuffer: Buffer, speed: number): Promise<Buffer> {
  if (speed === 1.0) {
    return wavBuffer;
  }

  const clampedSpeed = Math.max(0.5, Math.min(2.0, speed));
  logger.info(`Adjusting audio speed: ${clampedSpeed}x`);

  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inputPath = path.join(os.tmpdir(), `speed-in-${tag}.wav`);
  const outputPath = path.join(os.tmpdir(), `speed-out-${tag}.wav`);

  await fs.promises.writeFile(inputPath, wavBuffer);

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .inputFormat('wav')
        .audioFilters(`atempo=${clampedSpeed}`)
        .format('wav')
        .on('error', (err) => {
          logger.error('FFmpeg error:', err);
          reject(err);
        })
        .on('end', () => resolve())
        .save(outputPath);
    });

    const result = await fs.promises.readFile(outputPath);
    logger.info(`Speed adjustment complete: ${wavBuffer.length} -> ${result.length} bytes`);
    return result;
  } finally {
    await fs.promises.unlink(inputPath).catch(() => {});
    await fs.promises.unlink(outputPath).catch(() => {});
  }
}

// Main route handler
router.post('/', async (req: Request, res: Response) => {
  const { script, voiceSampleUrl, projectId, stream, speed = 1, ttsSettings = {}, segmentationMode } = req.body;
  // Progressive segmentation (10s first 30 min, 30s after) is the default.
  // Opt back into the old 19-segment layout by explicitly sending
  // segmentationMode: 'legacy'. The previous opt-in default silently fell
  // back to legacy whenever the frontend bundle lagged behind a deploy,
  // burning money on unintended re-generations.
  const segMode: SegmentationMode = segmentationMode === 'legacy' ? 'legacy' : 'progressive';

  // Extract TTS settings with defaults
  const emotionMarker = ttsSettings.emotionMarker ?? '(sincere) (soft tone)';
  const ttsTemperature = ttsSettings.temperature ?? 0.9;
  const ttsTopP = ttsSettings.topP ?? 0.85;
  const ttsRepetitionPenalty = ttsSettings.repetitionPenalty ?? 1.1;

  // Create settings object to pass through call chain
  const ttsJobSettings: TTSJobSettings = {
    emotionMarker,
    temperature: ttsTemperature,
    topP: ttsTopP,
    repetitionPenalty: ttsRepetitionPenalty,
  };

  // Log raw input immediately with more detail
  const rawWordCount = script ? script.split(/\s+/).filter(Boolean).length : 0;
  console.log(`\n[AUDIO REQUEST] Raw script: ${script?.length || 0} chars, ${rawWordCount} words, stream=${stream}, speed=${speed}, voiceSampleUrl=${voiceSampleUrl ? 'YES' : 'NO'}`);
  console.log(`[AUDIO DEBUG] Script first 500 chars: "${script?.substring(0, 500)}"`);
  console.log(`[AUDIO DEBUG] Script last 200 chars: "${script?.slice(-200)}"`);

  // Helper to send SSE error events when streaming
  const sendStreamError = (error: string) => {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
    }
    res.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
    res.end();
  };

  try {
    if (!script) {
      if (stream) {
        return sendStreamError('Script is required');
      }
      return res.status(400).json({ error: 'Script is required' });
    }

    const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
    if (!RUNPOD_API_KEY) {
      if (stream) {
        return sendStreamError('RUNPOD_API_KEY not configured');
      }
      return res.status(500).json({ error: 'RUNPOD_API_KEY not configured' });
    }

    // Clean script - remove markdown and metadata
    let cleanScript = script
      // Remove hashtags (with or without spaces) - entire lines
      .replace(/^#.*$/gm, '')
      // Remove standalone ALL CAPS lines (section headers like OPENING, CONCLUSION, etc.)
      .replace(/^[A-Z\s]{3,}$/gm, '')
      // Remove markdown headers (entire lines starting with #)
      .replace(/^#{1,6}\s+.*$/gm, '')
      // Remove markdown horizontal rules (---, ***, ___) - these cause TTS silence
      .replace(/^[-*_]{3,}$/gm, '')
      // Remove scene markers
      .replace(/\[SCENE \d+\]/g, '')
      .replace(/\[[^\]]+\]/g, '')
      // Remove markdown bold/italic markers (keep text)
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
      // Remove inline hashtags (like #TheMedievalTavern in middle of text)
      .replace(/#\S+/g, '')
      // Remove parenthetical metadata like (5-10 minutes)
      .replace(/\([^)]*minutes?\)/gi, '')
      // Clean up excessive newlines
      .replace(/\n{3,}/g, '\n\n')
      // Remove leading/trailing whitespace
      .trim();

    // Log what was cleaned
    const originalWordCount = script.split(/\s+/).filter(Boolean).length;
    const cleanedWordCount = cleanScript.split(/\s+/).filter(Boolean).length;
    const wordsRemoved = originalWordCount - cleanedWordCount;
    console.log(`[AUDIO DEBUG] After cleaning: ${cleanedWordCount} words (removed ${wordsRemoved})`);
    console.log(`[AUDIO DEBUG] CleanScript first 500: "${cleanScript.substring(0, 500)}"`);
    if (wordsRemoved > 0) {
      logger.info(`Cleaned script: removed ${wordsRemoved} words (headers, metadata, etc.)`);
      logger.debug(`  Original: ${originalWordCount} words, Cleaned: ${cleanedWordCount} words`);
    }

    cleanScript = normalizeText(cleanScript);
    console.log(`[AUDIO DEBUG] After normalizeText: ${cleanScript.length} chars`);
    console.log(`[AUDIO DEBUG] Normalized first 500: "${cleanScript.substring(0, 500)}"`);

    // Remove repetitions from source text BEFORE TTS generation (proactive)
    const { cleaned, removedCount } = removeTextRepetitions(cleanScript);
    if (removedCount > 0) {
      logger.info(`Removed ${removedCount} duplicate sentences before TTS generation`);
      cleanScript = cleaned;
    }

    const wordCount = cleanScript.split(/\s+/).filter(Boolean).length;
    logger.info(`Generating audio for ${wordCount} words with Chatterbox TTS...`);
    logger.debug(`Normalized text length: ${cleanScript.length} chars`);
    logger.debug(`First 200 chars: "${cleanScript.substring(0, 200)}..."`);

    const rawChunks = splitIntoChunks(cleanScript, MAX_TTS_CHUNK_LENGTH);
    logger.debug(`Split into ${rawChunks.length} chunks`);

    const chunks: string[] = [];
    for (let i = 0; i < rawChunks.length; i++) {
      if (!validateTTSInput(rawChunks[i])) {
        logger.warn(`Skipping chunk ${i + 1} (invalid): "${rawChunks[i].substring(0, 50)}..."`);
        const reasons: string[] = [];
        if (!rawChunks[i]) reasons.push('empty');
        else if (rawChunks[i].trim().length < MIN_TEXT_LENGTH) reasons.push(`too short (${rawChunks[i].trim().length} chars)`);
        else if (rawChunks[i].length > MAX_TEXT_LENGTH) reasons.push(`too long (${rawChunks[i].length} chars)`);
        else if (/[^\x00-\x7F]/.test(rawChunks[i])) {
          const nonAscii = rawChunks[i].match(/[^\x00-\x7F]/g) || [];
          reasons.push(`non-ASCII chars: ${[...new Set(nonAscii)].slice(0, 10).join(', ')}`);
        }
        else if (!/[a-zA-Z0-9]/.test(rawChunks[i])) reasons.push('no alphanumeric chars');
        logger.warn(`  Reasons: ${reasons.join(', ')}`);
        continue;
      }
      chunks.push(rawChunks[i]);
    }

    if (chunks.length === 0) {
      console.error(`[AUDIO DEBUG] ALL ${rawChunks.length} chunks failed validation!`);
      console.error(`[AUDIO DEBUG] First 3 raw chunks:`);
      rawChunks.slice(0, 3).forEach((c, i) => {
        console.error(`  Chunk ${i}: "${c.substring(0, 100)}..." (${c.length} chars)`);
        console.error(`    - Length OK: ${c.trim().length >= MIN_TEXT_LENGTH}`);
        console.error(`    - Under max: ${c.length <= MAX_TEXT_LENGTH}`);
        console.error(`    - ASCII only: ${!/[^\x00-\x7F]/.test(c)}`);
        console.error(`    - Has alphanum: ${/[a-zA-Z0-9]/.test(c)}`);
        if (/[^\x00-\x7F]/.test(c)) {
          const nonAscii = c.match(/[^\x00-\x7F]/g) || [];
          console.error(`    - Non-ASCII chars: ${[...new Set(nonAscii)].join(', ')}`);
        }
      });
      const errorMsg = 'No valid text chunks after validation. Script may contain only special characters or be too short.';
      if (stream) {
        return sendStreamError(errorMsg);
      }
      return res.status(400).json({ error: errorMsg });
    }

    logger.info(`Using ${chunks.length} valid chunks (skipped ${rawChunks.length - chunks.length} invalid)`);

    // Log first 3 chunks for debugging
    if (chunks.length > 0) {
      logger.info(`First chunk preview: "${chunks[0].substring(0, 100)}..."`);
      if (chunks.length > 1) logger.debug(`Second chunk preview: "${chunks[1].substring(0, 100)}..."`);
      if (chunks.length > 2) logger.debug(`Third chunk preview: "${chunks[2].substring(0, 100)}..."`);
    }

    // Flip current_step to 'audio' BEFORE dispatching so the frontend polling
    // fallback (src/lib/api.ts) doesn't race with the first segment completion
    // and resolve against the previous run's stale audio_url + current_step.
    // Only applies when regenerating an existing project; new projects skip it.
    if (projectId) {
      try {
        await markAudioGenerationStarted(projectId);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to start audio generation';
        logger.error(`[AUDIO] ${errorMsg}`);
        if (stream) {
          return sendStreamError(errorMsg);
        }
        return res.status(500).json({ error: errorMsg });
      }
    }

    // Voice cloning support - now generates 10 separate segments
    if (voiceSampleUrl && stream) {
      logger.info(`Using streaming mode with voice cloning (segmentation=${segMode})`);
      return handleVoiceCloningStreaming(req, res, cleanScript, projectId, wordCount, RUNPOD_API_KEY, voiceSampleUrl, speed, ttsJobSettings, segMode);
    }

    if (stream) {
      return handleStreaming(req, res, chunks, projectId, wordCount, RUNPOD_API_KEY, speed, ttsJobSettings);
    } else {
      return handleNonStreaming(req, res, chunks, projectId, wordCount, RUNPOD_API_KEY, voiceSampleUrl, speed, ttsJobSettings);
    }

  } catch (error) {
    logger.error('Error generating audio:', error);
    const errorMsg = error instanceof Error ? error.message : 'Audio generation failed';

    if (stream) {
      return sendStreamError(errorMsg);
    }
    return res.status(500).json({ error: errorMsg });
  }
});

// Handle streaming without voice cloning (SEQUENTIAL - Memory optimized)
async function handleStreaming(req: Request, res: Response, chunks: string[], projectId: string, wordCount: number, apiKey: string, speed: number = 1, ttsJobSettings?: TTSJobSettings) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Keep connection alive with heartbeat every 15 seconds
  const heartbeatInterval = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  try {
    sendEvent({ type: 'progress', progress: 5, message: `Starting Chatterbox TTS (${chunks.length} chunks, default voice)...` });

    console.log(`\n=== Processing ${chunks.length} chunks sequentially (no voice cloning) ===`);
    sendEvent({ type: 'progress', progress: 10, message: `Processing ${chunks.length} chunks...` });

    const audioChunks: Buffer[] = [];
    const successfulTextChunks: string[] = []; // Track text for pause insertion

    // Process each chunk sequentially (no voice cloning in streaming mode)
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      console.log(`Processing chunk ${i + 1}/${chunks.length}: "${chunkText.substring(0, 50)}..."`);

      const progress = 10 + Math.round(((i + 1) / chunks.length) * 65);
      sendEvent({ type: 'progress', progress, message: `Generating audio chunk ${i + 1}/${chunks.length}...` });

      try {
        // Use retry logic with exponential backoff
        const audioData = await generateTTSChunkWithRetry(chunkText, apiKey, undefined, i, chunks.length, ttsJobSettings);
        audioChunks.push(audioData);
        successfulTextChunks.push(chunkText); // Track successful text
        console.log(`Chunk ${i + 1} completed: ${audioData.length} bytes`);
      } catch (err) {
        console.error(`Failed to process chunk ${i + 1} after all retries:`, err);
        logger.warn(`Skipping chunk ${i + 1} due to error: ${err instanceof Error ? err.message : 'Unknown error'}`);
        // Continue with next chunk instead of failing completely
      }
    }

    if (audioChunks.length === 0) {
      throw new Error('All audio chunks failed to generate');
    }

    console.log(`Successfully generated ${audioChunks.length}/${chunks.length} audio chunks`);

    sendEvent({ type: 'progress', progress: 70, message: 'Concatenating audio chunks with pauses...' });

    // Use pause-aware concatenation for consistent breaks
    let { wav: finalAudio, durationSeconds } = concatenateWavFilesWithPauses(audioChunks, successfulTextChunks);

    console.log(`Concatenated audio: ${finalAudio.length} bytes from ${audioChunks.length} chunks`);

    // Check audio integrity BEFORE upload (skip if file too large to avoid V8 crash)
    const MAX_INTEGRITY_CHECK_SIZE = 50 * 1024 * 1024; // 50MB threshold
    let integrityResult: AudioIntegrityResult;
    if (finalAudio.length <= MAX_INTEGRITY_CHECK_SIZE) {
      sendEvent({ type: 'progress', progress: 78, message: 'Verifying audio integrity...' });
      integrityResult = checkAudioIntegrity(finalAudio, {
        silenceThresholdMs: 1500,
        glitchThresholdDb: 25,
        sampleWindowMs: 50,
      });
      logAudioIntegrity(integrityResult, 'non-streaming audio');
    } else {
      logger.info(`[INTEGRITY] Skipping check (${(finalAudio.length / 1024 / 1024).toFixed(1)}MB > ${MAX_INTEGRITY_CHECK_SIZE / 1024 / 1024}MB threshold)`);
      // Return minimal result when skipping
      integrityResult = {
        valid: true,
        issues: [],
        stats: {
          durationSeconds: durationSeconds,
          avgAmplitude: 0,
          maxAmplitude: 0,
          silencePercent: 0,
          discontinuities: 0,
        },
      };
    }

    // Apply speed adjustment if not 1.0
    if (speed !== 1.0) {
      sendEvent({ type: 'progress', progress: 80, message: `Adjusting speed to ${speed}x...` });
      finalAudio = await adjustAudioSpeed(finalAudio, speed);
      // Adjust duration based on speed (slower = longer, faster = shorter)
      durationSeconds = durationSeconds / speed;
    }

    const durationRounded = Math.round(durationSeconds);
    console.log(`Final audio: ${finalAudio.length} bytes, ${durationRounded}s`);

    sendEvent({ type: 'progress', progress: 90, message: 'Uploading audio file...' });

    const credentials = getSupabaseCredentials();
    if (!credentials) {
      sendEvent({ type: 'error', error: 'Supabase credentials not configured' });
      res.end();
      return;
    }

    const supabase = createClient(credentials.url, credentials.key);
    const fileName = `${projectId || crypto.randomUUID()}/voiceover.wav`;

    const { error: uploadError } = await supabase.storage
      .from('generated-assets')
      .upload(fileName, finalAudio, {
        contentType: 'audio/wav',
        upsert: true,
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      const errorMsg = `Failed to upload audio: ${uploadError.message || JSON.stringify(uploadError)}`;
      sendEvent({ type: 'error', error: errorMsg });
      res.end();
      return;
    }

    const { data: urlData } = supabase.storage
      .from('generated-assets')
      .getPublicUrl(fileName);

    console.log('Audio uploaded:', urlData.publicUrl);

    // Get audio issues for response
    const audioIssues = integrityResult.issues.filter(i => i.type === 'skip' || i.type === 'discontinuity');

    sendEvent({
      type: 'complete',
      audioUrl: urlData.publicUrl,
      duration: durationRounded,
      size: finalAudio.length,
      audioIntegrity: {
        valid: integrityResult.valid,
        issueCount: audioIssues.length,
        issues: audioIssues.slice(0, 5).map(i => ({
          type: i.type,
          timestamp: i.timestamp,
          description: i.description,
        })),
      },
    });
    res.end();

  } catch (error) {
    console.error('Audio error:', error);
    sendEvent({ type: 'error', error: error instanceof Error ? error.message : 'Audio generation failed' });
    res.end();
  } finally {
    clearInterval(heartbeatInterval);
  }
}

// Audio segment result type
interface AudioSegmentResult {
  index: number;
  audioUrl: string;
  duration: number;
  size: number;
  text: string;
}

// Handle streaming with voice cloning - generates N separate segments
async function handleVoiceCloningStreaming(req: Request, res: Response, script: string, projectId: string, wordCount: number, apiKey: string, voiceSampleUrl: string, speed: number = 1, ttsJobSettings?: TTSJobSettings, segMode: SegmentationMode = 'legacy') {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Keep connection alive with heartbeat every 15 seconds
  const heartbeatInterval = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  try {
    // Log input script stats for debugging
    const inputWordCount = script.split(/\s+/).filter(Boolean).length;
    console.log(`\n========================================`);
    console.log(`INPUT SCRIPT STATS:`);
    console.log(`  - Characters: ${script.length}`);
    console.log(`  - Words: ${inputWordCount}`);
    console.log(`  - Expected duration: ~${Math.round(inputWordCount / 150)} minutes`);
    console.log(`  - First 200 chars: "${script.substring(0, 200)}..."`);
    console.log(`========================================\n`);

    // Split script. Legacy mode preserves the 19-segment layout; progressive
    // mode chops the first 30 min into 10s segments and the rest into 30s.
    const segments = splitIntoSegments(script, speed, segMode);
    const actualSegmentCount = segments.length;
    logger.info(`Segmentation: mode=${segMode}, speed=${speed}, segments=${actualSegmentCount}`);

    // Log segment breakdown
    console.log(`SEGMENT BREAKDOWN:`);
    segments.forEach((seg, i) => {
      const segWords = seg.split(/\s+/).filter(Boolean).length;
      console.log(`  Segment ${i + 1}: ${segWords} words, ${seg.length} chars`);
    });

    sendEvent({ type: 'progress', progress: 5 });

    sendEvent({ type: 'progress', progress: 8 });

    const referenceAudioBase64 = await downloadVoiceSample(voiceSampleUrl);
    console.log(`Voice sample ready: ${referenceAudioBase64.length} chars base64`);

    const credentials = getSupabaseCredentials();
    if (!credentials) {
      sendEvent({ type: 'error', error: 'Supabase credentials not configured' });
      res.end();
      return;
    }

    const supabase = createClient(credentials.url, credentials.key);
    const actualProjectId = projectId || crypto.randomUUID();

    // Match Fish Speech RunPod worker allocation. Progressive mode can produce
    // 300+ segments, so allow scaling up via env var without redeploy. Default
    // stays at 10 for legacy-mode parity.
    const MAX_CONCURRENT_SEGMENTS = parseInt(process.env.MAX_CONCURRENT_SEGMENTS ?? '10', 10);
    console.log(`\n=== Processing ${actualSegmentCount} segments with rolling concurrency (max ${MAX_CONCURRENT_SEGMENTS} concurrent) ===`);

    const allSegmentResults: Array<{
      index: number;
      audioUrl: string;
      duration: number;
      size: number;
      text: string;
      audioBuffer: Buffer | null; // null until we re-download for concatenation
      durationSeconds: number;
    }> = [];

    let nextSegmentIndex = 0;
    const activeSegments = new Map<number, Promise<void>>();

    // Helper to process a single segment
    const processSegment = async (segIdx: number): Promise<void> => {
      const segmentText = segments[segIdx];
      const segmentNumber = segIdx + 1;

      console.log(`\n--- Segment ${segmentNumber}/${actualSegmentCount} STARTED ---`);
      console.log(`Text: "${segmentText.substring(0, 100)}..."`);

      try {
        // Split this segment into TTS chunks
        const rawChunks = splitIntoChunks(segmentText, MAX_TTS_CHUNK_LENGTH);
        const chunks: string[] = [];
        let skippedChunks = 0;

        for (const chunk of rawChunks) {
          if (validateTTSInput(chunk)) {
            chunks.push(chunk);
          } else {
            skippedChunks++;
            const reasons: string[] = [];
            if (!chunk) reasons.push('empty');
            else if (chunk.trim().length < MIN_TEXT_LENGTH) reasons.push(`too short (${chunk.trim().length} chars)`);
            else if (chunk.length > MAX_TEXT_LENGTH) reasons.push(`too long (${chunk.length} chars)`);
            else if (/[^\x00-\x7F]/.test(chunk)) reasons.push('contains non-ASCII');
            else if (!/[a-zA-Z0-9]/.test(chunk)) reasons.push('no alphanumeric chars');
            console.log(`  SKIPPED chunk in segment ${segmentNumber}: ${reasons.join(', ')} - "${chunk.substring(0, 50)}..."`);
          }
        }

        if (chunks.length === 0) {
          console.log(`  WARNING: Segment ${segmentNumber} has no valid chunks (${rawChunks.length} raw, ${skippedChunks} skipped)`);
          return;
        }

        console.log(`  Segment ${segmentNumber}: ${chunks.length}/${rawChunks.length} chunks valid (${skippedChunks} skipped)`);

        // Use incremental concatenation to reduce memory usage (don't accumulate all chunks)
        let segmentAudio: Buffer | null = null;
        let totalDurationSeconds = 0;
        let successfulChunks = 0;
        let lastSuccessfulChunkText = ''; // Track for pause insertion

        // Process each chunk in this segment sequentially
        for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
          const chunkText = chunks[chunkIdx];

          const completed = allSegmentResults.length;
          const baseProgress = 10 + Math.round((completed / actualSegmentCount) * 75);
          const chunkProgress = baseProgress + Math.round(
            ((chunkIdx + 1) / chunks.length) * (75 / actualSegmentCount)
          );

          sendEvent({
            type: 'progress',
            progress: Math.min(chunkProgress, 85)
          });

          try {
            const audioData = await generateTTSChunkWithRetry(chunkText, apiKey, referenceAudioBase64, chunkIdx, chunks.length, ttsJobSettings);
            console.log(`  Segment ${segmentNumber} - Chunk ${chunkIdx + 1}/${chunks.length}: ${audioData.length} bytes`);

            // Incrementally concatenate instead of accumulating in array
            if (segmentAudio === null) {
              segmentAudio = audioData;
            } else {
              // Add pause based on previous chunk's ending punctuation
              const pauseDuration = getPauseDuration(lastSuccessfulChunkText, false);
              if (pauseDuration > 0) {
                const wavInfo = extractWavInfo(segmentAudio);
                const silenceBuffer = generateSilence(pauseDuration, wavInfo.sampleRate, wavInfo.channels, wavInfo.bitsPerSample);
                const { wav: withPause } = concatenateWavFiles([segmentAudio, silenceBuffer]);
                segmentAudio = withPause;
                logger.debug(`Added ${pauseDuration}s pause after: "${lastSuccessfulChunkText.slice(-20)}"`);
              }
              const { wav: combined, durationSeconds } = concatenateWavFiles([segmentAudio, audioData]);
              totalDurationSeconds = durationSeconds;
              segmentAudio = combined; // Replace with combined version
            }
            successfulChunks++;
            lastSuccessfulChunkText = chunkText;

            // Clear audioData buffer immediately (help GC)
            // TypeScript doesn't allow deleting, but we've already used it
          } catch (err) {
            logger.warn(`Skipping chunk ${chunkIdx + 1} in segment ${segmentNumber} after all retries: ${err instanceof Error ? err.message : 'Unknown error'}`);
          }
        }

        if (segmentAudio === null || successfulChunks === 0) {
          logger.warn(`All chunks failed for segment ${segmentNumber}, skipping`);
          return;
        }

        // Calculate final duration
        const durationSeconds = totalDurationSeconds;
        const durationRounded = Math.round(durationSeconds * 10) / 10;

        console.log(`Segment ${segmentNumber} audio: ${segmentAudio.length} bytes, ${durationRounded}s`);

        // CRITICAL: Apply FFmpeg smoothing to eliminate click/pop glitches at chunk boundaries
        logger.info(`[SEGMENT ${segmentNumber}] Applying audio smoothing (highpass 20Hz, lowpass 20kHz)...`);
        try {
          segmentAudio = await smoothAudioWithFFmpeg(segmentAudio, {
            highpassFreq: 20,   // Remove DC offset and subsonic rumble (reduces pops)
            lowpassFreq: 20000, // Remove ultrasonic artifacts (reduces clicks)
          });
          logger.info(`[SEGMENT ${segmentNumber}] Smoothing applied successfully`);
        } catch (err) {
          logger.warn(`[SEGMENT ${segmentNumber}] Smoothing failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
          // Continue with unsmoothed audio - better to have glitches than no audio
        }

        // Check segment audio integrity IMMEDIATELY after concatenation
        const segmentIntegrity = checkAudioIntegrity(segmentAudio, {
          silenceThresholdMs: 1500,
          glitchThresholdDb: 25,
          sampleWindowMs: 50,
        });

        const glitches = segmentIntegrity.issues.filter(i => i.type === 'glitch');
        if (glitches.length > 0) {
          logger.error(`[SEGMENT ${segmentNumber}] Detected ${glitches.length} click/pop glitches:`);
          glitches.slice(0, 3).forEach(g => {
            logger.error(`  - ${g.description}`);
          });
          // Log warning but continue - crossfading should prevent this in future generations
        } else {
          logger.info(`[SEGMENT ${segmentNumber}] Audio integrity: CLEAN (no glitches)`);
        }

        // Upload this segment
        const fileName = `${actualProjectId}/voiceover-segment-${segmentNumber}.wav`;

        const { error: uploadError } = await supabase.storage
          .from('generated-assets')
          .upload(fileName, segmentAudio, {
            contentType: 'audio/wav',
            upsert: true,
          });

        if (uploadError) {
          logger.error(`Failed to upload segment ${segmentNumber}: ${uploadError.message}`);
          throw new Error(`Failed to upload segment ${segmentNumber}: ${uploadError.message}`);
        }

        const { data: urlData } = supabase.storage
          .from('generated-assets')
          .getPublicUrl(fileName);

        console.log(`Segment ${segmentNumber} COMPLETED: ${urlData.publicUrl}`);

        // Store result (WITHOUT buffer to save memory - we'll re-download later)
        // Add cache buster to prevent browser/CDN serving old cached audio after regeneration
        const cacheBustedSegmentUrl = `${urlData.publicUrl}?t=${Date.now()}`;
        allSegmentResults.push({
          index: segmentNumber,
          audioUrl: cacheBustedSegmentUrl,
          duration: durationRounded,
          size: segmentAudio.length,
          text: segmentText,
          audioBuffer: null as any, // Placeholder - will download later
          durationSeconds,
        });

        // Send progress update
        const completed = allSegmentResults.length;
        sendEvent({
          type: 'progress',
          progress: 10 + Math.round((completed / actualSegmentCount) * 75)
        });

        // Save progress after each completed segment (fire-and-forget)
        if (projectId && allSegmentResults.length > 0) {
          saveAudioProgress(projectId, allSegmentResults.map(r => ({
            index: r.index,
            audioUrl: r.audioUrl,
            duration: r.duration,
            text: r.text,
          })), 'generating').catch(err =>
            console.warn('[Audio] Failed to save progress:', err)
          );
        }

      } catch (err) {
        logger.error(`Segment ${segmentNumber} failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    };

    // Helper to start next segment
    const startNextSegment = async (): Promise<void> => {
      if (nextSegmentIndex >= actualSegmentCount) return;

      const segIdx = nextSegmentIndex;
      nextSegmentIndex++;

      const promise = processSegment(segIdx).finally(() => {
        activeSegments.delete(segIdx);
      });

      activeSegments.set(segIdx, promise);
    };

    // Fill initial window with segments
    const initialBatch = Math.min(MAX_CONCURRENT_SEGMENTS, actualSegmentCount);
    console.log(`Starting initial batch of ${initialBatch} segments...`);
    for (let i = 0; i < initialBatch; i++) {
      await startNextSegment();
    }

    // Process remaining segments as active ones complete
    while (activeSegments.size > 0) {
      // Wait for any segment to complete
      await Promise.race(Array.from(activeSegments.values()));

      // Start next segment if available
      if (nextSegmentIndex < actualSegmentCount) {
        await startNextSegment();
      }
    }

    // Sort results by segment index
    const segmentResults = allSegmentResults.sort((a, b) => a.index - b.index);

    if (segmentResults.length === 0) {
      throw new Error('All segments failed to generate');
    }

    logger.info(`All ${segmentResults.length} segments uploaded successfully`);
    segmentResults.forEach((seg, idx) => {
      logger.debug(`  Segment ${seg.index}: ${seg.audioUrl} (${seg.size} bytes, ${seg.duration}s)`);
    });

    sendEvent({ type: 'progress', progress: 88 });

    // True streaming concatenation: process ONE segment at a time
    console.log(`\n=== Streaming concatenation of ${segmentResults.length} segments ===`);

    // Helper to extract WAV metadata and data
    const extractWavData = (wav: Buffer) => {
      const findChunk = (bytes: Buffer, fourcc: string) => {
        const needle = Buffer.from(fourcc, 'ascii');
        for (let i = 0; i <= bytes.length - 4; i++) {
          if (bytes.slice(i, i + 4).equals(needle)) return i;
        }
        return -1;
      };

      const fmtIdx = findChunk(wav, 'fmt ');
      const dataIdx = findChunk(wav, 'data');
      if (fmtIdx === -1 || dataIdx === -1) throw new Error('Invalid WAV format');

      const fmtDataStart = fmtIdx + 8;
      const sampleRate = wav.readUInt32LE(fmtDataStart + 4);
      const byteRate = wav.readUInt32LE(fmtDataStart + 8);
      const channels = wav.readUInt16LE(fmtDataStart + 2);
      const bitsPerSample = wav.readUInt16LE(fmtDataStart + 14);

      const dataSize = wav.readUInt32LE(dataIdx + 4);
      const dataStart = dataIdx + 8;
      const data = wav.slice(dataStart, Math.min(wav.length, dataStart + dataSize));

      return { header: wav.slice(0, dataStart), data, dataIdx, sampleRate, byteRate, channels, bitsPerSample };
    };

    // Step 1: Download first segment to get header and calculate total size
    console.log(`Step 1: Downloading first segment for header info...`);
    const firstFileName = `${actualProjectId}/voiceover-segment-${segmentResults[0].index}.wav`;
    console.log(`Attempting to download: ${firstFileName} from generated-assets bucket`);

    // First, verify the file exists
    const { data: listData, error: listError } = await supabase.storage
      .from('generated-assets')
      .list(actualProjectId);

    if (listError) {
      logger.error(`Failed to list files in ${actualProjectId}:`, listError);
    } else {
      logger.info(`Files in ${actualProjectId}:`, listData?.map(f => f.name).join(', '));
    }

    const { data: firstData, error: firstError } = await supabase.storage
      .from('generated-assets')
      .download(firstFileName);

    if (firstError || !firstData) {
      // Log all possible error properties
      logger.error(`Download failed for ${firstFileName}`);
      logger.error(`  Error object type: ${typeof firstError}`);
      logger.error(`  Error constructor: ${firstError?.constructor?.name}`);
      logger.error(`  Error message: ${firstError?.message}`);
      logger.error(`  Error name: ${(firstError as any)?.name}`);
      logger.error(`  Error statusCode: ${(firstError as any)?.statusCode}`);
      logger.error(`  Error error: ${(firstError as any)?.error}`);
      logger.error(`  Full error: ${JSON.stringify(firstError)}`);
      logger.error(`  Error keys: ${firstError ? Object.keys(firstError).join(', ') : 'none'}`);
      logger.error(`  Error getOwnPropertyNames: ${firstError ? Object.getOwnPropertyNames(firstError).join(', ') : 'none'}`);
      logger.error(`  Data exists: ${!!firstData}, Error exists: ${!!firstError}`);

      const errorMsg = firstError?.message || (firstError as any)?.error || JSON.stringify(firstError) || 'Unknown error';
      throw new Error(`Failed to download first segment (${firstFileName}): ${errorMsg}`);
    }

    const firstBuffer = Buffer.from(await firstData.arrayBuffer());
    const firstExtracted = extractWavData(firstBuffer);

    // Calculate total PCM size (first segment + estimate for remaining based on file sizes)
    let totalPcmSize = firstExtracted.data.length;
    const headerSize = firstExtracted.header.length;

    for (let i = 1; i < segmentResults.length; i++) {
      // Estimate PCM size as (total file size - header overhead ~100 bytes)
      totalPcmSize += Math.max(0, segmentResults[i].size - 100);
    }

    console.log(`Estimated total PCM size: ${totalPcmSize} bytes from ${segmentResults.length} segments`);

    sendEvent({ type: 'progress', progress: 90 });

    // Step 2: Allocate output buffer
    const combinedAudio = Buffer.alloc(headerSize + totalPcmSize);

    // Copy header from first segment
    firstExtracted.header.copy(combinedAudio, 0);

    // Update size fields
    const dataIdxInCombined = firstExtracted.dataIdx;
    combinedAudio.writeUInt32LE(combinedAudio.length - 8, 4); // RIFF size
    combinedAudio.writeUInt32LE(totalPcmSize, dataIdxInCombined + 4); // data size

    // Step 3: Copy first segment's PCM data
    let offset = headerSize;
    firstExtracted.data.copy(combinedAudio, offset);
    offset += firstExtracted.data.length;
    console.log(`Segment 1: copied ${firstExtracted.data.length} bytes, offset now ${offset}`);

    // Clear first buffer (help GC)
    firstBuffer.fill(0);

    // Step 4: Stream remaining segments one at a time
    for (let i = 1; i < segmentResults.length; i++) {
      const result = segmentResults[i];
      const fileName = `${actualProjectId}/voiceover-segment-${result.index}.wav`;

      console.log(`Streaming segment ${i + 1}/${segmentResults.length}: ${fileName}...`);

      const { data, error } = await supabase.storage
        .from('generated-assets')
        .download(fileName);

      if (error || !data) {
        const errorDetails = error ? JSON.stringify(error, null, 2) : 'No error details';
        logger.error(`Download failed for segment ${result.index} (${fileName}):`, errorDetails);
        throw new Error(`Failed to download segment ${result.index} (${fileName}): ${error?.message || errorDetails}`);
      }

      const buffer = Buffer.from(await data.arrayBuffer());
      const extracted = extractWavData(buffer);

      // Copy just the PCM data
      extracted.data.copy(combinedAudio, offset);
      offset += extracted.data.length;

      console.log(`Segment ${i + 1}: copied ${extracted.data.length} bytes, offset now ${offset}`);

      // Clear buffer immediately (only holds 1 segment at a time)
      buffer.fill(0);
    }

    // Adjust final size if estimate was off - MUST trim buffer to actual size
    const actualCombinedSize = offset;
    let trimmedAudio: Buffer;
    if (actualCombinedSize !== combinedAudio.length) {
      console.log(`Size adjustment: estimated ${combinedAudio.length}, actual ${actualCombinedSize} - trimming buffer`);
      // CRITICAL: Copy to new buffer of actual size to avoid garbage bytes at end
      trimmedAudio = Buffer.from(combinedAudio.subarray(0, actualCombinedSize));
      trimmedAudio.writeUInt32LE(actualCombinedSize - 8, 4);
      trimmedAudio.writeUInt32LE(actualCombinedSize - headerSize, dataIdxInCombined + 4);
    } else {
      trimmedAudio = combinedAudio;
    }

    let totalDuration = segmentResults.reduce((sum, r) => sum + r.durationSeconds, 0);
    let combinedDuration = firstExtracted.byteRate > 0 ? (actualCombinedSize - headerSize) / firstExtracted.byteRate : totalDuration;

    console.log(`Combined audio: ${trimmedAudio.length} bytes, ${Math.round(combinedDuration)}s`);

    let finalAudio: Buffer = trimmedAudio;

    // NOTE: Smoothing skipped for combined audio (238MB causes V8 memory error)
    // Smoothing already applied per-segment (where chunk glitches occur)

    // CRITICAL: Skip integrity check on large files to avoid V8 crash
    // checkAudioIntegrity() loads ALL samples into array (119M samples for 238MB = V8 limit exceeded)
    // Segments already checked individually, so this is redundant for large files
    const MAX_INTEGRITY_CHECK_SIZE = 50 * 1024 * 1024; // 50MB threshold
    let integrityResult: AudioIntegrityResult;
    let audioIssues: AudioIssue[] = [];

    if (finalAudio.length <= MAX_INTEGRITY_CHECK_SIZE) {
      sendEvent({ type: 'progress', progress: 91, message: 'Verifying audio integrity...' });
      integrityResult = checkAudioIntegrity(finalAudio, {
        silenceThresholdMs: 1500,
        glitchThresholdDb: 25,
        sampleWindowMs: 50,
      });
      logAudioIntegrity(integrityResult, 'combined audio');

      // Include integrity warnings in the response (but don't fail generation)
      audioIssues = integrityResult.issues.filter(i => i.type === 'skip' || i.type === 'discontinuity');
      if (audioIssues.length > 0) {
        logger.warn(`Audio integrity issues detected: ${audioIssues.length} potential skips/discontinuities`);
        audioIssues.slice(0, 5).forEach(issue => {
          logger.warn(`  ${issue.type} at ${issue.timestamp.toFixed(2)}s: ${issue.description}`);
        });
      }
    } else {
      logger.info(`[INTEGRITY] Skipping combined audio check (${(finalAudio.length / 1024 / 1024).toFixed(1)}MB > ${MAX_INTEGRITY_CHECK_SIZE / 1024 / 1024}MB threshold)`);
      logger.info(`[INTEGRITY] Per-segment checks already completed - this is redundant for large files`);
      // Return minimal result when skipping
      integrityResult = {
        valid: true,
        issues: [],
        stats: {
          durationSeconds: combinedDuration,
          avgAmplitude: 0,
          maxAmplitude: 0,
          silencePercent: 0,
          discontinuities: 0,
        },
      };
    }

    // Apply speed adjustment if not 1.0
    if (speed !== 1.0) {
      sendEvent({ type: 'progress', progress: 92, message: `Adjusting speed to ${speed}x...` });
      finalAudio = await adjustAudioSpeed(finalAudio, speed);
      // Adjust duration based on speed (slower = longer, faster = shorter)
      combinedDuration = combinedDuration / speed;
      totalDuration = totalDuration / speed;
      console.log(`Speed-adjusted audio: ${finalAudio.length} bytes, ${Math.round(combinedDuration)}s`);
    }

    const combinedFileName = `${actualProjectId}/voiceover.wav`;
    sendEvent({ type: 'progress', progress: 95 });

    console.log(`\n=== Uploading combined audio ===`);
    console.log(`Final audio: ${finalAudio.length} bytes, ${Math.round(combinedDuration)}s`);

    const { error: combinedUploadError } = await supabase.storage
      .from('generated-assets')
      .upload(combinedFileName, finalAudio, {
        contentType: 'audio/wav',
        upsert: true,
      });

    if (combinedUploadError) {
      logger.error(`Failed to upload combined audio: ${combinedUploadError.message}`);
      throw new Error(`Failed to upload combined audio: ${combinedUploadError.message}`);
    }

    const { data: combinedUrlData } = supabase.storage
      .from('generated-assets')
      .getPublicUrl(combinedFileName);

    // Add cache-busting timestamp to prevent browser showing stale audio after regeneration
    const cacheBustedAudioUrl = `${combinedUrlData.publicUrl}?t=${Date.now()}`;

    sendEvent({ type: 'progress', progress: 98 });

    console.log(`\n=== All ${segmentResults.length} segments complete ===`);
    console.log(`Combined audio URL: ${cacheBustedAudioUrl}`);
    console.log(`Total duration: ${Math.round(totalDuration)}s`);

    // Save cost to Supabase (Fish Speech: $0.004/minute of audio output)
    if (projectId) {
      const durationMinutes = totalDuration / 60;
      saveCost({
        projectId,
        source: 'manual',
        step: 'audio',
        service: 'fish_speech',
        units: durationMinutes,
        unitType: 'minutes',
      }).catch(err => console.error('[cost-tracker] Failed to save audio cost:', err));
    }

    // Clean up segment results for client (remove internal fields)
    const cleanedSegments: AudioSegmentResult[] = segmentResults.map(r => ({
      index: r.index,
      audioUrl: r.audioUrl,
      duration: r.duration,
      size: r.size,
      text: r.text,
    }));

    // Save to project database (fire-and-forget - allows user to close browser)
    if (projectId) {
      saveAudioToProject(projectId, cacheBustedAudioUrl, Math.round(combinedDuration), cleanedSegments)
        .then(result => {
          if (result.success) {
            console.log(`[Audio] Saved to project ${projectId}`);
          } else {
            console.warn(`[Audio] Failed to save to project: ${result.error}`);
          }
        })
        .catch(err => console.error(`[Audio] Error saving to project:`, err));
    }

    sendEvent({
      type: 'complete',
      success: true,
      audioUrl: cacheBustedAudioUrl, // Combined audio for playback (cache-busted)
      duration: Math.round(combinedDuration),
      size: finalAudio.length,
      segments: cleanedSegments, // Individual segments for regeneration
      totalDuration: Math.round(totalDuration),
      wordCount,
      // Include audio integrity info for frontend warning display
      audioIntegrity: {
        valid: integrityResult.valid,
        issueCount: audioIssues.length,
        issues: audioIssues.slice(0, 5).map(i => ({
          type: i.type,
          timestamp: i.timestamp,
          description: i.description,
        })),
      },
    });
    res.end();

  } catch (error) {
    console.error('Audio error:', error);
    // Note: Completed segments are already saved incrementally after each completion
    // No need to save again here - the last successful save has the latest state
    sendEvent({ type: 'error', error: error instanceof Error ? error.message : 'Audio generation failed' });
    res.end();
  } finally {
    clearInterval(heartbeatInterval);
  }
}

// Handle non-streaming (with or without voice cloning) - SEQUENTIAL - Memory optimized
async function handleNonStreaming(req: Request, res: Response, chunks: string[], projectId: string, wordCount: number, apiKey: string, voiceSampleUrl?: string, speed: number = 1, ttsJobSettings?: TTSJobSettings) {
  let referenceAudioBase64: string | undefined;
  if (voiceSampleUrl) {
    console.log('Downloading voice sample for cloning...');
    referenceAudioBase64 = await downloadVoiceSample(voiceSampleUrl);
    console.log(`Voice sample ready: ${referenceAudioBase64.length} chars base64`);
  }

  console.log(`\n=== Processing ${chunks.length} chunks sequentially ===`);

  const audioChunks: Buffer[] = [];
  const successfulTextChunks: string[] = []; // Track text for pause insertion

  // Process each chunk sequentially
  for (let i = 0; i < chunks.length; i++) {
    const chunkText = chunks[i];
    console.log(`Processing chunk ${i + 1}/${chunks.length}: "${chunkText.substring(0, 50)}..."`);

    try {
      // Start the TTS job with reference_audio_base64 for cloning (if provided)
      const jobId = await startTTSJob(chunkText, apiKey, referenceAudioBase64, ttsJobSettings);
      console.log(`TTS job started with ID: ${jobId}`);

      // Poll for completion
      const output = await pollJobStatus(jobId, apiKey);

      // Decode audio
      const audioData = base64ToBuffer(output.audio_base64);
      audioChunks.push(audioData);
      successfulTextChunks.push(chunkText); // Track successful text
      console.log(`Chunk ${i + 1} completed: ${audioData.length} bytes`);
    } catch (err) {
      console.error(`Failed to process chunk ${i + 1}:`, err);
      logger.warn(`Skipping chunk ${i + 1} due to error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      // Continue with next chunk instead of failing completely
    }
  }

  if (audioChunks.length === 0) {
    return res.status(500).json({ success: false, error: 'All audio chunks failed to generate' });
  }

  console.log(`Successfully generated ${audioChunks.length}/${chunks.length} audio chunks`);

  // Use pause-aware concatenation for consistent breaks
  const { wav: combinedAudio, durationSeconds: combinedDurationSeconds } = concatenateWavFilesWithPauses(
    audioChunks,
    successfulTextChunks
  );
  let durationSeconds = combinedDurationSeconds;

  console.log(`Concatenated audio: ${combinedAudio.length} bytes from ${audioChunks.length} chunks`);

  let finalAudio = combinedAudio;

  // Apply speed adjustment if not 1.0
  if (speed !== 1.0) {
    console.log(`Adjusting speed to ${speed}x...`);
    finalAudio = await adjustAudioSpeed(finalAudio, speed);
    // Adjust duration based on speed (slower = longer, faster = shorter)
    durationSeconds = durationSeconds / speed;
    console.log(`Speed-adjusted audio: ${finalAudio.length} bytes, ${Math.round(durationSeconds)}s`);
  }

  const durationRounded = Math.round(durationSeconds);
  console.log(`Final audio: ${finalAudio.length} bytes, ${durationRounded}s`);

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return res.status(500).json({ error: 'Supabase credentials not configured' });
  }

  const supabase = createClient(credentials.url, credentials.key);
  const fileName = `${projectId || crypto.randomUUID()}/voiceover.wav`;

  const { error: uploadError } = await supabase.storage
    .from('generated-assets')
    .upload(fileName, finalAudio, {
      contentType: 'audio/wav',
      upsert: true,
    });

  if (uploadError) {
    console.error('Upload error:', uploadError);
    throw new Error(`Failed to upload audio: ${uploadError.message || JSON.stringify(uploadError)}`);
  }

  const { data: urlData } = supabase.storage
    .from('generated-assets')
    .getPublicUrl(fileName);

  // Save cost to Supabase (Fish Speech: $0.004/minute of audio output)
  if (projectId) {
    const durationMinutes = durationSeconds / 60;
    saveCost({
      projectId,
      source: 'manual',
      step: 'audio',
      service: 'fish_speech',
      units: durationMinutes,
      unitType: 'minutes',
    }).catch(err => console.error('[cost-tracker] Failed to save audio cost:', err));
  }

  return res.json({
    success: true,
    audioUrl: urlData.publicUrl,
    duration: durationRounded,
    wordCount,
    size: finalAudio.length
  });
}

// Regenerate a single segment (with optional pronunciation fix)
router.post('/segment', async (req: Request, res: Response) => {
  const { segmentText, segmentIndex, voiceSampleUrl, projectId, pronunciationFix, ttsSettings } = req.body;
  // pronunciationFix: { word: string, phonetic: string } - optional one-off fix for this segment
  // ttsSettings: { temperature, topP, repetitionPenalty } - same settings as original audio

  try {
    if (!segmentText) {
      return res.status(400).json({ error: 'segmentText is required' });
    }
    if (!segmentIndex || segmentIndex < 1) {
      return res.status(400).json({ error: 'segmentIndex must be a positive integer' });
    }
    if (!voiceSampleUrl) {
      return res.status(400).json({ error: 'voiceSampleUrl is required' });
    }
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
    if (!RUNPOD_API_KEY) {
      return res.status(500).json({ error: 'RUNPOD_API_KEY not configured' });
    }

    const credentials = getSupabaseCredentials();
    if (!credentials) {
      return res.status(500).json({ error: 'Supabase credentials not configured' });
    }

    logger.info(`Regenerating segment ${segmentIndex} for project ${projectId}`);

    // Download voice sample
    const referenceAudioBase64 = await downloadVoiceSample(voiceSampleUrl);
    console.log(`Voice sample ready: ${referenceAudioBase64.length} chars base64`);

    // Clean segment text - remove markdown and metadata (same as main endpoint)
    const cleanSegmentText = segmentText
      // Remove hashtags (with or without spaces) - entire lines
      .replace(/^#.*$/gm, '')
      // Remove standalone ALL CAPS lines (section headers like OPENING, CONCLUSION, etc.)
      .replace(/^[A-Z\s]{3,}$/gm, '')
      // Remove markdown headers (entire lines starting with #)
      .replace(/^#{1,6}\s+.*$/gm, '')
      // Remove markdown horizontal rules (---, ***, ___) - these cause TTS silence
      .replace(/^[-*_]{3,}$/gm, '')
      // Remove scene markers
      .replace(/\[SCENE \d+\]/g, '')
      .replace(/\[[^\]]+\]/g, '')
      // Remove markdown bold/italic markers (keep text)
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
      // Remove inline hashtags (like #TheMedievalTavern in middle of text)
      .replace(/#\S+/g, '')
      // Remove parenthetical metadata like (5-10 minutes)
      .replace(/\([^)]*minutes?\)/gi, '')
      // Clean up excessive newlines
      .replace(/\n{3,}/g, '\n\n')
      // Remove leading/trailing whitespace
      .trim();

    // Normalize and chunk the segment text
    const normalizedText = normalizeText(cleanSegmentText);
    console.log(`[SEGMENT ${segmentIndex}] Original text (${cleanSegmentText.length} chars):\n${cleanSegmentText.substring(0, 500)}...`);
    console.log(`[SEGMENT ${segmentIndex}] Normalized text (${normalizedText.length} chars):\n${normalizedText.substring(0, 500)}...`);

    const rawChunks = splitIntoChunks(normalizedText, MAX_TTS_CHUNK_LENGTH);
    console.log(`[SEGMENT ${segmentIndex}] Raw chunks: ${rawChunks.length}`);
    rawChunks.forEach((c, i) => console.log(`  Chunk ${i+1}: "${c.substring(0, 80)}..."`));

    const chunks: string[] = [];

    for (const chunk of rawChunks) {
      if (validateTTSInput(chunk)) {
        chunks.push(chunk);
      }
    }

    if (chunks.length === 0) {
      return res.status(400).json({ error: 'No valid text chunks in segment' });
    }

    // Process chunks in parallel batches. Reduced from 5→2 on 2026-04: each
    // request carries the full voice sample base64 (~3-5MB), so 5 parallel
    // requests = ~20MB burst upload which was causing hangs under RunPod
    // worker saturation. 2 is a safer sweet spot; override via env.
    const PARALLEL_CHUNKS = Number(process.env.SEGMENT_REGEN_PARALLEL_CHUNKS || 2);
    console.log(`Segment ${segmentIndex}: processing ${chunks.length} chunks in batches of ${PARALLEL_CHUNKS}`);

    const results: { index: number; audio: Buffer; text: string }[] = [];

    for (let batch = 0; batch < chunks.length; batch += PARALLEL_CHUNKS) {
      const batchChunks = chunks.slice(batch, batch + PARALLEL_CHUNKS);
      const batchEnd = Math.min(batch + PARALLEL_CHUNKS, chunks.length);
      console.log(`Processing batch ${Math.floor(batch / PARALLEL_CHUNKS) + 1}: chunks ${batch + 1}-${batchEnd}/${chunks.length}`);

      const batchPromises = batchChunks.map(async (chunkText, i) => {
        const chunkIndex = batch + i;
        const chunkStart = Date.now();
        console.log(`  ➤ chunk ${chunkIndex + 1}/${chunks.length}: starting (${chunkText.length} chars)`);
        try {
          // Apply global pronunciation fixes
          let ttsText = applyPronunciationFixes(chunkText);

          // Apply one-off pronunciation fix if provided
          if (pronunciationFix?.word) {
            // If no phonetic provided, auto-lookup from dictionary
            const phonetic = pronunciationFix.phonetic || lookupPhonetic(pronunciationFix.word);
            // Escape special regex characters in the word
            const escapedWord = pronunciationFix.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`\\b${escapedWord}\\b`, 'gi');
            const before = ttsText;
            ttsText = ttsText.replace(regex, phonetic);
            if (before !== ttsText) {
              console.log(`[ONE-OFF FIX] "${pronunciationFix.word}" → "${phonetic}"${!pronunciationFix.phonetic ? ' (auto-lookup)' : ''}`);
            }
          }

          // Pass TTS settings to match original audio voice characteristics
          const ttsJobSettings = ttsSettings ? {
            temperature: ttsSettings.temperature,
            topP: ttsSettings.topP,
            repetitionPenalty: ttsSettings.repetitionPenalty,
          } : undefined;

          const jobId = await startTTSJob(ttsText, RUNPOD_API_KEY, referenceAudioBase64, ttsJobSettings);
          const output = await pollJobStatus(jobId, RUNPOD_API_KEY);
          const audioData = base64ToBuffer(output.audio_base64);

          const elapsed = ((Date.now() - chunkStart) / 1000).toFixed(1);
          console.log(`  ✓ chunk ${chunkIndex + 1}/${chunks.length}: ${audioData.length} bytes (${elapsed}s)`);
          return { index: chunkIndex, audio: audioData, text: chunkText };
        } catch (err) {
          const elapsed = ((Date.now() - chunkStart) / 1000).toFixed(1);
          logger.warn(`  ✗ chunk ${chunkIndex + 1}/${chunks.length} FAILED after ${elapsed}s: ${err instanceof Error ? err.message : 'Unknown error'}`);
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      for (const result of batchResults) {
        if (result !== null) {
          results.push(result);
        }
      }
    }

    if (results.length === 0) {
      return res.status(500).json({ error: 'All chunks failed to generate' });
    }

    // Sort by index to maintain correct order, then extract audio buffers and text
    results.sort((a, b) => a.index - b.index);
    const audioChunks = results.map(r => r.audio);
    const textChunks = results.map(r => r.text);
    console.log(`Successfully processed ${audioChunks.length}/${chunks.length} chunks`)

    // Concatenate chunks with pause insertion based on punctuation
    const { wav: segmentAudio, durationSeconds } = concatenateWavFilesWithPauses(audioChunks, textChunks);
    const durationRounded = Math.round(durationSeconds * 10) / 10;

    console.log(`Segment ${segmentIndex} audio: ${segmentAudio.length} bytes, ${durationRounded}s`);

    // Upload to Supabase
    const supabase = createClient(credentials.url, credentials.key);
    const fileName = `${projectId}/voiceover-segment-${segmentIndex}.wav`;

    const { error: uploadError } = await supabase.storage
      .from('generated-assets')
      .upload(fileName, segmentAudio, {
        contentType: 'audio/wav',
        upsert: true,
      });

    if (uploadError) {
      logger.error(`Failed to upload segment: ${uploadError.message}`);
      return res.status(500).json({ error: `Upload failed: ${uploadError.message}` });
    }

    const { data: urlData } = supabase.storage
      .from('generated-assets')
      .getPublicUrl(fileName);

    // Add cache-busting timestamp to URL to force browser to reload
    const cacheBustedUrl = `${urlData.publicUrl}?t=${Date.now()}`;

    console.log(`Segment ${segmentIndex} regenerated: ${cacheBustedUrl}`);

    return res.json({
      success: true,
      segment: {
        index: segmentIndex,
        audioUrl: cacheBustedUrl,
        duration: durationRounded,
        size: segmentAudio.length,
        text: segmentText,
      },
    });

  } catch (error) {
    logger.error('Error regenerating segment:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Segment regeneration failed'
    });
  }
});

// Regenerate a single segment using segment text from DB (not caller).
// Simpler alternative to POST /segment — takes only {projectId, segmentNumber, voiceSampleUrl, ttsSettings?}
// and reads segment text from audio_segments. Intended for one-click "regenerate this segment"
// flows where the caller already trusts the DB as source of truth.
router.post('/regenerate-segment', async (req: Request, res: Response) => {
  const { projectId, segmentNumber, voiceSampleUrl, ttsSettings } = req.body;

  try {
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    if (!segmentNumber || typeof segmentNumber !== 'number' || segmentNumber < 1) {
      return res.status(400).json({ error: 'segmentNumber must be a positive integer' });
    }
    if (!voiceSampleUrl) return res.status(400).json({ error: 'voiceSampleUrl is required' });

    const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
    if (!RUNPOD_API_KEY) return res.status(500).json({ error: 'RUNPOD_API_KEY not configured' });

    const credentials = getSupabaseCredentials();
    if (!credentials) return res.status(500).json({ error: 'Supabase credentials not configured' });

    // Look up segment text from DB — this is the feature that differentiates
    // this endpoint from POST /segment.
    const projectData = await getProjectData(projectId);
    if (!projectData.exists) {
      return res.status(404).json({ error: `Project ${projectId} not found` });
    }
    const segments = projectData.audioSegments || [];
    const target = segments.find((s: any) => s.index === segmentNumber);
    if (!target || !target.text) {
      return res.status(404).json({ error: `Segment ${segmentNumber} not found in project audio_segments` });
    }

    logger.info(`[regenerate-segment] project=${projectId} segment=${segmentNumber} (text from DB: ${target.text.length} chars)`);

    const referenceAudioBase64 = await downloadVoiceSample(voiceSampleUrl);

    const cleanText = normalizeText(
      target.text
        .replace(/^#.*$/gm, '')
        .replace(/^[A-Z\s]{3,}$/gm, '')
        .replace(/^#{1,6}\s+.*$/gm, '')
        .replace(/^[-*_]{3,}$/gm, '')
        .replace(/\[SCENE \d+\]/g, '')
        .replace(/\[[^\]]+\]/g, '')
        .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
        .replace(/#\S+/g, '')
        .replace(/\([^)]*minutes?\)/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    );

    const rawChunks = splitIntoChunks(cleanText, MAX_TTS_CHUNK_LENGTH);
    const chunks = rawChunks.filter(validateTTSInput);
    if (chunks.length === 0) {
      return res.status(400).json({ error: 'No valid text chunks after cleaning segment text' });
    }

    const jobSettings: TTSJobSettings | undefined = ttsSettings ? {
      temperature: ttsSettings.temperature,
      topP: ttsSettings.topP,
      repetitionPenalty: ttsSettings.repetitionPenalty,
      seed: ttsSettings.seed,
      emotionMarker: ttsSettings.emotionMarker,
    } : undefined;

    const PARALLEL_CHUNKS = 5;
    const results: { index: number; audio: Buffer; text: string }[] = [];

    for (let batch = 0; batch < chunks.length; batch += PARALLEL_CHUNKS) {
      const batchChunks = chunks.slice(batch, batch + PARALLEL_CHUNKS);
      const batchPromises = batchChunks.map(async (chunkText, i) => {
        const chunkIndex = batch + i;
        try {
          const ttsText = applyPronunciationFixes(chunkText);
          const jobId = await startTTSJob(ttsText, RUNPOD_API_KEY, referenceAudioBase64, jobSettings);
          const output = await pollJobStatus(jobId, RUNPOD_API_KEY);
          const audioData = base64ToBuffer(output.audio_base64);
          return { index: chunkIndex, audio: audioData, text: chunkText };
        } catch (err) {
          logger.warn(`[regenerate-segment] chunk ${chunkIndex + 1} failed: ${err instanceof Error ? err.message : 'unknown'}`);
          return null;
        }
      });
      const batchResults = await Promise.all(batchPromises);
      for (const r of batchResults) if (r) results.push(r);
    }

    if (results.length === 0) {
      return res.status(500).json({ error: 'All chunks failed to generate' });
    }

    results.sort((a, b) => a.index - b.index);
    const audioChunks = results.map(r => r.audio);
    const textChunks = results.map(r => r.text);
    const { wav: segmentAudio, durationSeconds } = concatenateWavFilesWithPauses(audioChunks, textChunks);
    const durationRounded = Math.round(durationSeconds * 10) / 10;

    const supabase = createClient(credentials.url, credentials.key);
    const fileName = `${projectId}/voiceover-segment-${segmentNumber}.wav`;
    const { error: uploadError } = await supabase.storage
      .from('generated-assets')
      .upload(fileName, segmentAudio, { contentType: 'audio/wav', upsert: true });
    if (uploadError) {
      return res.status(500).json({ error: `Upload failed: ${uploadError.message}` });
    }

    const { data: urlData } = supabase.storage.from('generated-assets').getPublicUrl(fileName);
    const cacheBustedUrl = `${urlData.publicUrl}?t=${Date.now()}`;

    logger.info(`[regenerate-segment] segment ${segmentNumber} uploaded: ${cacheBustedUrl}`);

    return res.json({
      success: true,
      segment: {
        index: segmentNumber,
        audioUrl: cacheBustedUrl,
        duration: durationRounded,
        size: segmentAudio.length,
        text: target.text,
      },
    });
  } catch (error) {
    logger.error('[regenerate-segment] error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Segment regeneration failed',
    });
  }
});

// Parse SRT into WhisperSegment[] for loop detection.
// Shape: "1\n00:00:01,000 --> 00:00:02,500\nHello there\n\n2\n..."
function parseSrtToWhisperSegments(srt: string): WhisperSegment[] {
  const out: WhisperSegment[] = [];
  const blocks = srt.replace(/\r/g, '').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    const m = /^([\d:,]+)\s*-->\s*([\d:,]+)/.exec(lines[1]);
    if (!m) continue;
    const toSec = (t: string) => {
      const [hms, ms] = t.split(',');
      const [h, mn, s] = hms.split(':').map(Number);
      return h * 3600 + mn * 60 + s + Number(ms) / 1000;
    };
    out.push({
      start: toSec(m[1]),
      end: toSec(m[2]),
      text: lines.slice(2).join(' ').trim(),
    });
  }
  return out;
}

// Scan the project's SRT for repeated sentences. Text-only, no API calls.
// Returns the detected loops with their timestamps in the full audio.
router.post('/scan-loops', async (req: Request, res: Response) => {
  const { srtContent, projectId } = req.body;
  try {
    let srt: string | undefined = srtContent;
    let audioSegments: Array<{ index: number; duration: number; text?: string }> | undefined;
    if (projectId) {
      const projectData = await getProjectData(projectId);
      if (!projectData.exists) return res.status(404).json({ error: 'Project not found' });
      if (!srt) srt = (projectData as any).srtContent || undefined;
      audioSegments = (projectData.audioSegments as any[]) || undefined;
    }
    if (!srt) return res.status(400).json({ error: 'srtContent or projectId with stored SRT is required' });

    const segments = parseSrtToWhisperSegments(srt);
    if (segments.length < 2) return res.json({ loops: [] });

    const loops = detectRepetitions(segments);

    // Map each loop's full-audio timestamp back to its audio segment index
    // so the UI can say "Segment 12 has a loop" instead of just "3:25".
    // Uses cumulative segment durations — same math the combined audio uses.
    const segmentNumberAt = (sec: number): number | undefined => {
      if (!audioSegments || audioSegments.length === 0) return undefined;
      let cum = 0;
      for (const s of audioSegments) {
        const end = cum + (s.duration || 0);
        if (sec >= cum && sec < end) return s.index;
        cum = end;
      }
      // Past the end — attribute to the last segment
      return audioSegments[audioSegments.length - 1]?.index;
    };

    logger.info(`[scan-loops] project=${projectId || 'n/a'} segments=${segments.length} loops=${loops.length}`);
    return res.json({
      loops: loops.map(l => ({
        start: l.start,
        end: l.end,
        text: l.text,
        durationSec: l.end - l.start,
        segmentNumber: segmentNumberAt(l.start),
      })),
    });
  } catch (error) {
    logger.error('[scan-loops] error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Scan failed' });
  }
});


// Lookup phonetic spelling for a word (for auto-fill in frontend)
router.get('/phonetic/:word', (req: Request, res: Response) => {
  const word = req.params.word;
  if (!word) {
    return res.status(400).json({ error: 'word is required' });
  }
  const phonetic = lookupPhonetic(word);
  const isAutoGenerated = phonetic === word; // If same as input, we didn't find it
  return res.json({
    word,
    phonetic,
    found: !isAutoGenerated
  });
});

// Generate audio for a single word (for pronunciation preview)
router.post('/word', async (req: Request, res: Response) => {
  const { word, phonetic, voiceSampleUrl, sentenceContext, ttsSettings } = req.body;

  if (!word) {
    return res.status(400).json({ error: 'word is required' });
  }
  if (!voiceSampleUrl) {
    return res.status(400).json({ error: 'voiceSampleUrl is required' });
  }

  // Validate the voice sample URL
  const urlValidation = validateVoiceSampleUrl(voiceSampleUrl);
  if (!urlValidation.valid) {
    return res.status(400).json({ error: urlValidation.error });
  }

  const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
  if (!RUNPOD_API_KEY) {
    return res.status(500).json({ error: 'TTS service not configured' });
  }

  try {
    // Use phonetic if provided, otherwise use the word itself
    const pronunciation = phonetic || word;

    // If we have sentence context, replace the word with phonetic spelling in the actual sentence
    // This produces natural speech with the same voice instead of robotic "the correct pronunciation is..."
    let textToSpeak: string;
    if (sentenceContext) {
      // Escape special regex characters in the word
      const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Replace the word (case-insensitive) with the phonetic spelling
      const wordRegex = new RegExp(`\\b${escapedWord}\\b`, 'gi');
      textToSpeak = sentenceContext.replace(wordRegex, pronunciation);
    } else {
      // Fallback: repeat the word in a natural phrase
      textToSpeak = `${pronunciation}. ${pronunciation}. ${pronunciation}.`;
    }
    console.log(`[Word Preview] Generating audio for word "${word}" as "${pronunciation}" in context`);

    // Download voice sample and convert to base64 (same as main audio generation)
    // RunPod works better with base64 than URLs
    const referenceAudioBase64 = await downloadVoiceSample(voiceSampleUrl);
    console.log(`[Word Preview] Voice sample ready: ${referenceAudioBase64.length} chars base64`);

    // Build input payload with same TTS settings as original audio generation
    const inputPayload: Record<string, unknown> = {
      text: textToSpeak,
      reference_audio_base64: referenceAudioBase64,
    };

    // Apply TTS settings to match original voice characteristics
    if (ttsSettings) {
      if (ttsSettings.temperature !== undefined) {
        inputPayload.temperature = ttsSettings.temperature;
      }
      if (ttsSettings.topP !== undefined) {
        inputPayload.top_p = ttsSettings.topP;
      }
      if (ttsSettings.repetitionPenalty !== undefined) {
        inputPayload.repetition_penalty = ttsSettings.repetitionPenalty;
      }
    }

    // Start TTS job
    const startResponse = await fetch(`${RUNPOD_API_URL}/run`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RUNPOD_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: inputPayload }),
    });

    if (!startResponse.ok) {
      const errorText = await startResponse.text();
      console.error('[Word Preview] Failed to start TTS job:', errorText);
      return res.status(500).json({ error: 'Failed to start TTS job' });
    }

    const startResult = await startResponse.json();
    const jobId = startResult.id;

    if (!jobId) {
      return res.status(500).json({ error: 'No job ID returned from TTS service' });
    }

    // Poll for completion
    const startTime = Date.now();
    const timeout = 30000; // 30 second timeout for a single word

    while (Date.now() - startTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, 500));

      const statusResponse = await fetch(`${RUNPOD_API_URL}/status/${jobId}`, {
        headers: { 'Authorization': `Bearer ${RUNPOD_API_KEY}` },
      });

      if (!statusResponse.ok) {
        continue;
      }

      const statusResult = await statusResponse.json();

      if (statusResult.status === 'COMPLETED') {
        const audioBase64 = statusResult.output?.audio_base64;
        if (!audioBase64) {
          return res.status(500).json({ error: 'No audio returned from TTS' });
        }

        // Convert base64 to data URL for easy playback
        const audioDataUrl = `data:audio/wav;base64,${audioBase64}`;

        console.log(`[Word Preview] Successfully generated audio for "${word}"`);
        return res.json({
          success: true,
          word,
          phonetic: textToSpeak,
          audioUrl: audioDataUrl,
        });
      } else if (statusResult.status === 'FAILED') {
        console.error('[Word Preview] TTS job failed:', statusResult.error);
        return res.status(500).json({ error: 'TTS job failed' });
      }
    }

    return res.status(504).json({ error: 'TTS job timed out' });
  } catch (error) {
    console.error('[Word Preview] Error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Word preview generation failed'
    });
  }
});

// Recombine segments into a new combined audio file
router.post('/recombine', async (req: Request, res: Response) => {
  const { projectId, segmentCount } = req.body;

  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return res.status(500).json({ error: 'Supabase credentials not configured' });
  }

  const supabase = createClient(credentials.url, credentials.key);
  const numSegments = segmentCount || 10;

  try {
    console.log(`Recombining ${numSegments} segments for project ${projectId}...`);

    // Download all segment WAV files
    const segmentBuffers: Buffer[] = [];

    for (let i = 1; i <= numSegments; i++) {
      const segmentPath = `${projectId}/voiceover-segment-${i}.wav`;

      const { data, error } = await supabase.storage
        .from('generated-assets')
        .download(segmentPath);

      if (error || !data) {
        console.error(`Failed to download segment ${i}: ${error?.message}`);
        return res.status(404).json({ error: `Segment ${i} not found` });
      }

      const arrayBuffer = await data.arrayBuffer();
      segmentBuffers.push(Buffer.from(arrayBuffer));
      console.log(`Downloaded segment ${i}: ${segmentBuffers[i-1].length} bytes`);
    }

    // Concatenate all segments
    const { wav: combinedAudio, durationSeconds } = concatenateWavFiles(segmentBuffers);
    console.log(`Combined audio: ${combinedAudio.length} bytes, ${durationSeconds.toFixed(1)}s`);

    // NOTE: Smoothing skipped - segments already smoothed before upload
    // Segment-to-segment boundaries are natural (no chunk glitches)

    // Upload combined audio
    const combinedFileName = `${projectId}/voiceover.wav`;
    const { error: uploadError } = await supabase.storage
      .from('generated-assets')
      .upload(combinedFileName, combinedAudio, {
        contentType: 'audio/wav',
        upsert: true
      });

    if (uploadError) {
      logger.error(`Failed to upload combined audio: ${uploadError.message}`);
      return res.status(500).json({ error: `Upload failed: ${uploadError.message}` });
    }

    const { data: urlData } = supabase.storage
      .from('generated-assets')
      .getPublicUrl(combinedFileName);

    // Add cache-busting timestamp
    const cacheBustedUrl = `${urlData.publicUrl}?t=${Date.now()}`;

    console.log(`Recombined audio uploaded: ${cacheBustedUrl}`);

    return res.json({
      success: true,
      audioUrl: cacheBustedUrl,
      duration: Math.round(durationSeconds * 10) / 10,
      size: combinedAudio.length
    });

  } catch (error) {
    logger.error('Error recombining segments:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Recombine failed'
    });
  }
});

export default router;
