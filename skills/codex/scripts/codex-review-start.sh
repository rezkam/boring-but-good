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
  --effort <value>          Reasoning effort: minimal, low, medium, high, xhigh
  --config <k=v>            Codex -c config override (repeatable),
                            e.g. --config model_reasoning_effort=low
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
            validate_effort "$2"
            EFFORT="$2"
            CONFIG_FLAGS+=(-c "model_reasoning_effort=$2")
            shift 2
            ;;
        --config)
            [[ $# -lt 2 ]] && { echo "--config requires a key=value" >&2; exit 1; }
            if [[ "$2" == model_reasoning_effort=* ]]; then
                effort_value="${2#*=}"
                validate_effort "$effort_value"
                EFFORT="$effort_value"
            fi
            CONFIG_FLAGS+=(-c "$2")
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

# codex-cli 0.142.5 rejects scope flags combined with the [PROMPT] argument
# at parse time, on BOTH `codex review` and `codex exec review`. Prompt-mode
# reviews therefore only work on the default scope, which is the uncommitted
# change set. Refuse the impossible combination instead of silently dropping
# the prompt (the failure mode this replaced).
if [[ -n "$FINAL_PROMPT" && "$SCOPE" != "uncommitted" ]]; then
    echo "codex cannot combine --base/--commit with a preset or custom prompt (scope flags are mutually exclusive with [PROMPT] on codex-cli 0.142.5)." >&2
    echo "Either run the scoped review without --preset/--prompt and shape it afterward with codex-review-converse.sh, or review the uncommitted scope with the preset." >&2
    exit 1
fi

WORKDIR="$(cd "$WORKDIR" && pwd)"
RUN_ID="$(codex_review_new_run_id)"
RUN_DIR="$(codex_review_run_dir "$RUN_ID")"
LOG_FILE="$RUN_DIR/events.log"
REPORT_FILE="$RUN_DIR/report.md"
CONV_DIR="$RUN_DIR/conversations"
mkdir -p "$RUN_DIR" "$CONV_DIR"

codex_review_create_meta "$RUN_ID" "$WORKDIR" "$SCOPE" "$SCOPE_VALUE" "$TITLE" "$PRESET" "$MODEL" "" "$LOG_FILE" "$REPORT_FILE" "$CONV_DIR"
if [[ -n "$EFFORT" ]]; then
    codex_review_set_meta_field "$RUN_ID" effort "$EFFORT"
fi

# Direct `codex review` is used when possible. It supports the real review
# scope flags, but it cannot combine scoped review with a custom prompt and
# it does not accept --model. Use exec review only for features that direct
# review cannot express non-interactively.
USE_EXEC="false"
if [[ -n "$FINAL_PROMPT" || -n "$MODEL" ]]; then
    USE_EXEC="true"
fi

if [[ "$USE_EXEC" == "true" ]]; then
    CODEX_CMD=(codex exec review --json --output-last-message "$REPORT_FILE")
else
    CODEX_CMD=(codex review)
fi

if [[ "$SCOPE" == "uncommitted" ]]; then
    # With a prompt, the --uncommitted flag must be omitted (it conflicts
    # with [PROMPT]); uncommitted is the default scope anyway, verified by
    # probing which git commands the review harness runs.
    if [[ -z "$FINAL_PROMPT" ]]; then
        CODEX_CMD+=(--uncommitted)
    fi
elif [[ "$SCOPE" == "base" ]]; then
    CODEX_CMD+=(--base "$SCOPE_VALUE")
elif [[ "$SCOPE" == "commit" ]]; then
    CODEX_CMD+=(--commit "$SCOPE_VALUE")
fi
if [[ -n "$TITLE" ]]; then
    CODEX_CMD+=(--title "$TITLE")
fi
if [[ "$USE_EXEC" == "true" && -n "$MODEL" ]]; then
    CODEX_CMD+=(-m "$MODEL")
fi
# Both `codex review` and `codex exec review` accept -c overrides
# (verified on codex-cli 0.142.5), so config flags apply to either runner.
if [[ ${#CONFIG_FLAGS[@]} -gt 0 ]]; then
    CODEX_CMD+=("${CONFIG_FLAGS[@]}")
fi

codex_review_set_meta_field "$RUN_ID" runner "$([[ "$USE_EXEC" == "true" ]] && echo "codex-exec-review" || echo "codex-review")"

SESS_BASE="${CODEX_HOME:-$HOME/.codex}/sessions"
PRE_MARKER="$RUN_DIR/.pre_sessions_stamp"
codex_review_stamp_sessions "$SESS_BASE" > "$PRE_MARKER"

run_review() {
    local report_file="$1"
    local log_file="$2"

    if [[ "$USE_EXEC" == "true" ]]; then
        if [[ -n "$FINAL_PROMPT" ]]; then
            # The custom instructions are a POSITIONAL argument to
            # `codex exec review`; stdin is only read when that argument is
            # `-`. Piping without `-` silently drops the whole prompt
            # (verified on codex-cli 0.142.5 by grepping the session rollout).
            printf '%s' "$FINAL_PROMPT" | "${CODEX_CMD[@]}" - >"$log_file" 2>&1
        else
            "${CODEX_CMD[@]}" >"$log_file" 2>&1
        fi
        return $?
    fi

    # Direct review writes the human report to stdout and progress/errors to stderr.
    "${CODEX_CMD[@]}" >"$report_file" 2>"$log_file"
}

record_session_id() {
    local session_id=""
    session_id="$(codex_review_extract_session_id_from_log "$LOG_FILE" || true)"
    if [[ -z "$session_id" ]]; then
        session_id="$(codex_review_extract_thread_id "$LOG_FILE" || true)"
    fi
    if [[ -z "$session_id" ]]; then
        session_id="$(codex_review_find_new_session "$SESS_BASE" "$PRE_MARKER" || true)"
    fi
    if [[ -n "$session_id" ]]; then
        codex_review_set_meta_field "$RUN_ID" thread_id "$session_id"
        printf '%s' "$session_id"
    fi
}

if [[ "$WAIT" == "true" ]]; then
    codex_review_set_meta_field "$RUN_ID" status "running"
    codex_review_set_meta_field "$RUN_ID" pid "$$" number
    codex_review_update_timestamp "$RUN_ID"

    cd "$WORKDIR"
    if run_review "$REPORT_FILE" "$LOG_FILE"; then
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
    if run_review "$REPORT_FILE" "$LOG_FILE"; then
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
codex_review_set_meta_field "$RUN_ID" pid "$RUN_PID" number

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
runner: $([[ "$USE_EXEC" == "true" ]] && echo "codex exec review" || echo "codex review")
workdir: $WORKDIR
log_file: $LOG_FILE
report_file: $REPORT_FILE
scope: $SCOPE ${SCOPE_VALUE:+($SCOPE_VALUE)}
pid: $RUN_PID

Use this command to check progress:
  $SCRIPT_DIR/codex-review-status.sh $RUN_ID

Use this command when done:
  $SCRIPT_DIR/codex-review-report.sh $RUN_ID

If you want to add an adversarial or security follow up prompt:
  $SCRIPT_DIR/codex-review-converse.sh $RUN_ID "Your additional request"
EOF

exit 0
