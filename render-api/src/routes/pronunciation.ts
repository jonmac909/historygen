import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

const router = Router();

// Store pronunciation fixes in a JSON file alongside the server
const FIXES_FILE = path.join(__dirname, '../../pronunciation-fixes.json');

interface PronunciationFix {
  word: string;
  phonetic: string;
}

// Default fixes (built-in)
const DEFAULT_FIXES: PronunciationFix[] = [
  // Place names
  { word: 'Clermont', phonetic: 'Clair-mont' },
  { word: 'Jerusalem', phonetic: 'Jeh-roo-sah-lem' },
  { word: 'Piacenza', phonetic: 'Pee-ah-chen-zah' },
  { word: 'Bouillon', phonetic: 'Boo-ee-yon' },
  { word: 'Nicaea', phonetic: 'Nye-see-ah' },
  { word: 'Dorylaeum', phonetic: 'Dor-ee-lay-um' },
  { word: 'Anatolia', phonetic: 'An-ah-toe-lee-ah' },
  { word: 'Kew', phonetic: 'Kyoo' },
  { word: 'Versailles', phonetic: 'Vair-sigh' },
  { word: 'Buckingham', phonetic: 'Buck-ing-um' },
  { word: 'Windsor', phonetic: 'Wind-zer' },
  { word: 'Mecklenburg', phonetic: 'Meck-len-berg' },
  { word: 'Strelitz', phonetic: 'Strell-its' },
  // Historical terms
  { word: 'Byzantine', phonetic: 'Biz-an-tine' },
  { word: 'Papal', phonetic: 'Pay-pal' },
  { word: 'Manzikert', phonetic: 'Man-zee-kert' },
  { word: 'Crusade', phonetic: 'Crew-sade' },
  { word: 'ecclesiastical', phonetic: 'eh-klee-zee-as-ti-cal' },
  { word: 'Alexios', phonetic: 'Ah-lex-ee-os' },
  { word: 'Kerbogha', phonetic: 'Ker-bow-gah' },
  // Titles and royalty
  { word: 'archduchess', phonetic: 'arch-duch-ess' },
  { word: 'archduke', phonetic: 'arch-duke' },
  // Common words that get garbled by Fish Speech TTS
  { word: 'palace', phonetic: 'PAL-iss' },
  { word: 'palaces', phonetic: 'PAL-iss-ez' },
  { word: 'courts', phonetic: 'korts' },
  { word: 'preachers', phonetic: 'pree-chers' },
  { word: 'Jewish', phonetic: 'Jew-ish' },
  { word: 'Armenian', phonetic: 'Ar-mee-nee-an' },
  { word: 'dream', phonetic: 'dreem' },
  { word: 'dreams', phonetic: 'dreems' },
  { word: 'Charlotte', phonetic: 'Sharlot' },
  { word: 'George', phonetic: 'Jorj' },
  { word: 'Georgian', phonetic: 'Jorjun' },
  { word: 'porphyria', phonetic: 'porfeereeah' },
  { word: 'malady', phonetic: 'maladee' },
  // 'regency' removed - TTS handles it naturally, phonetic was worse
];

// Load fixes from file, falling back to defaults
function loadFixes(): PronunciationFix[] {
  try {
    if (fs.existsSync(FIXES_FILE)) {
      const data = fs.readFileSync(FIXES_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (error) {
    console.error('Error loading pronunciation fixes:', error);
  }
  return DEFAULT_FIXES;
}

// Save fixes to file
function saveFixes(fixes: PronunciationFix[]): boolean {
  try {
    fs.writeFileSync(FIXES_FILE, JSON.stringify(fixes, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving pronunciation fixes:', error);
    return false;
  }
}

// GET /pronunciation - Get all pronunciation fixes
router.get('/', (req: Request, res: Response) => {
  const fixes = loadFixes();
  res.json({ fixes });
});

// POST /pronunciation - Update pronunciation fixes
router.post('/', (req: Request, res: Response) => {
  const { fixes } = req.body;

  if (!Array.isArray(fixes)) {
    return res.status(400).json({ error: 'fixes must be an array' });
  }

  // Validate each fix
  for (const fix of fixes) {
    if (!fix.word || !fix.phonetic || typeof fix.word !== 'string' || typeof fix.phonetic !== 'string') {
      return res.status(400).json({ error: 'Each fix must have word and phonetic strings' });
    }
  }

  if (saveFixes(fixes)) {
    // Also update the in-memory PRONUNCIATION_FIXES in generate-audio
    // This is done by re-importing the fixes when audio is generated
    res.json({ success: true, count: fixes.length });
  } else {
    res.status(500).json({ error: 'Failed to save pronunciation fixes' });
  }
});

// Export function to get fixes as a Record (for use in generate-audio)
export function getPronunciationFixesRecord(): Record<string, string> {
  const fixes = loadFixes();
  const record: Record<string, string> = {};
  for (const fix of fixes) {
    record[fix.word] = fix.phonetic;
  }
  return record;
}

export default router;
