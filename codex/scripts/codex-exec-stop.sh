#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_helpers.sh"

codex_review_require_cmds

usage() {
    cat <<'EOF'
Usage: codex-exec-stop.sh [run_id|--last]

Stop a running exec worker. Without a run_id (or with --last), stops the most
recent exec run. The run stays in the list as `stopped` with its log and any
partial work in the tree; the codex thread remains resumable via
`codex exec resume`.
EOF
}

RUN_ID=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --last|-l) RUN_ID=""; shift ;;
        --help|-h) usage; exit 0 ;;
        *) RUN_ID="$1"; shift ;;
    esac
done

if ! RUN_ID="$(codex_resolve_run_id "$RUN_ID" exec)" || [[ -z "$RUN_ID" ]]; then
    echo "No exec run found." >&2
    exit 1
fi

META_FILE="$(codex_review_meta_file "$RUN_ID")"
if [[ ! -f "$META_FILE" ]]; then
    echo "Metadata missing for run $RUN_ID" >&2
    exit 1
fi
KIND="$(jq -r '.kind // "review"' "$META_FILE")"
if [[ "$KIND" != "exec" ]]; then
    echo "Run $RUN_ID is a $KIND run, not an exec worker." >&2
    exit 1
fi

PID="$(codex_review_get_meta_field "$RUN_ID" pid)"
THREAD_ID="$(codex_review_get_meta_field "$RUN_ID" thread_id)"

if [[ -n "$PID" && "$PID" != "null" ]] && kill -0 "$PID" 2>/dev/null; then
    # The recorded pid is the wrapper subshell; TERM its whole process group
    # would be nicer, but codex runs as its child, so kill the tree.
    pkill -TERM -P "$PID" 2>/dev/null || true
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 10); do
        kill -0 "$PID" 2>/dev/null || break
        sleep 0.5
    done
    if kill -0 "$PID" 2>/dev/null; then
        pkill -KILL -P "$PID" 2>/dev/null || true
        kill -9 "$PID" 2>/dev/null || true
    fi
    echo "Stopped exec worker $RUN_ID (pid $PID). Partial changes may be in the tree; review them before relaunching."
else
    echo "Exec worker $RUN_ID was not running."
fi

codex_review_update_status "$RUN_ID" "stopped" 0

if [[ -n "$THREAD_ID" && "$THREAD_ID" != "null" ]]; then
    echo "Session $THREAD_ID is preserved. Continue it with:"
    echo "  codex exec resume $THREAD_ID \"<your prompt>\""
fi
