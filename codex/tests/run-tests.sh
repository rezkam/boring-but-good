#!/usr/bin/env bash
# Test suite for the codex skill. Two tiers:
#
#   OFFLINE  argument validation, error paths, helpers, the full delete
#            lifecycle (guards, --force against a live pid, --last, --all),
#            and every exec liveness verdict (wedged/stalled/dead) against
#            fabricated metadata with real pids. No codex API calls.
#   LIVE     App Server discovery, new and resumed turns, same-connection
#            steering and interruption, native review, tracked review and exec
#            wrappers, status, reports, worker output, continuation, stop, list,
#            and deletion of real finished runs.
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
ln -s "$TESTS_DIR/fake-codex-app-server.mjs" "$FAKE_CODEX_BIN/codex"

fake_client() {
    local scenario="$1"
    shift
    PATH="$FAKE_CODEX_BIN:$PATH" \
        FAKE_CODEX_PID_FILE="$FAKE_CODEX_PID_FILE" \
        FAKE_APP_SERVER_SCENARIO="$scenario" \
        FAKE_APP_SERVER_LOG="${FAKE_APP_SERVER_LOG:-}" \
        node "$SCRIPTS_DIR/codex-app-server.mjs" "$@"
}

APP_SERVER_LOG="$WORK/app-server-client.jsonl"
APP_SERVER_EVENTS="$WORK/app-server-events.jsonl"
APP_SERVER_REPORT="$WORK/app-server-report.md"
APP_SERVER_THREAD="$WORK/app-server-thread.id"
export FAKE_APP_SERVER_LOG="$APP_SERVER_LOG"

app_server_out="$(fake_client complete turn --new --prompt "fake protocol turn" --sandbox read-only \
    --events "$APP_SERVER_EVENTS" --report "$APP_SERVER_REPORT" --thread-out "$APP_SERVER_THREAD" 2>&1)"; code=$?
if [[ "$code" -eq 0 ]]; then
    assert_contains "app-server client completes a fake bidirectional turn" "$app_server_out" "APP_SERVER_FAKE_OK"
else
    check "app-server client completes a fake bidirectional turn" 1 "exit=$code output: $(printf '%s' "$app_server_out" | head -c 200)"
fi
if [[ "$(sed -n '1p' "$APP_SERVER_LOG" | jq -r '.method')" == "initialize" ]] \
    && [[ "$(sed -n '2p' "$APP_SERVER_LOG" | jq -r '.method')" == "initialized" ]] \
    && [[ "$(sed -n '3p' "$APP_SERVER_LOG" | jq -r '.method')" == "thread/start" ]]; then
    check "app-server performs initialize handshake before thread requests" 0
else
    check "app-server performs initialize handshake before thread requests" 1 "log: $(head -c 300 "$APP_SERVER_LOG")"
fi
jq -e 'select(.method == "turn/start") | .params.input[0].type == "text" and .params.sandboxPolicy.type == "readOnly"' "$APP_SERVER_LOG" >/dev/null 2>&1
check "turn/start sends typed input and sandbox policy" $?
if [[ "$(tr -d '[:space:]' < "$APP_SERVER_THREAD")" == "00000000-0000-0000-0000-000000000001" ]]; then
    check "new turn persists durable thread id" 0
else
    check "new turn persists durable thread id" 1
fi
grep -qx "APP_SERVER_FAKE_OK" "$APP_SERVER_REPORT"
check "new turn writes final report" $?
jq -e 'select(.method == "item/completed")' "$APP_SERVER_EVENTS" >/dev/null 2>&1 \
    && jq -e 'select(.method == "turn/completed")' "$APP_SERVER_EVENTS" >/dev/null 2>&1
check "event archive includes item and terminal notifications" $?

: > "$APP_SERVER_LOG"
app_server_out="$(fake_client notification-race turn --new --prompt "race" --sandbox read-only 2>&1)"; code=$?
if [[ "$code" -eq 0 ]] && printf '%s' "$app_server_out" | grep -qF "EARLY_NOTIFICATION_OK"; then
    check "turn handles terminal notifications before start response" 0
else
    check "turn handles terminal notifications before start response" 1 "exit=$code output: $(printf '%s' "$app_server_out" | head -c 200)"
fi

: > "$APP_SERVER_LOG"
app_server_out="$(fake_client complete turn --thread "00000000-0000-0000-0000-000000000001" --prompt "resume" --sandbox read-only 2>&1)"; code=$?
if [[ "$code" -eq 0 ]] && jq -e 'select(.method == "thread/resume")' "$APP_SERVER_LOG" >/dev/null 2>&1; then
    check "turn resumes a durable thread on a fresh connection" 0
else
    check "turn resumes a durable thread on a fresh connection" 1 "exit=$code"
fi

: > "$APP_SERVER_LOG"
app_server_out="$(fake_client review review --scope base --scope-value main --workdir "$NONBLOCK_REPO" \
    --prompt "review lens" --sandbox read-only 2>&1)"; code=$?
if [[ "$code" -eq 0 ]] && printf '%s' "$app_server_out" | grep -qF "NATIVE_REVIEW_OK"; then
    check "native review returns exitedReviewMode output" 0
else
    check "native review returns exitedReviewMode output" 1 "exit=$code output: $(printf '%s' "$app_server_out" | head -c 200)"
fi
jq -e 'select(.method == "thread/start") | .params.developerInstructions == "review lens"' "$APP_SERVER_LOG" >/dev/null 2>&1 \
    && jq -e 'select(.method == "review/start") | .params.target == {"type":"baseBranch","branch":"main"}' "$APP_SERVER_LOG" >/dev/null 2>&1
check "native review combines base scope with developer instructions" $?

for scope_args in "uncommitted" "commit HEAD"; do
    : > "$APP_SERVER_LOG"
    read -r scope scope_value <<< "$scope_args"
    review_args=(review --scope "$scope" --workdir "$NONBLOCK_REPO" --sandbox read-only)
    [[ -n "${scope_value:-}" ]] && review_args+=(--scope-value "$scope_value")
    fake_client review "${review_args[@]}" >/dev/null 2>&1; code=$?
    if [[ "$scope" == "uncommitted" ]]; then
        jq -e 'select(.method == "review/start") | .params.target.type == "uncommittedChanges"' "$APP_SERVER_LOG" >/dev/null 2>&1
    else
        jq -e 'select(.method == "review/start") | .params.target.type == "commit" and .params.target.sha == "HEAD"' "$APP_SERVER_LOG" >/dev/null 2>&1
    fi
    target_code=$?
    if [[ "$code" -eq 0 && "$target_code" -eq 0 ]]; then
        check "native review maps $scope target" 0
    else
        check "native review maps $scope target" 1 "exit=$code"
    fi
