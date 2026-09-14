#!/bin/bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/forbidden.sh"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE="${SCRIPT_DIR}/../skills/pr-ready/pr-state.sh"
FINAL="${SCRIPT_DIR}/../skills/pr-ready/pr-final.sh"
PASS=0
FAIL=0
SKIP=0
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

pass() {
  PASS=$((PASS + 1))
  printf '  OK   %s\n' "$1"
}
fail() {
  FAIL=$((FAIL + 1))
  printf '  FAIL %s: %s\n' "$1" "$2"
}

mkdir -p "$SANDBOX/bin"

cat >"$SANDBOX/bin/git" <<'EOF'
#!/bin/bash
head=1111111111111111111111111111111111111111
case "$*" in
  "rev-parse --abbrev-ref HEAD") echo fix/pr-ready ;;
  "rev-parse HEAD") echo "$head" ;;
  "status --porcelain") ;;
  "rev-parse --abbrev-ref @{upstream}")
    [ "${GIT_SCENARIO:-}" = no-upstream ] && exit 1
    echo origin/fix/pr-ready
    ;;
  "rev-list --left-right --count @{upstream}...HEAD")
    case "${GIT_SCENARIO:-}" in
      upstream) echo '1 0' ;;
      unpushed|behind-and-unpushed) echo '0 1' ;;
      *) echo '0 0' ;;
    esac
    ;;
  "fetch --quiet origin +refs/heads/main:refs/remotes/origin/main")
    [ -z "${GIT_FETCH_LOG:-}" ] || echo "$*" > "$GIT_FETCH_LOG"
    [ "${GIT_SCENARIO:-}" != fetch-fail ]
    ;;
  "rev-parse --verify --quiet origin/main") ;;
  "rev-parse origin/main") echo 3333333333333333333333333333333333333333 ;;
  "rev-list --count HEAD..origin/main")
    [ "${GIT_SCENARIO:-}" = behind-and-unpushed ] && echo 1 || echo 0
    ;;
  "rev-list --count origin/main..HEAD") echo 1 ;;
  "rev-list --merges --count origin/main..HEAD") echo 0 ;;
  *) printf 'unexpected git call: %s\n' "$*" >&2; exit 2 ;;
esac
EOF

cat >"$SANDBOX/bin/gh" <<'EOF'
#!/bin/bash
if [ "$1 $2" = "pr view" ]; then
  if [[ "$*" == *statusCheckRollup* ]]; then
    head=1111111111111111111111111111111111111111
    decision=""
    checks='[{"__typename":"CheckRun","name":"ci","status":"COMPLETED","conclusion":"SUCCESS","detailsUrl":"https://example.test/run/1"}]'
    state=CLEAN
    mergeable=MERGEABLE
    case "${PR_TEST_SCENARIO:-success}" in
      pending) checks='[{"__typename":"CheckRun","name":"ci","status":"IN_PROGRESS","conclusion":"","detailsUrl":"https://example.test/run/2"}]' ;;
      failure) checks='[{"__typename":"CheckRun","name":"ci","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://example.test/run/3"}]' ;;
      none) checks='[]' ;;
      mismatch) head=2222222222222222222222222222222222222222 ;;
      changes) decision=CHANGES_REQUESTED ;;
      dirty) state=DIRTY; mergeable=CONFLICTING ;;
    esac
    jq -n --arg head "$head" --arg decision "$decision" --arg state "$state" --arg mergeable "$mergeable" --argjson checks "$checks" \
      '{number:7,isDraft:false,mergeable:$mergeable,mergeStateStatus:$state,title:"mock",baseRefName:"main",headRefOid:$head,reviewDecision:$decision,url:"https://example.test/pr/7",statusCheckRollup:$checks}'
  else
    echo 0
  fi
elif [ "$1 $2" = "repo view" ]; then
  if [[ "$*" == *mergeCommitAllowed* ]]; then
    printf 'true\ttrue\ttrue\n'
  else
    printf 'example\trepository\n'
  fi
elif [ "$1 $2" = "api graphql" ]; then
  [ "${PR_TEST_SCENARIO:-}" = threads ] && echo 1 || echo 0
else
  exit 2
fi
EOF

chmod +x "$SANDBOX/bin/git" "$SANDBOX/bin/gh"

cat >"$SANDBOX/bin/state-sequence" <<'EOF'
#!/bin/bash
count=0
[ ! -f "$PR_FINAL_COUNT_FILE" ] || read -r count < "$PR_FINAL_COUNT_FILE"
count=$((count + 1))
printf '%s\n' "$count" > "$PR_FINAL_COUNT_FILE"

