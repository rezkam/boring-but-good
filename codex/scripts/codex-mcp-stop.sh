#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_helpers.sh"

codex_review_require_cmds

usage() {
    cat <<'EOF'
Usage: codex-mcp-stop.sh [run_id|--last]

Stop a running codex MCP server. Without a run_id (or with --last), stops the
most recent MCP run. The conversation transcript stays on disk; the thread can
be continued later with `codex exec resume <thread_id>` (a NEW mcp-server
process cannot resume it, the MCP thread registry is per-process).
EOF
}

RUN_ID=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --last|-l)
            RUN_ID=""
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            RUN_ID="$1"
            shift
            ;;
    esac
done

if ! RUN_ID="$(codex_resolve_run_id "$RUN_ID" mcp)" || [[ -z "$RUN_ID" ]]; then
    echo "No MCP server run found." >&2
    exit 1
fi

META_FILE="$(codex_review_meta_file "$RUN_ID")"
if [[ ! -f "$META_FILE" ]]; then
    echo "Metadata missing for run $RUN_ID" >&2
    exit 1
fi
if [[ "$(jq -r '.kind // "review"' "$META_FILE")" != "mcp" ]]; then
    echo "Run $RUN_ID is a review run, not an MCP server." >&2
    exit 1
fi

PID="$(codex_review_get_meta_field "$RUN_ID" pid)"
THREAD_ID="$(codex_review_get_meta_field "$RUN_ID" thread_id)"

if [[ -n "$PID" && "$PID" != "null" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 10); do
        kill -0 "$PID" 2>/dev/null || break
        sleep 0.5
    done
    if kill -0 "$PID" 2>/dev/null; then
        kill -9 "$PID" 2>/dev/null || true
    fi
    echo "Stopped MCP server $RUN_ID (pid $PID)."
else
    echo "MCP server $RUN_ID was not running."
fi

codex_review_update_status "$RUN_ID" "stopped" 0

FIFO="$(codex_review_get_meta_field "$RUN_ID" fifo)"
[[ -p "$FIFO" ]] && rm -f "$FIFO"

if [[ -n "$THREAD_ID" && "$THREAD_ID" != "null" ]]; then
    echo "Conversation thread $THREAD_ID is preserved on disk. Continue it later with:"
    echo "  codex exec resume $THREAD_ID \"<your prompt>\""
fi
