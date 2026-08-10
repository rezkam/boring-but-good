#!/usr/bin/env bash
# Test suite for the codex skill. Two tiers:
#
#   OFFLINE  argument validation, error paths, helpers, the full delete
#            lifecycle (guards, --force against a live pid, --last, --all),
#            and every exec liveness verdict (wedged/stalled/dead) against
#            fabricated metadata with real pids. No codex API calls.
#   LIVE     every feature end to end against the real codex CLI: review
#            start (--wait and background, direct and exec runner), status,
#            report, converse continuation, exec worker delegation (launch,
#            liveness poll to completion, produced-change proof, follow-up,
#            stop), list, MCP server start, multi turn conversation with
#            context continuity AND new-thread isolation proofs, status,
#            stop, the documented disk-resume recovery path, and delete of
#            real finished runs.
#
# Run everything:      tests/run-tests.sh
# Offline only (free): tests/run-tests.sh --offline
#
# Live tests pin model_reasoning_effort=low so a full run costs a few small
# turns. Context continuity is proven with a codeword: turn 1 stores it,
# turn 2 must recall it, which only works if the thread really continued.
set -uo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS_DIR="$(cd "$TESTS_DIR/../scripts" && pwd)"
for GNU_DIR in /opt/homebrew/opt/findutils/libexec/gnubin /opt/homebrew/opt/coreutils/libexec/gnubin; do
    [[ -d "$GNU_DIR" ]] && PATH="$GNU_DIR:$PATH"
done
export PATH

OFFLINE_ONLY="false"
KEEP="false"
for arg in "$@"; do
    case "$arg" in
        --offline) OFFLINE_ONLY="true" ;;
        --keep) KEEP="true" ;;
        --help|-h)
            sed -n '2,16p' "$0"
            exit 0
            ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

WORK="$(mktemp -d /tmp/codex-skill-tests.XXXXXX)"
export CODEX_REVIEW_HOME="$WORK/home"
FIXTURE_REPO="$WORK/fixture-repo"

PASS=0
FAIL=0
FAILED_NAMES=()

note() { printf '\n== %s\n' "$1"; }

check() {
    local name="$1"
    local ok="$2"
    local detail="${3:-}"
    if [[ "$ok" == "0" ]]; then
        PASS=$((PASS + 1))
        printf 'ok   %s\n' "$name"
    else
        FAIL=$((FAIL + 1))
        FAILED_NAMES+=("$name")
        printf 'FAIL %s%s\n' "$name" "${detail:+ | $detail}"
    fi
}

assert_contains() {
    local name="$1" haystack="$2" needle="$3"
    if printf '%s' "$haystack" | grep -qF -- "$needle"; then
        check "$name" 0
    else
        check "$name" 1 "expected to contain '$needle', got: $(printf '%s' "$haystack" | head -c 200)"
    fi
}

assert_exit_nonzero() {
    local name="$1" code="$2" output="$3" needle="$4"
    if [[ "$code" -ne 0 ]] && printf '%s' "$output" | grep -qF -- "$needle"; then
        check "$name" 0
    else
        check "$name" 1 "exit=$code output: $(printf '%s' "$output" | head -c 200)"
    fi
}

make_fixture_repo() {
    mkdir -p "$FIXTURE_REPO"
    git -C "$FIXTURE_REPO" init -q
    git -C "$FIXTURE_REPO" config user.email test@example.com
    git -C "$FIXTURE_REPO" config user.name "Codex Skill Tests"
    cat > "$FIXTURE_REPO/discount.py" <<'PY'
def apply_discount(price, percent):
    """Return price reduced by percent (0-100)."""
    return price * percent / 100
PY
    git -C "$FIXTURE_REPO" add -A
    git -C "$FIXTURE_REPO" -c commit.gpgSign=false commit -qm "initial"
    # Uncommitted change with a planted, findable bug: the function now
    # returns the DISCOUNT AMOUNT, not the discounted price, and divides by
    # zero when percent is 100 in the added guard.
    cat > "$FIXTURE_REPO/discount.py" <<'PY'
def apply_discount(price, percent):
    """Return price reduced by percent (0-100)."""
    remaining = 100 - percent
    return price / (100 / remaining)
PY
}

# ---------------------------------------------------------------------------
note "OFFLINE: argument and error contracts"
# ---------------------------------------------------------------------------

VALID_EFFORTS="minimal, low, medium, high, or xhigh"

out="$("$SCRIPTS_DIR/codex-review-start.sh" --preset bogus 2>&1)"; code=$?
assert_exit_nonzero "review-start rejects unknown preset" "$code" "$out" "Unknown preset"

out="$("$SCRIPTS_DIR/codex-review-start.sh" --effort bogus 2>&1)"; code=$?
assert_exit_nonzero "review-start rejects unknown effort" "$code" "$out" "$VALID_EFFORTS"

# codex-cli 0.142.5 parse-time conflict: scope flags vs [PROMPT]. The script
# must refuse base/commit scope with a prompt instead of silently dropping it.
out="$("$SCRIPTS_DIR/codex-review-start.sh" --base main --preset adversarial 2>&1)"; code=$?
assert_exit_nonzero "review-start refuses preset with base scope" "$code" "$out" "mutually exclusive"
out="$("$SCRIPTS_DIR/codex-review-start.sh" --commit HEAD --prompt "check auth" 2>&1)"; code=$?
assert_exit_nonzero "review-start refuses custom prompt with commit scope" "$code" "$out" "mutually exclusive"

out="$("$SCRIPTS_DIR/codex-mcp-start.sh" --sandbox bogus 2>&1)"; code=$?
assert_exit_nonzero "mcp-start rejects unknown sandbox" "$code" "$out" "Unknown sandbox"

out="$("$SCRIPTS_DIR/codex-mcp-start.sh" --effort bogus 2>&1)"; code=$?
assert_exit_nonzero "mcp-start rejects unknown effort" "$code" "$out" "$VALID_EFFORTS"

out="$("$SCRIPTS_DIR/codex-mcp-start.sh" --workdir /nonexistent-dir-xyz 2>&1)"; code=$?
assert_exit_nonzero "mcp-start rejects missing workdir" "$code" "$out" "Workdir not found"

out="$("$SCRIPTS_DIR/codex-mcp-send.sh" --last "hello" 2>&1)"; code=$?
assert_exit_nonzero "mcp-send without any server errors" "$code" "$out" "No MCP server run found"

out="$("$SCRIPTS_DIR/codex-mcp-send.sh" some-run-id --effort bogus "hi" 2>&1)"; code=$?
assert_exit_nonzero "mcp-send rejects unknown effort" "$code" "$out" "$VALID_EFFORTS"

out="$("$SCRIPTS_DIR/codex-mcp-send.sh" some-run-id --timeout abc "hi" 2>&1)"; code=$?
assert_exit_nonzero "mcp-send rejects non-numeric timeout" "$code" "$out" "--timeout must be"

out="$("$SCRIPTS_DIR/codex-mcp-status.sh" 2>&1)"; code=$?
assert_exit_nonzero "mcp-status without runs errors" "$code" "$out" "No MCP server run found"

out="$("$SCRIPTS_DIR/codex-mcp-stop.sh" 2>&1)"; code=$?
assert_exit_nonzero "mcp-stop without runs errors" "$code" "$out" "No MCP server run found"

