#!/bin/bash
# Test suite for the Jira skill
# Tests: argument validation, error messages, output parsing, failure modes
# RULE: Live tests are READ-ONLY. Never create, modify, or delete data in live systems.
# Read-only live tests run automatically when Jira is configured.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JIRA_SCRIPTS="${SCRIPT_DIR}/../skills/jira/scripts"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
PASS=0; FAIL=0; SKIP=0


pass() { PASS=$((PASS + 1)); printf "  ${GREEN}OK${RESET}   %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${RESET} %s\n" "$1"; [ -n "$2" ] && printf "    ${DIM}%s${RESET}\n" "$2"; }
skip() { SKIP=$((SKIP + 1)); printf "  ${YELLOW}SKIP${RESET} %s ${DIM}(skipped)${RESET}\n" "$1"; }
header() { echo ""; printf "${BOLD}━━━ %s ━━━${RESET}\n" "$1"; }

# ── Helper: run script expecting failure, capture stderr ────────────────────
# Returns stderr in $CAPTURED_ERR, exit code in $CAPTURED_RC
run_expect_fail() {
    local tmp_err
    tmp_err=$(mktemp)
    "$@" >/dev/null 2>"$tmp_err"
    CAPTURED_RC=$?
    CAPTURED_ERR=$(cat "$tmp_err")
    rm -f "$tmp_err"
}

