#!/bin/bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/forbidden.sh"
# Master test runner for boring-but-good
# Runs all per-skill test suites and reports combined results.
#
# Usage: ./test-all.sh
# Read-only live tests run automatically for any configured service.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

TOTAL_PASS=0; TOTAL_FAIL=0; TOTAL_SKIP=0; SUITE_FAIL=0

echo ""
printf "${BOLD}Boring Skills — Full Test Suite${RESET}\n"
printf "${DIM}Read-only live tests run automatically for configured services.${RESET}\n"

run_suite() {
    local name="$1" test_file="$2"

    echo ""
    printf "${BOLD}┌─────────────────────────────────────────────┐${RESET}\n"
    printf "${BOLD}│  %-43s │${RESET}\n" "$name"
    printf "${BOLD}└─────────────────────────────────────────────┘${RESET}\n"

    if [ ! -f "$test_file" ]; then
        printf "  ${YELLOW}○${RESET} Test file not found: %s ${DIM}(skipped)${RESET}\n" "$test_file"
        TOTAL_SKIP=$((TOTAL_SKIP + 1))
        return
    fi

    chmod +x "$test_file"
    local output rc
    output=$("$test_file" 2>&1)
    rc=$?

    echo "$output"

    # Extract counts from the "Results" line
    local p f s
    p=$(echo "$output" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' | tail -1)
    f=$(echo "$output" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' | tail -1)
    s=$(echo "$output" | grep -oE '[0-9]+ skipped' | grep -oE '[0-9]+' | tail -1)

    TOTAL_PASS=$((TOTAL_PASS + ${p:-0}))
    TOTAL_FAIL=$((TOTAL_FAIL + ${f:-0}))
    TOTAL_SKIP=$((TOTAL_SKIP + ${s:-0}))

    if [ $rc -ne 0 ]; then
        SUITE_FAIL=$((SUITE_FAIL + 1))
    fi
}

# ── Run all suites ──────────────────────────────────────────────────────────

run_suite "Setup"             "$SCRIPT_DIR/test-setup.sh"
run_suite "Jira"              "$SCRIPT_DIR/test-jira.sh"
run_suite "Jenkins"           "$SCRIPT_DIR/test-jenkins.sh"
run_suite "SonarQube"         "$SCRIPT_DIR/test-sonarqube.sh"
run_suite "Dependency-Track"  "$SCRIPT_DIR/test-dependency-track.sh"
run_suite "ArgoCD"            "$SCRIPT_DIR/test-argocd.sh"
run_suite "Codex"             "$SCRIPT_DIR/test-codex-review.sh"

# ── Global cross-skill checks ──────────────────────────────────────────────

echo ""
printf "${BOLD}━━━ Cross-skill checks ━━━${RESET}\n"

REPO_DIR="${SCRIPT_DIR}/.."
CROSS_FAIL=0

# Only scan directories that contain a SKILL.md (actual skills)
SKILL_DIRS=""
while IFS= read -r skillmd; do
    SKILL_DIRS="$SKILL_DIRS $(dirname "$skillmd")"
done < <(find "$REPO_DIR" -mindepth 2 -maxdepth 3 -name SKILL.md -type f | sort)

# Check no company/user/system-specific data anywhere in skill dirs
LEAKS=""
for d in $SKILL_DIRS; do
    found=$(grep -rniE "$FORBIDDEN_RE" "$d" --include='*.sh' --include='*.md' --exclude-dir=node_modules 2>/dev/null)
    [ -n "$found" ] && LEAKS="${LEAKS}${found}\n"
done
if [ -n "$LEAKS" ]; then
    printf "  ${RED}FAIL${RESET} Company/user-specific data found:\n"
    printf "$LEAKS" | while IFS= read -r line; do printf "    ${DIM}%s${RESET}\n" "$line"; done
    CROSS_FAIL=$((CROSS_FAIL + 1))
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
else
    printf "  ${GREEN}OK${RESET}   No company/user-specific data in any skill\n"
    TOTAL_PASS=$((TOTAL_PASS + 1))
fi

# Check no hardcoded home directory paths
PATHS=""
for d in $SKILL_DIRS; do
    found=$(grep -rnE '/Users/[a-z]|/home/[a-z]' "$d" --include='*.sh' --include='*.md' --exclude-dir=node_modules 2>/dev/null)
    [ -n "$found" ] && PATHS="${PATHS}${found}\n"
done
if [ -n "$PATHS" ]; then
    printf "  ${RED}FAIL${RESET} Hardcoded home directory paths found:\n"
    printf "$PATHS" | while IFS= read -r line; do printf "    ${DIM}%s${RESET}\n" "$line"; done
    CROSS_FAIL=$((CROSS_FAIL + 1))
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
else
    printf "  ${GREEN}OK${RESET}   No hardcoded home directory paths\n"
    TOTAL_PASS=$((TOTAL_PASS + 1))
fi

# Check setup.sh gates read -p behind a bash-only check (broken in zsh — -p means coprocess)
if [ -f "$REPO_DIR/setup.sh" ]; then
    if grep -q '_is_bash\|BASH_VERSION' "$REPO_DIR/setup.sh"; then
        printf "  ${GREEN}OK${RESET}   setup.sh: gates 'read -p' behind bash detection (zsh-safe)\n"
        TOTAL_PASS=$((TOTAL_PASS + 1))
    else
        printf "  ${RED}FAIL${RESET} setup.sh: no bash detection guard for 'read -p' (breaks zsh)\n"
        TOTAL_FAIL=$((TOTAL_FAIL + 1))
        CROSS_FAIL=$((CROSS_FAIL + 1))
    fi
fi

# Check all SKILL.md files have valid frontmatter
for skill_dir in $SKILL_DIRS; do
    skill_name=$(basename "$skill_dir")
    skillmd="${skill_dir}/SKILL.md"

    # Name in frontmatter matches directory
    name_val=$(sed -n '2,/^---$/p' "$skillmd" | sed '$d' | grep "^name:" | sed 's/^name: *//')
    if [ "$name_val" = "$skill_name" ]; then
        printf "  ${GREEN}OK${RESET}   ${skill_name}: SKILL.md name matches directory\n"
        TOTAL_PASS=$((TOTAL_PASS + 1))
    else
        printf "  ${RED}FAIL${RESET} ${skill_name}: SKILL.md name '${name_val}' doesn't match directory\n"
        TOTAL_FAIL=$((TOTAL_FAIL + 1))
        CROSS_FAIL=$((CROSS_FAIL + 1))
    fi

    # All referenced scripts exist
    while IFS= read -r ref; do
        ref_path="${skill_dir}/${ref}"
        if [ -f "$ref_path" ] || [ -d "$ref_path" ]; then
            : # OK
        else
            printf "  ${RED}FAIL${RESET} ${skill_name}: broken reference '${ref}' in SKILL.md\n"
            TOTAL_FAIL=$((TOTAL_FAIL + 1))
            CROSS_FAIL=$((CROSS_FAIL + 1))
        fi
    done < <(grep -oE '(scripts|references|assets)/[a-zA-Z0-9_./-]+' "$skillmd" 2>/dev/null | sort -u)
done

# ── Summary ─────────────────────────────────────────────────────────────────

echo ""
printf "${BOLD}═══════════════════════════════════════════════${RESET}\n"
printf "${BOLD}  TOTAL: ${GREEN}%d passed${RESET}  ${RED}%d failed${RESET}  ${YELLOW}%d skipped${RESET}\n" "$TOTAL_PASS" "$TOTAL_FAIL" "$TOTAL_SKIP"
printf "${BOLD}═══════════════════════════════════════════════${RESET}\n"
echo ""

OVERALL_FAIL=$((SUITE_FAIL + CROSS_FAIL))
if [ $OVERALL_FAIL -gt 0 ]; then
    printf "  ${RED}${BOLD}FAILED${RESET} (${OVERALL_FAIL} suite(s) with failures)\n"
    exit 1
else
    printf "  ${GREEN}${BOLD}ALL TESTS PASSED${RESET}\n"
    exit 0
fi