done
: > "$APP_SERVER_LOG"
fake_client review review --scope custom --prompt "custom review target" --workdir "$NONBLOCK_REPO" --sandbox read-only >/dev/null 2>&1; code=$?
if [[ "$code" -eq 0 ]] && jq -e 'select(.method == "review/start") | .params.target == {"type":"custom","instructions":"custom review target"}' "$APP_SERVER_LOG" >/dev/null 2>&1; then
    check "native review maps custom target" 0
else
    check "native review maps custom target" 1 "exit=$code"
fi

: > "$APP_SERVER_LOG"
CONTROL_DIR="$WORK/active-turn-control"
CONTROL_TURN_OUT="$WORK/control-turn.out"
(fake_client control-steer turn --new --prompt "wait for steering" --sandbox read-only \
    --control-dir "$CONTROL_DIR") >"$CONTROL_TURN_OUT" 2>&1 &
CONTROL_TURN_PID=$!
for _ in $(seq 1 100); do [[ -f "$CONTROL_DIR/state.json" ]] && break; sleep 0.02; done
app_server_out="$(node "$SCRIPTS_DIR/codex-app-server.mjs" steer --control-dir "$CONTROL_DIR" \
    --thread "00000000-0000-0000-0000-000000000001" \
    --turn "00000000-0000-0000-0000-000000000002" --prompt "steer now" 2>&1)"; code=$?
if wait "$CONTROL_TURN_PID"; then control_turn_code=0; else control_turn_code=$?; fi
if [[ "$code" -eq 0 && "$control_turn_code" -eq 0 ]] \
    && jq -e 'select(.method == "turn/steer") | .params.expectedTurnId == "00000000-0000-0000-0000-000000000002" and (.params | has("turnId") | not)' "$APP_SERVER_LOG" >/dev/null 2>&1 \
    && grep -qF "STEERED_ON_ACTIVE_CONNECTION" "$CONTROL_TURN_OUT"; then
    check "steer controls the active turn on its owning connection" 0
else
    check "steer controls the active turn on its owning connection" 1 "control_exit=$code turn_exit=$control_turn_code output: $(printf '%s' "$app_server_out" | head -c 200)"
fi

: > "$APP_SERVER_LOG"
(fake_client control-interrupt turn --new --prompt "wait for interrupt" --sandbox read-only \
    --control-dir "$CONTROL_DIR") >"$CONTROL_TURN_OUT" 2>&1 &
CONTROL_TURN_PID=$!
for _ in $(seq 1 100); do [[ -f "$CONTROL_DIR/state.json" ]] && break; sleep 0.02; done
app_server_out="$(node "$SCRIPTS_DIR/codex-app-server.mjs" interrupt --control-dir "$CONTROL_DIR" \
    --thread "00000000-0000-0000-0000-000000000001" \
    --turn "00000000-0000-0000-0000-000000000002" 2>&1)"; code=$?
if wait "$CONTROL_TURN_PID"; then control_turn_code=0; else control_turn_code=$?; fi
if [[ "$code" -eq 0 && "$control_turn_code" -ne 0 ]] && jq -e 'select(.method == "turn/interrupt")' "$APP_SERVER_LOG" >/dev/null 2>&1; then
    check "interrupt controls the active turn on its owning connection" 0
else
    check "interrupt controls the active turn on its owning connection" 1 "control_exit=$code turn_exit=$control_turn_code"
fi

: > "$APP_SERVER_LOG"
app_server_out="$(fake_client complete request --method model/list 2>&1)"; code=$?
if [[ "$code" -eq 0 ]] && printf '%s' "$app_server_out" | jq -e '.result.data[0].id == "fake-model"' >/dev/null 2>&1; then
    check "generic request returns protocol result" 0
else
    check "generic request returns protocol result" 1 "exit=$code output: $(printf '%s' "$app_server_out" | head -c 200)"
fi
: > "$APP_SERVER_LOG"
fake_client complete request --method account/logout --no-params >/dev/null 2>&1; code=$?
if [[ "$code" -eq 0 ]] && jq -e 'select(.method == "account/logout") | has("params") | not' "$APP_SERVER_LOG" >/dev/null 2>&1; then
    check "generic request can omit params" 0
else
    check "generic request can omit params" 1 "exit=$code"
fi

: > "$APP_SERVER_LOG"
app_server_out="$(fake_client approvals turn --new --prompt "approvals" --sandbox read-only --approval decline 2>&1)"; code=$?
if [[ "$code" -eq 0 ]] \
    && jq -e 'select(.id == 901) | .result == {"decision":"decline"}' "$APP_SERVER_LOG" >/dev/null 2>&1 \
    && jq -e 'select(.id == 902) | .result == {"decision":"decline"}' "$APP_SERVER_LOG" >/dev/null 2>&1 \
    && jq -e 'select(.id == 903) | .result == {"permissions":{},"scope":"turn"}' "$APP_SERVER_LOG" >/dev/null 2>&1 \
    && jq -e 'select(.id == 904) | .result == {"answers":{}}' "$APP_SERVER_LOG" >/dev/null 2>&1 \
    && jq -e 'select(.id == 905) | .result == {"action":"cancel","content":null,"_meta":null}' "$APP_SERVER_LOG" >/dev/null 2>&1 \
    && jq -e 'select(.id == 906) | .result.success == false' "$APP_SERVER_LOG" >/dev/null 2>&1; then
    check "server-initiated requests receive schema-valid safe responses" 0
else
    check "server-initiated requests receive schema-valid safe responses" 1 "exit=$code log: $(tail -c 500 "$APP_SERVER_LOG")"
