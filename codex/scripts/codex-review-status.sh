#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_helpers.sh"

codex_review_require_cmds

usage() {
    cat <<'EOF'
Usage: codex-review-status.sh [run_id|--last] [--follow]

Show the current status for a Codex review session.

Options:
  --follow   Tail the review stream while it is running
  --json     Output metadata as JSON
  --last     Use most recent session
EOF
}

RUN_ID=""
FOLLOW="false"
OUTPUT_JSON="false"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --follow)
            FOLLOW="true"
            shift
            ;;
        --json)
            OUTPUT_JSON="true"
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

if [[ "$FOLLOW" == "true" ]]; then
    LOG_FILE="$(codex_review_get_meta_field "$RUN_ID" log_file)"
    if [[ -z "$LOG_FILE" || ! -f "$LOG_FILE" ]]; then
        echo "No log file yet for run $RUN_ID" >&2
        exit 1
    fi
    tail -n 40 -f "$LOG_FILE"
    exit 0
fi

codex_skill_reconcile_orphaned_run "$RUN_ID"
STATUS="$(codex_review_get_meta_field "$RUN_ID" status)"
PID="$(codex_review_get_meta_field "$RUN_ID" pid)"
SESSION_ID="$(codex_review_get_meta_field "$RUN_ID" thread_id)"
WORKDIR="$(codex_review_get_meta_field "$RUN_ID" workdir)"
SCOPE="$(codex_review_get_meta_field "$RUN_ID" scope)"
SCOPE_VALUE="$(codex_review_get_meta_field "$RUN_ID" scope_value)"
TITLE="$(codex_review_get_meta_field "$RUN_ID" title)"
PRESET="$(codex_review_get_meta_field "$RUN_ID" preset)"
LOG_FILE="$(codex_review_get_meta_field "$RUN_ID" log_file)"
ERROR_FILE="$(codex_review_get_meta_field "$RUN_ID" error_log)"
REPORT_FILE="$(codex_review_get_meta_field "$RUN_ID" report_file)"
CREATED="$(codex_review_get_meta_field "$RUN_ID" created_at)"
UPDATED="$(codex_review_get_meta_field "$RUN_ID" updated_at)"
EXIT_CODE="$(codex_review_get_meta_field "$RUN_ID" exit_code)"
SESSION_DIR="$(codex_review_get_meta_field "$RUN_ID" session_dir)"
HOST_STATUS="none"
ACTIVE_TURNS=0
PENDING_REQUESTS=0
if [[ -n "$SESSION_DIR" && "$SESSION_DIR" != "null" && -f "$SESSION_DIR/state.json" ]]; then
    HOST_STATUS="$(jq -r '.status // "unknown"' "$SESSION_DIR/state.json")"
    ACTIVE_TURNS="$(jq -r '.activeTurns | length' "$SESSION_DIR/state.json")"
    PENDING_REQUESTS="$(jq -r '.pendingRequests | length' "$SESSION_DIR/state.json")"
fi

if [[ -z "$SESSION_ID" || "$SESSION_ID" == "null" ]]; then
    SESSION_ID="$(codex_review_extract_session_id_from_log "$LOG_FILE" || true)"
    if [[ -z "$SESSION_ID" ]]; then
        SESSION_ID="$(codex_review_extract_thread_id "$LOG_FILE" || true)"
    fi
    if [[ -n "$SESSION_ID" ]]; then
        codex_review_set_meta_field "$RUN_ID" thread_id "$SESSION_ID"
    fi
fi

if [[ "$STATUS" == "running" && -n "$PID" && "$PID" != "null" ]]; then
    if ! kill -0 "$PID" 2>/dev/null; then
        if [[ -s "$REPORT_FILE" ]]; then
            STATUS="completed"
        else
            STATUS="$(codex_review_status_from_log "$LOG_FILE")"
            if [[ "$STATUS" == "running" ]]; then
                STATUS="failed"
            fi
        fi
        codex_review_set_meta_field "$RUN_ID" status "$STATUS"
    fi
fi

if [[ "$OUTPUT_JSON" == "true" ]]; then
    jq -n \
        --arg run_id "$RUN_ID" \
        --arg status "$STATUS" \
        --arg workdir "$WORKDIR" \
        --arg session_id "$SESSION_ID" \
        --arg scope "$SCOPE" \
        --arg scope_value "$SCOPE_VALUE" \
        --arg title "$TITLE" \
        --arg preset "$PRESET" \
        --arg pid "$PID" \
        --arg log_file "$LOG_FILE" \
        --arg error_file "$ERROR_FILE" \
        --arg report_file "$REPORT_FILE" \
        --arg created "$CREATED" \
        --arg updated "$UPDATED" \
        --arg exit_code "$EXIT_CODE" \
        --arg session_dir "$SESSION_DIR" \
        --arg host_status "$HOST_STATUS" \
        --argjson active_turns "$ACTIVE_TURNS" \
        --argjson pending_requests "$PENDING_REQUESTS" \
        '{
            run_id: $run_id,
            status: $status,
            workdir: $workdir,
            session_id: $session_id,
            scope: $scope,
            scope_value: $scope_value,
            title: $title,
            preset: $preset,
            pid: ($pid|if . == "null" or . == "" then null else tonumber end),
            log_file: $log_file,
            error_log: (if $error_file == "" or $error_file == "null" then null else $error_file end),
            report_file: $report_file,
            created_at: ($created | tonumber),
            updated_at: ($updated | tonumber),
            exit_code: ($exit_code | if . == "null" or . == "" then null else tonumber end)
        } + {session_dir: (if $session_dir == "" or $session_dir == "null" then null else $session_dir end), host_status: $host_status, active_turns: $active_turns, pending_requests: $pending_requests}'
    exit 0
fi

LAST_LINES=""
if [[ -f "$LOG_FILE" ]]; then
    LAST_LINES="$(tail -n 20 "$LOG_FILE")"
fi

LAST_SEEN=""
if [[ -n "$LAST_LINES" ]]; then
    LAST_SEEN="$(echo "$LAST_LINES" | tail -n 1)"
fi

printf "run_id: %s\n" "$RUN_ID"
printf "status: %s\n" "$STATUS"
printf "workdir: %s\n" "$WORKDIR"
printf "scope: %s\n" "$SCOPE"
printf "scope_value: %s\n" "${SCOPE_VALUE:-}"
printf "title: %s\n" "${TITLE:-<none>}"
printf "preset: %s\n" "${PRESET:-<none>}"
printf "session_id: %s\n" "${SESSION_ID:-pending}"
printf "pid: %s\n" "${PID:-none}"
printf "app_server: status=%s active_turns=%s pending_requests=%s\n" "$HOST_STATUS" "$ACTIVE_TURNS" "$PENDING_REQUESTS"
printf "created_at: %s\n" "$(date -u -d "@$CREATED" +"%Y-%m-%dT%H:%M:%SZ")"
printf "updated_at: %s\n" "$(date -u -d "@$UPDATED" +"%Y-%m-%dT%H:%M:%SZ")"
printf "exit_code: %s\n" "${EXIT_CODE:-null}"
printf "log_file: %s\n" "$LOG_FILE"
[[ -n "$ERROR_FILE" && "$ERROR_FILE" != "null" ]] && printf "error_log: %s\n" "$ERROR_FILE"
printf "report_file: %s\n" "$REPORT_FILE"
printf "\n"
printf "Recent activity:\n%s\n\n" "${LAST_SEEN:-No activity yet}"

if [[ "$STATUS" == "running" ]]; then
    printf "Session is still running. Run with --follow to stream updates.\n"
fi
