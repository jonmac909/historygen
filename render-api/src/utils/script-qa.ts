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
  // Human-readable label like "Missing phrase", "Word change",
  // "Pronunciation difference" — helps the user understand at a glance
  // whether a "mismatch" is a real problem or just framing drift.
  label?: string;
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

// Spelled-out number words → digits. Handles simple cases (thirty = 30,
// thirty-five = 35), compound multipliers (three hundred thousand =
// 300000), and connector "and". Years written as words ("seventeen
// ninety-three") are NOT handled — users typically write years as digits
// in scripts anyway, and ambiguous cases are left untouched.
const NUM_ONES = new Map<string, number>([
  ['zero', 0], ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
  ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14],
  ['fifteen', 15], ['sixteen', 16], ['seventeen', 17], ['eighteen', 18], ['nineteen', 19],
]);
const NUM_TENS = new Map<string, number>([
  ['twenty', 20], ['thirty', 30], ['forty', 40], ['fifty', 50],
  ['sixty', 60], ['seventy', 70], ['eighty', 80], ['ninety', 90],
]);
const NUM_MULTIPLIERS = new Map<string, number>([
  ['hundred', 100], ['thousand', 1000], ['million', 1000000], ['billion', 1000000000],
]);

function numberWordsToDigits(text: string): string {
  // "thirty-five" → "thirty five" so we can merge tokens
  const hyphenExpanded = text.replace(/([a-zA-Z])-([a-zA-Z])/g, '$1 $2');
  const tokens = hyphenExpanded.split(/(\s+)/); // keep whitespace for rebuild
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    const low = tok.toLowerCase().replace(/[^a-z]/g, '');
    if (NUM_ONES.has(low) || NUM_TENS.has(low)) {
      // Start of a number phrase — consume greedily
      let total = 0;
      let current = 0;
      let j = i;
      let consumed = 0;
      while (j < tokens.length) {
        const piece = tokens[j];
        if (/^\s+$/.test(piece)) { j++; continue; }
        const p = piece.toLowerCase().replace(/[^a-z]/g, '');
        if (NUM_ONES.has(p)) {
          current += NUM_ONES.get(p)!;
          consumed = j + 1;
          j++;
        } else if (NUM_TENS.has(p)) {
          if (current > 0 && current < 100) break; // "seventeen ninety" is a year, don't merge
          current += NUM_TENS.get(p)!;
          consumed = j + 1;
          j++;
        } else if (NUM_MULTIPLIERS.has(p)) {
          const m = NUM_MULTIPLIERS.get(p)!;
          if (m === 100) {
            current = Math.max(1, current) * 100;
          } else {
            total += Math.max(1, current) * m;
            current = 0;
          }
          consumed = j + 1;
          j++;
        } else if (p === 'and' && (current > 0 || total > 0)) {
          j++;
        } else {
          break;
        }
      }
      if (consumed > i) {
        out.push(String(total + current));
        i = consumed;
      } else {
        out.push(tok);
        i++;
      }
    } else {
      out.push(tok);
      i++;
    }
  }
  return out.join('');
}

/**
 * Normalize text for comparison - lowercase, remove punctuation, collapse
 * whitespace, and convert spelled-out numbers to digits ("thirty-five" → "35",
 * "three hundred thousand" → "300000"). Script-vs-audio comparisons treat
 * "30" and "thirty" as identical after this pass.
 */
