#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_helpers.sh"

codex_review_require_cmds

usage() {
    cat <<'EOF'
Usage: codex-exec-status.sh [run_id|--last] [--json] [--wedge-secs N] [--quiet-secs N] [--stall-secs N]

Liveness and progress for an exec worker run. Without a run_id (or with
--last), the most recent exec run. The verdict answers the coordinator's real
question, is the worker actually working:

  running    pid alive, session exists, and the event log is fresh
  quiet      pid alive, session exists, the event log is idle past the quiet
             window (default 180s), and network or child command activity is
             visible
  wedged     pid alive but no codex session appeared within the wedge window
             (default 180s): the classic startup hang. Kill and relaunch.
  stalled    pid alive but the event log is idle with no network connection
             and no child command, or has passed the stall window (default
             1200s). Inspect the log tail; stop and relaunch.
  dead       meta says running but the process is gone: crashed or was killed
             without recording completion. Check the log tail.
  completed / failed / stopped   terminal states from the run metadata.

"Process running" is NOT "working"; that is exactly the gap wedged/stalled
close. --json emits one machine-readable object for automation.
EOF
}

RUN_ID=""
JSON="false"
WEDGE_S=180
QUIET_S=180
STALL_S=1200

while [[ $# -gt 0 ]]; do
    case "$1" in
        --json) JSON="true"; shift ;;
        --last|-l) RUN_ID=""; shift ;;
        --wedge-secs) [[ $# -lt 2 ]] && { echo "--wedge-secs requires a number" >&2; exit 1; }; WEDGE_S="$2"; shift 2 ;;
        --quiet-secs) [[ $# -lt 2 ]] && { echo "--quiet-secs requires a number" >&2; exit 1; }; QUIET_S="$2"; shift 2 ;;
        --stall-secs) [[ $# -lt 2 ]] && { echo "--stall-secs requires a number" >&2; exit 1; }; STALL_S="$2"; shift 2 ;;
        --help|-h) usage; exit 0 ;;
        -*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
        *) RUN_ID="$1"; shift ;;
    esac
done

if ! [[ "$WEDGE_S" =~ ^[0-9]+$ && "$QUIET_S" =~ ^[0-9]+$ && "$STALL_S" =~ ^[0-9]+$ ]]; then
    echo "--wedge-secs, --quiet-secs, and --stall-secs must be whole seconds." >&2
    exit 1
fi

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
    echo "Run $RUN_ID is a $KIND run, not an exec worker. Use codex-review-status.sh or codex-mcp-status.sh." >&2
    exit 1
fi

codex_emit_status "$RUN_ID" "$JSON" "$WEDGE_S" "$QUIET_S" "$STALL_S"