fi
for approval_mode in accept accept-for-session; do
    : > "$APP_SERVER_LOG"
    fake_client approvals turn --new --prompt "approvals" --sandbox read-only --approval "$approval_mode" >/dev/null 2>&1; code=$?
    expected_decision="accept"
    [[ "$approval_mode" == "accept-for-session" ]] && expected_decision="acceptForSession"
    if [[ "$code" -eq 0 ]] && jq -e --arg decision "$expected_decision" 'select(.id == 901 or .id == 902) | .result.decision == $decision' "$APP_SERVER_LOG" >/dev/null 2>&1; then
        check "approval mode $approval_mode maps to protocol decision" 0
    else
        check "approval mode $approval_mode maps to protocol decision" 1 "exit=$code"
    fi
done

: > "$APP_SERVER_LOG"
app_server_out="$(fake_client close-recovered turn --new --prompt "close" --sandbox read-only 2>&1)"; code=$?
if [[ "$code" -eq 0 ]] && printf '%s' "$app_server_out" | grep -qF "RECOVERED_AFTER_CLOSE"; then
    check "client recovers a completed assistant item after transport close" 0
else
    check "client recovers a completed assistant item after transport close" 1 "exit=$code output: $(printf '%s' "$app_server_out" | head -c 200)"
fi
app_server_out="$(fake_client close-unresolved turn --new --prompt "close unsafe" --sandbox read-only 2>&1)"; code=$?
if [[ "$code" -ne 0 ]] && ! printf '%s' "$app_server_out" | grep -q '"status":"completed"'; then
    check "client rejects close recovery with unresolved side effects" 0
else
    check "client rejects close recovery with unresolved side effects" 1 "exit=$code output: $(printf '%s' "$app_server_out" | head -c 200)"
fi
app_server_out="$(fake_client close-commentary turn --new --prompt "close commentary" --sandbox read-only 2>&1)"; code=$?
if [[ "$code" -ne 0 ]] && ! printf '%s' "$app_server_out" | grep -q '"status":"completed"'; then
    check "client does not recover commentary as a final answer" 0
else
    check "client does not recover commentary as a final answer" 1 "exit=$code output: $(printf '%s' "$app_server_out" | head -c 200)"
fi
app_server_out="$(fake_client malformed-json turn --new --prompt "malformed" --sandbox read-only 2>&1)"; code=$?
assert_exit_nonzero "malformed server JSON closes the client instead of hanging" "$code" "$app_server_out" "invalid JSON from codex app-server"

: > "$APP_SERVER_LOG"
app_server_out="$(fake_client timeout turn --new --prompt "timeout" --sandbox read-only --timeout 0.01 2>&1)"; code=$?
if [[ "$code" -ne 0 ]] && printf '%s' "$app_server_out" | grep -qF "was not replayed" \
    && [[ "$(jq -r 'select(.method == "turn/start") | .method' "$APP_SERVER_LOG" | wc -l | tr -d ' ')" == "1" ]] \
    && jq -e 'select(.method == "turn/interrupt")' "$APP_SERVER_LOG" >/dev/null 2>&1; then
    check "timeout interrupts once and never replays the turn" 0
else
    check "timeout interrupts once and never replays the turn" 1 "exit=$code output: $(printf '%s' "$app_server_out" | head -c 200)"
fi

app_server_out="$(fake_client rpc-error turn --new --prompt "rpc" --sandbox read-only 2>&1)"; code=$?
assert_exit_nonzero "RPC errors name the failing method" "$code" "$app_server_out" "turn/start failed: bad turn params"
app_server_out="$(fake_client complete turn --new --thread thread-1 --prompt "ambiguous" 2>&1)"; code=$?
assert_exit_nonzero "turn rejects conflicting thread selectors" "$code" "$app_server_out" "either --new or --thread"
app_server_out="$(fake_client complete turn --new --prompt "approval" --approval unsafe 2>&1)"; code=$?
assert_exit_nonzero "client rejects unknown approval modes" "$code" "$app_server_out" "--approval must be"
app_server_out="$(fake_client complete turn --new --prompt "sandbox" --sandbox misspelled 2>&1)"; code=$?
assert_exit_nonzero "client rejects unknown sandbox instead of falling through" "$code" "$app_server_out" "--sandbox must be"
app_server_out="$(fake_client complete turn --new --prompt "effort" --effort enormous 2>&1)"; code=$?
assert_exit_nonzero "client rejects unknown reasoning effort" "$code" "$app_server_out" "--effort must be"
app_server_out="$(fake_client complete turn --new --prompt "one" --prompt-file "$WORK/missing" 2>&1)"; code=$?
assert_exit_nonzero "client rejects conflicting prompt sources" "$code" "$app_server_out" "either --prompt or --prompt-file"
printf '%s\n' '[]' > "$WORK/invalid-params.json"
app_server_out="$(fake_client complete request --method model/list --params-file "$WORK/invalid-params.json" 2>&1)"; code=$?
assert_exit_nonzero "generic request rejects non-object params" "$code" "$app_server_out" "must contain one JSON object"

# A managed session must keep one initialized App Server connection across
# completed turns and later requests. The local command clients never own or
# replace that transport.
MANAGED_DIR="$WORK/managed-session"
: > "$APP_SERVER_LOG"
PATH="$FAKE_CODEX_BIN:$PATH" FAKE_APP_SERVER_SCENARIO=complete \
    node "$SCRIPTS_DIR/codex-app-server.mjs" start --session-dir "$MANAGED_DIR" \
    --events "$MANAGED_DIR/events.jsonl" --approval decline >/dev/null 2>&1; code=$?
managed_turn="$(node "$SCRIPTS_DIR/codex-app-server.mjs" turn --session-dir "$MANAGED_DIR" \
    --new --prompt "managed turn" --sandbox read-only 2>&1)"; turn_code=$?
managed_thread="$(printf '%s' "$managed_turn" | jq -r '.threadId')"
managed_followup="$(node "$SCRIPTS_DIR/codex-app-server.mjs" turn --session-dir "$MANAGED_DIR" \
    --thread "$managed_thread" --prompt "managed follow-up" --sandbox read-only 2>&1)"; followup_code=$?
managed_models="$(node "$SCRIPTS_DIR/codex-app-server.mjs" request --session-dir "$MANAGED_DIR" \
    --method model/list 2>&1)"; request_code=$?
