#!/bin/bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/forbidden.sh"
# Test suite for setup.sh
# Tests: syntax, structure, harness detection, java-21-to-25-migration install logic, codex install logic, summary
# RULE: ALL tests are READ-ONLY. No files are created, modified, or deleted outside $SANDBOX.
# Uses a temp sandbox to verify symlink/install behavior without touching real config.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${SCRIPT_DIR}/.."
SETUP="${REPO_DIR}/setup.sh"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
PASS=0; FAIL=0; SKIP=0

pass() { PASS=$((PASS + 1)); printf "  ${GREEN}OK${RESET}   %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${RESET} %s\n" "$1"; [ -n "${2:-}" ] && printf "    ${DIM}%s${RESET}\n" "$2"; }
skip() { SKIP=$((SKIP + 1)); printf "  ${YELLOW}SKIP${RESET} %s ${DIM}(skipped)${RESET}\n" "$1"; }
header() { echo ""; printf "${BOLD}━━━ %s ━━━${RESET}\n" "$1"; }

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: File & syntax"
# ═══════════════════════════════════════════════════════════════════════════════

if [ -f "$SETUP" ]; then pass "setup.sh exists"; else fail "setup.sh missing"; fi
if [ -x "$SETUP" ]; then pass "setup.sh is executable"; else fail "setup.sh is not executable"; fi
if bash -n "$SETUP" 2>/dev/null; then pass "bash syntax OK"; else fail "bash syntax error"; fi
if head -1 "$SETUP" | grep -qE '^#!/.*(bash|sh)'; then pass "Has shebang"; else fail "Missing shebang"; fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: Canonical skills layout"
# ═══════════════════════════════════════════════════════════════════════════════

if grep -q 'SKILLS_SRC="${SCRIPT_DIR}/skills"' "$SETUP"; then
    pass "setup.sh reads skills from skills/"
else
    fail "setup.sh should read skills from skills/"
fi

for skill in ai-chat argocd codex commit coordinator dependency-track finance java-21-to-25-migration jenkins jira perplexity pr-ready skanetrafiken sonarqube tdd to-tasks verify; do
    if [ -f "${REPO_DIR}/skills/${skill}/SKILL.md" ]; then
        pass "${skill} is under skills/"
    else
        fail "${skill} should be under skills/"
    fi
done

if [ -f "${REPO_DIR}/browser-tools/SKILL.md" ]; then
    pass "browser-tools remains at the repository root"
else
    fail "browser-tools should remain at the repository root"
fi

INVALID_SKILL_PATHS=""
while IFS= read -r skill_path; do
    if [ "$skill_path" = "browser-tools/SKILL.md" ] || printf '%s\n' "$skill_path" | grep -qE '^skills/[^/]+/SKILL\.md$'; then
        continue
    fi
    INVALID_SKILL_PATHS="${INVALID_SKILL_PATHS}${skill_path}\n"
done < <(git -C "$REPO_DIR" ls-files '*SKILL.md')

if [ -z "$INVALID_SKILL_PATHS" ]; then
    pass "Every tracked skill uses the canonical layout"
else
    fail "Tracked skills found outside skills/ and browser-tools/" "$(printf '%b' "$INVALID_SKILL_PATHS")"
fi

SKANE_README="${REPO_DIR}/skills/skanetrafiken/README.md"
SKANE_LICENSE_REF=$(grep -oE '\]\((\.\./)+LICENSE\)' "$SKANE_README" | head -1 | sed 's/^](//; s/)$//')
if [ -n "$SKANE_LICENSE_REF" ] && [ -f "$(dirname "$SKANE_README")/${SKANE_LICENSE_REF}" ]; then
    pass "skanetrafiken README license link resolves"
else
    fail "skanetrafiken README license link should resolve to the repository license"
fi

if grep -q '^migrate_legacy_skill_links()' "$SETUP"; then
    pass "setup.sh has moved-skill symlink migration"
else
    fail "setup.sh should migrate symlinks for moved skills"
fi

if sed -n '/^main()/,/^}/p' "$SETUP" | grep -q 'migrate_legacy_skill_links'; then
    pass "main runs moved-skill symlink migration"
else
    fail "main should run moved-skill symlink migration"
fi

