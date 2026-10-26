#!/bin/bash
# Test suite for the Jenkins skill
# Tests: argument validation, error messages, script structure
# RULE: Live tests are READ-ONLY. Never create, modify, or delete data in live systems.
# Read-only live tests run automatically when Jenkins is configured.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JENKINS_DIR="${SCRIPT_DIR}/../skills/jenkins"
JENKINS_SCRIPTS="${JENKINS_DIR}/scripts"

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
done

# ═══════════════════════════════════════════════════════════════════════════════
header "Jenkins: Argument validation"
# ═══════════════════════════════════════════════════════════════════════════════

# Scripts that require arguments should fail with descriptive errors.
# Credentials are set so _config.sh passes and each script reaches its own
# argument check. The curl stub refuses every call, so nothing leaves the machine.
# jenkins-list-jobs.sh is not listed: with no args it lists the root folder.
ARGS_MOCK_DIR=$(mktemp -d)
printf '#!/bin/bash\nexit 7\n' > "${ARGS_MOCK_DIR}/curl"
chmod +x "${ARGS_MOCK_DIR}/curl"

for script in jenkins-build-status jenkins-console jenkins-trigger jenkins-stages jenkins-test-failures jenkins-abort jenkins-build-history; do
    run_expect_fail env PATH="${ARGS_MOCK_DIR}:$PATH" \
        JENKINS_URL="http://mock" JENKINS_USER="x" JENKINS_TOKEN="fake" CURL_RETRIES=0 \
        bash "$JENKINS_SCRIPTS/${script}.sh"
    if [ $CAPTURED_RC -ne 0 ]; then
        pass "${script}.sh: exits non-zero without required args"
    else
        fail "${script}.sh: exits 0 without required args"
    fi

    if [ -n "$CAPTURED_ERR" ] && echo "$CAPTURED_ERR" | grep -qi 'usage\|error\|required'; then
        pass "${script}.sh: provides usage/error message"
    else
        fail "${script}.sh: no usage/error message on missing args"
    fi
done

rm -rf "$ARGS_MOCK_DIR"

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
header "Jenkins: trigger exit code without params (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: [[ ${#PARAMS[@]} -gt 0 ]] && echo "Parameters: ..." was the last
# command in the success branch. When no params were passed, [[ ]] was false,
# && short-circuited, and the expression returned exit 1. Since it was the last
# command, the script exited 1 despite successfully triggering the build.
# Fix: use if/then/fi instead of && to avoid leaking the exit code.

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
header "Jenkins: curl --globoff for URL safety (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: curl interprets [ ] { } in URLs as glob patterns and fails with
# exit code 3 (URL malformed), which _api.sh reports as HTTP 000. Jenkins tree
# queries use these characters heavily: tree=jobs[name,url,lastBuild[number]].
# Adding -g (--globoff) to all curl calls prevents this.

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
