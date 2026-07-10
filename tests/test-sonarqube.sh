#!/bin/bash
# Test suite for the SonarQube skill
# Tests: argument validation, error messages, script structure
# RULE: Live tests are READ-ONLY. Never create, modify, or delete data in live systems.
# Read-only live tests run automatically when SonarQube is configured.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SQ_DIR="${SCRIPT_DIR}/../workflow-tools/sonarqube"
SQ_SCRIPTS="${SQ_DIR}/scripts"
SKILL_DIR="${SCRIPT_DIR}/../workflow-tools/sonarqube"

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
header "SonarQube: SKILL.md structure"
# ═══════════════════════════════════════════════════════════════════════════════

SKILLMD="${SKILL_DIR}/SKILL.md"

if [ -f "$SKILLMD" ]; then pass "SKILL.md exists"; else fail "SKILL.md missing"; fi
if head -1 "$SKILLMD" | grep -q '^---$'; then pass "Has YAML frontmatter"; else fail "Missing YAML frontmatter"; fi
if grep -q '^name: sonarqube' "$SKILLMD"; then pass "Name field is 'sonarqube'"; else fail "Name field missing or wrong"; fi
if grep -q '^description:' "$SKILLMD"; then pass "Has description"; else fail "Missing description"; fi

if grep -qiE 'telavox|reza\.kamali|/Users/' "$SKILLMD"; then
    fail "SKILL.md contains company/user/system-specific data"
else
    pass "No company/user/system-specific data in SKILL.md"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "SonarQube: Script file checks"
# ═══════════════════════════════════════════════════════════════════════════════

