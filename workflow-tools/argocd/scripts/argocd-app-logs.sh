#!/bin/bash
# Get logs from an ArgoCD application's pods
# Usage: argocd-app-logs.sh <app-name> [--resource RESOURCE] [--container CONTAINER] [--tail LINES] [--project PROJECT]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

APP="" RESOURCE="" CONTAINER="" TAIL="100" PROJECT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --resource)  RESOURCE="$2"; shift 2 ;;
        --container) CONTAINER="$2"; shift 2 ;;
        --tail)      TAIL="$2"; shift 2 ;;
        --project)   PROJECT="$2"; shift 2 ;;
        -*)          echo "Usage: $0 <app-name> [--resource NAME] [--container NAME] [--tail LINES] [--project PROJECT]" >&2; exit 1 ;;
        *)           APP="$1"; shift ;;
    esac
done

if [ -z "$APP" ]; then
    echo "Usage: $0 <app-name> [--resource NAME] [--container NAME] [--tail LINES] [--project PROJECT]" >&2
    echo "  Get logs from pods in an ArgoCD application." >&2
    echo "  --resource: filter by resource name (e.g. pod name)" >&2
    echo "  --container: filter by container name" >&2
    echo "  --tail: number of lines (default: 100)" >&2
    exit 1
fi

QUERY="tailLines=${TAIL}"
[ -n "$RESOURCE" ]  && QUERY="${QUERY}&resourceName=${RESOURCE}"
[ -n "$CONTAINER" ] && QUERY="${QUERY}&container=${CONTAINER}"
[ -n "$PROJECT" ]   && QUERY="${QUERY}&project=${PROJECT}"

# ArgoCD log endpoint returns newline-delimited JSON
RESULT=$(argocd_get "/api/v1/applications/${APP}/logs?${QUERY}")
echo "$RESULT" | jq -r '
    if .result then
        (if .podName then "[\(.podName)" + (if .content then "/\(.content)" else "" end) + "] " else "" end) +
        (.result.content // .message // "")
    elif .message then
        .message
    else
        tostring
    end
' 2>/dev/null || echo "$RESULT"
