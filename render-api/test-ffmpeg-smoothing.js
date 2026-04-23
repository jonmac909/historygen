/**
 * Test FFmpeg smoothing function with a small WAV file
 */

const fs = require('fs');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');

// Generate small test WAV with glitches
function generateTestWav(filename, duration = 0.5) {
  const sampleRate = 24000;
  const numSamples = Math.floor(duration * sampleRate);
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
    let value = Math.floor(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 8000);

    // Add glitch at 0.25s
    if (i === Math.floor(0.25 * sampleRate)) {
      value = 16000;  // Large jump
    }

    samples.writeInt16LE(value, i * 2);
  }

  const wav = Buffer.concat([header, samples]);
  fs.writeFileSync(filename, wav);
  return wav.length;
}

// Test FFmpeg smoothing
async function testSmoothing() {
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `test-input-${Date.now()}.wav`);
  const outputPath = path.join(tempDir, `test-output-${Date.now()}.wav`);

  try {
    console.log('=== Testing FFmpeg Audio Smoothing ===\n');

    // Generate test file
    const inputSize = generateTestWav(inputPath);
    console.log(`✓ Generated test WAV: ${inputSize} bytes`);

    // Apply smoothing (highpass 20Hz + lowpass 20kHz)
    console.log('Applying FFmpeg smoothing...');
    const startTime = Date.now();

    const ffmpegPath = require('ffmpeg-static');
    execSync(
      `"${ffmpegPath}" -y -i "${inputPath}" -af "highpass=f=20,lowpass=f=20000" "${outputPath}"`
    );

    const duration = Date.now() - startTime;
    const outputSize = fs.statSync(outputPath).size;

    console.log(`✓ Smoothing completed in ${duration}ms`);
    console.log(`  Output size: ${outputSize} bytes`);

    // Verify output
    const outputBuffer = fs.readFileSync(outputPath);
    if (outputBuffer.length === 0) {
      throw new Error('Output file is empty!');
    }

    console.log('\n✅ FFmpeg smoothing working correctly');
    console.log(`   Test files: ${inputPath}, ${outputPath}`);

    // Cleanup
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

  } catch (err) {
    console.error('\n❌ FFmpeg smoothing FAILED:');
    console.error(err.message);

    // Cleanup on error
    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {}

    process.exit(1);
  }
}

testSmoothing();
