#!/usr/bin/env bash
# One deterministic snapshot of "is this branch actually landable".
#
# Usage: pr-state.sh [pr-number] [options]
#   --exclude <pathspec>   Treat a dirty path as FOREIGN (not this session's work).
#                          Repeatable. Also read from PR_READY_EXCLUDE (colon-separated).
#   --probe-rebase         Actually replay this branch onto the base in a throwaway
#                          detached worktree and report whether rebase-merge is viable.
#   --preserve-merges      Probe with --rebase-merges, keeping merge commits.
#   --allow-no-checks      Allow a repository that has been verified to have no CI.
#
# Prints a fixed block. Exit 0 always: the caller reads the fields.

set -uo pipefail

pr=""
probe=0
rebase_merges=0
allow_no_checks=0
excludes=()

if [ -n "${PR_READY_EXCLUDE:-}" ]; then
  IFS=':' read -r -a env_ex <<<"$PR_READY_EXCLUDE"
  excludes+=("${env_ex[@]}")
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --exclude)
      excludes+=("$2")
      shift 2
      ;;
    --probe-rebase)
      probe=1
      shift
      ;;
    --preserve-merges)
      rebase_merges=1
      shift
      ;;
    --allow-no-checks)
      allow_no_checks=1
      shift
      ;;
    *)
      pr="$1"
      shift
      ;;
  esac
done

branch=$(git rev-parse --abbrev-ref HEAD)
[ -n "$pr" ] || pr=$(gh pr view --json number -q .number 2>/dev/null || echo "")

pr_json=""
pr_query_ok=1
if [ -n "$pr" ]; then
  pr_json=$(gh pr view "$pr" --json number,isDraft,mergeable,mergeStateStatus,title,baseRefName,headRefOid,reviewDecision,url,statusCheckRollup 2>/dev/null)
  printf '%s' "$pr_json" | jq -e 'type == "object" and .number != null' >/dev/null 2>&1 || pr_query_ok=0
fi

if [ "$pr_query_ok" = 1 ] && [ -n "$pr" ]; then
  base=$(printf '%s' "$pr_json" | jq -r .baseRefName)
else
  base=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo main)
fi

local_sha=$(git rev-parse HEAD)

echo "BRANCH         $branch"
echo "BASE           $base"
echo "LOCAL_HEAD     $local_sha"

