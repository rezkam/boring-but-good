#!/bin/bash
# List ArgoCD clusters
# Usage: argocd-cluster-list.sh
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

RESULT=$(argocd_get "/api/v1/clusters")
echo "$RESULT" | jq -r '
    .items // [] | if length == 0 then "No clusters found."
    else
        ["NAME", "SERVER", "VERSION", "STATUS"],
        (.[] | [
            (.name // "-"),
            .server,
            (.serverVersion // "-"),
            (.info.connectionState.status // "-")
        ]) | @tsv
    end
' | column -t -s $'\t'
