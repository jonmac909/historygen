/**
 * Zod schemas for the local-inference HTTP boundary between render-api and
 * the three local Python servers (VoxCPM2:7861, Z-Image:7862, LTX-2:7863).
 *
 * Wire convention: camelCase end-to-end (matches each server's Pydantic
 * `Field(alias=...)`). Field names + ranges + defaults mirror the Python
 * source of truth so render-api Zod and Python Pydantic accept exactly
 * the same payloads.
 *
 * Source of truth for each schema:
 *   - voxcpm2RequestSchema  -> local-inference/voxcpm2_server.py: class TTSRequest
 *   - zimageRequestSchema   -> local-inference/zimage_server.py:  class GenerateRequest
 *   - ltx2RequestSchema     -> local-inference/ltx2_server.py:    class I2VRequest
 *
 * Error envelope (from local-inference/common.py error_envelope):
 *   { error: { code, message, details } }
 *   code in: VALIDATION_ERROR | NOT_FOUND | RATE_LIMITED | INTERNAL_ERROR | BUSY
 */

import { z } from 'zod';

// -- error envelope --------------------------------------------------------

export const errorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'BUSY',
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).nullable(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

// -- VoxCPM2 (port 7861, POST /tts) ----------------------------------------

export const voxcpm2RequestSchema = z.object({
  text: z.string().min(5).max(500),
  referenceAudioBase64: z.string().optional(),
  referenceTranscript: z.string().optional(),
  emotion: z.string().optional(),
  temperature: z.number().min(0.5).max(1.5).default(0.9),
  topP: z.number().min(0).max(1).default(0.85),
  repetitionPenalty: z.number().min(1).max(2).default(1.1),
  seed: z.number().int().optional(),
});

export type Voxcpm2Request = z.infer<typeof voxcpm2RequestSchema>;

// -- Z-Image-Turbo (port 7862, POST /generate) -----------------------------

export const aspectRatioSchema = z.enum(['16:9', '9:16', '1:1']);
export type AspectRatio = z.infer<typeof aspectRatioSchema>;

export const imageQualitySchema = z.enum(['high', 'basic']);
export type ImageQuality = z.infer<typeof imageQualitySchema>;

export const zimageRequestSchema = z.object({
  prompt: z.string().min(10).max(2000),
  negativePrompt: z.string().max(2000).default(''),
  aspectRatio: aspectRatioSchema.default('16:9'),
  quality: imageQualitySchema.default('high'),
  seed: z.number().int().optional(),
});

export type ZimageRequest = z.infer<typeof zimageRequestSchema>;

// -- LTX-2 (port 7863, POST /i2v) ------------------------------------------

export const videoResolutionSchema = z.enum(['720p', '480p']);
export type VideoResolution = z.infer<typeof videoResolutionSchema>;

export const ltx2RequestSchema = z.object({
  prompt: z.string().min(10).max(2000),
  imageBase64: z.string().min(1),
  negativePrompt: z.string().max(2000).default(''),
  durationSeconds: z.number().min(3).max(10).default(5),
  resolution: videoResolutionSchema.default('720p'),
  seed: z.number().int().optional(),
});

export type Ltx2Request = z.infer<typeof ltx2RequestSchema>;

// -- /healthz response (all 3 servers, GET /healthz) -----------------------

export const healthzStatusSchema = z.enum(['idle', 'loading', 'ready', 'busy', 'error']);
export type HealthzStatus = z.infer<typeof healthzStatusSchema>;

export const healthzResponseSchema = z.object({
  status: healthzStatusSchema,
  modelLoaded: z.boolean(),
});

export type HealthzResponse = z.infer<typeof healthzResponseSchema>;

// -- /config response (render-api GET /config, frontend boot) --------------

export const configResponseSchema = z.object({
  localInferenceMode: z.boolean(),
});

export type ConfigResponse = z.infer<typeof configResponseSchema>;

// -- Generic union exports for backwards compatibility with Layer 3 test ---
// Layer 3 test imports `LocalInferenceRequest` and `LocalInferenceResponse`
// as Zod schemas (calls .parse). Both are unions over the canonical
// per-server schemas. Route handlers should prefer the canonical names
// for type narrowing.

export const LocalInferenceRequest = z.union([
  voxcpm2RequestSchema,
  zimageRequestSchema,
  ltx2RequestSchema,
]);

export type LocalInferenceRequestT = z.infer<typeof LocalInferenceRequest>;

// LocalInferenceResponse: the boundary returns either bytes (200) or an
// error envelope (4xx/5xx). At the schema level we model only the error
// shape since binary responses aren't Zod-shaped. Route consumers parse
// 200 responses by content-type, not Zod.
export const LocalInferenceResponse = errorEnvelopeSchema;

export type LocalInferenceResponseT = z.infer<typeof LocalInferenceResponse>;