local_head=1111111111111111111111111111111111111111
pr_head=$local_head
base_head=3333333333333333333333333333333333333333
verdict=READY_TO_MERGE
case "${PR_FINAL_SCENARIO:-stable}" in
  conflict-first) verdict=CONFLICTS_WITH_BASE ;;
  conflict-second) [ "$count" -eq 1 ] || verdict=CONFLICTS_WITH_BASE ;;
  head-change)
    if [ "$count" -gt 1 ]; then
      local_head=2222222222222222222222222222222222222222
      pr_head=$local_head
    fi
    ;;
  base-change)
    [ "$count" -eq 1 ] || base_head=4444444444444444444444444444444444444444
    ;;
esac

echo "LOCAL_HEAD     $local_head"
echo "BASE_HEAD      $base_head"
echo "PR_HEAD        $pr_head"
echo "VERDICT        $verdict"
EOF

chmod +x "$SANDBOX/bin/state-sequence"

run_case() {
  label="$1"
  pr_scenario="$2"
  git_scenario="$3"
  expected="$4"
  shift 4
  output=$(PATH="$SANDBOX/bin:$PATH" PR_TEST_SCENARIO="$pr_scenario" GIT_SCENARIO="$git_scenario" "$STATE" 7 "$@")
  actual=$(printf '%s\n' "$output" | awk '/^VERDICT/{print $2}')
  if [ "$actual" = "$expected" ]; then
    pass "$label"
  else
    fail "$label" "expected $expected, got ${actual:-no verdict}"
  fi
}

run_case "green current head is ready" success normal READY_TO_MERGE
run_case "pending check keeps watching" pending normal CHECKS_RUNNING
run_case "failed check requires diagnosis" failure normal CHECKS_FAILING
run_case "new head with no checks waits for registration" none normal CHECKS_STARTING
run_case "verified repository without CI can opt out" none normal READY_TO_MERGE --allow-no-checks
run_case "replacement PR head invalidates old results" mismatch normal PR_HEAD_MISMATCH
run_case "requested changes block readiness" changes normal CHANGES_REQUESTED
run_case "unresolved review thread blocks readiness" threads normal OPEN_REVIEW_THREADS
run_case "failed base refresh blocks readiness" success fetch-fail BASE_FETCH_FAILED
run_case "remote commits block readiness" success upstream UPSTREAM_AHEAD
run_case "local commits must be pushed" success unpushed LOCAL_UNPUSHED
run_case "missing tracking branch must be repaired" success no-upstream NO_UPSTREAM
run_case "base drift outranks an unpushed local commit" success behind-and-unpushed BEHIND_BASE
run_case "GitHub conflict blocks a current branch" dirty normal CONFLICTS_WITH_BASE

state_output=$(PATH="$SANDBOX/bin:$PATH" "$STATE" 7)
if printf '%s\n' "$state_output" | grep -q '^BASE_HEAD      3333333333333333333333333333333333333333$'; then
  pass "state snapshot records the fetched base head"
else
  fail "state snapshot records the fetched base head" "BASE_HEAD was absent or incorrect"
fi

fetch_log="$SANDBOX/fetch-log"
PATH="$SANDBOX/bin:$PATH" GIT_FETCH_LOG="$fetch_log" "$STATE" 7 >/dev/null
if [ "$(cat "$fetch_log")" = "fetch --quiet origin +refs/heads/main:refs/remotes/origin/main" ]; then
  pass "base refresh updates the exact remote-tracking ref"
else
  fail "base refresh updates the exact remote-tracking ref" "got $(cat "$fetch_log")"
fi

run_final_case() {
  label="$1"
  scenario="$2"
  expected="$3"
  expected_calls="$4"
  count_file="$SANDBOX/final-count"
  rm -f "$count_file"
  output=$(PR_READY_STATE_COMMAND="$SANDBOX/bin/state-sequence" PR_READY_STABILITY_SECONDS=0 PR_FINAL_COUNT_FILE="$count_file" PR_FINAL_SCENARIO="$scenario" "$FINAL" 7 2>&1)
  actual=$(printf '%s\n' "$output" | awk '/^VERDICT/{print $2}')
  calls=$(cat "$count_file" 2>/dev/null || echo 0)
  if [ "$actual" = "$expected" ] && [ "$calls" = "$expected_calls" ]; then
    pass "$label"
  else
    fail "$label" "expected $expected after $expected_calls snapshot(s), got ${actual:-no verdict} after $calls"
  fi
}

run_final_case "a conflicting first snapshot cannot be certified ready" conflict-first CONFLICTS_WITH_BASE 1
run_final_case "a conflict appearing during settling blocks readiness" conflict-second CONFLICTS_WITH_BASE 2
run_final_case "unchanged ready snapshots certify readiness" stable READY_TO_MERGE 2
run_final_case "a changed PR head invalidates provisional readiness" head-change STABILITY_CHANGED 2
run_final_case "a changed base head invalidates provisional readiness" base-change STABILITY_CHANGED 2

printf '\nResults: %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ]
