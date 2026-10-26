#!/bin/bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/forbidden.sh"
# Test suite for setup.sh
# Tests: syntax, canonical layout, safety scans, skill description length, legacy link migration
# RULE: ALL tests are READ-ONLY. No files are created, modified, or deleted outside $SANDBOX.
# Uses a temp sandbox to run the legacy link migration without touching real config.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${SCRIPT_DIR}/.."
SETUP="${REPO_DIR}/setup.sh"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
PASS=0; FAIL=0; SKIP=0

pass() { PASS=$((PASS + 1)); printf "  ${GREEN}OK${RESET}   %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${RESET} %s\n" "$1"; [ -n "${2:-}" ] && printf "    ${DIM}%s${RESET}\n" "$2"; }
header() { echo ""; printf "${BOLD}━━━ %s ━━━${RESET}\n" "$1"; }

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: File & syntax"
# ═══════════════════════════════════════════════════════════════════════════════

if [ -x "$SETUP" ]; then pass "setup.sh is executable"; else fail "setup.sh is not executable"; fi
if bash -n "$SETUP" 2>/dev/null; then pass "bash syntax OK"; else fail "bash syntax error"; fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: Canonical skills layout"
# ═══════════════════════════════════════════════════════════════════════════════

INVALID_SKILL_PATHS=""
while IFS= read -r skill_path; do
    [ -f "${REPO_DIR}/${skill_path}" ] || continue
    if printf '%s\n' "$skill_path" | grep -qE '^skills/[^/]+/SKILL\.md$'; then
        continue
    fi
    INVALID_SKILL_PATHS="${INVALID_SKILL_PATHS}${skill_path}\n"
done < <(git -C "$REPO_DIR" ls-files '*SKILL.md')

if [ -z "$INVALID_SKILL_PATHS" ]; then
    pass "Every tracked skill uses the canonical skills/<name>/ layout"
else
    fail "Tracked skills found outside skills/<name>/" "$(printf '%b' "$INVALID_SKILL_PATHS")"
fi

# Pi extensions are package resources, not skill implementation details. Keeping them at
# the repository extension root lets pi discover and install them independently of skills.
header "Setup: Canonical extension layout"
MISPLACED_EXTENSIONS=$(find "${REPO_DIR}/skills" -path '*/node_modules' -prune -o -type f \( -path '*/extensions/*' -o -name 'pi-extension.ts' \) -print)
if [ -z "$MISPLACED_EXTENSIONS" ]; then
    pass "No Pi extensions are nested inside skills"
else
    fail "Pi extensions should not be nested inside skills" "$MISPLACED_EXTENSIONS"
fi

SKANE_README="${REPO_DIR}/skills/skanetrafiken/README.md"
SKANE_LICENSE_REF=$(grep -oE '\]\((\.\./)+LICENSE\)' "$SKANE_README" | head -1 | sed 's/^](//; s/)$//')
if [ -n "$SKANE_LICENSE_REF" ] && [ -f "$(dirname "$SKANE_README")/${SKANE_LICENSE_REF}" ]; then
    pass "skanetrafiken README license link resolves"
else
    fail "skanetrafiken README license link should resolve to the repository license"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: No hardcoded paths or secrets"
# ═══════════════════════════════════════════════════════════════════════════════

if grep -qE '/Users/[a-z]|/home/[a-z]' "$SETUP"; then
    fail "Hardcoded home directory paths in setup.sh"
else
    pass "No hardcoded home directory paths"
fi

if grep -qiE "$FORBIDDEN_RE" "$SETUP"; then
    fail "Company/user-specific data in setup.sh"
else
    pass "No company/user-specific data"
fi

# Exclude known safe references: jira keyring docs mention 'password-source', 'add-generic-password'
SUSPECT_SECRETS=$(grep -niE 'apikey=[^$]|token=[^$"'"'"']' "$SETUP" | grep -viE 'password-source|add-generic-password|#|DIM|echo' || true)
if [ -n "$SUSPECT_SECRETS" ]; then
    fail "Possible hardcoded secrets in setup.sh" "$SUSPECT_SECRETS"
else
    pass "No hardcoded secrets (password refs are jira keyring docs)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: SKILL.md description length (java-21-to-25-migration)"
# ═══════════════════════════════════════════════════════════════════════════════

JAVA_MIG_DIR="${REPO_DIR}/skills/java-21-to-25-migration"
SKILLMD="${JAVA_MIG_DIR}/SKILL.md"

# Description length check (pi limit: 1024 chars)
DESC_LEN=$(grep '^description:' "$SKILLMD" | sed 's/^description: //' | wc -c | tr -d ' ')
if [ "$DESC_LEN" -le 1024 ]; then
    pass "Description length ${DESC_LEN} chars (≤1024 pi limit)"
else
    fail "Description too long: ${DESC_LEN} chars (pi limit is 1024)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: Sandbox legacy link migration (non-destructive)"
# ═══════════════════════════════════════════════════════════════════════════════

# Create a temp sandbox to test symlink logic without touching real system
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

MIGRATION_FNS=$(sed -n '/^_skill_source()/,/^_link_skill_to()/p' "$SETUP" | sed '$d')
if [ -n "$MIGRATION_FNS" ] && (
    SCRIPT_DIR="$SANDBOX/repository"
    SKILLS_SRC="$SCRIPT_DIR/skills"
    INSTALL_DIR="$SANDBOX/pi-skills"
    AGENT_HARNESS="pi"
    BOLD=""
    RESET=""
    eval "$(grep '^MOVED_SKILLS=' "$SETUP")"
    eval "$(grep '^LEGACY_WORKFLOW_TOOL_SKILLS=' "$SETUP")"
    header() { :; }
    info() { :; }
    success() { :; }
    warn() { :; }
    ask_yn() { eval "$1=true"; }
    eval "$MIGRATION_FNS"
    mkdir -p "$INSTALL_DIR"
    for skill in $MOVED_SKILLS; do
        old_target="$(_legacy_skill_source "$skill")"
        new_target="$(_skill_source "$skill")"
        mkdir -p "$old_target" "$new_target"
        ln -s "$old_target" "$INSTALL_DIR/$skill"
    done
    migrate_legacy_skill_links
    for skill in $MOVED_SKILLS; do
        [ "$(readlink "$INSTALL_DIR/$skill")" = "$(_skill_source "$skill")" ] || exit 1
    done
); then
    pass "Sandbox: migration refreshes every moved Pi skill link"
else
    fail "Sandbox: migration should refresh every moved Pi skill link"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Results: Setup"
# ═══════════════════════════════════════════════════════════════════════════════

printf "\n  ${GREEN}%d passed${RESET}  ${RED}%d failed${RESET}  ${YELLOW}%d skipped${RESET}\n" "$PASS" "$FAIL" "$SKIP"
echo ""
if [ "$FAIL" -gt 0 ]; then printf "  ${RED}${BOLD}FAILED${RESET}\n"; exit 1
else printf "  ${GREEN}${BOLD}ALL TESTS PASSED${RESET}\n"; exit 0; fi
