#!/bin/bash
# Builds $FORBIDDEN_RE: an alternation of patterns that must never appear in
# published files (checked case-insensitively by the test guards).
#
# Identity, employer, and internal-key patterns are intentionally kept OUT of
# this repo. Put them, one regex per line, in tests/forbidden-patterns.local
# (gitignored). See tests/forbidden-patterns.local.example for the format.
# When that file is absent (e.g. a fresh clone), the guard still catches home
# paths via the generic default below.
__fdir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORBIDDEN_RE='/Users/|/home/'
if [ -f "$__fdir/forbidden-patterns.local" ]; then
  __extra="$(grep -vE '^[[:space:]]*(#|$)' "$__fdir/forbidden-patterns.local" | tr '\n' '|' | sed 's/|$//')"
  [ -n "$__extra" ] && FORBIDDEN_RE="${__extra}|${FORBIDDEN_RE}"
fi
export FORBIDDEN_RE
