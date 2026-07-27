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
         # Blind staging pulls in work that is not yours.
         if printf '%s' "$cmd" | grep -qE 'git add (-A|--all|\.)( |$)|git commit[^|;]*( |^)(-[a-zA-Z]*a[a-zA-Z]*|--all)( |$)'; then
           printf 'Blocked: stage by explicit path. git add -A / git add . / git commit -a sweep up unrelated work.\n' >&2
           exit 2
         fi
         # Only inspect commands that author text: commits, PRs, issues, releases.
         if printf '%s' "$cmd" | grep -qE 'git (commit|tag)|gh (pr|issue|release)'; then
           text="$cmd"; path="commit-or-pr-text"
           # Paths and host names are scanned only inside quoted segments, which is where
           # the authored message lives. `cd /some/path && git commit` is plumbing, and
           # blocking it made the guard refuse an ordinary commit the first time it ran.
           authored=$(printf '%s' "$cmd" | grep -oE '"[^"]*"|'"'"'[^'"'"']*'"'"'' || true)
         else
           exit 0
         fi ;;
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

if printf '%s' "$text" | grep -q '—'; then
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
  # For a Bash command this is the quoted portion only. For Write and Edit it is the whole
  # content, since all of it is being written down.
  scan=${authored-$text}
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
