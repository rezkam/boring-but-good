#!/bin/bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/forbidden.sh"
# Test suite for the Jira skill
# Tests: argument validation, error messages, output parsing, failure modes
# RULE: Live tests are READ-ONLY. Never create, modify, or delete data in live systems.
# Read-only live tests run automatically when Jira is configured.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JIRA_SCRIPTS="${SCRIPT_DIR}/../skills/jira/scripts"
SKILL_DIR="${SCRIPT_DIR}/../skills/jira"

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
header "Jira: SKILL.md structure"
# ═══════════════════════════════════════════════════════════════════════════════

SKILLMD="${SKILL_DIR}/SKILL.md"

if [ -f "$SKILLMD" ]; then pass "SKILL.md exists"; else fail "SKILL.md missing"; fi

if head -1 "$SKILLMD" | grep -q '^---$'; then
    pass "Has YAML frontmatter"
else
    fail "Missing YAML frontmatter"
fi

if grep -q '^name: jira' "$SKILLMD"; then
    pass "Name field is 'jira'"
else
    fail "Name field missing or wrong"
fi

if grep -q '^description:' "$SKILLMD"; then
    pass "Has description"
else
    fail "Missing description"
fi

# No company/user/system-specific data
if grep -qiE "$FORBIDDEN_RE" "$SKILLMD"; then
    fail "SKILL.md contains company/user-specific data"
else
    pass "No company/user-specific data in SKILL.md"
fi

# References all scripts
for script in jira-api jira-create jira-view jira-transition jira-comment jira-labels jira-assign jira-list jira-search jira-update jira-meta; do
    if grep -q "${script}.sh" "$SKILLMD"; then
        pass "SKILL.md references ${script}.sh"
    else
        fail "SKILL.md missing reference to ${script}.sh"
    fi
done

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

    # Sources _config.sh
    if grep -q '_config.sh' "$script"; then
        pass "${name}: sources _config.sh"
    else
        fail "${name}: does not source _config.sh"
    fi

    # Has usage/help text
    if grep -q 'Usage\|ERROR' "$script"; then
        pass "${name}: has usage/error messages"
    else
        fail "${name}: missing usage/error messages"
    fi

    # No company-specific data
    if grep -qiE "$FORBIDDEN_RE" "$script"; then
        fail "${name}: contains company/user-specific data"
    else
        pass "${name}: no company/user-specific data"
    fi

    # No hardcoded absolute paths
    if grep -qE '/Users/|/home/[a-z]' "$script"; then
        fail "${name}: contains hardcoded home directory path"
    else
        pass "${name}: no hardcoded paths"
    fi
done

# _config.sh checks
header "Jira: _config.sh"

if bash -n "$JIRA_SCRIPTS/_config.sh" 2>/dev/null; then
    pass "_config.sh: bash syntax OK"
else
    fail "_config.sh: bash syntax error"
fi

if grep -q 'command -v jira' "$JIRA_SCRIPTS/_config.sh"; then
    pass "_config.sh: checks for go-jira"
else
    fail "_config.sh: doesn't check for go-jira"
fi

if grep -q '\.jira\.d/config\.yml' "$JIRA_SCRIPTS/_config.sh"; then
    pass "_config.sh: checks for config.yml"
else
    fail "_config.sh: doesn't check for config.yml"
fi

if grep -q 'JIRA_DEFAULT_LABELS' "$JIRA_SCRIPTS/_config.sh"; then
    pass "_config.sh: loads default labels"
else
    fail "_config.sh: doesn't load default labels"
fi

if grep -qiE "$FORBIDDEN_RE" "$JIRA_SCRIPTS/_config.sh"; then
    fail "_config.sh: contains company/user-specific data"
else
    pass "_config.sh: no company/user-specific data"
fi

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
assert_err_contains "jira-transition.sh no-args: explains transitions vs statuses" "transition\|Transition"
assert_err_contains "jira-transition.sh no-args: suggests --list" "list"

# -- jira-assign.sh: no args
jira_run_expect_fail "$JIRA_SCRIPTS/jira-assign.sh"
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-assign.sh: exits non-zero with no args"; else fail "jira-assign.sh: should exit non-zero"; fi
assert_err_contains "jira-assign.sh no-args: mentions --me" "me"
assert_err_contains "jira-assign.sh no-args: mentions --unassign" "unassign"

# -- jira-labels.sh: no args
jira_run_expect_fail "$JIRA_SCRIPTS/jira-labels.sh"
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-labels.sh: exits non-zero with no args"; else fail "jira-labels.sh: should exit non-zero"; fi
assert_err_contains "jira-labels.sh no-args: mentions set/add/remove" "set.*add.*remove\|set\|add\|remove"

