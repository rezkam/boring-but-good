#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_helpers.sh"

codex_review_require_cmds

usage() {
    cat <<'EOF'
Usage: codex-exec-start.sh [options] "<task prompt>"
       codex-exec-start.sh [options] --prompt-file <path>

Run codex as a background IMPLEMENTATION worker through App Server as a tracked run.
The coordinator that launched it polls codex-exec-status.sh for a liveness
verdict (running / wedged / stalled / dead / completed / failed), follows up
in the same session with codex-review-converse.sh, and owns verifying the
resulting diff.

Options:
  --workdir <dir>      repo to work in (default: current directory)
  --sandbox <mode>     read-only | workspace-write (default) | danger-full-access
  --network            allow network inside workspace-write (dependency fetches)
  --model <name>       model override
  --effort <value>     reasoning effort: minimal, low, medium, high, xhigh
  --config k=v         repeatable codex -c override (e.g. model_reasoning_effort=low)
  --approval <mode>    decline (default) or interactive
  --title <text>       label shown in the run list
  --prompt-file <path> read the task prompt from a file
  --wait               run foreground and print the final message

Notes for coordinators:
  - One task per run; follow-ups continue the SAME session via converse.
  - Start from a clean tree (or record the baseline commit) so the worker's
    diff is separable from yours; do not touch the tree while it runs.
  - workspace-write keeps .git read-only: the worker cannot commit. Collect
    the diff and commit yourself, or run a scoped commit-only follow-up.
EOF
}

WORKDIR="$PWD"
SANDBOX="workspace-write"
NETWORK="false"
MODEL=""
EFFORT=""
TITLE=""
PROMPT=""
PROMPT_FILE=""
WAIT="false"
CONFIG_FLAGS=()
APPROVAL="decline"

validate_effort() {
    case "$1" in
        minimal|low|medium|high|xhigh) ;;
        *)
            echo "Unknown effort '$1'. Use minimal, low, medium, high, or xhigh." >&2
            exit 1
            ;;
    esac
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --workdir) [[ $# -lt 2 ]] && { echo "--workdir requires a path" >&2; exit 1; }; WORKDIR="$2"; shift 2 ;;
        --sandbox) [[ $# -lt 2 ]] && { echo "--sandbox requires a mode" >&2; exit 1; }; SANDBOX="$2"; shift 2 ;;
        --network) NETWORK="true"; shift ;;
        --model) [[ $# -lt 2 ]] && { echo "--model requires a value" >&2; exit 1; }; MODEL="$2"; shift 2 ;;
        --effort) [[ $# -lt 2 ]] && { echo "--effort requires a value" >&2; exit 1; }; validate_effort "$2"; EFFORT="$2"; CONFIG_FLAGS+=(-c "model_reasoning_effort=$2"); shift 2 ;;
        --config) [[ $# -lt 2 ]] && { echo "--config requires a key=value" >&2; exit 1; }; if [[ "$2" == model_reasoning_effort=* ]]; then effort_value="${2#*=}"; validate_effort "$effort_value"; EFFORT="$effort_value"; fi; CONFIG_FLAGS+=(-c "$2"); shift 2 ;;
        --approval) [[ $# -lt 2 ]] && { echo "--approval requires a value" >&2; exit 1; }; APPROVAL="$2"; shift 2 ;;
        --title) [[ $# -lt 2 ]] && { echo "--title requires a value" >&2; exit 1; }; TITLE="$2"; shift 2 ;;
        --prompt-file) [[ $# -lt 2 ]] && { echo "--prompt-file requires a path" >&2; exit 1; }; PROMPT_FILE="$2"; shift 2 ;;
        --wait) WAIT="true"; shift ;;
        --help|-h) usage; exit 0 ;;
        -*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
        *)
            if [[ -z "$PROMPT" ]]; then PROMPT="$1"; else PROMPT="$PROMPT $1"; fi
            shift
            ;;
    esac
done

case "$SANDBOX" in
    read-only|workspace-write) ;;
    danger-full-access)
        echo "WARNING: danger-full-access removes OS-level control. Use only in a dedicated worktree with a prompt you authored end to end." >&2
        ;;
    *)
        echo "Unknown sandbox '$SANDBOX'. Use read-only, workspace-write, or danger-full-access." >&2
        exit 1
        ;;
esac

case "$APPROVAL" in
    decline|interactive) ;;
    *) echo "Unknown approval mode '$APPROVAL'. Use decline or interactive." >&2; exit 1 ;;
