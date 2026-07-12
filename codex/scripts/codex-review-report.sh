#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_helpers.sh"

codex_review_require_cmds

usage() {
    cat <<'EOF'
Usage: codex-review-report.sh <run_id|--last> [--wait]

Wait for completion and print the review report output.

Options:
  --wait    Block until the run is completed
  --help    Show this message
EOF
}

RUN_ID=""
WAIT="false"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --wait)
            WAIT="true"
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
            if [[ -z "$RUN_ID" ]]; then
                RUN_ID="$1"
            fi
            shift
            ;;
    esac
done

if ! RUN_ID="$(codex_resolve_run_id "$RUN_ID" review)" || [[ -z "$RUN_ID" ]]; then
    echo "No review run found." >&2
    exit 1
fi

META_FILE="$(codex_review_meta_file "$RUN_ID")"
if [[ ! -f "$META_FILE" ]]; then
    echo "Metadata missing for run $RUN_ID" >&2
    exit 1
fi

STATUS="$(codex_review_get_meta_field "$RUN_ID" status)"
REPORT_FILE="$(codex_review_get_meta_field "$RUN_ID" report_file)"
PID="$(codex_review_get_meta_field "$RUN_ID" pid)"

if [[ "$WAIT" == "true" && "$STATUS" == "running" ]]; then
    while true; do
        if [[ -n "$PID" && "$PID" != "null" ]] && kill -0 "$PID" 2>/dev/null; then
            sleep 2
            continue
        fi

        STATUS="$(codex_review_get_meta_field "$RUN_ID" status)"
        if [[ "$STATUS" == "running" ]]; then
            if [[ -s "$REPORT_FILE" ]]; then
                STATUS="completed"
            else
                STATUS="$(codex_review_status_from_log "$(codex_review_get_meta_field "$RUN_ID" log_file)" )"
                if [[ "$STATUS" == "running" ]]; then
                    STATUS="failed"
                fi
            fi
            codex_review_set_meta_field "$RUN_ID" status "$STATUS"
        fi

        if [[ "$STATUS" == "running" ]]; then
            sleep 2
            continue
        fi
        break
    done
fi

if [[ ! -f "$REPORT_FILE" ]]; then
    if [[ "$STATUS" == "running" ]]; then
        echo "Review is still running, no final report yet." >&2
        exit 1
    fi
    echo "Report file not found: $REPORT_FILE" >&2
    exit 1
fi

echo "===== Review report for $RUN_ID ====="
cat "$REPORT_FILE"
