#!/usr/bin/env bash
# What models and efforts did the dispatched agents ACTUALLY run at?
#
# Answers from the harness's own records, never from an agent's self-report: a model's
# belief about its own identity is unreliable, and effort is usually not visible to it.
#
# Usage:
#   dispatch-audit.sh                    audit the most recent dispatch for this cwd
#   dispatch-audit.sh --workflow wf_xxx  audit one Claude Code workflow run
#   dispatch-audit.sh --session PATH|ID  audit one pi session by path or id substring
#   dispatch-audit.sh --last N           audit the N most recent runs (default 1)
#   dispatch-audit.sh --harness NAME     force claude-code | codex | pi
#
# Exit 0 always. Read the VERDICT line, and on pi the POLICY line beside it.
#
# Coverage, by harness:
#   claude-code  model verified per agent; effort is REQUEST-ONLY, the harness records none
#   codex        model and reasoning_effort both verified, per turn
#   pi           model and effort both verified, per subagent run directory

set -uo pipefail

harness=""
workflow=""
session=""
last=1

while [ $# -gt 0 ]; do
  case "$1" in
    --workflow) workflow="$2"; shift 2 ;;
    --session)  session="$2"; shift 2 ;;
    --last)     last="$2"; shift 2 ;;
    --harness)  harness="$2"; shift 2 ;;
    -h|--help)  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
# pi keeps both halves of the answer. The parent session holds each `subagent` toolCall
# (what was asked for) and its toolResult (what resolved, including the :effort suffix
# and the turn-budget outcome). Beside it, one directory per run holds the child's own
# model_change and thinking_level_change: what the process actually loaded. Reading only
# the parent misses dispatches that never returned; reading only the directories misses
# what was requested. This reads both and joins them.

