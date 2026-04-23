#!/usr/bin/env bash
# Verifies the audio polling-race fix is wired up.
#
# The bug: frontend polling fallback in src/lib/api.ts resolves as soon as
# `current_step !== 'audio'` + `audio_url` is set. On a regen against a
# previously-completed project, that was true from t=0 — so the first 30s
# poll returned the PREVIOUS run's stale snapshot, leaving the modal stuck
# on the old segment count.
#
# The fix (three parts):
#   1. A `markAudioGenerationStarted` helper that flips current_step='audio'
#      and throws on failure.
#   2. The main audio route calls it before dispatching to any handler.
#   3. `saveAudioToProject` clears `segments_need_recombine` on completion so
#      the "Combined audio is outdated" warning doesn't carry over.
#
# This script greps the code to confirm those three pieces are in place.

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0

check() {
  local desc="$1"
  local file="$2"
  local pattern="$3"
  if grep -q "$pattern" "$file"; then
    echo "  [OK] $desc"
  else
    echo "  [FAIL] MISSING: $desc"
    echo "         file: $file"
    echo "         pattern: $pattern"
    FAIL=1
  fi
}

echo "Checking audio polling-race fix..."

check "markAudioGenerationStarted helper exported" \
  "$ROOT/render-api/src/lib/supabase-project.ts" \
  "export async function markAudioGenerationStarted"

check "markAudioGenerationStarted throws on failure" \
  "$ROOT/render-api/src/lib/supabase-project.ts" \
  "throw new Error(\`Failed to mark audio generation started"

check "saveAudioToProject clears segments_need_recombine" \
  "$ROOT/render-api/src/lib/supabase-project.ts" \
  "segments_need_recombine: false"

check "ProjectUpdate interface has segments_need_recombine" \
  "$ROOT/render-api/src/lib/supabase-project.ts" \
  "segments_need_recombine?: boolean"

check "markAudioGenerationStarted imported in generate-audio.ts" \
  "$ROOT/render-api/src/routes/generate-audio.ts" \
  "markAudioGenerationStarted.*from '../lib/supabase-project'"

check "markAudioGenerationStarted awaited in route handler" \
  "$ROOT/render-api/src/routes/generate-audio.ts" \
  "await markAudioGenerationStarted(projectId)"

if [ $FAIL -ne 0 ]; then
  echo ""
  echo "FAIL: audio polling-race fix incomplete"
  exit 1
fi

echo ""
echo "OK: audio polling-race fix in place"