function normalizeText(text: string): string {
  return numberWordsToDigits(text)
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

// Soundex: phonetic encoding that maps similar-sounding words to the same
// 4-char code. Handles Austen/Austin, bawl/ball, led/lead, etc. Used in
// conjunction with edit distance for our fuzzy word match.
function soundex(word: string): string {
  const w = word.toUpperCase().replace(/[^A-Z]/g, '');
  if (!w) return '';
  const CODES: Record<string, string> = {
    B: '1', F: '1', P: '1', V: '1',
    C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2',
    D: '3', T: '3',
    L: '4',
    M: '5', N: '5',
    R: '6',
  };
  let result = w[0];
  let lastCode = CODES[w[0]] || '';
  for (let i = 1; i < w.length && result.length < 4; i++) {
    const ch = w[i];
    const code = CODES[ch];
    if (code) {
      if (code !== lastCode) result += code;
      lastCode = code;
    } else if (ch !== 'H' && ch !== 'W') {
      // vowels break the dedup chain
      lastCode = '';
    }
  }
  return (result + '000').slice(0, 4);
}

// Treat two words as matching if they're identical, phonetically equivalent
// (Soundex), or within a small edit distance (handles minor spelling drift).
// Short words (< 4 chars) require exact match to avoid false merges of
// "the" vs "she" etc.
function wordsMatchFuzzy(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (soundex(a) === soundex(b)) return true;
  if (a[0] !== b[0]) return false;
  const maxLen = Math.max(a.length, b.length);
  const distance = levenshteinDistance(a, b);
  const threshold = maxLen <= 6 ? 1 : 2;
  return distance <= threshold;
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
  // Build a flat transcript view: a single word list spanning all SRT rows
  // plus an index mapping each word to the positions it appears. We'll
  // search the ENTIRE transcript (not per-sentence) for each script
  // sentence — that way "script sentence spans multiple transcript
  // sentences" no longer triggers false mismatches.
  const fullTranscription = [...srtSegments]
    .sort((a, b) => a.startTime - b.startTime)
    .map(s => s.text)
    .join(' ')
    .trim();
  const fullTranscriptWords = normalizeText(fullTranscription).split(' ').filter(Boolean);
  const transcriptIndex = new Map<string, number[]>();
  for (let i = 0; i < fullTranscriptWords.length; i++) {
    const w = fullTranscriptWords[i];
    let bucket = transcriptIndex.get(w);
    if (!bucket) { bucket = []; transcriptIndex.set(w, bucket); }
    bucket.push(i);
  }
  const allTranscribedSentences = splitIntoSentences(fullTranscription);

  // Greedy forward search BOUNDED to a transcript range [minStart, maxStart].
  // For each anchor (position of the script's first word) inside that range,
  // try to match subsequent script words forward with fuzzy comparison.
  // This enforces that script sentences must appear in order — if sentence
  // N+1 is found only WAY after N, it's treated as out-of-order (flagged).
  const scanScript = (
    scriptWords: string[],
    minStart: number,
    maxStart: number,
  ): { coverage: number; startIdx: number; endIdx: number; matchedScriptIndices: Set<number> } => {
    if (scriptWords.length === 0) {
      return { coverage: 1, startIdx: -1, endIdx: -1, matchedScriptIndices: new Set() };
    }
    const MAX_GAP = 40;
    const first = scriptWords[0];

    const anchors = new Set<number>();
    for (const p of (transcriptIndex.get(first) || [])) {
      if (p >= minStart && p <= maxStart) anchors.add(p);
    }
    if (first.length >= 4 && anchors.size < 50) {
      const soundCode = soundex(first);
      for (const [w, positions] of transcriptIndex) {
        if (w !== first && w.length >= 4 && soundex(w) === soundCode) {
          for (const p of positions) {
            if (p >= minStart && p <= maxStart) anchors.add(p);
          }
        }
      }
    }

    let best = { matches: 0, startIdx: -1, endIdx: -1, matched: new Set<number>() };
    for (const startPos of anchors) {
      let pos = startPos;
      let matches = 1;
      let lastMatch = startPos;
      const matchedHere = new Set<number>([0]);
      for (let si = 1; si < scriptWords.length; si++) {
        const target = scriptWords[si];
        const searchEnd = Math.min(pos + MAX_GAP, fullTranscriptWords.length);
        let found = -1;
        for (let j = pos + 1; j < searchEnd; j++) {
          if (wordsMatchFuzzy(fullTranscriptWords[j], target)) { found = j; break; }
          // Compound-word tolerance: "schoolrooms" == "school"+"rooms"
          if (j + 1 < searchEnd) {
            const joined = fullTranscriptWords[j] + fullTranscriptWords[j + 1];
            if (joined === target) { found = j + 1; break; }
          }
        }
        if (found === -1) continue; // unmatched — keep trying later script words in case of skip
        matches++;
        matchedHere.add(si);
        lastMatch = found;
        pos = found;
      }
      if (matches > best.matches) {
        best = { matches, startIdx: startPos, endIdx: lastMatch, matched: matchedHere };
      }
      if (best.matches === scriptWords.length) break;
    }
    return {
      coverage: best.matches / scriptWords.length,
      startIdx: best.startIdx,
      endIdx: best.endIdx,
      matchedScriptIndices: best.matched,
    };
  };

  // For display: pick the transcript sentence whose range overlaps the
  // match region best. If no match region, fall back to best single-
  // sentence containment.
  const transcriptSentenceAtWordIdx = (() => {
    // Compute start word index of each transcript sentence
    const starts: number[] = [];
    let acc = 0;
    for (const s of allTranscribedSentences) {
      starts.push(acc);
      acc += normalizeText(s).split(' ').filter(Boolean).length;
    }
    return (wordIdx: number): number => {
      if (wordIdx < 0) return -1;
      for (let i = starts.length - 1; i >= 0; i--) {
        if (starts[i] <= wordIdx) return i;
      }
      return -1;
    };
  })();

  // Stopwords / function words whose presence or absence rarely matters.
  // When the ONLY differences between script and transcript are these, the
  // scanner should not flag the sentence as a real issue.
  const STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'so', 'yet',
    'of', 'in', 'on', 'at', 'to', 'for', 'from', 'with', 'by', 'as',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
    'this', 'that', 'these', 'those',
    'it', 'he', 'she', 'we', 'they', 'you', 'i', 'his', 'her', 'their', 'its', 'our',
    'if', 'then', 'than', 'into', 'onto', 'about', 'over', 'under',
  ]);

  const isTriviallyDifferent = (scriptWords: string[], matchedScriptIndices: Set<number>): boolean => {
    // If all unmatched script words are stopwords, the mismatch is not a
    // real content issue — just a filler-word variation.
    for (let i = 0; i < scriptWords.length; i++) {
      if (matchedScriptIndices.has(i)) continue;
      if (!STOPWORDS.has(scriptWords[i])) return false;
    }
    return true;
  };

  // Classify the mismatch so the UI can show a human-readable label.
  const classifyIssue = (scriptWords: string[], matchStart: number, matchEnd: number, coverage: number): string => {
    const unmatched = scriptWords.length - Math.round(coverage * scriptWords.length);
    if (coverage < 0.5) return 'Likely missing / skipped';
    if (unmatched === 0) return 'Framing drift (content present)';
    if (unmatched === 1) return 'One word different';
    if (unmatched <= 3) return 'A few words different';
    // Look at where unmatched words are — is it a block or scattered?
    if (matchStart >= 0 && matchEnd >= matchStart) {
      const span = matchEnd - matchStart + 1;
      if (span < scriptWords.length * 0.7) return 'Partial match — portion missing or reworded';
    }
    return 'Multiple differences';
  };

  // Sequential read-head through the transcript. Each script sentence must
  // match at or shortly after the cursor — not anywhere in the transcript.
  // A script sentence whose words match only far from the cursor is treated
  // as genuinely missing (out of order = probably not the same content).
  let transcriptCursor = 0;

  for (const audioSeg of sortedAudioSegments) {
    if (!audioSeg.text || audioSeg.text.trim().length === 0) continue;
    totalSegments++;

    const scriptSentences = splitIntoSentences(audioSeg.text);
    let sentencesFlagged = 0;
    let sentencesChecked = 0;

    for (const scriptSentence of scriptSentences) {
      const scriptWords = normalizeText(scriptSentence).split(' ').filter(Boolean);
      if (scriptWords.length < 3) continue;
      sentencesChecked++;

      // Allow lookahead proportional to sentence length (handles minor
      // framing drift) but cap the window to prevent matching unrelated
      // content many sentences later.
      const lookahead = Math.max(80, scriptWords.length * 3);
      const maxStart = Math.min(transcriptCursor + lookahead, fullTranscriptWords.length - 1);
      const result = scanScript(scriptWords, transcriptCursor, maxStart);

      if (result.coverage >= 0.92) {
        // Present, in order — advance the cursor past this match
        transcriptCursor = result.endIdx + 1;
        continue;
      }

      // "Smart" filter: if the only unmatched script words are stopwords
      // (function-word swaps like "and"/"in", "a"/"the"), don't flag —
      // content is effectively present, variation is not a real issue.
      if (result.coverage >= 0.7 && isTriviallyDifferent(scriptWords, result.matchedScriptIndices)) {
        transcriptCursor = (result.endIdx >= 0 ? result.endIdx : transcriptCursor) + 1;
        continue;
      }

      // Build display transcript text from matched range (may be empty if
      // no anchor was found at all).
      let transcribedText = '';
      if (result.startIdx >= 0) {
        const sIdx = transcriptSentenceAtWordIdx(result.startIdx);
        const eIdx = transcriptSentenceAtWordIdx(result.endIdx);
        if (sIdx >= 0) {
          transcribedText = allTranscribedSentences.slice(sIdx, Math.max(sIdx, eIdx) + 1).join(' ');
        }
      }
      const label = classifyIssue(scriptWords, result.startIdx, result.endIdx, result.coverage);

      issues.push({
        type: result.coverage < 0.6 ? 'missing' : 'mismatch',
        originalText: scriptSentence,
        transcribedText,
        similarity: result.coverage,
        severity: result.coverage < 0.6 ? 'error' : 'warning',
        segmentNumber: audioSeg.index,
        label,
      });
      sentencesFlagged++;

      // Advance cursor past the imperfect match (if any) so subsequent
      // sentences don't get stuck searching behind it. If nothing matched,
      // advance by an estimated sentence-worth of words to avoid infinite
      // stalling at a genuinely-missing stretch.
      if (result.endIdx >= transcriptCursor) {
        transcriptCursor = result.endIdx + 1;
      } else {
        transcriptCursor += Math.max(5, Math.floor(scriptWords.length * 0.5));
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
