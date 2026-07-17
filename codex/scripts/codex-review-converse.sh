#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_helpers.sh"

codex_review_require_cmds

usage() {
    cat <<'EOF'
Usage: codex-review-converse.sh <run_id> [--workdir <dir>] [--prompt-file <path>] [--model <name>] [--effort <value>] <prompt>
Usage: codex-review-converse.sh --last [--workdir <dir>] [--prompt-file <path>] [--model <name>] [--effort <value>] <prompt>

Continue a review or exec session through its persistent App Server host. A
running turn is steered. An idle host starts a new turn on the same connection
and durable thread.

The follow-up resumes with its working directory set to the run's recorded
workdir (from meta.json). This keeps the App Server sandbox root on the target
repository when the follow-up is launched from another directory. Override
with --workdir when the run has moved.

Reasoning effort and model are inherited from the run's recorded meta.json on
resume when not passed explicitly. Pass --effort/--model to override.

Options:
  --workdir <dir>   directory to resume in (default: the run's recorded workdir)
  --effort <value>  Reasoning effort advertised by the selected model
                    (default: the run's recorded effort)
  --model <name>    model to resume with (default: the run's recorded model)

If only one positional argument is provided after --last, it is treated as the prompt.
EOF
}

RUN_ID=""
USE_LAST="false"
PROMPT_FILE=""
MODEL=""
EFFORT=""
PROMPT=""
WORKDIR=""
CONFIG_FLAGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --prompt-file)
            [[ $# -lt 2 ]] && { echo "--prompt-file requires a path" >&2; exit 1; }
            PROMPT_FILE="$2"
            shift 2
            ;;
        --model)
            [[ $# -lt 2 ]] && { echo "--model requires a value" >&2; exit 1; }
            MODEL="$2"
            shift 2
            ;;
        --workdir)
            [[ $# -lt 2 ]] && { echo "--workdir requires a path" >&2; exit 1; }
            WORKDIR="$2"
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
        --help|-h)
            usage
            exit 0
            ;;
        --last|-l)
            USE_LAST="true"
            shift
            ;;
        *)
            if [[ "$USE_LAST" == "true" ]]; then
                if [[ -z "$PROMPT" ]]; then
                    PROMPT="$1"
                else
                    PROMPT="$PROMPT $1"
                fi
                shift
                continue
            fi

            if [[ -z "$RUN_ID" ]]; then
                RUN_ID="$1"
                shift
                continue
            fi

            if [[ -z "$PROMPT" ]]; then
                PROMPT="$1"
            else
                PROMPT="$PROMPT $1"
            fi
            shift
            ;;
    esac
done

if ! RUN_ID="$(codex_review_resolve_run_id "$RUN_ID")"; then
    echo "No review run found." >&2
    exit 1
fi
if [[ -z "$RUN_ID" ]]; then
    echo "No review run found." >&2
    exit 1
fi

META_FILE="$(codex_review_meta_file "$RUN_ID")"
if [[ ! -f "$META_FILE" ]]; then
    echo "Metadata missing for run $RUN_ID" >&2
    exit 1
fi
# Review and exec runs continue through App Server. Legacy MCP runs keep their
# live thread inside the old server process, so route those to codex-mcp-send.sh.
if [[ "$(jq -r '.kind // "review"' "$META_FILE")" == "mcp" ]]; then
    echo "Run $RUN_ID is an MCP conversation. Use codex-mcp-send.sh $RUN_ID \"<prompt>\" instead." >&2
    exit 1
fi

# Resume in the run's recorded workdir unless overridden so App Server applies
# the sandbox policy to the target repository.
if [[ -z "$WORKDIR" ]]; then
    WORKDIR="$(codex_review_get_meta_field "$RUN_ID" workdir)"
fi
if [[ -n "$WORKDIR" && "$WORKDIR" != "null" ]]; then
    if [[ ! -d "$WORKDIR" ]]; then
        echo "Resume workdir does not exist: $WORKDIR (pass --workdir to override)." >&2
        exit 1
    fi
else
    WORKDIR="$(pwd)"
fi

# Default to the recorded effort so every follow-up stays at the same tier.
if [[ -z "$EFFORT" ]]; then
    META_EFFORT="$(codex_review_get_meta_field "$RUN_ID" effort)"
    if [[ -n "$META_EFFORT" && "$META_EFFORT" != "null" ]]; then
        EFFORT="$META_EFFORT"
        CONFIG_FLAGS+=(-c "model_reasoning_effort=$META_EFFORT")
    fi
fi

# Likewise keep the run's recorded model on resume when not overridden, so a
# follow-up does not silently switch models mid-session.
if [[ -z "$MODEL" ]]; then
    META_MODEL="$(codex_review_get_meta_field "$RUN_ID" model)"
    if [[ -n "$META_MODEL" && "$META_MODEL" != "null" ]]; then
        MODEL="$META_MODEL"
    fi
fi

if [[ -n "$PROMPT_FILE" ]]; then
    if [[ ! -f "$PROMPT_FILE" ]]; then
        echo "Prompt file not found: $PROMPT_FILE" >&2
        exit 1
    fi
    PROMPT="$(cat "$PROMPT_FILE")"
fi

if [[ -z "$PROMPT" && -t 0 ]]; then
    echo "No prompt given. Pass text as arguments, --prompt-file, or read from stdin." >&2
    exit 1
fi

if [[ -z "$PROMPT" ]]; then
    PROMPT="$(cat)"
fi

if [[ "$PROMPT" == "" ]]; then
    echo "Prompt is empty." >&2
    exit 1
fi

SESSION_ID="$(codex_review_get_meta_field "$RUN_ID" thread_id)"
if [[ -z "$SESSION_ID" || "$SESSION_ID" == "null" ]]; then
    # Try legacy extraction from exec-mode log
    LOG_FILE="$(codex_review_get_meta_field "$RUN_ID" log_file)"
    SESSION_ID="$(codex_review_extract_thread_id "$LOG_FILE" || true)"
    if [[ -z "$SESSION_ID" ]]; then
        echo "Session id not known yet for run $RUN_ID. Wait for review startup to complete." >&2
        exit 1
    fi
    codex_review_set_meta_field "$RUN_ID" thread_id "$SESSION_ID"
fi

RUN_STATUS="$(codex_review_get_meta_field "$RUN_ID" status)"
SESSION_DIR="$(codex_review_get_meta_field "$RUN_ID" session_dir)"
if [[ -z "$SESSION_DIR" || "$SESSION_DIR" == "null" ]]; then
    SESSION_DIR="$(codex_review_get_meta_field "$RUN_ID" control_dir)"
fi
if [[ -z "$SESSION_DIR" || "$SESSION_DIR" == "null" || ! -f "$SESSION_DIR/state.json" ]]; then
    echo "Run $RUN_ID has no persistent App Server session host. Inspect its event log and thread state before recovery." >&2
    exit 1
fi
HOST_STATE="$(node "$SCRIPT_DIR/codex-app-server.mjs" status --session-dir "$SESSION_DIR" 2>/dev/null || true)"
if ! printf '%s' "$HOST_STATE" | jq -e '.status == "ready" and .processAlive == true and .responsive == true' >/dev/null 2>&1; then
    echo "Run $RUN_ID App Server session host is not ready. Inspect $SESSION_DIR/state.json before recovery." >&2
    exit 1
fi
ACTIVE_TURNS="$(printf '%s' "$HOST_STATE" | jq -r '.activeTurns | length')"
if [[ "$ACTIVE_TURNS" -gt 0 ]]; then
    node "$SCRIPT_DIR/codex-app-server.mjs" steer --session-dir "$SESSION_DIR" \
        --thread "$SESSION_ID" --prompt "$PROMPT"
    exit 0
fi

if [[ "$RUN_STATUS" != "completed" ]]; then
    echo "Run $RUN_ID has status $RUN_STATUS. Resume is allowed only after a confirmed completed turn; inspect thread/read and the event log first." >&2
    exit 1
fi

CONV_DIR="$(codex_review_get_meta_field "$RUN_ID" conversation_dir)"
mkdir -p "$CONV_DIR"

STAMP="$(codex_review_unix_ts)"
OUT_FILE="$CONV_DIR/converse-${STAMP}.md"
LOG_FILE="$CONV_DIR/converse-${STAMP}.log"
ERROR_FILE="$CONV_DIR/converse-${STAMP}.stderr.log"

# Keep all follow-up turns on the existing bidirectional connection so server
# notifications and requests remain visible to the same session owner.
APP_SERVER_CMD=(node "$SCRIPT_DIR/codex-app-server.mjs" turn --session-dir "$SESSION_DIR" --thread "$SESSION_ID" --prompt "$PROMPT" --workdir "$WORKDIR" --report "$OUT_FILE")
if [[ -n "$MODEL" ]]; then
    APP_SERVER_CMD+=(--model "$MODEL")
fi
if [[ -n "$EFFORT" ]]; then
    APP_SERVER_CMD+=(--effort "$EFFORT")
fi
if ( cd "$WORKDIR" && "${APP_SERVER_CMD[@]}" >"$CONV_DIR/converse-${STAMP}.json" 2>>"$ERROR_FILE" ); then
    EXIT_CODE=0
else
    EXIT_CODE=$?
fi

if [[ $EXIT_CODE -ne 0 ]]; then
    echo "Conversation command returned non-zero status: $EXIT_CODE. Check: $ERROR_FILE" >&2
fi

if [[ -f "$OUT_FILE" && -s "$OUT_FILE" ]]; then
    if [[ -n "$EFFORT" ]]; then
        codex_review_set_meta_field "$RUN_ID" effort "$EFFORT"
    fi
    echo "===== Conversation response for $RUN_ID ====="
    cat "$OUT_FILE"
else
    echo "No response file produced. Check log: $LOG_FILE" >&2
    exit 1
fi

exit "$EXIT_CODE"
