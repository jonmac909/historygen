/**
 * Script QA - Compare original script to Whisper transcription
 * Detects TTS mistakes by finding mismatches between what was supposed to be said
 * and what Whisper actually heard.
 *
 * Includes both sentence-level and word-level comparison.
 */

export interface QAIssue {
  type: 'missing' | 'garbled' | 'extra' | 'mismatch';
  originalText: string;
  transcribedText: string;
  similarity?: number;
  severity: 'warning' | 'error';
  segmentNumber?: number;  // Which SRT segment this issue relates to
}

export interface WordIssue {
  type: 'missing_word' | 'extra_word' | 'wrong_word' | 'clipped_word';
  scriptWord: string;
  transcribedWord: string;
  context: string;  // Surrounding words for reference
  severity: 'warning' | 'error';
}

export interface QAResult {
  score: number;              // 0-100% match
  totalScriptSentences: number;
  matchedSentences: number;
  issues: QAIssue[];
  wordIssues: WordIssue[];    // NEW: Word-level issues
  needsReview: boolean;       // true if score < 95% or has word issues
}

/**
 * Normalize text for comparison - lowercase, remove punctuation, collapse whitespace
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate Levenshtein distance between two strings
 * Used for fuzzy word matching (e.g., "didn" vs "didnt")
 */
function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;

  // Create matrix
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  // Initialize first row and column
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  // Fill matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],     // deletion
          dp[i][j - 1],     // insertion
          dp[i - 1][j - 1]  // substitution
        );
      }
    }
  }

  return dp[m][n];
}

/**
 * Check if two words are similar (within edit distance threshold)
 * Returns true if words are similar but not identical
 */
function areWordsSimilar(word1: string, word2: string): boolean {
  if (word1 === word2) return false; // Identical, not "similar"

  const maxLen = Math.max(word1.length, word2.length);
  if (maxLen < 3) return false; // Too short to compare

  const distance = levenshteinDistance(word1, word2);
  const threshold = maxLen <= 5 ? 1 : 2; // Allow 1 edit for short words, 2 for longer

  return distance <= threshold;
}

/**
 * Check if a word looks like a clipped version of another
 * e.g., "didn" is a clipped version of "didnt"
 */
function isClippedWord(transcribed: string, script: string): boolean {
  // Transcribed word is shorter and is a prefix of script word
  if (transcribed.length < script.length && script.startsWith(transcribed)) {
    return true;
  }
  // Common contractions that get clipped
  const contractionPairs: [string, string][] = [
    ['didn', 'didnt'],
    ['doesn', 'doesnt'],
    ['wasn', 'wasnt'],
    ['weren', 'werent'],
    ['couldn', 'couldnt'],
    ['wouldn', 'wouldnt'],
    ['shouldn', 'shouldnt'],
    ['hasn', 'hasnt'],
    ['haven', 'havent'],
    ['hadn', 'hadnt'],
    ['isn', 'isnt'],
    ['aren', 'arent'],
    ['won', 'wont'],
    ['can', 'cant'],
    ['don', 'dont'],
  ];

  for (const [clipped, full] of contractionPairs) {
    if (transcribed === clipped && script === full) return true;
  }

  return false;
}

/**
 * Find word-level issues by comparing script and transcription word by word
 * Uses sequence alignment to find insertions, deletions, and substitutions
 */