out="$("$SCRIPTS_DIR/codex-status.sh" 2>&1)"; code=$?
assert_exit_nonzero "status without runs errors" "$code" "$out" "No run found"

out="$("$SCRIPTS_DIR/codex-status.sh" --quiet-secs nope 2>&1)"; code=$?
assert_exit_nonzero "status rejects non-numeric quiet seconds" "$code" "$out" "--quiet-secs"

out="$("$SCRIPTS_DIR/codex-exec-status.sh" --quiet-secs nope 2>&1)"; code=$?
assert_exit_nonzero "exec-status rejects non-numeric quiet seconds" "$code" "$out" "--quiet-secs"

out="$("$SCRIPTS_DIR/codex-watch.sh" fake-run --interval nope 2>&1)"; code=$?
assert_exit_nonzero "watch rejects non-numeric interval" "$code" "$out" "--interval must be"

out="$("$SCRIPTS_DIR/codex-review-converse.sh" nonexistent-run "hi" 2>&1)"; code=$?
assert_exit_nonzero "converse on unknown run errors" "$code" "$out" "Metadata missing"

out="$("$SCRIPTS_DIR/codex-review-list.sh" 2>&1)"; code=$?
if [[ "$code" -eq 0 ]]; then
    assert_contains "list on empty home reports no runs" "$out" "No runs yet"
else
    check "list on empty home reports no runs" 1 "exit=$code"
fi

# Kind guards: an mcp command pointed at a review run must refuse, and vice
# versa. Build a fake review meta through the real helper to test this
# without any codex call.
(
    source "$SCRIPTS_DIR/_helpers.sh"
    codex_review_create_meta "fake-review-run" "/tmp" "uncommitted" "" "t" "" "" "" "/tmp/log" "/tmp/report" "/tmp/conv"
)
out="$("$SCRIPTS_DIR/codex-mcp-send.sh" fake-review-run "hi" 2>&1)"; code=$?
assert_exit_nonzero "mcp-send refuses a review-kind run" "$code" "$out" "is a review run"
out="$("$SCRIPTS_DIR/codex-mcp-status.sh" fake-review-run 2>&1)"; code=$?
assert_exit_nonzero "mcp-status refuses a review-kind run" "$code" "$out" "is a review run"
out="$("$SCRIPTS_DIR/codex-mcp-stop.sh" fake-review-run 2>&1)"; code=$?
assert_exit_nonzero "mcp-stop refuses a review-kind run" "$code" "$out" "is a review run"

# Exec worker contracts. The liveness verdicts (wedged / stalled / dead) are
# the coordinator's safety net, so each is proven offline with fabricated
# metadata and real pids; no codex call needed.
out="$("$SCRIPTS_DIR/codex-exec-start.sh" 2>&1)"; code=$?
assert_exit_nonzero "exec-start rejects missing prompt" "$code" "$out" "No task prompt"

out="$("$SCRIPTS_DIR/codex-exec-start.sh" --sandbox bogus "do things" 2>&1)"; code=$?
assert_exit_nonzero "exec-start rejects unknown sandbox" "$code" "$out" "Unknown sandbox"

out="$("$SCRIPTS_DIR/codex-exec-start.sh" --effort bogus "do things" 2>&1)"; code=$?
assert_exit_nonzero "exec-start rejects unknown effort" "$code" "$out" "$VALID_EFFORTS"

out="$("$SCRIPTS_DIR/codex-exec-start.sh" --workdir /nonexistent-dir-xyz "do things" 2>&1)"; code=$?
assert_exit_nonzero "exec-start rejects missing workdir" "$code" "$out" "Workdir not found"

out="$("$SCRIPTS_DIR/codex-exec-start.sh" --prompt-file /nonexistent-prompt.txt 2>&1)"; code=$?
assert_exit_nonzero "exec-start rejects missing prompt file" "$code" "$out" "Prompt file not found"

FAKE_CODEX_BIN="$WORK/fake-codex-bin"
FAKE_CODEX_PID_FILE="$WORK/fake-codex.pids"
NONBLOCK_REPO="$WORK/nonblock-repo"
mkdir -p "$FAKE_CODEX_BIN" "$NONBLOCK_REPO"
cat > "$FAKE_CODEX_BIN/codex" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$$" >> "$FAKE_CODEX_PID_FILE"
printf '{"thread_id":"00000000-0000-0000-0000-000000000001"}\n'
sleep 30
SH
chmod +x "$FAKE_CODEX_BIN/codex"
nonblock_out="$(
    PATH="$FAKE_CODEX_BIN:$PATH" FAKE_CODEX_PID_FILE="$FAKE_CODEX_PID_FILE" timeout 10 bash -c '
        out="$("$1/codex-exec-start.sh" --workdir "$2" "fake slow worker")"
        printf "%s\n" "$out"
    ' _ "$SCRIPTS_DIR" "$NONBLOCK_REPO" 2>&1
)"
code=$?
NONBLOCK_RUN_ID="$(printf '%s' "$nonblock_out" | awk '/^run_id:/ {print $2; exit}')"
if [[ "$code" -eq 0 && -n "$NONBLOCK_RUN_ID" ]]; then
    check "exec-start command substitution returns before worker finishes" 0
else
    check "exec-start command substitution returns before worker finishes" 1 "exit=$code output: $(printf '%s' "$nonblock_out" | head -c 200)"
fi
if [[ -n "$NONBLOCK_RUN_ID" ]]; then
    "$SCRIPTS_DIR/codex-exec-stop.sh" "$NONBLOCK_RUN_ID" >/dev/null 2>&1 || true
    "$SCRIPTS_DIR/codex-delete.sh" "$NONBLOCK_RUN_ID" --force >/dev/null 2>&1 || true
fi
if [[ -f "$FAKE_CODEX_PID_FILE" ]]; then
    while IFS= read -r fake_pid; do
        kill "$fake_pid" 2>/dev/null || true
    done < "$FAKE_CODEX_PID_FILE"
fi
rm -rf "$FAKE_CODEX_BIN" "$NONBLOCK_REPO" "$FAKE_CODEX_PID_FILE"

out="$("$SCRIPTS_DIR/codex-exec-status.sh" 2>&1)"; code=$?
assert_exit_nonzero "exec-status without runs errors" "$code" "$out" "No exec run found"

out="$("$SCRIPTS_DIR/codex-exec-stop.sh" 2>&1)"; code=$?
assert_exit_nonzero "exec-stop without runs errors" "$code" "$out" "No exec run found"

out="$("$SCRIPTS_DIR/codex-exec-status.sh" fake-review-run 2>&1)"; code=$?
assert_exit_nonzero "exec-status refuses a review-kind run" "$code" "$out" "not an exec worker"

fabricate_exec_run() {
    local id="$1" pid="$2" thread="$3"
    (
        source "$SCRIPTS_DIR/_helpers.sh"
        codex_review_create_meta "$id" "/tmp" "exec-task" "" "t" "" "" "workspace-write" \
            "$CODEX_REVIEW_HOME/runs/$id/events.log" "$CODEX_REVIEW_HOME/runs/$id/report.md" "$CODEX_REVIEW_HOME/runs/$id/conv"
        codex_review_set_meta_field "$id" kind "exec"
        codex_review_set_meta_field "$id" status "running"
        [[ -n "$pid" ]] && codex_review_set_meta_field "$id" pid "$pid" number
        [[ -n "$thread" ]] && codex_review_set_meta_field "$id" thread_id "$thread"
    )
}

