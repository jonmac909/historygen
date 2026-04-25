#!/usr/bin/env bash
# validate-plan-exists.sh — Light check: plan exists + has test & impl phases
# Usage: bash .claude/scripts/validate-plan-exists.sh <plan-slug>

set -uo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

PROJECT_ROOT="${PROJECT_ROOT:-$(pwd)}"

PASSED=0
TOTAL=3

pass() { echo -e "  ${GREEN}\xe2\x9c\x93${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}\xe2\x9c\x97${NC} $1"; }

if [ $# -lt 1 ]; then
  echo -e "${BOLD}Usage:${NC} validate-plan-exists.sh <plan-slug>"
  echo "Example: validate-plan-exists.sh client-campaign-schema"
  exit 1
fi

SLUG="$1"
PLAN_FILE="$PROJECT_ROOT/.claude/plans/${SLUG}.md"

echo -e "\n${BOLD}Checking plan structure: ${SLUG}${NC}\n"

# --- Check 1: Plan file exists ---
if [ -f "$PLAN_FILE" ]; then
  pass "Plan file found"
else
  fail "Plan file not found at .claude/plans/${SLUG}.md"
  echo -e "\nChecks: 0/${TOTAL} passed"
  echo -e "\n${RED}\xe2\x9d\x8c Plan structure check failed.${NC}"
  exit 1
fi

# --- Check 2: Has test phase ---
if grep -qi -E '(phase\s*0|write\s*tests|write\s*all\s*tests)' "$PLAN_FILE" 2>/dev/null; then
  pass "Test phase defined"
else
  fail "No test phase (Phase 0 / Write Tests) found"
fi

# --- Check 3: Has implementation phases ---
if grep -qi -E '(phase\s*[1-9]|implementation\s*(steps|phases))' "$PLAN_FILE" 2>/dev/null; then
  pass "Implementation phases defined"
else
  fail "No implementation phases found"
fi

# --- Summary ---
echo ""
echo -e "Checks: ${PASSED}/${TOTAL} passed"

if [ "$PASSED" -eq "$TOTAL" ]; then
  echo -e "\n${GREEN}\xe2\x9c\x85 Plan structure looks good.${NC}"
  exit 0
else
  echo -e "\n${RED}\xe2\x9d\x8c Plan structure check failed.${NC}"
  exit 1
fi
