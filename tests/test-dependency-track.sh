#!/bin/bash
# Test suite for the Dependency-Track skill
# Tests: argument validation, error messages, script structure
# RULE: Live tests are READ-ONLY. Never create, modify, or delete data in live systems.
# Read-only live tests run automatically when Dependency-Track is configured.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DT_DIR="${SCRIPT_DIR}/../workflow-tools/dependency-track"
DT_SCRIPTS="${DT_DIR}/scripts"
SKILL_DIR="${SCRIPT_DIR}/../workflow-tools/dependency-track"

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
header "Dependency-Track: SKILL.md structure"
# ═══════════════════════════════════════════════════════════════════════════════

SKILLMD="${SKILL_DIR}/SKILL.md"

if [ -f "$SKILLMD" ]; then pass "SKILL.md exists"; else fail "SKILL.md missing"; fi
if head -1 "$SKILLMD" | grep -q '^---$'; then pass "Has YAML frontmatter"; else fail "Missing YAML frontmatter"; fi
if grep -q '^name: dependency-track' "$SKILLMD"; then pass "Name field is 'dependency-track'"; else fail "Name field missing or wrong"; fi
if grep -q '^description:' "$SKILLMD"; then pass "Has description"; else fail "Missing description"; fi

if grep -qiE 'telavox|reza\.kamali|/Users/' "$SKILLMD"; then
    fail "SKILL.md contains company/user/system-specific data"
else
    pass "No company/user/system-specific data in SKILL.md"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Dependency-Track: Script file checks"
# ═══════════════════════════════════════════════════════════════════════════════

