#!/bin/bash
# List ArgoCD repositories
# Usage: argocd-repo-list.sh
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

RESULT=$(argocd_get "/api/v1/repositories")
echo "$RESULT" | jq -r '
    .items // [] | if length == 0 then "No repositories found."
    else
        ["TYPE", "REPO", "STATUS"],
        (.[] | [
            (.type // "git"),
            .repo,
            (.connectionState.status // "-")
        ]) | @tsv
    end
' | column -t -s $'\t'
