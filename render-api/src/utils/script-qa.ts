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

// Ordinal word → digit (nineteenth → 19, twentieth → 20, first → 1…).
// Applied before scalar number normalization so "nineteenth century"
// becomes "19 century" and matches Whisper's "19th century".
const ORDINAL_TO_CARDINAL: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15,
  sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20,
  thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70,
  eightieth: 80, ninetieth: 90, hundredth: 100, thousandth: 1000,
};

function numberWordsToDigits(text: string): string {
  // "thirty-five" → "thirty five" so we can merge tokens
  const hyphenExpanded = text.replace(/([a-zA-Z])-([a-zA-Z])/g, '$1 $2');
  const tokens = hyphenExpanded.split(/(\s+)/);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    const low = tok.toLowerCase().replace(/[^a-z]/g, '');
    // Ordinals become their cardinal digit (nineteenth → 19)
    if (ORDINAL_TO_CARDINAL[low] !== undefined) {
      out.push(String(ORDINAL_TO_CARDINAL[low]));
      i++;
      continue;
    }
    if (NUM_ONES.has(low) || NUM_TENS.has(low)) {
      // Start of a number phrase — consume greedily, with YEAR detection.
      let total = 0;
      let current = 0;
      let j = i;
      let consumed = 0;
      while (j < tokens.length) {
        const piece = tokens[j];
        if (/^\s+$/.test(piece)) { j++; continue; }
        const p = piece.toLowerCase().replace(/[^a-z]/g, '');
        if (NUM_ONES.has(p)) {
          const val = NUM_ONES.get(p)!;
          // Year construction: "seventeen sixty" pattern — if current is
          // a "teen" (10-19) and next is tens, treat as century+tens.
          // Handled via NUM_TENS branch below. For ones after tens in a
          // year (e.g., "seventeen sixty-two"), just add.
          current += val;
          consumed = j + 1;
          j++;
        } else if (NUM_TENS.has(p)) {
          const tensVal = NUM_TENS.get(p)!;
          if (current >= 10 && current < 20) {
            // YEAR: "seventeen sixty" → 17 * 100 + 60 = 1760
            current = current * 100 + tensVal;
          } else if (current > 0 && current < 100) {
            break; // two unrelated numbers
          } else {
            current += tensVal;
          }
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

// British → American spelling normalization. Spelling variations are NOT
// audio differences (Whisper can render the same sound either way), so we
// collapse them before comparing. Skews toward American but either direction
// works since both sides are normalized the same way.
const SPELLING_MAP: Record<string, string> = {
  // -our → -or
  labour: 'labor', labours: 'labors', laboured: 'labored', labouring: 'laboring',
  colour: 'color', colours: 'colors', coloured: 'colored', colouring: 'coloring',
  honour: 'honor', honours: 'honors', honoured: 'honored', honouring: 'honoring', honourable: 'honorable',
  behaviour: 'behavior', behaviours: 'behaviors',
  favour: 'favor', favours: 'favors', favoured: 'favored', favouring: 'favoring', favourite: 'favorite', favourites: 'favorites',
  flavour: 'flavor', flavours: 'flavors', flavoured: 'flavored',
  neighbour: 'neighbor', neighbours: 'neighbors', neighbourhood: 'neighborhood', neighbouring: 'neighboring',
  rumour: 'rumor', rumours: 'rumors', rumoured: 'rumored',
  savour: 'savor', savoured: 'savored', savouring: 'savoring',
  harbour: 'harbor', harbours: 'harbors',
  armour: 'armor', armoured: 'armored',
  parlour: 'parlor', parlours: 'parlors',
  splendour: 'splendor',
  endeavour: 'endeavor', endeavours: 'endeavors',
  saviour: 'savior', saviours: 'saviors',
  odour: 'odor', odours: 'odors',
  ardour: 'ardor',
  vigour: 'vigor',
  clamour: 'clamor',
  humour: 'humor', humours: 'humors', humoured: 'humored',
  demeanour: 'demeanor',
  candour: 'candor',
  rancour: 'rancor',
  tumour: 'tumor', tumours: 'tumors',
  // -re → -er
  centre: 'center', centres: 'centers', centred: 'centered',
  theatre: 'theater', theatres: 'theaters',
  metre: 'meter', metres: 'meters',
  fibre: 'fiber', fibres: 'fibers',
  litre: 'liter', litres: 'liters',
  calibre: 'caliber',
  spectre: 'specter', spectres: 'specters',
  lustre: 'luster',
  sabre: 'saber', sabres: 'sabers',
  sceptre: 'scepter',
  // -ence → -ense (nouns)
  defence: 'defense', defences: 'defenses',
  offence: 'offense', offences: 'offenses',
  pretence: 'pretense',
  licence: 'license', licences: 'licenses',
  // -ogue → -og
  catalogue: 'catalog', catalogues: 'catalogs',
  dialogue: 'dialog', dialogues: 'dialogs',
  analogue: 'analog', analogues: 'analogs',
  monologue: 'monolog',
  // -ise → -ize
  realise: 'realize', realised: 'realized', realising: 'realizing', realises: 'realizes',
  organise: 'organize', organised: 'organized', organising: 'organizing', organises: 'organizes', organisation: 'organization', organisations: 'organizations',
  recognise: 'recognize', recognised: 'recognized', recognising: 'recognizing', recognises: 'recognizes',
  analyse: 'analyze', analysed: 'analyzed', analysing: 'analyzing', analyses: 'analyzes',
  emphasise: 'emphasize', emphasised: 'emphasized', emphasising: 'emphasizing',
  memorise: 'memorize', memorised: 'memorized',
  apologise: 'apologize', apologised: 'apologized', apologising: 'apologizing',
  criticise: 'criticize', criticised: 'criticized',
  summarise: 'summarize', summarised: 'summarized',
  specialise: 'specialize', specialised: 'specialized',
  standardise: 'standardize', standardised: 'standardized',
  civilise: 'civilize', civilised: 'civilized',
  characterise: 'characterize', characterised: 'characterized',
  categorise: 'categorize', categorised: 'categorized',
  minimise: 'minimize', minimised: 'minimized',
  maximise: 'maximize', maximised: 'maximized',
  utilise: 'utilize', utilised: 'utilized',
  // -lled → -led (British doubles consonant before suffix)
  travelled: 'traveled', travelling: 'traveling', traveller: 'traveler', travellers: 'travelers',
  cancelled: 'canceled', cancelling: 'canceling',
  labelled: 'labeled', labelling: 'labeling',
  modelled: 'modeled', modelling: 'modeling',
  counselled: 'counseled', counselling: 'counseling',
  signalled: 'signaled', signalling: 'signaling',
  channelled: 'channeled', channelling: 'channeling',
  // -aemia / -oestro
  anaemia: 'anemia', anaemic: 'anemic',
  leukaemia: 'leukemia',
  paediatric: 'pediatric', paediatrics: 'pediatrics',
  oestrogen: 'estrogen',
  // misc common
  grey: 'gray', greys: 'grays',
  cheque: 'check', cheques: 'checks',
  whilst: 'while',
  amongst: 'among',
  tyre: 'tire', tyres: 'tires',
  aluminium: 'aluminum',
  practise: 'practice', practised: 'practiced', practising: 'practicing',
  draught: 'draft', draughts: 'drafts',
  cosy: 'cozy',
  jewellery: 'jewelry',
  enquiry: 'inquiry', enquiries: 'inquiries',
  enquire: 'inquire', enquired: 'inquired',
  enrolment: 'enrollment',
  fulfil: 'fulfill',
  instalment: 'installment', instalments: 'installments',
  skilful: 'skillful',
  manoeuvre: 'maneuver', manoeuvres: 'maneuvers',
  manoeuvred: 'maneuvered',
  storey: 'story', storeys: 'stories',
  kerb: 'curb', kerbs: 'curbs',
  plough: 'plow', ploughs: 'plows', ploughed: 'plowed',
  sulphur: 'sulfur',
  moustache: 'mustache',
  pyjamas: 'pajamas',
};

// Contraction expansion runs BEFORE punctuation stripping (so we can still
// see the apostrophes that distinguish "we'll" from "well", "he'll" from
// "hell", etc). Each key is the apostrophe-form; value is the expansion.
// Same audio content, different written form — Whisper often renders one
// way while the script has the other.
const CONTRACTIONS: Record<string, string> = {
  "don't": 'do not', "can't": 'cannot', "won't": 'will not',
  "isn't": 'is not', "aren't": 'are not', "wasn't": 'was not', "weren't": 'were not',
  "hasn't": 'has not', "haven't": 'have not', "hadn't": 'had not',
  "doesn't": 'does not', "didn't": 'did not',
  "shouldn't": 'should not', "wouldn't": 'would not', "couldn't": 'could not',
  "mustn't": 'must not', "needn't": 'need not',
  "i've": 'i have', "you've": 'you have', "we've": 'we have', "they've": 'they have',
  "i'll": 'i will', "you'll": 'you will', "he'll": 'he will', "she'll": 'she will',
  "we'll": 'we will', "they'll": 'they will', "it'll": 'it will',
  "i'm": 'i am', "you're": 'you are', "he's": 'he is', "she's": 'she is',
  "we're": 'we are', "they're": 'they are', "it's": 'it is', "that's": 'that is',
  "there's": 'there is', "what's": 'what is', "who's": 'who is',
  "i'd": 'i would', "you'd": 'you would', "he'd": 'he would', "she'd": 'she would',
  "we'd": 'we would', "they'd": 'they would',
  "let's": 'let us',
};

function expandContractions(text: string): string {
  return text.replace(/\b[A-Za-z]+'[A-Za-z]+\b/g, (m) => {
    const lower = m.toLowerCase();
    return CONTRACTIONS[lower] || m;
  });
}

/**
 * Normalize text for comparison - lowercase, remove punctuation, collapse
 * whitespace, convert spelled-out numbers to digits, and unify
 * British/American spelling + common contractions. Script-vs-audio
 * comparisons treat "30"/"thirty", "labor"/"labour", "don't"/"do not",
 * "realize"/"realise" as identical after this pass — because none of
 * those differences are audible.
 */
function normalizeText(text: string): string {
  // 1. Expand contractions BEFORE stripping apostrophes
  let t = expandContractions(text);
  // 2. Convert spelled-out numbers to digits
  t = numberWordsToDigits(t);
  // 3. Lowercase, strip punctuation, collapse whitespace
  const cleaned = t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  // 4. British → American spelling normalization per word
  return cleaned.split(' ').map(w => SPELLING_MAP[w] || w).join(' ');
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
  const fullTranscription = [...srtSegments]
    .sort((a, b) => a.startTime - b.startTime)
    .map(s => s.text)
    .join(' ')
    .trim();
  const allTranscribedSentences = splitIntoSentences(fullTranscription);
  const transcribedNormWords: string[][] = allTranscribedSentences.map(
    s => normalizeText(s).split(' ').filter(Boolean)
  );

  // LCS length between two word arrays, with fuzzy/compound tolerance.
  const lcsWithFuzzy = (a: string[], b: string[]): number => {
    if (a.length === 0 || b.length === 0) return 0;
    const m = a.length, n = b.length;
    let prev = new Int32Array(n + 1);
    let curr = new Int32Array(n + 1);
    for (let i = 1; i <= m; i++) {
      curr[0] = 0;
      for (let j = 1; j <= n; j++) {
        let hit = wordsMatchFuzzy(a[i - 1], b[j - 1]);
        if (!hit && j < n && a[i - 1] === b[j - 1] + b[j]) hit = true; // compound
        curr[j] = hit ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
      }
      [prev, curr] = [curr, prev];
    }
    return prev[n];
  };

  // Dice similarity on LCS — symmetric, 1.0 for identical, scales with
  // differences in either direction. Good for alignment scoring.
  const sentenceSim = (a: string[], b: string[]): number => {
    if (a.length === 0 && b.length === 0) return 1;
    if (a.length === 0 || b.length === 0) return 0;
    const lcs = lcsWithFuzzy(a, b);
    return (2 * lcs) / (a.length + b.length);
  };

  // Set of script word indices matched when aligned against transWords.
  // Used only to drive the stopword dismiss heuristic on flagged pairs.
  const scriptWordsMatchedByTrans = (scriptWords: string[], transWords: string[]): Set<number> => {
    const matched = new Set<number>();
    if (scriptWords.length === 0 || transWords.length === 0) return matched;
    let pos = 0;
    for (let si = 0; si < scriptWords.length; si++) {
      for (let j = pos; j < transWords.length; j++) {
        if (wordsMatchFuzzy(transWords[j], scriptWords[si])) {
          matched.add(si); pos = j + 1; break;
        }
        if (j + 1 < transWords.length && transWords[j] + transWords[j + 1] === scriptWords[si]) {
          matched.add(si); pos = j + 2; break;
        }
      }
    }
    return matched;
  };

  // ------------------------------------------------------------------
  // Needleman-Wunsch sentence alignment. Script and transcript are both
  // sequences of sentences; NW finds the best 1:1 order-preserving
  // alignment allowing insertions (missing from audio / extra in audio).
  // ------------------------------------------------------------------

  // Flatten all script sentences WITH their originating audio segment so
  // each aligned pair can be attributed back to the right segment.
  type ScriptEntry = { text: string; words: string[]; segmentIndex: number };
  const scriptEntries: ScriptEntry[] = [];
  for (const audioSeg of sortedAudioSegments) {
    if (!audioSeg.text) continue;
    for (const sent of splitIntoSentences(audioSeg.text)) {
      const words = normalizeText(sent).split(' ').filter(Boolean);
      if (words.length === 0) continue;
      scriptEntries.push({ text: sent, words, segmentIndex: audioSeg.index });
    }
  }
  totalSegments = sortedAudioSegments.filter(s => s.text && s.text.trim()).length;

  const N = scriptEntries.length;
  const M = allTranscribedSentences.length;

  if (N === 0 || M === 0) {
    return {
      score: 100,
      totalScriptSentences: 0,
      matchedSentences: 0,
      issues: [],
      wordIssues: [],
      needsReview: false,
    };
  }

  // Quick-reject bag-of-words prefilter: only score full LCS for pairs
  // with at least some word overlap. Cuts ~90% of NxM comparisons.
  const scriptWordSets = scriptEntries.map(e => new Set(e.words));
  const transWordSets = transcribedNormWords.map(w => new Set(w));

  // Precompute similarity within a diagonal BAND to respect order. For
  // script sentence i, only consider transcript sentences j roughly near
  // its expected position. Band width is generous to handle misalignment.
  const expectedJ = (i: number) => Math.round((i / Math.max(1, N - 1)) * (M - 1));
  const BAND = Math.max(50, Math.ceil(Math.max(N, M) * 0.2));

  const simMatrix: Map<number, number>[] = Array.from({ length: N + 1 }, () => new Map<number, number>());
  for (let i = 1; i <= N; i++) {
    const jCenter = expectedJ(i - 1);
    const jLo = Math.max(1, jCenter + 1 - BAND);
    const jHi = Math.min(M, jCenter + 1 + BAND);
    const sSet = scriptWordSets[i - 1];
    const sWords = scriptEntries[i - 1].words;
    for (let j = jLo; j <= jHi; j++) {
      const tSet = transWordSets[j - 1];
      // Prefilter: require word overlap proportional to script length
      let overlap = 0;
      for (const w of sSet) if (tSet.has(w)) overlap++;
      if (overlap < Math.min(3, Math.ceil(sWords.length * 0.3))) continue;
      simMatrix[i].set(j, sentenceSim(sWords, transcribedNormWords[j - 1]));
    }
  }

  const simAt = (i: number, j: number): number => simMatrix[i].get(j) ?? 0;

  // NW DP. Gap penalty balances "prefer alignment" vs "allow skips for
  // missing/extra sentences". -0.3 is gentle enough that true mismatches
  // still align (with low score) rather than both get skipped.
  const GAP = -0.3;
  // Only store dp cells within the band to save memory. Use dense array
  // indexed by (i, j-jLo).
  const bandLo: number[] = new Array(N + 1).fill(0);
  const bandHi: number[] = new Array(N + 1).fill(0);
  for (let i = 0; i <= N; i++) {
    if (i === 0) { bandLo[i] = 0; bandHi[i] = M; continue; }
    const jCenter = expectedJ(i - 1);
    bandLo[i] = Math.max(0, jCenter - BAND);
    bandHi[i] = Math.min(M, jCenter + BAND);
  }

  // Use full 2D for simplicity (N*M ~ 500K cells = 4MB Float32). Fine.
  const dp = new Float32Array((N + 1) * (M + 1));
  const bt = new Uint8Array((N + 1) * (M + 1)); // 1=diag 2=up(missing) 3=left(extra)
  const idx = (i: number, j: number) => i * (M + 1) + j;

  for (let i = 1; i <= N; i++) dp[idx(i, 0)] = i * GAP;
  for (let j = 1; j <= M; j++) dp[idx(0, j)] = j * GAP;

  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= M; j++) {
      const diag = dp[idx(i - 1, j - 1)] + simAt(i, j);
      const up = dp[idx(i - 1, j)] + GAP;
      const left = dp[idx(i, j - 1)] + GAP;
      if (diag >= up && diag >= left) {
        dp[idx(i, j)] = diag; bt[idx(i, j)] = 1;
      } else if (up >= left) {
        dp[idx(i, j)] = up; bt[idx(i, j)] = 2;
      } else {
        dp[idx(i, j)] = left; bt[idx(i, j)] = 3;
      }
    }
  }

  // Backtrack to get the alignment
  type Aligned = { si: number; tj: number; sim: number } | { si: number; tj: -1; sim: 0 } | { si: -1; tj: number; sim: 0 };
  const aligned: Aligned[] = [];
  {
    let i = N, j = M;
    while (i > 0 || j > 0) {
      if (i === 0) { aligned.push({ si: -1, tj: j - 1, sim: 0 }); j--; continue; }
      if (j === 0) { aligned.push({ si: i - 1, tj: -1, sim: 0 }); i--; continue; }
      const op = bt[idx(i, j)];
      if (op === 1) {
        aligned.push({ si: i - 1, tj: j - 1, sim: simAt(i, j) });
        i--; j--;
      } else if (op === 2) {
        aligned.push({ si: i - 1, tj: -1, sim: 0 });
        i--;
      } else {
        aligned.push({ si: -1, tj: j - 1, sim: 0 });
        j--;
      }
    }
    aligned.reverse();
  }

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

  // Walk the alignment. Each aligned pair gives us a script sentence (or
  // none for "extra in audio") and a transcript sentence (or none for
  // "missing from audio"). Clean 1:1 pairing by construction.
  const perSegmentChecked = new Map<number, number>();
  const perSegmentFlagged = new Map<number, number>();

  for (const a of aligned) {
    if (a.si < 0) continue; // "extra in audio" — skip for now (not tied to a script segment)

    const entry = scriptEntries[a.si];
    if (entry.words.length < 3) continue;
    perSegmentChecked.set(entry.segmentIndex, (perSegmentChecked.get(entry.segmentIndex) || 0) + 1);

    // Script sentence with no transcript counterpart → genuinely missing.
    if (a.tj < 0) {
      issues.push({
        type: 'missing',
        originalText: entry.text,
        transcribedText: '',
        similarity: 0,
        severity: 'error',
        segmentNumber: entry.segmentIndex,
        label: 'Likely missing / skipped',
      });
      perSegmentFlagged.set(entry.segmentIndex, (perSegmentFlagged.get(entry.segmentIndex) || 0) + 1);
      continue;
    }

    // Aligned pair — check similarity. Dice 0.75 means ~75% content
    // match after fuzzy/compound/number normalization — anything above
    // that is usually just formatting/framing drift that isn't an audio
    // issue. Real mismatches (word substitutions, skipped phrases) score
    // noticeably lower.
    const sim = a.sim;
    if (sim >= 0.75) continue;

    // Stopword / trivial-diff dismiss
    const pairedTransWords = transcribedNormWords[a.tj];
    const matchedScriptIndices = scriptWordsMatchedByTrans(entry.words, pairedTransWords);
    if (sim >= 0.5 && isTriviallyDifferent(entry.words, matchedScriptIndices)) continue;

    const label = classifyIssue(entry.words, 0, entry.words.length - 1, sim);
    issues.push({
      type: sim < 0.5 ? 'missing' : 'mismatch',
      originalText: entry.text,
      transcribedText: allTranscribedSentences[a.tj],
      similarity: sim,
      severity: sim < 0.5 ? 'error' : 'warning',
      segmentNumber: entry.segmentIndex,
      label,
    });
    perSegmentFlagged.set(entry.segmentIndex, (perSegmentFlagged.get(entry.segmentIndex) || 0) + 1);
  }

  // Segment-level score: fraction of a segment's sentences that matched cleanly
  for (const [segIdx, checked] of perSegmentChecked) {
    const flagged = perSegmentFlagged.get(segIdx) || 0;
    totalMatched += checked > 0 ? Math.max(0, 1 - flagged / checked) : 1;
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
