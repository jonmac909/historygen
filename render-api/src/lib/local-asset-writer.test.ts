/**
 * Layer 4 — local-asset-writer unit tests (RED until Phase 2 step 3).
 *
 * Tests the new writeLocalAsset / readLocalAsset module:
 *   - Writes bytes to ${LOCAL_ASSETS_DIR}/${kind}/${key}
 *   - Returns ${LOCAL_ASSETS_BASE_URL}/${kind}/${key}
 *   - Round-trip read returns identical bytes
 *   - Validates kind against the locked enum
 *   - Validates key against UUID format
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

let tmpDir: string;

const VALID_KINDS = ['audio', 'images', 'clips', 'renders', 'thumbnails', 'fx'] as const;

describe('Layer 4 — writeLocalAsset / readLocalAsset', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-asset-writer-'));
    for (const k of VALID_KINDS) {
      await fs.mkdir(path.join(tmpDir, k), { recursive: true });
    }
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('LOCAL_ASSETS_DIR', tmpDir);
    vi.stubEnv('LOCAL_ASSETS_BASE_URL', 'http://localhost:3000/assets');
    vi.stubEnv('LOCAL_INFERENCE', 'true');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes bytes to LOCAL_ASSETS_DIR/<kind>/<key>', async () => {
    const { writeLocalAsset } = await import('./local-asset-writer');
    const key = `${randomUUID()}.png`;
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeLocalAsset('images', key, bytes);
    const onDisk = await fs.readFile(path.join(tmpDir, 'images', key));
    expect(onDisk.equals(bytes)).toBe(true);
  });

  it('returns ${LOCAL_ASSETS_BASE_URL}/<kind>/<key>', async () => {
    const { writeLocalAsset } = await import('./local-asset-writer');
    const key = `${randomUUID()}.wav`;
    const url = await writeLocalAsset('audio', key, Buffer.from([1, 2, 3]));
    expect(url).toBe(`http://localhost:3000/assets/audio/${key}`);
  });

  it('round-trips: readLocalAsset returns the same bytes that writeLocalAsset wrote', async () => {
    const { writeLocalAsset, readLocalAsset } = await import('./local-asset-writer');
    const key = `${randomUUID()}.mp4`;
    const bytes = Buffer.from('hello-mp4-bytes');
    await writeLocalAsset('clips', key, bytes);
    const got = await readLocalAsset('clips', key);
    expect(got.equals(bytes)).toBe(true);
  });

  it.each(VALID_KINDS)('accepts kind=%s', async (kind) => {
    const { writeLocalAsset } = await import('./local-asset-writer');
    const url = await writeLocalAsset(kind, `${randomUUID()}.bin`, Buffer.from([1]));
    expect(url).toContain(`/${kind}/`);
  });

  it('rejects an unknown kind', async () => {
    const { writeLocalAsset } = await import('./local-asset-writer');
    await expect(
      // @ts-expect-error: invalid kind
      writeLocalAsset('bogus', `${randomUUID()}.bin`, Buffer.from([1])),
    ).rejects.toThrow();
  });

  it('accepts UUID-formatted keys', async () => {
    const { writeLocalAsset } = await import('./local-asset-writer');
    const uuid = randomUUID();
    const url = await writeLocalAsset('renders', `${uuid}.mp4`, Buffer.from([1]));
    expect(url).toContain(uuid);
  });
});
