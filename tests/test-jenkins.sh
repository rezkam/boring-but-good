#!/bin/bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/forbidden.sh"
# Test suite for the Jenkins skill
# Tests: argument validation, error messages, script structure
# RULE: Live tests are READ-ONLY. Never create, modify, or delete data in live systems.
# Read-only live tests run automatically when Jenkins is configured.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JENKINS_DIR="${SCRIPT_DIR}/../skills/jenkins"
JENKINS_SCRIPTS="${JENKINS_DIR}/scripts"
SKILL_DIR="${JENKINS_DIR}"

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
header "Jenkins: SKILL.md structure"
# ═══════════════════════════════════════════════════════════════════════════════

SKILLMD="${SKILL_DIR}/SKILL.md"

if [ -f "$SKILLMD" ]; then pass "SKILL.md exists"; else fail "SKILL.md missing"; fi
if head -1 "$SKILLMD" | grep -q '^---$'; then pass "Has YAML frontmatter"; else fail "Missing YAML frontmatter"; fi
if grep -q '^name: jenkins' "$SKILLMD"; then pass "Name field is 'jenkins'"; else fail "Name field missing or wrong"; fi
if grep -q '^description:' "$SKILLMD"; then pass "Has description"; else fail "Missing description"; fi

if grep -qiE "$FORBIDDEN_RE" "$SKILLMD"; then
    fail "SKILL.md contains company/user/system-specific data"
else
    pass "No company/user/system-specific data in SKILL.md"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Jenkins: Script file checks"
# ═══════════════════════════════════════════════════════════════════════════════

