#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_helpers.sh"

codex_review_require_cmds

usage() {
    cat <<'EOF'
Usage: codex-mcp-send.sh <run_id> [options] <prompt>
Usage: codex-mcp-send.sh --last [options] <prompt>

Send one conversation turn to a running codex MCP server and print the
agent's reply. The first turn starts a conversation thread; every later send
continues the SAME thread (full context), which is what makes multi-round
review discussion and adversarial back-and-forth work.

Options:
  --last               Use the most recent MCP server run
  --new-thread         Start a fresh thread on this server instead of
                       continuing the current one
  --preset <name>      Prefix a review lens on a thread-opening turn:
                       adversarial, security, architecture, completeness
  --prompt-file <path> Read the prompt from a file (safest for long prompts)
  --model <name>       Model override for a thread-opening turn
  --effort <value>     Reasoning effort for a thread-opening turn:
                       minimal, low, medium, high, xhigh
  --config <k=v>       Per-thread codex config override on a thread-opening
                       turn (repeatable), e.g. --config model_reasoning_effort=low
  --timeout <seconds>  Max wait for the reply (default 1800)
  --help               Show this message

The prompt can also be piped on stdin. Replies are archived under the run's
conversations/ directory.
EOF
}

RUN_ID=""
USE_LAST="false"
NEW_THREAD="false"
PRESET=""
PROMPT_FILE=""
MODEL=""
EFFORT=""
TIMEOUT_S=1800
PROMPT=""
CONFIG_KVS=()

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
        --last|-l)
            USE_LAST="true"
            shift
            ;;
        --new-thread)
            NEW_THREAD="true"
            shift
            ;;
        --preset)
            [[ $# -lt 2 ]] && { echo "--preset requires a value" >&2; exit 1; }
            PRESET="$2"
            shift 2
            ;;
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
        --effort)
            [[ $# -lt 2 ]] && { echo "--effort requires a value" >&2; exit 1; }
            validate_effort "$2"
            EFFORT="$2"
            CONFIG_KVS+=("model_reasoning_effort=$2")
            shift 2
            ;;
        --config)
            [[ $# -lt 2 ]] && { echo "--config requires a key=value" >&2; exit 1; }
            if [[ "$2" == model_reasoning_effort=* ]]; then
                effort_value="${2#*=}"
                validate_effort "$effort_value"
                EFFORT="$effort_value"
            fi
            CONFIG_KVS+=("$2")
            shift 2
            ;;
        --timeout)
            [[ $# -lt 2 ]] && { echo "--timeout requires seconds" >&2; exit 1; }
            TIMEOUT_S="$2"
            shift 2
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            if [[ "$USE_LAST" == "false" && -z "$RUN_ID" ]]; then
                RUN_ID="$1"
            elif [[ -z "$PROMPT" ]]; then
                PROMPT="$1"
            else
                PROMPT="$PROMPT $1"
            fi
            shift
            ;;
    esac
done

case "$PRESET" in
    ""|adversarial|security|architecture|completeness)
        ;;
    *)
        echo "Unknown preset '$PRESET'. Use adversarial, security, architecture, or completeness." >&2
        exit 1
        ;;
esac

if ! [[ "$TIMEOUT_S" =~ ^[0-9]+$ ]] || (( TIMEOUT_S < 1 )); then
    echo "--timeout must be a positive integer number of seconds." >&2
    exit 1
fi

if [[ "$USE_LAST" == "true" ]]; then
    if ! RUN_ID="$(codex_skill_latest_run_id_of_kind mcp)"; then
        echo "No MCP server run found. Start one with codex-mcp-start.sh first." >&2
        exit 1
    fi
fi
if [[ -z "$RUN_ID" ]]; then
    echo "Missing run_id (or --last)." >&2
    usage >&2
    exit 1
fi

META_FILE="$(codex_review_meta_file "$RUN_ID")"
if [[ ! -f "$META_FILE" ]]; then
    echo "Metadata missing for run $RUN_ID" >&2
    exit 1
fi
if [[ "$(jq -r '.kind // "review"' "$META_FILE")" != "mcp" ]]; then
    echo "Run $RUN_ID is a review run, not an MCP server. Use codex-review-converse.sh for review runs." >&2
    exit 1
fi

if [[ -n "$PROMPT_FILE" ]]; then
    if [[ ! -f "$PROMPT_FILE" ]]; then
        echo "Prompt file not found: $PROMPT_FILE" >&2
        exit 1
    fi
    PROMPT="$(cat "$PROMPT_FILE")"
fi
if [[ -z "$PROMPT" && ! -t 0 ]]; then
    PROMPT="$(cat)"
fi
if [[ -z "$PROMPT" ]]; then
    echo "No prompt given. Pass text as arguments, --prompt-file, or stdin." >&2
    exit 1
fi

THREAD_ID="$(codex_review_get_meta_field "$RUN_ID" thread_id)"
OPENING_TURN="false"
if [[ "$NEW_THREAD" == "true" || -z "$THREAD_ID" || "$THREAD_ID" == "null" ]]; then
    OPENING_TURN="true"
fi

if [[ "$OPENING_TURN" == "false" ]]; then
    if [[ -n "$PRESET" || -n "$MODEL" || -n "$EFFORT" || ${#CONFIG_KVS[@]} -gt 0 ]]; then
        echo "--preset/--model/--config/--effort only apply to a thread-opening turn (codex-reply accepts only the prompt). Add --new-thread or drop these flags." >&2
        exit 1
    fi
fi

if ! codex_mcp_server_alive "$RUN_ID"; then
    THREAD_HINT=""
    if [[ -n "$THREAD_ID" && "$THREAD_ID" != "null" ]]; then
        THREAD_HINT="
The conversation itself is recoverable from disk without the server:
  codex exec resume $THREAD_ID \"<your prompt>\"
(codex-reply on a NEW server cannot resume it; the MCP thread registry is per-process.)"
    fi
    echo "MCP server for run $RUN_ID is not running (status: $(codex_review_get_meta_field "$RUN_ID" status)).
Start a new server with codex-mcp-start.sh.$THREAD_HINT" >&2
    exit 1
fi

FIFO="$(codex_review_get_meta_field "$RUN_ID" fifo)"
OUT_FILE="$(codex_review_get_meta_field "$RUN_ID" log_file)"
CONV_DIR="$(codex_review_get_meta_field "$RUN_ID" conversation_dir)"
WORKDIR="$(codex_review_get_meta_field "$RUN_ID" workdir)"
SANDBOX="$(codex_review_get_meta_field "$RUN_ID" sandbox read-only)"
META_MODEL="$(codex_review_get_meta_field "$RUN_ID" model)"
mkdir -p "$CONV_DIR"

FULL_PROMPT="$PROMPT"
if [[ -n "$PRESET" ]]; then
    PRESET_PROMPT="$(codex_review_default_preset_prompt "$PRESET")"
    FULL_PROMPT="$PRESET_PROMPT

$PROMPT"
fi

REQ_ID="$(codex_mcp_next_request_id "$RUN_ID")"

if [[ "$OPENING_TURN" == "true" ]]; then
    EFFECTIVE_MODEL="$MODEL"
    if [[ -z "$EFFECTIVE_MODEL" && -n "$META_MODEL" && "$META_MODEL" != "null" ]]; then
        EFFECTIVE_MODEL="$META_MODEL"
    fi
    # Per-thread config overrides ride in arguments.config. Values are passed
    # as strings; codex parses each as TOML and falls back to the literal
    # string, matching -c semantics.
    CONFIG_JSON="{}"
    if [[ ${#CONFIG_KVS[@]} -gt 0 ]]; then
        for kv in "${CONFIG_KVS[@]}"; do
            key="${kv%%=*}"
            value="${kv#*=}"
            if [[ -z "$key" || "$key" == "$kv" ]]; then
                echo "--config expects key=value, got: $kv" >&2
                exit 1
            fi
            CONFIG_JSON="$(jq -c --arg k "$key" --arg v "$value" '.[$k] = $v' <<< "$CONFIG_JSON")"
        done
    fi
    REQUEST="$(jq -cn \
        --argjson id "$REQ_ID" \
        --arg prompt "$FULL_PROMPT" \
        --arg cwd "$WORKDIR" \
        --arg sandbox "$SANDBOX" \
        --arg model "$EFFECTIVE_MODEL" \
        --argjson config "$CONFIG_JSON" \
        '{jsonrpc: "2.0", id: $id, method: "tools/call", params: {name: "codex", arguments: ({prompt: $prompt, cwd: $cwd, sandbox: $sandbox, "approval-policy": "never"} + (if $model != "" then {model: $model} else {} end) + (if ($config | length) > 0 then {config: $config} else {} end))}}')"
else
    REQUEST="$(jq -cn \
        --argjson id "$REQ_ID" \
        --arg thread "$THREAD_ID" \
        --arg prompt "$FULL_PROMPT" \
        '{jsonrpc: "2.0", id: $id, method: "tools/call", params: {name: "codex-reply", arguments: {threadId: $thread, prompt: $prompt}}}')"
fi

if ! timeout 10 bash -c 'printf "%s\n" "$2" > "$1"' _ "$FIFO" "$REQUEST"; then
    echo "Timed out writing to the server FIFO. The server may have died; check codex-mcp-status.sh $RUN_ID" >&2
    exit 1
fi

if ! RESPONSE="$(codex_mcp_wait_response "$OUT_FILE" "$REQ_ID" "$TIMEOUT_S")"; then
    echo "No reply within ${TIMEOUT_S}s. The turn may still be running; check activity with:
  codex-mcp-status.sh $RUN_ID
then re-read the reply later from $OUT_FILE (JSON-RPC id $REQ_ID)." >&2
    exit 1
fi

RPC_ERROR="$(printf '%s' "$RESPONSE" | jq -r '.error.message // empty')"
if [[ -n "$RPC_ERROR" ]]; then
    echo "MCP error: $RPC_ERROR" >&2
    exit 1
fi

NEW_THREAD_ID="$(printf '%s' "$RESPONSE" | jq -r '.result.structuredContent.threadId // empty')"
CONTENT="$(printf '%s' "$RESPONSE" | jq -r '.result.structuredContent.content // ([.result.content[]? | select(.type == "text") | .text] | join("\n"))')"

# The codex MCP tools report turn failures as normal results whose content
# carries the error text (isError is not always set), e.g. "Session not
# found". Detect the known fatal shapes instead of archiving them as replies.
if printf '%s' "$CONTENT" | grep -qE '^(Session not found|error: |ERROR: )'; then
    echo "Turn failed: $CONTENT" >&2
    exit 1
fi

if [[ -n "$NEW_THREAD_ID" ]]; then
    codex_review_set_meta_field "$RUN_ID" thread_id "$NEW_THREAD_ID"
fi
if [[ -n "$EFFORT" ]]; then
    codex_review_set_meta_field "$RUN_ID" effort "$EFFORT"
fi
TURN_COUNT="$(codex_review_get_meta_field "$RUN_ID" turn_count 0)"
codex_review_set_meta_field "$RUN_ID" turn_count "$((TURN_COUNT + 1))" number
codex_review_update_timestamp "$RUN_ID"

STAMP="$(codex_review_unix_ts)"
TURN_FILE="$CONV_DIR/turn-$(printf '%03d' "$((TURN_COUNT + 1))")-req${REQ_ID}.md"
{
    echo "# Turn $((TURN_COUNT + 1)) ($STAMP, request id $REQ_ID, thread ${NEW_THREAD_ID:-$THREAD_ID})"
    if [[ "$OPENING_TURN" == "true" ]]; then
        if [[ -n "$EFFORT" ]]; then
            echo "effort: $EFFORT"
        fi
        if [[ -n "${EFFECTIVE_MODEL:-}" ]]; then
            echo "model: $EFFECTIVE_MODEL"
        fi
        if [[ ${#CONFIG_KVS[@]} -gt 0 ]]; then
            for kv in "${CONFIG_KVS[@]}"; do
                echo "config: $kv"
            done
        fi
    fi
    echo
    echo "## Prompt"
    echo
    printf '%s\n' "$FULL_PROMPT"
    echo
    echo "## Reply"
    echo
    printf '%s\n' "$CONTENT"
} > "$TURN_FILE"

printf '%s\n' "$CONTENT"
