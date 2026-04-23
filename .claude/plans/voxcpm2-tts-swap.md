# Change Plan: Fish Speech → VoxCPM2 TTS Swap

## Spec (from question loop)

- **Engine**: VoxCPM2 (2B params, 8GB VRAM, 0.13 RTF)
- **Deploy**: RunPod serverless, built-in container registry
- **Cloning mode**: Ultimate (reference audio + Whisper transcript)
- **Output**: 48kHz end-to-end (no downsample)
- **Chunk size**: 500 chars (up from Fish's 250)
- **Scope**: Test worktree only (`~/auto-ai-gen-test/`)
- **Goal**: Straight swap — same pipeline shape, different engine

## Breakage Map

### Will break (must fix)

| File | Line(s) | What | Fix |
|---|---|---|---|
| `render-api/src/routes/generate-audio.ts` | 59 | `RUNPOD_ENDPOINT_ID` default | Add `RUNPOD_VOXCPM2_ENDPOINT_ID` env var |
| `render-api/src/routes/generate-audio.ts` | 37 | `MAX_TTS_CHUNK_LENGTH = 250` | Change to 500 |
| `render-api/src/routes/generate-audio.ts` | 1694-1720 | `startTTSJob()` payload fields | Add `reference_transcript` field, map to VoxCPM2 input format |
| `render-api/src/routes/generate-audio.ts` | 384 | `generateSilence()` default 24000 | Change fallback to 48000 |
| `render-api/src/routes/generate-audio.ts` | 3078, 3238 | `service: 'fish_speech'` | Change to `'voxcpm2'` |
| `render-api/src/utils/audio-integrity.ts` | 73, 259 | Default sampleRate fallback 24000 | Change to 48000 |
| `render-api/src/lib/cost-tracker.ts` | 19, 76-78 | `fish_speech` pricing + switch case | Add `voxcpm2` entry |
| `supabase/functions/generate-audio/index.ts` | 13 | `MAX_TTS_CHUNK_LENGTH = 250` | Change to 500 |

### Won't break (sample-rate agnostic)

- `concatenateWavFiles()` — reads sampleRate from WAV headers
- `concatenateWavFilesWithPauses()` — generates silence at extracted sampleRate
- `getPauseDuration()` — returns seconds, not samples
- FFmpeg smoothing — Hz-based filters (80Hz highpass, 12kHz lowpass), safe for 48kHz
- `detectRepeatedWindows()` — adapts to sampleRate via `samplesPerFrame`
- Frontend audio player — HTML5 Audio API handles any WAV format
- Supabase storage — stores generic WAV bytes
- `adjustAudioSpeed()` — FFmpeg atempo is format-agnostic

## Phase 1: RunPod VoxCPM2 Worker ✅

- [x] `runpod-voxcpm2-worker/Dockerfile` — PyTorch base, VoxCPM2 + Whisper, weights baked in
- [x] `runpod-voxcpm2-worker/handler.py` — ultimate cloning, auto-transcribe via Whisper, 48kHz output
- [x] `runpod-voxcpm2-worker/requirements.txt` + `README.md`
- [x] Docker image built (13.9GB, linux/amd64)
- [x] Pushed to `ghcr.io/jonmac909/voxcpm2-worker:latest`
- [x] RunPod template `acqpaot8o4` (VoxCPM2-TTS) with GHCR registry auth
- [x] RunPod serverless endpoint `s7wnnxpnv1vqa1` (AMPERE_16, 0-3 workers)
- [x] Endpoint ID wired in `~/auto-ai-gen-test/.env`
- [ ] Smoke test: curl endpoint with sample text + voice

## Phase 2: Render API Integration ✅

- [x] `generate-audio.ts` line 37: `MAX_TTS_CHUNK_LENGTH = 500`
- [x] `generate-audio.ts` line 60-61: `RUNPOD_VOXCPM2_ENDPOINT_ID` + URL
- [x] `startTTSJob()`: `reference_transcript` + `emotion` in payload, routes to VoxCPM2 URL
- [x] `generateSilence()` default → 48000
- [x] Cost tracking: 3 call sites → `'voxcpm2'`
- [x] `audio-integrity.ts`: both fallbacks → 48000
- [x] `cost-tracker.ts`: `voxcpm2: 0.006` + switch case
- [x] `supabase/functions/generate-audio/index.ts`: chunk length → 500
- [x] Whisper transcription of voice sample (cached per URL via `getVoiceSampleTranscript()`)

## Phase 3: Verification

- [ ] Generate 5-min narration with voice cloning (ultimate mode)
- [ ] Verify output is 48kHz WAV (check header)
- [ ] Run `checkAudioIntegrity()` on output
- [ ] Run `detectRepeatedWindows()` — confirm no false positives on VoxCPM2
- [ ] Play in browser — confirm AudioPreviewModal works
- [ ] Verify Supabase upload/download cycle
- [ ] Measure: RunPod job time, cost per minute, total latency
- [ ] A/B: same script + voice, Fish vs VoxCPM2, compare WER + subjective quality

## Questions

(none — spec locked)