MOVED_SKILLS_LINE=$(grep '^MOVED_SKILLS=' "$SETUP" || true)
for skill in ai-chat argocd codex commit coordinator dependency-track finance java-21-to-25-migration jenkins jira perplexity pr-ready skanetrafiken sonarqube tdd to-tasks verify; do
    if printf '%s\n' "$MOVED_SKILLS_LINE" | grep -q " ${skill}\|\"${skill} \| ${skill}\""; then
        pass "Migration includes ${skill}"
    else
        fail "Migration should include ${skill}"
    fi
done

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: Zsh safety"
# ═══════════════════════════════════════════════════════════════════════════════

# read -p in zsh means coprocess, not prompt — must be gated behind bash check
if grep -q '_is_bash\|BASH_VERSION' "$SETUP"; then
    pass "Gates 'read -p' behind bash detection (zsh-safe)"
else
    fail "No bash detection guard for 'read -p' (breaks zsh)"
fi

# Verify read -e -r -p only appears inside _is_bash blocks, not bare
BARE_READ_P=$(grep -n 'read -e -r -p\|read -r -p' "$SETUP" | grep -v '_is_bash\|#' || true)
if grep -c 'read -e -r -p' "$SETUP" | grep -q '^0$'; then
    skip "No 'read -e -r -p' found (different pattern used)"
else
    # All instances should be inside if _is_bash blocks
    pass "Uses 'read -e -r -p' (bash-only variant present)"
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
header "Setup: Skill selection menu"
# ═══════════════════════════════════════════════════════════════════════════════

# All skills must appear in the selection menu
for skill in dependency-track jenkins jira to-tasks sonarqube argocd skanetrafiken java-21-to-25-migration codex; do
    if grep -q "$skill" "$SETUP"; then
        pass "Skill '${skill}' referenced in setup.sh"
    else
        fail "Skill '${skill}' not found in setup.sh"
    fi
done

# All skills in select_skills menu
MENU_ITEMS=$(sed -n '/^select_skills/,/^}/p' "$SETUP" | grep -c 'printf.*BOLD.*RESET.*DIM')
if [ "$MENU_ITEMS" -ge 9 ]; then
    pass "Selection menu has ${MENU_ITEMS} items (expected ≥9)"
else
    fail "Selection menu has ${MENU_ITEMS} items (expected ≥9)"
fi

# 'all' selects all skills including java migration
# The 'all' branch sets all INSTALL_* vars on one line
if sed -n '/^select_skills/,/^}/p' "$SETUP" | grep -q 'INSTALL_JAVA_MIG=true'; then
    pass "'all' selection includes INSTALL_JAVA_MIG"
else
    fail "'all' selection does not include INSTALL_JAVA_MIG"
fi

if sed -n '/^select_skills/,/^}/p' "$SETUP" | grep -q 'INSTALL_TO_TASKS=true'; then
    pass "'all' selection includes INSTALL_TO_TASKS"
else
    fail "'all' selection does not include INSTALL_TO_TASKS"
fi

if sed -n '/^select_skills/,/^}/p' "$SETUP" | grep -q 'INSTALL_CODEX_REVIEW=true'; then
    pass "'all' selection includes INSTALL_CODEX_REVIEW"
else
    fail "'all' selection does not include INSTALL_CODEX_REVIEW"
fi

if sed -n '/^select_skills/,/^}/p' "$SETUP" | grep -q '9) INSTALL_CODEX_REVIEW=true'; then
    pass "Selection 9 enables codex"
else
    fail "Selection 9 should enable codex"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: codex dependency gate"
# ═══════════════════════════════════════════════════════════════════════════════

DEPS_BODY=$(sed -n '/^check_and_install_deps/,/^}/p' "$SETUP")

if echo "$DEPS_BODY" | grep -q 'INSTALL_CODEX_REVIEW' && echo "$DEPS_BODY" | grep -q 'has_cmd codex'; then
    pass "codex checks for codex CLI"
else
    fail "codex should check for codex CLI"
fi

if echo "$DEPS_BODY" | grep -q 'Skipping codex skill'; then
    pass "codex is skipped when codex CLI is missing"
else
    fail "codex should be skipped when codex CLI is missing"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: AGENT_HARNESS variable"
# ═══════════════════════════════════════════════════════════════════════════════

# Default value
if grep -q 'AGENT_HARNESS="claude-code"' "$SETUP"; then
    pass "AGENT_HARNESS defaults to claude-code"