esac

if [[ -n "$PROMPT_FILE" ]]; then
    if [[ ! -f "$PROMPT_FILE" ]]; then
        echo "Prompt file not found: $PROMPT_FILE" >&2
        exit 1
    fi
    PROMPT="$(cat "$PROMPT_FILE")"
fi
if [[ -z "$PROMPT" ]]; then
    echo "No task prompt given. Pass it as an argument or via --prompt-file." >&2
    exit 1
fi

if [[ ! -d "$WORKDIR" ]]; then
    echo "Workdir not found: $WORKDIR" >&2
    exit 1
fi
WORKDIR="$(cd "$WORKDIR" && pwd)"

if [[ "$NETWORK" == "true" ]]; then
    CONFIG_FLAGS+=(-c sandbox_workspace_write.network_access=true)
fi

BASELINE_COMMIT="none"
BASELINE_DIRTY="false"
if git -C "$WORKDIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    BASELINE_COMMIT="$(git -C "$WORKDIR" rev-parse HEAD 2>/dev/null || printf 'none')"
    if [[ -n "$(git -C "$WORKDIR" status --porcelain)" ]]; then
        BASELINE_DIRTY="true"
    fi
fi

RUN_ID="$(codex_review_new_run_id)"
RUN_DIR="$(codex_review_run_dir "$RUN_ID")"
LOG_FILE="$RUN_DIR/events.log"
ERROR_FILE="$RUN_DIR/app-server.stderr.log"
REPORT_FILE="$RUN_DIR/report.md"
CONV_DIR="$RUN_DIR/conversations"
mkdir -p "$RUN_DIR" "$CONV_DIR"

codex_review_create_meta "$RUN_ID" "$WORKDIR" "exec-task" "" "$TITLE" "" "$MODEL" "$SANDBOX" "$LOG_FILE" "$REPORT_FILE" "$CONV_DIR"
codex_review_set_meta_field "$RUN_ID" kind "exec"
if [[ -n "$EFFORT" ]]; then
    codex_review_set_meta_field "$RUN_ID" effort "$EFFORT"
fi
codex_review_set_meta_field "$RUN_ID" baseline_commit "$BASELINE_COMMIT"
codex_review_set_meta_field "$RUN_ID" baseline_dirty "$BASELINE_DIRTY"
codex_review_set_meta_field "$RUN_ID" error_log "$ERROR_FILE"
printf '%s\n' "$PROMPT" > "$RUN_DIR/task-prompt.txt"

THREAD_FILE="$RUN_DIR/thread.id"
SESSION_DIR="$RUN_DIR/app-server-session"
CLIENT_OUTPUT_FILE="$RUN_DIR/app-server-result.json"
HOST_OUTPUT_FILE="$RUN_DIR/app-server-host.json"
HOST_CMD=(node "$SCRIPT_DIR/codex-app-server.mjs" start --session-dir "$SESSION_DIR" --events "$LOG_FILE" --approval "$APPROVAL")
APP_SERVER_CMD=(node "$SCRIPT_DIR/codex-app-server.mjs" turn --session-dir "$SESSION_DIR" --new --prompt "$PROMPT" --workdir "$WORKDIR" --sandbox "$SANDBOX" --thread-out "$THREAD_FILE" --report "$REPORT_FILE")
codex_review_set_meta_field "$RUN_ID" session_dir "$SESSION_DIR"
codex_review_set_meta_field "$RUN_ID" control_dir "$SESSION_DIR"
codex_review_set_meta_field "$RUN_ID" approval "$APPROVAL"
if [[ -n "$MODEL" ]]; then
    APP_SERVER_CMD+=(--model "$MODEL")
fi
if [[ -n "$EFFORT" ]]; then
    APP_SERVER_CMD+=(--effort "$EFFORT")
fi
if [[ "$NETWORK" == "true" ]]; then
    HOST_CMD+=(--network)
    APP_SERVER_CMD+=(--network)