fabricate_review_run() {
    local id="$1" pid="$2" thread="$3"
    (
        source "$SCRIPTS_DIR/_helpers.sh"
        codex_review_create_meta "$id" "/tmp" "uncommitted" "" "t" "" "" "workspace-write" \
            "$CODEX_REVIEW_HOME/runs/$id/review.log" "$CODEX_REVIEW_HOME/runs/$id/report.md" "$CODEX_REVIEW_HOME/runs/$id/conv"
        codex_review_set_meta_field "$id" kind "review"
        codex_review_set_meta_field "$id" status "running"
        [[ -n "$pid" ]] && codex_review_set_meta_field "$id" pid "$pid" number
        [[ -n "$thread" ]] && codex_review_set_meta_field "$id" thread_id "$thread"
    )
}

fabricate_mcp_run() {
    local id="$1" pid="$2" thread="${3:-}"
    (
        source "$SCRIPTS_DIR/_helpers.sh"
        codex_mcp_create_meta "$id" "/tmp" "t" "" "read-only" \
            "$CODEX_REVIEW_HOME/runs/$id/in.fifo" "$CODEX_REVIEW_HOME/runs/$id/out.jsonl" \
            "$CODEX_REVIEW_HOME/runs/$id/err.log" "$CODEX_REVIEW_HOME/runs/$id/conv"
        codex_review_set_meta_field "$id" status "running"
        [[ -n "$pid" ]] && codex_review_set_meta_field "$id" pid "$pid" number
        [[ -n "$thread" ]] && codex_review_set_meta_field "$id" thread_id "$thread"
    )
}

assert_pure_verdict() {
    local name="$1" expected_verdict="$2" expected_advice_code="$3"
    local status="$4" pid_alive="$5" thread_known="$6" age_s="$7" log_age_s="$8" network_active="$9" child_cmd_running="${10}"
    local out verdict advice_code

    out="$(
        source "$SCRIPTS_DIR/_helpers.sh"
        codex_skill_liveness_verdict "$status" "$pid_alive" "$thread_known" "$age_s" "$log_age_s" "$network_active" "$child_cmd_running" 180 180 1200
    )"
    verdict="$(printf '%s' "$out" | jq -r '.verdict' 2>/dev/null || echo invalid)"
    advice_code="$(printf '%s' "$out" | jq -r '.advice_code // ""' 2>/dev/null || echo invalid)"
    if [[ "$verdict" == "$expected_verdict" && "$advice_code" == "$expected_advice_code" ]]; then
        check "$name" 0
    else
        check "$name" 1 "verdict=$verdict advice_code=$advice_code output: $(printf '%s' "$out" | head -c 200)"
    fi
}

probe_field() {
    local line="$1" key="$2"
    printf '%s\n' "$line" | tr ' ' '\n' | awk -F= -v key="$key" '$1 == key { print $2; exit }'
}

assert_pure_verdict "pure verdict fresh log is running" "running" "" "running" "true" "true" 60 10 "false" "false"
assert_pure_verdict "pure verdict idle with network is quiet" "quiet" "quiet_active" "running" "true" "true" 60 300 "true" "false"
assert_pure_verdict "pure verdict idle with child command is quiet" "quiet" "quiet_active" "running" "true" "true" 60 300 "false" "true"
assert_pure_verdict "pure verdict idle without activity is stalled" "stalled" "hang_signature" "running" "true" "true" 60 300 "false" "false"
assert_pure_verdict "pure verdict past stall wins over network" "stalled" "stall_cliff" "running" "true" "true" 60 1300 "true" "false"
assert_pure_verdict "pure verdict still wedges without thread" "wedged" "wedged" "running" "true" "false" 181 10 "false" "false"
assert_pure_verdict "pure verdict unknown network waits for stall cliff" "running" "" "running" "true" "true" 60 300 "unknown" "false"

sleep 300 &
PROBE_SLEEP_PID=$!
probe_out="$(
    source "$SCRIPTS_DIR/_helpers.sh"
    codex_skill_probe_activity "$PROBE_SLEEP_PID"
)"
kill "$PROBE_SLEEP_PID" 2>/dev/null || true
wait "$PROBE_SLEEP_PID" 2>/dev/null || true
probe_codex_pid="$(probe_field "$probe_out" codex_pid)"
if [[ "$probe_codex_pid" == "none" ]]; then
    check "activity probe ignores a non-codex sleep pid" 0
else
    check "activity probe ignores a non-codex sleep pid" 1 "got: $probe_out"
fi

if ps -p $$ -o args= >/dev/null 2>&1; then
    bash -c 'bash -c '"'"'exec -a codex bash -c "sleep 300 & wait"'"'"' & wait' &
    PROBE_WRAPPER_PID=$!
    sleep 0.2
    probe_out="$(
        source "$SCRIPTS_DIR/_helpers.sh"
        codex_skill_probe_activity "$PROBE_WRAPPER_PID"
    )"
    FAKE_LSOF_DIR="$WORK/fake-lsof-bin"
    mkdir -p "$FAKE_LSOF_DIR"
    cat > "$FAKE_LSOF_DIR/lsof" <<'SH'
#!/usr/bin/env bash
echo "lsof: permission denied" >&2
exit 1
SH
    chmod +x "$FAKE_LSOF_DIR/lsof"
    probe_lsof_error_out="$(
        PATH="$FAKE_LSOF_DIR:$PATH"
        source "$SCRIPTS_DIR/_helpers.sh"
        codex_skill_probe_activity "$PROBE_WRAPPER_PID"
    )"
    for child in $(pgrep -P "$PROBE_WRAPPER_PID" 2>/dev/null || true); do
        for grandchild in $(pgrep -P "$child" 2>/dev/null || true); do
            kill "$grandchild" 2>/dev/null || true
        done
        kill "$child" 2>/dev/null || true
    done
    kill "$PROBE_WRAPPER_PID" 2>/dev/null || true
    wait "$PROBE_WRAPPER_PID" 2>/dev/null || true
    probe_codex_pid="$(probe_field "$probe_out" codex_pid)"
    probe_child_cmd="$(probe_field "$probe_out" child_cmd_running)"
    if [[ "$probe_codex_pid" != "none" && "$probe_codex_pid" != "$PROBE_WRAPPER_PID" && "$probe_child_cmd" == "true" ]]; then
        check "activity probe walks to codex child and detects command" 0
    else
        check "activity probe walks to codex child and detects command" 1 "got: $probe_out"
    fi
    probe_error_net="$(probe_field "$probe_lsof_error_out" network_active)"
    if [[ "$probe_error_net" == "unknown" ]]; then
        check "activity probe reports unknown when lsof writes an error" 0
    else
        check "activity probe reports unknown when lsof writes an error" 1 "got: $probe_lsof_error_out"
    fi
else
    check "activity probe child command detection skipped without process listing" 0
fi

fabricate_mcp_run "fake-mcp-thread" "" "00000000-0000-0000-0000-000000000000"
out="$("$SCRIPTS_DIR/codex-mcp-send.sh" fake-mcp-thread --effort low "hi" 2>&1)"; code=$?
assert_exit_nonzero "mcp-send rejects --effort on a continuation turn" "$code" "$out" "thread-opening turn"

