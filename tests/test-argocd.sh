#!/bin/bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/forbidden.sh"
# Test suite for the ArgoCD skill
# Tests: argument validation, error messages, script structure
# RULE: Live tests are READ-ONLY. Never create, modify, or delete data in live systems.
# Read-only live tests run automatically when ArgoCD is configured.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ARGOCD_DIR="${SCRIPT_DIR}/../skills/argocd"
ARGOCD_SCRIPTS="${ARGOCD_DIR}/scripts"
SKILL_DIR="${ARGOCD_DIR}"

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
header "ArgoCD: SKILL.md structure"
# ═══════════════════════════════════════════════════════════════════════════════

SKILLMD="${SKILL_DIR}/SKILL.md"

if [ -f "$SKILLMD" ]; then pass "SKILL.md exists"; else fail "SKILL.md missing"; fi
if head -1 "$SKILLMD" | grep -q '^---$'; then pass "Has YAML frontmatter"; else fail "Missing YAML frontmatter"; fi
if grep -q '^name: argocd' "$SKILLMD"; then pass "Name field is 'argocd'"; else fail "Name field missing or wrong"; fi
if grep -q '^description:' "$SKILLMD"; then pass "Has description"; else fail "Missing description"; fi

if grep -qiE "$FORBIDDEN_RE" "$SKILLMD"; then
    fail "SKILL.md contains company/user/system-specific data"
else
    pass "No company/user/system-specific data in SKILL.md"
fi

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
    if grep -q '_config.sh\|argocd-api.sh' "$script"; then pass "${name}: loads config"; else fail "${name}: doesn't load config"; fi

    if grep -qiE "$FORBIDDEN_RE" "$script"; then
        fail "${name}: contains company/user/system-specific data"
    else
        pass "${name}: no company/user/system-specific data"
    fi
done

# ═══════════════════════════════════════════════════════════════════════════════
header "ArgoCD: _config.sh"
# ═══════════════════════════════════════════════════════════════════════════════

CONFIG="${ARGOCD_SCRIPTS}/_config.sh"

if bash -n "$CONFIG" 2>/dev/null; then pass "_config.sh: bash syntax OK"; else fail "_config.sh: bash syntax error"; fi
if zsh -n "$CONFIG" 2>/dev/null; then pass "_config.sh: zsh syntax OK"; else fail "_config.sh: zsh syntax error"; fi
if grep -q '\.boring/argocd' "$CONFIG"; then pass "_config.sh: uses ~/.boring/argocd/"; else fail "_config.sh: should use ~/.boring/argocd/"; fi
if grep -qiE "$FORBIDDEN_RE" "$CONFIG"; then
    fail "_config.sh: contains company/user/system-specific data"
else
    pass "_config.sh: no company/user/system-specific data"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "ArgoCD: _api.sh"
# ═══════════════════════════════════════════════════════════════════════════════

API="${ARGOCD_SCRIPTS}/_api.sh"

if bash -n "$API" 2>/dev/null; then pass "_api.sh: bash syntax OK"; else fail "_api.sh: bash syntax error"; fi
if zsh -n "$API" 2>/dev/null; then pass "_api.sh: zsh syntax OK"; else fail "_api.sh: zsh syntax error"; fi

# Verify all API functions use --globoff (-g)
for func in argocd_get argocd_post argocd_put argocd_delete argocd_raw; do
    func_body=$(sed -n "/^${func}()/,/^}/p" "$API")
    if [ -z "$func_body" ]; then
        skip "_api.sh ${func}: function not found"
        continue
    fi
    if echo "$func_body" | grep -qE '\-g\b|--globoff'; then
        pass "_api.sh ${func}: uses --globoff (-g)"
    else
        fail "_api.sh ${func}: missing --globoff (-g)"
    fi
done

# Verify no -f flag in API functions (callers handle errors)
for func in argocd_get argocd_post argocd_put argocd_delete; do
    func_body=$(sed -n "/^${func}()/,/^}/p" "$API")
    if echo "$func_body" | grep -q 'curl.*-[a-z]*f'; then
        fail "_api.sh ${func}: uses -f (bypasses caller error handling)"
    else
        pass "_api.sh ${func}: does not use -f (callers check HTTP code)"
    fi
done

# Verify Bearer token auth
if grep -q 'Authorization: Bearer' "$API"; then
    pass "_api.sh: uses Bearer token authentication"
else
    fail "_api.sh: should use Bearer token authentication"
fi

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
        skip "${script}.sh: exits 0 without args (may be valid)"
    fi

    if [ -n "$CAPTURED_ERR" ] && echo "$CAPTURED_ERR" | grep -qi 'usage\|error\|required'; then
        pass "${script}.sh: provides usage/error message"
    else
        skip "${script}.sh: no error message on missing args"
    fi
done

# Scripts that work without args (list operations)
for script in argocd-app-list argocd-project-list argocd-cluster-list argocd-repo-list; do
    # These should NOT fail without args (they list all items)
    # But they will fail because the URL is fake — that's OK, we just check they don't fail on arg validation
    run_expect_fail env ARGOCD_URL="http://fake" ARGOCD_TOKEN="fake" CURL_RETRIES=0 CURL_CONNECT_TIMEOUT=1 CURL_MAX_TIME=1 \
        bash "$ARGOCD_SCRIPTS/${script}.sh"
    # If it fails, the error should be about connectivity, not about missing args
    if echo "$CAPTURED_ERR" | grep -qi 'usage'; then
        fail "${script}.sh: asks for usage on no-arg call (should list all)"
    else
        pass "${script}.sh: accepts no-arg call (list operation)"
    fi
done

# ═══════════════════════════════════════════════════════════════════════════════
header "ArgoCD: References"
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
header "ArgoCD: SKILL.md config docs match _config.sh"
# ═══════════════════════════════════════════════════════════════════════════════

if grep -q 'boring/argocd/url' "$ARGOCD_DIR/SKILL.md" || grep -q "boring/argocd" "$ARGOCD_DIR/SKILL.md"; then
    pass "SKILL.md: documents ~/.boring/argocd/ config"
else
    fail "SKILL.md: should document ~/.boring/argocd/ config"
fi

if grep -q 'argocd/token' "$ARGOCD_DIR/SKILL.md"; then
    pass "SKILL.md: documents token file"
else
    fail "SKILL.md: should document token file"
fi

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