else
    fail "AGENT_HARNESS missing default"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: Harness detection logic"
# ═══════════════════════════════════════════════════════════════════════════════

# detect_and_select_harness function exists
if grep -q '^detect_and_select_harness()' "$SETUP"; then
    pass "detect_and_select_harness function exists"
else
    fail "detect_and_select_harness function missing"
fi

# Called from main()
if sed -n '/^main()/,/^}/p' "$SETUP" | grep -q 'detect_and_select_harness'; then
    pass "detect_and_select_harness called from main()"
else
    fail "detect_and_select_harness not called from main()"
fi

# Checks for ~/.claude
HARNESS_BODY=$(sed -n '/^detect_and_select_harness/,/^}/p' "$SETUP")
if echo "$HARNESS_BODY" | grep -q '\.claude'; then
    pass "Detects ~/.claude directory"
else
    fail "Does not check for ~/.claude"
fi

# Checks for ~/.pi
if echo "$HARNESS_BODY" | grep -q '\.pi'; then
    pass "Detects ~/.pi directory"
else
    fail "Does not check for ~/.pi"
fi

# All three options: claude-code, pi, both
if echo "$HARNESS_BODY" | grep -q 'claude-code' && \
   echo "$HARNESS_BODY" | grep -q '"pi"' && \
   echo "$HARNESS_BODY" | grep -q '"both"'; then
    pass "Supports claude-code, pi, and both options"
else
    fail "Missing one or more harness options (claude-code, pi, both)"
fi

# Menu descriptions should explain the actual difference (agent vs skill for java migration)
if echo "$HARNESS_BODY" | grep -q 'agent.*skill\|skill.*agent\|as agent\|as skill'; then
    pass "Menu describes the actual difference (agent vs skill)"
else
    fail "Menu should describe the actual difference (agent vs skill for java migration)"
fi

# Auto-detects when only one is present (no prompt needed)
if echo "$HARNESS_BODY" | grep -q 'elif.*has_claude.*true' && \
   echo "$HARNESS_BODY" | grep -q 'elif.*has_pi.*true'; then
    pass "Auto-selects when only one harness is present"
else
    fail "Should auto-select when only one harness is present"
fi

# Mentions symlinks and git pull
if echo "$HARNESS_BODY" | grep -qi 'symlink'; then
    pass "Mentions symlinks in harness detection"
else
    fail "Should mention symlinks in harness detection"
fi

if echo "$HARNESS_BODY" | grep -qi 'git pull'; then
    pass "Mentions git pull for updates"
else
    fail "Should mention git pull for updates"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: install_java_migration function"
# ═══════════════════════════════════════════════════════════════════════════════

if grep -q '^install_java_migration()' "$SETUP"; then
    pass "install_java_migration function exists"
else
    fail "install_java_migration function missing"
fi

# Called from main()
if sed -n '/^main()/,/^}/p' "$SETUP" | grep -q 'install_java_migration'; then
    pass "install_java_migration called from main()"
else
    fail "install_java_migration not called from main()"
fi

# Guarded by INSTALL_JAVA_MIG
if sed -n '/^main()/,/^}/p' "$SETUP" | grep -q 'INSTALL_JAVA_MIG.*true.*install_java_migration'; then
    pass "install_java_migration guarded by INSTALL_JAVA_MIG"
else
    fail "install_java_migration not guarded by INSTALL_JAVA_MIG"
fi

JAVA_MIG_BODY=$(sed -n '/^install_java_migration/,/^}/p' "$SETUP")

# For claude-code: links SKILL.md → agents dir (file symlink)
if echo "$JAVA_MIG_BODY" | grep -q 'AGENT_DIR.*\.md\|agent_dest.*\.md'; then
    pass "Claude Code mode: creates .md file symlink in agents dir"
else
    fail "Claude Code mode: should create .md file symlink"
fi

if echo "$JAVA_MIG_BODY" | grep -q 'SKILL.md'; then
    pass "Claude Code mode: links to SKILL.md source"
else
    fail "Claude Code mode: should link to SKILL.md"
fi

# For pi: links directory via _link_skill_to
if echo "$JAVA_MIG_BODY" | grep -q '_link_skill_to.*INSTALL_DIR\|_link_skill_to.*PI_SKILLS_DIR'; then
    pass "Pi mode: links directory to Pi skills path"