# Wedged: live pid, no session, created long ago.
sleep 300 & WEDGE_PID=$!
fabricate_exec_run "fake-exec-wedged" "$WEDGE_PID" ""
(
    source "$SCRIPTS_DIR/_helpers.sh"
    codex_review_set_meta_field "fake-exec-wedged" created_at "$(( $(codex_review_unix_ts) - 600 ))" number
)
out="$("$SCRIPTS_DIR/codex-exec-status.sh" fake-exec-wedged 2>&1)"
assert_contains "exec-status detects a wedged worker" "$out" "verdict: wedged"

# Stalled: live pid, session known, event log frozen for 30 minutes.
fabricate_exec_run "fake-exec-stalled" "$WEDGE_PID" "00000000-0000-0000-0000-000000000000"
printf '{"type":"item.started"}\n' > "$CODEX_REVIEW_HOME/runs/fake-exec-stalled/events.log"
touch -d "30 minutes ago" "$CODEX_REVIEW_HOME/runs/fake-exec-stalled/events.log"
out="$("$SCRIPTS_DIR/codex-exec-status.sh" fake-exec-stalled 2>&1)"
assert_contains "exec-status detects a stalled worker" "$out" "verdict: stalled"

# Dead: status running but the pid is gone.
fabricate_exec_run "fake-exec-dead" "" "00000000-0000-0000-0000-000000000000"
(
    source "$SCRIPTS_DIR/_helpers.sh"
    codex_review_set_meta_field "fake-exec-dead" pid 999999 number
)
out="$("$SCRIPTS_DIR/codex-exec-status.sh" fake-exec-dead 2>&1)"
assert_contains "exec-status detects a dead worker" "$out" "verdict: dead"

fabricate_exec_run "fake-exec-report-complete" "" "00000000-0000-0000-0000-000000000000"
(
    source "$SCRIPTS_DIR/_helpers.sh"
    codex_review_set_meta_field "fake-exec-report-complete" pid 999999 number
)
printf 'done\n' > "$CODEX_REVIEW_HOME/runs/fake-exec-report-complete/report.md"
out="$("$SCRIPTS_DIR/codex-status.sh" fake-exec-report-complete --json 2>&1)"
persisted_status="$(jq -r '.status' "$CODEX_REVIEW_HOME/runs/fake-exec-report-complete/meta.json")"
if [[ "$persisted_status" == "completed" ]] && printf '%s' "$out" | jq -e '.kind == "exec" and .status == "completed" and .verdict == "completed"' >/dev/null 2>&1; then
    check "status reconciles a dead exec with a report as completed" 0
else
    check "status reconciles a dead exec with a report as completed" 1 "persisted=$persisted_status got: $(printf '%s' "$out" | head -c 200)"
fi

# Machine-readable form for coordinators.
out="$("$SCRIPTS_DIR/codex-exec-status.sh" fake-exec-dead --json 2>&1)"
if printf '%s' "$out" | jq -e '.verdict == "dead" and .kind == "exec" and .codex_pid == null and .network_active == false and .child_cmd_running == false' >/dev/null 2>&1; then
    check "exec-status --json is valid and carries the verdict" 0
else
    check "exec-status --json is valid and carries the verdict" 1 "got: $(printf '%s' "$out" | head -c 200)"
fi

exec_status_json="$("$SCRIPTS_DIR/codex-exec-status.sh" fake-exec-dead --json 2>&1)"
status_json="$("$SCRIPTS_DIR/codex-status.sh" fake-exec-dead --json 2>&1)"
exec_verdict="$(printf '%s' "$exec_status_json" | jq -r '.verdict' 2>/dev/null || echo unknown)"
if printf '%s' "$status_json" | jq -e --arg verdict "$exec_verdict" '.kind == "exec" and .verdict == $verdict' >/dev/null 2>&1; then
    check "status --json matches exec-status verdict for exec runs" 0
else
    check "status --json matches exec-status verdict for exec runs" 1 "got: $(printf '%s' "$status_json" | head -c 200)"
fi

fabricate_review_run "fake-review-status" "$WEDGE_PID" "00000000-0000-0000-0000-000000000000"
out="$("$SCRIPTS_DIR/codex-status.sh" fake-review-status --json 2>&1)"
if printf '%s' "$out" | jq -e '.kind == "review" and .verdict == "running"' >/dev/null 2>&1; then
    check "status --json works for review-kind runs" 0
else
    check "status --json works for review-kind runs" 1 "got: $(printf '%s' "$out" | head -c 200)"
fi

fabricate_review_run "fake-review-wedged" "$WEDGE_PID" ""
(
    source "$SCRIPTS_DIR/_helpers.sh"
    codex_review_set_meta_field "fake-review-wedged" created_at "$(( $(codex_review_unix_ts) - 600 ))" number
)
out="$("$SCRIPTS_DIR/codex-status.sh" fake-review-wedged --json 2>&1)"
if printf '%s' "$out" | jq -e '.kind == "review" and .verdict == "wedged" and (.advice | contains("codex-exec-stop.sh") | not) and (.advice | contains("codex-delete.sh")) and (.advice | contains("--force"))' >/dev/null 2>&1; then
    check "status advice for wedged review uses delete force" 0
else
    check "status advice for wedged review uses delete force" 1 "got: $(printf '%s' "$out" | head -c 200)"
fi

fabricate_mcp_run "fake-mcp-status" "$WEDGE_PID"
out="$("$SCRIPTS_DIR/codex-status.sh" fake-mcp-status --json 2>&1)"
if printf '%s' "$out" | jq -e '.kind == "mcp" and .verdict == "running" and .turn_count == 0' >/dev/null 2>&1; then
    check "status --json works for mcp-kind runs" 0
else
    check "status --json works for mcp-kind runs" 1 "got: $(printf '%s' "$out" | head -c 200)"
fi

out="$("$SCRIPTS_DIR/codex-watch.sh" fake-exec-dead --interval 1 2>&1)"; code=$?
if [[ "$code" -eq 3 ]] && printf '%s' "$out" | grep -qF "verdict=dead"; then
    check "watch exits 3 on a dead run" 0
else
    check "watch exits 3 on a dead run" 1 "exit=$code output: $(printf '%s' "$out" | head -c 200)"
fi

# Baseline metadata is the coordinator's diff anchor for delegated work.
fabricate_exec_run "fake-exec-baseline" "" "00000000-0000-0000-0000-000000000000"
(
    source "$SCRIPTS_DIR/_helpers.sh"
    codex_review_set_meta_field "fake-exec-baseline" status "completed"
    codex_review_set_meta_field "fake-exec-baseline" baseline_commit "0123456789abcdef"
    codex_review_set_meta_field "fake-exec-baseline" baseline_dirty "true"
)
out="$("$SCRIPTS_DIR/codex-exec-status.sh" fake-exec-baseline --json 2>&1)"
if printf '%s' "$out" | jq -e '.baseline_commit == "0123456789abcdef" and .baseline_dirty == true' >/dev/null 2>&1; then
    check "exec-status --json carries baseline metadata" 0
else
    check "exec-status --json carries baseline metadata" 1 "got: $(printf '%s' "$out" | head -c 200)"
fi

out="$("$SCRIPTS_DIR/codex-exec-status.sh" fake-exec-baseline 2>&1)"
assert_contains "exec-status human output reports baseline" "$out" "baseline:"

