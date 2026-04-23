/**
 * Test audio concatenation to detect glitches
 * Generates sample WAV chunks and tests concatenation
 */

const fs = require('fs');

// Generate a simple WAV file with sine wave (simulates TTS output)
function generateTestWav(durationSeconds, frequency, sampleRate = 24000) {
  const numSamples = Math.floor(durationSeconds * sampleRate);
  const header = Buffer.alloc(44);

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + numSamples * 2, 4);
  header.write('WAVE', 8);

  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20);  // audio format (PCM)
  header.writeUInt16LE(1, 22);  // channels (mono)
  header.writeUInt32LE(sampleRate, 24); // sample rate
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);  // block align
  header.writeUInt16LE(16, 34); // bits per sample

  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(numSamples * 2, 40);

  // Generate sine wave samples
  const samples = Buffer.alloc(numSamples * 2);
  const amplitude = 8000; // Typical TTS amplitude

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const value = Math.floor(amplitude * Math.sin(2 * Math.PI * frequency * t));
    samples.writeInt16LE(value, i * 2);
  }

  return Buffer.concat([header, samples]);
}

// Simple concatenation (matches current implementation)
function concatenateWavFiles(audioChunks) {
  const findChunk = (bytes, fourcc) => {
    const needle = Buffer.from(fourcc, 'ascii');
    for (let i = 0; i <= bytes.length - 4; i++) {
      if (bytes.slice(i, i + 4).equals(needle)) {
        return i;
      }
    }
    return -1;
  };

  const extract = (wav) => {
    const fmtIdx = findChunk(wav, 'fmt ');
    const dataIdx = findChunk(wav, 'data');

    const fmtDataStart = fmtIdx + 8;
    const sampleRate = wav.readUInt32LE(fmtDataStart + 4);
    const channels = wav.readUInt16LE(fmtDataStart + 2);
    const bitsPerSample = wav.readUInt16LE(fmtDataStart + 14);
    const byteRate = wav.readUInt32LE(fmtDataStart + 8);

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

  let offset = first.header.length;
  for (const e of extracted) {
    e.data.copy(output, offset);
    offset += e.data.length;
  }

  return output;
}

// Check for sample-level discontinuities (clicks/pops)
function checkForGlitches(wavBuffer) {
  const dataMarker = Buffer.from('data', 'ascii');
  let dataIdx = -1;
  for (let i = 0; i <= wavBuffer.length - 4; i++) {
    if (wavBuffer.slice(i, i + 4).equals(dataMarker)) {
      dataIdx = i;
      break;
    }
  }

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

  const dataSize = wavBuffer.readUInt32LE(dataIdx + 4);
  const dataStart = dataIdx + 8;
  const dataEnd = Math.min(wavBuffer.length, dataStart + dataSize);

  // Read samples
  const samples = [];
  for (let i = dataStart; i < dataEnd - 1; i += 2) {
    samples.push(wavBuffer.readInt16LE(i));
  }

  console.log(`Total samples: ${samples.length}`);
  console.log(`Duration: ${(samples.length / sampleRate).toFixed(2)}s`);

  // Detect large sample-to-sample jumps
  const clickThreshold = 5000;
  const glitches = [];

  for (let i = 1; i < samples.length; i++) {
    const diff = Math.abs(samples[i] - samples[i - 1]);
    if (diff > clickThreshold) {
      const timestamp = i / sampleRate;
      glitches.push({ timestamp, diff, sampleIndex: i });
      if (glitches.length >= 10) break; // Limit output
    }
  }

  return glitches;
}

// Run test
console.log('=== Testing Audio Concatenation ===\n');

// Generate 3 test chunks with different frequencies (simulates TTS variability)
console.log('Generating test audio chunks...');
const chunk1 = generateTestWav(0.5, 440);  // 0.5s @ 440Hz (A note)
const chunk2 = generateTestWav(0.5, 554);  // 0.5s @ 554Hz (C# note)
const chunk3 = generateTestWav(0.5, 659);  // 0.5s @ 659Hz (E note)

console.log(`Chunk 1: ${chunk1.length} bytes`);
console.log(`Chunk 2: ${chunk2.length} bytes`);
console.log(`Chunk 3: ${chunk3.length} bytes\n`);

// Concatenate
console.log('Concatenating chunks...');
const combined = concatenateWavFiles([chunk1, chunk2, chunk3]);
console.log(`Combined: ${combined.length} bytes\n`);

// Check for glitches
console.log('Checking for glitches...');
const glitches = checkForGlitches(combined);

if (glitches.length === 0) {
  console.log('✅ NO GLITCHES DETECTED - Concatenation is clean!');
} else {
  console.log(`❌ DETECTED ${glitches.length} GLITCHES:`);
  glitches.forEach(g => {
    console.log(`  - At ${g.timestamp.toFixed(3)}s: sample jump of ${g.diff} (sample ${g.sampleIndex})`);
  });
  console.log('\nGlitches found at chunk boundaries - concatenation creates discontinuities!');
}

// Save test file for manual listening
fs.writeFileSync('/tmp/test-concat.wav', combined);
console.log('\n💾 Test audio saved to /tmp/test-concat.wav');
console.log('   Listen with: afplay /tmp/test-concat.wav');
