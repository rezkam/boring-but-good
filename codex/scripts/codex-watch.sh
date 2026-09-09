#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_helpers.sh"

codex_review_require_cmds

usage() {
    cat <<'EOF'
Usage: codex-watch.sh <run_id|--last> [--interval N] [--json] [--heartbeat] [--timeout N]

Poll codex-status.sh and print one line for each verdict transition,
including the initial verdict. Exits 0 for completed or stopped, 2 for
failed, 3 for dead, and 4 for timeout.

Options:
  --heartbeat   Print a heartbeat line on polls where the verdict did not
                change. With --json, print the full status JSON every poll.
EOF
}

RUN_ID=""
USE_LAST="false"
JSON="false"
HEARTBEAT="false"
INTERVAL=15
TIMEOUT=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --interval) [[ $# -lt 2 ]] && { echo "--interval requires a number" >&2; exit 1; }; INTERVAL="$2"; shift 2 ;;
        --timeout) [[ $# -lt 2 ]] && { echo "--timeout requires a number" >&2; exit 1; }; TIMEOUT="$2"; shift 2 ;;
        --json) JSON="true"; shift ;;
        --heartbeat) HEARTBEAT="true"; shift ;;
        --last|-l) USE_LAST="true"; RUN_ID=""; shift ;;
        --help|-h) usage; exit 0 ;;
        -*)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
        *)
            if [[ "$USE_LAST" == "true" || -n "$RUN_ID" ]]; then
                echo "Unexpected argument: $1" >&2
                usage >&2
                exit 1
            fi
            RUN_ID="$1"
            shift
            ;;
    esac
done

if [[ "$USE_LAST" != "true" && -z "$RUN_ID" ]]; then
    echo "No run id given." >&2
    usage >&2
    exit 1
fi

if ! [[ "$INTERVAL" =~ ^[0-9]+$ ]]; then
    echo "--interval must be a whole number." >&2
    exit 1
fi
if [[ "$INTERVAL" -eq 0 ]]; then
    echo "--interval must be greater than zero." >&2
    exit 1
fi
if ! [[ "$TIMEOUT" =~ ^[0-9]+$ ]]; then
    echo "--timeout must be a whole number." >&2
    exit 1
fi

load_status() {
    local out
    if [[ -n "$RUN_ID" ]]; then
        if ! out="$("$SCRIPT_DIR/codex-status.sh" "$RUN_ID" --json 2>&1)"; then
            printf '%s\n' "$out" >&2
            return 1
        fi
    else
        if ! out="$("$SCRIPT_DIR/codex-status.sh" --json 2>&1)"; then
            printf '%s\n' "$out" >&2
            return 1
        fi
    fi
    printf '%s\n' "$out"
}

emit_transition() {
    local status_json="$1"
    local timestamp run_id kind verdict advice
    if [[ "$JSON" == "true" ]]; then
        printf '%s\n' "$status_json" | jq -c '.'
        return
    fi

    timestamp="$(codex_review_timestamp)"
    run_id="$(printf '%s' "$status_json" | jq -r '.run_id')"
    kind="$(printf '%s' "$status_json" | jq -r '.kind')"
    verdict="$(printf '%s' "$status_json" | jq -r '.verdict')"
    advice="$(printf '%s' "$status_json" | jq -r '.advice // ""')"

    printf '%s %s %s verdict=%s' "$timestamp" "$run_id" "$kind" "$verdict"
    [[ -n "$advice" ]] && printf ' advice=%s' "$advice"
    printf '\n'
}

emit_heartbeat() {
    local status_json="$1"
    local timestamp run_id kind verdict event_count log_age_s
    if [[ "$JSON" == "true" ]]; then
        printf '%s\n' "$status_json" | jq -c '.'
        return
    fi

    timestamp="$(codex_review_timestamp)"
    run_id="$(printf '%s' "$status_json" | jq -r '.run_id')"
    kind="$(printf '%s' "$status_json" | jq -r '.kind')"
    verdict="$(printf '%s' "$status_json" | jq -r '.verdict')"
    event_count="$(printf '%s' "$status_json" | jq -r '.event_count')"
    log_age_s="$(printf '%s' "$status_json" | jq -r '.log_age_s')"

    printf '%s %s %s verdict=%s events=%s log_idle=%ss heartbeat\n' "$timestamp" "$run_id" "$kind" "$verdict" "$event_count" "$log_age_s"
}

emit_timeout() {
    local status_json="$1"
    local timestamp run_id kind verdict advice
    if [[ "$JSON" == "true" ]]; then
        printf '%s\n' "$status_json" | jq -c --argjson timeout_s "$TIMEOUT" '. + {timeout: true, timeout_s: $timeout_s}'
        return
    fi

    timestamp="$(codex_review_timestamp)"
    run_id="$(printf '%s' "$status_json" | jq -r '.run_id')"
    kind="$(printf '%s' "$status_json" | jq -r '.kind')"
    verdict="$(printf '%s' "$status_json" | jq -r '.verdict')"
    advice="$(printf '%s' "$status_json" | jq -r '.advice // ""')"

    printf '%s %s %s timeout=%ss verdict=%s' "$timestamp" "$run_id" "$kind" "$TIMEOUT" "$verdict"
    [[ -n "$advice" ]] && printf ' advice=%s' "$advice"
    printf '\n'
}

START_S="$(codex_review_unix_ts)"
LAST_VERDICT=""
STATUS_JSON=""

while true; do
    STATUS_JSON="$(load_status)"
    if [[ -z "$RUN_ID" ]]; then
        RUN_ID="$(printf '%s' "$STATUS_JSON" | jq -r '.run_id')"
    fi

    VERDICT="$(printf '%s' "$STATUS_JSON" | jq -r '.verdict')"
    if [[ "$VERDICT" != "$LAST_VERDICT" ]]; then
        emit_transition "$STATUS_JSON"
        LAST_VERDICT="$VERDICT"
    elif [[ "$HEARTBEAT" == "true" ]]; then
        emit_heartbeat "$STATUS_JSON"
    fi

    case "$VERDICT" in
        completed|stopped) exit 0 ;;
        failed) exit 2 ;;
        dead) exit 3 ;;
        running|quiet|waiting|stalled|wedged) ;;
    esac

    if [[ "$TIMEOUT" -gt 0 ]]; then
        NOW="$(codex_review_unix_ts)"
        ELAPSED=$((NOW - START_S))
        if [[ "$ELAPSED" -ge "$TIMEOUT" ]]; then
            emit_timeout "$STATUS_JSON"
            exit 4
        fi
        SLEEP_FOR="$INTERVAL"
        REMAINING=$((TIMEOUT - ELAPSED))
        if [[ "$REMAINING" -lt "$SLEEP_FOR" ]]; then
            SLEEP_FOR="$REMAINING"
        fi
        sleep "$SLEEP_FOR"
    else
        sleep "$INTERVAL"
    fi
done