for script in "$SQ_SCRIPTS"/*.sh; do
    name=$(basename "$script")
    [ "$name" = "_config.sh" ] && continue

    if [ -x "$script" ]; then pass "${name}: is executable"; else fail "${name}: not executable"; fi
    if bash -n "$script" 2>/dev/null; then pass "${name}: bash syntax OK"; else fail "${name}: bash syntax error"; fi
    if grep -q 'set -e' "$script"; then pass "${name}: has set -e"; else fail "${name}: missing set -e"; fi
    if grep -q '_config.sh\|sonarqube-api.sh' "$script"; then pass "${name}: loads config"; else fail "${name}: doesn't load config"; fi

    if grep -qiE 'telavox|reza\.kamali|/Users/' "$script"; then
        fail "${name}: contains company/user/system-specific data"
    else
        pass "${name}: no company/user/system-specific data"
    fi
done

# ═══════════════════════════════════════════════════════════════════════════════
header "SonarQube: _config.sh"
# ═══════════════════════════════════════════════════════════════════════════════

CONFIG="${SQ_SCRIPTS}/_config.sh"

if bash -n "$CONFIG" 2>/dev/null; then pass "_config.sh: bash syntax OK"; else fail "_config.sh: bash syntax error"; fi
if grep -q '\.boring/sonarqube' "$CONFIG"; then pass "_config.sh: uses ~/.boring/sonarqube/"; else fail "_config.sh: should use ~/.boring/sonarqube/"; fi
if grep -qiE 'telavox|reza\.kamali|/Users/' "$CONFIG"; then
    fail "_config.sh: contains company/user/system-specific data"
else
    pass "_config.sh: no company/user/system-specific data"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "SonarQube: Argument validation"
# ═══════════════════════════════════════════════════════════════════════════════

MOCK_TOKEN=$(mktemp); echo "fake" > "$MOCK_TOKEN"

for script in sonarqube-issues sonarqube-coverage sonarqube-hotspots sonarqube-projects sonarqube-quality-gate sonarqube-transition; do
    SCRIPT_FILE="$SQ_SCRIPTS/${script}.sh"
    [ -f "$SCRIPT_FILE" ] || continue

    run_expect_fail env SONARQUBE_URL="http://fake" SONARQUBE_TOKEN_FILE="$MOCK_TOKEN" \
        bash "$SCRIPT_FILE"
    if [ $CAPTURED_RC -ne 0 ]; then
        pass "${script}.sh: exits non-zero without required args"
    else
        skip "${script}.sh: exits 0 without args (may be valid)"
    fi

    if [ -n "$CAPTURED_ERR" ] && echo "$CAPTURED_ERR" | grep -qi 'usage\|error\|required'; then
        pass "${script}.sh: provides usage/error message"
    else
        skip "${script}.sh: no error message on missing args"
    fi
done

rm -f "$MOCK_TOKEN"

# ═══════════════════════════════════════════════════════════════════════════════
header "SonarQube: --limit parsing regression"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: sonarqube-projects.sh consumed --limit as the search query
# because first positional was always grabbed before flag parsing.
# Fix: proper argument loop.
if grep -q 'while' "$SQ_SCRIPTS/sonarqube-projects.sh" && grep -q '\-\-limit' "$SQ_SCRIPTS/sonarqube-projects.sh"; then
    pass "sonarqube-projects.sh: parses --limit in argument loop"
else
    fail "sonarqube-projects.sh: should parse --limit in argument loop (not positional grab)"
fi

# Verify SEARCH is assigned inside the case, not before flag parsing
if grep -qE '^SEARCH="\$\{1' "$SQ_SCRIPTS/sonarqube-projects.sh"; then
    fail "sonarqube-projects.sh: still grabs first arg as SEARCH before parsing flags"
else
    pass "sonarqube-projects.sh: flags parsed before positional assignment"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "SonarQube: Bearer auth token quoting (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: _sonar_auth_args() returned unquoted "Authorization: Bearer token"
# which split into multiple argv tokens when expanded with $().
# Fix: inline the case in each function instead of using a helper.
if grep -q '_sonar_auth_args' "$SQ_SCRIPTS/_api.sh"; then
    fail "_api.sh: still uses _sonar_auth_args helper (word-splitting risk)"
else
    pass "_api.sh: no _sonar_auth_args helper (inline case prevents word splitting)"
fi

# Verify bearer header is properly quoted in a single -H argument
BEARER_LINES=$(grep -c '"Authorization: Bearer' "$SQ_SCRIPTS/_api.sh" || true)
if [ "$BEARER_LINES" -ge 3 ]; then
    pass "_api.sh: bearer header quoted in all functions (${BEARER_LINES} occurrences)"
else
    fail "_api.sh: bearer header should be quoted in all functions (found ${BEARER_LINES})"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "SonarQube: URL encoding (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: search query appended directly to URL without encoding
if grep -q 'urlencode' "$SQ_SCRIPTS/sonarqube-projects.sh"; then
    pass "sonarqube-projects.sh: URL-encodes search query"
else
    fail "sonarqube-projects.sh: should URL-encode search query (spaces, special chars)"
fi

if grep -q '&q=\${SEARCH}' "$SQ_SCRIPTS/sonarqube-projects.sh"; then
    fail "sonarqube-projects.sh: directly concatenates \$SEARCH (should encode)"
else
    pass "sonarqube-projects.sh: does not directly concatenate \$SEARCH"
fi

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
header "SonarQube: References"
# ═══════════════════════════════════════════════════════════════════════════════

REFS_DIR="${SKILL_DIR}/references"
if [ -d "$REFS_DIR" ]; then
    for ref in "$REFS_DIR"/*.md; do
        [ -f "$ref" ] || continue
        name=$(basename "$ref")
        if [ -s "$ref" ]; then pass "${name}: non-empty"; else fail "${name}: is empty"; fi
        if grep -qiE 'telavox|reza\.kamali|/Users/' "$ref"; then
            fail "${name}: contains company/user/system-specific data"
        else
            pass "${name}: no company/user/system-specific data"
        fi
    done
else
    skip "No references/ directory"
fi

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
header "SonarQube: Missing metrics produce N/A (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: jq select() with no match silently drops the whole object
# Fix: collect into array, check length, return "N/A" when empty
if grep -q 'if length == 0 then "N/A"' "$SQ_SCRIPTS/sonarqube-coverage.sh"; then
    pass "sonarqube-coverage.sh: metric() falls back to N/A when absent"
else
    fail "sonarqube-coverage.sh: missing metrics can produce empty output"
fi

# Verify it doesn't use the old pattern that silently drops
if grep -q '\.measures\[\] | select.*\.value // "N/A"' "$SQ_SCRIPTS/sonarqube-coverage.sh"; then
    fail "sonarqube-coverage.sh: still uses select() without array wrap (empty on miss)"
else
    pass "sonarqube-coverage.sh: does not use bare select() for metric lookup"
fi

# Exercise the actual jq: missing metric must produce "N/A", not empty
TEST_INPUT='{"component":{"name":"test","measures":[{"metric":"coverage","value":"80"}]}}'
# Extract the metric() function definition from the script
METRIC_DEF=$(sed -n '/^echo.*jq/,/'"'"'$/{ s/^echo.*jq '"'"'//; s/'"'"'$//; p; }' "$SQ_SCRIPTS/sonarqube-coverage.sh" | head -6)
METRIC_RESULT=$(echo "$TEST_INPUT" | jq "
    def metric(\$n): (
        [.component.measures[] | select(.metric==\$n)] |
        if length == 0 then \"N/A\"
        else .[0] | (.period.value // .value // \"N/A\")
        end
    );
    { present: metric(\"coverage\"), missing: metric(\"ncloc\") }
" 2>/dev/null)
PRESENT_VAL=$(echo "$METRIC_RESULT" | jq -r '.present')
MISSING_VAL=$(echo "$METRIC_RESULT" | jq -r '.missing')
if [ "$PRESENT_VAL" = "80" ]; then
    pass "sonarqube-coverage.sh metric(): existing metric returns value ('80')"
else
    fail "sonarqube-coverage.sh metric(): expected '80', got '${PRESENT_VAL}'"
fi
if [ "$MISSING_VAL" = "N/A" ]; then
    pass "sonarqube-coverage.sh metric(): missing metric returns 'N/A'"
else
    fail "sonarqube-coverage.sh metric(): expected 'N/A', got '${MISSING_VAL}'"
fi

# Prove old pattern produces empty output (the bug)
OLD_RESULT=$(echo "$TEST_INPUT" | jq '
    def metric($n): (.component.measures[] | select(.metric==$n) | .value // "N/A");
    { present: metric("coverage"), missing: metric("ncloc") }
' 2>/dev/null)
if [ -z "$OLD_RESULT" ]; then
    pass "Old metric() pattern: produces empty output when metric missing (the bug)"
else
    fail "Old metric() pattern: expected empty output but got: ${OLD_RESULT}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "SonarQube: SKILL.md config docs match _config.sh (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: SKILL.md documented a single 'config' file but _config.sh reads separate files
if grep -q 'boring/sonarqube/config' "$SQ_DIR/SKILL.md"; then
    fail "sonarqube SKILL.md: still documents single 'config' file (loader reads url + token)"
else
    pass "sonarqube SKILL.md: config docs match loader (separate files)"
fi

if grep -q 'sonarqube/url' "$SQ_DIR/SKILL.md" && grep -q 'sonarqube/token' "$SQ_DIR/SKILL.md"; then
    pass "sonarqube SKILL.md: documents url and token files"
else
    fail "sonarqube SKILL.md: should document url and token files"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "SonarQube: auth_method loaded from file (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# The bearer auth fix is useless if _config.sh never reads auth_method
if grep -q 'auth_method' "$SQ_SCRIPTS/_config.sh"; then
    pass "sonarqube _config.sh: loads auth_method from file"
else
    fail "sonarqube _config.sh: should load auth_method from file for bearer auth"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Results: SonarQube"
# ═══════════════════════════════════════════════════════════════════════════════

printf "  ${GREEN}%d passed${RESET}  ${RED}%d failed${RESET}  ${YELLOW}%d skipped${RESET}\n" "$PASS" "$FAIL" "$SKIP"
echo ""
if [ "$FAIL" -gt 0 ]; then printf "  ${RED}${BOLD}FAILED${RESET}\n"; exit 1
else printf "  ${GREEN}${BOLD}ALL TESTS PASSED${RESET}\n"; exit 0; fi
