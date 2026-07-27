#!/usr/bin/env bash
# One deterministic snapshot of "is this branch actually landable".
#
# Usage: pr-state.sh [pr-number] [options]
#   --exclude <pathspec>   Treat a dirty path as FOREIGN (not this session's work).
#                          Repeatable. Also read from PR_READY_EXCLUDE (colon-separated).
#   --probe-rebase         Actually replay this branch onto the base in a throwaway
#                          detached worktree and report whether rebase-merge is viable.
#   --preserve-merges      Probe with --rebase-merges, keeping merge commits.
#
# Prints a fixed block. Exit 0 always: the caller reads the fields, it does not
# parse exit codes.

set -uo pipefail

pr=""
probe=0
rebase_merges=0
excludes=()

if [ -n "${PR_READY_EXCLUDE:-}" ]; then
  IFS=':' read -r -a env_ex <<< "$PR_READY_EXCLUDE"
  excludes+=("${env_ex[@]}")
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --exclude)        excludes+=("$2"); shift 2 ;;
    --probe-rebase)   probe=1; shift ;;
    --preserve-merges) rebase_merges=1; shift ;;
    *)                pr="$1"; shift ;;
  esac
done

branch=$(git rev-parse --abbrev-ref HEAD)
base=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo main)
[ -n "$pr" ] || pr=$(gh pr view --json number -q .number 2>/dev/null || echo "")

echo "BRANCH         $branch"
echo "BASE           $base"

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
    case "$path" in "$ex"|"$ex"/*) hit=1; break ;; esac
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
if git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
  read -r behind ahead < <(git rev-list --left-right --count '@{upstream}...HEAD' | awk '{print $1, $2}')
  echo "UNPUSHED       $ahead commit(s) ahead of upstream"
  echo "UPSTREAM_AHEAD $behind commit(s) not pulled"
else
  echo "UNPUSHED       no upstream set"
  echo "UPSTREAM_AHEAD n/a"
fi

# Distance from the real base
git fetch --quiet origin "$base" 2>/dev/null
behind_base=0
merge_commits=0
ahead_base=0
if git rev-parse --verify --quiet "origin/$base" >/dev/null; then
  behind_base=$(git rev-list --count "HEAD..origin/$base")
  ahead_base=$(git rev-list --count "origin/$base..HEAD")
  merge_commits=$(git rev-list --merges --count "origin/$base..HEAD")
  echo "BEHIND_BASE    $behind_base commit(s) behind origin/$base"
  echo "AHEAD_BASE     $ahead_base commit(s), $merge_commits of them merge commits"
fi

if [ -z "$pr" ]; then
  echo "PR             none"
  echo "VERDICT        NO_PR"
  exit 0
fi

read -r number isdraft mergeable state title < <(
  gh pr view "$pr" --json number,isDraft,mergeable,mergeStateStatus,title \
    -q '[.number, .isDraft, .mergeable, .mergeStateStatus, .title] | @tsv'
)
echo "PR             #$number  $title"
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
rebase_risk="none"     # none | high | proven | broken
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

# Checks
checks=$(gh pr checks "$pr" --json name,state,link 2>/dev/null || echo "[]")
total=$(printf '%s' "$checks" | jq 'length')
pend=$(printf '%s' "$checks" | jq '[.[]|select(.state=="PENDING" or .state=="QUEUED" or .state=="IN_PROGRESS")]|length')
fail=$(printf '%s' "$checks" | jq '[.[]|select(.state=="FAILURE" or .state=="ERROR" or .state=="TIMED_OUT" or .state=="CANCELLED")]|length')
pass=$(printf '%s' "$checks" | jq '[.[]|select(.state=="SUCCESS")]|length')
echo "CHECKS         $pass passed, $fail failed, $pend running, $total total"
[ "$fail" -gt 0 ] && printf '%s' "$checks" | jq -r '.[]|select(.state=="FAILURE" or .state=="ERROR" or .state=="TIMED_OUT" or .state=="CANCELLED")|"  FAILED       \(.name)  \(.link)"'

# Unresolved review threads (bot and human). Only GraphQL exposes isResolved.
read -r owner name < <(gh repo view --json owner,name -q '[.owner.login, .name] | @tsv')
threads=$(gh api graphql -f query="query{repository(owner:\"$owner\",name:\"$name\"){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}" \
  -q '[.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved==false)]|length' 2>/dev/null || echo "?")
comments=$(gh pr view "$pr" --json comments -q '.comments|length' 2>/dev/null || echo "?")
decision=$(gh pr view "$pr" --json reviewDecision -q '.reviewDecision // "NONE"' 2>/dev/null || echo "?")
echo "OPEN_THREADS   $threads unresolved"
echo "COMMENTS       $comments total"
echo "REVIEW         ${decision:-NONE}"

# Single verdict the caller acts on
if [ "$mine" -gt 0 ];                  then echo "VERDICT        UNCOMMITTED_WORK"
elif [ "$isdraft" = "true" ];          then echo "VERDICT        IS_DRAFT"
elif [ "$state" = "DIRTY" ];           then echo "VERDICT        CONFLICTS_WITH_BASE"
elif [ "$state" = "BEHIND" ];          then echo "VERDICT        BEHIND_BASE"
elif [ "$fail" -gt 0 ];                then echo "VERDICT        CHECKS_FAILING"
elif [ "$pend" -gt 0 ];                then echo "VERDICT        CHECKS_RUNNING"
elif [ "$threads" != "0" ] && [ "$threads" != "?" ]; then echo "VERDICT        OPEN_REVIEW_THREADS"
elif [ "$state" = "BLOCKED" ];         then echo "VERDICT        BLOCKED_NEEDS_APPROVAL"
elif [ "$state" = "CLEAN" ]; then
  case "$rebase_risk" in
    broken) echo "VERDICT        READY_EXCEPT_REBASE" ;;
    high)   echo "VERDICT        REBASE_UNPROVEN" ;;
    *)      echo "VERDICT        READY_TO_MERGE" ;;
  esac
else                                        echo "VERDICT        UNKNOWN_$state"
fi
