#!/bin/sh
set -e

# Write Claude Code OAuth credentials from $CLAUDE_CODE_OAUTH_TOKEN env var
# into ~/.claude/credentials.json so the bundled CLI authenticates against
# your Claude.ai subscription (not a per-token API key).
#
# Claude Code refuses credentials files with perms wider than 0600 (gap #19).
if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
  mkdir -p "$HOME/.claude"
  cat > "$HOME/.claude/credentials.json" <<EOF
{ "oauth_token": "$CLAUDE_CODE_OAUTH_TOKEN" }
EOF
  chmod 0600 "$HOME/.claude/credentials.json"
  echo "[entrypoint] Wrote ~/.claude/credentials.json (0600)"
else
  echo "[entrypoint] WARNING: CLAUDE_CODE_OAUTH_TOKEN not set; bridge will fail auth"
fi

# Neutral workdir for the CLI (no CLAUDE.md auto-discovery).
mkdir -p /tmp/claude-bridge/workdir /tmp/claude-bridge

exec "$@"
