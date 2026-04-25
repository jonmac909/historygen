/**
 * Centralized FFmpeg encoder args.
 *
 * Local mode (LOCAL_INFERENCE=true): NVENC hardware encoder on the dev box.
 *   `h264_nvenc` ships with the existing ffmpeg-static@5.3.0 on Windows
 *   (no gyan.dev install needed). Preset p5 + VBR rate-control + CQ 23 is
 *   the quality/speed trade-off agreed in the local-inference-swap plan.
 *
 * Remote mode: software libx264 — preset 'fast' / CRF 26, matching the
 *   FFMPEG_PRESET / FFMPEG_CRF constants in routes/render-video.ts. The
 *   regression snapshot pins remote-mode payloads byte-for-byte; do not
 *   change these without updating the snapshot.
 *
 * Returned array is spread directly into fluent-ffmpeg's
 *   .outputOptions([...]) argument list.
 */

const NVENC_ARGS: readonly string[] = [
  '-c:v', 'h264_nvenc',
  '-preset', 'p5',
  '-rc', 'vbr',
  '-cq', '23',
] as const;

const LIBX264_ARGS: readonly string[] = [
  '-c:v', 'libx264',
  '-preset', 'fast',
  '-crf', '26',
] as const;

export function getEncoderArgs(localMode: boolean): string[] {
  return localMode ? [...NVENC_ARGS] : [...LIBX264_ARGS];
}
