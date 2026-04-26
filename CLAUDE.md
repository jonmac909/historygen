# Claude Rules for AutoAiGen Project

## CRITICAL: Data Safety

1. **NEVER delete data** - No DELETE commands on Supabase, ever
2. **NEVER suggest "cleaning up"** - Don't volunteer to remove, archive, or tidy data
3. **NEVER touch data unless explicitly asked** - Don't query the database looking for problems
4. **Projects with the same title are NOT duplicates** - Each has a unique UUID, user may want multiple versions

## When Working on This Project

1. **Stay in scope** - Only do what was asked, then stop
2. **Don't wander** - After finishing a task, don't explore for more "improvements"
3. **Ask before irreversible actions** - If something can't be undone, confirm first
4. **Use the app's functions** - Don't bypass existing code with raw API calls

## When Accused of Something

1. **Search the logs first** - Check `/Users/jacquelineyeung/.claude/projects/` transcripts before denying
2. **Don't be defensive** - Investigate, don't argue
3. **Memory is unreliable** - Context compaction loses information

## Soft Delete Already Exists

The codebase has soft delete in `src/lib/projectStore.ts`:
- `deleteProject()` sets `status: 'archived'` (line 305)
- It does NOT actually delete rows
- Archived projects can be recovered

If you ever need to "delete" something (which you shouldn't without being asked):
- Use the app's UI delete button
- Or `PATCH` with `status: 'archived'`
- NEVER `curl -X DELETE`

## Audio Takes Hours to Generate

Audio generation is expensive (time and money). Never do anything that could cause audio files to be lost. The storage bucket `generated-assets` contains irreplaceable work.

## What Costs Money

- Fish Speech TTS: Audio generation
- Z-Image: Image generation
- Seedance/KIE: Video clip generation
- Claude API: Script rewriting

Don't cause regeneration of any of these without explicit request.

## Correct Pricing Constants (Verified from Scottish Highlands project)

File: `render-api/src/lib/cost-tracker.ts`

| Service | Rate | Notes |
|---------|------|-------|
| fish_speech | $0.008/min | Self-hosted server |
| z_image | $0.0084/image | Self-hosted server |
| whisper | $0.006/min | Transcription |
| seedance | $0.08/clip | Kie.ai |
| claude_input | $3/1M tokens | |
| claude_output | $15/1M tokens | |
| claude_vision | $0.004/image | |

**DO NOT** use RunPod marketplace rates or change these without checking against a known-correct project like Scottish Highlands.

## Deployment

**Supabase Edge Functions:**
```bash
cd /Users/jacquelineyeung/AutoAiGen/history-gen-ai
SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" npx supabase functions deploy <function-name> --project-ref udqfdeoullsxttqguupz
```

**Project IDs:**
- Supabase: `udqfdeoullsxttqguupz`
- Frontend: Vercel auto-deploys from git push to main

---

## Local-Inference Branch (`feat/local-inference`) — As of 2026-04-25

**Goal:** swap RunPod (Z-Image + VoxCPM2) + Kie.ai (video clips) + Cloudflare R2 (asset bytes) for localhost inference + local-disk storage. Production behavior preserved behind a `LOCAL_INFERENCE` feature flag (default `false`); production path byte-identical when flag off.

**Branch:** `feat/local-inference` — 20 commits, pushed to origin. `main` untouched. Render.com / Vercel auto-deploys both unaffected.

**For full architecture:** [.claude/plans/local-inference-swap.md](.claude/plans/local-inference-swap.md)
**For commit-by-commit:** [CHANGELOG.md](CHANGELOG.md)

### Verified working today (RTX 5070 12 GB)

| Component | State | Evidence |
|---|---|---|
| `local-inference/voxcpm2_server.py` (port 7861) | ✅ green | 28 s cold / 7.5 s warm, 11 GB peak, /unload releases. Cloning + Whisper SHA-256 cache works. |
| `render-api` swap — 10 sub-steps in Phase 2 | ✅ green | 47 unit tests pass, `tsc --noEmit` 0 errors, regression snapshot baseline captured |
| `render-api/.env` env-flag flow | ✅ green | `dotenv` import order bug fixed (was at line 51, AFTER imports — moved to line 1) |
| `localInferenceConfig` env bundle, `uploadAsset` wrapper, `cost-tracker` zero rates, `/health`, `/config`, `/assets` static, NVENC encoder swap | ✅ all wired | |
| Browser dev tester (`/assets/dev-tools/tts.html`) | ✅ E2E via agent-browser | 49.6 s wall, SSE progress bar 0→100%, 9 progress events streamed, audio played inline (readyState=4) |
| Phase 2.8 LTX-2 probe-and-fallback | ✅ falls back to Kie.ai | When `LOCAL_LTX2_URL` unreachable, video clips automatically use existing Kie.ai path. Routing flips silently when LTX-2 server comes online. |

### Hardware-blocked on 12 GB (waiting for Monday's 5080 16 GB)

| Component | Block reason |
|---|---|
| `local-inference/zimage_server.py` (port 7862) | Z-Image-Turbo 6B BF16 doesn't fit on 12 GB after Windows pagefile cap. CPU staging crashes pagefile, force-cuda OOMs (`~26 GiB allocated by PyTorch`). Code itself is correct. |
| `local-inference/ltx2_server.py` (port 7863) | LTX-2 22B + Gemma 3 12B encoder exceeds 12 GB. Pipeline + DistilledPipeline config locked in plan; verified API surface read from `D:\LTX-2\packages\ltx-pipelines\src\ltx_pipelines\distilled.py:47`. |
| `tests/local-inference.spec.ts` (Playwright lifecycle) | Needs Z-Image + LTX-2 to actually run end-to-end. Spec exists, `webServer` config update pending. |

### Monday checklist (~1–2 hours total to ship)

1. **Hardware:** install RTX 5080 16 GB. `nvidia-smi` confirms 16 GB / sm_120.
2. **Spin stack:** `pwsh local-inference\start-all.ps1` (sets `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` automatically) → `pwsh local-inference\healthcheck.ps1 -Ready` blocks until all 3 `/healthz?ready=1` return 200.
3. **Z-Image smoke:** open `http://localhost:3000/assets/dev-tools/tts.html` (already verified) → confirm WAV. Then curl Z-Image direct at 1024×1024:
   ```
   curl -X POST http://localhost:7862/generate -H "Content-Type: application/json" `
     -d '{"prompt":"a Roman senator on the steps of the forum","aspectRatio":"1:1","quality":"high"}' `
     -o test.png
   ```
   Expected: ~10–15 s on 5080. If GREEN → cycle to `aspectRatio: "16:9"` (1920×1080) for full-quality test.
4. **LTX-2 smoke:** with the LTX-2 server up, `curl POST /i2v` with a small base64 PNG. Expected wall time ~2–6 min on 5080. The `generate-video-clips.ts` probe-and-fallback (commit `10990e1`) auto-routes to LTX-2 once `/healthz` is ready.
5. **Full Shorts pipeline E2E:**
   - Set real Supabase + OpenAI keys in `render-api/.env` (replacing placeholders)
   - `cd D:\historygen && npm run dev` → frontend at `localhost:8080` (Vite override; NOT 5173)
   - Sign in, open existing project, click Generate Short
   - Capture: SSE events, final video URL, `nvidia-smi` showing NVENC active during render, `netstat` proving zero outbound to api.runpod.ai / api.kie.ai
6. **Ship gate:**
   - `gh pr create` (will need `gh` installed: `winget install GitHub.cli`)
   - Self-review: re-run all unit tests, run a 3-round zero-gaps loop on the PR diff
   - `gh pr merge --squash` → Render.com + Vercel auto-deploy both fire
   - 3-click production smoke (open project, click Generate Short, confirm asset URL is `*.r2.cloudflarestorage.com` not localhost — proves remote-mode unchanged)
   - Append to `CHANGELOG.md` with PR # and final test counts

### Known limitations to flag during Monday verification

- **Audio integrity warnings** during voice cloning: VoxCPM2 generates 12+ "skip"/"discontinuity" warnings per short clone. Audio is still playable. Could be real glitches or false positives from natural speech pauses. Tune in a follow-up; not blocking.
- **Z-Image perf on Blackwell sm_120 Windows:** no `flash-attn` wheel exists for cu128. Falls back to native SDPA at ~5 min per denoising step at 1080p. Mitigation in dev: default to 1024×1024 (~3.5× less compute → ~12 min/image). Not unblocked by 5080 — same architecture.
- **Layer 5 regression snapshot tests** for `/generate-images`, `/generate-audio`, `/generate-video-clips`: stay RED on a `vi.unstubAllEnvs()` cascade in test-infra (clears `ANTHROPIC_API_KEY` before app re-import). Test infrastructure issue, not a code defect. Fix in a separate cleanup commit.
- **`local-assets/` dirs are gitignored** except `fx/` and `dev-tools/`. Voice samples + smoke artifacts stay local.
- **Env file `render-api/.env`** is gitignored (contains secrets). The placeholder version used in this session is in `local-assets/render-api.log` if you need to recreate it.

### Pricing in local mode

`localInferenceConfig.enabled === true` zeroes rates for `z_image`, `voxcpm2`, `seedance`, `fish_speech`. `whisper`, `claude_input/output/vision` stay paid (cloud APIs). `cost_usd=0` rows still written to `project_costs` so the grid stays populated.
