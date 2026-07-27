#!/usr/bin/env bash
# What models and efforts did the dispatched agents ACTUALLY run at?
#
# Answers from the harness's own records, never from an agent's self-report: a model's
# belief about its own identity is unreliable, and effort is usually not visible to it.
#
# Usage:
#   dispatch-audit.sh                    audit the most recent dispatch for this cwd
#   dispatch-audit.sh --workflow wf_xxx  audit one Claude Code workflow run
#   dispatch-audit.sh --last N           audit the N most recent runs (default 1)
#   dispatch-audit.sh --harness NAME     force claude-code | codex | pi
#
# Exit 0 always. Read the VERDICT line.
#
# Coverage, by harness:
#   claude-code  model verified per agent; effort is REQUEST-ONLY, the harness records none
#   codex        model and reasoning_effort both verified, per turn
#   pi           model verified; effort travels inside the request string, unconfirmed

set -uo pipefail

harness=""
workflow=""
last=1

while [ $# -gt 0 ]; do
  case "$1" in
    --workflow) workflow="$2"; shift 2 ;;
    --last)     last="$2"; shift 2 ;;
    --harness)  harness="$2"; shift 2 ;;
    -h|--help)  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          echo "unknown argument: $1" >&2; exit 0 ;;
  esac
done

# ---------------------------------------------------------------- harness detect
if [ -z "$harness" ]; then
  if   [ -n "${CLAUDE_PROJECT_DIR:-}" ] || [ -d "$HOME/.claude/projects" ]; then harness=claude-code
  elif [ -d "$HOME/.codex/sessions" ];                                      then harness=codex
  elif [ -d "$HOME/.pi/agent/sessions" ];                                   then harness=pi
  else echo "VERDICT        NO_HARNESS_RECORDS_FOUND"; exit 0; fi
fi
echo "HARNESS        $harness"

# Claude Code names a project dir after the cwd with both / and . folded to -
slug() { printf '%s' "$1" | sed 's|[/.]|-|g'; }

# A script may pin an alias ("sonnet") that the harness resolves to a full id
# ("claude-sonnet-5"). Comparing those as strings reports a false mismatch.
# $1 requested, $2 actual family (variant suffix already stripped)
model_matches() {
  [ "$1" = "$2" ] && return 0
  case "$1" in
    opus|sonnet|haiku|fable) case "$2" in claude-$1-*) return 0 ;; esac ;;
  esac
  return 1
}