out="$("$SCRIPTS_DIR/codex-watch.sh" fake-exec-baseline --interval 1 2>&1)"; code=$?
line_count="$(printf '%s\n' "$out" | sed '/^$/d' | wc -l)"
if [[ "$code" -eq 0 && "$line_count" -eq 1 ]] && printf '%s' "$out" | grep -qF "verdict=completed"; then
    check "watch prints one transition for an already-completed run" 0
else
    check "watch prints one transition for an already-completed run" 1 "exit=$code lines=$line_count output: $(printf '%s' "$out" | head -c 200)"
fi

out="$("$SCRIPTS_DIR/codex-watch.sh" fake-exec-baseline --heartbeat --interval 1 2>&1)"; code=$?
line_count="$(printf '%s\n' "$out" | sed '/^$/d' | wc -l)"
if [[ "$code" -eq 0 && "$line_count" -eq 1 ]] && printf '%s' "$out" | grep -qF "verdict=completed" && ! printf '%s' "$out" | grep -qF "heartbeat"; then
    check "watch heartbeat still prints one transition for an already-completed run" 0
else
    check "watch heartbeat still prints one transition for an already-completed run" 1 "exit=$code lines=$line_count output: $(printf '%s' "$out" | head -c 200)"
fi

sleep 300 &
HEARTBEAT_PID=$!
fabricate_exec_run "fake-exec-heartbeat-running" "$HEARTBEAT_PID" "00000000-0000-0000-0000-000000000000"
printf '{"type":"item.started"}\n' > "$CODEX_REVIEW_HOME/runs/fake-exec-heartbeat-running/events.log"
touch "$CODEX_REVIEW_HOME/runs/fake-exec-heartbeat-running/events.log"
out="$("$SCRIPTS_DIR/codex-watch.sh" fake-exec-heartbeat-running --heartbeat --interval 1 --timeout 3 2>&1)"; code=$?
heartbeat_count="$(printf '%s\n' "$out" | grep -cF " heartbeat" || true)"
kill "$HEARTBEAT_PID" 2>/dev/null || true
wait "$HEARTBEAT_PID" 2>/dev/null || true
if [[ "$code" -eq 4 && "$heartbeat_count" -ge 2 ]]; then
    check "watch heartbeat prints steady running polls until timeout" 0
else
    check "watch heartbeat prints steady running polls until timeout" 1 "exit=$code heartbeats=$heartbeat_count output: $(printf '%s' "$out" | head -c 300)"
fi

fabricate_exec_run "fake-exec-baseline-none" "" "00000000-0000-0000-0000-000000000000"
(
    source "$SCRIPTS_DIR/_helpers.sh"
    codex_review_set_meta_field "fake-exec-baseline-none" status "completed"
    codex_review_set_meta_field "fake-exec-baseline-none" baseline_commit "none"
    codex_review_set_meta_field "fake-exec-baseline-none" baseline_dirty "false"
)
out="$("$SCRIPTS_DIR/codex-exec-status.sh" fake-exec-baseline-none --json 2>&1)"
if printf '%s' "$out" | jq -e '.baseline_commit == null and .baseline_dirty == false' >/dev/null 2>&1; then
    check "exec-status --json maps none baseline to null" 0
else
    check "exec-status --json maps none baseline to null" 1 "got: $(printf '%s' "$out" | head -c 200)"
fi

# exec-stop on the wedged fake must kill the pid and keep the run listed.
out="$("$SCRIPTS_DIR/codex-exec-stop.sh" fake-exec-wedged 2>&1)"; code=$?
if [[ "$code" -eq 0 ]] && ! kill -0 "$WEDGE_PID" 2>/dev/null && [[ -d "$CODEX_REVIEW_HOME/runs/fake-exec-wedged" ]]; then
    check "exec-stop kills a wedged worker and keeps the run" 0
else
    check "exec-stop kills a wedged worker and keeps the run" 1 "exit=$code"
    kill -9 "$WEDGE_PID" 2>/dev/null || true
fi

# Converse must refuse an MCP run (its live thread belongs to the server).
(
    source "$SCRIPTS_DIR/_helpers.sh"
    codex_mcp_create_meta "fake-mcp-conv" "/tmp" "t" "" "read-only" "/tmp/no.fifo" "/tmp/o" "/tmp/e" "/tmp/c"
    codex_review_set_meta_field "fake-mcp-conv" thread_id "00000000-0000-0000-0000-000000000000"
)
out="$("$SCRIPTS_DIR/codex-review-converse.sh" fake-mcp-conv "hi" 2>&1)"; code=$?
assert_exit_nonzero "converse refuses an MCP run" "$code" "$out" "Use codex-mcp-send.sh"

# Resume must inherit the run's recorded effort/model. `codex exec resume` does
# not carry them forward; without an explicit override it falls back to the
# model's config default (e.g. xhigh for gpt-5.5), silently leaving the tier a
# campaign was pinned to. A stub codex captures the assembled command so we can
# assert the effort override the converse script passes on resume.
EFFORT_STUB_BIN="$WORK/effort-stub-bin"
export EFFORT_CAPTURE="$WORK/effort-capture.txt"
mkdir -p "$EFFORT_STUB_BIN"
cat > "$EFFORT_STUB_BIN/codex" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$EFFORT_CAPTURE"
out=""; prev=""
for a in "$@"; do [[ "$prev" == "--output-last-message" ]] && out="$a"; prev="$a"; done
[[ -n "$out" ]] && printf 'ack\n' > "$out"
exit 0
SH
chmod +x "$EFFORT_STUB_BIN/codex"
effort_set() { ( source "$SCRIPTS_DIR/_helpers.sh"; codex_review_set_meta_field "$@" ); }

fabricate_exec_run "fake-exec-effort" "" "00000000-0000-0000-0000-000000000042"
effort_set fake-exec-effort status "completed"
effort_set fake-exec-effort effort "medium"
PATH="$EFFORT_STUB_BIN:$PATH" "$SCRIPTS_DIR/codex-review-converse.sh" fake-exec-effort "hi" >/dev/null 2>&1 || true
if grep -q 'model_reasoning_effort=medium' "$EFFORT_CAPTURE" 2>/dev/null; then
    check "converse resume inherits the run's recorded effort" 0
else
    check "converse resume inherits the run's recorded effort" 1 "cmd: $(head -c 200 "$EFFORT_CAPTURE" 2>/dev/null)"
fi

PATH="$EFFORT_STUB_BIN:$PATH" "$SCRIPTS_DIR/codex-review-converse.sh" fake-exec-effort --effort high "hi" >/dev/null 2>&1 || true
if grep -q 'model_reasoning_effort=high' "$EFFORT_CAPTURE" 2>/dev/null && ! grep -q 'model_reasoning_effort=medium' "$EFFORT_CAPTURE" 2>/dev/null; then
    check "converse --effort overrides the recorded effort" 0
else
    check "converse --effort overrides the recorded effort" 1 "cmd: $(head -c 200 "$EFFORT_CAPTURE" 2>/dev/null)"
fi

fabricate_exec_run "fake-exec-effort-none" "" "00000000-0000-0000-0000-000000000043"
effort_set fake-exec-effort-none status "completed"
PATH="$EFFORT_STUB_BIN:$PATH" "$SCRIPTS_DIR/codex-review-converse.sh" fake-exec-effort-none "hi" >/dev/null 2>&1 || true
if grep -q 'model_reasoning_effort' "$EFFORT_CAPTURE" 2>/dev/null; then
    check "converse forces no effort when the run recorded none" 1 "cmd: $(head -c 200 "$EFFORT_CAPTURE" 2>/dev/null)"
