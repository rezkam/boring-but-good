#!/bin/bash
# Wait for an ArgoCD application to finish syncing and become healthy
# Usage: argocd-app-wait.sh <app-name> [--timeout SECONDS] [--project PROJECT]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

APP="" TIMEOUT=300 PROJECT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --timeout) TIMEOUT="$2"; shift 2 ;;
        --project) PROJECT="$2"; shift 2 ;;
        -*)        echo "Usage: $0 <app-name> [--timeout SECONDS] [--project PROJECT]" >&2; exit 1 ;;
        *)         APP="$1"; shift ;;
    esac
done

if [ -z "$APP" ]; then
    echo "Usage: $0 <app-name> [--timeout SECONDS] [--project PROJECT]" >&2
    echo "  Wait for sync to complete and app to become healthy." >&2
    echo "  Default timeout: 300 seconds." >&2
    exit 1
fi

QUERY=""
[ -n "$PROJECT" ] && QUERY="?project=${PROJECT}"

ELAPSED=0
INTERVAL=5

echo "Waiting for ${APP} to sync and become healthy (timeout: ${TIMEOUT}s)..."

while [ $ELAPSED -lt "$TIMEOUT" ]; do
    RESULT=$(argocd_get "/api/v1/applications/${APP}${QUERY}")

    SYNC=$(echo "$RESULT" | jq -r '.status.sync.status // "Unknown"')
    HEALTH=$(echo "$RESULT" | jq -r '.status.health.status // "Unknown"')
    PHASE=$(echo "$RESULT" | jq -r '.status.operationState.phase // "N/A"')

    printf "\r  [%3ds] Sync: %-12s Health: %-12s Phase: %-12s" "$ELAPSED" "$SYNC" "$HEALTH" "$PHASE"

    # Check if operation finished
    if [ "$PHASE" = "Failed" ] || [ "$PHASE" = "Error" ]; then
        echo ""
        MSG=$(echo "$RESULT" | jq -r '.status.operationState.message // "No details"')
        echo "FAILED: Operation ${PHASE}: ${MSG}" >&2
        exit 1
    fi

    if [ "$SYNC" = "Synced" ] && [ "$HEALTH" = "Healthy" ]; then
        echo ""
        echo "SUCCESS: ${APP} is Synced and Healthy."
        exit 0
    fi

    sleep "$INTERVAL"
    ELAPSED=$((ELAPSED + INTERVAL))
done

echo ""
echo "TIMEOUT: ${APP} did not reach Synced+Healthy within ${TIMEOUT}s." >&2
echo "  Last state: Sync=${SYNC} Health=${HEALTH} Phase=${PHASE}" >&2
exit 1
