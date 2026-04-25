import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import {
  readLocalAsset,
  writeLocalAsset,
  type AssetKind,
} from './local-asset-writer';

// Inlined to avoid depending on ASSET_KINDS from the mocked module in tests
// (r2-storage.test.ts mocks only writeLocalAsset/readLocalAsset). Source of
// truth for the closed enum still lives in ./local-asset-writer.ts.
const VALID_ASSET_KINDS: readonly AssetKind[] = [
  'audio',
  'images',
  'clips',
  'renders',
  'thumbnails',
  'fx',
] as const;

// CALLSITE KIND MAP (Phase 2.3 audit) ----------------------------------------
// Every prior callsite of uploadToR2 / downloadFromR2 maps to a kind below.
// As of Phase 2.3, the only existing callsites in render-api/src/ live in
// routes/generate-audio.ts (8x uploadToR2, 3x downloadFromR2 — all 'audio').
// Future Phase 2.x sub-agents add the remaining file→kind mappings:
//   routes/generate-images.ts          → 'images'
//   routes/generate-video-clips.ts     → 'clips'
//   routes/render-video.ts (final mp4) → 'renders'
//   routes/generate-thumbnails.ts      → 'thumbnails'
//   routes/render-short.ts (mp4)       → 'renders'
//   routes/render-short.ts (interim)   → 'images' / 'audio'
//   routes/delete-project-images.ts    → 'images'
//   lib/video-preprocessor.ts          → classify per call-by-call
//   lib/remotion-renderer.ts           → 'renders'
// Closed enum lives in ./local-asset-writer.ts (single source of truth).
// ---------------------------------------------------------------------------

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'autoaigen-test-assets';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

export async function uploadToR2(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string = 'audio/wav'
): Promise<string> {
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));

  const publicUrl = process.env.R2_PUBLIC_URL;
  if (publicUrl) {
    return `${publicUrl}/${key}`;
  }
  return getSignedDownloadUrl(key, 7 * 24 * 60 * 60);
}

export async function downloadFromR2(key: string): Promise<Buffer> {
  const resp = await s3.send(new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  }));

  const chunks: Uint8Array[] = [];
  const stream = resp.Body as AsyncIterable<Uint8Array>;
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function deleteFromR2(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  }));
}

export async function deleteProjectSegments(projectId: string): Promise<number> {
  const listed = await s3.send(new ListObjectsV2Command({
    Bucket: R2_BUCKET_NAME,
    Prefix: `${projectId}/voiceover-segment-`,
  }));

  const keys = (listed.Contents || []).map(obj => obj.Key!).filter(Boolean);
  let deleted = 0;

  for (const key of keys) {
    await s3.send(new DeleteObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    }));
    deleted++;
  }

  console.log(`[R2] Deleted ${deleted} segment WAVs for project ${projectId}`);
  return deleted;
}

export async function deleteOldAssets(maxAgeDays: number = 30): Promise<number> {
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET_NAME,
      ContinuationToken: continuationToken,
    }));

    for (const obj of (listed.Contents || [])) {
      if (obj.LastModified && obj.LastModified.getTime() < cutoff) {
        await s3.send(new DeleteObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: obj.Key!,
        }));
        deleted++;
      }
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  console.log(`[R2] Retention cleanup: deleted ${deleted} objects older than ${maxAgeDays} days`);
  return deleted;
}

export function getPublicUrl(key: string): string {
  return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${key}`;
}

export async function getSignedDownloadUrl(key: string, expiresIn: number = 3600): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  }), { expiresIn });
}

function isLocalInferenceEnabled(): boolean {
  // Read env live so test env stubs apply without re-importing runtime-config.
  return process.env.LOCAL_INFERENCE === 'true';
}

function assertAssetKind(kind: AssetKind): void {
  if (!VALID_ASSET_KINDS.includes(kind)) {
    throw new TypeError(
      `Invalid asset kind '${String(kind)}'. Expected one of: ${VALID_ASSET_KINDS.join(', ')}`,
    );
  }
}

/**
 * Routes asset uploads to either local disk (LOCAL_INFERENCE=true) or R2.
 *
 * In remote mode the `key` is passed through to `uploadToR2` UNCHANGED to
 * preserve existing R2 keying conventions (e.g. `<projectId>/voiceover.wav`)
 * — the regression snapshot layer pins the wire bytes byte-for-byte.
 *
 * In local mode the layout is `<assetsDir>/<kind>/<key>` and the returned
 * URL is `<assetsBaseUrl>/<kind>/<key>`.
 */
export async function uploadAsset(
  kind: AssetKind,
  key: string,
  bytes: Buffer | Uint8Array,
  contentType?: string,
): Promise<string> {
  assertAssetKind(kind);
  if (isLocalInferenceEnabled()) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    return writeLocalAsset(kind, key, buf);
  }
  // Self-import so vitest's vi.spyOn(mod, 'uploadToR2') intercepts the call:
  // a direct local reference closes over the original binding and bypasses
  // the spy's namespace replacement.
  const self = await import('./r2-storage');
  return self.uploadToR2(key, bytes, contentType);
}

export async function downloadAsset(kind: AssetKind, key: string): Promise<Buffer> {
  assertAssetKind(kind);
  if (isLocalInferenceEnabled()) {
    return readLocalAsset(kind, key);
  }
  const self = await import('./r2-storage');
  return self.downloadFromR2(key);
}

export { s3, R2_BUCKET_NAME };
