#!/bin/bash
# List ArgoCD projects
# Usage: argocd-project-list.sh
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

RESULT=$(argocd_get "/api/v1/projects")
echo "$RESULT" | jq -r '
    .items // [] | if length == 0 then "No projects found."
    else
        ["NAME", "DESCRIPTION", "SOURCES", "DESTINATIONS"],
        (.[] | [
            .metadata.name,
            (.spec.description // "-"),
            (.spec.sourceRepos // [] | if length > 2 then "\(length) repos" elif length > 0 then join(", ") else "*" end),
            (.spec.destinations // [] | if length > 2 then "\(length) dests" elif length > 0 then map(.server // .name // "*") | join(", ") else "*" end)
        ]) | @tsv
    end
' | column -t -s $'\t'