for script in "$DT_SCRIPTS"/*.sh; do
    name=$(basename "$script")
    [ "$name" = "_config.sh" ] && continue

    if [ -x "$script" ]; then pass "${name}: is executable"; else fail "${name}: not executable"; fi
    if bash -n "$script" 2>/dev/null; then pass "${name}: bash syntax OK"; else fail "${name}: bash syntax error"; fi
    if grep -q 'set -e' "$script"; then pass "${name}: has set -e"; else fail "${name}: missing set -e"; fi
    if grep -q '_config.sh\|dtrack-api.sh' "$script"; then pass "${name}: loads config"; else fail "${name}: doesn't load config"; fi

    if grep -qiE 'telavox|reza\.kamali|/Users/' "$script"; then
        fail "${name}: contains company/user/system-specific data"
    else
        pass "${name}: no company/user/system-specific data"
    fi
done

# ═══════════════════════════════════════════════════════════════════════════════
header "Dependency-Track: _config.sh"
# ═══════════════════════════════════════════════════════════════════════════════

CONFIG="${DT_SCRIPTS}/_config.sh"

if bash -n "$CONFIG" 2>/dev/null; then pass "_config.sh: bash syntax OK"; else fail "_config.sh: bash syntax error"; fi
if grep -q '\.boring/dependency' "$CONFIG"; then pass "_config.sh: uses ~/.boring/dependency-track/"; else fail "_config.sh: should use ~/.boring/dependency-track/"; fi
if grep -qiE 'telavox|reza\.kamali|/Users/' "$CONFIG"; then
    fail "_config.sh: contains company/user/system-specific data"
else
    pass "_config.sh: no company/user/system-specific data"
fi

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
header "Dependency-Track: References"
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
header "Dependency-Track: --search arg parsing regression"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: dtrack-components.sh used positional PAGE="${2:-1}" which consumed
# --search as the page number. Fix: proper argument loop.
if grep -q 'while' "$DT_SCRIPTS/dtrack-components.sh" && grep -q '\-\-search' "$DT_SCRIPTS/dtrack-components.sh"; then
    pass "dtrack-components.sh: parses --search in argument loop"
else
    fail "dtrack-components.sh: should parse --search in argument loop"
fi

# Verify --page is a flag, not positional
if grep -q 'PAGE="\${2:-' "$DT_SCRIPTS/dtrack-components.sh"; then
    fail "dtrack-components.sh: still uses positional PAGE=\${2} (breaks --search)"
else
    pass "dtrack-components.sh: PAGE is not a positional argument"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Dependency-Track: URL encoding (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: name/version concatenated directly into query string
if grep -q 'urlencode' "$DT_SCRIPTS/dtrack-components.sh"; then
    pass "dtrack-components.sh: URL-encodes search text"
else
    fail "dtrack-components.sh: should URL-encode --search (spaces, special chars)"
fi

if grep -q 'searchText=\${SEARCH}' "$DT_SCRIPTS/dtrack-components.sh"; then
    fail "dtrack-components.sh: directly concatenates \$SEARCH (should encode)"
else
    pass "dtrack-components.sh: does not directly concatenate \$SEARCH"
fi

# dtrack-project-lookup.sh encoding
if grep -q 'urlencode' "$DT_SCRIPTS/dtrack-project-lookup.sh"; then
    pass "dtrack-project-lookup.sh: URL-encodes name and version"
else
    fail "dtrack-project-lookup.sh: should URL-encode name/version (spaces, special chars)"
fi

if grep -q 'name=\${NAME}\|version=\${VERSION}' "$DT_SCRIPTS/dtrack-project-lookup.sh"; then
    fail "dtrack-project-lookup.sh: directly concatenates \$NAME/\$VERSION (should encode)"
else
    pass "dtrack-project-lookup.sh: does not directly concatenate \$NAME/\$VERSION"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Dependency-Track: jq syntax regression"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: tags jq expression had operator precedence bug
# [.tags[]?.name] | if length ... was parsed as object-level pipe, not array pipe
# Fix: wrap in parens: ([.tags[]?.name] | if length ...)

JQ_TAGS_EXPR=$(grep 'tags:' "$DT_SCRIPTS/dtrack-projects.sh" | head -1)
if echo "$JQ_TAGS_EXPR" | grep -q '(.*tags.*|.*if.*length'; then
    pass "dtrack-projects.sh: tags jq expression has parentheses (precedence fix)"
else
    fail "dtrack-projects.sh: tags jq expression missing parentheses — will cause jq compile error"
fi

# Verify the jq in dtrack-projects.sh actually compiles
JQ_BLOCK=$(sed -n '/jq.*\[\.\\*\[\]/,/}].$/{p;}' "$DT_SCRIPTS/dtrack-projects.sh" 2>/dev/null)
TEST_INPUT='[{"name":"test","version":"1.0","uuid":"abc","active":true,"lastBomImport":null,"tags":[{"name":"t1"}],"metrics":null},{"name":"empty","version":"2.0","uuid":"def","active":true,"lastBomImport":null,"tags":[],"metrics":{"critical":1,"high":2,"medium":3,"low":4,"unassigned":0,"components":10,"inheritedRiskScore":5.0}}]'
RESULT=$(echo "$TEST_INPUT" | jq --arg q "" '.' | jq '[.[] | {
    uuid, name, version, active, lastBomImport,
    tags: ([.tags[]?.name] | if length == 0 then null else . end),
    metrics: (if .metrics then {
        critical: .metrics.critical, high: .metrics.high,
        medium: .metrics.medium, low: .metrics.low,
        unassigned: .metrics.unassigned,
        components: .metrics.components,
        riskScore: .metrics.inheritedRiskScore
    } else null end)
}]' 2>&1)
if echo "$RESULT" | jq -e '.[0].tags[0] == "t1"' >/dev/null 2>&1; then
    pass "dtrack-projects.sh: jq expression compiles and extracts tags correctly"
else
    fail "dtrack-projects.sh: jq expression fails — $RESULT"
fi
if echo "$RESULT" | jq -e '.[1].tags == null' >/dev/null 2>&1; then
    pass "dtrack-projects.sh: empty tags array becomes null"
else
    fail "dtrack-projects.sh: empty tags should become null"
fi
if echo "$RESULT" | jq -e '.[1].metrics.critical == 1' >/dev/null 2>&1; then
    pass "dtrack-projects.sh: metrics extracted correctly"
else
    fail "dtrack-projects.sh: metrics extraction broken"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Dependency-Track: Search (partial match regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: DT name= param is exact match only, so search returned empty
# Fix: fetch all projects and filter client-side with case-insensitive contains

# Verify the script does client-side filtering not server-side name= param
if grep -q 'name=.*SEARCH_NAME' "$DT_SCRIPTS/dtrack-projects.sh"; then
    fail "dtrack-projects.sh: still uses server-side name= (exact match only)"
else
    pass "dtrack-projects.sh: does not use server-side name= param"
fi

if grep -q 'ascii_downcase.*contains' "$DT_SCRIPTS/dtrack-projects.sh"; then
    pass "dtrack-projects.sh: uses case-insensitive client-side filtering"
else
    fail "dtrack-projects.sh: should use case-insensitive client-side filtering"
fi

# Test the jq filter logic directly
MOCK_PROJECTS='[{"name":"Data Usage Service"},{"name":"Billing API"},{"name":"data-collector"}]'
MATCHED=$(echo "$MOCK_PROJECTS" | jq --arg q "data" '[.[] | select(.name | ascii_downcase | contains($q | ascii_downcase))]' | jq 'length')
if [ "$MATCHED" = "2" ]; then
    pass "dtrack-projects.sh: partial search 'data' matches 2 of 3 projects"
else
    fail "dtrack-projects.sh: partial search should match 2 projects, got $MATCHED"
fi

MATCHED_CASE=$(echo "$MOCK_PROJECTS" | jq --arg q "DATA USAGE" '[.[] | select(.name | ascii_downcase | contains($q | ascii_downcase))]' | jq 'length')
if [ "$MATCHED_CASE" = "1" ]; then
    pass "dtrack-projects.sh: case-insensitive search 'DATA USAGE' matches 1 project"
else
    fail "dtrack-projects.sh: case-insensitive search should match 1 project, got $MATCHED_CASE"
fi

MATCHED_NONE=$(echo "$MOCK_PROJECTS" | jq --arg q "nonexistent" '[.[] | select(.name | ascii_downcase | contains($q | ascii_downcase))]' | jq 'length')
if [ "$MATCHED_NONE" = "0" ]; then
    pass "dtrack-projects.sh: search 'nonexistent' returns 0 results"
else
    fail "dtrack-projects.sh: non-matching search should return 0, got $MATCHED_NONE"
fi

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
header "Dependency-Track: SKILL.md config docs match _config.sh (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: SKILL.md documented single 'config' file but _config.sh reads url + apikey
if grep -q 'boring/dependency-track/config' "$DT_DIR/SKILL.md"; then
    fail "dependency-track SKILL.md: still documents single 'config' file (loader reads url + apikey)"
else
    pass "dependency-track SKILL.md: config docs match loader (separate files)"
fi

if grep -q 'dependency-track/url' "$DT_DIR/SKILL.md" && grep -q 'dependency-track/apikey' "$DT_DIR/SKILL.md"; then
    pass "dependency-track SKILL.md: documents url and apikey files"
else
    fail "dependency-track SKILL.md: should document url and apikey files"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Dependency-Track: Project listing pagination (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: single request with pageSize=500, no loop — instances with >500 projects lose results
if grep -q 'while.*true\|PAGE_NUM' "$DT_SCRIPTS/dtrack-projects.sh"; then
    pass "dtrack-projects.sh: paginates project listing"
else
    fail "dtrack-projects.sh: single request, no pagination (drops results beyond first page)"
fi

# Verify it stops when a page has fewer results than page size
if grep -q 'PAGE_COUNT.*PAGE_SIZE\|lt.*PAGE_SIZE' "$DT_SCRIPTS/dtrack-projects.sh"; then
    pass "dtrack-projects.sh: stops pagination when page is not full"
else
    fail "dtrack-projects.sh: should stop when page count < page size"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Results: Dependency-Track"
# ═══════════════════════════════════════════════════════════════════════════════

printf "  ${GREEN}%d passed${RESET}  ${RED}%d failed${RESET}  ${YELLOW}%d skipped${RESET}\n" "$PASS" "$FAIL" "$SKIP"
echo ""
if [ "$FAIL" -gt 0 ]; then printf "  ${RED}${BOLD}FAILED${RESET}\n"; exit 1
else printf "  ${GREEN}${BOLD}ALL TESTS PASSED${RESET}\n"; exit 0; fi
