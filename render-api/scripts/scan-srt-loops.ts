import * as fs from 'fs';
import { detectRepetitions } from '../src/routes/generate-audio';

interface WhisperSegment { text: string; start: number; end: number; }

function parseSrtTime(t: string): number {
  const [hms, ms] = t.split(',');
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s + Number(ms) / 1000;
}

function parseSrt(raw: string): WhisperSegment[] {
  const segs: WhisperSegment[] = [];
  const blocks = raw.replace(/\r/g, '').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    const timeLine = lines[1];
    const m = /^([\d:,]+)\s*-->\s*([\d:,]+)/.exec(timeLine);
    if (!m) continue;
    segs.push({
      start: parseSrtTime(m[1]),
      end: parseSrtTime(m[2]),
      text: lines.slice(2).join(' ').trim(),
    });
  }
  return segs;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(1);
  return `${m}:${s.padStart(4, '0')}`;
}

async function main() {
  const srtPath = process.argv[2];
  if (!srtPath) { console.error('usage: tsx scan-srt-loops.ts <srt>'); return; }
  const raw = fs.readFileSync(srtPath, 'utf8');
  const segments = parseSrt(raw);
  const lastEnd = segments[segments.length - 1]?.end || 0;
  console.log(`Parsed ${segments.length} SRT segments, covering ${fmt(lastEnd)}`);

  console.log('\n=== Step 1: detectRepetitions (new strict defaults: minWords=6, sim>0.85, phrase>=6, occ>=3) ===');
  const strict = detectRepetitions(segments);
  console.log(`Strict: ${strict.length} repetition range(s)`);
  strict.forEach((l, i) => {
    const dur = (l.end - l.start).toFixed(1);
    console.log(`  [${i}] ${fmt(l.start)} -> ${fmt(l.end)}  (${dur}s)  "${l.text.slice(0, 140).replace(/\s+/g, ' ')}"`);
  });

  console.log('\n=== Old thresholds (pre-tightening: minWords=4, sim>0.70, phrase>=4, occ>=2) ===');
  const loose = detectRepetitions(segments, 4, 0.70, 4, 2);
  console.log(`Loose: ${loose.length} repetition range(s)`);
  loose.slice(0, 40).forEach((l, i) => {
    const dur = (l.end - l.start).toFixed(1);
    console.log(`  [${i}] ${fmt(l.start)} -> ${fmt(l.end)}  (${dur}s)  "${l.text.slice(0, 140).replace(/\s+/g, ' ')}"`);
  });
  if (loose.length > 40) console.log(`  ... and ${loose.length - 40} more`);
}

main();
