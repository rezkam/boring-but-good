#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_helpers.sh"

codex_review_require_cmds

usage() {
    cat <<'EOF'
Usage: codex-mcp-status.sh [run_id|--last] [--json]

Show the state of an MCP server run: process liveness, conversation thread,
turn count, and recent activity from the codex event stream. Without a
run_id (or with --last), uses the most recent MCP run.
EOF
}

JSON="false"
RUN_ID=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --json)
            JSON="true"
            shift
            ;;
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
    echo "Run $RUN_ID is a review run; use codex-review-status.sh instead." >&2
    exit 1
fi

ALIVE="false"
if codex_mcp_server_alive "$RUN_ID"; then
    ALIVE="true"
fi

if [[ "$JSON" == "true" ]]; then
    jq --arg alive "$ALIVE" '. + {server_alive: ($alive == "true")}' "$META_FILE"
    exit 0
fi

OUT_FILE="$(codex_review_get_meta_field "$RUN_ID" log_file)"
ERR_FILE="$(codex_review_get_meta_field "$RUN_ID" err_file)"

echo "run_id: $RUN_ID"
echo "kind: mcp-server"
echo "status: $(codex_review_get_meta_field "$RUN_ID" status)"
echo "server_alive: $ALIVE"
echo "pid: $(codex_review_get_meta_field "$RUN_ID" pid)"
echo "workdir: $(codex_review_get_meta_field "$RUN_ID" workdir)"
echo "sandbox: $(codex_review_get_meta_field "$RUN_ID" sandbox)"
echo "thread_id: $(codex_review_get_meta_field "$RUN_ID" thread_id '(none yet)')"
echo "turn_count: $(codex_review_get_meta_field "$RUN_ID" turn_count 0)"
TITLE="$(codex_review_get_meta_field "$RUN_ID" title)"
[[ -n "$TITLE" ]] && echo "title: $TITLE"

if [[ -f "$OUT_FILE" ]]; then
    echo
    echo "Recent activity (codex event types):"
    jq -r 'select(type == "object" and .method == "codex/event") | .params.msg.type // empty' "$OUT_FILE" 2>/dev/null | tail -n 12 | sed 's/^/  /' || true
fi
if [[ -s "$ERR_FILE" ]]; then
    echo
    echo "Server stderr tail:"
    tail -n 5 "$ERR_FILE" | sed 's/^/  /'
fi
