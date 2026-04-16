/**
 * Standalone loop scanner — runs the new detection pipeline against a WAV file.
 * Usage: ts-node scripts/scan-loops.ts <path-to-wav>
 */
import * as fs from 'fs';
import { detectRepeatedWindows } from '../src/utils/audio-integrity';

async function main() {
  const wavPath = process.argv[2];
  if (!wavPath) {
    console.error('usage: scan-loops.ts <wav>');
    process.exit(1);
  }

  console.log(`Reading ${wavPath}...`);
  const buffer = fs.readFileSync(wavPath);
  console.log(`Size: ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);

  // Step 4: signal-based self-similarity scan
  console.log('\n=== Step 4: Signal-based self-similarity scan ===');
  const t0 = Date.now();
  // Sweep thresholds to find a sensible operating point
  const passes = [
    { label: 'A default', opts: {} },
    { label: 'B sim0.96  period>=500ms occ3', opts: { minPatternMs: 500, similarityThreshold: 0.96 } },
    { label: 'C sim0.97  period>=500ms occ3', opts: { minPatternMs: 500, similarityThreshold: 0.97 } },
    { label: 'D sim0.97  period>=500ms occ4', opts: { minPatternMs: 500, similarityThreshold: 0.97, minOccurrences: 4 } },
    { label: 'E sim0.98  period>=500ms occ4', opts: { minPatternMs: 500, similarityThreshold: 0.98, minOccurrences: 4 } },
    { label: 'F sim0.99  period>=400ms occ3', opts: { minPatternMs: 400, similarityThreshold: 0.99, minOccurrences: 3 } },
    { label: 'G sim0.995 period>=400ms occ3', opts: { minPatternMs: 400, similarityThreshold: 0.995, minOccurrences: 3 } },
  ];

  let loops: ReturnType<typeof detectRepeatedWindows> = [];
  for (const p of passes) {
    const t = Date.now();
    const l = detectRepeatedWindows(buffer, p.opts as any);
    const took = ((Date.now() - t) / 1000).toFixed(1);
    console.log(`  ${p.label}: ${l.length} hits (${took}s)`);
    loops = l;
  }
  const elapsedSignal = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Scan took ${elapsedSignal}s — detected ${loops.length} loop range(s)`);

  if (loops.length === 0) {
    console.log('  (no signal-level loops detected at current thresholds)');
  } else {
    console.log('  Detected loops (sorted by start time):');
    loops.forEach((l, i) => {
      const mins = Math.floor(l.startSec / 60);
      const secs = (l.startSec - mins * 60).toFixed(1);
      console.log(`    [${i}] ${mins}:${secs.padStart(4,'0')} → ${(l.endSec).toFixed(1)}s  ×${l.occurrences}  period=${l.periodMs}ms  sim=${l.similarity.toFixed(3)}`);
    });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
