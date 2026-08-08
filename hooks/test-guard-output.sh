#!/usr/bin/env bash
# Cases for guard-output.sh. Each case feeds a PreToolUse payload on stdin and asserts
# the exit code: 0 allows, 2 blocks.
#
# A hook that blocks legitimate work gets switched off, so the ALLOW cases matter as much
# as the BLOCK ones.

set -uo pipefail
HOOK="$(cd "$(dirname "$0")" && pwd)/guard-output.sh"
EM=$(printf '\u2014')
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
check 2 "em dash in written content"        "$(w "a sentence $EM with a dash")"
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

echo "commands that can open an editor and hang"
check 2 "git rebase --continue bare"        "$(b 'git rebase --continue')"
check 0 "rebase --continue with GIT_EDITOR" "$(b 'GIT_EDITOR=true git rebase --continue')"
check 2 "git merge without --no-edit"       "$(b 'git merge origin/main')"
check 0 "git merge --no-edit"               "$(b 'git merge --no-edit origin/main')"
check 2 "git cherry-pick bare"              "$(b 'git cherry-pick abc1234')"
check 0 "git revert --no-edit"              "$(b 'git revert --no-edit abc1234')"
check 2 "git commit --amend without -m"     "$(b 'git commit --amend')"
check 0 "git commit --amend --no-edit"      "$(b 'git commit --amend --no-edit')"
check 0 "git commit with -m"                "$(b 'git commit -m "fix: a message"')"

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

echo "only text the command actually authors is inspected"
check 0 "gh pr view with a path in plumbing"   "$(b "gh pr view 296 --repo \"\$(git -C $HOME/Code/repo remote get-url origin)\"")"
check 0 "gh issue list is read-only"           "$(b "gh issue list --repo x --json number > $HOME/out.json")"
check 0 "gh pr checks is read-only"           "$(b "gh pr checks 296 --repo $HOME/Code/repo")"
check 0 "message built by a substitution"     "$(b "git commit -m \"\$(cat $HOME/msg.txt)\"")"
check 2 "path in a PR body"                   "$(b "gh pr create --title x --body \"see $HOME/Code/x\"")"
check 2 "em dash in an issue comment"         "$(b "gh issue comment 5 --body \"one ${EM} two\"")"
check 2 "identity in a release note"          "$(b 'gh release create v1 --notes "by reza.kamali"')"
check 0 "path in a PR view json filter"       "$(b "gh pr view 296 --json files --jq '.files[].path' # $HOME/x")"

# The usual way a PR body is written. It arrives as a substitution, so the heredoc body
# is read directly.
check 2 "heredoc PR body with a home path"    "$(b "gh pr create --title x --body \"\$(cat <<'EOF'
see $HOME/Code/x for details
EOF
)\"")"
check 0 "clean heredoc PR body"               "$(b "gh pr create --title x --body \"\$(cat <<'EOF'
a clean body, nothing personal
EOF
)\"")"

echo "git commands that abort rather than open an editor"
check 0 "git merge --abort"                   "$(b 'git merge --abort')"
check 0 "git cherry-pick --abort"             "$(b 'git cherry-pick --abort')"
check 0 "git rebase --skip"                   "$(b 'git rebase --skip')"

printf '\n  %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = "0" ]