managed_status="$(node "$SCRIPTS_DIR/codex-app-server.mjs" status --session-dir "$MANAGED_DIR" 2>&1)"; status_code=$?
if [[ "$code" -eq 0 && "$turn_code" -eq 0 && "$followup_code" -eq 0 && "$request_code" -eq 0 && "$status_code" -eq 0 ]] \
    && [[ "$(jq -r 'select(.method == "initialize") | .method' "$APP_SERVER_LOG" | wc -l | tr -d ' ')" == "1" ]] \
    && [[ "$(jq -r 'select(.method == "turn/start") | .method' "$APP_SERVER_LOG" | wc -l | tr -d ' ')" == "2" ]] \
    && [[ "$(jq -r 'select(.method == "thread/resume") | .method' "$APP_SERVER_LOG" | wc -l | tr -d ' ')" == "0" ]] \
    && printf '%s' "$managed_status" | jq -e '.status == "ready" and .processAlive == true and (.threads | length) == 1' >/dev/null 2>&1 \
    && printf '%s' "$managed_models" | jq -e '.data[0].id == "fake-model"' >/dev/null 2>&1; then
    check "managed session reuses one initialized connection across operations" 0
else
    check "managed session reuses one initialized connection across operations" 1 "turn=$managed_turn followup=$managed_followup status=$managed_status"
fi
jq -s -e '([.[]._session.sequence] == ([.[]._session.sequence] | sort)) and (.[0]._session.sequence == 1)' "$MANAGED_DIR/events.jsonl" >/dev/null 2>&1
check "managed session gives archived events a stable sequence" $?
node "$SCRIPTS_DIR/codex-app-server.mjs" shutdown --session-dir "$MANAGED_DIR" >/dev/null 2>&1
for _ in $(seq 1 100); do [[ "$(jq -r '.status' "$MANAGED_DIR/state.json")" == "closed" ]] && break; sleep 0.02; done
if [[ "$(jq -r '.status' "$MANAGED_DIR/state.json")" == "closed" ]]; then
    check "managed session shuts down cleanly after its leases finish" 0
else
    check "managed session shuts down cleanly after its leases finish" 1
fi

# Steering and interruption enter through separate local clients, but the
# host sends both RPCs over the connection that owns the active turn.
MANAGED_STEER_DIR="$WORK/managed-steer"
: > "$APP_SERVER_LOG"
PATH="$FAKE_CODEX_BIN:$PATH" FAKE_APP_SERVER_SCENARIO=control-steer \
    node "$SCRIPTS_DIR/codex-app-server.mjs" start --session-dir "$MANAGED_STEER_DIR" --approval decline >/dev/null 2>&1
node "$SCRIPTS_DIR/codex-app-server.mjs" turn --session-dir "$MANAGED_STEER_DIR" \
    --new --prompt "wait" --sandbox read-only >"$WORK/managed-steer-turn.json" 2>&1 &
MANAGED_TURN_PID=$!
for _ in $(seq 1 100); do jq -e '.activeTurns | length == 1' "$MANAGED_STEER_DIR/state.json" >/dev/null 2>&1 && break; sleep 0.02; done
managed_steer="$(node "$SCRIPTS_DIR/codex-app-server.mjs" steer --session-dir "$MANAGED_STEER_DIR" --prompt "redirect" 2>&1)"; code=$?
if wait "$MANAGED_TURN_PID"; then managed_turn_code=0; else managed_turn_code=$?; fi
if [[ "$code" -eq 0 && "$managed_turn_code" -eq 0 ]] \
    && jq -e 'select(.method == "turn/steer") | .params.expectedTurnId == "00000000-0000-0000-0000-000000000002"' "$APP_SERVER_LOG" >/dev/null 2>&1 \
    && grep -qF "STEERED_ON_ACTIVE_CONNECTION" "$WORK/managed-steer-turn.json"; then
    check "managed session routes steering to the owning connection" 0
else
    check "managed session routes steering to the owning connection" 1 "exit=$code turn=$managed_turn_code output=$managed_steer"
fi
node "$SCRIPTS_DIR/codex-app-server.mjs" shutdown --session-dir "$MANAGED_STEER_DIR" >/dev/null 2>&1

MANAGED_INTERRUPT_DIR="$WORK/managed-interrupt"
: > "$APP_SERVER_LOG"
PATH="$FAKE_CODEX_BIN:$PATH" FAKE_APP_SERVER_SCENARIO=control-interrupt \
    node "$SCRIPTS_DIR/codex-app-server.mjs" start --session-dir "$MANAGED_INTERRUPT_DIR" --approval decline >/dev/null 2>&1
node "$SCRIPTS_DIR/codex-app-server.mjs" turn --session-dir "$MANAGED_INTERRUPT_DIR" \
    --new --prompt "wait" --sandbox read-only >"$WORK/managed-interrupt-turn.json" 2>&1 &
MANAGED_TURN_PID=$!
for _ in $(seq 1 100); do jq -e '.activeTurns | length == 1' "$MANAGED_INTERRUPT_DIR/state.json" >/dev/null 2>&1 && break; sleep 0.02; done
shutdown_active="$(node "$SCRIPTS_DIR/codex-app-server.mjs" shutdown --session-dir "$MANAGED_INTERRUPT_DIR" 2>&1)"; shutdown_code=$?
managed_interrupt="$(node "$SCRIPTS_DIR/codex-app-server.mjs" interrupt --session-dir "$MANAGED_INTERRUPT_DIR" 2>&1)"; interrupt_code=$?
if wait "$MANAGED_TURN_PID"; then managed_turn_code=0; else managed_turn_code=$?; fi
if [[ "$shutdown_code" -ne 0 && "$interrupt_code" -eq 0 && "$managed_turn_code" -ne 0 ]] \
    && printf '%s' "$shutdown_active" | grep -qF "active turn" \
    && jq -e 'select(.method == "turn/interrupt")' "$APP_SERVER_LOG" >/dev/null 2>&1; then
    check "managed session refuses unsafe shutdown and interrupts without replay" 0
else
    check "managed session refuses unsafe shutdown and interrupts without replay" 1 "shutdown=$shutdown_code interrupt=$interrupt_code turn=$managed_turn_code"
fi
node "$SCRIPTS_DIR/codex-app-server.mjs" shutdown --session-dir "$MANAGED_INTERRUPT_DIR" >/dev/null 2>&1

