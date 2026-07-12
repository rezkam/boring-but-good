#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_helpers.sh"

codex_review_require_cmds

usage() {
    cat <<'EOF'
Usage: codex-delete.sh <run_id> [run_id...] [--force]
       codex-delete.sh --last [--force]
       codex-delete.sh --all [--force]

Delete run directories (metadata, logs, reports, archived turns) from the
skill's run store. Works on both review and mcp runs.

A run with a live process (an MCP server, or a review still running) is
refused unless --force, which stops the process first. Deleting a run does
NOT delete the underlying codex thread: transcripts live in ~/.codex/sessions
and stay resumable with `codex exec resume <thread_id>` if you saved the id.

  --last   delete the most recent run (any kind)
  --all    delete every run; live runs are skipped unless --force
  --force  stop live processes and delete anyway
EOF
}

RUN_IDS=()
USE_LAST="false"
USE_ALL="false"
FORCE="false"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --last|-l) USE_LAST="true"; shift ;;
        --all) USE_ALL="true"; shift ;;
        --force|-f) FORCE="true"; shift ;;
        --help|-h) usage; exit 0 ;;
        -*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
        *) RUN_IDS+=("$1"); shift ;;
    esac
done

if [[ "$USE_ALL" == "true" ]]; then
    if [[ ${#RUN_IDS[@]} -gt 0 || "$USE_LAST" == "true" ]]; then
        echo "--all cannot be combined with run ids or --last." >&2
        exit 1
    fi
    while IFS= read -r dir; do
        RUN_IDS+=("$(basename "$dir")")
    done < <(find "$REVIEW_RUNS_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)
    if [[ ${#RUN_IDS[@]} -eq 0 ]]; then
        echo "No runs to delete."
        exit 0
    fi
elif [[ "$USE_LAST" == "true" ]]; then
    if [[ ${#RUN_IDS[@]} -gt 0 ]]; then
        echo "--last cannot be combined with explicit run ids." >&2
        exit 1
    fi
    if ! LAST_ID="$(codex_review_latest_run_id)"; then
        echo "No runs found." >&2
        exit 1
    fi
    RUN_IDS=("$LAST_ID")
elif [[ ${#RUN_IDS[@]} -eq 0 ]]; then
    echo "No run id given. Pass run ids, --last, or --all." >&2
    usage >&2
    exit 1
fi

# Kill a pid politely, then hard. Mirrors codex-mcp-stop.sh.
stop_pid() {
    local pid="$1"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do
        kill -0 "$pid" 2>/dev/null || return 0
        sleep 0.5
    done
    kill -9 "$pid" 2>/dev/null || true
}

REFUSED=0
DELETED=0

for RUN_ID in "${RUN_IDS[@]}"; do
    RUN_DIR="$(codex_review_run_dir "$RUN_ID")"
    META_FILE="$(codex_review_meta_file "$RUN_ID")"

    if [[ ! -d "$RUN_DIR" ]]; then
        echo "Run $RUN_ID not found." >&2
        REFUSED=$((REFUSED + 1))
        continue
    fi

    if [[ ! -f "$META_FILE" ]]; then
        # Broken run dir with no metadata: nothing can be alive that we know
        # how to check, just remove it.
        rm -rf "$RUN_DIR"
        echo "Deleted $RUN_ID (no metadata, removed directory)."
        DELETED=$((DELETED + 1))
        continue
    fi

    KIND="$(jq -r '.kind // "review"' "$META_FILE")"
    PID="$(codex_review_get_meta_field "$RUN_ID" pid)"
    STATUS="$(codex_review_get_meta_field "$RUN_ID" status)"
    THREAD_ID="$(codex_review_get_meta_field "$RUN_ID" thread_id)"

    ALIVE="false"
    if [[ -n "$PID" && "$PID" != "null" ]] && kill -0 "$PID" 2>/dev/null; then
        ALIVE="true"
    fi

    if [[ "$ALIVE" == "true" && "$FORCE" != "true" ]]; then
        if [[ "$KIND" == "mcp" ]]; then
            echo "Run $RUN_ID is a live MCP server (pid $PID). Stop it with codex-mcp-stop.sh $RUN_ID, or pass --force." >&2
        elif [[ "$KIND" == "exec" ]]; then
            echo "Run $RUN_ID is a live exec worker (pid $PID, status $STATUS). Stop it with codex-exec-stop.sh $RUN_ID, or pass --force." >&2
        else
            echo "Run $RUN_ID is a review still running (pid $PID, status $STATUS). Wait for it, or pass --force." >&2
        fi
        REFUSED=$((REFUSED + 1))
        continue
    fi

    if [[ "$ALIVE" == "true" ]]; then
        stop_pid "$PID"
        echo "Stopped live $KIND process (pid $PID) for $RUN_ID."
    fi

    if [[ "$KIND" == "mcp" ]]; then
        FIFO="$(codex_review_get_meta_field "$RUN_ID" fifo)"
        [[ -p "$FIFO" ]] && rm -f "$FIFO"
    fi

    rm -rf "$RUN_DIR"
    DELETED=$((DELETED + 1))
    if [[ -n "$THREAD_ID" && "$THREAD_ID" != "null" ]]; then
        echo "Deleted $RUN_ID ($KIND). Codex thread $THREAD_ID stays on disk; resume with: codex exec resume $THREAD_ID \"<prompt>\""
    else
        echo "Deleted $RUN_ID ($KIND)."
    fi
done

echo "deleted: $DELETED, refused: $REFUSED"
(( REFUSED == 0 )) || exit 1
exit 0
