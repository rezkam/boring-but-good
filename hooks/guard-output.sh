#!/usr/bin/env bash
# PreToolUse guard. Blocks the global hard rules before they reach a file, a commit
# message, or a PR body, rather than relying on the model to remember them.
#
# Wire into ~/.claude/settings.json:
#   "hooks": { "PreToolUse": [ { "matcher": "Write|Edit|Bash",
#     "hooks": [ { "type": "command", "command": "<abs path to this file>" } ] } ] }
#
# Exit 0 = allow. Exit 2 = block, and stderr is shown to the model so it can self-correct.
#
# Scope: this catches the mechanical categories. Meetings, agreements, itineraries, and
# balances described in prose are not regex-detectable and remain instruction-only.

set -uo pipefail

payload=$(cat)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // empty')
path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')

case "$tool" in
  Write) text=$(printf '%s' "$payload" | jq -r '.tool_input.content // empty') ;;
  Edit)  text=$(printf '%s' "$payload" | jq -r '.tool_input.new_string // empty') ;;
  Bash)  cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')
         # Draft PRs: the user has said to open non-draft, never draft.
         if printf '%s' "$cmd" | grep -qE 'gh pr create.*--draft'; then
           printf 'Blocked: never open a draft PR. Drop --draft.\n' >&2
           exit 2
         fi
         # implementation-notes-*.md is the user's local record, never committed.
         if printf '%s' "$cmd" | grep -qE 'git add.*implementation-notes'; then
           printf 'Blocked: implementation-notes-*.md is a local record and is never staged.\n' >&2
           exit 2
         fi
         # Commands that drop into $EDITOR and wait forever. One rebase --continue sat in
         # vim for 1022 seconds before the run was killed, then finished in 0.3s once the
         # editor was disabled. Not every harness sets GIT_EDITOR, so do not rely on it.
         if printf '%s' "$cmd" | grep -qE '(^|[;&|] *)git +(rebase +--continue|merge |cherry-pick |revert |commit +--amend)' \
            && ! printf '%s' "$cmd" | grep -qE 'GIT_EDITOR=|--no-edit|-m |--message|--file|-F |--abort|--quit|--skip'; then
           printf 'Blocked: this git command opens an editor and will hang.\nPrefix it with GIT_EDITOR=true, or pass --no-edit or -m.\n' >&2
           exit 2
         fi
         # Blind staging pulls in work that is not yours.
         if printf '%s' "$cmd" | grep -qE 'git add (-A|--all|\.)( |$)|git commit[^|;]*( |^)(-[a-zA-Z]*a[a-zA-Z]*|--all)( |$)'; then
           printf 'Blocked: stage by explicit path. git add -A / git add . / git commit -a sweep up unrelated work.\n' >&2
           exit 2
         fi
         # Only inspect commands that author text: commits, tags, PRs, issues, releases.
         # `gh pr view` and `gh issue list` publish nothing, so they are never inspected.
         if ! printf '%s' "$cmd" | grep -qE '(^|[;&|] *)(git +(commit|tag)|gh +(pr|issue|release) +(create|edit|comment|review))'; then
           exit 0
         fi
         path="commit-or-pr-text"
         # Scan the message itself, not the command that carries it. Everything else on
         # the line is plumbing: a `cd` prefix, a `--repo "$(git remote get-url origin)"`,
         # a `--jq` filter. Scanning those made the guard refuse read-only commands and an
         # ordinary commit. Text produced by a substitution is invisible here and is left
         # to the Write and Edit cases, which see the file being written.
         text=$(printf '%s' "$cmd" | perl -0777 -ne '
           my @found;
           while (/(?:^|\s)(?:-m|-t|-b|-n|--message|--title|--body|--notes|--subject)(?:=|\s+)(?:'"'"'([^'"'"']*)'"'"'|"((?:[^"\\]|\\.)*)"|([^\s'"'"'"]+))/g) {
             push @found, defined $1 ? $1 : defined $2 ? $2 : $3;
           }
           while (/<<-?\s*'"'"'?"?(\w+)"?'"'"'?\r?\n(.*?)\r?\n\s*\1/gs) { push @found, $2 }
           for (@found) { s/\$(\((?:[^()]++|(?1))*\))//g; s/`[^`]*`//g; print "$_\n" }
         ') ;;
  *) exit 0 ;;
esac

[ -z "$text" ] && exit 0

# Local-only destinations. These never leave the machine, so a real path in them is not
# a leak. Everything else is treated as publishable.
local_only=0
case "$path" in
  "$HOME"/.agents/*|*/implementation-notes-*) local_only=1 ;;
esac

violations=""
add() { violations+="$1
"; }

# Built from its codepoint on purpose. A literal here would make this file, and its
# tests, unwritable by the very guard they implement.
emdash=$(printf '\u2014')
if printf '%s' "$text" | grep -qF "$emdash"; then
  add "Em dash found. Use a comma, a colon, parentheses, or a second sentence."
fi

if printf '%s' "$text" | grep -qiE 'co-authored-by: *(claude|codex|gpt|gemini)|generated with \[?(claude|codex)|claude\.ai/code|claude-session:|. generated'; then
  add "AI attribution found. Remove it entirely, do not reword it."
fi

if printf '%s' "$text" | grep -qiE 'telavox|reza\.kamali|kamali-fard'; then
  add "Employer or personal identity found. Use a placeholder."
fi

# Email addresses, minus the conventional placeholder domains.
if printf '%s' "$text" \
   | grep -ohiE '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' \
   | grep -qivE '@(example|test|invalid|localhost)\.|\.(invalid|local|test|example)$|@(users\.)?noreply\.'; then
  add "Email address found. Use a placeholder such as you@example.com."
fi

# International phone numbers. The leading + keeps this off version and math strings.
if printf '%s' "$text" | grep -qE '\+[0-9][0-9 ()-]{7,17}[0-9]'; then
  add "Phone number found. Remove it or use a placeholder."
fi

if printf '%s' "$text" | grep -qE '\b[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}\b'; then
  add "IBAN-shaped account number found. Remove it."
fi

# Payment cards: separated groups, or a bare 15 to 16 digit run. 13-digit epoch
# milliseconds stay under the bare threshold on purpose.
if printf '%s' "$text" | grep -qE '[0-9]{4}[ -][0-9]{4}[ -][0-9]{4}[ -][0-9]{1,4}|\b[0-9]{15,16}\b'; then
  add "Payment-card-shaped number found. Remove it."
fi

if printf '%s' "$text" | grep -qE '\b([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b'; then
  add "MAC address found. Remove it."
fi

# Routable IPv4. Private, loopback, link-local, multicast, and broadcast are fine.
# Heuristic: an address whose every octet is under 10 is treated as a version string.
if printf '%s' "$text" | grep -ohE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' \
   | grep -vE '^(10\.|127\.|0\.|255\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|22[4-9]\.|23[0-9]\.)' \
   | grep -qvE '^[0-9]\.[0-9]\.[0-9]\.[0-9]$'; then
  add "Routable IP address found. Remove it or use a documentation range."
fi

if [ "$local_only" = "0" ]; then
  scan="$text"
  # A real path from this machine, as opposed to ~ or $HOME.
  if printf '%s' "$scan" | grep -qF "$HOME/"; then
    add "Absolute path from this machine found. Use ~, \$HOME, or a relative path."
  fi
  # Device and network names, resolved at runtime. Generic model names are skipped
  # because they collide with ordinary prose.
  for n in "$(hostname -s 2>/dev/null)" "$(scutil --get LocalHostName 2>/dev/null)" \
           "$(scutil --get ComputerName 2>/dev/null)"; do
    [ -n "$n" ] && [ ${#n} -ge 4 ] || continue
    case "$n" in MacBook*|iMac*|Mac\ *|localhost) continue ;; esac
    if printf '%s' "$scan" | grep -qF "$n"; then
      add "Device or network name found. Remove it."
      break
    fi
  done
fi

if [ -n "$violations" ]; then
  printf 'Blocked by a global hard rule.\n\n%s\nAsk before writing any of these, per instance.\n' "$violations" >&2
  exit 2
fi

exit 0