# Interactive hosts expose every server request until another process answers
# it. This proves two-way communication beyond turn steering.
MANAGED_APPROVAL_DIR="$WORK/managed-approvals"
: > "$APP_SERVER_LOG"
PATH="$FAKE_CODEX_BIN:$PATH" FAKE_APP_SERVER_SCENARIO=approvals \
    node "$SCRIPTS_DIR/codex-app-server.mjs" start --session-dir "$MANAGED_APPROVAL_DIR" --approval interactive >/dev/null 2>&1
node "$SCRIPTS_DIR/codex-app-server.mjs" turn --session-dir "$MANAGED_APPROVAL_DIR" \
    --new --prompt "approvals" --sandbox read-only >"$WORK/managed-approval-turn.json" 2>&1 &
MANAGED_TURN_PID=$!
for _ in $(seq 1 100); do jq -e '.pendingRequests | length == 6' "$MANAGED_APPROVAL_DIR/state.json" >/dev/null 2>&1 && break; sleep 0.02; done
managed_pending="$(node "$SCRIPTS_DIR/codex-app-server.mjs" pending --session-dir "$MANAGED_APPROVAL_DIR" 2>&1)"; pending_code=$?
jq -n '{decision:"decline"}' > "$WORK/managed-decision.json"
jq -n '{permissions:{},scope:"turn"}' > "$WORK/managed-permissions.json"
jq -n '{answers:{}}' > "$WORK/managed-answers.json"
jq -n '{action:"cancel",content:null,_meta:null}' > "$WORK/managed-cancel.json"
jq -n '{success:false,contentItems:[]}' > "$WORK/managed-tool.json"
for request_spec in \
    "901:$WORK/managed-decision.json" "902:$WORK/managed-decision.json" \
    "903:$WORK/managed-permissions.json" "904:$WORK/managed-answers.json" \
    "905:$WORK/managed-cancel.json" "906:$WORK/managed-tool.json"; do
    request_id="${request_spec%%:*}"
    response_file="${request_spec#*:}"
    node "$SCRIPTS_DIR/codex-app-server.mjs" respond --session-dir "$MANAGED_APPROVAL_DIR" \
        --request "$request_id" --result-file "$response_file" >/dev/null 2>&1
done
if wait "$MANAGED_TURN_PID"; then managed_turn_code=0; else managed_turn_code=$?; fi
if [[ "$pending_code" -eq 0 && "$managed_turn_code" -eq 0 ]] \
    && printf '%s' "$managed_pending" | jq -e '(length == 6) and ((map(.method) | index("item/tool/requestUserInput")) != null)' >/dev/null 2>&1 \
    && grep -qF "APPROVALS_HANDLED" "$WORK/managed-approval-turn.json" \
    && jq -e 'select(.id == 901) | .result.decision == "decline"' "$APP_SERVER_LOG" >/dev/null 2>&1; then
    check "managed session exposes and resolves bidirectional server requests" 0
else
    check "managed session exposes and resolves bidirectional server requests" 1 "pending=$managed_pending turn=$managed_turn_code"
fi
node "$SCRIPTS_DIR/codex-app-server.mjs" shutdown --session-dir "$MANAGED_APPROVAL_DIR" >/dev/null 2>&1

MANAGED_AUTO_DIR="$WORK/managed-auto-resolution"
: > "$APP_SERVER_LOG"
PATH="$FAKE_CODEX_BIN:$PATH" FAKE_APP_SERVER_SCENARIO=auto-resolve \
    node "$SCRIPTS_DIR/codex-app-server.mjs" start --session-dir "$MANAGED_AUTO_DIR" --approval interactive >/dev/null 2>&1
managed_auto="$(node "$SCRIPTS_DIR/codex-app-server.mjs" turn --session-dir "$MANAGED_AUTO_DIR" \
    --new --prompt "auto" --sandbox read-only 2>&1)"; auto_code=$?
if [[ "$auto_code" -eq 0 ]] && printf '%s' "$managed_auto" | grep -qF "AUTO_RESOLVED_INPUT" \
    && jq -e 'select(.id == 904) | .result == {"answers":{}}' "$APP_SERVER_LOG" >/dev/null 2>&1; then
    check "managed session honors user-input auto-resolution deadlines" 0
else
    check "managed session honors user-input auto-resolution deadlines" 1 "exit=$auto_code output=$managed_auto"
fi
node "$SCRIPTS_DIR/codex-app-server.mjs" shutdown --session-dir "$MANAGED_AUTO_DIR" >/dev/null 2>&1

MANAGED_CLEARED_DIR="$WORK/managed-cleared-request"
: > "$APP_SERVER_LOG"
PATH="$FAKE_CODEX_BIN:$PATH" FAKE_APP_SERVER_SCENARIO=request-cleared \
    node "$SCRIPTS_DIR/codex-app-server.mjs" start --session-dir "$MANAGED_CLEARED_DIR" --approval interactive >/dev/null 2>&1
managed_cleared="$(node "$SCRIPTS_DIR/codex-app-server.mjs" turn --session-dir "$MANAGED_CLEARED_DIR" \
    --new --prompt "cleared" --sandbox read-only 2>&1)"; cleared_code=$?
for _ in $(seq 1 100); do jq -e '.pendingRequests == []' "$MANAGED_CLEARED_DIR/state.json" >/dev/null 2>&1 && break; sleep 0.02; done
cleared_status="$(node "$SCRIPTS_DIR/codex-app-server.mjs" status --session-dir "$MANAGED_CLEARED_DIR" 2>&1)"
if [[ "$cleared_code" -eq 0 ]] && printf '%s' "$managed_cleared" | grep -qF "REQUEST_CLEARED" \
    && printf '%s' "$cleared_status" | jq -e '.pendingRequests == []' >/dev/null 2>&1 \
    && ! jq -e 'select(.id == 904 and has("method") == false)' "$APP_SERVER_LOG" >/dev/null 2>&1; then
    check "managed session removes server-cleared requests without a late response" 0
else
    check "managed session removes server-cleared requests without a late response" 1 "exit=$cleared_code status=$cleared_status"
fi
node "$SCRIPTS_DIR/codex-app-server.mjs" shutdown --session-dir "$MANAGED_CLEARED_DIR" >/dev/null 2>&1