# -- jira-labels.sh: missing labels (has key + action but no labels)
jira_run_expect_fail "$JIRA_SCRIPTS/jira-labels.sh" PROJ-123 set
if [ $CAPTURED_RC -ne 0 ]; then pass "jira-labels.sh: exits non-zero with no labels"; else fail "jira-labels.sh: should require label args"; fi
assert_err_contains "jira-labels.sh no-labels: shows example" "example\|Example\|label"

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
assert_err_contains "jira-meta.sh transitions: explains what transitions are" "transition\|workflow\|current state"

# ── Clean up mock environment ───────────────────────────────────────────────
rm -rf "$_JIRA_MOCK_DIR" "$_JIRA_MOCK_HOME"

# ═══════════════════════════════════════════════════════════════════════════════
header "Jira: Issue key extraction (bug: grep double-match)"
# ═══════════════════════════════════════════════════════════════════════════════

# The bug: go-jira outputs "OK PROJ-123 https://example.atlassian.net/browse/PROJ-123"
# grep -oE '[A-Z]+-[0-9]+' matches PROJ-123 TWICE (from text and URL)
# Fix: pipe through head -1

if grep -q 'head -1' "$JIRA_SCRIPTS/jira-create.sh"; then
    pass "jira-create.sh: uses head -1 to deduplicate grep matches"
else
    fail "jira-create.sh: MISSING head -1 — will pass multi-line key to jira labels set"
fi

# Simulate the parsing with the script's actual regex
SIMULATED_OUTPUT="OK PROJ-123 https://example.atlassian.net/browse/PROJ-123"
EXTRACTED=$(echo "$SIMULATED_OUTPUT" | grep -oE '[A-Z][A-Z0-9_]+-[0-9]+' | head -1)
if [ "$EXTRACTED" = "PROJ-123" ]; then
    pass "Key extraction: correctly extracts single key from go-jira output"
else
    fail "Key extraction: got '$EXTRACTED' instead of 'PROJ-123'"
fi

# Verify it would fail WITHOUT head -1
EXTRACTED_BAD=$(echo "$SIMULATED_OUTPUT" | grep -oE '[A-Z][A-Z0-9_]+-[0-9]+')
LINE_COUNT=$(echo "$EXTRACTED_BAD" | wc -l | tr -d ' ')
if [ "$LINE_COUNT" = "2" ]; then
    pass "Key extraction: confirms grep -oE matches twice without head -1 (this is the bug)"
else
    fail "Key extraction: expected 2 matches without head -1, got $LINE_COUNT"
fi

# Regression: [A-Z]+-[0-9]+ fails for project keys with digits (APP1-123, P2P-456)
# Jira project keys: start with uppercase, then uppercase/digits/underscore
if grep -q '\[A-Z\]\[A-Z0-9' "$JIRA_SCRIPTS/jira-create.sh"; then
    pass "jira-create.sh: key regex supports digits in project key"
else
    fail "jira-create.sh: key regex [A-Z]+-[0-9]+ fails for keys like APP1-123"
fi

# Prove the old regex [A-Z]+-[0-9]+ fails on these keys
OLD_RE='[A-Z]+-[0-9]+'
for bad_case in "APP1-123" "P2P-456" "PROJECT2-789"; do
    old_match=$(echo "OK ${bad_case} https://x/${bad_case}" | grep -oE "$OLD_RE" | head -1)
    if [ "$old_match" != "$bad_case" ]; then
        pass "Old regex fails on '${bad_case}' (got '${old_match:-EMPTY}') — proves fix is needed"
    else
        fail "Old regex should fail on '${bad_case}' but matched correctly"
    fi
done

# Prove the new regex [A-Z][A-Z0-9_]+-[0-9]+ succeeds
NEW_RE='[A-Z][A-Z0-9_]+-[0-9]+'
for good_case in "APP1-123" "P2P-456" "PROJECT2-789" "USS-99" "AB-1"; do
    new_match=$(echo "OK ${good_case} https://x/${good_case}" | grep -oE "$NEW_RE" | head -1)
    if [ "$new_match" = "$good_case" ]; then
        pass "New regex extracts '${good_case}' correctly"
    else
        fail "New regex: expected '${good_case}', got '${new_match:-EMPTY}'"
    fi
done

# ═══════════════════════════════════════════════════════════════════════════════
header "Jira: Default labels enforcement"
# ═══════════════════════════════════════════════════════════════════════════════

