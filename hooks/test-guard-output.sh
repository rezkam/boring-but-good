#!/usr/bin/env bash
# Cases for guard-output.sh. Each case feeds a PreToolUse payload on stdin and asserts
# the exit code: 0 allows, 2 blocks.
#
# A hook that blocks legitimate work gets switched off, so the ALLOW cases matter as much
# as the BLOCK ones.

set -uo pipefail
HOOK="$(cd "$(dirname "$0")" && pwd)/guard-output.sh"
pass=0; fail=0

# $1 expected exit, $2 name, $3 json payload
check() {
  local want="$1" name="$2" payload="$3" got
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then
    pass=$((pass+1)); printf '  ok    %s\n' "$name"
  else
    fail=$((fail+1)); printf '  FAIL  %s (wanted exit %s, got %s)\n' "$name" "$want" "$got"
  fi
}

w() { jq -cn --arg c "$1" --arg p "${2:-/repo/src/a.md}" \
  '{tool_name:"Write", tool_input:{content:$c, file_path:$p}}'; }
b() { jq -cn --arg c "$1" '{tool_name:"Bash", tool_input:{command:$c}}'; }

echo "existing behavior"
check 2 "em dash in written content"        "$(w 'a sentence — with a dash')"
check 0 "clean written content"             "$(w 'a sentence, with a comma')"
check 2 "AI attribution in a commit"        "$(b 'git commit -m "fix

Co-Authored-By: Claude <x@y.z>"')"
check 2 "git add -A"                        "$(b 'git add -A')"
check 2 "git add ."                         "$(b 'git add .')"
check 2 "git commit -am"                    "$(b 'git commit -am wip')"
check 0 "git commit --amend --no-edit"      "$(b 'git commit --amend --no-edit')"
check 2 "draft PR"                          "$(b 'gh pr create --draft --title x')"
check 2 "staging the notes file"            "$(b 'git add implementation-notes-x.md')"
check 0 "ordinary bash is not inspected"    "$(b 'ls -la /Users/someone/Code')"

echo "personal and environment data"
check 2 "real email address"                "$(w 'contact: firstname.lastname@acme.com')"
check 0 "placeholder email"                 "$(w 'contact: you@example.com')"
check 0 "noreply placeholder"               "$(w 'set user.email to test@test.invalid')"
check 2 "international phone number"        "$(w 'call +46701234567 to confirm')"
check 2 "IBAN"                              "$(w 'account SE4550000000058398257466')"
check 2 "payment card number"               "$(w 'card 4111 1111 1111 1111 exp 04/29')"
check 2 "MAC address"                       "$(w 'device a4:83:e7:2b:19:0f joined')"
check 2 "routable IP address"               "$(w 'host 87.96.14.22 responded')"
check 0 "private IP address"                "$(w 'bind 192.168.1.10 and 10.0.0.5')"
check 0 "loopback and version strings"      "$(w 'serve 127.0.0.1 running 1.2.3.4 build')"

echo "machine identity"
check 2 "hardcoded home path in a repo file" "$(w "see $HOME/Code/thing for details")"
check 0 "home path in a local-only note"     "$(w "see $HOME/Code/thing" "$HOME/.agents/note.md")"
check 0 "home path in an implementation note" "$(w "see $HOME/Code" "/repo/implementation-notes-x.md")"
check 2 "home path in a commit message"      "$(b "git commit -m \"read $HOME/Code/x\"")"
check 0 "tilde or \$HOME is fine"            "$(w 'see ~/Code/thing and $HOME/bin')"
# Regression: a cd prefix is command plumbing, not authored text. Blocking this made the
# guard refuse an ordinary commit the first time it ran for real.
check 0 "cd prefix before a clean commit"    "$(b "cd $HOME/Code/repo && git commit -m \"fix(x): a clean message\"")"
check 0 "path as an unquoted git argument"   "$(b "git add $HOME/Code/repo/a.md && git commit -m \"fix: y\"")"

printf '\n  %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = "0" ]