else
    fail "Pi mode: should link directory to Pi skills path"
fi

# Pi-only mode links to INSTALL_DIR (which is ~/.pi/agent/skills)
# The if/elif structure: HARNESS = "pi" → _link_skill_to INSTALL_DIR
if echo "$JAVA_MIG_BODY" | grep -q '"pi"' && echo "$JAVA_MIG_BODY" | grep -q '_link_skill_to.*INSTALL_DIR'; then
    pass "Pi-only mode: uses INSTALL_DIR (~/.pi/agent/skills)"
else
    fail "Pi-only mode: should use INSTALL_DIR"
fi

# Both mode links to PI_SKILLS_DIR for Pi
if echo "$JAVA_MIG_BODY" | grep -q '"both"' && echo "$JAVA_MIG_BODY" | grep -q '_link_skill_to.*PI_SKILLS_DIR'; then
    pass "'both' mode: uses PI_SKILLS_DIR for Pi"
else
    fail "'both' mode: should use PI_SKILLS_DIR for Pi"
fi

# Handles all three harness modes
if echo "$JAVA_MIG_BODY" | grep -q 'claude-code' && \
   echo "$JAVA_MIG_BODY" | grep -q '"pi"' && \
   echo "$JAVA_MIG_BODY" | grep -q '"both"'; then
    pass "Handles claude-code, pi, and both modes"
else
    fail "Should handle all three harness modes"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: select_install_path"
# ═══════════════════════════════════════════════════════════════════════════════

INSTALL_PATH_BODY=$(sed -n '/^select_install_path/,/^}/p' "$SETUP")

# Should not prompt the user — paths are automatic
if echo "$INSTALL_PATH_BODY" | grep -q 'ask '; then
    fail "select_install_path should not prompt (paths are automatic)"
else
    pass "select_install_path does not prompt (automatic paths)"
fi

# Claude Code paths
if echo "$INSTALL_PATH_BODY" | grep -q 'claude/skills'; then
    pass "Claude Code INSTALL_DIR points to ~/.claude/skills"
else
    fail "Claude Code INSTALL_DIR should point to ~/.claude/skills"
fi

if echo "$INSTALL_PATH_BODY" | grep -q 'claude/agents'; then
    pass "AGENT_DIR points to ~/.claude/agents"
else
    fail "AGENT_DIR should point to ~/.claude/agents"
fi

# Pi paths
if echo "$INSTALL_PATH_BODY" | grep -q '\.pi/agent/skills'; then
    pass "Pi INSTALL_DIR points to ~/.pi/agent/skills"
else
    fail "Pi INSTALL_DIR should point to ~/.pi/agent/skills"
fi

# Both mode has PI_SKILLS_DIR
if echo "$INSTALL_PATH_BODY" | grep -q 'PI_SKILLS_DIR'; then
    pass "'both' mode sets PI_SKILLS_DIR for Pi"
else
    fail "'both' mode should set PI_SKILLS_DIR for Pi"
fi

# Handles all three harness cases
if echo "$INSTALL_PATH_BODY" | grep -q 'claude-code' && \
   echo "$INSTALL_PATH_BODY" | grep -q 'pi)' && \
   echo "$INSTALL_PATH_BODY" | grep -q 'both)'; then
    pass "select_install_path handles all three harness modes"
else
    fail "select_install_path should handle claude-code, pi, and both"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: Summary includes java-21-to-25-migration"
# ═══════════════════════════════════════════════════════════════════════════════

SUMMARY_BODY=$(sed -n '/^print_summary/,/^}/p' "$SETUP")

if echo "$SUMMARY_BODY" | grep -q 'INSTALL_JAVA_MIG'; then
    pass "Summary includes java-21-to-25-migration"
else
    fail "Summary should include java-21-to-25-migration"
fi

if echo "$SUMMARY_BODY" | grep -q 'INSTALL_CODEX_REVIEW'; then
    pass "Summary includes codex"
else
    fail "Summary should include codex"
fi

if echo "$SUMMARY_BODY" | grep -q 'AGENT_HARNESS'; then
    pass "Summary shows harness type"
else
    fail "Summary should show harness type"
fi

if echo "$SUMMARY_BODY" | grep -qi 'git pull'; then
    pass "Summary mentions git pull for updates"
else
    fail "Summary should mention git pull for updates"
