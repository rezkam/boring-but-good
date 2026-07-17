#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_helpers.sh"

codex_review_require_cmds

usage() {
    cat <<'EOF'
Usage: codex-review-start.sh [options] [prompt]

Start a non-interactive Codex code review session in background.

Options:
  --uncommitted             Review staged, unstaged, and untracked changes
  --base <branch>           Review changes against a base branch
  --commit <sha>            Review changes from a commit
  --title <text>            Optional session title shown in the report
  --preset <name>           Optional review lens: adversarial, security, architecture, completeness
  --prompt <text>           Custom prompt for the review
  --prompt-file <path>      Read custom prompt from file
  --model <name>            Override model used by Codex
  --effort <value>          Reasoning effort advertised by the selected model
  --config <k=v>            Codex -c config override (repeatable),
                            e.g. --config model_reasoning_effort=low
  --approval <mode>         decline (default) or interactive
  --workdir <path>          Set working directory for diff resolution
  --wait                    Run in foreground and return when completed
  --help                    Show this message

Either use --prompt or provide prompt as positional arguments.
EOF
}

SCOPE="uncommitted"
SCOPE_VALUE=""
TITLE=""
PRESET=""
CUSTOM_PROMPT=""
CUSTOM_PROMPT_FILE=""
MODEL=""
EFFORT=""
CONFIG_FLAGS=()
WORKDIR="$(pwd)"
WAIT="false"
APPROVAL="decline"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --uncommitted)
            SCOPE="uncommitted"
            SCOPE_VALUE=""
            shift
            ;;
        --base)
            [[ $# -lt 2 ]] && { echo "--base requires a value" >&2; exit 1; }
            SCOPE="base"
            SCOPE_VALUE="$2"
            shift 2
            ;;
        --commit)
            [[ $# -lt 2 ]] && { echo "--commit requires a value" >&2; exit 1; }
            SCOPE="commit"
            SCOPE_VALUE="$2"
            shift 2
            ;;
        --title)
            [[ $# -lt 2 ]] && { echo "--title requires a value" >&2; exit 1; }
            TITLE="$2"
            shift 2
            ;;
        --preset)
            [[ $# -lt 2 ]] && { echo "--preset requires a value" >&2; exit 1; }
            PRESET="$2"
            shift 2
            ;;
        --prompt)
            [[ $# -lt 2 ]] && { echo "--prompt requires a value" >&2; exit 1; }
            CUSTOM_PROMPT="$2"
            shift 2
            ;;
        --prompt-file)
            [[ $# -lt 2 ]] && { echo "--prompt-file requires a value" >&2; exit 1; }
            CUSTOM_PROMPT_FILE="$2"
            shift 2
            ;;
        --model)
            [[ $# -lt 2 ]] && { echo "--model requires a value" >&2; exit 1; }
            MODEL="$2"
            shift 2
            ;;
        --effort)
            [[ $# -lt 2 ]] && { echo "--effort requires a value" >&2; exit 1; }
            EFFORT="$2"
            CONFIG_FLAGS+=(-c "model_reasoning_effort=$2")
            shift 2
            ;;
        --config)
            [[ $# -lt 2 ]] && { echo "--config requires a key=value" >&2; exit 1; }
            if [[ "$2" == model_reasoning_effort=* ]]; then
                EFFORT="${2#*=}"
            fi
            CONFIG_FLAGS+=(-c "$2")
            shift 2
            ;;
        --approval)
            [[ $# -lt 2 ]] && { echo "--approval requires a value" >&2; exit 1; }
            APPROVAL="$2"
            shift 2
            ;;
        --workdir)
            [[ $# -lt 2 ]] && { echo "--workdir requires a value" >&2; exit 1; }
            WORKDIR="$2"
            shift 2
            ;;
        --wait)
            WAIT="true"
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        --)
            shift
            if [[ $# -gt 0 ]]; then
                CUSTOM_PROMPT="${*}"
            fi
            break
            ;;
        *)
            if [[ -z "$CUSTOM_PROMPT" ]]; then
                CUSTOM_PROMPT="$1"
            else
                CUSTOM_PROMPT="$CUSTOM_PROMPT $1"
            fi
            shift
            ;;
    esac
done

case "$APPROVAL" in
    decline|interactive) ;;
    *) echo "Unknown approval mode '$APPROVAL'. Use decline or interactive." >&2; exit 1 ;;
esac

if [[ -n "$CUSTOM_PROMPT_FILE" ]]; then
    if [[ ! -f "$CUSTOM_PROMPT_FILE" ]]; then
        echo "Prompt file not found: $CUSTOM_PROMPT_FILE" >&2
        exit 1
    fi
    CUSTOM_PROMPT="$(cat "$CUSTOM_PROMPT_FILE")"
fi

case "$PRESET" in
    ""|adversarial|security|architecture|completeness)
        ;;
    *)
        echo "Unknown preset '$PRESET'. Use default, adversarial, security, architecture, or completeness." >&2
        exit 1
        ;;
esac

case "$SCOPE" in
    uncommitted)
        ;;
    base)
        if [[ -z "$SCOPE_VALUE" ]]; then
            echo "--base requires a branch value" >&2
            exit 1
        fi
        ;;
    commit)
        if [[ -z "$SCOPE_VALUE" ]]; then
            echo "--commit requires a commit SHA" >&2
            exit 1
        fi
        ;;
esac

PRESET_PROMPT="$(codex_review_default_preset_prompt "$PRESET")"
FINAL_PROMPT=""
if [[ -n "$PRESET_PROMPT" && -n "$CUSTOM_PROMPT" ]]; then
    FINAL_PROMPT="$PRESET_PROMPT

Additional user guidance:
$CUSTOM_PROMPT"
elif [[ -n "$PRESET_PROMPT" ]]; then
    FINAL_PROMPT="$PRESET_PROMPT"
elif [[ -n "$CUSTOM_PROMPT" ]]; then
    FINAL_PROMPT="$CUSTOM_PROMPT"
fi

WORKDIR="$(cd "$WORKDIR" && pwd)"
RUN_ID="$(codex_review_new_run_id)"
RUN_DIR="$(codex_review_run_dir "$RUN_ID")"
LOG_FILE="$RUN_DIR/events.log"
ERROR_FILE="$RUN_DIR/app-server.stderr.log"
REPORT_FILE="$RUN_DIR/report.md"
CONV_DIR="$RUN_DIR/conversations"
mkdir -p "$RUN_DIR" "$CONV_DIR"

codex_review_create_meta "$RUN_ID" "$WORKDIR" "$SCOPE" "$SCOPE_VALUE" "$TITLE" "$PRESET" "$MODEL" "" "$LOG_FILE" "$REPORT_FILE" "$CONV_DIR"
codex_review_set_meta_field "$RUN_ID" error_log "$ERROR_FILE"
if [[ -n "$EFFORT" ]]; then
    codex_review_set_meta_field "$RUN_ID" effort "$EFFORT"
fi

THREAD_FILE="$RUN_DIR/thread.id"
SESSION_DIR="$RUN_DIR/app-server-session"
CLIENT_OUTPUT_FILE="$RUN_DIR/app-server-result.json"
HOST_OUTPUT_FILE="$RUN_DIR/app-server-host.json"
HOST_CMD=(node "$SCRIPT_DIR/codex-app-server.mjs" start --session-dir "$SESSION_DIR" --events "$LOG_FILE" --approval "$APPROVAL")
APP_SERVER_CMD=(node "$SCRIPT_DIR/codex-app-server.mjs" review --session-dir "$SESSION_DIR" --scope "$SCOPE" --workdir "$WORKDIR" --thread-out "$THREAD_FILE" --report "$REPORT_FILE")
codex_review_set_meta_field "$RUN_ID" session_dir "$SESSION_DIR"
codex_review_set_meta_field "$RUN_ID" control_dir "$SESSION_DIR"
codex_review_set_meta_field "$RUN_ID" approval "$APPROVAL"
[[ -n "$SCOPE_VALUE" ]] && APP_SERVER_CMD+=(--scope-value "$SCOPE_VALUE")
[[ -n "$TITLE" ]] && APP_SERVER_CMD+=(--title "$TITLE")
[[ -n "$FINAL_PROMPT" ]] && APP_SERVER_CMD+=(--prompt "$FINAL_PROMPT")
[[ -n "$MODEL" ]] && APP_SERVER_CMD+=(--model "$MODEL")
[[ -n "$EFFORT" ]] && APP_SERVER_CMD+=(--effort "$EFFORT")
for flag_index in "${!CONFIG_FLAGS[@]}"; do
    if [[ "${CONFIG_FLAGS[$flag_index]}" == "-c" ]] && [[ -n "${CONFIG_FLAGS[$((flag_index + 1))]:-}" ]]; then
        APP_SERVER_CMD+=(--config "${CONFIG_FLAGS[$((flag_index + 1))]}")
        HOST_CMD+=(--config "${CONFIG_FLAGS[$((flag_index + 1))]}")
    fi
done
codex_review_set_meta_field "$RUN_ID" runner "codex-app-server-review"

if ! (cd "$WORKDIR" && "${HOST_CMD[@]}" >"$HOST_OUTPUT_FILE" 2>>"$ERROR_FILE"); then
    codex_review_update_status "$RUN_ID" "failed" 1
    echo "App Server session host failed to start. Check: $ERROR_FILE" >&2
    exit 1
fi
HOST_PID="$(jq -r '.pid' "$SESSION_DIR/state.json")"
codex_review_set_meta_field "$RUN_ID" pid "$HOST_PID" number
codex_review_set_meta_field "$RUN_ID" host_pid "$HOST_PID" number

run_review() {
    "${APP_SERVER_CMD[@]}" >"$CLIENT_OUTPUT_FILE" 2>>"$ERROR_FILE"
}

record_session_id() {
    local session_id=""
    if [[ -f "$THREAD_FILE" ]]; then
        session_id="$(tr -d '[:space:]' < "$THREAD_FILE")"
    fi
    if [[ -n "$session_id" ]]; then
        codex_review_set_meta_field "$RUN_ID" thread_id "$session_id"
        printf '%s' "$session_id"
    fi
}

if [[ "$WAIT" == "true" ]]; then
    codex_review_set_meta_field "$RUN_ID" status "running"
    codex_review_update_timestamp "$RUN_ID"

    cd "$WORKDIR"
    if run_review; then
        EXIT_CODE=0
    else
        EXIT_CODE=$?
    fi

    record_session_id >/dev/null

    if [[ $EXIT_CODE -eq 0 ]]; then
        codex_review_update_status "$RUN_ID" "completed" "$EXIT_CODE"
    else
        codex_review_update_status "$RUN_ID" "failed" "$EXIT_CODE"
    fi

    if [[ -f "$REPORT_FILE" && -s "$REPORT_FILE" ]]; then
        cat "$REPORT_FILE"
    else
        echo "No report file generated at $REPORT_FILE" >&2
    fi

    exit "$EXIT_CODE"
fi

SESSION_ID=""
(
    codex_review_set_meta_field "$RUN_ID" status "running"
    codex_review_update_timestamp "$RUN_ID"

    cd "$WORKDIR"
    if run_review; then
        EXIT_CODE=0
    else
        EXIT_CODE=$?
    fi

    record_session_id >/dev/null

    if [[ $EXIT_CODE -eq 0 ]]; then
        codex_review_update_status "$RUN_ID" "completed" "$EXIT_CODE"
    else
        codex_review_update_status "$RUN_ID" "failed" "$EXIT_CODE"
    fi
) >/dev/null 2>&1 &
RUN_PID=$!
codex_review_set_meta_field "$RUN_ID" turn_client_pid "$RUN_PID" number

for _ in $(seq 1 30); do
    SESSION_ID="$(record_session_id || true)"
    if [[ -n "$SESSION_ID" ]]; then
        break
    fi
    sleep 0.5
done

cat <<EOF
run_id: $RUN_ID
status: running
session_id: ${SESSION_ID:-pending}
runner: codex app-server review/start
workdir: $WORKDIR
log_file: $LOG_FILE
error_log: $ERROR_FILE
report_file: $REPORT_FILE
session_dir: $SESSION_DIR
scope: $SCOPE ${SCOPE_VALUE:+($SCOPE_VALUE)}
host_pid: $HOST_PID

Use this command to check progress:
  $SCRIPT_DIR/codex-review-status.sh $RUN_ID

Use this command when done:
  $SCRIPT_DIR/codex-review-report.sh $RUN_ID

Steer or interrupt the active review on its owning connection:
  node $SCRIPT_DIR/codex-app-server.mjs steer --session-dir $SESSION_DIR --prompt "<instruction>"
  node $SCRIPT_DIR/codex-app-server.mjs interrupt --session-dir $SESSION_DIR
  node $SCRIPT_DIR/codex-app-server.mjs pending --session-dir $SESSION_DIR

If you want to add an adversarial or security follow up prompt:
  $SCRIPT_DIR/codex-review-converse.sh $RUN_ID "Your additional request"
EOF

exit 0
