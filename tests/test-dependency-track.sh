#!/bin/bash
# Test suite for the Dependency-Track skill
# Tests: argument validation, error messages, script structure
# RULE: Live tests are READ-ONLY. Never create, modify, or delete data in live systems.
# Read-only live tests run automatically when Dependency-Track is configured.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DT_DIR="${SCRIPT_DIR}/../skills/dependency-track"
DT_SCRIPTS="${DT_DIR}/scripts"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
PASS=0; FAIL=0; SKIP=0


pass() { PASS=$((PASS + 1)); printf "  ${GREEN}OK${RESET}   %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${RESET} %s\n" "$1"; [ -n "$2" ] && printf "    ${DIM}%s${RESET}\n" "$2"; }
skip() { SKIP=$((SKIP + 1)); printf "  ${YELLOW}SKIP${RESET} %s ${DIM}(skipped)${RESET}\n" "$1"; }
header() { echo ""; printf "${BOLD}━━━ %s ━━━${RESET}\n" "$1"; }

run_expect_fail() {
    local tmp_err; tmp_err=$(mktemp)
    "$@" >/dev/null 2>"$tmp_err"; CAPTURED_RC=$?; CAPTURED_ERR=$(cat "$tmp_err"); rm -f "$tmp_err"
}

# ═══════════════════════════════════════════════════════════════════════════════
header "Dependency-Track: Script file checks"
# ═══════════════════════════════════════════════════════════════════════════════

for script in "$DT_SCRIPTS"/*.sh; do
    name=$(basename "$script")
    [ "$name" = "_config.sh" ] && continue

    if [ -x "$script" ]; then pass "${name}: is executable"; else fail "${name}: not executable"; fi
    if bash -n "$script" 2>/dev/null; then pass "${name}: bash syntax OK"; else fail "${name}: bash syntax error"; fi
    if grep -q 'set -e' "$script"; then pass "${name}: has set -e"; else fail "${name}: missing set -e"; fi
done

# ═══════════════════════════════════════════════════════════════════════════════
header "Dependency-Track: _config.sh"
# ═══════════════════════════════════════════════════════════════════════════════

CONFIG="${DT_SCRIPTS}/_config.sh"

if bash -n "$CONFIG" 2>/dev/null; then pass "_config.sh: bash syntax OK"; else fail "_config.sh: bash syntax error"; fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Dependency-Track: Argument validation"
# ═══════════════════════════════════════════════════════════════════════════════

MOCK_TOKEN=$(mktemp); echo "fake" > "$MOCK_TOKEN"

for script in dtrack-api dtrack-findings dtrack-audit dtrack-audit-get dtrack-components dtrack-services dtrack-violations dtrack-project-status dtrack-projects dtrack-project-lookup dtrack-vulnerability dtrack-bom-upload; do
    SCRIPT_FILE="$DT_SCRIPTS/${script}.sh"
    [ -f "$SCRIPT_FILE" ] || continue

    run_expect_fail env DTRACK_URL="http://fake" DTRACK_API_KEY_FILE="$MOCK_TOKEN" \
        bash "$SCRIPT_FILE"
    if [ $CAPTURED_RC -ne 0 ]; then
        pass "${script}.sh: exits non-zero without required args"
    else
        fail "${script}.sh: exits 0 without required args"
    fi

    if [ -n "$CAPTURED_ERR" ] && echo "$CAPTURED_ERR" | grep -qi 'usage\|error\|required'; then
        pass "${script}.sh: provides usage/error message"
    else
        fail "${script}.sh: no error message on missing args"
    fi
done

# dtrack-metrics-refresh.sh: valid no-arg behavior (refreshes portfolio metrics).
# It should NOT be in the "must fail" loop — calling without args triggers a portfolio
# refresh, which is its intended default mode.
run_expect_fail env DTRACK_URL="http://fake" DTRACK_API_KEY_FILE="$MOCK_TOKEN" \
    bash "$DT_SCRIPTS/dtrack-metrics-refresh.sh"
if [ $CAPTURED_RC -eq 0 ]; then
    pass "dtrack-metrics-refresh.sh: exits 0 without args (portfolio refresh mode)"
else
    fail "dtrack-metrics-refresh.sh: unexpected failure without args (rc=${CAPTURED_RC})"
fi
if echo "$CAPTURED_ERR" | grep -qi "portfolio.*refresh\|refresh.*portfolio"; then
    pass "dtrack-metrics-refresh.sh: outputs portfolio refresh message"
else
    fail "dtrack-metrics-refresh.sh: missing portfolio refresh message"
fi

rm -f "$MOCK_TOKEN"

# ═══════════════════════════════════════════════════════════════════════════════
# Live tests
# ═══════════════════════════════════════════════════════════════════════════════

if [ -f "$HOME/.boring/dependency-track/url" ] && [ -f "$HOME/.boring/dependency-track/apikey" ]; then
    header "Dependency-Track: LIVE — Connectivity (read-only)"

    RESULT=$("$DT_SCRIPTS/dtrack-api.sh" GET /v1/project?pageSize=1 2>&1)
    if echo "$RESULT" | jq -e '.[0].name' >/dev/null 2>&1; then
        pass "Dependency-Track API reachable"
    else
        fail "Dependency-Track API failed: $(echo "$RESULT" | head -3)"
    fi

    header "Dependency-Track: LIVE — Project listing (read-only)"

    PROJECTS=$("$DT_SCRIPTS/dtrack-projects.sh" 2>&1)
    if echo "$PROJECTS" | jq -e '.[0].name' >/dev/null 2>&1; then
        COUNT=$(echo "$PROJECTS" | jq 'length')
        pass "dtrack-projects.sh: listed ${COUNT} projects"
    else
        fail "dtrack-projects.sh: failed: $(echo "$PROJECTS" | head -3)"
    fi
else
    header "Dependency-Track: LIVE tests (read-only)"
    skip "Dependency-Track not configured (missing ~/.boring/dependency-track/ files)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Results: Dependency-Track"
# ═══════════════════════════════════════════════════════════════════════════════

printf "  ${GREEN}%d passed${RESET}  ${RED}%d failed${RESET}  ${YELLOW}%d skipped${RESET}\n" "$PASS" "$FAIL" "$SKIP"
echo ""
if [ "$FAIL" -gt 0 ]; then printf "  ${RED}${BOLD}FAILED${RESET}\n"; exit 1
else printf "  ${GREEN}${BOLD}ALL TESTS PASSED${RESET}\n"; exit 0; fi