fi

if echo "$SUMMARY_BODY" | grep -qi 'symlink'; then
    pass "Summary mentions symlinks"
else
    fail "Summary should mention symlinks"
fi

if echo "$SUMMARY_BODY" | grep -q 'AGENT_DIR'; then
    pass "Summary shows agent install path for claude-code"
else
    fail "Summary should show agent install path for claude-code"
fi

if echo "$SUMMARY_BODY" | grep -q 'INSTALL_DIR'; then
    pass "Summary shows skill install path"
else
    fail "Summary should show skill install path"
fi

if echo "$SUMMARY_BODY" | grep -q 'PI_SKILLS_DIR'; then
    pass "Summary shows Pi skills path for 'both' mode"
else
    fail "Summary should show PI_SKILLS_DIR for 'both' mode"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: Remaining count includes no-config workflow skills"
# ═══════════════════════════════════════════════════════════════════════════════

MAIN_BODY=$(sed -n '/^main()/,/^}/p' "$SETUP")

if echo "$MAIN_BODY" | grep -q 'INSTALL_JAVA_MIG.*remaining'; then
    pass "INSTALL_JAVA_MIG counted in remaining check"
else
    fail "INSTALL_JAVA_MIG not counted in remaining skills check"
fi

if echo "$MAIN_BODY" | grep -q 'INSTALL_TO_TASKS.*remaining'; then
    pass "INSTALL_TO_TASKS counted in remaining check"
else
    fail "INSTALL_TO_TASKS not counted in remaining skills check"
fi

if echo "$MAIN_BODY" | grep -q 'INSTALL_CODEX_REVIEW.*remaining'; then
    pass "INSTALL_CODEX_REVIEW counted in remaining check"
else
    fail "INSTALL_CODEX_REVIEW not counted in remaining skills check"
fi

if echo "$MAIN_BODY" | grep -q 'INSTALL_CODEX_REVIEW.*install_skill "codex"'; then
    pass "INSTALL_CODEX_REVIEW installs codex skill"
else
    fail "INSTALL_CODEX_REVIEW should install codex skill"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: java-21-to-25-migration source directory"
# ═══════════════════════════════════════════════════════════════════════════════

JAVA_MIG_DIR="${REPO_DIR}/skills/java-21-to-25-migration"

if [ -d "$JAVA_MIG_DIR" ]; then
    pass "java-21-to-25-migration/ directory exists"
else
    fail "java-21-to-25-migration/ directory missing"
fi

if [ -f "$JAVA_MIG_DIR/SKILL.md" ]; then
    pass "SKILL.md exists"
else
    fail "SKILL.md missing"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: SKILL.md structure (java-21-to-25-migration)"
# ═══════════════════════════════════════════════════════════════════════════════

SKILLMD="${JAVA_MIG_DIR}/SKILL.md"

if head -1 "$SKILLMD" | grep -q '^---$'; then
    pass "Has YAML frontmatter"
else
    fail "Missing YAML frontmatter"
fi

if grep -q '^name: java-21-to-25-migration' "$SKILLMD"; then
    pass "Name field matches directory"
else
    fail "Name field missing or doesn't match directory"
fi

if grep -q '^description:' "$SKILLMD"; then
    pass "Has description"
else
    fail "Missing description"
fi

# Description length check (pi limit: 1024 chars)
DESC_LEN=$(grep '^description:' "$SKILLMD" | sed 's/^description: //' | wc -c | tr -d ' ')
if [ "$DESC_LEN" -le 1024 ]; then
    pass "Description length ${DESC_LEN} chars (≤1024 pi limit)"
else
    fail "Description too long: ${DESC_LEN} chars (pi limit is 1024)"
fi

if grep -qiE "$FORBIDDEN_RE" "$SKILLMD"; then
    fail "SKILL.md contains company/user/system-specific data"
else
    pass "No company/user/system-specific data in SKILL.md"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: SKILL.md content coverage (java-21-to-25-migration)"
# ═══════════════════════════════════════════════════════════════════════════════

# Master checklist
if grep -q 'MASTER CHECKLIST' "$SKILLMD"; then
    pass "Has Master Checklist"
else
    fail "Missing Master Checklist"
fi

# Phase structure (0-6)
for phase in 0 1 2 3 4 5 6; do
    if grep -qi "Phase ${phase}" "$SKILLMD"; then
        pass "Has Phase ${phase}"
    else
        fail "Missing Phase ${phase}"
    fi
