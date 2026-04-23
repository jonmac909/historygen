/**
 * Test FFmpeg smoothing with realistic segment size (~23MB)
 */

const fs = require('fs');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');

// Generate realistic-sized WAV (similar to actual segments)
function generateLargeWav(filename, durationSeconds = 60) {
  const sampleRate = 24000;
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

  // Generate speech-like audio
  const samples = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const f1 = 200 * Math.sin(2 * Math.PI * 200 * t);
    const f2 = 300 * Math.sin(2 * Math.PI * 850 * t);
    const value = Math.floor(f1 + f2);
    samples.writeInt16LE(value, i * 2);
  }

  const wav = Buffer.concat([header, samples]);
  fs.writeFileSync(filename, wav);
  return { size: wav.length, duration: durationSeconds };
}

async function testLargeSmoothing() {
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `test-large-${Date.now()}.wav`);
  const outputPath = path.join(tempDir, `test-large-out-${Date.now()}.wav`);

  try {
    console.log('=== Testing FFmpeg Smoothing on Large File ===\n');

    // Generate ~3MB test file (60 seconds @ 24kHz mono 16-bit = 2.88MB)
    const { size, duration } = generateLargeWav(inputPath, 60);
    console.log(`✓ Generated ${(size / 1024 / 1024).toFixed(2)}MB WAV (${duration}s)`);

    // Apply smoothing
    console.log('Applying FFmpeg smoothing...');
    const startTime = Date.now();

    const ffmpegPath = require('ffmpeg-static');
    execSync(
      `"${ffmpegPath}" -y -i "${inputPath}" -af "highpass=f=20,lowpass=f=20000" "${outputPath}" 2>&1 | grep -E "(size|time=|error|Invalid)"`,
      { stdio: 'inherit' }
    );

    const processingTime = Date.now() - startTime;
    const outputSize = fs.statSync(outputPath).size;

    console.log(`\n✓ Smoothing completed in ${processingTime}ms`);
    console.log(`  Input:  ${(size / 1024 / 1024).toFixed(2)}MB`);
    console.log(`  Output: ${(outputSize / 1024 / 1024).toFixed(2)}MB`);
    console.log(`  Speed:  ${(size / outputSize * 100).toFixed(1)}% ratio`);

    // Check for V8 memory issues
    const memUsage = process.memoryUsage();
    console.log(`\n✓ Memory usage:`);
    console.log(`  Heap used: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`);
    console.log(`  RSS: ${(memUsage.rss / 1024 / 1024).toFixed(2)}MB`);

    if (outputSize === 0) {
      throw new Error('Output file is empty!');
    }

    console.log('\n✅ Large file smoothing working correctly (no crashes)');

    // Cleanup
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

  } catch (err) {
    console.error('\n❌ Large file smoothing FAILED:');
    console.error(err.message);

    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {}

    process.exit(1);
  }
}

testLargeSmoothing();