MANAGED_CLOSE_DIR="$WORK/managed-close"
: > "$APP_SERVER_LOG"
PATH="$FAKE_CODEX_BIN:$PATH" FAKE_APP_SERVER_SCENARIO=close-commentary \
    node "$SCRIPTS_DIR/codex-app-server.mjs" start --session-dir "$MANAGED_CLOSE_DIR" --approval decline >/dev/null 2>&1
managed_close="$(node "$SCRIPTS_DIR/codex-app-server.mjs" turn --session-dir "$MANAGED_CLOSE_DIR" \
    --new --prompt "close" --sandbox read-only 2>&1)"; close_code=$?
for _ in $(seq 1 100); do [[ "$(jq -r '.status' "$MANAGED_CLOSE_DIR/state.json")" == "closed" ]] && break; sleep 0.02; done
managed_restart="$(PATH="$FAKE_CODEX_BIN:$PATH" FAKE_APP_SERVER_SCENARIO=complete \
    node "$SCRIPTS_DIR/codex-app-server.mjs" start --session-dir "$MANAGED_CLOSE_DIR" --approval decline 2>&1)"; restart_code=$?
if [[ "$close_code" -ne 0 && "$restart_code" -ne 0 ]] \
    && [[ "$(jq -r '.status' "$MANAGED_CLOSE_DIR/state.json")" == "closed" ]] \
    && [[ "$(jq -r 'select(.method == "turn/start") | .method' "$APP_SERVER_LOG" | wc -l | tr -d ' ')" == "1" ]] \
    && printf '%s' "$managed_close" | grep -qF "exited" \
    && printf '%s' "$managed_restart" | grep -qF "stale commands cannot be replayed"; then
    check "managed transport close rejects waiters and stale sessions never replay" 0
else
    check "managed transport close rejects waiters and stale sessions never replay" 1 "close=$close_code restart=$restart_code output=$managed_close"
fi

: > "$APP_SERVER_LOG"
review_wrapper_out="$(PATH="$FAKE_CODEX_BIN:$PATH" FAKE_CODEX_PID_FILE="$FAKE_CODEX_PID_FILE" \
    FAKE_APP_SERVER_SCENARIO=review FAKE_APP_SERVER_LOG="$APP_SERVER_LOG" \
    "$SCRIPTS_DIR/codex-review-start.sh" --wait --base main --prompt "wrapper lens" \
    --workdir "$NONBLOCK_REPO" 2>&1)"; code=$?
if [[ "$code" -eq 0 ]] && printf '%s' "$review_wrapper_out" | grep -qF "NATIVE_REVIEW_OK" \
    && jq -e 'select(.method == "review/start") | .params.target.branch == "main"' "$APP_SERVER_LOG" >/dev/null 2>&1; then
    check "tracked review wrapper uses native App Server review" 0
else
    check "tracked review wrapper uses native App Server review" 1 "exit=$code output: $(printf '%s' "$review_wrapper_out" | head -c 200)"
fi
FAKE_REVIEW_RUN_ID="$("$SCRIPTS_DIR/codex-review-list.sh" 2 | awk -F'\t' 'NR>1 && $2=="review" {print $1; exit}')"
if [[ -n "$FAKE_REVIEW_RUN_ID" ]] \
    && [[ "$(jq -r '.runner' "$CODEX_REVIEW_HOME/runs/$FAKE_REVIEW_RUN_ID/meta.json")" == "codex-app-server-review" ]] \
    && [[ "$(jq -r '.session_dir' "$CODEX_REVIEW_HOME/runs/$FAKE_REVIEW_RUN_ID/meta.json")" == "$CODEX_REVIEW_HOME/runs/$FAKE_REVIEW_RUN_ID/app-server-session" ]]; then
    check "tracked review records persistent App Server session" 0
else
    check "tracked review records persistent App Server session" 1
fi
[[ -n "$FAKE_REVIEW_RUN_ID" ]] && "$SCRIPTS_DIR/codex-delete.sh" "$FAKE_REVIEW_RUN_ID" >/dev/null 2>&1

nonblock_out="$(
    PATH="$FAKE_CODEX_BIN:$PATH" FAKE_CODEX_PID_FILE="$FAKE_CODEX_PID_FILE" FAKE_APP_SERVER_SCENARIO=hold timeout 10 bash -c '
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
    NONBLOCK_CONTROL_DIR="$(jq -r '.session_dir // ""' "$CODEX_REVIEW_HOME/runs/$NONBLOCK_RUN_ID/meta.json")"
    if [[ "$NONBLOCK_CONTROL_DIR" == "$CODEX_REVIEW_HOME/runs/$NONBLOCK_RUN_ID/app-server-session" && -f "$NONBLOCK_CONTROL_DIR/state.json" ]]; then
        check "tracked exec exposes its persistent App Server session" 0
    else
        check "tracked exec exposes its persistent App Server session" 1 "dir=$NONBLOCK_CONTROL_DIR"
    fi
    active_converse_out="$("$SCRIPTS_DIR/codex-review-converse.sh" "$NONBLOCK_RUN_ID" "focus on the active test" 2>&1)"; code=$?
    if [[ "$code" -eq 0 ]] && jq -e 'select(.method == "turn/steer") | .params.input[0].text == "focus on the active test"' "$APP_SERVER_LOG" >/dev/null 2>&1; then
        check "converse steers a running turn on its owning connection" 0
    else
        check "converse steers a running turn on its owning connection" 1 "exit=$code output: $(printf '%s' "$active_converse_out" | head -c 200)"
    fi
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

# Resume must inherit the run's recorded effort and apply it to a new turn on
# the existing App Server host, not to a newly spawned CLI process.
EFFORT_STUB_BIN="$WORK/effort-stub-bin"
EFFORT_RPC_LOG="$WORK/effort-rpc.jsonl"
EFFORT_SESSION="$WORK/effort-session"
mkdir -p "$EFFORT_STUB_BIN"
ln -s "$TESTS_DIR/fake-codex-app-server.mjs" "$EFFORT_STUB_BIN/codex"
PATH="$EFFORT_STUB_BIN:$PATH" FAKE_APP_SERVER_SCENARIO=complete FAKE_APP_SERVER_LOG="$EFFORT_RPC_LOG" \
    node "$SCRIPTS_DIR/codex-app-server.mjs" start --session-dir "$EFFORT_SESSION" --approval decline >/dev/null 2>&1
