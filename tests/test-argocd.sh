#!/bin/bash
# Test suite for the ArgoCD skill
# Tests: argument validation, error messages, script structure
# RULE: Live tests are READ-ONLY. Never create, modify, or delete data in live systems.
# Read-only live tests run automatically when ArgoCD is configured.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ARGOCD_DIR="${SCRIPT_DIR}/../skills/argocd"
ARGOCD_SCRIPTS="${ARGOCD_DIR}/scripts"

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
header "ArgoCD: Script file checks"
# ═══════════════════════════════════════════════════════════════════════════════

for script in "$ARGOCD_SCRIPTS"/*.sh; do
    name=$(basename "$script")
    [ "$name" = "_config.sh" ] && continue

    if [ -x "$script" ]; then pass "${name}: is executable"; else fail "${name}: not executable"; fi
    if bash -n "$script" 2>/dev/null; then pass "${name}: bash syntax OK"; else fail "${name}: bash syntax error"; fi
    if zsh -n "$script" 2>/dev/null; then pass "${name}: zsh syntax OK"; else fail "${name}: zsh syntax error"; fi
    if grep -q 'set -e' "$script"; then pass "${name}: has set -e"; else fail "${name}: missing set -e"; fi
done

# ═══════════════════════════════════════════════════════════════════════════════
header "ArgoCD: _config.sh"
# ═══════════════════════════════════════════════════════════════════════════════

CONFIG="${ARGOCD_SCRIPTS}/_config.sh"

if bash -n "$CONFIG" 2>/dev/null; then pass "_config.sh: bash syntax OK"; else fail "_config.sh: bash syntax error"; fi
if zsh -n "$CONFIG" 2>/dev/null; then pass "_config.sh: zsh syntax OK"; else fail "_config.sh: zsh syntax error"; fi

# ═══════════════════════════════════════════════════════════════════════════════
header "ArgoCD: _api.sh"
# ═══════════════════════════════════════════════════════════════════════════════

API="${ARGOCD_SCRIPTS}/_api.sh"

if bash -n "$API" 2>/dev/null; then pass "_api.sh: bash syntax OK"; else fail "_api.sh: bash syntax error"; fi
if zsh -n "$API" 2>/dev/null; then pass "_api.sh: zsh syntax OK"; else fail "_api.sh: zsh syntax error"; fi

# ═══════════════════════════════════════════════════════════════════════════════
header "ArgoCD: Argument validation"
# ═══════════════════════════════════════════════════════════════════════════════

# Scripts that require arguments should fail with descriptive errors
for script in argocd-app-get argocd-app-sync argocd-app-wait argocd-app-history \
              argocd-app-resources argocd-app-logs argocd-app-manifests argocd-app-diff \
              argocd-app-rollback argocd-app-actions argocd-app-delete argocd-project-get argocd-api; do
    run_expect_fail env ARGOCD_URL="http://fake" ARGOCD_TOKEN="fake" \
        bash "$ARGOCD_SCRIPTS/${script}.sh"
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

# ═══════════════════════════════════════════════════════════════════════════════
# Read-only live tests — run automatically when configured, all GET requests
# ═══════════════════════════════════════════════════════════════════════════════

if [ -f "$HOME/.boring/argocd/url" ] && [ -f "$HOME/.boring/argocd/token" ]; then
    header "ArgoCD: LIVE — Connectivity (read-only)"

    RESULT=$("$ARGOCD_SCRIPTS/argocd-api.sh" /api/v1/session/userinfo 2>&1)
    if echo "$RESULT" | jq -e '.loggedIn' >/dev/null 2>&1; then
        pass "ArgoCD API reachable (user info)"
    else
        fail "ArgoCD API failed: $(echo "$RESULT" | head -3)"
    fi

    header "ArgoCD: LIVE — List applications (read-only)"
    RESULT=$("$ARGOCD_SCRIPTS/argocd-app-list.sh" 2>&1)
    if [ $? -eq 0 ]; then
        pass "argocd-app-list.sh succeeds"
    else
        fail "argocd-app-list.sh failed: $(echo "$RESULT" | head -3)"
    fi

    header "ArgoCD: LIVE — List projects (read-only)"
    RESULT=$("$ARGOCD_SCRIPTS/argocd-project-list.sh" 2>&1)
    if [ $? -eq 0 ]; then
        pass "argocd-project-list.sh succeeds"
    else
        fail "argocd-project-list.sh failed: $(echo "$RESULT" | head -3)"
    fi
else
    header "ArgoCD: LIVE tests (read-only)"
    skip "ArgoCD not configured (missing ~/.boring/argocd/ files)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Results: ArgoCD"
# ═══════════════════════════════════════════════════════════════════════════════

printf "  ${GREEN}%d passed${RESET}  ${RED}%d failed${RESET}  ${YELLOW}%d skipped${RESET}\n" "$PASS" "$FAIL" "$SKIP"
echo ""
if [ "$FAIL" -gt 0 ]; then printf "  ${RED}${BOLD}FAILED${RESET}\n"; exit 1
else printf "  ${GREEN}${BOLD}ALL TESTS PASSED${RESET}\n"; exit 0; fi
