# Changelog

All notable changes to historygen.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] — `feat/local-inference` branch

### Added — local-inference swap (RunPod + Kie.ai + R2 → localhost)

Plan: [.claude/plans/local-inference-swap.md](.claude/plans/local-inference-swap.md)

Three local Python FastAPI servers that wrap the existing model installs:

- **VoxCPM2 TTS** (`local-inference/voxcpm2_server.py`, port 7861) — ✅ verified end-to-end on RTX 5070 12 GB. Cold load 28 s, warm 7.5 s, 11 GB VRAM peak, releases on `/unload`.
- **Z-Image-Turbo** (`local-inference/zimage_server.py`, port 7862) — code complete; hardware-blocked at 12 GB VRAM (cpu staging blows Windows pagefile, force-cuda OOMs). Pending RTX 5080 16 GB upgrade.
- **LTX-2 22B** (`local-inference/ltx2_server.py`, port 7863) — code complete; hardware-blocked at 12 GB. Probe-and-fallback design in `generate-video-clips.ts` routes to Kie.ai when LTX-2 unreachable.

`render-api` swap landed across 10 sub-steps:

- `localInferenceConfig` env-var bundle (`runtime-config.ts`)
- Shared Zod schemas matching Python Pydantic shapes (`schemas/local-inference-schemas.ts`)
- `uploadAsset` / `downloadAsset` wrappers branching on the flag (`r2-storage.ts`); local-disk writer at `local-asset-writer.ts`
- Cost-tracker rates → 0 for local services (`cost-tracker.ts`)
- `GET /health`, `GET /config`, `app.use('/assets', static)` + boot guards (production safety + write-sentinel) in `index.ts`
- `generate-audio.ts`, `generate-images.ts`, `generate-video-clips.ts`, `render-video.ts`, `runpod.ts` — feature-flagged local branches; remote-mode behavior byte-identical
- `h264_nvenc` encoder for local-mode renders (`encoder-args.ts`); ffmpeg-static@5.3.0 ships NVENC on Windows so no separate ffmpeg install
- Smoke + embers overlays cached at `local-assets/fx/` (sourced from `public/overlays/`); the dead `historygenai.netlify.app/overlays/...` URL stays intact for production but local mode bypasses it
- `assertAllowedAssetUrl` allows `http://localhost:*` in local mode

`render-api/tests/` — vitest 4 + supertest + msw 2 installed; 11 RED test files written across 8 layers (walking skeleton, Gherkin, API contract, unit, regression snapshot, lifecycle API, lifecycle browser, lint/type/build). 47 unit tests + Layer 3 contract green. `tsc --noEmit` 0 errors.

Frontend (`src/lib/api.ts` + `src/App.tsx`):

- `getLocalInferenceMode()` boot probe to render-api `/config` with 2 s timeout + safe `false` default
- `ApiClient` interface + `getApiClient(localMode)` factory (current implementation routes everything through render-api since render-api itself owns local-vs-remote routing — kept for future Edge-Function escape hatch)
- `ConfigProbeBanner` dev-only red toast when `/config` probe fails

### Fixed during Phase 4 verification

- **dotenv ordering bug in `render-api/src/index.ts`** — `dotenv.config()` ran AFTER route imports that called env-reading factories at module load. Result: render-api crashed at boot with `ANTHROPIC_API_KEY not configured` even when `.env` had a value. Fix: `import 'dotenv/config'` at line 1 (before any other import).
- **`patch_safetensors_force_cuda()` variant added to `local-inference/common.py`** — for callers that hard-code `device='cpu'` and crash on Windows pagefile mmap. Z-Image's force-cuda fit was wrong (loads all shards to GPU at once → OOM); kept as escape hatch for LTX-2's eventual use Monday.

### Known limitations

- **RTX 5070 12 GB hardware block**: Z-Image-Turbo and LTX-2 both exceed VRAM on this card. Phase 4 verification of these two paths waits for the **RTX 5080 16 GB upgrade Monday**. VoxCPM2 + Kie.ai fallback for video clips works today.
- **Z-Image perf on Blackwell sm_120 Windows**: no flash-attn wheel for cu128, falls back to native SDPA at ~5 min/step. Even on the 5080 this remains slow for 1080p. Mitigation: default local mode to 1024×1024 for testing (~3.5× less compute).
- **Layer 5 regression snapshot tests for /generate-images/audio/clips**: stay RED because the test's `vi.unstubAllEnvs()` clears `ANTHROPIC_API_KEY`, breaking the `app` import. Test-infra issue, not a code issue. Documented for the next phase.