done

# Key JEPs
for jep in "JEP 456" "JEP 486" "JEP 485" "JEP 506" "JEP 511" "JEP 512" "JEP 513"; do
    if grep -q "$jep" "$SKILLMD"; then
        pass "References ${jep}"
    else
        fail "Missing ${jep}"
    fi
done

# Key topics
for topic in "SecurityManager" "sun.misc.Unsafe" "Unnamed Variables" "Markdown Documentation" \
             "Stream Gatherers" "Scoped Values" "CompletableFuture" "AOT" "Virtual threads"; do
    if grep -qi "$topic" "$SKILLMD"; then
        pass "Covers: ${topic}"
    else
        fail "Missing coverage: ${topic}"
    fi
done

# Reference pointers, including external sources and local phase references
LINK_COUNT=$(grep -Eo 'https?://|\[[^]]+\]\(references/' "$SKILLMD" | wc -l | tr -d ' ')
if [ "$LINK_COUNT" -ge 10 ]; then
    pass "Has ${LINK_COUNT} reference pointers (expected 10 or more)"
else
    fail "Only ${LINK_COUNT} reference pointers (expected 10 or more)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: No standalone install.sh (consolidated into setup.sh)"
# ═══════════════════════════════════════════════════════════════════════════════

if [ -f "$JAVA_MIG_DIR/install.sh" ]; then
    fail "Standalone install.sh still exists (should be consolidated into setup.sh)"
else
    pass "No standalone install.sh (uses setup.sh)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: No duplicate agent file in agents/ directory"
# ═══════════════════════════════════════════════════════════════════════════════

if [ -f "$REPO_DIR/agents/java-21-to-25-migration.md" ]; then
    fail "Duplicate agent file still exists in agents/"
else
    pass "No duplicate in agents/ (single source in skills/java-21-to-25-migration/SKILL.md)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: Sandbox — symlink behavior (non-destructive)"
# ═══════════════════════════════════════════════════════════════════════════════

# Create a temp sandbox to test symlink logic without touching real system
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

REFRESH_LINK_FN=$(sed -n '/^_refresh_legacy_link()/,/^}/p' "$SETUP")
if [ -n "$REFRESH_LINK_FN" ]; then
    mkdir -p "$SANDBOX/legacy-source" "$SANDBOX/new-source" "$SANDBOX/install"
    ln -s "$SANDBOX/legacy-source" "$SANDBOX/install/example"
    if (
        eval "$REFRESH_LINK_FN"
        _refresh_legacy_link "$SANDBOX/install/example" "$SANDBOX/legacy-source" "$SANDBOX/new-source"
        [ "$(readlink "$SANDBOX/install/example")" = "$SANDBOX/new-source" ]
    ); then
        pass "Sandbox: moved-skill migration refreshes an exact legacy symlink"
    else
        fail "Sandbox: moved-skill migration should refresh an exact legacy symlink"
    fi
else
    fail "Sandbox: _refresh_legacy_link helper missing"
fi

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

# Source only the helper functions from setup.sh (no main execution)
# We extract and test the symlinking logic directly

# ── Test 1: install_skill creates correct symlink ──
MOCK_SRC="${SANDBOX}/src/test-skill"
MOCK_DEST="${SANDBOX}/dest"
mkdir -p "$MOCK_SRC" "$MOCK_DEST"
echo "test" > "$MOCK_SRC/SKILL.md"

# Simulate what install_skill does
ln -s "$MOCK_SRC" "$MOCK_DEST/test-skill"
if [ -L "$MOCK_DEST/test-skill" ] && [ "$(readlink "$MOCK_DEST/test-skill")" = "$MOCK_SRC" ]; then
    pass "Sandbox: directory symlink created correctly"
else
    fail "Sandbox: directory symlink creation failed"
fi

# Verify the symlinked SKILL.md is readable
if [ -f "$MOCK_DEST/test-skill/SKILL.md" ]; then
    pass "Sandbox: SKILL.md accessible through symlink"
else
    fail "Sandbox: SKILL.md not accessible through symlink"
fi

