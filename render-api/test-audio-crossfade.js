/**
 * Test FFmpeg acrossfade filter vs direct concatenation
 * This demonstrates how crossfading eliminates glitches
 */

const { execSync } = require('child_process');
const fs = require('fs');

// Generate WAV with specific end amplitude
function generateWavWithEndAmplitude(durationSeconds, endAmplitude, filename, sampleRate = 24000) {
  const numSamples = Math.floor(durationSeconds * sampleRate);
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + numSamples * 2, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);  // PCM
  header.writeUInt16LE(1, 22);  // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(numSamples * 2, 40);

  const samples = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const f1 = 200 * Math.sin(2 * Math.PI * 200 * t);
    const f2 = 300 * Math.sin(2 * Math.PI * 850 * t);
    let value = Math.floor(f1 + f2);
    if (i >= numSamples - 5) value = endAmplitude;
    samples.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }

  const wav = Buffer.concat([header, samples]);
  fs.writeFileSync(filename, wav);
  return filename;
}

// Check for glitches
function checkGlitches(wavPath, threshold = 5000) {
  const buffer = fs.readFileSync(wavPath);
  const dataIdx = buffer.indexOf(Buffer.from('data', 'ascii'));
  const dataStart = dataIdx + 8;
  const dataEnd = buffer.length;

  const samples = [];
  for (let i = dataStart; i < dataEnd - 1; i += 2) {
    samples.push(buffer.readInt16LE(i));
  }

  const glitches = [];
  for (let i = 1; i < samples.length; i++) {
    const diff = Math.abs(samples[i] - samples[i - 1]);
    if (diff > threshold) {
      glitches.push({ sampleIndex: i, diff, prev: samples[i-1], curr: samples[i] });
    }
  }
  return glitches;
}

console.log('=== FFmpeg Crossfade Test ===\n');

// Create test chunks with mismatched boundaries
console.log('Creating chunks with large boundary jumps...');
generateWavWithEndAmplitude(0.3, 8000, '/tmp/chunk1.wav');
generateWavWithEndAmplitude(0.3, -8000, '/tmp/chunk2.wav');
generateWavWithEndAmplitude(0.3, 8000, '/tmp/chunk3.wav');

// Test 1: Direct concatenation (current method)
console.log('\n--- Test 1: Direct Concatenation (NO crossfade) ---');
try {
  execSync('ffmpeg -y -i /tmp/chunk1.wav -i /tmp/chunk2.wav -i /tmp/chunk3.wav -filter_complex "[0][1][2]concat=n=3:v=0:a=1[out]" -map "[out]" /tmp/test-direct.wav 2>/dev/null');
  const directGlitches = checkGlitches('/tmp/test-direct.wav');
  console.log(`Result: ${directGlitches.length} glitches detected`);
  if (directGlitches.length > 0) {
    directGlitches.slice(0, 3).forEach((g, i) => {
      console.log(`  ${i+1}. ${g.prev} → ${g.curr} (jump: ${g.diff})`);
    });
  }
} catch (err) {
  console.error('Direct concat failed:', err.message);
}

// Test 2: With crossfading (proposed solution)
console.log('\n--- Test 2: With 5ms Crossfade (FIXED) ---');
try {
  execSync('ffmpeg -y -i /tmp/chunk1.wav -i /tmp/chunk2.wav -i /tmp/chunk3.wav -filter_complex "[0][1]acrossfade=d=0.005[a01];[a01][2]acrossfade=d=0.005[out]" -map "[out]" /tmp/test-crossfade.wav 2>/dev/null');
  const crossfadeGlitches = checkGlitches('/tmp/test-crossfade.wav');
  console.log(`Result: ${crossfadeGlitches.length} glitches detected`);
  if (crossfadeGlitches.length > 0) {
    crossfadeGlitches.slice(0, 3).forEach((g, i) => {
      console.log(`  ${i+1}. ${g.prev} → ${g.curr} (jump: ${g.diff})`);
    });
  }
} catch (err) {
  console.error('Crossfade failed:', err.message);
}

console.log('\n💾 Test files saved:');
console.log('   Direct:    /tmp/test-direct.wav');
console.log('   Crossfade: /tmp/test-crossfade.wav');
console.log('\nListen to compare:');
console.log('   afplay /tmp/test-direct.wav     # Should have audible clicks');
console.log('   afplay /tmp/test-crossfade.wav  # Should be smooth');

// Cleanup
fs.unlinkSync('/tmp/chunk1.wav');
fs.unlinkSync('/tmp/chunk2.wav');
fs.unlinkSync('/tmp/chunk3.wav');