fi
for flag_index in "${!CONFIG_FLAGS[@]}"; do
    if [[ "${CONFIG_FLAGS[$flag_index]}" == "-c" ]] && [[ -n "${CONFIG_FLAGS[$((flag_index + 1))]:-}" ]]; then
        APP_SERVER_CMD+=(--config "${CONFIG_FLAGS[$((flag_index + 1))]}")
        HOST_CMD+=(--config "${CONFIG_FLAGS[$((flag_index + 1))]}")
    fi
done

if ! (cd "$WORKDIR" && "${HOST_CMD[@]}" >"$HOST_OUTPUT_FILE" 2>>"$ERROR_FILE"); then
    codex_review_update_status "$RUN_ID" "failed" 1
    echo "App Server session host failed to start. Check: $ERROR_FILE" >&2
    exit 1
fi
HOST_PID="$(jq -r '.pid' "$SESSION_DIR/state.json")"
codex_review_set_meta_field "$RUN_ID" pid "$HOST_PID" number
codex_review_set_meta_field "$RUN_ID" host_pid "$HOST_PID" number

run_exec() {
    # The persistent session host owns App Server. This process only waits for
    # the initial turn and leaves the host alive for later messages.
    (cd "$WORKDIR" && "${APP_SERVER_CMD[@]}" >"$CLIENT_OUTPUT_FILE" 2>>"$ERROR_FILE")
}

record_thread_id() {
    local tid=""
    if [[ -f "$THREAD_FILE" ]]; then
        tid="$(tr -d '[:space:]' < "$THREAD_FILE")"
    fi
    if [[ -n "$tid" ]]; then
        codex_review_set_meta_field "$RUN_ID" thread_id "$tid"
        printf '%s' "$tid"
    fi
}

if [[ "$WAIT" == "true" ]]; then
    codex_review_set_meta_field "$RUN_ID" status "running"
    if run_exec; then EXIT_CODE=0; else EXIT_CODE=$?; fi
    record_thread_id >/dev/null
    if [[ $EXIT_CODE -eq 0 ]]; then
        codex_review_update_status "$RUN_ID" "completed" "$EXIT_CODE"
    else
        codex_review_update_status "$RUN_ID" "failed" "$EXIT_CODE"
    fi
    if [[ -s "$REPORT_FILE" ]]; then
        cat "$REPORT_FILE"
    else
        echo "No final message produced. Check log: $LOG_FILE" >&2
    fi
    exit "$EXIT_CODE"
fi

(
    codex_review_set_meta_field "$RUN_ID" status "running"
    if run_exec; then EXIT_CODE=0; else EXIT_CODE=$?; fi
    record_thread_id >/dev/null
    if [[ $EXIT_CODE -eq 0 ]]; then
        codex_review_update_status "$RUN_ID" "completed" "$EXIT_CODE"
    else
        codex_review_update_status "$RUN_ID" "failed" "$EXIT_CODE"
    fi
) >/dev/null 2>&1 &
RUN_PID=$!
codex_review_set_meta_field "$RUN_ID" turn_client_pid "$RUN_PID" number

THREAD_ID=""
for _ in $(seq 1 20); do
    THREAD_ID="$(record_thread_id || true)"
    [[ -n "$THREAD_ID" ]] && break
    sleep 0.5
done

cat <<EOF
run_id: $RUN_ID
kind: exec
status: running
thread_id: ${THREAD_ID:-pending}
sandbox: $SANDBOX
workdir: $WORKDIR
log_file: $LOG_FILE
error_log: $ERROR_FILE
session_dir: $SESSION_DIR
host_pid: $HOST_PID

Poll progress and liveness:
  $SCRIPT_DIR/codex-exec-status.sh $RUN_ID
Steer or interrupt the active turn on its owning connection:
  node $SCRIPT_DIR/codex-app-server.mjs steer --session-dir $SESSION_DIR --prompt "<instruction>"
  node $SCRIPT_DIR/codex-app-server.mjs interrupt --session-dir $SESSION_DIR
  node $SCRIPT_DIR/codex-app-server.mjs pending --session-dir $SESSION_DIR
Follow up in the same session after completion:
  $SCRIPT_DIR/codex-review-converse.sh $RUN_ID "<follow-up>"
EOF