else
    check "converse forces no effort when the run recorded none" 0
fi

rm -rf "$EFFORT_STUB_BIN" "$EFFORT_CAPTURE" "$CODEX_REVIEW_HOME/runs/fake-exec-effort" "$CODEX_REVIEW_HOME/runs/fake-exec-effort-none"
unset EFFORT_CAPTURE

rm -rf "$CODEX_REVIEW_HOME/runs/fake-exec-wedged" "$CODEX_REVIEW_HOME/runs/fake-exec-stalled" "$CODEX_REVIEW_HOME/runs/fake-exec-dead" "$CODEX_REVIEW_HOME/runs/fake-exec-report-complete" "$CODEX_REVIEW_HOME/runs/fake-exec-baseline" "$CODEX_REVIEW_HOME/runs/fake-exec-heartbeat-running" "$CODEX_REVIEW_HOME/runs/fake-exec-baseline-none" "$CODEX_REVIEW_HOME/runs/fake-review-status" "$CODEX_REVIEW_HOME/runs/fake-review-wedged" "$CODEX_REVIEW_HOME/runs/fake-mcp-status" "$CODEX_REVIEW_HOME/runs/fake-mcp-conv" "$CODEX_REVIEW_HOME/runs/fake-mcp-thread"

# Delete contracts. Deletion needs no codex call, so the whole feature is
# testable offline: guard rails first, then real removal, then --force
# against a genuinely live pid.
out="$("$SCRIPTS_DIR/codex-delete.sh" 2>&1)"; code=$?
assert_exit_nonzero "delete without args errors" "$code" "$out" "No run id given"

out="$("$SCRIPTS_DIR/codex-delete.sh" no-such-run 2>&1)"; code=$?
assert_exit_nonzero "delete unknown run errors" "$code" "$out" "not found"

out="$("$SCRIPTS_DIR/codex-delete.sh" fake-review-run 2>&1)"; code=$?
if [[ "$code" -eq 0 && ! -d "$CODEX_REVIEW_HOME/runs/fake-review-run" ]]; then
    check "delete removes a review run directory" 0
else
    check "delete removes a review run directory" 1 "exit=$code"
fi

# A run whose recorded pid is alive must be refused without --force and
# stopped+deleted with it. Use a real sleep process as the "server".
sleep 300 &
FAKE_PID=$!
(
    source "$SCRIPTS_DIR/_helpers.sh"
    codex_mcp_create_meta "fake-live-mcp" "/tmp" "t" "" "read-only" "/tmp/no.fifo" "/tmp/o" "/tmp/e" "/tmp/c"
    codex_review_set_meta_field "fake-live-mcp" pid "$FAKE_PID" number
)
out="$("$SCRIPTS_DIR/codex-delete.sh" fake-live-mcp 2>&1)"; code=$?
assert_exit_nonzero "delete refuses a live MCP run without --force" "$code" "$out" "live MCP server"
[[ -d "$CODEX_REVIEW_HOME/runs/fake-live-mcp" ]]; check "refused run directory still exists" $?

out="$("$SCRIPTS_DIR/codex-delete.sh" fake-live-mcp --force 2>&1)"; code=$?
if [[ "$code" -eq 0 && ! -d "$CODEX_REVIEW_HOME/runs/fake-live-mcp" ]] && ! kill -0 "$FAKE_PID" 2>/dev/null; then
    check "delete --force stops the process and removes the run" 0
else
    check "delete --force stops the process and removes the run" 1 "exit=$code alive=$(kill -0 "$FAKE_PID" 2>/dev/null && echo yes || echo no)"
    kill -9 "$FAKE_PID" 2>/dev/null || true
fi

(
    source "$SCRIPTS_DIR/_helpers.sh"
    codex_review_create_meta "fake-del-a" "/tmp" "uncommitted" "" "t" "" "" "" "/tmp/log" "/tmp/report" "/tmp/conv"
    sleep 1
    codex_review_create_meta "fake-del-b" "/tmp" "uncommitted" "" "t" "" "" "" "/tmp/log" "/tmp/report" "/tmp/conv"
)
out="$("$SCRIPTS_DIR/codex-delete.sh" --last 2>&1)"; code=$?
if [[ "$code" -eq 0 && ! -d "$CODEX_REVIEW_HOME/runs/fake-del-b" && -d "$CODEX_REVIEW_HOME/runs/fake-del-a" ]]; then
    check "delete --last removes only the newest run" 0
else
    check "delete --last removes only the newest run" 1 "exit=$code"
fi

out="$("$SCRIPTS_DIR/codex-delete.sh" --all 2>&1)"; code=$?
remaining="$(find "$CODEX_REVIEW_HOME/runs" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)"
if [[ "$code" -eq 0 && "$remaining" -eq 0 ]]; then
    check "delete --all empties the run store" 0
else
    check "delete --all empties the run store" 1 "exit=$code remaining=$remaining"
fi

out="$(
    source "$SCRIPTS_DIR/_helpers.sh"
    for p in adversarial security architecture completeness; do
        text="$(codex_review_default_preset_prompt "$p")"
        [[ -n "$text" ]] || { echo "empty preset: $p"; exit 1; }
    done
    [[ -z "$(codex_review_default_preset_prompt unknown)" ]] || { echo "unknown preset not empty"; exit 1; }
    echo "presets-ok"
)"
assert_contains "all four preset prompts defined, unknown empty" "$out" "presets-ok"

if [[ "$OFFLINE_ONLY" == "true" ]]; then
    printf '\n%d passed, %d failed (offline only)\n' "$PASS" "$FAIL"
    [[ "$KEEP" == "true" ]] || rm -rf "$WORK"
    (( FAIL == 0 )) && exit 0 || exit 1
fi

command -v codex >/dev/null || { echo "codex CLI not found; cannot run live tests." >&2; exit 1; }

# ---------------------------------------------------------------------------
note "LIVE: review session lifecycle (exec runner: preset + config)"
# ---------------------------------------------------------------------------
make_fixture_repo

out="$("$SCRIPTS_DIR/codex-review-start.sh" --wait --uncommitted \
    --workdir "$FIXTURE_REPO" --preset adversarial \
    --config model_reasoning_effort=low \
    --title "test exec review" 2>&1)"; code=$?
check "review --wait (exec runner) exits 0" "$code" "$(printf '%s' "$out" | tail -c 200)"
if [[ -n "$out" && "$code" -eq 0 ]]; then check "review --wait produced a report" 0; else check "review --wait produced a report" 1; fi

WAIT_RUN_ID="$("$SCRIPTS_DIR/codex-review-list.sh" 2 | awk -F'\t' 'NR>1 && $2=="review" {print $1; exit}')"
[[ -n "$WAIT_RUN_ID" ]]; check "review run appears in list" $?

status_out="$("$SCRIPTS_DIR/codex-review-status.sh" "$WAIT_RUN_ID" 2>&1)"
assert_contains "review status shows completed" "$status_out" "completed"

report_out="$("$SCRIPTS_DIR/codex-review-report.sh" "$WAIT_RUN_ID" 2>&1)"; code=$?
if [[ "$code" -eq 0 && -n "$report_out" ]]; then check "review report prints" 0; else check "review report prints" 1 "exit=$code"; fi

