#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_helpers.sh"

codex_review_require_cmds

usage() {
    cat <<'EOF'
Usage: codex-status.sh [run_id|--last] [--json] [--wedge-secs N] [--quiet-secs N] [--stall-secs N]

Liveness and progress for any Codex skill run. Without a run_id (or with
--last), uses the most recent run of any kind.

Verdicts:
  running    pid alive and healthy for this run kind
  quiet      exec/review pid alive, session exists, log is idle, and network
             or child command activity is visible
  waiting    App Server has a reverse request that needs a response
  wedged     exec/review pid alive but no codex session appeared in time
  stalled    exec/review pid alive but no network or command activity is
             visible while the log is idle, or the stall window was reached
  dead       meta says non-terminal but the process is gone
  completed / failed / stopped   terminal states from run metadata

MCP servers are allowed to be idle: a live MCP pid is running, not stalled.
--json emits one machine-readable object for automation.
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

if ! RUN_ID="$(codex_resolve_run_id "$RUN_ID" any)" || [[ -z "$RUN_ID" ]]; then
    echo "No run found." >&2
    exit 1
fi

codex_emit_status "$RUN_ID" "$JSON" "$WEDGE_S" "$QUIET_S" "$STALL_S"