function findWordLevelIssues(script: string, transcription: string): WordIssue[] {
  const issues: WordIssue[] = [];

  const scriptWords = normalizeText(script).split(' ').filter(w => w.length > 0);
  const transWords = normalizeText(transcription).split(' ').filter(w => w.length > 0);

  // Use a sliding window approach to find mismatches
  // This is more practical than full sequence alignment for long texts

  let scriptIdx = 0;
  let transIdx = 0;

  while (scriptIdx < scriptWords.length && transIdx < transWords.length) {
    const scriptWord = scriptWords[scriptIdx];
    const transWord = transWords[transIdx];

    if (scriptWord === transWord) {
      // Words match, move both pointers
      scriptIdx++;
      transIdx++;
      continue;
    }

    // Words don't match - figure out what happened

    // Check if it's a clipped word (e.g., "didn" vs "didnt")
    if (isClippedWord(transWord, scriptWord)) {
      const contextStart = Math.max(0, scriptIdx - 2);
      const contextEnd = Math.min(scriptWords.length, scriptIdx + 3);
      const context = scriptWords.slice(contextStart, contextEnd).join(' ');

      issues.push({
        type: 'clipped_word',
        scriptWord,
        transcribedWord: transWord,
        context,
        severity: 'error',  // Clipped words are audio quality issues
      });
      scriptIdx++;
      transIdx++;
      continue;
    }

    // Check if it's a similar word (typo/mishearing)
    if (areWordsSimilar(scriptWord, transWord)) {
      const contextStart = Math.max(0, scriptIdx - 2);
      const contextEnd = Math.min(scriptWords.length, scriptIdx + 3);
      const context = scriptWords.slice(contextStart, contextEnd).join(' ');

      issues.push({
        type: 'wrong_word',
        scriptWord,
        transcribedWord: transWord,
        context,
        severity: 'warning',
      });
      scriptIdx++;
      transIdx++;
      continue;
    }

    // Look ahead to see if script word appears soon in transcription (missing word in trans)
    const lookAheadTrans = transWords.slice(transIdx, transIdx + 5);
    const foundInTrans = lookAheadTrans.indexOf(scriptWord);

    // Look ahead to see if trans word appears soon in script (extra word in trans)
    const lookAheadScript = scriptWords.slice(scriptIdx, scriptIdx + 5);
    const foundInScript = lookAheadScript.indexOf(transWord);

    if (foundInTrans > 0 && (foundInScript < 0 || foundInTrans <= foundInScript)) {
      // Script word found ahead in transcription - there are extra words in transcription
      for (let i = 0; i < foundInTrans; i++) {
        const contextStart = Math.max(0, scriptIdx - 2);
        const contextEnd = Math.min(scriptWords.length, scriptIdx + 3);
        const context = scriptWords.slice(contextStart, contextEnd).join(' ');

        issues.push({
          type: 'extra_word',
          scriptWord: '',
          transcribedWord: transWords[transIdx + i],
          context,
          severity: 'warning',
        });
      }
      transIdx += foundInTrans;
    } else if (foundInScript > 0) {
      // Trans word found ahead in script - script words are missing from transcription
      for (let i = 0; i < foundInScript; i++) {
        const contextStart = Math.max(0, scriptIdx + i - 2);
        const contextEnd = Math.min(scriptWords.length, scriptIdx + i + 3);
        const context = scriptWords.slice(contextStart, contextEnd).join(' ');

        issues.push({
          type: 'missing_word',
          scriptWord: scriptWords[scriptIdx + i],
          transcribedWord: '',
          context,
          severity: 'error',
        });
      }
      scriptIdx += foundInScript;
    } else {
      // Can't align - treat as wrong word and move on
      const contextStart = Math.max(0, scriptIdx - 2);
      const contextEnd = Math.min(scriptWords.length, scriptIdx + 3);
      const context = scriptWords.slice(contextStart, contextEnd).join(' ');

      issues.push({
        type: 'wrong_word',
        scriptWord,
        transcribedWord: transWord,
        context,
        severity: 'warning',
      });
      scriptIdx++;
      transIdx++;
    }
  }

  // Handle remaining words
  while (scriptIdx < scriptWords.length) {
    const contextStart = Math.max(0, scriptIdx - 2);
    const contextEnd = Math.min(scriptWords.length, scriptIdx + 3);
    const context = scriptWords.slice(contextStart, contextEnd).join(' ');

    issues.push({
      type: 'missing_word',
      scriptWord: scriptWords[scriptIdx],
      transcribedWord: '',
      context,
      severity: 'error',
    });
    scriptIdx++;
  }

  while (transIdx < transWords.length) {
    issues.push({
      type: 'extra_word',
      scriptWord: '',
      transcribedWord: transWords[transIdx],
      context: transWords.slice(Math.max(0, transIdx - 2), transIdx + 3).join(' '),
      severity: 'warning',
    });
    transIdx++;
  }

  return issues;
}

/**
 * Calculate sequence-based similarity using Longest Common Subsequence (LCS)
 * Unlike Jaccard, this CARES about word ORDER which catches garbled audio.
 *
 * Exported alias `calculateLCSSimilarity` is for callers outside this module
 * (e.g. per-chunk TTS verification). Internal callers continue to use the
 * local `calculateSimilarity` name.
 */
export function calculateLCSSimilarity(str1: string, str2: string): number {
  return calculateSimilarity(str1, str2);
}

/**
 * Normalize text then compare — convenience wrapper for callers that have
 * raw strings (punctuation, capitalization, etc) rather than pre-normalized input.
 */
export function calculateLCSSimilarityNormalized(str1: string, str2: string): number {
  return calculateSimilarity(normalizeText(str1), normalizeText(str2));
}