# Pair every agent() call's label with the model and effort it pinned, so a run that
# pins several tiers can still be judged per agent instead of collapsing to ambiguous.
# Reads the script on stdin, emits: <label-prefix>TAB<model>TAB<effort>
# The prefix is the literal head of the label, cut at any ${...} interpolation.
script_pins() {
  tr '\n' ' ' \
  | grep -oE "label: *[\`'\"][^\`'\",]*|model: *'[^' ]+'|effort: *'[^' ]+'" \
  | awk '
      function flush() { if (lbl != "") printf "%s\t%s\t%s\n", lbl, (m?m:"inherited"), (e?e:"inherited") }
      /^label:/  { flush(); lbl=$0; sub(/^label: *./, "", lbl); sub(/\$\{.*/, "", lbl); m=""; e="" ; next }
      /^model:/  { m=$0; gsub(/^model: *.|.$/, "", m); next }
      /^effort:/ { e=$0; gsub(/^effort: *.|.$/, "", e); next }
      END        { flush() }'
}

# ------------------------------------------------------- claude code: workflow runs
audit_claude_code() {
  local dirs=() d s seen=""
  s=$(slug "$PWD")
  # The two roots share project directories by symlink, so dedupe by real path or
  # every run is audited twice.
  for root in "$HOME/.claude/projects" "$HOME/.claude-work/projects"; do
    [ -d "$root/$s" ] || continue
    local rp; rp=$(realpath "$root/$s")
    case "$seen" in *"|$rp|"*) continue ;; esac
    seen="$seen|$rp|"; dirs+=("$rp")
  done
  [ ${#dirs[@]} -gt 0 ] || { echo "VERDICT        NO_SESSION_DIR_FOR $PWD"; return; }

  local files=()
  if [ -n "$workflow" ]; then
    while IFS= read -r f; do files+=("$f"); done < <(
      find "${dirs[@]}" -path "*/workflows/$workflow.json" 2>/dev/null)
  else
    while IFS= read -r f; do files+=("$f"); done < <(
      find "${dirs[@]}" -path '*/workflows/wf_*.json' -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | head -n "$last" | cut -d' ' -f2-)
  fi
  [ ${#files[@]} -gt 0 ] || { echo "VERDICT        NO_WORKFLOW_RUNS_FOUND"; return; }

  local overall=VERIFIED
  for d in "${files[@]}"; do
    echo "RUN            $(basename "$d" .json)  $(jq -r '.workflowName // "?"' "$d")"
    local default script requested req_models req_efforts n
    default=$(jq -r '.defaultModel // "unknown"' "$d")
    script=$(jq -r '.script // ""' "$d")
    echo "SESSION_MODEL  $default   (what an unpinned agent inherits)"

    # REQUEST side, per label prefix, so each agent is judged against its own pin.
    local pins; pins=$(mktemp)
    printf '%s' "$script" | script_pins > "$pins"
    n=$(grep -c . "$pins"); n=${n:-0}
    if [ "$n" = "0" ]; then
      echo "REQUESTED      none pinned in the script, all agents inherit $default"
    else
      while IFS=$'\t' read -r p m e; do
        printf 'REQUESTED      %-22s %-22s effort=%s\n' "${p}*" "$m" "$e"
      done < "$pins"
    fi

    # ACTUAL side: what the harness recorded per agent. Verdicts land in a temp file
    # so the summary counts the same judgments the lines showed.
    local tmp; tmp=$(mktemp)
    jq -r '.workflowProgress[]? | select(.type=="workflow_agent")
           | "\(.label)\t\(.model)\t\(.attempt)\t\(.state)"' "$d" 2>/dev/null \
    | while IFS=$'\t' read -r label actual attempt state; do
        local verdict fam_a req best=""
        fam_a=${actual%%\[*}
        # Longest matching label prefix wins.
        while IFS=$'\t' read -r p m e; do
          case "$label" in "$p"*) [ ${#p} -ge ${#best} ] && { best="$p"; req="$m"; } ;; esac
        done < "$pins"
        if   [ "$n" = "0" ];  then verdict=INHERITED
        elif [ -z "$best" ];  then verdict=UNATTRIBUTED
        elif [ "$req" = "inherited" ]; then verdict=INHERITED
        elif model_matches "$req" "$fam_a"; then
          if   [ "$actual" = "$default" ]; then verdict=INDISTINGUISHABLE
          elif [ "$actual" != "$req" ];    then verdict=MATCH_RESOLVED
          else                                  verdict=MATCH; fi
        else verdict=MISMATCH; fi
        printf 'AGENT          %-28s %-22s attempt=%s %-6s %s\n' \
          "$label" "$actual" "$attempt" "$state" "$verdict"
        [ "$attempt" != "1" ] && echo "  RETRIED      $label ran $attempt times, the tree may hold work from a dead run"
        [ "$state" = "done" ] || echo "  NOT_DONE     $label ended in state=$state"
        echo "$verdict" >> "$tmp"
      done

    # Effort has no result side on this harness. Say so, every time.
    req_efforts=$(cut -f3 "$pins" | sort -u | tr '\n' ',' | sed 's/,$//')
    echo "EFFORT         requested=${req_efforts:-none}  actual=UNVERIFIABLE (claude-code records no effort)"
    rm -f "$pins"

    local bad ind amb una
    # grep -c prints 0 and exits 1 on no match, so a `|| echo 0` fallback would
    # append a second zero and break the integer tests below.
    bad=$(grep -c '^MISMATCH$' "$tmp" 2>/dev/null); bad=${bad:-0}
    ind=$(grep -c '^INDISTINGUISHABLE$' "$tmp" 2>/dev/null); ind=${ind:-0}
    una=$(grep -c '^UNATTRIBUTED$' "$tmp" 2>/dev/null); una=${una:-0}
    amb=$(grep -c '^INHERITED$' "$tmp" 2>/dev/null); amb=${amb:-0}
    if   [ "$n" = "0" ];        then echo "RUN_VERDICT    ALL_INHERITED, nothing was pinned"; overall=UNVERIFIED
    elif [ "$bad" -gt 0 ];      then echo "RUN_VERDICT    MISMATCH, $bad agent(s) ran a model the script did not pin"; overall=MISMATCH
    elif [ "$una" -gt 0 ];      then echo "RUN_VERDICT    UNATTRIBUTED, $una agent(s) match no pinned label, reconcile by hand"; overall=UNVERIFIED
    elif [ "$amb" -gt 0 ];      then echo "RUN_VERDICT    PARTIALLY_INHERITED, $amb agent(s) had no model pinned"; overall=UNVERIFIED
    elif [ "$ind" -gt 0 ];      then echo "RUN_VERDICT    INDISTINGUISHABLE, the pin equals the session default so it proves nothing"
                                     [ "$overall" = VERIFIED ] && overall=INDISTINGUISHABLE
    else                             echo "RUN_VERDICT    MODEL_VERIFIED"; fi
    rm -f "$tmp"
    echo
  done
  echo "VERDICT        ROUTING_$overall"
}

# ------------------------------------------------------------------------- codex
audit_codex() {
  local f
  f=$(find "$HOME/.codex/sessions" -name 'rollout-*.jsonl' -printf '%T@ %p\n' 2>/dev/null \
      | sort -rn | head -1 | cut -d' ' -f2-)
  [ -n "$f" ] || { echo "VERDICT        NO_CODEX_ROLLOUTS_FOUND"; return; }
  echo "RUN            $(basename "$f")"
  # turn_context is the harness's own statement of what the turn ran at.
  grep -ohE '"model":"[^"]+"|"reasoning_effort":"[^"]+"' "$f" \
    | sort | uniq -c | sed 's/^ *//' \
    | while read -r c kv; do printf 'ACTUAL         %-40s x%s\n' "$kv" "$c"; done
  echo "EFFORT         actual=VERIFIED (codex records reasoning_effort per turn)"
  local n
  n=$(grep -ohE '"reasoning_effort":"[^"]+"' "$f" | sort -u | wc -l | tr -d ' ')
  [ "$n" -gt 1 ] && echo "NOTE           effort changed mid-session, $n distinct values"
  echo "VERDICT        ROUTING_VERIFIED"
}

# ---------------------------------------------------------------------------- pi
audit_pi() {
  local d f s
  s=$(printf '%s' "$PWD" | sed 's|/|-|g')
  d=$(find "$HOME/.pi/agent/sessions" -maxdepth 1 -type d -name "*$s*" 2>/dev/null | head -1)
  [ -n "$d" ] || d="$HOME/.pi/agent/sessions"
  f=$(find "$d" -name '*.jsonl' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
  [ -n "$f" ] || { echo "VERDICT        NO_PI_SESSIONS_FOUND"; return; }
  echo "RUN            $(basename "$f")"
  # pi carries effort inside the request string: provider/model:effort
  grep -ohE '"[a-z-]+/[a-z0-9.-]+:(minimal|low|medium|high|xhigh)"' "$f" 2>/dev/null \
    | sort | uniq -c | sed 's/^ *//' \
    | while read -r c m; do printf 'REQUESTED      %-40s x%s\n' "$m" "$c"; done
  grep -ohE '"model":"[^"]+"' "$f" | sort | uniq -c | sed 's/^ *//' \
    | while read -r c m; do printf 'ACTUAL         %-40s x%s\n' "$m" "$c"; done
  echo "EFFORT         actual=UNCONFIRMED (pi strips the :effort suffix from the resolved record)"
  echo "VERDICT        ROUTING_MODEL_ONLY"
}

case "$harness" in
  claude-code) audit_claude_code ;;
  codex)       audit_codex ;;
  pi)          audit_pi ;;
  *)           echo "VERDICT        UNKNOWN_HARNESS_$harness" ;;
esac
