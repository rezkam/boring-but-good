#!/bin/bash
# Get sync history for an ArgoCD application
# Usage: argocd-app-history.sh <app-name> [--project PROJECT]
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
    echo "  Show sync/deploy history for an application." >&2
    exit 1
fi

QUERY=""
[ -n "$PROJECT" ] && QUERY="?project=${PROJECT}"

RESULT=$(argocd_get "/api/v1/applications/${APP}${QUERY}")
echo "$RESULT" | jq -r '
    if (.status.history // [] | length) == 0 then
        "No sync history found for \(.metadata.name)."
    else
        "Sync history for \(.metadata.name):",
        "",
        ["ID", "REVISION", "DEPLOYED_AT", "SOURCE"],
        (.status.history | reverse | .[] | [
            (.id | tostring),
            (.revision // "N/A" | if length > 12 then .[0:12] else . end),
            (.deployedAt // "N/A"),
            (.source.repoURL // "N/A")
        ]) | @tsv
    end
' | column -t -s $'\t'