effort_set() { ( source "$SCRIPTS_DIR/_helpers.sh"; codex_review_set_meta_field "$@" ); }

fabricate_exec_run "fake-exec-effort" "" "00000000-0000-0000-0000-000000000042"
effort_set fake-exec-effort status "completed"
effort_set fake-exec-effort effort "medium"
effort_set fake-exec-effort session_dir "$EFFORT_SESSION"
: > "$EFFORT_RPC_LOG"
"$SCRIPTS_DIR/codex-review-converse.sh" fake-exec-effort "hi" >/dev/null 2>&1 || true
if jq -e 'select(.method == "turn/start") | .params.effort == "medium"' "$EFFORT_RPC_LOG" >/dev/null 2>&1; then
    check "converse resume inherits the run's recorded effort" 0
else
    check "converse resume inherits the run's recorded effort" 1 "rpc: $(tail -c 300 "$EFFORT_RPC_LOG" 2>/dev/null)"
fi

: > "$EFFORT_RPC_LOG"
"$SCRIPTS_DIR/codex-review-converse.sh" fake-exec-effort --effort high "hi" >/dev/null 2>&1 || true
if jq -e 'select(.method == "turn/start") | .params.effort == "high"' "$EFFORT_RPC_LOG" >/dev/null 2>&1; then
    check "converse --effort overrides the recorded effort" 0
else
    check "converse --effort overrides the recorded effort" 1 "rpc: $(tail -c 300 "$EFFORT_RPC_LOG" 2>/dev/null)"
fi

fabricate_exec_run "fake-exec-effort-none" "" "00000000-0000-0000-0000-000000000043"
effort_set fake-exec-effort-none status "completed"
effort_set fake-exec-effort-none session_dir "$EFFORT_SESSION"
: > "$EFFORT_RPC_LOG"
"$SCRIPTS_DIR/codex-review-converse.sh" fake-exec-effort-none "hi" >/dev/null 2>&1 || true
if jq -e 'select(.method == "turn/start") | .params | has("effort")' "$EFFORT_RPC_LOG" >/dev/null 2>&1; then
    check "converse forces no effort when the run recorded none" 1 "rpc: $(tail -c 300 "$EFFORT_RPC_LOG" 2>/dev/null)"
else
    check "converse forces no effort when the run recorded none" 0
fi

node "$SCRIPTS_DIR/codex-app-server.mjs" shutdown --session-dir "$EFFORT_SESSION" >/dev/null 2>&1 || true
rm -rf "$EFFORT_STUB_BIN" "$CODEX_REVIEW_HOME/runs/fake-exec-effort" "$CODEX_REVIEW_HOME/runs/fake-exec-effort-none"

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
note "LIVE: native App Server review lifecycle (preset + config)"
# ---------------------------------------------------------------------------
make_fixture_repo

out="$("$SCRIPTS_DIR/codex-review-start.sh" --wait --uncommitted \
    --workdir "$FIXTURE_REPO" --preset adversarial \
    --config model_reasoning_effort=low \
    --title "test exec review" 2>&1)"; code=$?
check "native review --wait exits 0" "$code" "$(printf '%s' "$out" | tail -c 200)"
if [[ -n "$out" && "$code" -eq 0 ]]; then check "review --wait produced a report" 0; else check "review --wait produced a report" 1; fi

WAIT_RUN_ID="$("$SCRIPTS_DIR/codex-review-list.sh" 2 | awk -F'\t' 'NR>1 && $2=="review" {print $1; exit}')"
[[ -n "$WAIT_RUN_ID" ]]; check "review run appears in list" $?

status_out="$("$SCRIPTS_DIR/codex-review-status.sh" "$WAIT_RUN_ID" 2>&1)"
assert_contains "review status shows completed" "$status_out" "completed"

report_out="$("$SCRIPTS_DIR/codex-review-report.sh" "$WAIT_RUN_ID" 2>&1)"; code=$?
if [[ "$code" -eq 0 && -n "$report_out" ]]; then check "review report prints" 0; else check "review report prints" 1 "exit=$code"; fi

# Protocol proof: native review mode must enter and exit on the event stream.
# The following P0 assertion is the behavioral proof that the preset rubric
# affected the reviewer, without depending on private rollout file layout.
WAIT_LOG="$(jq -r '.log_file' "$CODEX_REVIEW_HOME/runs/$WAIT_RUN_ID/meta.json")"
if jq -e 'select(.method == "item/started" and .params.item.type == "enteredReviewMode")' "$WAIT_LOG" >/dev/null 2>&1 \
    && jq -e 'select(.method == "item/completed" and .params.item.type == "exitedReviewMode")' "$WAIT_LOG" >/dev/null 2>&1; then
    check "native review streams entered and exited review mode" 0
else
    check "native review streams entered and exited review mode" 1
fi

# Behavioral check on the rubric: the planted crash on a documented valid
# input must be labeled P0.
assert_contains "planted crash labeled P0 per the rubric" "$report_out" "P0"

conv_out="$("$SCRIPTS_DIR/codex-review-converse.sh" "$WAIT_RUN_ID" \
    --config model_reasoning_effort=low \
    "Reply with exactly the word ACK and nothing else." 2>&1)"; code=$?
assert_contains "converse continues the review thread" "$conv_out" "ACK"

# ---------------------------------------------------------------------------
note "LIVE: native App Server review lifecycle (background + commit target)"
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
    check "review --wait --commit produces output" 0
else
    check "review --wait --commit produces output" 1 "exit=$code: $(printf '%s' "$commit_out" | head -c 200)"
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
if [[ "$code" -eq 0 ]] && printf '%s' "$out" | grep -q "Stopped exec worker and App Server session"; then
    check "exec-stop closes the persistent host after a finished turn" 0
else
    check "exec-stop closes the persistent host after a finished turn" 1 "exit=$code: $(printf '%s' "$out" | head -c 200)"
fi

# ---------------------------------------------------------------------------
note "LIVE: direct App Server lifecycle and active-turn control"
# ---------------------------------------------------------------------------

LIVE_APP_DIR="$WORK/live-app-server"
mkdir -p "$LIVE_APP_DIR"
LIVE_SESSION_DIR="$LIVE_APP_DIR/session"
LIVE_SESSION_EVENTS="$LIVE_APP_DIR/session-events.jsonl"

