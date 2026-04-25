/**
 * Layer 4 — encoder-args unit tests (RED until Phase 2 step 7).
 *
 * Verifies getEncoderArgs(localMode):
 *   - true  -> ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23']
 *   - false -> the existing libx264 args (preset 'fast', crf '26' — see
 *               render-video.ts:45 FFMPEG_PRESET / FFMPEG_CRF)
 */

import { describe, it, expect } from 'vitest';

describe('Layer 4 — getEncoderArgs', () => {
  it('returns h264_nvenc args when localMode=true', async () => {
    const { getEncoderArgs } = await import('./encoder-args');
    expect(getEncoderArgs(true)).toEqual([
      '-c:v', 'h264_nvenc',
      '-preset', 'p5',
      '-rc', 'vbr',
      '-cq', '23',
    ]);
  });

  it('returns libx264 args (preset=fast, crf=26) when localMode=false', async () => {
    const { getEncoderArgs } = await import('./encoder-args');
    expect(getEncoderArgs(false)).toEqual([
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '26',
    ]);
  });

  it('returns array of string flags only', async () => {
    const { getEncoderArgs } = await import('./encoder-args');
    for (const arr of [getEncoderArgs(true), getEncoderArgs(false)]) {
      expect(Array.isArray(arr)).toBe(true);
      arr.forEach(item => expect(typeof item).toBe('string'));
    }
  });
});