function calculateSimilarity(str1: string, str2: string): number {
  const words1 = str1.split(' ').filter(w => w.length > 0);
  const words2 = str2.split(' ').filter(w => w.length > 0);

  if (words1.length === 0 && words2.length === 0) return 1;
  if (words1.length === 0 || words2.length === 0) return 0;

  // LCS dynamic programming
  const m = words1.length;
  const n = words2.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (words1[i - 1] === words2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const lcsLength = dp[m][n];
  // Score based on how much of the original script is preserved in order
  // Use max length as denominator to penalize extra/missing words
  return lcsLength / Math.max(m, n);
}

/**
 * Split text into sentences
 */
function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Find the best matching transcription sentence for a script sentence
 */
function findBestMatch(
  scriptSentence: string,
  transcriptionSentences: string[],
  usedIndices: Set<number>
): { index: number; similarity: number } | null {
  const normalizedScript = normalizeText(scriptSentence);
  let bestMatch = { index: -1, similarity: 0 };

  for (let i = 0; i < transcriptionSentences.length; i++) {
    if (usedIndices.has(i)) continue;

    const normalizedTrans = normalizeText(transcriptionSentences[i]);
    const similarity = calculateSimilarity(normalizedScript, normalizedTrans);

    if (similarity > bestMatch.similarity) {
      bestMatch = { index: i, similarity };
    }
  }

  return bestMatch.index >= 0 ? bestMatch : null;
}

/**
 * Compare original script to Whisper transcription
 * Returns QA results with score and issues found
 */
export function compareScriptToTranscription(
  script: string,
  transcription: string
): QAResult {
  const scriptSentences = splitIntoSentences(script);
  const transcriptionSentences = splitIntoSentences(transcription);

  const issues: QAIssue[] = [];
  const usedTranscriptionIndices = new Set<number>();
  let matchedCount = 0;

  // For each script sentence, find best matching transcription sentence
  for (const scriptSentence of scriptSentences) {
    const normalizedScript = normalizeText(scriptSentence);

    // Skip very short sentences (less than 3 words)
    if (normalizedScript.split(' ').length < 3) {
      matchedCount++; // Don't penalize for short sentences
      continue;
    }

    const match = findBestMatch(scriptSentence, transcriptionSentences, usedTranscriptionIndices);

    if (!match || match.similarity < 0.6) {
      // Sentence is missing or severely garbled (raised from 0.5 to 0.6)
      issues.push({
        type: 'missing',
        originalText: scriptSentence.substring(0, 100) + (scriptSentence.length > 100 ? '...' : ''),
        transcribedText: match ? transcriptionSentences[match.index].substring(0, 100) : '',
        similarity: match?.similarity,
        severity: 'error',
      });
    } else if (match.similarity < 0.92) {
      // Sentence exists but has issues (raised from 0.85 to 0.92 - stricter)
      usedTranscriptionIndices.add(match.index);
      issues.push({
        type: 'garbled',
        originalText: scriptSentence.substring(0, 100) + (scriptSentence.length > 100 ? '...' : ''),
        transcribedText: transcriptionSentences[match.index].substring(0, 100),
        similarity: match.similarity,
        severity: 'warning',
      });
      matchedCount += match.similarity; // Partial credit
    } else {
      // Good match (requires 92%+ LCS similarity now)
      usedTranscriptionIndices.add(match.index);
      matchedCount++;
    }
  }

  // Check for extra content in transcription (TTS hallucinations)
  for (let i = 0; i < transcriptionSentences.length; i++) {
    if (usedTranscriptionIndices.has(i)) continue;

    const sentence = transcriptionSentences[i];
    const normalized = normalizeText(sentence);

    // Skip very short extra sentences
    if (normalized.split(' ').length < 5) continue;

    // Check if it's similar to any script sentence
    let foundSimilar = false;
    for (const scriptSentence of scriptSentences) {
      if (calculateSimilarity(normalized, normalizeText(scriptSentence)) > 0.5) {
        foundSimilar = true;
        break;
      }
    }

    if (!foundSimilar) {
      issues.push({
        type: 'extra',
        originalText: '',
        transcribedText: sentence.substring(0, 100) + (sentence.length > 100 ? '...' : ''),
        severity: 'warning',
      });
    }
  }

  // Word-level comparison - show ALL issues, don't hide them
  const wordIssues = findWordLevelIssues(script, transcription);

  // Only filter out very minor issues (single-character filler words)
  const significantWordIssues = wordIssues.filter(issue => {
    // Always keep clipped words (TTS quality issues)
    if (issue.type === 'clipped_word') return true;

    // Always keep wrong words - these indicate garbled audio
    if (issue.type === 'wrong_word') return true;

    // Keep missing words unless they're single-letter articles
    if (issue.type === 'missing_word') {
      return issue.scriptWord.length > 1; // Keep anything longer than 1 char
    }

    // Keep extra words unless they're very short filler sounds
    if (issue.type === 'extra_word') {
      return issue.transcribedWord.length > 2; // Keep anything longer than 2 chars
    }

    return true;
  });

  // Calculate overall score
  const totalSentences = scriptSentences.filter(s => normalizeText(s).split(' ').length >= 3).length;
  const score = totalSentences > 0 ? Math.round((matchedCount / totalSentences) * 100) : 100;

  // Determine if review is needed - STRICTER thresholds
  const hasClippedWords = significantWordIssues.some(i => i.type === 'clipped_word');
  const hasWrongWords = significantWordIssues.some(i => i.type === 'wrong_word');
  const hasMissingWords = significantWordIssues.filter(i => i.type === 'missing_word').length > 2;
  const hasManyWordIssues = significantWordIssues.length > 3; // Was 5, now 3

  return {
    score,
    totalScriptSentences: scriptSentences.length,
    matchedSentences: Math.round(matchedCount),
    issues,
    wordIssues: significantWordIssues,
    // Flag for review if: score < 98% (was 95), OR any wrong/clipped words, OR many issues
    needsReview: score < 98 || hasClippedWords || hasWrongWords || hasMissingWords || hasManyWordIssues,
  };
}

/**
 * Quick check - just returns score without detailed issues
 */
export function quickScoreCheck(script: string, transcription: string): number {
  const result = compareScriptToTranscription(script, transcription);
  return result.score;
}

/**
 * Audio segment from Fish Speech TTS
 */
export interface AudioSegment {
  index: number;      // 1-based segment number
  text: string;       // Original script text sent to TTS
  duration: number;   // Duration in seconds
  audioUrl?: string;  // URL to individual segment audio
}

/**
 * SRT segment parsed from captions file
 */
export interface SrtSegment {
  index: number;      // 1-based SRT entry number
  text: string;       // Transcribed text
  startTime: number;  // Start time in seconds
  endTime: number;    // End time in seconds
}

/**
 * Compare audio segments to SRT segments by TIME RANGE
 *
 * This is the correct approach because:
 * - Each audio segment contains a chunk of script text (e.g., "The gossip around Princess Charlotte...")
 * - Fish Speech TTS generates audio for that segment
 * - The combined audio is transcribed by Whisper into SRT
 * - SRT segments are split into 5-7 word chunks for readability
 * - So one audio segment maps to MANY SRT segments
 *
 * Algorithm:
 * 1. Calculate time range for each audio segment (cumulative durations)
 * 2. Find SRT segments that fall within each audio segment's time range
 * 3. Concatenate those SRT texts
 * 4. Compare audio segment text vs concatenated SRT text
 */
export function compareAudioSegmentsToSRT(
  audioSegments: AudioSegment[],
  srtSegments: SrtSegment[]
): QAResult {
  const issues: QAIssue[] = [];
  let totalMatched = 0;
  let totalSegments = 0;

  const sortedAudioSegments = [...audioSegments].sort((a, b) => a.index - b.index);

  // Build a GLOBAL transcription sentence list from all SRT entries.
  // Time-range matching was too brittle: Whisper chunks the audio at pause
  // boundaries that don't match TTS segment boundaries, so a script sentence
  // near a segment edge would show up in the wrong time window, producing
  // false "mismatch" flags (e.g. "script: 'This was custom, ... required
  // witnesses to prove...' vs heard: 'went back to times when...' — both
  // are actually the same sentence, just framed differently).
  // By searching the ENTIRE transcription for each script sentence, we only
  // flag sentences that are truly absent or mangled — not ones that are
  // just positioned differently.
  const fullTranscription = [...srtSegments]
    .sort((a, b) => a.startTime - b.startTime)
    .map(s => s.text)
    .join(' ')
    .trim();
  const allTranscribedSentences = splitIntoSentences(fullTranscription);

  // Asymmetric "containment" similarity: what fraction of the script
  // sentence's words appear in-order in the transcript sentence? This
  // treats "script fully inside a longer transcript sentence" as a
  // perfect match (1.0), which is the correct reading when Whisper
  // merges two script sentences into one comma-joined utterance.
  // Symmetric LCS/max would falsely penalize those as missing.
  const containmentSimilarity = (scriptSentence: string, transcriptSentence: string): number => {
    const scriptWords = normalizeText(scriptSentence).split(' ').filter(Boolean);
    const transWords = normalizeText(transcriptSentence).split(' ').filter(Boolean);
    if (scriptWords.length === 0) return 1;
    if (transWords.length === 0) return 0;
    const m = scriptWords.length;
    const n = transWords.length;
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = scriptWords[i - 1] === transWords[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp[m][n] / scriptWords.length;
  };

  const findBestContainment = (scriptSentence: string) => {
    let best = { index: -1, similarity: 0 };
    for (let i = 0; i < allTranscribedSentences.length; i++) {
      const sim = containmentSimilarity(scriptSentence, allTranscribedSentences[i]);
      if (sim > best.similarity) best = { index: i, similarity: sim };
      if (best.similarity >= 1.0) break; // short-circuit on perfect match
    }
    return best.index >= 0 ? best : null;
  };

  for (const audioSeg of sortedAudioSegments) {
    if (!audioSeg.text || audioSeg.text.trim().length === 0) continue;
    totalSegments++;

    const scriptSentences = splitIntoSentences(audioSeg.text);
    let sentencesFlagged = 0;
    let sentencesChecked = 0;

    for (const scriptSentence of scriptSentences) {
      const normScript = normalizeText(scriptSentence);
      if (normScript.split(' ').filter(Boolean).length < 3) continue; // skip tiny fragments
      sentencesChecked++;

      // No used-index restriction — multiple script sentences may
      // legitimately match the same long transcript sentence.
      const match = findBestContainment(scriptSentence);

      if (!match || match.similarity < 0.6) {
        issues.push({
          type: 'missing',
          originalText: scriptSentence,
          transcribedText: match ? allTranscribedSentences[match.index] : '',
          similarity: match?.similarity,
          severity: 'error',
          segmentNumber: audioSeg.index,
        });
        sentencesFlagged++;
      } else if (match.similarity < 0.92) {
        issues.push({
          type: 'mismatch',
          originalText: scriptSentence,
          transcribedText: allTranscribedSentences[match.index],
          similarity: match.similarity,
          severity: 'warning',
          segmentNumber: audioSeg.index,
        });
        sentencesFlagged++;
      }
    }

    // Score: fraction of this segment's sentences that matched cleanly
    const segmentScore = sentencesChecked > 0
      ? Math.max(0, 1 - sentencesFlagged / sentencesChecked)
      : 1;
    totalMatched += segmentScore;
  }

  // Calculate overall score
  const score = totalSegments > 0 ? Math.round((totalMatched / totalSegments) * 100) : 100;

  // Word-level comparison: concatenate all audio segment texts and all SRT texts
  const fullScript = sortedAudioSegments.map(s => s.text).join(' ');
  const fullTranscript = srtSegments.sort((a, b) => a.startTime - b.startTime).map(s => s.text).join(' ');
  const wordIssues = findWordLevelIssues(fullScript, fullTranscript);

  // Filter significant word issues
  const significantWordIssues = wordIssues.filter(issue => {
    if (issue.type === 'clipped_word') return true;
    if (issue.type === 'wrong_word') return true;
    if (issue.type === 'missing_word') return issue.scriptWord.length > 1;
    if (issue.type === 'extra_word') return issue.transcribedWord.length > 2;
    return true;
  });

  // Determine if review is needed
  const hasClippedWords = significantWordIssues.some(i => i.type === 'clipped_word');
  const hasWrongWords = significantWordIssues.some(i => i.type === 'wrong_word');
  const hasMissingWords = significantWordIssues.filter(i => i.type === 'missing_word').length > 2;

  return {
    score,
    totalScriptSentences: totalSegments,
    matchedSentences: Math.round(totalMatched),
    issues,
    wordIssues: significantWordIssues,
    needsReview: score < 98 || hasClippedWords || hasWrongWords || hasMissingWords || issues.length > 0,
  };
}

/**
 * Parse SRT content into SrtSegment array
 */
export function parseSrtToSegments(srtContent: string): SrtSegment[] {
  const segments: SrtSegment[] = [];
  const blocks = srtContent.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length >= 3) {
      const index = parseInt(lines[0], 10);
      const timeMatch = lines[1].match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
      const text = lines.slice(2).join(' ').trim();

      if (!isNaN(index) && timeMatch) {
        const startTime =
          parseInt(timeMatch[1]) * 3600 +
          parseInt(timeMatch[2]) * 60 +
          parseInt(timeMatch[3]) +
          parseInt(timeMatch[4]) / 1000;
        const endTime =
          parseInt(timeMatch[5]) * 3600 +
          parseInt(timeMatch[6]) * 60 +
          parseInt(timeMatch[7]) +
          parseInt(timeMatch[8]) / 1000;

        segments.push({ index, text, startTime, endTime });
      }
    }
  }

  return segments;
}