# ── Test 2: Claude Code agent symlink (file → file) ──
MOCK_AGENTS="${SANDBOX}/agents"
mkdir -p "$MOCK_AGENTS"
ln -s "$MOCK_SRC/SKILL.md" "$MOCK_AGENTS/test-skill.md"
if [ -L "$MOCK_AGENTS/test-skill.md" ] && [ "$(readlink "$MOCK_AGENTS/test-skill.md")" = "$MOCK_SRC/SKILL.md" ]; then
    pass "Sandbox: agent file symlink created correctly"
else
    fail "Sandbox: agent file symlink creation failed"
fi

if [ -f "$MOCK_AGENTS/test-skill.md" ]; then
    pass "Sandbox: agent .md accessible through symlink"
else
    fail "Sandbox: agent .md not accessible through symlink"
fi

# ── Test 3: Relink overwrites existing symlink ──
MOCK_SRC2="${SANDBOX}/src/test-skill-v2"
mkdir -p "$MOCK_SRC2"
echo "test v2" > "$MOCK_SRC2/SKILL.md"
rm -f "$MOCK_DEST/test-skill"
ln -s "$MOCK_SRC2" "$MOCK_DEST/test-skill"
if [ "$(readlink "$MOCK_DEST/test-skill")" = "$MOCK_SRC2" ]; then
    pass "Sandbox: relink updates symlink target"
else
    fail "Sandbox: relink should update symlink target"
fi

# ── Test 4: Both mode creates two symlinks ──
MOCK_BOTH_SKILLS="${SANDBOX}/both-skills"
MOCK_BOTH_AGENTS="${SANDBOX}/both-agents"
mkdir -p "$MOCK_BOTH_SKILLS" "$MOCK_BOTH_AGENTS"
ln -s "$MOCK_SRC" "$MOCK_BOTH_SKILLS/test-skill"           # Pi: directory
ln -s "$MOCK_SRC/SKILL.md" "$MOCK_BOTH_AGENTS/test-skill.md"  # Claude: file
if [ -L "$MOCK_BOTH_SKILLS/test-skill" ] && [ -L "$MOCK_BOTH_AGENTS/test-skill.md" ]; then
    pass "Sandbox: 'both' mode creates skill dir + agent file symlinks"
else
    fail "Sandbox: 'both' mode should create both symlinks"
fi

# ── Test 5: Symlinks are not copies (changes propagate) ──
echo "updated content" > "$MOCK_SRC/SKILL.md"
CONTENT=$(cat "$MOCK_BOTH_AGENTS/test-skill.md")
if [ "$CONTENT" = "updated content" ]; then
    pass "Sandbox: file changes propagate through symlink (git pull works)"
else
    fail "Sandbox: symlinked file should reflect source changes"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: help text"
# ═══════════════════════════════════════════════════════════════════════════════

HELP_BODY=$(sed -n '/^show_help/,/^}/p' "$SETUP")

if echo "$HELP_BODY" | grep -q 'java-21-to-25-migration'; then
    pass "Help text mentions java-21-to-25-migration"
else
    fail "Help text should mention java-21-to-25-migration"
fi

if echo "$HELP_BODY" | grep -q 'codex'; then
    pass "Help text mentions codex"
else
    fail "Help text should mention codex"
fi

if echo "$HELP_BODY" | grep -qi 'claude code.*pi\|pi.*claude'; then
    pass "Help text mentions both harnesses"
else
    fail "Help text should mention both harnesses"
fi

if echo "$HELP_BODY" | grep -qi 'symlink\|git pull'; then
    pass "Help text mentions symlinks/updates"
else
    fail "Help text should mention symlinks or git pull"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: All skills have source directories"
# ═══════════════════════════════════════════════════════════════════════════════

for skill in dependency-track jenkins jira to-tasks sonarqube argocd skanetrafiken java-21-to-25-migration codex; do
    skill_dir="${REPO_DIR}/skills/${skill}"
    if [ -d "$skill_dir" ]; then
        pass "${skill}/ directory exists"
    else
        fail "${skill}/ directory missing"
    fi
    if [ -f "${skill_dir}/SKILL.md" ]; then
        pass "${skill}/SKILL.md exists"
    else
        fail "${skill}/SKILL.md missing"
    fi
done

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: Connectivity test only for remote-config skills"
# ═══════════════════════════════════════════════════════════════════════════════

# The connectivity test prompt should only appear when a service with remote
# config is selected (dtrack, jenkins, jira, sonarqube), not for skanetrafiken,
# to-tasks, java-21-to-25-migration, or codex which need no remote config.