# Prompt-delivery proof: the preset text must appear in the codex session
# rollout on disk. Guards the `codex exec review -` stdin contract; without
# the trailing `-` the whole prompt is silently dropped and reviews come back
# generic (found live 2026-07-03).
WAIT_THREAD="$(jq -r '.thread_id' "$CODEX_REVIEW_HOME/runs/$WAIT_RUN_ID/meta.json")"
ROLLOUT="$(find "${CODEX_HOME:-$HOME/.codex}/sessions" -name "*${WAIT_THREAD}*.jsonl" 2>/dev/null | head -1)"
[[ -n "$ROLLOUT" ]] && grep -qF "always P0, never lower" "$ROLLOUT"
check "adversarial preset prompt reached the codex session" $?

# Behavioral check on the rubric: the planted crash on a documented valid
# input must be labeled P0.
assert_contains "planted crash labeled P0 per the rubric" "$report_out" "P0"

conv_out="$("$SCRIPTS_DIR/codex-review-converse.sh" "$WAIT_RUN_ID" \
    --config model_reasoning_effort=low \
    "Reply with exactly the word ACK and nothing else." 2>&1)"; code=$?
assert_contains "converse continues the review thread" "$conv_out" "ACK"

# ---------------------------------------------------------------------------
note "LIVE: review session lifecycle (background + direct runner)"
# ---------------------------------------------------------------------------

start_out="$("$SCRIPTS_DIR/codex-review-start.sh" --uncommitted \
    --workdir "$FIXTURE_REPO" \
    --config model_reasoning_effort=low 2>&1)"; code=$?
check "background review starts" "$code"
BG_RUN_ID="$(printf '%s' "$start_out" | awk '/^run_id:/ {print $2; exit}')"
[[ -n "$BG_RUN_ID" ]]; check "background start prints run_id" $?

deadline=$((SECONDS + 600))
bg_status="running"
while (( SECONDS < deadline )); do
    bg_status="$(jq -r '.status' "$CODEX_REVIEW_HOME/runs/$BG_RUN_ID/meta.json" 2>/dev/null || echo unknown)"
    [[ "$bg_status" == "completed" || "$bg_status" == "failed" ]] && break
    sleep 10
done
[[ "$bg_status" == "completed" ]]; check "background review completes (status=$bg_status)" $?

bg_report="$("$SCRIPTS_DIR/codex-review-report.sh" "$BG_RUN_ID" 2>&1)"; code=$?
if [[ "$code" -eq 0 && -n "$bg_report" ]]; then check "background review report non-empty" 0; else check "background review report non-empty" 1; fi

commit_out="$("$SCRIPTS_DIR/codex-review-start.sh" --wait --commit HEAD \
    --workdir "$FIXTURE_REPO" \
    --config model_reasoning_effort=low 2>&1)"; code=$?
if [[ "$code" -eq 0 && -n "$commit_out" ]]; then
    check "review --wait --commit (direct runner) produces output" 0
else
    check "review --wait --commit (direct runner) produces output" 1 "exit=$code: $(printf '%s' "$commit_out" | head -c 200)"
fi

# ---------------------------------------------------------------------------
note "LIVE: exec worker lifecycle (delegated implementation + liveness)"
# ---------------------------------------------------------------------------

exec_out="$("$SCRIPTS_DIR/codex-exec-start.sh" --workdir "$FIXTURE_REPO" \
    --effort low --title "test exec worker" \
    "First execute the shell command 'sleep 45'. After that, create a file named WORKER_NOTE.txt in the repository root containing exactly the line EXEC-WORKER-OK and nothing else. Do not run git commands." 2>&1)"; code=$?
check "exec-start launches a background worker" "$code" "$(printf '%s' "$exec_out" | tail -c 200)"
EXEC_RUN_ID="$(printf '%s' "$exec_out" | awk '/^run_id:/ {print $2; exit}')"
[[ -n "$EXEC_RUN_ID" ]]; check "exec-start prints run_id" $?
EXEC_EFFORT="$(jq -r '.effort // ""' "$CODEX_REVIEW_HOME/runs/$EXEC_RUN_ID/meta.json" 2>/dev/null || true)"
[[ "$EXEC_EFFORT" == "low" ]]; check "exec worker meta records effort" $?

exec_activity_seen="false"
for _ in $(seq 1 30); do
    exec_status_json="$("$SCRIPTS_DIR/codex-exec-status.sh" "$EXEC_RUN_ID" --json 2>/dev/null || true)"
    if printf '%s' "$exec_status_json" | jq -e '.network_active == true or .child_cmd_running == true' >/dev/null 2>&1; then
        exec_activity_seen="true"
        break
    fi
    sleep 2
done
[[ "$exec_activity_seen" == "true" ]]; check "probe observes worker activity while it runs" $?

exec_verdict="unknown"
deadline=$((SECONDS + 600))
while (( SECONDS < deadline )); do
    exec_verdict="$("$SCRIPTS_DIR/codex-exec-status.sh" "$EXEC_RUN_ID" --json 2>/dev/null | jq -r '.verdict' || echo unknown)"
    case "$exec_verdict" in completed|failed|dead|wedged) break ;; esac
    sleep 5
done
[[ "$exec_verdict" == "completed" ]]; check "exec worker completes (verdict=$exec_verdict)" $?

[[ -f "$FIXTURE_REPO/WORKER_NOTE.txt" ]] && grep -qx "EXEC-WORKER-OK" "$FIXTURE_REPO/WORKER_NOTE.txt"
check "exec worker really produced the requested change" $?

exec_status="$("$SCRIPTS_DIR/codex-exec-status.sh" "$EXEC_RUN_ID" 2>&1)"
assert_contains "exec-status reports the final message location" "$exec_status" "final message"

exec_conv="$("$SCRIPTS_DIR/codex-review-converse.sh" "$EXEC_RUN_ID" \
    --config model_reasoning_effort=low \
    "Reply with exactly the word ACK and nothing else." 2>&1)"; code=$?
assert_contains "converse continues the exec worker session" "$exec_conv" "ACK"

out="$("$SCRIPTS_DIR/codex-exec-stop.sh" "$EXEC_RUN_ID" 2>&1)"; code=$?
if [[ "$code" -eq 0 ]] && printf '%s' "$out" | grep -q "was not running"; then
    check "exec-stop on a finished worker is a safe no-op" 0
else
    check "exec-stop on a finished worker is a safe no-op" 1 "exit=$code: $(printf '%s' "$out" | head -c 200)"
fi

# ---------------------------------------------------------------------------
note "LIVE: MCP server multi-turn conversation"
# ---------------------------------------------------------------------------

mcp_out="$("$SCRIPTS_DIR/codex-mcp-start.sh" --workdir "$FIXTURE_REPO" \
    --title "test mcp" --sandbox read-only 2>&1)"; code=$?
check "mcp-start reaches ready" "$code" "$(printf '%s' "$mcp_out" | tail -c 200)"
MCP_RUN_ID="$(printf '%s' "$mcp_out" | awk '/^run_id:/ {print $2; exit}')"
[[ -n "$MCP_RUN_ID" ]]; check "mcp-start prints run_id" $?

t1="$("$SCRIPTS_DIR/codex-mcp-send.sh" "$MCP_RUN_ID" --timeout 300 \
    --config model_reasoning_effort=low \
    "The codeword is MANGO. Acknowledge with exactly: STORED" 2>&1)"; code=$?
assert_contains "mcp turn 1 answers" "$t1" "STORED"

