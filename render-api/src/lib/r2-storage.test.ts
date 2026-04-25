/**
 * Layer 4 — r2-storage unit tests (RED until Phase 2 step 2).
 *
 * Verifies uploadAsset(kind, key, bytes, contentType) routes to:
 *   - writeLocalAsset (mocked) when localInferenceConfig.enabled=true
 *   - uploadToR2 (mocked) otherwise
 * Same routing for downloadAsset. The 'kind' parameter maps to the correct subdirectory.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the local-asset-writer (does not exist yet — this drives the new module)
vi.mock('./local-asset-writer', () => ({
  writeLocalAsset: vi.fn(async (kind: string, key: string) => `http://localhost:3000/assets/${kind}/${key}`),
  readLocalAsset: vi.fn(async (_kind: string, _key: string) => Buffer.from('local-bytes')),
}));

describe('Layer 4 — uploadAsset routing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('exports uploadAsset and downloadAsset functions', async () => {
    const mod = await import('./r2-storage');
    expect(typeof (mod as any).uploadAsset).toBe('function');
    expect(typeof (mod as any).downloadAsset).toBe('function');
  });

  it('routes to writeLocalAsset when LOCAL_INFERENCE=true', async () => {
    vi.stubEnv('LOCAL_INFERENCE', 'true');
    const writer = await import('./local-asset-writer');
    const { uploadAsset } = await import('./r2-storage');
    const url = await uploadAsset('images', 'test-key.png', Buffer.from([1, 2, 3]), 'image/png');
    expect(writer.writeLocalAsset).toHaveBeenCalledWith('images', 'test-key.png', expect.any(Buffer));
    expect(url).toMatch(/^http:\/\/localhost:3000\/assets\/images\//);
  });

  it('routes to uploadToR2 when LOCAL_INFERENCE is unset', async () => {
    vi.stubEnv('LOCAL_INFERENCE', '');
    const r2Mod = await import('./r2-storage');
    const spy = vi.spyOn(r2Mod, 'uploadToR2').mockResolvedValue('https://r2.example/test.png');
    await (r2Mod as any).uploadAsset('images', 'test-key.png', Buffer.from([1, 2, 3]), 'image/png');
    expect(spy).toHaveBeenCalled();
  });

  it('downloadAsset routes to readLocalAsset when LOCAL_INFERENCE=true', async () => {
    vi.stubEnv('LOCAL_INFERENCE', 'true');
    const writer = await import('./local-asset-writer');
    const { downloadAsset } = await import('./r2-storage');
    const buf = await downloadAsset('audio', 'sample.wav');
    expect(writer.readLocalAsset).toHaveBeenCalledWith('audio', 'sample.wav');
    expect(buf).toBeInstanceOf(Buffer);
  });

  it.each([
    ['audio', 'audio/wav'],
    ['images', 'image/png'],
    ['clips', 'video/mp4'],
    ['renders', 'video/mp4'],
    ['thumbnails', 'image/jpeg'],
    ['fx', 'video/mp4'],
  ] as const)('accepts kind=%s and routes to subdir', async (kind, contentType) => {
    vi.stubEnv('LOCAL_INFERENCE', 'true');
    const writer = await import('./local-asset-writer');
    const { uploadAsset } = await import('./r2-storage');
    await uploadAsset(kind, `key.bin`, Buffer.from([1]), contentType);
    expect(writer.writeLocalAsset).toHaveBeenCalledWith(kind, 'key.bin', expect.any(Buffer));
  });

  it('rejects an unknown kind', async () => {
    vi.stubEnv('LOCAL_INFERENCE', 'true');
    const { uploadAsset } = await import('./r2-storage');
    // @ts-expect-error: testing runtime guard against bad kind
    await expect(uploadAsset('bogus', 'x.bin', Buffer.from([1]), 'application/octet-stream')).rejects.toThrow();
  });
});