# Emit "<runId>\t<idx>\t<provider/model:thinking>\t<name>" for every subagent run dir.
pi_run_dirs() { # $1 session stem directory
  local rd sf runid idx
  [ -d "$1" ] || return 0
  for rd in "$1"/*/run-*; do
    sf="$rd/session.jsonl"
    [ -f "$sf" ] || continue
    runid=$(basename "$(dirname "$rd")")
    idx=${rd##*run-}
    jq -rs --arg r "$runid" --arg i "$idx" '
      ([.[]|select(.type=="model_change")]|last)          as $m |
      ([.[]|select(.type=="thinking_level_change")]|last) as $t |
      ([.[]|select(.type=="session_info")]|last)          as $n |
      [$r, $i, "\($m.provider // "?")/\($m.modelId // "?"):\($t.thinkingLevel // "?")",
       ($n.name // "-")] | @tsv' "$sf" 2>/dev/null
  done
}

audit_pi() {
  local root="$HOME/.pi/agent/sessions"
  local files=() f d s

  if [ -n "$session" ]; then
    if [ -f "$session" ]; then
      files=("$session")
    else
      while IFS= read -r f; do files+=("$f"); done < <(
        find "$root" -maxdepth 2 -type f -name "*$session*.jsonl" 2>/dev/null | head -n "$last")
    fi
    [ ${#files[@]} -gt 0 ] || { echo "VERDICT        NO_PI_SESSION_MATCHING_$session"; return; }
  else
    s=$(printf '%s' "$PWD" | sed 's|/|-|g')
    d=$(find "$root" -maxdepth 1 -type d -name "*$s*" 2>/dev/null | head -1)
    [ -n "$d" ] || d="$root"
    while IFS= read -r f; do files+=("$f"); done < <(
      find "$d" -maxdepth 2 -type f -name '*.jsonl' -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | head -n "$last" | cut -d' ' -f2-)
    [ ${#files[@]} -gt 0 ] || { echo "VERDICT        NO_PI_SESSIONS_FOUND"; return; }
  fi

  local overall=VERIFIED total=0 budgets=0 killed=0 truncated=0

  for f in "${files[@]}"; do
    local stem sm st reqf resf dirf n
    stem=${f%.jsonl}
    echo "RUN            $(basename "$f")"

    sm=$(grep -m1 -F '"type":"model_change"' "$f" 2>/dev/null \
         | jq -r '"\(.provider)/\(.modelId)"' 2>/dev/null)
    st=$(grep -m1 -F '"type":"thinking_level_change"' "$f" 2>/dev/null \
         | jq -r '.thinkingLevel' 2>/dev/null)
    echo "SESSION_MODEL  ${sm:-unknown}${st:+:$st}   (what an unpinned agent inherits)"

    reqf=$(mktemp); resf=$(mktemp); dirf=$(mktemp)

    # REQUEST: one row per dispatching call. `tasks[]` is the batch form, and the model
    # key sits on the call, never inside a task, so a batch pins one model or none.
    # An `action` (list, status, get, models, watchdog.*) inspects the fleet and launches
    # nothing. Several of those carry an `agent` key, so filtering on `agent` alone
    # invented three phantom dispatches on a real session.
    grep -F '"subagent"' "$f" 2>/dev/null | jq -r '
      select(.type=="message") | .message | .content[]?
      | select(.type=="toolCall" and .name=="subagent")
      | select((.arguments.action? // "") == "")
      | select((.arguments.agent? // .arguments.tasks?) != null)
      | [ .id,
          (.arguments.model // "none"),
          (if .arguments.tasks then (.arguments.tasks|length) else 1 end),
          (if .arguments.turnBudget
             then "maxTurns=\(.arguments.turnBudget.maxTurns // "?")" else "-" end),
          (if .arguments.timeoutMs then "\(.arguments.timeoutMs)ms" else "-" end)
        ] | @tsv' 2>/dev/null > "$reqf"

    # ACTUAL, parent side: resolved model with its :effort suffix, plus how it ended.
    grep -F '"subagent"' "$f" 2>/dev/null | jq -r '
      select(.type=="message") | .message
      | select(.role=="toolResult" and .toolName=="subagent")
      | select((.details.runId? // "") != "")
      | .toolCallId as $c | .details.runId as $r
      | (.details.results // []) | to_entries[]
      | [ $c, $r, (.key|tostring), (.value.agent // "?"), (.value.model // "?"),
          (.value.thinking // "?"), (.value.turnBudget.outcome // "-"),
          (if .value.error then "error" else "ok" end)
        ] | @tsv' 2>/dev/null > "$resf"

    # ACTUAL, child side: what each run process actually loaded.
    pi_run_dirs "$stem" > "$dirf"

    n=$(grep -c . "$reqf" 2>/dev/null); n=${n:-0}
    if [ "$n" = "0" ]; then
      echo "DISPATCHES     none in this session"
      rm -f "$reqf" "$resf" "$dirf"
      echo
      continue
    fi
    total=$((total + n))

    while IFS=$'\t' read -r cid req ntasks tb tmo; do
      [ -n "$cid" ] || continue
      printf 'DISPATCH       %-22s tasks=%-2s model=%-28s turn_budget=%s timeout=%s\n' \
        "${cid%%|*}" "$ntasks" "$req" "$tb" "$tmo"
      [ "$tb" = "-" ] || budgets=$((budgets + 1))
      if [ "$req" = "none" ] && [ "$ntasks" -gt 1 ]; then
        echo "  UNPINNED_BATCH  the tasks[] form takes no per-task model, and none was set on the call"
      fi

      local found=0
      while IFS=$'\t' read -r rc rid idx agent actual thinking outcome status; do
        [ "$rc" = "$cid" ] || continue
        found=1
        local dm="-" dn="-" verdict
        while IFS=$'\t' read -r xr xi xm xn; do
          [ "$xr" = "$rid" ] && [ "$xi" = "$idx" ] && { dm="$xm"; dn="$xn"; break; }
        done < "$dirf"

        if   [ "$req" = "none" ];    then verdict=INHERITED
        elif [ "$req" = "$actual" ]; then
          if [ "${actual%%:*}" = "$sm" ]; then verdict=INDISTINGUISHABLE; else verdict=MATCH; fi
        else verdict=MISMATCH; fi

        printf 'AGENT          %-10s %-28s %-28s %s\n' "$agent" "$actual" "$dn" "$verdict"
        # The two records are written by different processes. When they disagree, the
        # result line is a summary and the run directory is the process, so say so.
        [ "$dm" = "-" ] || [ "$dm" = "$actual" ] \
          || echo "  RECORD_CONFLICT  run directory says $dm, the result record says $actual"

        case "$outcome" in
          exceeded)
            killed=$((killed + 1))
            echo "  KILLED_BY_TURN_BUDGET  $agent was cut off, not finished; its work may already be on disk" ;;
          wrap-up-requested)
            truncated=$((truncated + 1))
            echo "  TRUNCATED_BY_TURN_BUDGET  $agent was told to wrap up early, treat its answer as partial" ;;
          *)
            [ "$status" = "error" ] && echo "  FAILED       $agent returned an error" ;;
        esac

        case "$verdict" in
          MISMATCH)          overall=MISMATCH ;;
          INHERITED)         [ "$overall" = MISMATCH ] || overall=UNVERIFIED ;;
          INDISTINGUISHABLE) [ "$overall" = VERIFIED ] && overall=INDISTINGUISHABLE ;;
        esac
      done < "$resf"

      if [ "$found" = "0" ]; then
        echo "  NO_RESULT    launched, but this session holds no result for it. The run ended"
        echo "               before it returned, so nothing here was verified."
        [ "$overall" = MISMATCH ] || overall=UNVERIFIED
      fi
    done < "$reqf"

    # A run directory with no matching result is the same failure seen from the child.
    while IFS=$'\t' read -r xr xi xm xn; do
      [ -n "$xr" ] || continue
      cut -f2,3 "$resf" | grep -qxF "$xr	$xi" && continue
      printf 'AGENT          %-10s %-28s %-28s NO_RESULT\n' "-" "$xm" "$xn"
      [ "$overall" = MISMATCH ] || overall=UNVERIFIED
    done < "$dirf"

    echo "EFFORT         actual=VERIFIED (pi records thinkingLevel in each subagent run)"
    rm -f "$reqf" "$resf" "$dirf"
    echo
  done

  [ "$total" -gt 0 ] || overall=NO_DISPATCHES
  if [ "$budgets" -gt 0 ]; then
    echo "POLICY         $budgets dispatch(es) set a hard turn budget: $killed agent(s) killed by it," \
         "$truncated truncated. SKILL.md forbids turn and tool-call budgets, read-only agents included."
  else
    echo "POLICY         clean, no dispatch set a hard turn or tool-call budget"
  fi
  echo "VERDICT        ROUTING_$overall"
}

case "$harness" in
  claude-code) audit_claude_code ;;
  codex)       audit_codex ;;
  pi)          audit_pi ;;
  *)           echo "VERDICT        UNKNOWN_HARNESS_$harness" ;;
esac
