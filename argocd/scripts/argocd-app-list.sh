#!/bin/bash
# List ArgoCD applications
# Usage: argocd-app-list.sh [--project PROJECT] [--repo REPO]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

PROJECT="" REPO=""
while [ $# -gt 0 ]; do
    case "$1" in
        --project) PROJECT="$2"; shift 2 ;;
        --repo)    REPO="$2"; shift 2 ;;
        *)         echo "Usage: $0 [--project PROJECT] [--repo REPO]" >&2; exit 1 ;;
    esac
done

QUERY=""
[ -n "$PROJECT" ] && QUERY="${QUERY}&projects=${PROJECT}"
[ -n "$REPO" ]    && QUERY="${QUERY}&repo=${REPO}"
QUERY="${QUERY#&}"
[ -n "$QUERY" ] && QUERY="?${QUERY}"

RESULT=$(argocd_get "/api/v1/applications${QUERY}")
echo "$RESULT" | jq -r '
    .items // [] | if length == 0 then "No applications found."
    else
        ["NAME", "PROJECT", "SYNC", "HEALTH", "REPO"],
        (.[] | [
            .metadata.name,
            (.spec.project // "default"),
            (.status.sync.status // "Unknown"),
            (.status.health.status // "Unknown"),
            (.spec.source.repoURL // .spec.sources[0].repoURL // "N/A")
        ]) | @tsv
    end
' | column -t -s $'\t'