CODEWORD_THREAD="$(jq -r '.thread_id' "$CODEX_REVIEW_HOME/runs/$MCP_RUN_ID/meta.json")"
[[ -n "$CODEWORD_THREAD" && "$CODEWORD_THREAD" != "null" ]]; check "thread_id recorded after turn 1" $?

t2="$("$SCRIPTS_DIR/codex-mcp-send.sh" "$MCP_RUN_ID" --timeout 300 \
    "What is the codeword? Reply with only the codeword." 2>&1)"; code=$?
assert_contains "mcp turn 2 proves context continuity" "$t2" "MANGO"

out="$("$SCRIPTS_DIR/codex-mcp-send.sh" "$MCP_RUN_ID" --preset adversarial "hi" 2>&1)"; code=$?
assert_exit_nonzero "mcp-send rejects --preset on a continuation turn" "$code" "$out" "thread-opening turn"

t3="$("$SCRIPTS_DIR/codex-mcp-send.sh" "$MCP_RUN_ID" --timeout 600 \
    --new-thread --preset adversarial \
    --config model_reasoning_effort=low \
    "Review the uncommitted change to discount.py in this repository. State your single strongest finding in at most two sentences." 2>&1)"; code=$?
if [[ "$code" -eq 0 && -n "$t3" ]]; then check "mcp --new-thread --preset adversarial turn answers" 0; else check "mcp --new-thread --preset adversarial turn answers" 1 "exit=$code: $(printf '%s' "$t3" | head -c 200)"; fi

NEW_THREAD="$(jq -r '.thread_id' "$CODEX_REVIEW_HOME/runs/$MCP_RUN_ID/meta.json")"
[[ -n "$NEW_THREAD" && "$NEW_THREAD" != "$CODEWORD_THREAD" ]]; check "--new-thread switched to a new thread" $?

# Isolation, the flip side of continuity: the new thread must NOT know the
# old thread's codeword. A same-server context leak would pass every
# continuity check while being exactly the bug users fear.
t4="$("$SCRIPTS_DIR/codex-mcp-send.sh" "$MCP_RUN_ID" --timeout 300 \
    "What is the codeword? If no codeword was given earlier in this conversation, reply with exactly: UNKNOWN" 2>&1)"; code=$?
if printf '%s' "$t4" | grep -q "UNKNOWN" && ! printf '%s' "$t4" | grep -q "MANGO"; then
    check "new thread does not know the old thread's codeword" 0
else
    check "new thread does not know the old thread's codeword" 1 "got: $(printf '%s' "$t4" | head -c 200)"
fi

turn_files="$(find "$CODEX_REVIEW_HOME/runs/$MCP_RUN_ID/conversations" -name 'turn-*.md' | wc -l)"
(( turn_files >= 4 )); check "turn transcripts archived (found $turn_files)" $?

mcp_status="$("$SCRIPTS_DIR/codex-mcp-status.sh" "$MCP_RUN_ID" 2>&1)"
assert_contains "mcp-status shows live server" "$mcp_status" "server_alive: true"
assert_contains "mcp-status shows turn count" "$mcp_status" "turn_count: 4"

list_out="$("$SCRIPTS_DIR/codex-review-list.sh" 10 2>&1)"
assert_contains "list shows mcp kind" "$list_out" "mcp"
assert_contains "list shows review kind" "$list_out" "review"
assert_contains "list shows exec kind" "$list_out" "exec"

# ---------------------------------------------------------------------------
note "LIVE: MCP stop + disk-resume recovery"
# ---------------------------------------------------------------------------

stop_out="$("$SCRIPTS_DIR/codex-mcp-stop.sh" "$MCP_RUN_ID" 2>&1)"; code=$?
check "mcp-stop exits 0" "$code"
MCP_PID="$(jq -r '.pid' "$CODEX_REVIEW_HOME/runs/$MCP_RUN_ID/meta.json")"
! kill -0 "$MCP_PID" 2>/dev/null; check "server process is gone" $?

out="$("$SCRIPTS_DIR/codex-mcp-send.sh" "$MCP_RUN_ID" "hello again" 2>&1)"; code=$?
assert_exit_nonzero "mcp-send after stop points at disk resume" "$code" "$out" "codex exec resume"

# Stop must not remove the session: the run stays listed as stopped with its
# data intact until an explicit delete.
list_after_stop="$("$SCRIPTS_DIR/codex-review-list.sh" 20 2>&1)"
printf '%s' "$list_after_stop" | grep -F -- "$MCP_RUN_ID" | grep -q "stopped"
check "stopped run stays listed with status stopped" $?
[[ -d "$CODEX_REVIEW_HOME/runs/$MCP_RUN_ID/conversations" ]]
check "stopped run keeps its transcripts on disk" $?

resume_out="$(codex exec resume "$CODEWORD_THREAD" --json \
    -c model_reasoning_effort=low \
    -o "$WORK/resume-recall.txt" \
    "What is the codeword? Reply with only the codeword." 2>&1 >/dev/null; cat "$WORK/resume-recall.txt" 2>/dev/null)"
assert_contains "stopped thread recovers via codex exec resume" "$resume_out" "MANGO"

# ---------------------------------------------------------------------------
note "LIVE: delete cleans up real runs"
# ---------------------------------------------------------------------------

del_out="$("$SCRIPTS_DIR/codex-delete.sh" "$MCP_RUN_ID" 2>&1)"; code=$?
if [[ "$code" -eq 0 && ! -d "$CODEX_REVIEW_HOME/runs/$MCP_RUN_ID" ]]; then
    check "delete removes the stopped MCP run" 0
else
    check "delete removes the stopped MCP run" 1 "exit=$code: $(printf '%s' "$del_out" | head -c 200)"
fi
assert_contains "delete prints the resumable thread id" "$del_out" "codex exec resume"

del_out="$("$SCRIPTS_DIR/codex-delete.sh" "$BG_RUN_ID" 2>&1)"; code=$?
if [[ "$code" -eq 0 && ! -d "$CODEX_REVIEW_HOME/runs/$BG_RUN_ID" ]]; then
    check "delete removes a completed review run" 0
else
    check "delete removes a completed review run" 1 "exit=$code: $(printf '%s' "$del_out" | head -c 200)"
fi

del_out="$("$SCRIPTS_DIR/codex-delete.sh" "$EXEC_RUN_ID" 2>&1)"; code=$?
if [[ "$code" -eq 0 && ! -d "$CODEX_REVIEW_HOME/runs/$EXEC_RUN_ID" ]]; then
    check "delete removes a stopped exec run" 0
else
    check "delete removes a stopped exec run" 1 "exit=$code: $(printf '%s' "$del_out" | head -c 200)"
fi

list_out="$("$SCRIPTS_DIR/codex-review-list.sh" 20 2>&1)"
if ! printf '%s' "$list_out" | grep -qF -- "$MCP_RUN_ID" && ! printf '%s' "$list_out" | grep -qF -- "$BG_RUN_ID"; then
    check "deleted runs no longer listed" 0
else
    check "deleted runs no longer listed" 1
fi

# ---------------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if (( FAIL > 0 )); then
    printf 'failed: %s\n' "${FAILED_NAMES[@]}"
    echo "artifacts kept at: $WORK"
    exit 1
fi
[[ "$KEEP" == "true" ]] && echo "artifacts kept at: $WORK" || rm -rf "$WORK"
exit 0