node "$SCRIPTS_DIR/codex-app-server.mjs" start --session-dir "$LIVE_SESSION_DIR" \
    --events "$LIVE_SESSION_EVENTS" --approval decline >/dev/null 2>&1; code=$?
check "live persistent App Server host starts" "$code"

model_out="$(node "$SCRIPTS_DIR/codex-app-server.mjs" request --session-dir "$LIVE_SESSION_DIR" --method model/list 2>&1)"; code=$?
if [[ "$code" -eq 0 ]] && printf '%s' "$model_out" | jq -e '.data | length > 0' >/dev/null 2>&1; then
    check "live app-server model/list handshake succeeds" 0
else
    check "live app-server model/list handshake succeeds" 1 "exit=$code: $(printf '%s' "$model_out" | head -c 200)"
fi

CODEWORD_THREAD_FILE="$LIVE_APP_DIR/codeword-thread.id"
t1="$(node "$SCRIPTS_DIR/codex-app-server.mjs" turn --new \
    --session-dir "$LIVE_SESSION_DIR" \
    --prompt "The codeword is MANGO. Reply with exactly STORED." \
    --workdir "$LIVE_APP_DIR" --sandbox read-only --effort low \
    --thread-out "$CODEWORD_THREAD_FILE" 2>&1)"; code=$?
assert_contains "live app-server new turn answers" "$t1" "STORED"
CODEWORD_THREAD="$(tr -d '[:space:]' < "$CODEWORD_THREAD_FILE")"
[[ -n "$CODEWORD_THREAD" ]]; check "live app-server persists thread id" $?

t2="$(node "$SCRIPTS_DIR/codex-app-server.mjs" turn --thread "$CODEWORD_THREAD" \
    --session-dir "$LIVE_SESSION_DIR" \
    --prompt "What is the codeword? Reply with only the codeword." \
    --workdir "$LIVE_APP_DIR" --sandbox read-only --effort low 2>&1)"; code=$?
assert_contains "live app-server resume proves context continuity" "$t2" "MANGO"

node "$SCRIPTS_DIR/codex-app-server.mjs" turn --session-dir "$LIVE_SESSION_DIR" --new \
    --prompt "Write a numbered list from 1 to 200 about software testing, one sentence per item. Do not use tools." \
    --workdir "$LIVE_APP_DIR" --sandbox read-only --effort low \
    >"$LIVE_APP_DIR/steer-turn.json" 2>"$LIVE_APP_DIR/steer-turn.err" &
LIVE_CONTROL_PID=$!
for _ in $(seq 1 300); do jq -e '.activeTurns | length == 1' "$LIVE_SESSION_DIR/state.json" >/dev/null 2>&1 && break; sleep 0.1; done
steer_out="$(node "$SCRIPTS_DIR/codex-app-server.mjs" steer --session-dir "$LIVE_SESSION_DIR" \
    --prompt "Stop the list and reply with exactly STEER_LIVE_OK." 2>&1)"; steer_code=$?
if wait "$LIVE_CONTROL_PID"; then live_turn_code=0; else live_turn_code=$?; fi
if [[ "$steer_code" -eq 0 && "$live_turn_code" -eq 0 ]] && grep -qF "STEER_LIVE_OK" "$LIVE_APP_DIR/steer-turn.json"; then
    check "live same-connection steering succeeds" 0
else
    check "live same-connection steering succeeds" 1 "steer_exit=$steer_code turn_exit=$live_turn_code control: $(printf '%s' "$steer_out" | head -c 120) turn: $(head -c 120 "$LIVE_APP_DIR/steer-turn.err")"
fi

node "$SCRIPTS_DIR/codex-app-server.mjs" turn --session-dir "$LIVE_SESSION_DIR" --new \
    --prompt "Write a numbered list from 1 to 200 about software testing, one sentence per item. Do not use tools." \
    --workdir "$LIVE_APP_DIR" --sandbox read-only --effort low \
    >"$LIVE_APP_DIR/interrupt-turn.json" 2>"$LIVE_APP_DIR/interrupt-turn.err" &
LIVE_CONTROL_PID=$!
for _ in $(seq 1 300); do jq -e '.activeTurns | length == 1' "$LIVE_SESSION_DIR/state.json" >/dev/null 2>&1 && break; sleep 0.1; done
interrupt_out="$(node "$SCRIPTS_DIR/codex-app-server.mjs" interrupt --session-dir "$LIVE_SESSION_DIR" 2>&1)"; interrupt_code=$?
if wait "$LIVE_CONTROL_PID"; then live_turn_code=0; else live_turn_code=$?; fi
if [[ "$interrupt_code" -eq 0 && "$live_turn_code" -ne 0 ]] \
    && jq -e 'select(.method == "turn/completed") | .params.turn.status == "interrupted"' "$LIVE_SESSION_EVENTS" >/dev/null 2>&1; then
    check "live same-connection interruption reaches terminal state" 0
else
    check "live same-connection interruption reaches terminal state" 1 "interrupt_exit=$interrupt_code turn_exit=$live_turn_code output: $(printf '%s' "$interrupt_out" | head -c 200)"
fi

live_session_status="$(node "$SCRIPTS_DIR/codex-app-server.mjs" status --session-dir "$LIVE_SESSION_DIR" 2>&1)"; code=$?
if [[ "$code" -eq 0 ]] && printf '%s' "$live_session_status" | jq -e '.status == "ready" and .processAlive == true and .activeTurns == []' >/dev/null 2>&1; then
    check "live host remains ready after multiple terminal turns" 0
else
    check "live host remains ready after multiple terminal turns" 1 "status=$live_session_status"
fi
node "$SCRIPTS_DIR/codex-app-server.mjs" shutdown --session-dir "$LIVE_SESSION_DIR" >/dev/null 2>&1

list_out="$("$SCRIPTS_DIR/codex-review-list.sh" 10 2>&1)"
assert_contains "list shows review kind" "$list_out" "review"
assert_contains "list shows exec kind" "$list_out" "exec"

# ---------------------------------------------------------------------------
note "LIVE: delete cleans up real runs"
# ---------------------------------------------------------------------------

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
if ! printf '%s' "$list_out" | grep -qF -- "$BG_RUN_ID" && ! printf '%s' "$list_out" | grep -qF -- "$EXEC_RUN_ID"; then
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
