# claude-bridge

Local HTTP sidecar that routes Anthropic-SDK-shape requests through the Claude
Code CLI, so LLM usage bills against the user's Claude.ai subscription instead
of per-token API. Runs inside the render-api Railway container on
`127.0.0.1:9001`.

Design doc: `~/.claude/plans/humming-munching-platypus.md`.

## Activation runbook

The bridge ships deployed but inert. Flip it on by setting two Railway env vars.

### 1. Generate an OAuth token (local machine, one-time)

```bash
claude setup-token
```

Opens a browser tab for Claude.ai OAuth. After approval, it prints a token
starting with `sk-ant-oat-…`. Copy it.

### 2. Set the token in Railway

```bash
cd /Users/jacquelineyeung/AutoAiGen/history-gen-ai
railway link --service marvelous-blessing --environment staging  # if not already linked
railway variables --set CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-…
```

Railway auto-redeploys. Confirm the bridge wrote credentials on boot:

```bash
railway logs --service marvelous-blessing | grep '\[entrypoint\]'
# → [entrypoint] Wrote ~/.claude/credentials.json (0600)
```

### 3. Confirm subscription auth (no API billing)

```bash
railway logs --service marvelous-blessing | grep 'apiKeySource'
# → "apiKeySource":"none"   ← this is what you want
```

`"apiKeySource":"none"` means Claude Code authenticated via OAuth against your
Claude.ai account. If you see `"apiKeySource":"ANTHROPIC_API_KEY"` the token
isn't being read — check step 2.

### 4. Flip the feature flag

```bash
railway variables --set USE_CLAUDE_BRIDGE=true
```

`render-api/src/lib/anthropic-client.ts` immediately routes all 15+ Anthropic
callers through the bridge. Redeploy is automatic.

### 5. Verify

```bash
# Bridge health
railway run curl -s http://127.0.0.1:9001/health

# 429 flood should stop within minutes
railway logs --service marvelous-blessing | grep -i 'RateLimitError' | tail
```

Anthropic console (`console.anthropic.com`) should show your `ANTHROPIC_API_KEY`
usage flatline. Claude.ai dashboard usage should tick up instead.

## Token rotation

OAuth tokens expire periodically. When the bridge starts emitting 401s in
Railway logs:

```bash
claude setup-token                                       # local
railway variables --set CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-…
```

Railway auto-redeploys with the fresh credential.

## Break-glass (Claude.ai outage or bad token)

If the bridge is misbehaving and the app's LLM features are broken:

```bash
railway variables --set USE_CLAUDE_BRIDGE=false
```

All callers immediately revert to the Anthropic SDK against `ANTHROPIC_API_KEY`
(per-token billing during the outage). Flip back to `true` when ready.

## Tuning env vars

| Var | Default | Purpose |
|---|---|---|
| `FORCE_MODEL` | `opus` | Model every call uses |
| `FORCE_EFFORT` | `xhigh` | Reasoning effort level |
| `BRIDGE_POOL_SIZE` | `3` | Max warm sessions |
| `BRIDGE_CONCURRENCY` | `3` | Max parallel Claude processes |
| `BRIDGE_MAX_TURNS` | `50` | Retire session after N turns |
| `BRIDGE_MAX_CACHE_TOKENS` | `160000` | Retire session at cache-tokens threshold |
| `BRIDGE_REQUEST_TIMEOUT_MS` | `1200000` | Absolute per-turn cap (20 min). Safety ceiling. |
| `BRIDGE_IDLE_TIMEOUT_MS` | `600000` | Kill the session if no output from Claude for this long (10 min). Resets on every stdout line. Tuned for long-form generation where Opus xhigh buffers extended thinking silently. |
| `BRIDGE_TMP_BUDGET` | `104857600` | Max bytes of temp images at any time |

## Deleting deprecated Supabase edge functions

The frontend no longer invokes `rewrite-script` or `generate-image-prompts`
edge functions. Once you've verified bridge operation for a few days, remove
the deployed versions (the source is tagged DEPRECATED but still present):

```bash
cd /Users/jacquelineyeung/AutoAiGen/history-gen-ai
SUPABASE_ACCESS_TOKEN="REDACTED_SUPABASE_TOKEN" \
  npx supabase functions delete rewrite-script --project-ref udqfdeoullsxttqguupz
SUPABASE_ACCESS_TOKEN="REDACTED_SUPABASE_TOKEN" \
  npx supabase functions delete generate-image-prompts --project-ref udqfdeoullsxttqguupz
```
