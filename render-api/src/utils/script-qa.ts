/**
 * Script QA - Compare original script to Whisper transcription
 * Detects TTS mistakes by finding mismatches between what was supposed to be said
 * and what Whisper actually heard.
 */

export interface QAIssue {
  type: 'missing' | 'garbled' | 'extra' | 'mismatch';
  originalText: string;
  transcribedText: string;
  similarity?: number;
  severity: 'warning' | 'error';
}

export interface QAResult {
  score: number;              // 0-100% match
  totalScriptSentences: number;
  matchedSentences: number;
  issues: QAIssue[];
  needsReview: boolean;       // true if score < 95%
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
 * Calculate Jaccard similarity between two strings (word-level)
 */
function calculateSimilarity(str1: string, str2: string): number {
  const words1 = new Set(str1.split(' ').filter(w => w.length > 0));
  const words2 = new Set(str2.split(' ').filter(w => w.length > 0));

  if (words1.size === 0 && words2.size === 0) return 1;
  if (words1.size === 0 || words2.size === 0) return 0;

  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
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

    if (!match || match.similarity < 0.5) {
      // Sentence is missing or severely garbled
      issues.push({
        type: 'missing',
        originalText: scriptSentence.substring(0, 100) + (scriptSentence.length > 100 ? '...' : ''),
        transcribedText: match ? transcriptionSentences[match.index].substring(0, 100) : '',
        similarity: match?.similarity,
        severity: 'error',
      });
    } else if (match.similarity < 0.85) {
      // Sentence exists but has issues
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
      // Good match
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

  // Calculate overall score
  const totalSentences = scriptSentences.filter(s => normalizeText(s).split(' ').length >= 3).length;
  const score = totalSentences > 0 ? Math.round((matchedCount / totalSentences) * 100) : 100;

  return {
    score,
    totalScriptSentences: scriptSentences.length,
    matchedSentences: Math.round(matchedCount),
    issues,
    needsReview: score < 95,
  };
}

/**
 * Quick check - just returns score without detailed issues
 */
export function quickScoreCheck(script: string, transcription: string): number {
  const result = compareScriptToTranscription(script, transcription);
  return result.score;
}
