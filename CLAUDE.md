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
