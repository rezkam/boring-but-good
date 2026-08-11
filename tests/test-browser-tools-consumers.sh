#!/bin/bash
# Offline regression checks for consumers of the extracted Browser Tools package.
# This suite reads tracked files only and makes no network requests.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${SCRIPT_DIR}/.."

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; RESET='\033[0m'
PASS=0; FAIL=0; SKIP=0

pass() { PASS=$((PASS + 1)); printf "  ${GREEN}OK${RESET}   %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${RESET} %s\n" "$1"; [ -n "${2:-}" ] && printf "    %s\n" "$2"; }
header() { echo ""; printf "${BOLD}━━━ %s ━━━${RESET}\n" "$1"; }

header "Browser Tools package consumers"

for consumer in ai-chat finance perplexity; do
    consumer_dir="${REPO_DIR}/skills/${consumer}"

    if node - "$consumer_dir" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifest.dependencies?.['@rezkam/browser-tools'] !== '^1.0.2') process.exit(1);
NODE
    then
        pass "${consumer} declares @rezkam/browser-tools ^1.0.2"
    else
        fail "${consumer} should declare @rezkam/browser-tools ^1.0.2"
    fi

    if node - "$consumer_dir" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const entry = lock.packages?.['node_modules/@rezkam/browser-tools'];
if (lock.packages?.['']?.dependencies?.['@rezkam/browser-tools'] !== '^1.0.2') process.exit(1);
if (entry?.version !== '1.0.2') process.exit(1);
if (entry?.resolved !== 'https://registry.npmjs.org/@rezkam/browser-tools/-/browser-tools-1.0.2.tgz') process.exit(1);
NODE
    then
        pass "${consumer} locks Browser Tools 1.0.2 from the npm registry"
    else
        fail "${consumer} should lock Browser Tools 1.0.2 from the npm registry"
    fi

    if node - "$consumer_dir" <<'NODE'
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const manifest = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
const lock = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8');
const localProtocol = /(?:file|link|workspace):/;
if (localProtocol.test(manifest) || localProtocol.test(lock)) process.exit(1);

const fallbackPatterns = [
  /BROWSER_TOOLS_DIR/,
  /boring-but-good[\\/]browser-tools/,
  /(?:\.\.[\\/])+browser-tools[\\/]/,
  /browser-tools[\\/]scripts[\\/]/,
];
const repo = path.resolve(root, '..', '..');
const consumer = path.basename(root);
const trackedFiles = execFileSync(
  'git',
  ['-C', repo, 'ls-files', '--', `skills/${consumer}/scripts`, `skills/${consumer}/extensions`],
  { encoding: 'utf8' },
).trim().split('\n').filter(Boolean).map(file => path.join(repo, file));
for (const file of trackedFiles) {
  const source = fs.readFileSync(file, 'utf8');
  if (fallbackPatterns.some(pattern => pattern.test(source))) process.exit(1);
}
NODE
    then
        pass "${consumer} has no local protocol or sibling source fallback"
    else
        fail "${consumer} should have no local protocol or sibling source fallback"
    fi
done

header "Extracted root infrastructure"

OLD_PATHS=(
    "browser-tools"
    ".changeset"
    ".github/workflows/release.yml"
    "package.json"
    "package-lock.json"
)
MISSING_REMOVALS=""
for old_path in "${OLD_PATHS[@]}"; do
    if [ -e "${REPO_DIR}/${old_path}" ]; then
        MISSING_REMOVALS="${MISSING_REMOVALS}${old_path}\n"
    fi
done

if [ -z "$MISSING_REMOVALS" ]; then
    pass "Old root workspace, release infrastructure, and Browser Tools tree are absent"
else
    fail "Extracted root paths should be absent" "$(printf '%b' "$MISSING_REMOVALS")"
fi

header "Results: Browser Tools package consumers"
printf "  ${GREEN}%d passed${RESET}  ${RED}%d failed${RESET}  ${YELLOW}%d skipped${RESET}\n" "$PASS" "$FAIL" "$SKIP"
echo ""
if [ "$FAIL" -gt 0 ]; then printf "  ${RED}${BOLD}FAILED${RESET}\n"; exit 1
else printf "  ${GREEN}${BOLD}ALL TESTS PASSED${RESET}\n"; exit 0; fi
