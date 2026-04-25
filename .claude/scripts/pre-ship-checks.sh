#!/usr/bin/env bash
# pre-ship-checks.sh — Universal pre-ship quality gates for all projects
# Usage: bash ~/.claude/scripts/pre-ship-checks.sh [scope]
#   scope: number of commits (default 5), branch name, or "all"
#
# Checks:
#   1. Route safety    — every API route has catchAndRespond or auth middleware
#   2. OpenAPI coverage — every API route has an OpenAPI spec entry
#   3. FieldHelp        — admin form fields have FieldHelp tooltips
#   4. User manual      — updated for user-facing changes
#   5. Changelog        — updated in scope
#   6. Error boundaries — major route segments have error.tsx
#   7. Fetch safety     — client components check res.ok before .json()

set -uo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

PASSED=0
WARNED=0
FAILED=0
TOTAL=0

pass()  { echo -e "  ${GREEN}✓${NC} $1"; PASSED=$((PASSED + 1)); TOTAL=$((TOTAL + 1)); }
warn()  { echo -e "  ${YELLOW}⚠${NC} $1"; WARNED=$((WARNED + 1)); TOTAL=$((TOTAL + 1)); }
fail()  { echo -e "  ${RED}✗${NC} $1"; FAILED=$((FAILED + 1)); TOTAL=$((TOTAL + 1)); }
header() { echo -e "\n${BOLD}$1${NC}"; }

# Detect project root and app directory
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$PROJECT_ROOT"

# Find the app source directory (supports monorepo and single-app)
if [ -d "apps/routing/src" ]; then
  APP_DIR="apps/routing/src"
  APP_ROOT="apps/routing"
elif [ -d "src/app/api" ]; then
  APP_DIR="src"
  APP_ROOT="."
else
  echo "Could not detect app directory. Run from project root."
  exit 1
fi

# Determine diff scope
SCOPE="${1:-5}"
if [[ "$SCOPE" =~ ^[0-9]+$ ]]; then
  DIFF_BASE="HEAD~${SCOPE}"
elif [[ "$SCOPE" == "all" ]]; then
  DIFF_BASE=$(git rev-list --max-parents=0 HEAD)
else
  DIFF_BASE="$SCOPE"
fi

CHANGED_FILES=$(git diff --name-only "$DIFF_BASE" 2>/dev/null || echo "")
CHANGED_ROUTES=$(echo "$CHANGED_FILES" | grep "${APP_DIR}/app/api/.*route\.ts$" || true)
CHANGED_TSX=$(echo "$CHANGED_FILES" | grep "${APP_DIR}/.*\.tsx$" || true)
CHANGED_ADMIN_TSX=$(echo "$CHANGED_FILES" | grep "${APP_DIR}/app/admin/.*\.tsx$\|${APP_DIR}/app/superadmin/.*\.tsx$" || true)

echo -e "${BOLD}Pre-Ship Checks${NC} (scope: ${SCOPE})"
echo "Changed: $(echo "$CHANGED_FILES" | grep -c . || echo 0) files, $(echo "$CHANGED_ROUTES" | grep -c . || echo 0) routes"

# ─── Check 1: Route Safety (Sentry error tracking) ───────────────────
header "1. Route Safety"

if [ -z "$CHANGED_ROUTES" ]; then
  pass "No changed API routes"
else
  ROUTE_PASS=0
  ROUTE_FAIL=0
  ROUTE_FAILURES=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    has_catch=$(grep -c 'catchAndRespond' "$f" 2>/dev/null || true)
    has_mw=$(grep -cE 'withSuperAdmin|withAdmin|withAuth|withOwner|withPartner' "$f" 2>/dev/null || true)
    if [ "${has_catch:-0}" -gt 0 ] 2>/dev/null || [ "${has_mw:-0}" -gt 0 ] 2>/dev/null; then
      ROUTE_PASS=$((ROUTE_PASS + 1))
    else
      ROUTE_FAIL=$((ROUTE_FAIL + 1))
      ROUTE_FAILURES="$ROUTE_FAILURES\n      $f"
    fi
  done <<< "$CHANGED_ROUTES"

  if [ "$ROUTE_FAIL" -eq 0 ]; then
    pass "All ${ROUTE_PASS} changed routes have error tracking"
  else
    fail "${ROUTE_FAIL} routes missing catchAndRespond or auth middleware:${ROUTE_FAILURES}"
  fi