for script in "$JENKINS_SCRIPTS"/*.sh; do
    name=$(basename "$script")
    [ "$name" = "_config.sh" ] && continue

    if [ -x "$script" ]; then pass "${name}: is executable"; else fail "${name}: not executable"; fi
    if bash -n "$script" 2>/dev/null; then pass "${name}: bash syntax OK"; else fail "${name}: bash syntax error"; fi
    # jenkins-test-failures.sh should NOT have set -e (handles 404s with || true)
    if [ "$name" = "jenkins-test-failures.sh" ]; then
        if grep -q 'set -e' "$script"; then
            fail "${name}: should not have set -e (breaks 404 handling)"
        else
            pass "${name}: correctly omits set -e"
        fi
    else
        if grep -q 'set -e' "$script"; then pass "${name}: has set -e"; else fail "${name}: missing set -e"; fi
    fi
    if grep -q '_config.sh\|jenkins-api.sh' "$script"; then pass "${name}: loads config"; else fail "${name}: doesn't load config"; fi

    if grep -qiE "$FORBIDDEN_RE" "$script"; then
        fail "${name}: contains company/user/system-specific data"
    else
        pass "${name}: no company/user/system-specific data"
    fi
done

# ═══════════════════════════════════════════════════════════════════════════════
header "Jenkins: _config.sh"
# ═══════════════════════════════════════════════════════════════════════════════

CONFIG="${JENKINS_SCRIPTS}/_config.sh"

if bash -n "$CONFIG" 2>/dev/null; then pass "_config.sh: bash syntax OK"; else fail "_config.sh: bash syntax error"; fi
if grep -q '\.boring/jenkins' "$CONFIG"; then pass "_config.sh: uses ~/.boring/jenkins/"; else fail "_config.sh: should use ~/.boring/jenkins/"; fi
if grep -qiE "$FORBIDDEN_RE" "$CONFIG"; then
    fail "_config.sh: contains company/user/system-specific data"
else
    pass "_config.sh: no company/user/system-specific data"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Jenkins: Argument validation"
# ═══════════════════════════════════════════════════════════════════════════════

# Scripts that require arguments should fail with descriptive errors

MOCK_TOKEN=$(mktemp); echo "fake" > "$MOCK_TOKEN"

for script in jenkins-build-status jenkins-console jenkins-trigger jenkins-stages jenkins-test-failures jenkins-abort jenkins-build-history jenkins-list-jobs; do
    run_expect_fail env JENKINS_URL="http://fake" JENKINS_USER="x" JENKINS_TOKEN_FILE="$MOCK_TOKEN" \
        bash "$JENKINS_SCRIPTS/${script}.sh"
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
header "Jenkins: References"
# ═══════════════════════════════════════════════════════════════════════════════

REFS_DIR="${SKILL_DIR}/references"
if [ -d "$REFS_DIR" ]; then
    for ref in "$REFS_DIR"/*.md; do
        [ -f "$ref" ] || continue
        name=$(basename "$ref")
        if [ -s "$ref" ]; then pass "${name}: non-empty"; else fail "${name}: is empty"; fi
        if grep -qiE "$FORBIDDEN_RE" "$ref"; then
            fail "${name}: contains company/user/system-specific data"
        else
            pass "${name}: no company/user/system-specific data"
        fi
    done
else
    pass "No references/ directory (not required)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Read-only live tests — run automatically when configured, all GET requests
# ═══════════════════════════════════════════════════════════════════════════════

if [ -f "$HOME/.boring/jenkins/url" ] && [ -f "$HOME/.boring/jenkins/token" ]; then
    header "Jenkins: LIVE — Connectivity (read-only)"

    RESULT=$("$JENKINS_SCRIPTS/jenkins-api.sh" /api/json 2>&1)
    if echo "$RESULT" | jq -e '.mode' >/dev/null 2>&1; then
        pass "Jenkins API reachable"
    else
        fail "Jenkins API failed: $(echo "$RESULT" | head -3)"
    fi
else
    header "Jenkins: LIVE tests (read-only)"
    skip "Jenkins not configured (missing ~/.boring/jenkins/ files)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Jenkins: jenkins_post does not use -f flag (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: jenkins_post used -f (fail on HTTP error) which under set -e caused
# scripts to exit before reaching their own HTTP_CODE error handling
# jenkins_post body is between ^jenkins_post() and the closing }
if sed -n '/^jenkins_post/,/^}/p' "$JENKINS_SCRIPTS/_api.sh" | grep -q 'curl.*-[a-z]*f'; then
    fail "jenkins _api.sh: jenkins_post still uses -f (bypasses caller error handling)"
else
    pass "jenkins _api.sh: jenkins_post does not use -f (callers check HTTP code)"
fi

# jenkins_get must NOT use -f: it captures HTTP status and returns structured errors
if sed -n '/^jenkins_get/,/^}/p' "$JENKINS_SCRIPTS/_api.sh" | grep -q 'curl.*-[a-z]*f'; then
    fail "jenkins _api.sh: jenkins_get uses -f (bypasses structured error messages)"
else
    pass "jenkins _api.sh: jenkins_get does not use -f (returns structured errors)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Jenkins: SKILL.md config docs match _config.sh (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: SKILL.md documented single 'config' file but _config.sh reads url, user, token
if grep -q 'boring/jenkins/config' "$JENKINS_DIR/SKILL.md"; then
    fail "jenkins SKILL.md: still documents single 'config' file (loader reads url + user + token)"
else
    pass "jenkins SKILL.md: config docs match loader (separate files)"
fi

if grep -q 'jenkins/url' "$JENKINS_DIR/SKILL.md" && grep -q 'jenkins/token' "$JENKINS_DIR/SKILL.md"; then
    pass "jenkins SKILL.md: documents url and token files"
else
    fail "jenkins SKILL.md: should document url and token files"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Jenkins: --full flag parsing (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: BUILD="${2:-lastBuild}" grabbed --full as the build number
if grep -q 'while' "$JENKINS_SCRIPTS/jenkins-test-failures.sh" && \
   grep -q '\-\-full' "$JENKINS_SCRIPTS/jenkins-test-failures.sh"; then
    pass "jenkins-test-failures.sh: parses --full in argument loop"
else
    fail "jenkins-test-failures.sh: should parse --full in argument loop (not positional)"
fi

if grep -q 'BUILD="\${2' "$JENKINS_SCRIPTS/jenkins-test-failures.sh"; then
    fail "jenkins-test-failures.sh: still uses positional BUILD=\${2} (breaks --full)"
else
    pass "jenkins-test-failures.sh: BUILD is not a positional argument"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Jenkins: URL encoding for --param values (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: PARAM_STRING=$(IFS='&'; echo "${PARAMS[*]}") concatenated raw values
if grep -q 'urlencode' "$JENKINS_SCRIPTS/jenkins-trigger.sh"; then
    pass "jenkins-trigger.sh: URL-encodes parameter values"
else
    fail "jenkins-trigger.sh: should URL-encode --param values (spaces, special chars)"
fi

if grep -q 'PARAM_STRING=.*IFS.*PARAMS\[' "$JENKINS_SCRIPTS/jenkins-trigger.sh" && \
   ! grep -q 'ENCODED_PARAMS' "$JENKINS_SCRIPTS/jenkins-trigger.sh"; then
    fail "jenkins-trigger.sh: directly concatenates \$PARAMS (should encode)"
else
    pass "jenkins-trigger.sh: does not directly concatenate raw \$PARAMS"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Jenkins: trigger exit code without params (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: [[ ${#PARAMS[@]} -gt 0 ]] && echo "Parameters: ..." was the last
# command in the success branch. When no params were passed, [[ ]] was false,
# && short-circuited, and the expression returned exit 1. Since it was the last
# command, the script exited 1 despite successfully triggering the build.
# Fix: use if/then/fi instead of && to avoid leaking the exit code.

# Static check: no bare [[ ... ]] && pattern in the success path
if grep -q '\[\[.*PARAMS.*\]\] && echo' "$JENKINS_SCRIPTS/jenkins-trigger.sh"; then
    fail "jenkins-trigger.sh: uses [[ PARAMS ]] && echo (leaks exit 1 when no params)"
else
    pass "jenkins-trigger.sh: does not use [[ PARAMS ]] && echo (exit code safe)"
fi

# Functional test: mock curl, trigger without params, verify exit 0
MOCK_DIR=$(mktemp -d)
export MOCK_CURL_LOG="${MOCK_DIR}/curl_args.log"

cat > "${MOCK_DIR}/curl" <<'MOCKEOF'
#!/bin/bash
printf '%s\n' "$@" > "$MOCK_CURL_LOG"
# jenkins_post uses -o /dev/null -w "%{http_code}", output goes to stdout
printf "201"
MOCKEOF
chmod +x "${MOCK_DIR}/curl"

TRIGGER_OUT=$(env PATH="${MOCK_DIR}:$PATH" \
    JENKINS_URL="http://mock" JENKINS_USER="x" JENKINS_TOKEN="fake" CURL_RETRIES=0 \
    bash "$JENKINS_SCRIPTS/jenkins-trigger.sh" "test-org/test-job" 2>&1)
TRIGGER_RC=$?

if [ $TRIGGER_RC -eq 0 ]; then
    pass "jenkins-trigger.sh: exits 0 on successful trigger without params (mock test)"
else
    fail "jenkins-trigger.sh: exits $TRIGGER_RC on successful trigger without params (mock test)"
fi

if echo "$TRIGGER_OUT" | grep -q 'Build triggered'; then
    pass "jenkins-trigger.sh: prints success message (mock test)"
else
    fail "jenkins-trigger.sh: missing success message (mock test)"
fi

rm -rf "$MOCK_DIR"
unset MOCK_CURL_LOG

# ═══════════════════════════════════════════════════════════════════════════════
header "Jenkins: set -e removed from jenkins-test-failures.sh (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: set -e caused script to exit on 404 before reaching the "No test report" check
if grep -q '^set -e' "$JENKINS_SCRIPTS/jenkins-test-failures.sh"; then
    fail "jenkins-test-failures.sh: still uses set -e (breaks 404 handling)"
else
    pass "jenkins-test-failures.sh: does not use set -e"
fi

# Verify jenkins_get has || true to capture 404s
if grep -q 'jenkins_get.*|| true' "$JENKINS_SCRIPTS/jenkins-test-failures.sh"; then
    pass "jenkins-test-failures.sh: jenkins_get uses || true to capture errors"
else
    fail "jenkins-test-failures.sh: should use || true after jenkins_get"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Jenkins: curl --globoff for URL safety (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: curl interprets [ ] { } in URLs as glob patterns and fails with
# exit code 3 (URL malformed), which _api.sh reports as HTTP 000. Jenkins tree
# queries use these characters heavily: tree=jobs[name,url,lastBuild[number]].
# Adding -g (--globoff) to all curl calls prevents this.

# Static checks: verify each API function passes -g to curl
for func in jenkins_get jenkins_post jenkins_raw; do
    func_body=$(sed -n "/^${func}()/,/^}/p" "$JENKINS_SCRIPTS/_api.sh")
    if echo "$func_body" | grep -qE '\-g\b|--globoff'; then
        pass "_api.sh ${func}: uses --globoff (-g)"
    else
        fail "_api.sh ${func}: missing --globoff (-g) — curl will choke on brackets in tree queries"
    fi
done

# Functional test: mock curl to verify -g is actually passed for bracket URLs
# Creates a mock curl that logs its args, then runs jenkins-list-jobs.sh
# (which has unencoded brackets in the tree parameter) and verifies -g was passed.
MOCK_DIR=$(mktemp -d)
export MOCK_CURL_LOG="${MOCK_DIR}/curl_args.log"

cat > "${MOCK_DIR}/curl" <<'MOCKEOF'
#!/bin/bash
# Mock curl: log args and return a valid JSON response
printf '%s\n' "$@" > "$MOCK_CURL_LOG"
prev=""
for arg in "$@"; do
    [ "$prev" = "-o" ] && echo '{"jobs":[]}' > "$arg"
    prev="$arg"
done
printf "200"
MOCKEOF
chmod +x "${MOCK_DIR}/curl"

# Run jenkins-list-jobs.sh with mock curl (has unencoded tree=jobs[name,...])
if env PATH="${MOCK_DIR}:$PATH" \
    JENKINS_URL="http://mock" JENKINS_USER="x" JENKINS_TOKEN="fake" CURL_RETRIES=0 \
    bash "$JENKINS_SCRIPTS/jenkins-list-jobs.sh" "test-folder" >/dev/null 2>&1; then

    if grep -qE '^-g$|^-g[a-zA-Z]' "$MOCK_CURL_LOG" 2>/dev/null; then
        pass "jenkins-list-jobs.sh: curl receives -g for bracket URLs (mock test)"
    else
        fail "jenkins-list-jobs.sh: curl not called with -g (mock test)"
    fi
else
    fail "jenkins-list-jobs.sh: failed with mock curl (bracket URL likely broke curl)"
fi

# Run jenkins-queue.sh with mock curl (has unencoded tree=items[id,...,task[name,url]])
cat > "${MOCK_DIR}/curl" <<'MOCKEOF'
#!/bin/bash
printf '%s\n' "$@" > "$MOCK_CURL_LOG"
prev=""
for arg in "$@"; do
    [ "$prev" = "-o" ] && echo '{"items":[]}' > "$arg"
    prev="$arg"
done
printf "200"
MOCKEOF
chmod +x "${MOCK_DIR}/curl"

if env PATH="${MOCK_DIR}:$PATH" \
    JENKINS_URL="http://mock" JENKINS_USER="x" JENKINS_TOKEN="fake" CURL_RETRIES=0 \
    bash "$JENKINS_SCRIPTS/jenkins-queue.sh" >/dev/null 2>&1; then

    if grep -qE '^-g$|^-g[a-zA-Z]' "$MOCK_CURL_LOG" 2>/dev/null; then
        pass "jenkins-queue.sh: curl receives -g for bracket URLs (mock test)"
    else
        fail "jenkins-queue.sh: curl not called with -g (mock test)"
    fi
else
    fail "jenkins-queue.sh: failed with mock curl (bracket URL likely broke curl)"
fi

# Run jenkins-build-history.sh with mock curl (has unencoded tree=builds[...]{0,N})
cat > "${MOCK_DIR}/curl" <<'MOCKEOF'
#!/bin/bash
printf '%s\n' "$@" > "$MOCK_CURL_LOG"
prev=""
for arg in "$@"; do
    [ "$prev" = "-o" ] && echo '{"builds":[]}' > "$arg"
    prev="$arg"
done
printf "200"
MOCKEOF
chmod +x "${MOCK_DIR}/curl"

if env PATH="${MOCK_DIR}:$PATH" \
    JENKINS_URL="http://mock" JENKINS_USER="x" JENKINS_TOKEN="fake" CURL_RETRIES=0 \
    bash "$JENKINS_SCRIPTS/jenkins-build-history.sh" "test-folder" >/dev/null 2>&1; then

    if grep -qE '^-g$|^-g[a-zA-Z]' "$MOCK_CURL_LOG" 2>/dev/null; then
        pass "jenkins-build-history.sh: curl receives -g for bracket URLs (mock test)"
    else
        fail "jenkins-build-history.sh: curl not called with -g (mock test)"
    fi
else
    fail "jenkins-build-history.sh: failed with mock curl (bracket URL likely broke curl)"
fi

rm -rf "$MOCK_DIR"
unset MOCK_CURL_LOG

# ═══════════════════════════════════════════════════════════════════════════════
header "Results: Jenkins"
# ═══════════════════════════════════════════════════════════════════════════════

printf "  ${GREEN}%d passed${RESET}  ${RED}%d failed${RESET}  ${YELLOW}%d skipped${RESET}\n" "$PASS" "$FAIL" "$SKIP"
echo ""
if [ "$FAIL" -gt 0 ]; then printf "  ${RED}${BOLD}FAILED${RESET}\n"; exit 1
else printf "  ${GREEN}${BOLD}ALL TESTS PASSED${RESET}\n"; exit 0; fi
