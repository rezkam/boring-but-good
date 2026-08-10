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

Continue a running or completed review session with extra perspective.
The prompt is sent to the same Codex session so the model can synthesize across multiple review passes.

The follow-up resumes with its working directory set to the run's recorded
workdir (from meta.json), because `codex exec resume` derives its
workspace-write sandbox root from the current directory: without this, an exec
follow-up launched from another cwd cannot write the target repo. Override with
--workdir when the run has moved.

Reasoning effort and model are inherited from the run's recorded meta.json on
resume when not passed explicitly, because `codex exec resume` otherwise falls
back to the model's default effort (e.g. xhigh for gpt-5.5) instead of the tier
the run was started with. Pass --effort/--model to override.

Options:
  --workdir <dir>   directory to resume in (default: the run's recorded workdir)
  --effort <value>  Reasoning effort: minimal, low, medium, high, xhigh
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
# Review and exec runs continue via `codex exec resume`. An MCP run's live
# thread lives inside its server process; resuming it from disk here would
# silently fork the conversation. Route those to codex-mcp-send.sh.
if [[ "$(jq -r '.kind // "review"' "$META_FILE")" == "mcp" ]]; then
    echo "Run $RUN_ID is an MCP conversation. Use codex-mcp-send.sh $RUN_ID \"<prompt>\" instead." >&2
    exit 1
fi

# Resume in the run's recorded workdir unless overridden. codex exec resume
# derives its workspace-write sandbox root from the current directory (same as
# codex-exec-start.sh, which runs `(cd "$WORKDIR" && codex exec ...)`), so a
# follow-up launched from anywhere else cannot write the target repo.
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

# Inherit the run's recorded reasoning effort on resume. `codex exec resume`
# does NOT carry the effort over from the original session: without an explicit
# override it falls back to the model's collaboration-mode default (e.g. xhigh
# for gpt-5.5), silently diverging from the effort the run was started with.
# Default to the recorded effort so every follow-up stays at the same tier.
if [[ -z "$EFFORT" ]]; then
    META_EFFORT="$(codex_review_get_meta_field "$RUN_ID" effort)"
    if [[ -n "$META_EFFORT" && "$META_EFFORT" != "null" ]]; then
        validate_effort "$META_EFFORT"
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

CONV_DIR="$(codex_review_get_meta_field "$RUN_ID" conversation_dir)"
mkdir -p "$CONV_DIR"

STAMP="$(codex_review_unix_ts)"
OUT_FILE="$CONV_DIR/converse-${STAMP}.md"
LOG_FILE="$CONV_DIR/converse-${STAMP}.log"

# Direct `codex resume` requires a TTY. Use exec resume for non-interactive follow-up.
CODEX_CMD=(codex exec resume "$SESSION_ID" --json --output-last-message "$OUT_FILE")
if [[ -n "$MODEL" ]]; then
    CODEX_CMD+=(-m "$MODEL")
fi
if [[ ${#CONFIG_FLAGS[@]} -gt 0 ]]; then
    CODEX_CMD+=("${CONFIG_FLAGS[@]}")
fi

# OUT_FILE/LOG_FILE are absolute (under the run store), so the cd only affects
# the codex sandbox root, not where output lands.
if ( cd "$WORKDIR" && printf '%s' "$PROMPT" | "${CODEX_CMD[@]}" >"$LOG_FILE" 2>&1 ); then
    EXIT_CODE=0
else
    EXIT_CODE=$?
fi

if [[ $EXIT_CODE -ne 0 ]]; then
    echo "Conversation command returned non-zero status: $EXIT_CODE" >&2
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