fi

# ─── Check 2: OpenAPI Coverage ───────────────────────────────────────
header "2. OpenAPI Coverage"

OPENAPI_DIR="${APP_ROOT}/src/lib/openapi"
if [ ! -d "$OPENAPI_DIR" ]; then
  pass "No OpenAPI specs (N/A for this project)"
else
  if [ -z "$CHANGED_ROUTES" ]; then
    pass "No changed API routes"
  else
    # Collect all paths defined in OpenAPI YAML files
    OPENAPI_PATHS=$(grep -rh '^\s*/api/' "$OPENAPI_DIR" 2>/dev/null | sed 's/://;s/^\s*//' | sort -u)
    # Internal routes that don't need OpenAPI specs
    OPENAPI_SKIP="api/health|api/cron/|api/agent/|api/v1/sentry|api/v1/calls/webhooks"
    OA_PASS=0
    OA_FAIL=0
    OA_FAILURES=""
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      # Skip internal routes
      if echo "$f" | grep -qE "$OPENAPI_SKIP"; then
        OA_PASS=$((OA_PASS + 1))
        continue
      fi
      # Convert file path to API path: src/app/api/v1/signup/route.ts → /api/v1/signup
      api_path=$(echo "$f" | sed "s|${APP_DIR}/app||;s|/route\.ts$||" | sed 's/\[tenantId\]/{tenantId}/g;s/\[id\]/{id}/g;s/\[keyId\]/{keyId}/g;s/\[\([^]]*\)\]/{\1}/g')

      if echo "$OPENAPI_PATHS" | grep -qF "$api_path"; then
        OA_PASS=$((OA_PASS + 1))
      else
        OA_FAIL=$((OA_FAIL + 1))
        OA_FAILURES="$OA_FAILURES\n      $api_path ($f)"
      fi
    done <<< "$CHANGED_ROUTES"

    if [ "$OA_FAIL" -eq 0 ]; then
      pass "All ${OA_PASS} changed routes have OpenAPI specs"
    else
      warn "${OA_FAIL} routes missing OpenAPI spec:${OA_FAILURES}"
    fi
  fi
fi

# ─── Check 3: FieldHelp Coverage ─────────────────────────────────────
header "3. FieldHelp"

if [ -z "$CHANGED_ADMIN_TSX" ]; then
  pass "No changed admin UI files"
else
  FH_TOTAL=0
  FH_GAPS=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    [ ! -f "$f" ] && continue
    forms=$(grep -cE '<FormField|<label|<input |<select |<Input |<Select ' "$f" 2>/dev/null || true)
    helps=$(grep -c 'FieldHelp' "$f" 2>/dev/null || true)
    forms=${forms:-0}
    helps=${helps:-0}
    if [ "$forms" -gt 0 ] 2>/dev/null && [ "$helps" -eq 0 ] 2>/dev/null; then
      FH_GAPS="$FH_GAPS\n      $f — ${forms} form elements, 0 FieldHelp"
      FH_TOTAL=$((FH_TOTAL + 1))
    fi
  done <<< "$CHANGED_ADMIN_TSX"

  if [ "$FH_TOTAL" -eq 0 ]; then
    pass "All admin form fields have FieldHelp"
  else
    warn "${FH_TOTAL} files missing FieldHelp:${FH_GAPS}"
  fi
fi

# ─── Check 4: User Manual ────────────────────────────────────────────
header "4. User Manual"

MANUAL_PATH="${APP_ROOT}/src/content/user-manual.md"
HAS_UI_CHANGES=$(echo "$CHANGED_TSX" | grep -c "${APP_DIR}/app/" || true)
MANUAL_UPDATED=$(echo "$CHANGED_FILES" | grep -c "user-manual" || true)

if [ "${HAS_UI_CHANGES:-0}" -eq 0 ] 2>/dev/null; then
  pass "No user-facing changes (N/A)"
elif [ ! -f "$MANUAL_PATH" ]; then
  pass "No user manual in project (N/A)"
elif [ "${MANUAL_UPDATED:-0}" -gt 0 ] 2>/dev/null; then
  pass "User manual updated"
else
  warn "User-facing changes but user-manual.md not updated"
