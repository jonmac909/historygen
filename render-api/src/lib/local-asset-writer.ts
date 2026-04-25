/**
 * Local asset writer (Phase 2.3 of local-inference-swap).
 *
 * Mirrors the R2 wire contract for local-mode runs: bytes go to disk under
 * `${LOCAL_ASSETS_DIR}/<kind>/<key>` and the returned URL points at the
 * static `/assets` mount served by render-api itself
 * (`${LOCAL_ASSETS_BASE_URL}/<kind>/<key>`).
 *
 * The closed `AssetKind` enum is the only union allowed at the boundary; any
 * other value is a TypeError. `key` is treated as a relative path — single
 * filename or `subdir/filename` is fine; `..` traversal is rejected.
 */

import { promises as fs, mkdirSync } from 'node:fs';
import * as path from 'node:path';

import { localInferenceConfig } from './runtime-config';

export type AssetKind = 'audio' | 'images' | 'clips' | 'renders' | 'thumbnails' | 'fx';

export const ASSET_KINDS: readonly AssetKind[] = [
  'audio',
  'images',
  'clips',
  'renders',
  'thumbnails',
  'fx',
] as const;

function assertKind(kind: AssetKind): void {
  if (!ASSET_KINDS.includes(kind)) {
    throw new TypeError(
      `Invalid asset kind '${String(kind)}'. Expected one of: ${ASSET_KINDS.join(', ')}`,
    );
  }
}

function resolveAssetPath(kind: AssetKind, key: string): { assetPath: string; kindDir: string } {
  // Read assetsDir live each call so test env stubs (LOCAL_ASSETS_DIR) take effect
  // even when this module was imported before the stub.
  const assetsDir = process.env.LOCAL_ASSETS_DIR ?? localInferenceConfig.assetsDir;
  const kindDir = path.resolve(assetsDir, kind);
  const assetPath = path.resolve(kindDir, key);

  // Reject `..` traversal: assetPath must remain inside kindDir.
  const rel = path.relative(kindDir, assetPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error(
      `Refusing to write outside asset kind directory: kind='${kind}', key='${key}'`,
    ) as Error & { code?: string };
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  return { assetPath, kindDir };
}

function publicUrlFor(kind: AssetKind, key: string): string {
  const baseUrl = process.env.LOCAL_ASSETS_BASE_URL ?? localInferenceConfig.assetsBaseUrl;
  // Normalize key separators to forward slashes for the URL.
  const urlKey = key.split(path.sep).join('/');
  return `${baseUrl.replace(/\/$/, '')}/${kind}/${urlKey}`;
}

export async function writeLocalAsset(
  kind: AssetKind,
  key: string,
  bytes: Buffer,
): Promise<string> {
  assertKind(kind);
  const { assetPath } = resolveAssetPath(kind, key);
  mkdirSync(path.dirname(assetPath), { recursive: true });
  await fs.writeFile(assetPath, bytes);
  return publicUrlFor(kind, key);
}

export async function readLocalAsset(kind: AssetKind, key: string): Promise<Buffer> {
  assertKind(kind);
  const { assetPath } = resolveAssetPath(kind, key);
  return fs.readFile(assetPath);
}