# Labels must always be applied. The script must treat label failure as a hard error.

if grep -q 'exit 1' "$JIRA_SCRIPTS/jira-create.sh" | grep -A2 'labels could not'; then
    : # check below
fi

# Check that label failure exits non-zero
if grep -A30 'labels could not be applied' "$JIRA_SCRIPTS/jira-create.sh" | grep -q 'exit 1'; then
    pass "jira-create.sh: label failure exits non-zero (hard error)"
else
    fail "jira-create.sh: label failure should exit non-zero"
fi

# Check that label failure error includes recovery commands
if grep -A10 'labels could not be applied' "$JIRA_SCRIPTS/jira-create.sh" | grep -q 'jira labels set'; then
    pass "jira-create.sh: label failure includes recovery command"
else
    fail "jira-create.sh: label failure should include 'jira labels set' recovery command"
fi

if grep -A10 'labels could not be applied' "$JIRA_SCRIPTS/jira-create.sh" | grep -q 'jira-labels.sh'; then
    pass "jira-create.sh: label failure includes script-based recovery"
else
    fail "jira-create.sh: label failure should include jira-labels.sh recovery"
fi

if grep -A15 'labels could not be applied' "$JIRA_SCRIPTS/jira-create.sh" | grep -q 'jira-api.sh'; then
    pass "jira-create.sh: label failure includes raw API recovery"
else
    fail "jira-create.sh: label failure should include jira-api.sh raw API fallback"
fi

# Check that the issue key is still output even on label failure
# The script prints "The issue key is: ${ISSUE_KEY}" in the error message and echoes the key
if grep -A25 'labels could not be applied' "$JIRA_SCRIPTS/jira-create.sh" | grep -q 'echo.*ISSUE_KEY\|The issue key is'; then
    pass "jira-create.sh: outputs issue key even when labels fail"
else
    fail "jira-create.sh: should output issue key even when labels fail"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Jira: Issue type validation"
# ═══════════════════════════════════════════════════════════════════════════════

# jira-create.sh must validate the issue type before calling go-jira create

if grep -q 'jira-meta.sh' "$JIRA_SCRIPTS/jira-create.sh"; then
    pass "jira-create.sh: calls jira-meta.sh for type validation"
else
    fail "jira-create.sh: should validate types via jira-meta.sh"
fi

if grep -q 'types_.*\.json' "$JIRA_SCRIPTS/jira-create.sh"; then
    pass "jira-create.sh: checks cache file for type validation"
else
    fail "jira-create.sh: should check types cache file"
fi

# Check that invalid type error lists valid types
if grep -A5 'does not exist in project' "$JIRA_SCRIPTS/jira-create.sh" | grep -q 'Available issue types'; then
    pass "jira-create.sh: invalid type error lists available types"
