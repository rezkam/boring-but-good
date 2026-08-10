#!/bin/bash
# Get ArgoCD application details
# Usage: argocd-app-get.sh <app-name> [--project PROJECT]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

APP="" PROJECT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --project) PROJECT="$2"; shift 2 ;;
        -*)        echo "Usage: $0 <app-name> [--project PROJECT]" >&2; exit 1 ;;
        *)         APP="$1"; shift ;;
    esac
done

if [ -z "$APP" ]; then
    echo "Usage: $0 <app-name> [--project PROJECT]" >&2
    echo "  Get detailed status of an ArgoCD application." >&2
    exit 1
fi

QUERY=""
[ -n "$PROJECT" ] && QUERY="?project=${PROJECT}"

RESULT=$(argocd_get "/api/v1/applications/${APP}${QUERY}")
echo "$RESULT" | jq -r '
    "Application: \(.metadata.name)",
    "Project:     \(.spec.project // "default")",
    "Repo:        \(.spec.source.repoURL // .spec.sources[0].repoURL // "N/A")",
    "Path:        \(.spec.source.path // .spec.sources[0].path // "N/A")",
    "Target Rev:  \(.spec.source.targetRevision // .spec.sources[0].targetRevision // "N/A")",
    "Destination: \(.spec.destination.server // "N/A") / \(.spec.destination.namespace // "N/A")",
    "",
    "Sync Status:   \(.status.sync.status // "Unknown")",
    "Health Status:  \(.status.health.status // "Unknown")",
    "Sync Revision:  \(.status.sync.revision // "N/A")",
    "",
    if (.status.conditions // [] | length) > 0 then
        "Conditions:",
        (.status.conditions[] | "  - [\(.type)] \(.message)")
    else empty end,
    if (.status.operationState // null) != null then
        "",
        "Last Operation: \(.status.operationState.operation.sync.revision // "N/A")",
        "  Phase:   \(.status.operationState.phase // "N/A")",
        "  Message: \(.status.operationState.message // "N/A")",
        "  Started: \(.status.operationState.startedAt // "N/A")",
        "  Finished: \(.status.operationState.finishedAt // "N/A")"
    else empty end
'
