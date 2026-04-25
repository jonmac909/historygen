# Change Plan: Local Inference + Local Final Render

Status: tests-written
Updated: 2026-04-24
Slug: local-inference-swap
Branch: feat/local-inference (PR + squash-merge to `main` when complete)

## Spec (from question loop)

- **What**: replace four remote services (RunPod Z-Image, RunPod VoxCPM2 endpoint `s7wnnxpnv1vqa1`, Kie.ai Bytedance I2V, Render.com `render-api` host) with localhost inference + Cloudflare R2 → local-disk asset storage.
- **Models**:
  - VoxCPM2 (already pip-installed at `D:\VoxCPM\.venv`) — TTS
  - Z-Image-Turbo (8-step distilled, 6B, ~12 GB VRAM, 5–15 s/image) at `D:\Z-Image` — image gen
  - LTX-2 22B DistilledPipeline + FP8 cast + sequential CPU offload at `D:\LTX-2` — image-to-video
- **Hardware**: RTX 5070 12 GB now, 5080 16 GB Monday. LTX-2 needs CPU offload on either; VoxCPM2 + Z-Image-Turbo fit comfortably.
- **Concurrency**: each Python server is its own process with idle-unload after 90 s; render-api stages run sequentially so two GPU models are never live at once. Image-gen rolling concurrency drops from 4 to 1 in local mode.
- **Storage**: R2 fully replaced in local mode. `uploadToR2` becomes a router that branches on `LOCAL_INFERENCE`. Local writes land under `D:\historygen\local-assets\{images,audio,clips,renders,fx}\`. Render-api serves them at `/assets/*` via `express.static`.
- **Final render**: KENBURNS GPU + RunPod CPU chunk-renderer disabled; local CPU Ken Burns + sequential chunks. Encoder swaps `libx264` → `h264_nvenc` via gyan.dev full ffmpeg build (`FFMPEG_PATH` env override). Smoke/embers overlays cached locally at `local-assets/fx/`.
- **Cost tracker**: `z_image`, `seedance`, `voxcpm2`, `fish_speech` rates → 0 in local mode; `cost_usd=0` rows still written. Claude/Whisper rates unchanged.
- **Feature flag**: `LOCAL_INFERENCE=false` is the safe default. Production Vercel env never sets it. `LOCAL_INFERENCE=true` in `render-api/.env` only on the dev box.
- **Test infra**: render-api currently has zero tests; install `vitest`, `supertest`, `msw` as part of Phase 0; write all 8 test layers before any swap code.
- **Branch**: `feat/local-inference`. Vercel preview URLs auto-generate; main stays shippable.

## Breakage Map

### Will break (must fix)

| File | Line(s) | What | Fix |
|---|---|---|---|
| `render-api/src/routes/generate-audio.ts` | 17 + 8 callsites of `uploadToR2` (2488, 2764, 3098, 3259, 3455, 3587, 3915) | R2-only audio upload | Route through new `uploadAsset(kind, key, bytes, contentType)` helper that branches on `LOCAL_INFERENCE` |
| `render-api/src/routes/generate-audio.ts` | ~1737–1860 | RunPod VoxCPM2 polling | Add `LOCAL_INFERENCE` branch: single sync `POST` to `LOCAL_VOXCPM2_URL/tts`, skip polling |
| `render-api/src/routes/generate-images.ts` | 71–171, 174 | RunPod Z-Image polling + R2 upload | Add `LOCAL_INFERENCE` branch: sync `POST` to `LOCAL_ZIMAGE_URL/generate`; route upload through `uploadAsset`; emit SSE `started` / `completed` events around the sync call. Concurrency: **no code change** — already reads from `imageGenerationConfig.maxConcurrentJobs` (line 329). Set env `ZIMAGE_MAX_CONCURRENCY=1` in `render-api/.env` for local dev. (ZG-5) |
| `render-api/src/routes/generate-video-clips.ts` | 70–187, 354–403, 82, 220–224 | Kie.ai I2V polling + R2 upload | Extract `submitClipJob(clip,opts)`; LOCAL branch posts to `LOCAL_LTX2_URL/i2v`; pass through `clips[i].prompt` (drop hard-coded motion); keep fade-in/out; route upload through `uploadAsset` |
| `render-api/src/routes/render-video.ts` | 90, 91, 261, 278–340, 453, 599, 718 | KENBURNS GPU + RunPod CPU chunk fan-out | Wrap both branches in `if (!LOCAL_INFERENCE)`; CPU Ken Burns at 1092–1181 becomes the only path locally; chunks render sequentially |
| `render-api/src/routes/render-video.ts` | 1114, 1136, 1191, 1279 | `'-c:v', 'libx264'` hard-coded | Centralize via `getEncoderArgs(localMode)` helper. Local: `'-c:v','h264_nvenc','-preset','p5','-rc','vbr','-cq','23'`. Remote: unchanged |
| `render-api/src/routes/render-video.ts` | 61–62, 941–967 | smoke/embers downloaded from `historygenai.netlify.app` per render | Local mode reads `${LOCAL_ASSETS_DIR}/fx/embers.mp4` and `…/smoke_gray.mp4` directly. Same FFmpeg filter graph at 1239–1253 |
| `render-api/src/routes/render-video.ts` | 1466–1526 | `streamUploadToSupabase` for final MP4 | Route through `uploadAsset('renders', ...)` |
| `render-api/src/lib/r2-storage.ts` | 18 | `uploadToR2` is the wrong abstraction now | Wrap in (or replace with) `uploadAsset(kind, key, bytes, contentType)` that delegates to either R2 or local-disk based on `LOCAL_INFERENCE` |
| `render-api/src/lib/runtime-config.ts` | 1–57 | env loader uses plain `process.env`, no validation | Add `LOCAL_INFERENCE`, `LOCAL_VOXCPM2_URL`, `LOCAL_ZIMAGE_URL`, `LOCAL_LTX2_URL`, `LOCAL_ASSETS_DIR`, `LOCAL_ASSETS_BASE_URL`, `FFMPEG_PATH` with safe-default fallbacks. Match existing pattern (no Zod) |
| `render-api/src/lib/cost-tracker.ts` | rate map + switch | hard-coded rates | Branch on `LOCAL_INFERENCE`: 4 services → 0; skip writing the RunPod-CPU-chunk-renderer row entirely (it doesn't run) |
| `render-api/src/utils/runpod.ts` | 1–91 | `allocateWorkers*` calls RunPod control plane | No-op `return` when `LOCAL_INFERENCE` |
| `render-api/src/index.ts` | ~218 | no static asset serve | `app.use('/assets', express.static(LOCAL_ASSETS_DIR))` when `LOCAL_INFERENCE` |
| `render-api/src/routes/render-short.ts`, `generate-thumbnails.ts`, `generate-short.ts`, `generate-captions.ts`, `delete-project-images.ts`, `lib/video-preprocessor.ts`, `lib/remotion-renderer.ts` | grep showed all reference R2 | each `uploadToR2` / `downloadFromR2` callsite routes through `uploadAsset` / `downloadAsset` helpers (single change, mass effect) |
| `D:\historygen\.env` | new file | none | `VITE_RENDER_API_URL=http://localhost:3000` (dev box only — Vercel env keeps the Render.com URL) |
| `D:\historygen\render-api\.env` | new file | none | `LOCAL_INFERENCE=true`, `LOCAL_*_URL`, `LOCAL_ASSETS_*`, `FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe` (gyan.dev path), keep `ANTHROPIC_API_KEY` + `OPENAI_API_KEY` + `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` |
| `D:\historygen\local-assets\` | new dir | none | Pre-create `images/`, `audio/`, `clips/`, `renders/`, `fx/`. `.gitignore` everything except `fx/` (commit smoke + embers). One-time download: `curl -L https://historygenai.netlify.app/embers.mp4 -o local-assets/fx/embers.mp4`, same for `smoke_gray.mp4` |
| `D:\historygen\.gitignore` | append | none | `local-assets/images/`, `local-assets/audio/`, `local-assets/clips/`, `local-assets/renders/` |
| `D:\historygen\playwright.config.ts` | 15, 29, 74–78 | baseURL + webServer commented out | Configure `baseURL: 'http://localhost:5173'` and a `webServer` block that starts frontend + render-api + the 3 Python servers + healthcheck before running e2e |

### Won't break

- `runpod-voxcpm2-worker/`, `runpod-video-worker/` directories — empty placeholders, untouched
- `render_jobs` and `project_costs` table schemas — rows still written, only values change
- Supabase auth + DB rows — unchanged in either mode
- Existing R2 assets — old project URLs continue to resolve (Vercel deploy still uses R2); local mode just stops adding new ones
- Anthropic Claude script generation, OpenAI Whisper voice-sample transcription — still cloud APIs in both modes
- Frontend SSE / progress event format — payload shapes unchanged
- Vercel deploy — feature flag is dev-only; production env vars never set `LOCAL_INFERENCE=true`
- Existing frontend tests in `D:\historygen\src\test\*` and `D:\historygen\src\lib\api.test.ts` — pre-existing pass/fail state; not in scope to fix
- The 8-callsite count for `uploadToR2` in `generate-audio.ts` — same call shape; routing change is in the helper, not the callers (after refactor)

### Convention checks (ONE Convention Everywhere)

- **Naming**: local-server JSON payloads use camelCase (`referenceAudioBase64`, not `reference_audio_base64`). Existing RunPod payloads stay snake_case (their handler convention). Boundary anomaly contained to one file.
- **IDs**: asset filenames use `crypto.randomUUID()`.
- **Errors**: local servers return `{ error: { code, message, details } }` on 4xx/5xx. Codes: `VALIDATION_ERROR`, `NOT_FOUND`, `RATE_LIMITED`, `INTERNAL_ERROR`.
- **Validation**: shared Zod schemas in `render-api/src/schemas/local-inference-schemas.ts` for outgoing render-api payloads. Python servers re-validate with equivalent Pydantic models.

## Phase 0: Prereqs + test infrastructure + 8 layers (BEFORE any swap code)

### Phase 0.0 — Prereqs (gaps 1.3, 1.6, 4.3, 4.4)
- [ ] Install Jason Method bundle into `~/.claude/`. Skip-if-exists for items already present (don't clobber the user's existing `D:\historygen\.claude\plans\voxcpm2-tts-swap.md` or `.claude_settings.json`):
  ```
  cp -rn C:\Users\jonst\AppData\Local\Temp\Rar$DRa21516.780\jason-method-bundle\commands\* ~\.claude\commands\
  cp -rn ...skills\* ~\.claude\skills\
  cp -rn ...rules\* ~\.claude\rules\
  cp -rn ...scripts\* ~\.claude\scripts\
  chmod +x ~\.claude\scripts\*.sh
  ```
- [ ] Copy this plan to `D:\historygen\.claude\plans\local-inference-swap.md` (the slug `validate-plan.sh` expects)
- [ ] Read `D:\historygen\.claude_settings.json` for any hooks/permissions that affect bundle behavior; merge as needed
- [ ] Create branch: `cd D:\historygen && git checkout -b feat/local-inference`
- [ ] Confirm `git remote get-url origin` returns `https://github.com/jonmac909/historygen.git`

### Phase 0.1 — Test infrastructure
- [ ] `cd render-api && npm install -D vitest @vitest/coverage-v8 supertest msw @types/supertest` — install deps
- [ ] Add to `render-api/package.json` scripts: `test`, `test:watch`, `test:coverage`, `lint`, `typecheck`
- [ ] Create `render-api/vitest.config.ts` (Node env, globals on, setupFiles for msw bootstrap)
- [ ] Create `render-api/tests/setup.ts` (msw `setupServer` + cleanup hooks)
- [ ] Create `render-api/tests/helpers/` (test-id factories, sample WAV/PNG/MP4 fixtures)
- [ ] **Layer 1 — Walking skeleton**: `render-api/tests/integration/local-inference-swap.test.ts` — feature flag on → image gen → audio gen → final render produces MP4 at `local-assets/renders/*.mp4`. msw mocks the 3 Python servers
- [ ] **Layer 2 — Gherkin features**: `render-api/tests/features/local-inference-swap.feature` — scenarios for each happy path + each error envelope + flag-off regression
- [ ] **Layer 3 — API contract**: `render-api/tests/api/local-inference-swap.test.ts` — every modified route: Zod-validates incoming body, mocked local-server gets right payload, response shape unchanged from remote, `cost_usd=0` row written. **Plus SSE event coverage** (ZG-11): assert `started` / `in_progress` (LTX-2 every 30 s) / `completed` events fire in order with correct payload shape during a mocked local-mode pipeline run. Also covers the `POST /unload`-to-all-three call between stage transitions
- [ ] **Layer 4 — Unit tests**: colocated `*.test.ts` next to `cost-tracker.ts`, `runtime-config.ts`, `r2-storage.ts` (new `uploadAsset` helper), `local-inference-schemas.ts`, `local-asset-writer.ts`
- [ ] **Layer 5 — Regression snapshots**: `render-api/tests/regression/remote-mode-unchanged.test.ts` — with `LOCAL_INFERENCE=false`, every route's outgoing payload (to RunPod / Kie.ai / R2) matches a captured baseline byte-for-byte
- [ ] **Layer 6 — API lifecycle**: `render-api/tests/lifecycle/api-local-inference.test.ts` — `POST /generate-images` → `GET /assets/images/<uuid>.png` returns 200 + `image/png`. Same for audio + clips + renders
- [ ] **Layer 7 — Browser lifecycle**: `D:\historygen\tests\local-inference.spec.ts` (Playwright) — sign in → open project → Generate Short → final video plays from `localhost:3000/assets/renders/...`. Configure `playwright.config.ts` `baseURL: 'http://localhost:5173'` + `webServer: [...]` array (ZG-10):
  ```ts
  webServer: [
    { command: 'python voxcpm2_server.py', cwd: 'D:\\local-inference', url: 'http://localhost:7861/healthz', timeout: 30_000, reuseExistingServer: true },
    { command: 'python zimage_server.py',  cwd: 'D:\\local-inference', url: 'http://localhost:7862/healthz', timeout: 30_000, reuseExistingServer: true },
    { command: 'python ltx2_server.py',    cwd: 'D:\\local-inference', url: 'http://localhost:7863/healthz', timeout: 30_000, reuseExistingServer: true },
    { command: 'npm run dev',              cwd: 'D:\\historygen\\render-api', url: 'http://localhost:3000/health', timeout: 60_000, reuseExistingServer: true },
    { command: 'npm run dev',              cwd: 'D:\\historygen',             url: 'http://localhost:5173',         timeout: 60_000, reuseExistingServer: true },
  ],
  ```
  Note (ZG-20): no `PRE_WARM` env — single-GPU contention prevents pre-warming all 3 simultaneously. `/healthz` returns 200 when the server can accept requests (model lazy-loads on the first `/tts`/`/generate`/`/i2v`). Tests serialize via the test runner, and stage-coordinated `/unload` calls (ZG-23) free VRAM between stages. `cwd:` config replaces shelled `cd &&` chains (ZG-27).
- [ ] **Layer 8 — Lint/type/build gates**: `cd render-api && npx tsc --noEmit` returns 0; `npm run lint` returns 0; `npm run build` produces `dist/`
- [ ] Run `bash D:\historygen\.claude\scripts\validate-plan.sh local-inference-swap` returns 4/4 (need to copy validate-plan.sh from the bundle into the project's `.claude/scripts/`)
- [ ] All 8 layers RED. Set plan `Status: tests-written`. Commit with `[skip ci]` so Vercel preview doesn't try to build red tests

## Phase 1: Python local-inference servers

- [ ] Create `D:\local-inference\` directory structure
- [ ] `D:\local-inference\common.py` — `IdleUnloader` class (90 s timer + `torch.cuda.empty_cache()` + `gc.collect()`), error envelope helper, FastAPI scaffolding
- [ ] `D:\local-inference\requirements.txt` — `fastapi`, `uvicorn[standard]`, `pydantic`, `python-multipart`, `soundfile`, `pillow`
- [ ] **VoxCPM2** (`voxcpm2_server.py`, port 7861): wraps existing pip-installed `voxcpm` package; `POST /tts` accepts shared schema; `POST /unload` (idempotent — frees model, returns 200) (ZG-2); `GET /healthz` returns `{ status: 'idle'|'loading'|'ready'|'error', modelLoaded: bool }`; `GET /healthz?ready=1` blocks until model ready (used by Playwright + verify script) (ZG-7). `PRE_WARM=1` env loads model at startup. First-request weight pull from `D:\hf_cache`
- [ ] **Z-Image-Turbo** (`zimage_server.py`, port 7862): set up `D:\Z-Image\.venv` (`uv` or pip from `pyproject.toml`); reuse `inference.py:11` (`from zimage import generate`) and `inference.py:51` (`load_from_local_dir`); auto-fetch weights via `ensure_model_weights("ckpts/Z-Image-Turbo")` to `D:\hf_cache`. `POST /generate`, `POST /unload`, `GET /healthz` (same shape as VoxCPM2). **VRAM fallback** (gap 1.4): try BF16 first; on `torch.cuda.OutOfMemoryError`, fall back to FP8 quantization + `enable_model_cpu_offload()`. Log which config succeeded
- [ ] **LTX-2** (`ltx2_server.py`, port 7863): set up `D:\LTX-2\.venv` (`uv sync --frozen`). Pre-implementation step (ZG-25): read `D:\LTX-2\packages\ltx-pipelines\src\ltx_pipelines\distilled.py` and verify `enable_sequential_cpu_offload` exists. If absent, use only `quantization=QuantizationPolicy.fp8_cast()` per the LTX-2 README. Do NOT invent an offload API. Download required weights (`ltx-2.3-22b-distilled-1.1.safetensors`, spatial upscaler, distilled LoRA, Gemma 3 text encoder) to `D:\hf_cache`. `POST /i2v` streams NDJSON heartbeats (one JSON object per line, terminated with `\n`); render-api consumes via `for await (chunk of response.body)` reader and re-emits as SSE (ZG-21). `POST /unload`, `GET /healthz` (same shape as VoxCPM2). **Weight download** (ZG-30): use the venv-prefixed path:
  ```
  & "D:\VoxCPM\.venv\Scripts\python.exe" -m huggingface_hub.commands.huggingface_cli download Lightricks/LTX-2.3 --local-dir D:\hf_cache\Lightricks--LTX-2.3 --include "ltx-2.3-22b-distilled-1.1.safetensors" "ltx-2.3-spatial-upscaler-x2-1.1.safetensors" "ltx-2.3-22b-distilled-lora-384-1.1.safetensors"
  ```
  Run overnight; total ~30 GB
- [ ] Each Python server uses `threading.Lock` around inference; `IdleUnloader` resets timer at request *start*. Concurrent requests serialize; documented behavior: 1 in-flight, others queue with 30 s wait, then return `RATE_LIMITED` (gap 2.1). **`POST /unload` semantics** (ZG-23, ZG-31): acquires the same inference lock, queues behind any in-flight request, then frees the model. Responds 200 once queued (does not block the caller for the duration of the in-flight request). If model `status='loading'`, returns `409 { error: { code: 'BUSY', message: 'model is loading' } }` with `Retry-After: 30` header. render-api treats 409 from `/unload` as benign-skip
- [ ] `D:\local-inference\start-all.ps1` — spawns 3 servers, tails logs to `D:\local-inference\logs\`
- [ ] `D:\local-inference\healthcheck.ps1` — curls each `/healthz`; exits 0 only if all 3 return 200
- [ ] Curl smoke tests: VoxCPM2 returns 48 kHz WAV, Z-Image returns valid PNG, LTX-2 returns playable MP4
- [ ] `nvidia-smi` confirms VRAM drops to baseline within 90 s of last request

## Phase 2: render-api swap (sub-agent delegated, one file at a time)

Each sub-agent: reads breakage-map row, modifies the file, runs the affected test layers, runs `/simplify`, reports back. Trivial single-line edits the only main-agent exception.

- [ ] **`runtime-config.ts`** — add 7 new env vars with safe defaults
- [ ] **`r2-storage.ts`** — refactor: introduce `uploadAsset(kind, key, bytes, contentType): Promise<string>` that branches on `localInferenceConfig.enabled`. R2 path delegates to existing `uploadToR2`; local path delegates to new `local-asset-writer.ts`. Same for `downloadAsset`. **Pre-refactor audit** (ZG-26): grep the entire `render-api/src/` for `uploadToR2(` and `downloadFromR2(` callsites; classify each by `kind` ('audio' | 'images' | 'clips' | 'renders' | 'thumbnails' | 'fx'); lock the mapping in a comment block at the top of `r2-storage.ts`. Update **every** callsite atomically in the same commit — `kind` is a new required arg, not optional. Regression snapshot test catches any payload change
- [ ] **`local-asset-writer.ts`** (new) — `writeLocalAsset(kind, key, bytes)`: writes under `LOCAL_ASSETS_DIR`, returns `${LOCAL_ASSETS_BASE_URL}/${kind}/${key}`
- [ ] **`local-inference-schemas.ts`** (new) — Zod schemas for VoxCPM2, Z-Image, LTX-2 request/response payloads
- [ ] **`generate-audio.ts`** — feature-flag branch in `startTTSJob`/`pollJobStatus`; replace 8 `uploadToR2` callsites with `uploadAsset('audio', ...)`
- [ ] **`generate-images.ts`** — feature-flag branch in `startImageJob`/`checkJobStatus`; concurrency 4→1 in local mode (configurable, not literal); `uploadAsset('images', ...)`
- [ ] **`generate-video-clips.ts`** — extract `submitClipJob`; LOCAL branch; pass through `clips[i].prompt`; `uploadAsset('clips', ...)`
- [ ] **`render-video.ts`** — wrap KENBURNS + RunPod-CPU-chunk branches; centralize encoder args via `getEncoderArgs(localMode)`; smoke/embers from local fx; `uploadAsset('renders', ...)`
- [ ] **`cost-tracker.ts`** — feature-flag branch on rates
- [ ] **`runpod.ts`** — `allocateWorkers*` no-op when `LOCAL_INFERENCE`
- [ ] **`index.ts`** — `app.use('/assets', express.static(LOCAL_ASSETS_DIR))`. Add `GET /health → 200 { ok: true }` (Playwright webServer needs it; ZG-18). Add `GET /config → { localInferenceMode: boolean }` for frontend boot — minimum surface, no URLs / no secrets / no model paths exposed (ZG-3, ZG-12, ZG-22). **`/config` route is whitelisted before the `internalApiKey` middleware** so the frontend can fetch it unauthenticated (ZG-22). Add boot-time guard: `if (NODE_ENV==='production' && localInferenceConfig.enabled) throw`. Add boot-time write-sentinel check on each `local-assets/{kind}/` subdir; exit 1 with clear message if any write throws. Add stage-transition helper `unloadAllExcept(needed)` that fires `POST /unload` to the two non-needed Python servers in parallel before each new stage (ZG-2, ZG-13). Treat 409 responses as benign-skip (ZG-31)
- [ ] **`generate-audio.ts` voice-clone path** — replace URL-fetch with direct byte-upload to Whisper (gap 3.3). Audit current implementation at `getVoiceSampleTranscript()` and switch to OpenAI's `audio.transcriptions.create({ file: blob })` pattern
- [ ] **render-api → local-server fetches** — wrap each in `AbortController` with timeouts: VoxCPM2 60 s, Z-Image 5 min, LTX-2 15 min. Defaults configurable via `*_TIMEOUT_MS` env vars (gap 2.2)
- [ ] Other R2 callsites (render-short.ts, generate-thumbnails.ts, generate-short.ts, generate-captions.ts, delete-project-images.ts, video-preprocessor.ts, remotion-renderer.ts) — refactor through `uploadAsset` / `downloadAsset`. No new branches needed at these sites; the helper handles routing
- [ ] After each file: re-run affected test layers; require green before next file

## Phase 2.5: Frontend Edge Function audit (gap 1.1)

The frontend currently invokes 2 Supabase Edge Functions that hit RunPod directly (`generate-audio`, `generate-images`), bypassing render-api. Local mode must close this leak.

- [ ] Grep `D:\historygen\src\` for every `supabase.functions.invoke(` call. Build a table: caller file:line, target function name, payload shape, response shape
- [ ] For each invocation, identify the equivalent render-api route (most exist already)
- [ ] Add `getApiClient(localMode: boolean)` to `src/lib/api.ts`. Returns one of two implementations of the same interface: (a) Edge-Function path (current), (b) render-api path (new). Routes flip based on `localInferenceMode` from the `/config` endpoint at boot (ZG-3); falls back to `false` on fetch failure with a 2 s timeout and a dev-only banner (ZG-12)
- [ ] Update the 6 caller files (`api.ts`, `ThumbnailGeneratorModal.tsx`, `ProjectResults.tsx`, the 3 test files) to use the helper
- [ ] Update `D:\historygen\src\lib\api.test.ts` and other affected `src/test/*.test.ts` files: imports may shift; preserve coverage; tests that passed before must pass after (ZG-14)
- [ ] **No `VITE_LOCAL_INFERENCE` env var introduced** (ZG-3). Source of truth is the runtime `/config` endpoint. Vercel env stays unchanged
- [ ] Audit existing `D:\historygen\tests\*.spec.ts` Playwright specs for staging-URL dependencies; mark staging-only specs with `test.skip()` annotations when running locally

## Phase 3: Local-asset infra + FFmpeg

- [ ] Create `D:\historygen\local-assets\{images,audio,clips,renders,fx}\`
- [ ] One-time download:
  ```
  curl -L -o D:\historygen\local-assets\fx\embers.mp4     https://historygenai.netlify.app/embers.mp4
  curl -L -o D:\historygen\local-assets\fx\smoke_gray.mp4 https://historygenai.netlify.app/smoke_gray.mp4
  ffprobe -v error -show_entries format=duration D:\historygen\local-assets\fx\embers.mp4
  ffprobe -v error -show_entries format=duration D:\historygen\local-assets\fx\smoke_gray.mp4
  ```
- [ ] Update `.gitignore` to exclude `local-assets/{images,audio,clips,renders}/`; commit `local-assets/fx/*.mp4`
- [ ] Install gyan.dev full ffmpeg build at `C:\ffmpeg\bin\ffmpeg.exe`; verify `ffmpeg -hide_banner -encoders | findstr nvenc` lists `h264_nvenc` and `hevc_nvenc`
- [ ] Set `FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe` in `render-api/.env` only when `LOCAL_INFERENCE=true`. Process boot reads it, points `fluent-ffmpeg` at it. Production unchanged

## Phase 4: Verification

### Per-server smoke (curl from PowerShell)
```
curl -X POST http://localhost:7861/tts      -H "Content-Type: application/json" -d '{"text":"Hello world"}' -o test.wav
curl -X POST http://localhost:7862/generate -H "Content-Type: application/json" -d '{"prompt":"a Roman senator on the steps of the forum, oil painting","aspectRatio":"16:9"}' -o test.png
curl -X POST http://localhost:7863/i2v      -H "Content-Type: application/json" -d (Get-Content payload.json) -o test.mp4
```

### API lifecycle (Layer 6 must pass)
```
POST /generate-images       → /assets/images/<uuid>.png       200 image/png
POST /generate-audio        → /assets/audio/<uuid>.wav        200 audio/wav
POST /generate-video-clips  → /assets/clips/<uuid>.mp4        200 video/mp4
POST /render-video          → /assets/renders/<id>-<uuid>.mp4 200 video/mp4
```

### Browser lifecycle (Layer 7 must pass)
- Open `http://localhost:5173`, sign in, open existing test project
- Click Generate Short
- SSE pipeline drives UI through every stage
- Final video plays from `localhost:3000/assets/renders/...`
- `project_costs` grid shows $0 for `z_image`, `voxcpm2`, `seedance`

### Pre-existing-project regression (gap 2.4)
- Open a project created **before** local mode (asset URLs point at `*.r2.cloudflarestorage.com`)
- Confirm audio plays, images render, existing thumbnails resolve
- If R2 bucket CORS blocks `localhost:5173`, update bucket CORS config to include local dev origin

### Browser-close-mid-render recovery (ZG-15)
- Click Generate Short on a project requiring an LTX-2 stage
- Wait until SSE shows ~10% progress (image stage well underway, audio in progress)
- Close the browser tab entirely
- Wait until logs show the render finished (or check `render_jobs` row goes to `status=completed`)
- Reopen the app, navigate to the same project
- Confirm: progress UI reflects the completed render, final video URL resolves, no rerun triggered
- If recovery fails: existing `render_jobs` polling logic needs a local-mode fix; otherwise out-of-scope and document as known limitation

### Free-space + GC sanity (ZG-16)
- Before each render: `Get-PSDrive D | Select-Object Free` should be > 20 GB; render-api logs a warning at `< 20 GB` and writes the warning into the corresponding `render_jobs` row metadata
- Manual cleanup: `D:\local-inference\scripts\cleanup-old-assets.ps1` deletes files older than 30 days under `local-assets/{images,audio,clips,renders}/` (preserves `fx/`)

### Fresh evidence required (in this session, not from memory)
- Terminal output of `cd render-api && npm test` showing all green
- `nvidia-smi -l 1` screenshot during a render showing NVENC encoder column non-zero
- `netstat -ano | findstr ESTABLISHED` during a local-mode run — no connections to `api.runpod.ai`, `api.kie.ai`, `*.r2.cloudflarestorage.com`
- Browser screenshot of final MP4 playing with smoke + embers visible
- `ffprobe` output on final MP4 showing `Stream #0:0: Video: h264 (High), nv12, ... encoder: h264_nvenc`

### Ship gate (every box checked before PR squash-merge)
- [ ] All 8 test layers green (or remaining failures explained file:line)
- [ ] `tsc --noEmit` returns 0
- [ ] `npm run lint` returns 0
- [ ] `npm run build` produces `dist/`
- [ ] Regression snapshot green (remote-mode payloads byte-identical to baseline)
- [ ] API lifecycle pass green
- [ ] Browser lifecycle pass green
- [ ] Browser-close-mid-render recovery passes (ZG-15)
- [ ] `D:\historygen\scripts\verify-local-inference.ps1` returns 0 with `OK: zero-gaps verification PASSED` (ZG step 8)
- [ ] Fresh evidence captured (5 items above)
- [ ] CHANGELOG.md created (doesn't exist today); first entry links this plan + final test counts
- [ ] `git remote get-url origin` returns `https://github.com/jonmac909/historygen.git`
- [ ] `gh auth status` confirms account
- [ ] **Self-review protocol** (ZG-9, single-developer flow):
  - re-read full diff against `main` (`git diff main...HEAD`)
  - re-run all 8 test layers fresh
  - regression snapshot green
  - 3-round zero-gaps loop on the diff itself; document findings; close real gaps
- [ ] Squash-merge to `main` via `gh pr create` + `gh pr merge --squash`
- [ ] Vercel preview deploy on the PR succeeds (proves frontend remote-mode unbroken)
- [ ] After merge: Render.com auto-deploy of render-api reaches green; production Vercel deploy reaches green
- [ ] Manual smoke (3 clicks: open project → click Generate Short → first asset URL is `*.r2.cloudflarestorage.com`) on production confirms remote-mode unchanged

### Rollback
Set `LOCAL_INFERENCE=false` in `render-api/.env` and the existing R2 + RunPod + Kie.ai paths take over with no code revert.

## Questions

1. (Resolved) Plan scope → one big plan, single feat branch.
2. (Resolved) Plan structure → new file in repo `.claude/plans/local-inference-swap.md`, lean style.
3. (Resolved) Test infra → full Jason: install vitest + supertest + msw, all 8 test layers as Phase 0.
4. (Resolved) Z-Image variant → Turbo (8-step distilled, 6B, ~12 GB).
5. (Resolved) Branch strategy → `feat/local-inference`, PR + squash-merge.
6. (Resolved) R2 → fully replaced by local disk in local mode.
7. (Resolved) NVENC fallback → install gyan.dev full ffmpeg build, override `FFMPEG_PATH`.

## Banned in this plan

`TBD`, `TODO`, `???`, `…`, `etc`, `should`, `might`, `could`, `maybe`, `probably`, `appropriate`. If any appear, treat as unresolved question and surface before implementing the affected line.

## Out of scope (separate future plans)

- Migrating Claude / Whisper to local LLM / STT
- Caption burn-in (`srtContent` accepted at `render-video.ts:155` but never used)
- Audio post-processing (loudnorm, music ducking, EQ)
- Parallel chunk rendering on the local box (`worker_threads` or multi-`ffmpeg` spawning)
- Public / LAN exposure of the local stack (ngrok / tailscale)
- Deleting old R2 assets (`CLAUDE.md` rule: never touch data)
- Cleanup of empty `runpod-voxcpm2-worker/` and `runpod-video-worker/` directories

---

## Gap analysis (5 rounds — Jason Method)

### Round 1 — what edge cases / undefined behaviors / implicit assumptions did the spec miss?

| # | Gap | Label | Closure |
|---|---|---|---|
| 1.1 | **Two parallel paths to remote inference exist**: render-api (primary) AND Supabase Edge Functions (`supabase/functions/generate-audio/index.ts`, `supabase/functions/generate-images/index.ts`) call RunPod directly. Frontend invokes Edge Functions in 6 files including `src/lib/api.ts`, `ThumbnailGeneratorModal.tsx`, `ProjectResults.tsx`. In local mode, any frontend code path that uses `supabase.functions.invoke()` still hits cloud. | **real gap** | Add Phase 2.5: audit `src/lib/api.ts` for every `supabase.functions.invoke()` call; route those calls through render-api equivalents in local mode (gated by `VITE_LOCAL_INFERENCE` flag in the frontend). Where render-api lacks an equivalent, add it. Net: frontend has one place that decides "remote vs local" — `api.ts` — and Edge Functions become unused in local mode. |
| 1.2 | **Vercel deploy safety**: spec says "Vercel env never sets `LOCAL_INFERENCE=true`" but no runtime guard exists. A typo or careless env var copy could break production silently. | **real gap** | Add startup assertion in `render-api/src/index.ts` boot: `if (process.env.NODE_ENV === 'production' && process.env.LOCAL_INFERENCE === 'true') { throw new Error('LOCAL_INFERENCE must not be true in production'); }`. Same guard in frontend if a `VITE_LOCAL_INFERENCE` flag is added. |
| 1.3 | **`/simplify` skill not installed in user's Claude Code env**: bundle is in a temp dir. Sub-agents can't actually invoke `/simplify`. | **real gap** | Add Phase 0 prereq: install bundle into `~/.claude/` (`cp -r commands/* ~/.claude/commands/` etc., per bundle README). Validate `~/.claude/scripts/validate-plan.sh` is executable. |
| 1.4 | **Z-Image-Turbo VRAM on 12 GB**: Z-Image readme says "fits within 16G consumer devices". 12 GB might OOM at full BF16. | **real gap** | `zimage_server.py` first tries BF16, on `torch.cuda.OutOfMemoryError` falls back to FP8 quantization + `enable_model_cpu_offload()`. Log which config succeeded. |
| 1.5 | **LTX-2 weights download time**: 22B + spatial upscaler + distilled LoRA + Gemma 3 text encoder ≈ 30–40 GB. On residential broadband (50 Mbps) that's 1.5–2 hours. | **optional** | Note in Phase 1 LTX-2 step: "kick off `huggingface-cli download` overnight before Phase 1.6". |
| 1.6 | **Plan file location during planning vs implementation**: plan currently lives at `C:\Users\jonst\.claude\plans\now-make-a-detailed-cheerful-llama.md` (auto-generated path); implementation expects `D:\historygen\.claude\plans\local-inference-swap.md` for `validate-plan.sh`. | **real gap** | First implementation action: `cp` the plan to the project location with the correct slug. Add as Phase 0 step 1. |

### Round 2 — what could go wrong we haven't tested? Concurrent users, network failures, invalid data, permission boundaries, state corruption.

| # | Gap | Label | Closure |
|---|---|---|---|
| 2.1 | **Concurrent local model requests**: a frontend race could fire two `POST /generate` against Z-Image at once. Single GPU process, both in flight, second blocks. Worse: `IdleUnloader` could fire mid-request if timer logic is sloppy. | **real gap** | Local servers use a `threading.Lock` around the inference function; `IdleUnloader` resets timer at the *start* of each request, not the end. Concurrent requests serialize. Document expected behavior: 1 request at a time, others queue with a 30 s wait, then return `RATE_LIMITED` if still queued. |
| 2.2 | **Local model server crash mid-pipeline**: Python process dies during long render. render-api hangs polling (or fetch hangs on synchronous POST). | **real gap** | render-api uses explicit `AbortController` with timeouts: 60 s for VoxCPM2, 5 min for Z-Image, 15 min for LTX-2 (configurable). On timeout, return `INTERNAL_ERROR` to frontend with retry hint. |
| 2.3 | **`local-assets` dir not writable**: Windows file-permission edge case. | **real gap** | `render-api/src/index.ts` boot writes a sentinel file (`.write-test`) to each subdirectory of `LOCAL_ASSETS_DIR`; if any write throws, log + exit 1 with clear message before serving requests. |
| 2.4 | **Old project asset URLs (R2) still need to play in local mode**: existing projects have `https://*.r2.cloudflarestorage.com/...` URLs. Frontend playback against R2 URLs depends on R2 bucket CORS allowing `localhost:5173`. | **real gap** | Add to Phase 4 verification: "Open an existing pre-local-mode project, confirm audio + image playback works (R2 URLs resolve)." If CORS blocks, fix R2 bucket CORS to include `http://localhost:5173`. |
| 2.5 | **Disk-full on `D:\` during long renders**: a 200-image project might write 5–10 GB across intermediate chunks. | **optional** | render-api logs free-space warning when below 20 GB; render-video.ts cleans up its temp/chunk files in a `finally` block. Existing code probably already does the latter — verify in Phase 2. |
| 2.6 | **LTX-2 silent VRAM-fragmentation OOM**: long-running Python process accumulates fragmentation, OOMs after N requests. | **optional** | `IdleUnloader` already calls `torch.cuda.empty_cache()`; supplement with `torch.cuda.reset_peak_memory_stats()` per request. If issue persists, restart server every N requests. Defer until observed. |

### Round 3 — spec/breakage-map consistency check

| # | Gap | Label | Closure |
|---|---|---|---|
| 3.1 | Spec says "Image-gen rolling concurrency drops from 4 to 1". Breakage map covers `generate-images.ts` change but doesn't specify *where* the concurrency value is read from. Sub-agent might hard-code `1`. | **real gap** | Lock the helper name + location: add `IMAGE_GEN_CONCURRENCY` to `runtime-config.ts` (defaults: remote=4, local=1). All callers read from there. |
| 3.2 | Spec doesn't mention **audio chunking concurrency**. `generate-audio.ts` chunks 500-char pieces and may run them in parallel against RunPod. Local VoxCPM2 is 1 GPU; chunks must serialize. | **real gap** | Add `AUDIO_CHUNK_CONCURRENCY` to `runtime-config.ts` (defaults: remote=existing-value, local=1). Audit `generate-audio.ts` for the actual current concurrency value before locking the default. |
| 3.3 | Spec says "Whisper voice-sample transcription stays cloud". Existing `getVoiceSampleTranscript()` is cached per URL. In local mode the URL is `localhost:3000/assets/audio/...` — Whisper API can't reach localhost. | **real gap** | Voice-sample transcripts must be generated *before* the audio URL becomes localhost. If a user uploads a new voice sample, the upload path stores it on R2 first (small file, ~1 MB) so Whisper can fetch it. Or: send the bytes to Whisper directly via `audio` parameter (no URL). Use the latter — simpler. Update `generate-audio.ts` voice-cloning entry path to use byte-upload, not URL-fetch. |
| 3.4 | Helper name `uploadAsset` collision risk: AWS SDK has `Upload` class; an existing utility might already be named similarly. | **optional** | Grep `D:\historygen\render-api\src\` for `uploadAsset`, `writeLocalAsset`, `getEncoderArgs` before naming. If collision, prefix with `local`. |

### Round 4 — does the breakage map match actual file structure?

| # | Gap | Label | Closure |
|---|---|---|---|
| 4.1 | Breakage map references `render-api/src/utils/runpod.ts` but actual file may be at a different path. Verified by earlier explore: `runpod.ts` is at `render-api/src/utils/`. Confirmed. | — | OK |
| 4.2 | Plan's "8 callsites of `uploadToR2` in `generate-audio.ts`" comes from Grep output. Other routes also have callsites that refactoring `uploadAsset` covers. Plan lists "render-short.ts, generate-thumbnails.ts, ..." but doesn't enumerate the per-file callsite count. | **optional** | Sub-agent for the `r2-storage.ts` refactor greps the entire `render-api/src/` for `uploadToR2(` and reports total count before refactor — caller-count audit in the brief. |
| 4.3 | `D:\historygen\.claude\` already exists with `plans/`. Bundle install needs to either preserve existing plans or copy bundle into a different sub-path. | **real gap** | Bundle install: only copy bundle items that don't already exist (`cp -rn` on Linux; PS equivalent: skip-if-exists). Don't overwrite the user's existing plans. |
| 4.4 | `.claude_settings.json` exists at `D:\historygen\.claude_settings.json`. Plan doesn't reference it. Could contain hooks/permissions relevant to the bundle. | **optional** | Read it before bundle install; merge if needed. Defer until Phase 0 prereq. |

### Round 5 — what could a sub-agent get wrong? Brief ambiguity check.

| # | Gap | Label | Closure |
|---|---|---|---|
| 5.1 | Briefs say "feature-flag branch in `startTTSJob`". Sub-agent might add the branch deep in the function rather than at the top, missing early returns. | **real gap** | Brief template: "branch at the **first executable line** of the function. The remote-mode code stays exactly as-is below the branch." Include this in every Phase 2 sub-agent brief. |
| 5.2 | "Concurrency 4→1 in local mode (configurable, not literal)" — sub-agent might read this as "use a literal constant `1`". | **real gap** | Brief explicitly: "read from `runtimeConfig.imageGenConcurrency` (already added to runtime-config.ts in Phase 2 step 1). Do not introduce a new literal." |
| 5.3 | Helper names `uploadAsset`, `writeLocalAsset`, `getEncoderArgs`, `IMAGE_GEN_CONCURRENCY`, `AUDIO_CHUNK_CONCURRENCY` — multiple sub-agents could choose variants if not enforced. | **real gap** | Lock names in Spec (now done — see "Locked names" below). Brief references the lock. |
| 5.4 | Regression snapshot test: first run captures baseline, can never fail. Sub-agent might think a green first run is real validation. | **real gap** | Brief: "regression snapshot test: first run with `LOCAL_INFERENCE=false` captures baseline payload to `tests/regression/__snapshots__/`. Second run (after any code change) must match. The brief author runs it twice and shows both outputs as fresh evidence." |
| 5.5 | Sub-agent self-review (`/simplify`) without the skill installed → sub-agent skips it silently. | **real gap** | Once bundle is installed (gap 1.3 closure), every brief ends with "After making changes, run `/simplify` and paste its output as the final section of your report. If `/simplify` is unavailable, run the equivalent manual protocol: simplify → convention check → blast-radius check → fresh-evidence check, and document each in your report." |

### Locked names (post-gap-loop)

| Name | Type | Location |
|---|---|---|
| `uploadAsset(kind, key, bytes, contentType)` | function | `render-api/src/lib/r2-storage.ts` (replaces / wraps `uploadToR2`) |
| `downloadAsset(kind, key)` | function | `render-api/src/lib/r2-storage.ts` (replaces / wraps `downloadFromR2`) |
| `writeLocalAsset(kind, key, bytes)` | function | `render-api/src/lib/local-asset-writer.ts` (new) |
| `readLocalAsset(kind, key)` | function | `render-api/src/lib/local-asset-writer.ts` (new) |
| `getEncoderArgs(localMode: boolean)` | function | `render-api/src/lib/encoder-args.ts` (new) |
| `imageGenConcurrency` | runtime-config field | `render-api/src/lib/runtime-config.ts` |
| `audioChunkConcurrency` | runtime-config field | `render-api/src/lib/runtime-config.ts` |
| `localInferenceMode` | runtime-config field | `render-api/src/lib/runtime-config.ts` |
| `LocalInferenceRequest` / `LocalInferenceResponse` | Zod schemas | `render-api/src/schemas/local-inference-schemas.ts` (new) |

### Closures that mutate Phase plans (consolidated)

- **Phase 0 step 0 (new prereq)**: install bundle into `~/.claude/` (skip-if-exists), copy this plan to `D:\historygen\.claude\plans\local-inference-swap.md`. (gaps 1.3, 1.6, 4.3)
- **Phase 0 step 1.5 (new)**: write the locked-names list to spec; sub-agent briefs reference these names verbatim.
- **Phase 0 layer 5 (regression snapshot test)**: first run with `LOCAL_INFERENCE=false` captures baseline; second run validates. Brief calls this out. (gap 5.4)
- **Phase 2 step 1 (`runtime-config.ts`)**: add `imageGenConcurrency`, `audioChunkConcurrency`, `localInferenceMode`, plus the existing planned `LOCAL_*_URL` fields. (gaps 3.1, 3.2)
- **Phase 2 step 2 (`r2-storage.ts`)**: pre-refactor brief greps all `uploadToR2(` / `downloadFromR2(` callsites, reports count, and refactors *all* of them (not just the ones in the breakage map). (gap 4.2)
- **Phase 2 step (new) — `index.ts` startup assertion**: `LOCAL_INFERENCE` rejected when `NODE_ENV=production`. Plus dir-writable sentinel-file check. (gaps 1.2, 2.3)
- **Phase 2 step (new) — `generate-audio.ts` voice-clone byte-upload to Whisper**: replace URL-fetch with direct bytes parameter so localhost asset URLs work. (gap 3.3)
- **Phase 2.5 (new) — frontend Edge Function audit**: trace every `supabase.functions.invoke()` call in `src/lib/api.ts`; route through render-api in local mode behind `VITE_LOCAL_INFERENCE` flag. Add a `getApiClient(localMode)` helper that exposes the same surface for both paths. (gap 1.1)
- **Phase 1 LTX-2 step**: kickoff `huggingface-cli download` overnight before active work; add to brief. (gap 1.5)
- **Phase 1 zimage_server.py**: BF16 default, FP8 + `enable_model_cpu_offload()` fallback on `OutOfMemoryError`. Log which config won. (gap 1.4)
- **Phase 1 each server**: `threading.Lock` around inference; `IdleUnloader` resets at request *start*. Document: serial requests, queue + 30 s wait, then `RATE_LIMITED`. (gap 2.1)
- **render-api → local-server fetch**: `AbortController` timeouts: VoxCPM2 60 s, Z-Image 5 min, LTX-2 15 min. Configurable via env. (gap 2.2)
- **Phase 4 verification**: add "open existing pre-local-mode project, confirm playback of R2-hosted audio + images" — catches CORS regressions. (gap 2.4)
- **Sub-agent brief template** (master, used in every Phase 2 step):
  > File to modify: `<path>`
  > Breakage-map row: `<row>`
  > Locked names available: `<from list above>`
  > Branch placement: at the **first executable line** of the target function. Remote-mode code below stays as-is.
  > Tests that must be green after your change: `<list>`
  > Regression snapshot must remain unchanged.
  > After change, run `/simplify` (or the manual equivalent protocol). Paste its output.
  > Commit with message: `feat(local): <one-line summary>` and push to `feat/local-inference`.
  > Report: file diff, test output, `/simplify` output, fresh-evidence artifacts.

### Round 6 (bonus — confidence check)

After 5 rounds, remaining unknowns are bounded:
- Exact LTX-2 inference timing on 5070/5080 (verifiable in Phase 1.6)
- Whether `ffmpeg-static` ships NVENC on Windows (verifiable in Phase 3 — gyan.dev fallback already specified)
- Precise audio chunk concurrency value today (verifiable in Phase 2 step 1)

These are facts to be captured during execution, not unresolved spec questions. Spec is concrete enough to delegate.

---

## Zero-Gaps Audit (post-Jason gap-loop, concrete-failure-scenario lens)

Skill: `~/.claude/skills/zero-gaps/SKILL.md`. Three passes. Senior-engineer skeptical review of the plan as if someone else wrote it. Each gap states the exact failure scenario, the wrong assumption that makes the plan break, and the closure.

### Pass 1 gaps

**ZG-1 — SSE progress events go silent during sync local POSTs**
- Scenario: Z-Image takes 15 s per image; LTX-2 takes 5 min per clip. render-api removes the polling loop in local mode and just `await fetch(LOCAL_*_URL)`. SSE channel emits no events for the duration. Frontend shows a frozen progress bar; user thinks UI is hung, refreshes, breaks the pipeline.
- Wrong assumption: "removing polling means we don't need to emit events anymore."
- Closure: render-api wraps each local sync call in start/end SSE events: `{ stage, status: 'started', startedAt }` before the fetch, `{ stage, status: 'completed', durationMs, url }` after. For LTX-2 specifically, also emit periodic `{ stage, status: 'in_progress', elapsedSec }` heartbeats every 30 s so the frontend knows the connection is alive. Add to Phase 2 sub-agent briefs for `generate-audio.ts`, `generate-images.ts`, `generate-video-clips.ts`.

**ZG-2 — Cross-model VRAM coordination is timer-based, not explicit**
- Scenario: Pipeline transitions image-gen → audio. Last Z-Image request finishes at T=0. render-api immediately starts audio gen at T=0.5 s. VoxCPM2 server tries to load weights into VRAM. Z-Image's `IdleUnloader` 90 s timer hasn't fired; ~12 GB still resident. VoxCPM2 OOMs.
- Wrong assumption: "stages don't overlap, so timer-based unload is enough."
- Closure: each Python server exposes `POST /unload` (idempotent — sets model handle to `None`, calls `torch.cuda.empty_cache()`, returns 200). render-api emits an explicit unload call to the previous stage's server before the first request of the next stage. Coordination is explicit, not implicit on a timer.

**ZG-3 — `VITE_LOCAL_INFERENCE` is bake-time only**
- Scenario: Developer flips `VITE_LOCAL_INFERENCE` in `.env` from `false` to `true`. Refreshes the browser. Vite dev server serves the cached bundle with the old value. Frontend keeps hitting Render.com remote API. Developer wastes 30 min debugging.
- Wrong assumption: "Vite picks up `.env` changes on refresh." False — Vite bakes them at server start.
- Closure: drop `VITE_LOCAL_INFERENCE` entirely. Frontend boots, fetches `GET /config` from render-api at app start. Response: `{ localInferenceMode: boolean, ... }`. Single source of truth. The only baked-in env var stays `VITE_RENDER_API_URL`.

**ZG-4 — Locked-name `imageGenConcurrency` collides with existing `imageGenerationConfig.maxConcurrentJobs`**
- Scenario: Verified by reading `D:\historygen\render-api\src\lib\runtime-config.ts:27-32` — already has `imageGenerationConfig.maxConcurrentJobs` reading from env `ZIMAGE_MAX_CONCURRENCY` (default 4). Plan's locked name `imageGenConcurrency` is a different identifier. Sub-agent introduces a second source of truth or breaks 7 existing importers.
- Wrong assumption: "I'm adding new config; existing pattern doesn't matter."
- Closure: **revise locked names** — match existing pattern. Add fields to existing config objects, not new ones. New env vars only: `LOCAL_INFERENCE`, `LOCAL_VOXCPM2_URL`, `LOCAL_ZIMAGE_URL`, `LOCAL_LTX2_URL`, `LOCAL_ASSETS_DIR`, `LOCAL_ASSETS_BASE_URL`, `FFMPEG_PATH`, `VOXCPM2_TIMEOUT_MS`, `ZIMAGE_TIMEOUT_MS`, `LTX2_TIMEOUT_MS`. For concurrency: in local mode, `render-api/.env` sets `ZIMAGE_MAX_CONCURRENCY=1`. Zero code change at the call sites — already parameterized at `generate-images.ts:329`.

**ZG-5 — Plan over-promised code change for image concurrency**
- Scenario: Plan said "concurrency 4→1 in local mode (configurable, not literal)". Sub-agent reads breakage map, modifies `generate-images.ts` to add a branch. But the file already reads from `imageGenerationConfig.maxConcurrentJobs`. The "code change" is unnecessary noise.
- Wrong assumption: "value isn't parameterized." It is.
- Closure: remove `generate-images.ts` concurrency code change from breakage map. Keep only the env-var setting in `render-api/.env`. Plan complexity drops.

**ZG-6 — Vercel/Playwright CI red on `feat/local-inference` for weeks**
- Scenario: Phase 0 commits 8 RED test files. Push to `feat/local-inference`. GitHub Actions `playwright.yml` runs on push, all tests fail. PR shows red CI. Reviewer (or future-self) confused.
- Wrong assumption: "Tests can be safely red on the feature branch."
- Closure: explicit doc in plan: "feat/local-inference branch CI status is intentionally red from Phase 0 through end of Phase 4. Don't squash-merge until ship-gate runs locally green. Vercel preview URL for the branch: use it only for the FRONTEND visual smoke (frontend tests aren't part of `vite build`). render-api on Render.com isn't auto-deployed from feat branch (only main); safe."

**ZG-7 — Playwright `webServer` healthz returns 200 before models are loaded**
- Scenario: Playwright `webServer.url` waits for `localhost:7863/healthz` to return 200, then runs tests. Python server returns 200 immediately because models lazy-load on first request. First test sends an LTX-2 request → 90 s while model loads → test timeout (default 30 s).
- Wrong assumption: "healthz=200 means ready."
- Closure: each Python server's `/healthz` returns `{ status: 'idle' | 'loading' | 'ready' | 'error', modelLoaded: bool }`. Playwright config polls `/healthz` and waits for `status: 'ready'` via `webServer.url` + a custom check. Servers support `PRE_WARM=1` env to load model at startup; Playwright config sets it.

**ZG-8 — Vercel build doesn't bomb on `VITE_LOCAL_INFERENCE=true` (because we just dropped that flag)**
- Round 1 closure replaced `VITE_LOCAL_INFERENCE` with a runtime `/config` endpoint. So this gap is moot.
- Drop. (Self-correction during pass.)

**ZG-9 — Single-developer review block in ship gate**
- Scenario: Ship gate says "PR opened, reviewer approved, squash-merge into main". User is sole developer. There is no reviewer. Gate cannot pass.
- Wrong assumption: there's a team reviewer.
- Closure: replace "reviewer approved" with self-review protocol: re-read full diff against `main`, re-run all 8 test layers, regression snapshot green, run a 3-round zero-gaps loop on the diff itself, document the loop's findings, then squash-merge.

**ZG-10 — Playwright `webServer` config syntax**
- Scenario: Plan said "configure `webServer` block that starts frontend + render-api + 3 Python servers". Playwright's `webServer` config takes either ONE config object OR an ARRAY (Playwright ≥ 1.30). Sub-agent guesses the wrong shape; only one server starts; tests fail.
- Wrong assumption: "Playwright knows how to start 5 servers from one config."
- Closure: lock the array shape in plan:
  ```ts
  webServer: [
    { command: 'cd D:\\local-inference && python voxcpm2_server.py', url: 'http://localhost:7861/healthz?ready=1', timeout: 120_000, reuseExistingServer: true },
    { command: 'cd D:\\local-inference && python zimage_server.py',   url: 'http://localhost:7862/healthz?ready=1', timeout: 180_000, reuseExistingServer: true },
    { command: 'cd D:\\local-inference && python ltx2_server.py',     url: 'http://localhost:7863/healthz?ready=1', timeout: 600_000, reuseExistingServer: true },
    { command: 'cd D:\\historygen\\render-api && npm run dev',         url: 'http://localhost:3000/health',         timeout: 60_000,  reuseExistingServer: true },
    { command: 'cd D:\\historygen && npm run dev',                     url: 'http://localhost:5173',                timeout: 60_000,  reuseExistingServer: true },
  ],
  ```
  `?ready=1` is interpreted by the Python servers' healthz as "block until model loaded" with `PRE_WARM=1` set in the spawn env. `reuseExistingServer: true` lets the developer keep servers running between test runs.

### Pass 2 gaps (after pass-1 closures)

**ZG-11 — Closure of ZG-1 introduces new SSE event surface; no tests cover it**
- Scenario: We added start/in-progress/completed SSE events around sync local calls. A future refactor accidentally removes one (e.g., the in-progress heartbeat for LTX-2). Frontend timeouts return. No test catches it.
- Closure: add to Layer 3 (API contract tests): assert SSE events for `started`, `in_progress` (LTX-2 only, every 30 s), `completed` fire in expected order with correct payload shape during a mocked local-mode pipeline run.

**ZG-12 — Closure of ZG-3 (`/config` endpoint) creates a chicken-and-egg if render-api is down**
- Scenario: Frontend boots. Tries to fetch `localhost:3000/config`. render-api hasn't started yet (developer launched frontend first). Fetch fails. Frontend renders an error state.
- Wrong assumption: "frontend always boots after render-api."
- Closure: frontend has a baked-in default for `localInferenceMode` (default `false` — assume remote). On boot it fetches `/config` with a 2 s timeout; on failure or timeout, falls back to default. Display a small dev-only banner if the config fetch failed so the developer knows.

**ZG-13 — Closure of ZG-2 (`/unload` endpoint) means render-api needs to know which model was last used**
- Scenario: render-api emits `POST /unload` to the right server before the next stage. But render-api's pipeline state machine doesn't track which model is currently loaded. Sub-agent has to add stage-tracking.
- Closure: simpler invariant — render-api emits `/unload` to ALL three Python servers between stages (idempotent: if not loaded, `/unload` returns 200 immediately, no work). Cost: 3 cheap HTTP calls per stage transition. Saves all the stage-tracking logic.

**ZG-14 — Existing `D:\historygen\src\lib\api.test.ts` imports from `api.ts`; Phase 2.5 refactor breaks it**
- Scenario: Phase 2.5 introduces `getApiClient(localMode)`. `api.test.ts` imports specific functions from `api.ts`. Function signatures change. Test file fails to compile.
- Closure: Phase 2.5 brief includes "update `D:\historygen\src\lib\api.test.ts` to import from the new shape; preserve test coverage; if `api.test.ts` was passing before, it must pass after."

**ZG-15 — Browser close mid-LTX-2 render**
- Scenario: User clicks Generate Short. LTX-2 stage runs for 30 min total. User closes browser at minute 10. render-api keeps the request alive (Express doesn't auto-cancel). After minute 30, render-api writes final MP4 to `local-assets/renders/`. User comes back, opens project. Does the UI know the render finished?
- Wrong assumption: "client-disconnect kills the job."
- Closure: existing `render_jobs` table tracks status across reconnects (verified by reading `render-video.ts:185-246` — Supabase row-level progress). Local mode preserves this. Verify in Phase 4: kill browser at 10% progress, refresh page, confirm progress bar resumes from server state. Add this scenario to Phase 4 verification list.

**ZG-16 — Asset filename uniqueness without GC**
- Scenario: Same project rendered 5 times. 5 sets of files in `local-assets/renders/`. Across months, D: fills.
- Wrong assumption: "we'll deal with it later."
- Closure: free-space check before each render: if `LOCAL_ASSETS_DIR` parent drive < 20 GB free, log a warning into the render's `render_jobs` row but proceed. Add `D:\local-inference\scripts\cleanup-old-assets.ps1` that deletes files older than 30 days under `images/`, `audio/`, `clips/`, `renders/` (preserves `fx/`). Run manually as needed. Tying GC to project lifecycle stays out-of-scope.

### Pass 3 gaps (after pass-2 closures)

**ZG-17 — `/unload` to all-three on every stage = 9 extra round-trips per render**
- Scenario: 3 unload calls per stage × 3 stage transitions = 9 calls. Each is ~5–50 ms locally. Total < 1 s overhead per render. Acceptable.
- Drop. Not a real gap.

**ZG-18 — `/health` endpoint on render-api doesn't currently exist**
- Scenario: Playwright `webServer` waits for `localhost:3000/health`. Existing `render-api` may not have such a route.
- Wrong assumption: "we already have it."
- Closure: verify in Phase 0.0 (read `render-api/src/index.ts`); if absent, add `GET /health → 200 { ok: true }` as part of Phase 2 step 11 (`index.ts` changes — already in plan; just add the route).

**ZG-19 — `getVoiceSampleTranscript()` byte-upload to Whisper changes cache key**
- Scenario: Existing cache keys transcripts by URL (`url → transcript`). Switching to byte-upload removes the URL stability. Same voice sample uploaded twice generates two transcripts.
- Wrong assumption: "the cache works the same way."
- Closure: switch cache key to a SHA-256 hash of the file bytes. Same input → same hash → same transcript. Cache survives across uploads. Update Phase 2 voice-clone task brief.

### Step 6 — Edge cases (zero-gaps step 6)

| Edge | Coverage in plan |
|---|---|
| Empty state (zero projects) | existing UI; no change |
| Huge state (10k projects) | pre-existing pagination concern; out-of-scope |
| Concurrent state (two browser tabs same project) | render-api serializes per-project; existing behavior preserved |
| Degraded state (LTX-2 slow) | timeout 15 min; SSE heartbeat keeps connection alive |
| Malformed state (empty prompt, 10 MB string) | Zod validation rejects via shared schemas |
| Permission state (logged out) | auth middleware unchanged |
| Browser state (cached old JS expecting R2 URLs) | hard-refresh resolves; Vite cache-bust headers in `vercel.json` already set `no-store, no-cache, must-revalidate` |

### Step 7 — Regression check (zero-gaps step 7)

What existing functionality could break?
- **`render-api/src/lib/runtime-config.ts` importers** — 7+ files import `corsAllowedOrigins`, `internalApiKey`, `imageGenerationConfig`, etc. Plan's closure (ZG-4) keeps existing exports unchanged; only adds new ones. Importers untouched.
- **R2 callsites in non-route files** — `lib/video-preprocessor.ts`, `lib/remotion-renderer.ts` use `uploadToR2` / `downloadFromR2`. After `r2-storage.ts` refactor wraps in `uploadAsset` / `downloadAsset`, the original functions still exist (delegated to). Plan keeps backward compat.
- **Frontend `src/test/*` and `src/lib/api.test.ts`** — Phase 2.5 refactors api.ts; brief includes test updates (ZG-14).
- **Playwright `tests/historyvidgen.spec.ts`** etc. — these existing specs run against staging URL (currently). With `webServer` array configured, they'll run against localhost. They may rely on staging-specific data. Phase 0.1 layer 7 brief includes: "audit existing Playwright specs for staging-URL dependencies; mark each as either local-compatible or staging-only; staging-only specs get `test.skip()` annotations when running locally."
- **Anthropic, OpenAI, Supabase Auth** — untouched in either mode.
- **Vercel auto-deploy on main** — feat branch doesn't touch main. After PR squash-merge, regression snapshot test green proves payloads unchanged. Production deploy continues to use Render.com + R2 + RunPod + Kie.ai.

### Step 8 — Deterministic verification script

Add `D:\historygen\scripts\verify-local-inference.ps1`:
```powershell
# Returns 0 on success, 1 on any failure. Run before ship-gate.
$ErrorActionPreference = 'Stop'

# 1. Disk space
$free = (Get-PSDrive D).Free / 1GB
if ($free -lt 20) { Write-Error "D: has $free GB free, need >=20"; exit 1 }

# 2. ffmpeg has NVENC
$ffmpeg = $env:FFMPEG_PATH
if (-not (& $ffmpeg -hide_banner -encoders 2>&1 | Select-String 'h264_nvenc')) {
  Write-Error 'ffmpeg lacks h264_nvenc'; exit 1
}

# 3. Each Python server ready
'http://localhost:7861/healthz?ready=1', 'http://localhost:7862/healthz?ready=1', 'http://localhost:7863/healthz?ready=1' | ForEach-Object {
  $r = Invoke-RestMethod $_ -TimeoutSec 30
  if ($r.status -ne 'ready') { Write-Error "$_ not ready: $($r | ConvertTo-Json)"; exit 1 }
}

# 4. render-api up
Invoke-RestMethod http://localhost:3000/health -TimeoutSec 5 | Out-Null

# 5. /assets static serve works (ZG-29: direct write, no cross-volume Move)
$verifyPath = "$env:LOCAL_ASSETS_DIR\fx\.verify"
try {
  Set-Content -Path $verifyPath -Value 'sentinel' -Encoding utf8
  $res = Invoke-WebRequest "$env:LOCAL_ASSETS_BASE_URL/fx/.verify" -UseBasicParsing
  if ($res.StatusCode -ne 200) { Write-Error '/assets serve broken'; exit 1 }
} finally {
  if (Test-Path $verifyPath) { Remove-Item $verifyPath -Force }
}

# 6. No outbound RunPod / Kie.ai / R2 in last 60 s of netstat
Start-Sleep 1
$bad = netstat -ano | Select-String 'runpod|kie|cloudflarestorage' | Where-Object { $_ -match 'ESTABLISHED' }
if ($bad) { Write-Warning "Outbound to forbidden host: $bad" }

# 7. Run render-api unit + integration + regression tests
Push-Location D:\historygen\render-api
npm test -- --run
$testExit = $LASTEXITCODE
Pop-Location
if ($testExit -ne 0) { Write-Error "render-api tests failed"; exit 1 }

Write-Output "OK: zero-gaps verification PASSED"
exit 0
```

Add to ship gate: `bash` checkbox `[ ] scripts/verify-local-inference.ps1 returns 0 with output 'OK: zero-gaps verification PASSED'`.

### Step 9 — Completion summary

After applying every closure above, the plan is implementation-ready. Net delta from pre-zero-gaps state:

**Closures applied inline below:**
- Locked names revised to match existing `imageGenerationConfig` pattern (ZG-4)
- `generate-images.ts` concurrency code change removed; env-var-only (ZG-5)
- `VITE_LOCAL_INFERENCE` flag dropped; `GET /config` endpoint added (ZG-3, ZG-12)
- Each Python server adds `POST /unload`; render-api emits unload to all 3 between stages (ZG-2, ZG-13)
- SSE start/in-progress/completed events around each sync local call; tests cover (ZG-1, ZG-11)
- Playwright `webServer` array shape locked (ZG-10)
- Each `/healthz` returns model state; `?ready=1` blocks until loaded; `PRE_WARM=1` env (ZG-7)
- "PR reviewer approved" → "self-review protocol with 3-round zero-gaps loop on diff" (ZG-9)
- `feat/local-inference` CI red until ship-gate; documented (ZG-6)
- Existing `api.test.ts` updates included in Phase 2.5 brief (ZG-14)
- Browser-close-mid-render scenario added to Phase 4 verification (ZG-15)
- Asset GC: free-space warning + manual cleanup script (ZG-16)
- `GET /health` route added to render-api `index.ts` (ZG-18)
- Whisper voice-sample cache keyed by SHA-256 of bytes, not URL (ZG-19)
- Existing Playwright specs audited for staging-URL dependencies (regression check)
- `verify-local-inference.ps1` script added to ship gate

**Out of scope (flagged, deliberately not fixed):**
- Tying asset GC to project lifecycle (deferred to a future plan)
- Production migration of render-api off Render.com (this plan covers dev-mode only; user goal of "Railway zero" is achieved by stopping payment for Railway/Render only when production migrates — separate plan)
- Caption burn-in
- Audio post-processing
- Parallel chunk rendering on local box

**Gaps with concrete failure scenarios remaining: 0.**

Ship-gate is satisfiable on a single-developer flow.

---

## Locked names — REVISED post zero-gaps (supersedes earlier "Locked names" table above)

| Name | Type | Location | Notes |
|---|---|---|---|
| `imageGenerationConfig.maxConcurrentJobs` | existing field | `runtime-config.ts:28` | already exists; in local mode set env `ZIMAGE_MAX_CONCURRENCY=1`. **No code change at call site.** |
| `localInferenceConfig` | new exported object | `render-api/src/lib/runtime-config.ts` | `{ enabled, voxcpm2Url, zimageUrl, ltx2Url, assetsDir, assetsBaseUrl, ffmpegPath, voxcpm2TimeoutMs, zimageTimeoutMs, ltx2TimeoutMs }` — match existing `imageGenerationConfig` shape |
| `uploadAsset(kind, key, bytes, contentType)` | function | `render-api/src/lib/r2-storage.ts` | wraps existing `uploadToR2`, branches on `localInferenceConfig.enabled` |
| `downloadAsset(kind, key)` | function | `render-api/src/lib/r2-storage.ts` | wraps existing `downloadFromR2` |
| `writeLocalAsset(kind, key, bytes)` | function | `render-api/src/lib/local-asset-writer.ts` (new) | |
| `readLocalAsset(kind, key)` | function | `render-api/src/lib/local-asset-writer.ts` (new) | |
| `getEncoderArgs(localMode: boolean)` | function | `render-api/src/lib/encoder-args.ts` (new) | |
| `getApiClient(localMode: boolean)` | factory | `D:\historygen\src\lib\api.ts` | returns Edge-Function impl OR render-api impl behind same interface; consumes `/config` endpoint result |
| `LocalInferenceRequest` / `LocalInferenceResponse` | Zod schemas | `render-api/src/schemas/local-inference-schemas.ts` (new) | shared with Python servers via JSON-Schema export |

---

## Zero-Gaps Audit — Pass 4 (honesty correction: prior "0 remaining" claim was shallow)

Fresh skeptical pass on the plan and the pass 1–3 closures themselves found 12 more concrete-failure-scenario gaps. Closures applied inline above where critical, recorded here for traceability.

**ZG-20 — `PRE_WARM=1` on all 3 Python servers at Playwright startup OOMs the GPU**
- Scenario: Playwright `webServer` array spawns 3 Python servers in parallel with `PRE_WARM=1`. Each tries to load its model into VRAM at startup. VoxCPM2 (~4 GB) + Z-Image (~12 GB) + LTX-2 (~22 GB) = ~38 GB requested. RTX 5070 has 12 GB. First server wins, others CUDA-OOM, Playwright tests can't start.
- Wrong assumption: "PRE_WARM is harmless." Wrong on a single GPU.
- Closure: replace `PRE_WARM=1` with **lazy ready** — `/healthz?ready=1` returns 200 only when the server can serve a request *right now* (model not loaded but able to load on demand). Playwright tests serialize: when test 1 hits VoxCPM2, Z-Image and LTX-2 must already have unloaded. Add per-test-stage warmup hooks: `beforeEach` calls `POST /<server>/unload` to all-three servers except the one needed next. Single-GPU contention solved by stage-coordinated load/unload, not pre-warm.

**ZG-21 — LTX-2 NDJSON heartbeat from server → render-api requires streaming reader, not `response.json()`**
- Scenario: ZG-1 closure said LTX-2 server streams NDJSON heartbeats over the response body. Sub-agent writes `const result = await fetch(LTX2_URL).then(r => r.json())`. `.json()` waits for the body to close, then parses ALL of it as one JSON object → throws (NDJSON has multiple objects + newlines). Or sub-agent uses `.text()` and parses, which still blocks until end → no streaming.
- Wrong assumption: "Node fetch handles streaming response bodies the same way as buffered."
- Closure: lock the implementation pattern in the brief. Use `for await (const chunk of response.body)` to consume the stream; parse each newline-delimited JSON object as a heartbeat → re-emit via SSE; final object marks completion with `{type: 'done', urlPath}`. Add a unit test in Layer 4 that mocks an NDJSON stream and asserts heartbeats fire as they arrive (not after stream close).

**ZG-22 — `/config` endpoint blocked by existing `internalApiKey` middleware in production**
- Scenario: render-api boots with `apiKeyRequired = isProduction || REQUIRE_API_KEY === 'true'` (verified at `runtime-config.ts:21`). Frontend boots, fetches `/config` without `X-Internal-Api-Key` header (browser has no key). Returns 401. Frontend defaults to `localInferenceMode=false` per the safe-default closure (ZG-12). On the dev box this is fine since `apiKeyRequired=false` in dev. **In production it would always 401, but production should never have `localInferenceMode=true` anyway, so the safe default takes over.** Functionally OK.
- BUT: a developer running render-api with `REQUIRE_API_KEY=true` locally for testing finds frontend stuck on remote mode. Confusing.
- Closure: `/config` is **explicitly excluded** from the auth middleware. Whitelisted at the route level. Only exposes the boolean `localInferenceMode` (no URLs, no secrets, no model paths) — minimum viable surface (gap also covers ZG-Plan ambient minor on response shape).

**ZG-23 — `POST /unload` while a request is in flight races with inference**
- Scenario: User has two browser tabs both using the same render-api instance. Tab A starts an LTX-2 render at T=0. Tab B finishes its image stage at T=10 s and (per ZG-2 / ZG-13) calls `POST /unload` to all 3 Python servers. LTX-2 server, mid-inference for Tab A, gets the unload call. Naive impl: sets model handle to None; Tab A's in-flight request crashes with NoneType error.
- Wrong assumption: stage-transition unload-all-three is safe with concurrent users.
- Closure: each Python server's `/unload`:
  1. acquire the same `threading.Lock` that wraps inference
  2. if a request is in flight when lock is requested, the unload waits (queues behind the inference)
  3. unload happens after the in-flight request returns
  4. respond 200 to the unload caller as soon as queued (don't block the unload caller for 5 min)
  5. if model is in `loading` state, return 409 with `retry-after: 30` rather than aborting load (load is non-cancellable)
- This means stage transitions queue gracefully under concurrent users.

**ZG-24 — Z-Image FP8 fallback path is unspecified**
- Scenario: ZG-1.4 said "fall back to FP8 quantization on OOM." Z-Image's `from zimage import generate` API doesn't document FP8 — it's a custom pipeline, not standard `diffusers`. Sub-agent doesn't know what FP8 fallback looks like; tries `model.to(torch.float8_e4m3fn)` which may not work; tests fail.
- Wrong assumption: "FP8 fallback is a one-liner."
- Closure: revise the fallback to known-working APIs:
  1. First attempt: BF16 default (existing `inference.py:16`)
  2. On OOM: load with `torch.float16` instead of bfloat16 (sometimes saves a bit)
  3. Still OOM: enable `torch.cuda.empty_cache()` between calls + reduce batch to 1 + reduce resolution to 768
  4. Document if 12 GB is genuinely insufficient and the 5080 (16 GB) fixes it; defer FP8 quantization unless the Z-Image upstream adds it
- Plan no longer asserts FP8 will work for Z-Image; only for LTX-2 (where it's documented in the README).

**ZG-25 — LTX-2 `enable_sequential_cpu_offload()` may not be a method on the custom DistilledPipeline**
- Scenario: Plan says LTX-2 server uses `DistilledPipeline + enable_sequential_cpu_offload()`. The LTX-2 README mentions FP8 cast and gradient estimation; doesn't explicitly mention `enable_sequential_cpu_offload`. The DistilledPipeline class may inherit from `DiffusionPipeline` (which has the method) or be standalone (which doesn't).
- Wrong assumption: "all diffusers pipelines have this method."
- Closure: Phase 1 LTX-2 step brief: "verify `DistilledPipeline.enable_sequential_cpu_offload` exists by reading `D:\LTX-2\packages\ltx-pipelines\src\ltx_pipelines\distilled.py` first; if absent, use the documented `quantization=QuantizationPolicy.fp8_cast()` (LTX-2 README) and accept whatever offload behavior FP8 provides; do NOT invent an offload API." Add as explicit step before writing `ltx2_server.py`.

**ZG-26 — `uploadAsset(kind, ...)` adds a new param every callsite must pass; not a transparent wrapper**
- Scenario: ZG-Plan said `r2-storage.ts` refactor wraps `uploadToR2` in `uploadAsset`. Existing signature: `uploadToR2(key, body, contentType)`. New signature: `uploadAsset(kind, key, body, contentType)`. **Every callsite must change to pass the `kind` arg.** That's the 8 callsites in `generate-audio.ts` plus all the other files. Sub-agent doing the refactor sees "wraps existing" and writes a thin wrapper, expects existing callsites to still work. They don't; build breaks.
- Wrong assumption: "wrap" means "pass through unchanged."
- Closure: pre-refactor brief includes a callsite audit step:
  1. Grep `uploadToR2(` and `downloadFromR2(` across `render-api/src/`
  2. For each, classify the `kind` from the file path or callsite context (e.g., `generate-audio.ts` → `'audio'`)
  3. Lock the mapping in a comment block at the top of `r2-storage.ts`
  4. Update every callsite atomically in the same commit — this is a wide change, not a wrapper
- Sub-agent commits one large diff covering all callsites; regression snapshot test catches any payload change.

**ZG-27 — Playwright `webServer` shell-chained `cd && python` won't work cleanly on Windows**
- Scenario: Plan locked `command: 'cd D:\\local-inference && python voxcpm2_server.py'`. Playwright on Windows spawns this via `child_process.spawn` with `shell: true` (or similar). Path with backslashes + the `cd &&` chain is fragile across Powershell vs cmd.exe. Server may not start; Playwright times out.
- Wrong assumption: "shelled `cd &&` is portable."
- Closure: use the `cwd` config instead. Lock the shape:
  ```ts
  { command: 'python voxcpm2_server.py', cwd: 'D:\\local-inference', url: '...', timeout: 60_000, reuseExistingServer: true }
  ```
  Each entry has its own `cwd`. No shell chains.

**ZG-28 — `playwright.yml` workflow doesn't filter `[skip-ci]` — feat branch CI emails spam**
- Scenario: Phase 0 commits 8 RED test files. Push to `feat/local-inference`. GitHub Actions `playwright.yml` runs (push trigger), all RED tests fail, GitHub sends a failure email. Every subsequent commit on the branch (10–30 commits over weeks) sends another email. User's inbox fills.
- Wrong assumption: documenting "CI red is intended" silences the noise.
- Closure: add a step filter to `.github/workflows/playwright.yml`:
  ```yaml
  on:
    push:
      branches: [main, master]   # remove the implicit "any branch" — runs only on protected branches and PRs
    pull_request:
      branches: [main, master]
  ```
  Already exists per the audit. **Plus** add a job-level guard: `if: ${{ !contains(github.event.head_commit.message, '[skip-ci]') }}`. Phase 0 commits use `[skip-ci]` in commit messages. PR runs are unaffected (only push trigger checks message).

**ZG-29 — `verify-local-inference.ps1` cross-volume `Move-Item` may fail**
- Scenario: Verify script does `New-TemporaryFile` (creates in `%TEMP%`, typically `C:`) then `Move-Item` to `$env:LOCAL_ASSETS_DIR\fx\.verify` (on `D:`). Cross-volume Move-Item works on Windows but is slow and may interact with antivirus.
- Closure: replace the temp-file dance with `Set-Content -Path "$env:LOCAL_ASSETS_DIR\fx\.verify" -Value 'sentinel'` and `Remove-Item` in `finally`. Direct write, no move.

**ZG-30 — `huggingface-cli` not on PATH**
- Scenario: Phase 1 LTX-2 brief says "kick off `huggingface-cli download Lightricks/LTX-2.3 --local-dir D:\hf_cache\Lightricks--LTX-2.3 --include ...` overnight." Developer types this in a fresh PowerShell. `huggingface-cli` isn't on PATH because it lives in a venv (probably `D:\VoxCPM\.venv\Scripts\` from the existing VoxCPM2 install).
- Closure: brief specifies the exact command:
  ```
  & "D:\VoxCPM\.venv\Scripts\python.exe" -m huggingface_hub.commands.huggingface_cli download Lightricks/LTX-2.3 --local-dir D:\hf_cache\Lightricks--LTX-2.3 --include "ltx-2.3-22b-distilled-1.1.safetensors" "ltx-2.3-spatial-upscaler-x2-1.1.safetensors" "ltx-2.3-22b-distilled-lora-384-1.1.safetensors"
  ```
  Or activate the venv first. Lock the path-prefixed form.

**ZG-31 — `/unload` during `loading` state has unspecified semantic**
- Scenario: User triggers a render. Z-Image server starts loading model (5–10 s). Mid-load, render-api emits stage-transition unload to Z-Image. What happens? Naive impl: model handle is mid-assignment; setting it to None mid-load corrupts state.
- Wrong assumption: load can be safely cancelled.
- Closure: load is non-cancellable. `/unload` during `status='loading'` returns `409 { error: { code: 'BUSY', message: 'model is loading' } }` with `Retry-After: 30`. render-api treats 409 as "skip this unload, the model isn't really resident yet anyway" and proceeds. Add to Layer 3 API contract test.

### Pass 5 — gap budget

After applying ZG-20 through ZG-31 closures, fresh skeptical eye:

- **`/healthz?ready=1` semantic** (ZG-7 / ZG-20 interaction): the original closure said `?ready=1` blocks until model loaded. ZG-20 closure replaces `PRE_WARM=1` with lazy ready. So `?ready=1` now means "load on demand, then return". Playwright spawns 3 servers; each server's `?ready=1` probe triggers a load. With single GPU, only one can load at a time, others 503/wait. Playwright config `timeout: 600_000` (10 min) accommodates serial loading. Load-on-probe-only is the right semantic. **Resolved.**
- **Stage-transition unload-all-three vs PRE_WARM removal**: now consistent — render-api unloads non-needed servers before each stage; the next-stage server loads on first request. **Resolved.**
- **NDJSON parsing edge cases** (truncated chunk mid-line): standard pattern is "buffer until newline, parse line, discard line; repeat." Sub-agent may forget. Brief locks the canonical implementation. **Already in ZG-21 closure.**

Pass 5 finds 0 new concrete-failure-scenario gaps. Honest call: I now believe the spec is implementation-ready; pass 4 added 12 real ones the prior pass missed. Capping at pass 5 per skill rules; remaining unknowns are execution-time facts (LTX-2 actual VRAM behavior, Z-Image actual fit on 12 GB, exact NDJSON heartbeat shape) that surface in Phase 1.

### Post-pass-4 closures applied above
- ZG-20: `PRE_WARM` removed; `?ready=1` triggers lazy load; stage-coordinated unload covers single-GPU contention
- ZG-21: NDJSON streaming uses `for await ... response.body` reader; Layer 4 unit test
- ZG-22: `/config` route excluded from `internalApiKey` middleware; minimum surface
- ZG-23: `/unload` waits for inference lock; queues behind in-flight; 409 during load
- ZG-24: Z-Image fallback uses fp16/cache-clear/resolution drop, not undocumented FP8
- ZG-25: LTX-2 brief verifies offload API exists before assuming
- ZG-26: `r2-storage.ts` refactor brief includes callsite audit + `kind` mapping lock
- ZG-27: Playwright `webServer` uses `cwd` config, not shell `cd &&`
- ZG-28: `playwright.yml` job-level guard for `[skip-ci]` commit messages
- ZG-29: verify script uses `Set-Content`/`Remove-Item`, no cross-volume Move
- ZG-30: `huggingface-cli` invoked via venv-prefixed path
- ZG-31: `/unload` during loading returns 409 + Retry-After

**Honest status:** plan now reflects a fifth pass of skepticism. Sub-agents executing this plan have concrete pass/fail targets at every stage. If a sixth pass surfaces more gaps during implementation, that's expected — the plan deliberately surfaces them in Phase 0 RED tests rather than hiding them.

> 2026-04-24: Phase 0.1 complete — 7 test layer files generated, all RED. validate-plan.sh: 4/4.