else
    fail "jira-create.sh: invalid type error should list available types"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Jira: --parent applied in create (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: --parent was parsed but never applied to the created issue.
# Current behavior sets parent with a follow-up Jira API PUT because Jira Cloud ignores
# create-time parent overrides for some non-subtask issue types.
if grep -q 'PARENT_OUTPUT=.*jira-api.sh.*PUT' "$JIRA_SCRIPTS/jira-create.sh" && \
   grep -q 'parent.*key.*PARENT' "$JIRA_SCRIPTS/jira-create.sh"; then
    pass "jira-create.sh: --parent is applied with follow-up API update"
else
    fail "jira-create.sh: --parent is parsed but never applied to the created issue"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Jira: Assignee Cloud/Server compatibility (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: jira-update.sh used {"name": ...} which fails on Jira Cloud (needs accountId)
# Fix: delegate to go-jira assign which handles both
if grep -q '"name":.*ASSIGNEE\|\.assignee.*name' "$JIRA_SCRIPTS/jira-update.sh"; then
    fail "jira-update.sh: still uses {\"name\": ...} for assignee (breaks Jira Cloud)"
else
    pass "jira-update.sh: does not hardcode assignee as {\"name\": ...}"
fi

if grep -q 'jira assign\|jira take\|jira unassign\|_ASSIGNEE_PENDING' "$JIRA_SCRIPTS/jira-update.sh"; then
    pass "jira-update.sh: delegates assignee to go-jira (Cloud/Server compatible)"
else
    fail "jira-update.sh: should delegate assignee changes to go-jira"
fi

# Regression: assignee failures were masked with || true and then $? checked (always 0)
if grep -q 'ASSIGN_RC\||| ASSIGN_RC' "$JIRA_SCRIPTS/jira-update.sh"; then
    pass "jira-update.sh: captures assignee command exit code properly"
else
    fail "jira-update.sh: should capture assignee exit code (not || true then check \$?)"
fi

if grep -q '|| true' "$JIRA_SCRIPTS/jira-update.sh" && grep -q '\$? -ne 0' "$JIRA_SCRIPTS/jira-update.sh"; then
    fail "jira-update.sh: still uses || true with \$? check (always succeeds)"
else
    pass "jira-update.sh: does not use || true followed by \$? check"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Jira: Statuses fallback endpoint parsing (regression)"
# ═══════════════════════════════════════════════════════════════════════════════

# Regression: fallback to /rest/api/3/status used wrong jq filter (.[].statuses[]? instead of .[].name)
# Primary endpoint: [{"id":"...", "statuses":[...]}] → .[].statuses[]
# Fallback endpoint: [{"name":"...", "statusCategory":{...}}] → .[].name
if grep -A3 '/rest/api/3/status' "$JIRA_SCRIPTS/jira-meta.sh" | grep -q '\[\.\[\]\.name\]'; then
    pass "jira-meta.sh: fallback endpoint uses correct jq filter ([].name)"
else
    fail "jira-meta.sh: fallback should parse [].name, not [].statuses[]"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Jira: Search API (Cloud vs Server compatibility)"
# ═══════════════════════════════════════════════════════════════════════════════

# Jira Cloud deprecated GET /rest/api/3/search — must use POST /rest/api/3/search/jql

if grep -q 'search/jql' "$JIRA_SCRIPTS/jira-list.sh"; then
    pass "jira-list.sh: uses new /search/jql endpoint"
else
    fail "jira-list.sh: should use POST /rest/api/3/search/jql (old /search is deprecated)"
fi

if grep -q 'POST.*search/jql' "$JIRA_SCRIPTS/jira-list.sh" || grep -q 'jira-api.sh.*POST.*search/jql' "$JIRA_SCRIPTS/jira-list.sh"; then
    pass "jira-list.sh: uses POST method for search"
else
    fail "jira-list.sh: should use POST (not GET) for /search/jql"
fi

# Fallback for Server/DC
if grep -q 'rest/api/2/search' "$JIRA_SCRIPTS/jira-list.sh"; then
    pass "jira-list.sh: has fallback to old API for Server/DC"
else
    fail "jira-list.sh: should fall back to /rest/api/2/search for Server/DC"
fi

# Same checks for search script
if grep -q 'search/jql' "$JIRA_SCRIPTS/jira-search.sh"; then
    pass "jira-search.sh: uses new /search/jql endpoint"
else
    fail "jira-search.sh: should use POST /rest/api/3/search/jql"
fi

if grep -q 'rest/api/2/search' "$JIRA_SCRIPTS/jira-search.sh"; then
    pass "jira-search.sh: has fallback to old API for Server/DC"
else
    fail "jira-search.sh: should fall back to /rest/api/2/search"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Jira: JQL quoting safety (jq --arg)"
# ═══════════════════════════════════════════════════════════════════════════════

# JQL strings can contain double quotes like: status = "In Progress"
# Shell-interpolating $JQL into jq via '"'"$JQL"'"' breaks when JQL has quotes.
# Must use jq --arg to pass variables safely.

if grep -q 'jq --arg' "$JIRA_SCRIPTS/jira-list.sh" || grep -q "jq.*--arg.*jql" "$JIRA_SCRIPTS/jira-list.sh"; then
    pass "jira-list.sh: uses jq --arg for safe JQL interpolation"
else
    fail "jira-list.sh: MUST use jq --arg (shell-interpolating JQL into jq breaks on quotes)"
fi

if grep -q 'jq --arg' "$JIRA_SCRIPTS/jira-search.sh" || grep -q "jq.*--arg.*text" "$JIRA_SCRIPTS/jira-search.sh"; then
    pass "jira-search.sh: uses jq --arg for safe variable interpolation"
else
    fail "jira-search.sh: MUST use jq --arg"
fi

# Simulate the quoting bug: jq with embedded double quotes
TEST_JQL='status = "In Progress"'
RESULT=$(echo '{"issues":[]}' | jq --arg jql "$TEST_JQL" 'if .issues then {jql: $jql} else empty end' 2>/dev/null)
if [ -n "$RESULT" ]; then
    pass "jq --arg: safely handles JQL with double quotes"
else
    fail "jq --arg: failed to handle JQL with double quotes"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Jira: Empty/error API response handling"
# ═══════════════════════════════════════════════════════════════════════════════

# Scripts must handle: empty response, error response, no results

# Test: .issues is empty array
EMPTY_RESULT=$(echo '{"issues":[]}' | jq --arg jql "test" '
    if .issues then
        if (.issues | length) == 0 then
            {message: "No issues found matching the query.", jql: $jql}
        else
            [.issues[] | {key: .key}]
        end
    else
        {error: "Unexpected response format"}
    end' 2>/dev/null)

if echo "$EMPTY_RESULT" | grep -q "No issues found"; then
    pass "jq parsing: handles empty issues array gracefully"
else
    fail "jq parsing: should produce 'No issues found' for empty results"
fi

# Test: error response from Jira
ERROR_RESULT=$(echo '{"errorMessages":["Field does not exist"]}' | jq --arg jql "test" '
    if .errorMessages then
        {error: .errorMessages}
    elif .issues then
        []
    else
        {error: "Unexpected response format"}
    end' 2>/dev/null)

if echo "$ERROR_RESULT" | grep -q "Field does not exist"; then
    pass "jq parsing: handles errorMessages response"
else
    fail "jq parsing: should pass through Jira error messages"
fi

# Test: deprecated API response
DEPRECATED='{"errorMessages":["The requested API has been removed. Please migrate to the /rest/api/3/search/jql API."]}'
DEP_RESULT=$(echo "$DEPRECATED" | jq 'if .errorMessages then {error: .errorMessages} else empty end' 2>/dev/null)
if echo "$DEP_RESULT" | grep -q "migrate"; then
    pass "jq parsing: handles deprecated API error"
else
    fail "jq parsing: should handle deprecated API error message"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Jira: Transition error guidance"
# ═══════════════════════════════════════════════════════════════════════════════

# When a transition fails, the error must:
# 1. Show the current status
# 2. List available transitions
# 3. Explain transition name vs status name

if grep -q 'Current status' "$JIRA_SCRIPTS/jira-transition.sh"; then
    pass "jira-transition.sh: failure shows current status"
else
    fail "jira-transition.sh: failure should show current status"
fi

if grep -q 'Available transitions' "$JIRA_SCRIPTS/jira-transition.sh"; then
    pass "jira-transition.sh: failure lists available transitions"
else
    fail "jira-transition.sh: failure should list available transitions"
fi

if grep -q 'status name.*transition name\|transition name.*status name\|Using a status name instead of a transition name' "$JIRA_SCRIPTS/jira-transition.sh"; then
    pass "jira-transition.sh: explains transition name vs status name confusion"
else
    fail "jira-transition.sh: should explain transition name vs status name"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Jira: Metadata caching"
# ═══════════════════════════════════════════════════════════════════════════════

if grep -q 'CACHE_TTL' "$JIRA_SCRIPTS/jira-meta.sh"; then
    pass "jira-meta.sh: has cache TTL"
else
    fail "jira-meta.sh: should have a cache TTL"
fi

if grep -q '\.boring/jira/cache' "$JIRA_SCRIPTS/jira-meta.sh"; then
    pass "jira-meta.sh: caches to ~/.boring/jira/cache/"
else
    fail "jira-meta.sh: should cache to ~/.boring/jira/cache/"
fi

if grep -q 'refresh' "$JIRA_SCRIPTS/jira-meta.sh"; then
    pass "jira-meta.sh: has refresh action"
else
    fail "jira-meta.sh: should have a refresh action"
fi

# Supports both macOS and Linux stat
if grep -q 'stat -f' "$JIRA_SCRIPTS/jira-meta.sh" && grep -q 'stat -c' "$JIRA_SCRIPTS/jira-meta.sh"; then
    pass "jira-meta.sh: handles both macOS and Linux stat"
else
    fail "jira-meta.sh: should support both macOS (stat -f) and Linux (stat -c)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Jira: References directory"
# ═══════════════════════════════════════════════════════════════════════════════

REFS_DIR="${SKILL_DIR}/references"
if [ -d "$REFS_DIR" ]; then
    pass "references/ directory exists"
    for ref in "$REFS_DIR"/*.md; do
        [ -f "$ref" ] || continue
        name=$(basename "$ref")
        if [ -s "$ref" ]; then
            pass "${name}: non-empty"
        else
            fail "${name}: is empty"
        fi
        if grep -qiE "$FORBIDDEN_RE" "$ref"; then
            fail "${name}: contains company/user/system-specific data"
        else
            pass "${name}: no company/user/system-specific data"
        fi
    done
else
    skip "No references/ directory"
fi

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