# Local cleanliness. Every dirty path is named, because "3 file(s)" is not enough
# information to decide whether they are yours.
mine=0
foreign=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  path=${line:3}
  path=${path##* -> }
  hit=0
  for ex in ${excludes+"${excludes[@]}"}; do
    case "$path" in "$ex" | "$ex"/*)
      hit=1
      break
      ;;
    esac
  done
  if [ "$hit" = 1 ]; then
    foreign=$((foreign + 1))
    echo "  FOREIGN      ${line:0:2} $path"
  else
    mine=$((mine + 1))
    echo "  DIRTY        ${line:0:2} $path"
  fi
done < <(git status --porcelain)
echo "UNCOMMITTED    $mine file(s) unadjudicated, $foreign adjudicated foreign"

# Local vs remote tracking branch
has_upstream=0
behind=0
ahead=0
if git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
  has_upstream=1
  read -r behind ahead < <(git rev-list --left-right --count '@{upstream}...HEAD' | awk '{print $1, $2}')
  echo "UNPUSHED       $ahead commit(s) ahead of upstream"
  echo "UPSTREAM_AHEAD $behind commit(s) not pulled"
else
  echo "UNPUSHED       no upstream set"
  echo "UPSTREAM_AHEAD n/a"
fi

# Distance from the real base
fetch_ok=1
git fetch --quiet origin "+refs/heads/$base:refs/remotes/origin/$base" 2>/dev/null || fetch_ok=0
behind_base=0
merge_commits=0
ahead_base=0
if git rev-parse --verify --quiet "origin/$base" >/dev/null; then
  base_sha=$(git rev-parse "origin/$base")
  behind_base=$(git rev-list --count "HEAD..origin/$base")
  ahead_base=$(git rev-list --count "origin/$base..HEAD")
  merge_commits=$(git rev-list --merges --count "origin/$base..HEAD")
  echo "BASE_HEAD      $base_sha"
  echo "BEHIND_BASE    $behind_base commit(s) behind origin/$base"
  echo "AHEAD_BASE     $ahead_base commit(s), $merge_commits of them merge commits"
else
  echo "BASE_HEAD      n/a"
fi
echo "BASE_FETCH     $([ "$fetch_ok" = 1 ] && echo ok || echo failed)"

if [ -z "$pr" ]; then
  echo "PR             none"
  # Uncommitted work outranks a missing PR. Reporting NO_PR here sends the caller off to
  # push work that is not committed yet, which is what happened the first time this ran.
  if [ "$mine" -gt 0 ]; then
    echo "VERDICT        UNCOMMITTED_WORK"
  else
    echo "VERDICT        NO_PR"
  fi
  exit 0
fi

if [ "$pr_query_ok" != 1 ]; then
  echo "PR             query failed"
  echo "VERDICT        PR_QUERY_FAILED"
  exit 0
fi

number=$(printf '%s' "$pr_json" | jq -r .number)
isdraft=$(printf '%s' "$pr_json" | jq -r .isDraft)
mergeable=$(printf '%s' "$pr_json" | jq -r .mergeable)
state=$(printf '%s' "$pr_json" | jq -r .mergeStateStatus)
title=$(printf '%s' "$pr_json" | jq -r .title)
pr_head=$(printf '%s' "$pr_json" | jq -r .headRefOid)
decision=$(printf '%s' "$pr_json" | jq -r 'if .reviewDecision == null or .reviewDecision == "" then "NONE" else .reviewDecision end')
echo "PR             #$number  $title"
echo "PR_HEAD        $pr_head"
echo "DRAFT          $isdraft"
echo "MERGEABLE      $mergeable"
echo "MERGE_STATE    $state"

# Which buttons the repo actually offers. MERGE_STATE above describes merge-commit
# semantics only; it says nothing about whether rebase-merge can linearize.
read -r allow_merge allow_squash allow_rebase < <(
  gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed \
    -q '[.mergeCommitAllowed, .squashMergeAllowed, .rebaseMergeAllowed] | @tsv' 2>/dev/null \
    || echo "true	true	true"
)
echo "MERGE_METHODS  merge:$allow_merge squash:$allow_squash rebase:$allow_rebase"

# Rebase-merge viability. There is NO API field for this. The only proof is a replay.
rebase_status="NOT_PROBED"
rebase_risk="none" # none | high | proven | broken
if [ "$allow_rebase" != "true" ]; then
  rebase_status="DISABLED_ON_REPO"
elif [ "$probe" = 1 ]; then
  head_sha=$(git rev-parse HEAD)
  head_tree=$(git rev-parse "HEAD^{tree}")
  probe_dir="$HOME/.agents/pr-ready-probe/$(basename "$PWD")-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$(dirname "$probe_dir")"
  if git worktree add --detach --quiet "$probe_dir" "$head_sha" 2>/dev/null; then
    flag=""
    [ "$rebase_merges" = 1 ] && flag="--rebase-merges"
    log="$probe_dir.rebase.log"
    if git -C "$probe_dir" -c rerere.enabled=false rebase $flag "origin/$base" >"$log" 2>&1; then
      new_tree=$(git -C "$probe_dir" rev-parse "HEAD^{tree}")
      replayed=$(git -C "$probe_dir" rev-list --count "origin/$base..HEAD")
      if [ "$new_tree" = "$head_tree" ]; then
        rebase_status="PROVEN_CLEAN ($replayed commits replayed, tree identical to $head_sha)"
        rebase_risk="proven"
        rm -f "$log"
      else
        rebase_status="PROVEN_TREE_DIVERGED ($replayed replayed, tree $new_tree != $head_tree, see $probe_dir)"
        rebase_risk="broken"
      fi
    else
      at=$(grep -oE 'Rebasing \(([0-9]+)/([0-9]+)\)' "$log" | tail -1)
      badsha=$(grep -oE 'could not apply [0-9a-f]+' "$log" | tail -1 | awk '{print $4}')
      files=$(git -C "$probe_dir" diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ' ')
      git -C "$probe_dir" rebase --abort >/dev/null 2>&1
      if [ -n "$files" ]; then
        rebase_status="PROVEN_CONFLICTS ${at:-at unknown step} commit ${badsha:-?} in ${files}(log $log)"
        rebase_risk="broken"
      else
        # The rebase failed with nothing unmerged, so it is not a content conflict:
        # a bad revision, a busy index, a hook. Do not report it as one.
        rebase_status="PROBE_ERROR (rebase exited non-zero with no unmerged paths, see $log)"
        rebase_risk="high"
      fi
    fi
    git worktree remove --force "$probe_dir" >/dev/null 2>&1
  else
    rebase_status="PROBE_FAILED (could not create worktree at $probe_dir)"
    rebase_risk="high"
  fi
elif [ "$merge_commits" -gt 0 ]; then
  rebase_status="UNPROVEN ($merge_commits merge commit(s) in the branch: linearization discards their resolutions; run --probe-rebase)"
  rebase_risk="high"
else
  rebase_status="UNPROVEN (no merge commits, low risk; run --probe-rebase to confirm)"
  rebase_risk="none"
fi
echo "REBASE_MERGE   $rebase_status"

# Read checks from the same PR snapshot as headRefOid so results cannot belong
# to an older head. Support both check runs and legacy status contexts.
checks=$(printf '%s' "$pr_json" | jq '[.statusCheckRollup[]? |
  if .__typename == "CheckRun" then
    {name: .name, state: (if .status == "COMPLETED" then (.conclusion // "UNKNOWN") else .status end), link: .detailsUrl}
  else
    {name: (.context // "status"), state: (.state // "UNKNOWN"), link: .targetUrl}
  end]')
total=$(printf '%s' "$checks" | jq 'length')
pass=$(printf '%s' "$checks" | jq '[.[]|select(.state=="SUCCESS" or .state=="NEUTRAL" or .state=="SKIPPED")]|length')
fail=$(printf '%s' "$checks" | jq '[.[]|select(.state=="FAILURE" or .state=="ERROR" or .state=="TIMED_OUT" or .state=="CANCELLED" or .state=="CANCEL" or .state=="ACTION_REQUIRED" or .state=="STARTUP_FAILURE" or .state=="STALE")]|length')
pend=$(printf '%s' "$checks" | jq '[.[]|select(.state=="PENDING" or .state=="QUEUED" or .state=="IN_PROGRESS" or .state=="WAITING" or .state=="REQUESTED" or .state=="EXPECTED")]|length')
unknown=$((total - pass - fail - pend))
echo "CHECKS         $pass passed, $fail failed, $pend running, $unknown unknown, $total total"
[ "$fail" -gt 0 ] && printf '%s' "$checks" | jq -r '.[]|select(.state=="FAILURE" or .state=="ERROR" or .state=="TIMED_OUT" or .state=="CANCELLED" or .state=="CANCEL" or .state=="ACTION_REQUIRED" or .state=="STARTUP_FAILURE" or .state=="STALE")|"  FAILED       \(.name)  \(.link)"'

# Unresolved review threads (bot and human). Only GraphQL exposes isResolved.
read -r owner name < <(gh repo view --json owner,name -q '[.owner.login, .name] | @tsv')
threads=$(gh api graphql -f query="query{repository(owner:\"$owner\",name:\"$name\"){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}" \
  -q '[.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved==false)]|length' 2>/dev/null)
case "$threads" in '' | *[!0-9]*) threads="?" ;; esac
comments=$(gh pr view "$pr" --json comments -q '.comments|length' 2>/dev/null || echo "?")
echo "OPEN_THREADS   $threads unresolved"
echo "COMMENTS       $comments total"
echo "REVIEW         ${decision:-NONE}"

# Single verdict the caller acts on
if [ "$mine" -gt 0 ]; then
  echo "VERDICT        UNCOMMITTED_WORK"
elif [ "$fetch_ok" != 1 ]; then
  echo "VERDICT        BASE_FETCH_FAILED"
elif [ "$has_upstream" != 1 ]; then
  echo "VERDICT        NO_UPSTREAM"
elif [ "$behind" -gt 0 ]; then
  echo "VERDICT        UPSTREAM_AHEAD"
elif [ "$behind_base" -gt 0 ]; then
  echo "VERDICT        BEHIND_BASE"
elif [ "$ahead" -gt 0 ]; then
  echo "VERDICT        LOCAL_UNPUSHED"
elif [ "$local_sha" != "$pr_head" ]; then
  echo "VERDICT        PR_HEAD_MISMATCH"
elif [ "$isdraft" = "true" ]; then
  echo "VERDICT        IS_DRAFT"
elif [ "$state" = "DIRTY" ]; then
  echo "VERDICT        CONFLICTS_WITH_BASE"
elif [ "$state" = "BEHIND" ]; then
  echo "VERDICT        BEHIND_BASE"
elif [ "$fail" -gt 0 ]; then
  echo "VERDICT        CHECKS_FAILING"
elif [ "$total" -eq 0 ] && [ "$allow_no_checks" != 1 ]; then
  echo "VERDICT        CHECKS_STARTING"
elif [ "$pend" -gt 0 ]; then
  echo "VERDICT        CHECKS_RUNNING"
elif [ "$unknown" -gt 0 ]; then
  echo "VERDICT        CHECKS_QUERY_FAILED"
elif [ "$threads" = "?" ]; then
  echo "VERDICT        REVIEW_QUERY_FAILED"
elif [ "$decision" = "CHANGES_REQUESTED" ]; then
  echo "VERDICT        CHANGES_REQUESTED"
elif [ "$threads" != "0" ]; then
  echo "VERDICT        OPEN_REVIEW_THREADS"
elif [ "$state" = "BLOCKED" ]; then
  echo "VERDICT        BLOCKED_NEEDS_APPROVAL"
elif [ "$state" = "CLEAN" ]; then
  case "$rebase_risk" in
    broken) echo "VERDICT        READY_EXCEPT_REBASE" ;;
    high) echo "VERDICT        REBASE_UNPROVEN" ;;
    *) echo "VERDICT        READY_TO_MERGE" ;;
  esac
else
  echo "VERDICT        UNKNOWN_$state"
fi
