#!/bin/bash
# Rollback an ArgoCD application to a previous sync revision
# Usage: argocd-app-rollback.sh <app-name> <history-id> [--project PROJECT]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

APP="" HISTORY_ID="" PROJECT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --project) PROJECT="$2"; shift 2 ;;
        -*)        echo "Usage: $0 <app-name> <history-id> [--project PROJECT]" >&2; exit 1 ;;
        *)
            if [ -z "$APP" ]; then
                APP="$1"
            elif [ -z "$HISTORY_ID" ]; then
                HISTORY_ID="$1"
            fi
            shift ;;
    esac
done

if [ -z "$APP" ] || [ -z "$HISTORY_ID" ]; then
    echo "Usage: $0 <app-name> <history-id> [--project PROJECT]" >&2
    echo "  Rollback to a previous sync. Get history IDs from argocd-app-history.sh." >&2
    exit 1
fi

QUERY=""
[ -n "$PROJECT" ] && QUERY="?project=${PROJECT}"

BODY='{"id":"'"${HISTORY_ID}"'"}'
RESULT=$(argocd_post "/api/v1/applications/${APP}/rollback${QUERY}" "$BODY")
echo "$RESULT" | jq -r '
    "Rollback triggered for: \(.metadata.name // "'"${APP}"'")",
    "",
    "Operation:",
    "  Phase:   \(.status.operationState.phase // "Pending")",
    "  Message: \(.status.operationState.message // "Rollback initiated")",
    "",
    "Use argocd-app-wait.sh '"${APP}"' to watch progress."
'
