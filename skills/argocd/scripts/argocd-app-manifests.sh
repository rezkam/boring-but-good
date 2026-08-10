#!/bin/bash
# Get rendered manifests for an ArgoCD application
# Usage: argocd-app-manifests.sh <app-name> [--project PROJECT]
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
    echo "  Get the rendered Kubernetes manifests for an application." >&2
    exit 1
fi

QUERY=""
[ -n "$PROJECT" ] && QUERY="?project=${PROJECT}"

RESULT=$(argocd_get "/api/v1/applications/${APP}/manifests${QUERY}")
echo "$RESULT" | jq -r '
    if (.manifests // [] | length) == 0 then
        "No manifests found for application."
    else
        .manifests[] | fromjson | "---\n" + (. | tostring | @text)
    end
' 2>/dev/null || echo "$RESULT" | jq '.'
