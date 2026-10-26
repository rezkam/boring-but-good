#!/bin/bash
# Test suite for the SonarQube skill
# Tests: argument validation, error messages, script structure
# RULE: Live tests are READ-ONLY. Never create, modify, or delete data in live systems.
# Read-only live tests run automatically when SonarQube is configured.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SQ_DIR="${SCRIPT_DIR}/../skills/sonarqube"
SQ_SCRIPTS="${SQ_DIR}/scripts"

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
assert_err_contains() {
    local label="$1" needle="$2"
    if echo "$CAPTURED_ERR" | grep -qi "$needle"; then pass "$label"; else fail "$label" "Expected stderr to contain: $needle"; fi
}

# ═══════════════════════════════════════════════════════════════════════════════
header "SonarQube: Script file checks"
# ═══════════════════════════════════════════════════════════════════════════════

for script in "$SQ_SCRIPTS"/*.sh; do
    name=$(basename "$script")
    [ "$name" = "_config.sh" ] && continue

    if [ -x "$script" ]; then pass "${name}: is executable"; else fail "${name}: not executable"; fi
    if bash -n "$script" 2>/dev/null; then pass "${name}: bash syntax OK"; else fail "${name}: bash syntax error"; fi
    if grep -q 'set -e' "$script"; then pass "${name}: has set -e"; else fail "${name}: missing set -e"; fi
done

# ═══════════════════════════════════════════════════════════════════════════════
header "SonarQube: _config.sh"
# ═══════════════════════════════════════════════════════════════════════════════

CONFIG="${SQ_SCRIPTS}/_config.sh"

if bash -n "$CONFIG" 2>/dev/null; then pass "_config.sh: bash syntax OK"; else fail "_config.sh: bash syntax error"; fi

# ═══════════════════════════════════════════════════════════════════════════════
header "SonarQube: Argument validation"
# ═══════════════════════════════════════════════════════════════════════════════

MOCK_TOKEN=$(mktemp); echo "fake" > "$MOCK_TOKEN"

# sonarqube-projects.sh is a list operation: no args is valid, so it is not checked here.
for script in sonarqube-issues sonarqube-coverage sonarqube-hotspots sonarqube-quality-gate sonarqube-transition; do
    SCRIPT_FILE="$SQ_SCRIPTS/${script}.sh"
    [ -f "$SCRIPT_FILE" ] || continue

    run_expect_fail env SONARQUBE_URL="http://fake" SONARQUBE_TOKEN_FILE="$MOCK_TOKEN" \
        bash "$SCRIPT_FILE"
    if [ $CAPTURED_RC -ne 0 ]; then
        pass "${script}.sh: exits non-zero without required args"
    else
        fail "${script}.sh: should exit non-zero without required args"
    fi

    if [ -n "$CAPTURED_ERR" ] && echo "$CAPTURED_ERR" | grep -qi 'usage\|error\|required'; then
        pass "${script}.sh: provides usage/error message"
    else
        fail "${script}.sh: no usage/error message on missing args"
    fi
done

rm -f "$MOCK_TOKEN"

# ═══════════════════════════════════════════════════════════════════════════════
header "SonarQube: Transition validation"
# ═══════════════════════════════════════════════════════════════════════════════

MOCK_TOKEN=$(mktemp); echo "fake" > "$MOCK_TOKEN"
TRANS="$SQ_SCRIPTS/sonarqube-transition.sh"

# Missing args
run_expect_fail env SONARQUBE_URL="http://fake" SONARQUBE_TOKEN_FILE="$MOCK_TOKEN" \
    bash "$TRANS"
if [ $CAPTURED_RC -ne 0 ]; then
    pass "sonarqube-transition.sh: exits non-zero with no args"
else
    fail "sonarqube-transition.sh: should fail with no args"
fi
assert_err_contains "sonarqube-transition.sh: error mentions required" "required"

# Missing transition
run_expect_fail env SONARQUBE_URL="http://fake" SONARQUBE_TOKEN_FILE="$MOCK_TOKEN" \
    bash "$TRANS" "AY123abc"
if [ $CAPTURED_RC -ne 0 ]; then
    pass "sonarqube-transition.sh: exits non-zero with only issue key"
else
    fail "sonarqube-transition.sh: should fail with only issue key"
fi

# Invalid transition
run_expect_fail env SONARQUBE_URL="http://fake" SONARQUBE_TOKEN_FILE="$MOCK_TOKEN" \
    bash "$TRANS" "AY123abc" "invalid_transition"
if [ $CAPTURED_RC -ne 0 ]; then
    pass "sonarqube-transition.sh: exits non-zero with invalid transition"
else
    fail "sonarqube-transition.sh: should reject invalid transition"
fi
assert_err_contains "sonarqube-transition.sh: lists valid transitions" "falsepositive"
assert_err_contains "sonarqube-transition.sh: explains status constraints" "OPEN"

# All valid transitions accepted by validation (will fail on curl, but not on validation)
for t in confirm unconfirm reopen resolve falsepositive wontfix accept; do
    run_expect_fail env SONARQUBE_URL="http://fake.invalid" SONARQUBE_TOKEN_FILE="$MOCK_TOKEN" \
        bash "$TRANS" "AY123abc" "$t"
    if ! echo "$CAPTURED_ERR" | grep -qi "invalid transition"; then
        pass "sonarqube-transition.sh: '${t}' passes validation"
    else
        fail "sonarqube-transition.sh: '${t}' should be a valid transition"
    fi
done

# Help flag
HELP_OUT=$(env SONARQUBE_URL="http://fake" SONARQUBE_TOKEN_FILE="$MOCK_TOKEN" \
    bash "$TRANS" --help 2>&1)
if echo "$HELP_OUT" | grep -qi "usage"; then
    pass "sonarqube-transition.sh: --help shows usage"
else
    fail "sonarqube-transition.sh: --help should show usage"
fi

rm -f "$MOCK_TOKEN"

# ═══════════════════════════════════════════════════════════════════════════════
# Live tests
# ═══════════════════════════════════════════════════════════════════════════════

if [ -f "$HOME/.boring/sonarqube/url" ] && [ -f "$HOME/.boring/sonarqube/token" ]; then
    header "SonarQube: LIVE — Connectivity (read-only)"

    RESULT=$("$SQ_SCRIPTS/sonarqube-api.sh" /api/system/status 2>&1)
    if echo "$RESULT" | jq -e '.status' >/dev/null 2>&1; then
        STATUS=$(echo "$RESULT" | jq -r '.status')
        pass "SonarQube API reachable (status: ${STATUS})"
    else
        fail "SonarQube API failed: $(echo "$RESULT" | head -3)"
    fi
else
    header "SonarQube: LIVE tests (read-only)"
    skip "SonarQube not configured (missing ~/.boring/sonarqube/ files)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Results: SonarQube"
# ═══════════════════════════════════════════════════════════════════════════════

printf "  ${GREEN}%d passed${RESET}  ${RED}%d failed${RESET}  ${YELLOW}%d skipped${RESET}\n" "$PASS" "$FAIL" "$SKIP"
echo ""
if [ "$FAIL" -gt 0 ]; then printf "  ${RED}${BOLD}FAILED${RESET}\n"; exit 1
else printf "  ${GREEN}${BOLD}ALL TESTS PASSED${RESET}\n"; exit 0; fi
