#!/bin/bash
# Get resource tree for an ArgoCD application
# Usage: argocd-app-resources.sh <app-name> [--project PROJECT]
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
    echo "  Show the resource tree (Kubernetes resources) managed by the app." >&2
    exit 1
fi

QUERY=""
[ -n "$PROJECT" ] && QUERY="?project=${PROJECT}"

RESULT=$(argocd_get "/api/v1/applications/${APP}/resource-tree${QUERY}")
echo "$RESULT" | jq -r '
    if (.nodes // [] | length) == 0 then
        "No resources found."
    else
        ["KIND", "NAME", "NAMESPACE", "STATUS", "HEALTH", "VERSION"],
        (.nodes | sort_by(.kind, .name) | .[] | [
            .kind,
            .name,
            (.namespace // "-"),
            (.status // "-"),
            (.health.status // "-"),
            (.version // "-")
        ]) | @tsv
    end
' | column -t -s $'\t'