# ── Helper: check stderr contains a string ──────────────────────────────────
assert_err_contains() {
    local label="$1" needle="$2"
    if echo "$CAPTURED_ERR" | grep -qi "$needle"; then
        pass "$label"
    else
        fail "$label" "Expected stderr to contain: $needle"
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
header "Jira: Script file checks"
# ═══════════════════════════════════════════════════════════════════════════════

for script in "$JIRA_SCRIPTS"/*.sh; do
    name=$(basename "$script")
    [ "$name" = "_config.sh" ] && continue

    # Executable
    if [ -x "$script" ]; then
        pass "${name}: is executable"
    else
        fail "${name}: not executable"
    fi

    # Bash syntax
    if bash -n "$script" 2>/dev/null; then
        pass "${name}: bash syntax OK"
    else
        fail "${name}: bash syntax error"
    fi

    # Zsh syntax
    if zsh -n "$script" 2>/dev/null; then
        pass "${name}: zsh syntax OK"
    else
        fail "${name}: zsh syntax error"
    fi
done

# ═══════════════════════════════════════════════════════════════════════════════
header "Jira: macOS SSH Keychain fallback"
# ═══════════════════════════════════════════════════════════════════════════════

_AUTH_MOCK_DIR=$(mktemp -d)
_AUTH_MOCK_HOME=$(mktemp -d)
_AUTH_JIRA_LOG="${_AUTH_MOCK_DIR}/jira.log"
_AUTH_SECURITY_LOG="${_AUTH_MOCK_DIR}/security.log"
mkdir -p "$_AUTH_MOCK_HOME/.jira.d" "$_AUTH_MOCK_HOME/Library/Keychains"
cat > "$_AUTH_MOCK_HOME/.jira.d/config.yml" << 'EOF'
endpoint: https://example.atlassian.net
user: agent@example.com
password-source: keyring
EOF

cat > "$_AUTH_MOCK_DIR/uname" << 'EOF'
#!/bin/bash
echo Darwin
EOF

cat > "$_AUTH_MOCK_DIR/jira" << 'EOF'
#!/bin/bash
printf 'token=%s\nargs=%s\n' "${JIRA_API_TOKEN:-}" "$*" > "$AUTH_JIRA_LOG"
EOF

cat > "$_AUTH_MOCK_DIR/security" << 'EOF'
#!/bin/bash
printf '%s\n' "$*" >> "$AUTH_SECURITY_LOG"
case "${1:-}" in
    login-keychain)
        printf '    "%s/Library/Keychains/login.keychain-db"\n' "$HOME"
        exit 0
        ;;
    find-generic-password)
        case " $* " in
            *" $HOME/Library/Keychains/login.keychain-db "*)
                case " $* " in
                    *" -w "*)
                        [ "${MOCK_SECURITY_MODE:-readable}" = "locked" ] && exit 36
                        echo mock-jira-token
                        exit 0
                        ;;
                    *) exit 0 ;;
                esac
                ;;
            *) exit 44 ;;
        esac
        ;;
esac
exit 1
EOF
chmod +x "$_AUTH_MOCK_DIR/uname" "$_AUTH_MOCK_DIR/jira" "$_AUTH_MOCK_DIR/security"

_AUTH_ERR="${_AUTH_MOCK_DIR}/auth.err"
env HOME="$_AUTH_MOCK_HOME" PATH="$_AUTH_MOCK_DIR:$PATH" \
    JIRA_API_TOKEN= JIRA_SECURITY_BIN="$_AUTH_MOCK_DIR/security" \
    AUTH_JIRA_LOG="$_AUTH_JIRA_LOG" AUTH_SECURITY_LOG="$_AUTH_SECURITY_LOG" \
    MOCK_SECURITY_MODE=readable \
    /bin/bash -c '. "$1"; jira request -M GET /rest/api/3/myself' \
    _ "$JIRA_SCRIPTS/_config.sh" >/dev/null 2>"$_AUTH_ERR"
_AUTH_RC=$?

if [ "$_AUTH_RC" -eq 0 ] && grep -q '^token=mock-jira-token$' "$_AUTH_JIRA_LOG"; then
    pass "_config.sh: injects login-keychain token into go-jira under SSH"
else
    fail "_config.sh: did not inject explicit login-keychain token" "$(cat "$_AUTH_ERR")"
fi

if grep -q "$_AUTH_MOCK_HOME/Library/Keychains/login.keychain-db" "$_AUTH_SECURITY_LOG"; then
    pass "_config.sh: queries the explicit user login keychain"
else
    fail "_config.sh: should query login.keychain explicitly"
fi

rm -f "$_AUTH_JIRA_LOG" "$_AUTH_ERR"
env HOME="$_AUTH_MOCK_HOME" PATH="$_AUTH_MOCK_DIR:$PATH" \
    JIRA_API_TOKEN= JIRA_SECURITY_BIN="$_AUTH_MOCK_DIR/security" \
    AUTH_JIRA_LOG="$_AUTH_JIRA_LOG" AUTH_SECURITY_LOG="$_AUTH_SECURITY_LOG" \
    MOCK_SECURITY_MODE=locked \
    /bin/bash -c '. "$1"; jira request -M GET /rest/api/3/myself' \
    _ "$JIRA_SCRIPTS/_config.sh" >/dev/null 2>"$_AUTH_ERR"
_AUTH_RC=$?

if [ "$_AUTH_RC" -ne 0 ] && grep -qi 'security unlock-keychain' "$_AUTH_ERR"; then
    pass "_config.sh: locked keychain failure gives an actionable unlock command"
else
    fail "_config.sh: locked keychain failure is not actionable" "$(cat "$_AUTH_ERR")"
fi

if [ ! -f "$_AUTH_JIRA_LOG" ]; then
    pass "_config.sh: does not invoke go-jira when the token is inaccessible"
else
    fail "_config.sh: should not let go-jira fall through to an EOF prompt"
fi

rm -rf "$_AUTH_MOCK_DIR" "$_AUTH_MOCK_HOME"

# ═══════════════════════════════════════════════════════════════════════════════
header "Jira: Error message quality"
# ═══════════════════════════════════════════════════════════════════════════════

# Every error message should contain: what went wrong + how to fix it
# We test by checking error messages contain actionable guidance

# ── Mock environment for argument validation tests ──────────────────────────
# go-jira may not be installed on CI/dev machines. Create a minimal stub so
# scripts can pass _config.sh and reach their OWN argument validation code.
# The stub jira binary does nothing — it only needs to exist in PATH.
_JIRA_MOCK_DIR=$(mktemp -d)
_JIRA_MOCK_HOME=$(mktemp -d)
mkdir -p "$_JIRA_MOCK_HOME/.jira.d"
printf '%s\n' "endpoint: https://mock.atlassian.net" > "$_JIRA_MOCK_HOME/.jira.d/config.yml"
printf '#!/bin/bash\nexit 1\n' > "$_JIRA_MOCK_DIR/jira"
chmod +x "$_JIRA_MOCK_DIR/jira"

jira_run_expect_fail() {
    run_expect_fail env HOME="$_JIRA_MOCK_HOME" PATH="$_JIRA_MOCK_DIR:$PATH" "$@"
}
# ────────────────────────────────────────────────────────────────────────────

# -- jira-create.sh: missing --type
jira_run_expect_fail "$JIRA_SCRIPTS/jira-create.sh"
if [ $CAPTURED_RC -ne 0 ]; then
    pass "jira-create.sh: exits non-zero with no args"
else
    fail "jira-create.sh: should exit non-zero with no args"
fi
assert_err_contains "jira-create.sh no-args: mentions --type" "type"
assert_err_contains "jira-create.sh no-args: shows example" "example\|Example"

# -- jira-create.sh: missing --summary
jira_run_expect_fail "$JIRA_SCRIPTS/jira-create.sh" --type Bug
assert_err_contains "jira-create.sh no-summary: mentions --summary" "summary"
assert_err_contains "jira-create.sh no-summary: shows example" "example\|Example"

# -- jira-view.sh: no args
jira_run_expect_fail "$JIRA_SCRIPTS/jira-view.sh"
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-view.sh: exits non-zero with no args"; else fail "jira-view.sh: should exit non-zero"; fi
assert_err_contains "jira-view.sh no-args: mentions issue key" "issue.key\|issue-key\|PROJ-123"

# -- jira-comment.sh: no args
jira_run_expect_fail "$JIRA_SCRIPTS/jira-comment.sh"
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-comment.sh: exits non-zero with no args"; else fail "jira-comment.sh: should exit non-zero"; fi
assert_err_contains "jira-comment.sh no-args: shows usage" "Usage\|usage"

# -- jira-comment.sh: missing comment text
jira_run_expect_fail "$JIRA_SCRIPTS/jira-comment.sh" PROJ-123
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-comment.sh: exits non-zero with only key"; else fail "jira-comment.sh: should require comment text"; fi

# -- jira-transition.sh: no args
jira_run_expect_fail "$JIRA_SCRIPTS/jira-transition.sh"
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-transition.sh: exits non-zero with no args"; else fail "jira-transition.sh: should exit non-zero"; fi
assert_err_contains "jira-transition.sh no-args: suggests --list" "list"

# -- jira-assign.sh: no args
jira_run_expect_fail "$JIRA_SCRIPTS/jira-assign.sh"
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-assign.sh: exits non-zero with no args"; else fail "jira-assign.sh: should exit non-zero"; fi
assert_err_contains "jira-assign.sh no-args: mentions --unassign" "unassign"

# -- jira-labels.sh: no args
jira_run_expect_fail "$JIRA_SCRIPTS/jira-labels.sh"
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-labels.sh: exits non-zero with no args"; else fail "jira-labels.sh: should exit non-zero"; fi
assert_err_contains "jira-labels.sh no-args: mentions set/add/remove" "set.*add.*remove\|set\|add\|remove"

# -- jira-labels.sh: missing labels (has key + action but no labels)
jira_run_expect_fail "$JIRA_SCRIPTS/jira-labels.sh" PROJ-123 set
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-labels.sh: exits non-zero with no labels"; else fail "jira-labels.sh: should require label args"; fi

# -- jira-labels.sh: invalid action
jira_run_expect_fail "$JIRA_SCRIPTS/jira-labels.sh" PROJ-123 replace label1
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-labels.sh: exits non-zero with bad action"; else fail "jira-labels.sh: should reject invalid action"; fi
assert_err_contains "jira-labels.sh bad-action: lists valid actions" "set.*add.*remove"

# -- jira-update.sh: no args
jira_run_expect_fail "$JIRA_SCRIPTS/jira-update.sh"
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-update.sh: exits non-zero with no args"; else fail "jira-update.sh: should exit non-zero"; fi
assert_err_contains "jira-update.sh no-args: lists available options" "summary\|description\|priority"

# -- jira-update.sh: no fields provided
jira_run_expect_fail "$JIRA_SCRIPTS/jira-update.sh" PROJ-123
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-update.sh: exits non-zero with no fields"; else fail "jira-update.sh: should require at least one field"; fi
assert_err_contains "jira-update.sh no-fields: mentions raw API fallback" "jira-api\|raw API\|REST"

# -- jira-update.sh: unknown option
jira_run_expect_fail "$JIRA_SCRIPTS/jira-update.sh" PROJ-123 --bogus "value"
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-update.sh: exits non-zero with unknown option"; else fail "jira-update.sh: should reject unknown options"; fi

# -- jira-search.sh: no args
jira_run_expect_fail "$JIRA_SCRIPTS/jira-search.sh"
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-search.sh: exits non-zero with no args"; else fail "jira-search.sh: should exit non-zero"; fi
assert_err_contains "jira-search.sh no-args: suggests jira-list for advanced" "jira-list\|JQL\|structured"

# -- jira-api.sh: no args
jira_run_expect_fail "$JIRA_SCRIPTS/jira-api.sh"
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-api.sh: exits non-zero with no args"; else fail "jira-api.sh: should exit non-zero"; fi
assert_err_contains "jira-api.sh no-args: lists HTTP methods" "GET.*POST\|GET, POST"
assert_err_contains "jira-api.sh no-args: shows endpoint example" "/rest/api"

# -- jira-api.sh: invalid method
jira_run_expect_fail "$JIRA_SCRIPTS/jira-api.sh" BOGUS /rest/api/3/myself
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-api.sh: exits non-zero with bad method"; else fail "jira-api.sh: should reject invalid HTTP method"; fi
assert_err_contains "jira-api.sh bad-method: lists valid methods" "GET.*POST.*PUT.*DELETE"

# -- jira-api.sh: endpoint without leading /
jira_run_expect_fail "$JIRA_SCRIPTS/jira-api.sh" GET "rest/api/3/myself"
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-api.sh: exits non-zero when endpoint lacks /"; else fail "jira-api.sh: should require leading /"; fi
assert_err_contains "jira-api.sh bad-endpoint: explains the error" "must start with\|start with '/'"

# -- jira-api.sh: curl flags rejected (regression: -d and --data caused go-jira errors)
jira_run_expect_fail "$JIRA_SCRIPTS/jira-api.sh" PUT /rest/api/3/issue/X -d '{"fields":{}}'
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-api.sh: exits non-zero with -d flag"; else fail "jira-api.sh: should reject -d flag"; fi
assert_err_contains "jira-api.sh -d flag: explains it's a curl flag" "curl flag"
assert_err_contains "jira-api.sh -d flag: shows correct positional usage" "3rd positional\|positional argument"

jira_run_expect_fail "$JIRA_SCRIPTS/jira-api.sh" PUT /rest/api/3/issue/X --data '{"fields":{}}'
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-api.sh: exits non-zero with --data flag"; else fail "jira-api.sh: should reject --data flag"; fi
assert_err_contains "jira-api.sh --data flag: explains it's a curl flag" "curl flag"

jira_run_expect_fail "$JIRA_SCRIPTS/jira-api.sh" PUT /rest/api/3/issue/X --json '{"fields":{}}'
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-api.sh: exits non-zero with --json flag"; else fail "jira-api.sh: should reject --json flag"; fi

jira_run_expect_fail "$JIRA_SCRIPTS/jira-api.sh" GET /rest/api/3/myself -H 'Accept: application/json'
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-api.sh: exits non-zero with -H flag"; else fail "jira-api.sh: should reject -H flag"; fi

# -- jira-meta.sh: no args
jira_run_expect_fail "$JIRA_SCRIPTS/jira-meta.sh"
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-meta.sh: exits non-zero with no args"; else fail "jira-meta.sh: should exit non-zero"; fi
assert_err_contains "jira-meta.sh no-args: lists all actions" "types.*transitions.*statuses\|types\|transitions\|statuses"

# -- jira-meta.sh: transitions without issue key
jira_run_expect_fail "$JIRA_SCRIPTS/jira-meta.sh" transitions
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-meta.sh transitions: exits non-zero without key"; else fail "jira-meta.sh transitions: should require issue key"; fi

# ── Clean up mock environment ───────────────────────────────────────────────
rm -rf "$_JIRA_MOCK_DIR" "$_JIRA_MOCK_HOME"

# ═══════════════════════════════════════════════════════════════════════════════
# Read-only live tests — run automatically when configured, all GET requests
# ═══════════════════════════════════════════════════════════════════════════════

if [ -f "$HOME/.jira.d/config.yml" ]; then

    header "Jira: LIVE — Authentication (read-only)"

    MYSELF=$("$JIRA_SCRIPTS/jira-api.sh" GET /rest/api/3/myself 2>&1)
    if echo "$MYSELF" | jq -e '.displayName' >/dev/null 2>&1; then
        DISPLAY_NAME=$(echo "$MYSELF" | jq -r '.displayName')
        pass "Authentication works (user: ${DISPLAY_NAME})"
    else
        fail "Authentication failed: $MYSELF"
    fi

    header "Jira: LIVE — Metadata fetching"

    TYPES=$("$JIRA_SCRIPTS/jira-meta.sh" types 2>&1)
    if echo "$TYPES" | jq -e '.[0].name' >/dev/null 2>&1; then
        TYPE_COUNT=$(echo "$TYPES" | jq 'length')
        pass "jira-meta.sh types: fetched ${TYPE_COUNT} issue types"
    else
        fail "jira-meta.sh types: failed: $TYPES"
    fi

    STATUSES=$("$JIRA_SCRIPTS/jira-meta.sh" statuses 2>&1)
    if echo "$STATUSES" | jq -e '.[0]' >/dev/null 2>&1; then
        STATUS_COUNT=$(echo "$STATUSES" | jq 'length')
        pass "jira-meta.sh statuses: fetched ${STATUS_COUNT} statuses"
    else
        fail "jira-meta.sh statuses: failed: $STATUSES"
    fi

    PRIORITIES=$("$JIRA_SCRIPTS/jira-meta.sh" priorities 2>&1)
    if echo "$PRIORITIES" | jq -e '.[0].name' >/dev/null 2>&1; then
        pass "jira-meta.sh priorities: fetched priorities"
    else
        fail "jira-meta.sh priorities: failed: $PRIORITIES"
    fi

    header "Jira: LIVE — Search (POST /search/jql)"

    LIST_RESULT=$("$JIRA_SCRIPTS/jira-list.sh" --limit 2 2>&1)
    if echo "$LIST_RESULT" | jq -e '.[0].key' >/dev/null 2>&1; then
        pass "jira-list.sh: search returns results"
    elif echo "$LIST_RESULT" | jq -e '.message' >/dev/null 2>&1; then
        pass "jira-list.sh: search returns empty-result message"
    else
        fail "jira-list.sh: unexpected output: $(echo "$LIST_RESULT" | head -5)"
    fi

    header "Jira: LIVE — View issue"

    # Use first issue from list
    FIRST_KEY=$(echo "$LIST_RESULT" | jq -r '.[0].key // empty' 2>/dev/null)
    if [ -n "$FIRST_KEY" ]; then
        VIEW_RESULT=$("$JIRA_SCRIPTS/jira-view.sh" "$FIRST_KEY" 2>&1)
        if echo "$VIEW_RESULT" | jq -e '.key' >/dev/null 2>&1; then
            pass "jira-view.sh: successfully viewed ${FIRST_KEY}"
        else
            fail "jira-view.sh: failed to view ${FIRST_KEY}: $(echo "$VIEW_RESULT" | head -3)"
        fi
    else
        skip "No issues found to test jira-view.sh"
    fi

    header "Jira: LIVE — Transition listing"

    if [ -n "$FIRST_KEY" ]; then
        TRANS=$("$JIRA_SCRIPTS/jira-transition.sh" "$FIRST_KEY" --list 2>&1)
        if echo "$TRANS" | jq -e '.[0].name' >/dev/null 2>&1; then
            TRANS_COUNT=$(echo "$TRANS" | jq 'length')
            pass "jira-transition.sh --list: ${TRANS_COUNT} transitions for ${FIRST_KEY}"
        else
            fail "jira-transition.sh --list: failed: $(echo "$TRANS" | head -3)"
        fi
    else
        skip "No issues found to test transitions"
    fi

    header "Jira: LIVE — Invalid type detection"

    CREATE_ERR=$("$JIRA_SCRIPTS/jira-create.sh" --type "InvalidTypeThatDoesNotExist" --summary "test" 2>&1)
    CREATE_RC=$?
    if [ $CREATE_RC -ne 0 ] && echo "$CREATE_ERR" | grep -q "does not exist"; then
        pass "jira-create.sh: correctly rejects invalid type with helpful error"
    else
        fail "jira-create.sh: should reject invalid type (rc=${CREATE_RC}): $(echo "$CREATE_ERR" | head -3)"
    fi

else
    header "Jira: LIVE tests (read-only)"
    skip "Jira not configured (missing ~/.jira.d/config.yml)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Results: Jira"
# ═══════════════════════════════════════════════════════════════════════════════

printf "  ${GREEN}%d passed${RESET}  ${RED}%d failed${RESET}  ${YELLOW}%d skipped${RESET}\n" "$PASS" "$FAIL" "$SKIP"
echo ""

if [ "$FAIL" -gt 0 ]; then
    printf "  ${RED}${BOLD}FAILED${RESET}\n"
    exit 1
else
    printf "  ${GREEN}${BOLD}ALL TESTS PASSED${RESET}\n"
    exit 0
fi