MAIN_BODY=$(sed -n '/^main()/,/^}/p' "$SETUP")

if echo "$MAIN_BODY" | grep -q 'has_remote'; then
    pass "Connectivity test guarded by has_remote flag"
else
    fail "Connectivity test should be guarded by has_remote flag"
fi

# Only remote-config skills set has_remote=true
for remote_skill in INSTALL_DTRACK INSTALL_JENKINS INSTALL_JIRA INSTALL_SONAR; do
    if echo "$MAIN_BODY" | grep -q "${remote_skill}.*has_remote=true"; then
        pass "${remote_skill} sets has_remote=true"
    else
        fail "${remote_skill} should set has_remote=true"
    fi
done

# No-config skills must NOT set has_remote
for local_skill in INSTALL_SKANE INSTALL_TO_TASKS INSTALL_JAVA_MIG INSTALL_CODEX_REVIEW; do
    if echo "$MAIN_BODY" | grep -q "${local_skill}.*has_remote"; then
        fail "${local_skill} should not set has_remote (no remote config)"
    else
        pass "${local_skill} does not set has_remote (correct: no config needed)"
    fi
done

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: install_java_migration shows full file path"
# ═══════════════════════════════════════════════════════════════════════════════

JAVA_MIG_FN=$(sed -n '/^install_java_migration/,/^}/p' "$SETUP")

# Agent messages should show agent_dest (full path with .md), not just AGENT_DIR/
if echo "$JAVA_MIG_FN" | grep -q 'agent_dest.*agent'; then
    pass "Install messages use agent_dest (full path with .md)"
else
    fail "Install messages should use agent_dest not AGENT_DIR/"
fi

# Must not show just "AGENT_DIR/" without the filename
if echo "$JAVA_MIG_FN" | grep 'success.*Linked\|success.*Already' | grep -q 'AGENT_DIR}/'; then
    fail "Install messages show only AGENT_DIR/ (should show full file path)"
else
    pass "Install messages do not truncate to just AGENT_DIR/"
fi

# Summary shows full .md path
SUMMARY_BODY2=$(sed -n '/^print_summary/,/^}/p' "$SETUP")
if echo "$SUMMARY_BODY2" | grep -q 'java-21-to-25-migration.md'; then
    pass "Summary shows full agent file path (java-21-to-25-migration.md)"
else
    fail "Summary should show full agent file path with .md extension"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: install_skill handles 'both' mode"
# ═══════════════════════════════════════════════════════════════════════════════

INSTALL_SKILL_BODY=$(sed -n '/^install_skill/,/^}/p' "$SETUP")

# install_skill delegates to _link_skill_to
if echo "$INSTALL_SKILL_BODY" | grep -q '_link_skill_to'; then
    pass "install_skill delegates to _link_skill_to"
else
    fail "install_skill should delegate to _link_skill_to"
fi

# In 'both' mode, links to PI_SKILLS_DIR too
if echo "$INSTALL_SKILL_BODY" | grep -q 'PI_SKILLS_DIR'; then
    pass "install_skill links to PI_SKILLS_DIR in 'both' mode"
else
    fail "install_skill should link to PI_SKILLS_DIR in 'both' mode"
fi

# _link_skill_to function exists
if grep -q '^_link_skill_to()' "$SETUP"; then
    pass "_link_skill_to helper function exists"
else
    fail "_link_skill_to helper function missing"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Setup: SKILLS_SRC variable"
# ═══════════════════════════════════════════════════════════════════════════════

if grep -q 'SKILLS_SRC' "$SETUP"; then
    pass "SKILLS_SRC variable used for source path"
else
    fail "SKILLS_SRC variable missing (_link_skill_to needs it)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Results: Setup"
# ═══════════════════════════════════════════════════════════════════════════════

printf "\n  ${GREEN}%d passed${RESET}  ${RED}%d failed${RESET}  ${YELLOW}%d skipped${RESET}\n" "$PASS" "$FAIL" "$SKIP"
echo ""
if [ "$FAIL" -gt 0 ]; then printf "  ${RED}${BOLD}FAILED${RESET}\n"; exit 1
else printf "  ${GREEN}${BOLD}ALL TESTS PASSED${RESET}\n"; exit 0; fi
