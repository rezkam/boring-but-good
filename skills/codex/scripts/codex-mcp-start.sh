#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_helpers.sh"

codex_review_require_cmds

usage() {
    cat <<'EOF'
Usage: codex-mcp-start.sh [options]

Start a persistent `codex mcp-server` process for non-interactive multi-turn
conversation (review discussion, adversarial back-and-forth, Q&A about a
repository). The server stays alive across shell calls; send turns with
codex-mcp-send.sh and shut it down with codex-mcp-stop.sh.

Options:
  --workdir <path>     Working directory for conversations (default: cwd).
                       Sent as `cwd` on the first turn of each thread.
  --model <name>       Model override for turns started on this server
  --effort <value>     Reasoning effort: minimal, low, medium, high, xhigh
  --sandbox <mode>     read-only (default), workspace-write, danger-full-access
  --title <text>       Label shown in list/status output
  --config <k=v>       Server-level codex -c override (repeatable),
                       e.g. --config model_reasoning_effort=low
  --help               Show this message

Prints a run_id. All turn responses and the raw JSON-RPC stream are kept
under the run directory.
EOF
}

WORKDIR="$(pwd)"
MODEL=""
EFFORT=""
SANDBOX="read-only"
TITLE=""
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
        --workdir)
            [[ $# -lt 2 ]] && { echo "--workdir requires a value" >&2; exit 1; }
            WORKDIR="$2"
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
        --sandbox)
            [[ $# -lt 2 ]] && { echo "--sandbox requires a value" >&2; exit 1; }
            SANDBOX="$2"
            shift 2
            ;;
        --title)
            [[ $# -lt 2 ]] && { echo "--title requires a value" >&2; exit 1; }
            TITLE="$2"
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
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

case "$SANDBOX" in
    read-only|workspace-write|danger-full-access)
        ;;
    *)
        echo "Unknown sandbox '$SANDBOX'. Use read-only, workspace-write, or danger-full-access." >&2
        exit 1
        ;;
esac

if [[ ! -d "$WORKDIR" ]]; then
    echo "Workdir not found: $WORKDIR" >&2
    exit 1
fi
WORKDIR="$(cd "$WORKDIR" && pwd)"

RUN_ID="$(codex_review_new_run_id)"
RUN_DIR="$(codex_review_run_dir "$RUN_ID")"
FIFO="$RUN_DIR/mcp.in"
OUT_FILE="$RUN_DIR/server.jsonl"
ERR_FILE="$RUN_DIR/server.err"
CONV_DIR="$RUN_DIR/conversations"
mkdir -p "$RUN_DIR" "$CONV_DIR"
: > "$OUT_FILE"
: > "$ERR_FILE"

codex_mcp_create_meta "$RUN_ID" "$WORKDIR" "$TITLE" "$MODEL" "$SANDBOX" "$FIFO" "$OUT_FILE" "$ERR_FILE" "$CONV_DIR"
if [[ -n "$EFFORT" ]]; then
    codex_review_set_meta_field "$RUN_ID" effort "$EFFORT"
fi

mkfifo "$FIFO"

# 0<> is the load-bearing detail: the server opens its own stdin FIFO
# read-write, so it never sees EOF when a short-lived send script closes its
# write end. With a plain 0< redirect the server exits after the first
# writer disconnects (verified live on codex-cli 0.142.5).
nohup bash -c 'fifo="$1"; out="$2"; err="$3"; shift 3; exec codex mcp-server "$@" 0<> "$fifo" >> "$out" 2>> "$err"' \
    codex-mcp-server "$FIFO" "$OUT_FILE" "$ERR_FILE" ${CONFIG_FLAGS[@]+"${CONFIG_FLAGS[@]}"} \
    >/dev/null 2>&1 &
SERVER_PID=$!
codex_review_set_meta_field "$RUN_ID" pid "$SERVER_PID" number

fail_start() {
    codex_review_update_status "$RUN_ID" "failed" 1
    kill "$SERVER_PID" 2>/dev/null || true
    echo "$1" >&2
    echo "Server stderr tail:" >&2
    tail -n 5 "$ERR_FILE" >&2 || true
    exit 1
}

# Opening a FIFO for writing blocks until a reader exists. The server is the
# reader; if it died at startup the write would hang forever, so every write
# is timeout-guarded and checks the pid first.
write_fifo() {
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        fail_start "codex mcp-server process died during startup."
    fi
    if ! timeout 10 bash -c 'printf "%s\n" "$2" > "$1"' _ "$FIFO" "$1"; then
        fail_start "Timed out writing to the server FIFO (server not reading stdin)."
    fi
}

# MCP handshake: initialize (id 1), initialized notification, tools/list
# (id 2). The handshake doubles as the health check: a server that cannot
# answer tools/list with the codex + codex-reply tools is useless for turns.
write_fifo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"codex-skill","version":"1.0.0"}}}'
if ! codex_mcp_wait_response "$OUT_FILE" 1 20 >/dev/null; then
    fail_start "codex mcp-server did not answer the MCP initialize request within 20s."
fi
write_fifo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
write_fifo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
TOOLS_RESPONSE="$(codex_mcp_wait_response "$OUT_FILE" 2 20)" \
    || fail_start "codex mcp-server did not answer tools/list within 20s."

for tool in codex codex-reply; do
    if ! printf '%s' "$TOOLS_RESPONSE" | jq -e --arg t "$tool" '.result.tools[] | select(.name == $t)' >/dev/null; then
        fail_start "codex mcp-server does not expose the '$tool' tool; cannot run conversations."
    fi
done

codex_review_set_meta_field "$RUN_ID" status "ready"
codex_review_update_timestamp "$RUN_ID"

cat <<EOF
run_id: $RUN_ID
status: ready
kind: mcp-server
pid: $SERVER_PID
workdir: $WORKDIR
sandbox: $SANDBOX${MODEL:+
model: $MODEL}
server_out: $OUT_FILE
server_err: $ERR_FILE

Send a turn (first turn starts the conversation thread):
  $SCRIPT_DIR/codex-mcp-send.sh $RUN_ID "Your prompt"

Check server and conversation state:
  $SCRIPT_DIR/codex-mcp-status.sh $RUN_ID

Stop the server when done:
  $SCRIPT_DIR/codex-mcp-stop.sh $RUN_ID
EOF
