/**
 * Test with REALISTIC TTS-like audio that doesn't end at zero crossings
 * This simulates what Fish Speech TTS actually generates
 */

const fs = require('fs');

// Generate WAV with random amplitude at boundaries (like TTS)
function generateRealisticTTSWav(durationSeconds, sampleRate = 24000) {
  const numSamples = Math.floor(durationSeconds * sampleRate);
  const header = Buffer.alloc(44);

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + numSamples * 2, 4);
  header.write('WAVE', 8);

  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);  // PCM
  header.writeUInt16LE(1, 22);  // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);

  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(numSamples * 2, 40);

  // Generate realistic speech-like waveform (mix of frequencies, random phase)
  const samples = Buffer.alloc(numSamples * 2);
  const amplitude = 8000;

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Mix multiple frequencies like speech formants
    const f1 = 200 * Math.sin(2 * Math.PI * 200 * t + Math.random() * 0.5);
    const f2 = 300 * Math.sin(2 * Math.PI * 850 * t + Math.random() * 0.3);
    const f3 = 150 * Math.sin(2 * Math.PI * 2500 * t + Math.random() * 0.2);
    const noise = (Math.random() - 0.5) * 500; // Add noise

    const value = Math.floor(f1 + f2 + f3 + noise);
    samples.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }

  return Buffer.concat([header, samples]);
}

// Simple concatenation
function concatenateWavFiles(audioChunks) {
  const findChunk = (bytes, fourcc) => {
    const needle = Buffer.from(fourcc, 'ascii');
    for (let i = 0; i <= bytes.length - 4; i++) {
      if (bytes.slice(i, i + 4).equals(needle)) return i;
    }
    return -1;
  };

  const extract = (wav) => {
    const dataIdx = findChunk(wav, 'data');
    const dataSizeOffset = dataIdx + 4;
    const dataSize = wav.readUInt32LE(dataSizeOffset);
    const dataStart = dataIdx + 8;
    const dataEnd = Math.min(wav.length, dataStart + dataSize);
    const header = wav.slice(0, dataStart);
    const data = wav.slice(dataStart, dataEnd);
    return { header, data, dataSizeOffset };
  };

  const first = extract(audioChunks[0]);
  const extracted = audioChunks.map(extract);
  const totalDataSize = extracted.reduce((sum, e) => sum + e.data.length, 0);

  const output = Buffer.alloc(first.header.length + totalDataSize);
  first.header.copy(output, 0);
  output.writeUInt32LE(output.length - 8, 4);
  output.writeUInt32LE(totalDataSize, first.dataSizeOffset);

  let offset = first.header.length;
  for (const e of extracted) {
    e.data.copy(output, offset);
    offset += e.data.length;
  }

  return output;
}

// Check for glitches
function checkForGlitches(wavBuffer, clickThreshold = 5000) {
  const dataIdx = wavBuffer.indexOf(Buffer.from('data', 'ascii'));
  const dataSize = wavBuffer.readUInt32LE(dataIdx + 4);
  const dataStart = dataIdx + 8;
  const dataEnd = Math.min(wavBuffer.length, dataStart + dataSize);

  const samples = [];
  for (let i = dataStart; i < dataEnd - 1; i += 2) {
    samples.push(wavBuffer.readInt16LE(i));
  }

  const glitches = [];
  for (let i = 1; i < samples.length; i++) {
    const diff = Math.abs(samples[i] - samples[i - 1]);
    if (diff > clickThreshold) {
      glitches.push({
        sampleIndex: i,
        diff,
        prevSample: samples[i-1],
        currSample: samples[i]
      });
      if (glitches.length >= 10) break;
    }
  }

  return { samples, glitches };
}

// Run test
console.log('=== Testing REALISTIC TTS-like Audio Concatenation ===\n');

console.log('Generating realistic speech-like audio chunks...');
const chunk1 = generateRealisticTTSWav(0.3);
const chunk2 = generateRealisticTTSWav(0.3);
const chunk3 = generateRealisticTTSWav(0.3);

// Check boundary samples
const c1Data = chunk1.slice(chunk1.indexOf(Buffer.from('data')) + 8);
const c2Data = chunk2.slice(chunk2.indexOf(Buffer.from('data')) + 8);
const c1LastSample = c1Data.readInt16LE(c1Data.length - 2);
const c2FirstSample = c2Data.readInt16LE(0);

console.log(`\nChunk 1 last sample: ${c1LastSample}`);
console.log(`Chunk 2 first sample: ${c2FirstSample}`);
console.log(`Boundary jump: ${Math.abs(c2FirstSample - c1LastSample)}`);

console.log('\nConcatenating chunks...');
const combined = concatenateWavFiles([chunk1, chunk2, chunk3]);

console.log('Checking for glitches...\n');
const result = checkForGlitches(combined, 5000);

if (result.glitches.length === 0) {
  console.log('✅ NO GLITCHES DETECTED');
} else {
  console.log(`❌ DETECTED ${result.glitches.length} GLITCHES:`);
  result.glitches.forEach((g, i) => {
    const timestamp = (g.sampleIndex / 24000).toFixed(3);
    console.log(`  ${i+1}. At ${timestamp}s: ${g.prevSample} → ${g.currSample} (jump: ${g.diff})`);

    // Identify if this is at a chunk boundary
    const chunkSize = 7200; // 0.3s * 24000 samples
    if (g.sampleIndex % chunkSize < 5 || g.sampleIndex % chunkSize > chunkSize - 5) {
      console.log(`     ⚠️  AT CHUNK BOUNDARY`);
    }
  });
}

fs.writeFileSync('/tmp/test-realistic.wav', combined);
console.log('\n💾 Test audio saved to /tmp/test-realistic.wav');
console.log('   Listen with: afplay /tmp/test-realistic.wav');