fi

# ─── Check 5: Changelog ──────────────────────────────────────────────
header "5. Changelog"

CHANGELOG_UPDATED=$(echo "$CHANGED_FILES" | grep -c "CHANGELOG" || true)
if [ "${CHANGELOG_UPDATED:-0}" -gt 0 ] 2>/dev/null; then
  pass "CHANGELOG.md updated"
else
  warn "CHANGELOG.md not updated in scope"
fi

# ─── Check 6: Error Boundaries ───────────────────────────────────────
header "6. Error Boundaries"

NEW_SEGMENTS=$(echo "$CHANGED_TSX" | sed -n "s|\(${APP_DIR}/app/[^/]*\)/.*|\1|p" | sort -u || true)
EB_MISSING=""
while IFS= read -r seg; do
  [ -z "$seg" ] && continue
  if [ ! -f "${seg}/error.tsx" ] && [[ ! "$seg" =~ (api|get-started|login|forgot-password|reset-password)$ ]]; then
    EB_MISSING="$EB_MISSING\n      ${seg}/error.tsx"
  fi
done <<< "$NEW_SEGMENTS"

if [ -z "$EB_MISSING" ]; then
  pass "All route segments have error boundaries"
else
  warn "Missing error.tsx:${EB_MISSING}"
fi

# ─── Check 7: Fetch Safety ───────────────────────────────────────────
header "7. Fetch Safety"

CLIENT_FILES=$(echo "$CHANGED_TSX" | xargs grep -l "'use client'" 2>/dev/null || true)
FETCH_GAPS=""
if [ -z "$CLIENT_FILES" ]; then
  pass "No changed client components"
else
  FETCH_FAIL=0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    has_fetch=$(grep -c 'fetch(' "$f" 2>/dev/null || true)
    has_ok_check=$(grep -c '\.ok\|res\.ok\|r\.ok\|response\.ok' "$f" 2>/dev/null || true)
    has_fetch=${has_fetch:-0}
    has_ok_check=${has_ok_check:-0}
    if [ "$has_fetch" -gt 0 ] 2>/dev/null && [ "$has_ok_check" -eq 0 ] 2>/dev/null; then
      FETCH_GAPS="$FETCH_GAPS\n      $f — fetch() without .ok check"
      FETCH_FAIL=$((FETCH_FAIL + 1))
    fi
  done <<< "$CLIENT_FILES"

  if [ "$FETCH_FAIL" -eq 0 ]; then
    pass "All client fetch() calls check .ok"
  else
    fail "Unsafe fetch:${FETCH_GAPS}"
  fi
fi

# ─── Check 8: Feature Completeness Gate ─────────────────────────────
header "8. Feature Completeness"

FEATURE_GATE_SCRIPT="${PROJECT_ROOT}/scripts/feature-completeness-check.sh"
if [ -f "$FEATURE_GATE_SCRIPT" ]; then
  FC_OUTPUT=$(bash "$FEATURE_GATE_SCRIPT" "$SCOPE" 2>&1 || true)
  FC_WARNS=$(echo "$FC_OUTPUT" | grep -c "WARN" || true)
  FC_FAILS=$(echo "$FC_OUTPUT" | grep -c "FAIL" || true)
  if [ "${FC_FAILS:-0}" -gt 0 ] 2>/dev/null; then
    fail "Feature completeness gate has failures (run scripts/feature-completeness-check.sh for details)"
  elif [ "${FC_WARNS:-0}" -gt 0 ] 2>/dev/null; then
    warn "Feature completeness gate has warnings (run scripts/feature-completeness-check.sh for details)"
  else
    pass "Feature completeness gate passed"
  fi
else
  pass "No feature completeness script (N/A)"
fi

# ─── Summary ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Result: ${GREEN}${PASSED} passed${NC}, ${YELLOW}${WARNED} warnings${NC}, ${RED}${FAILED} failures${NC} (${TOTAL} checks)"

if [ "$FAILED" -gt 0 ]; then
  echo -e "${RED}Fix failures before shipping.${NC}"
  exit 1
elif [ "$WARNED" -gt 0 ]; then
  echo -e "${YELLOW}Warnings — review before shipping.${NC}"
  exit 0
else
  echo -e "${GREEN}All clear. Ship it.${NC}"
  exit 0
fi
