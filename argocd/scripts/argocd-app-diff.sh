#!/bin/bash
# Show diff between live and desired state for an ArgoCD application
# Usage: argocd-app-diff.sh <app-name> [--project PROJECT]
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
    echo "  Show resources that differ between live and desired state." >&2
    exit 1
fi

QUERY=""
[ -n "$PROJECT" ] && QUERY="?project=${PROJECT}"

RESULT=$(argocd_get "/api/v1/applications/${APP}/managed-resources${QUERY}")
echo "$RESULT" | jq -r '
    .items // [] |
    map(select(.diff // null | . != null and . != "" and . != "{}")) |
    if length == 0 then
        "No differences found — live state matches desired state."
    else
        .[] |
        "--- \(.kind)/\(.name) (namespace: \(.namespace // "cluster-scoped"))",
        "    Group:   \(.group // "core")",
        "    Status:  \(.status // "Unknown")",
        "    Health:  \(.health.status // "Unknown")",
        if .diff then
            "    Diff:",
            (.diff | split("\n") | .[] | "      \(.)")
        else empty end,
        ""
    end
'
