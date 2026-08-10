#!/bin/bash
# Get ArgoCD project details
# Usage: argocd-project-get.sh <project-name>
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

PROJECT="$1"
if [ -z "$PROJECT" ]; then
    echo "Usage: $0 <project-name>" >&2
    echo "  Get detailed info about an ArgoCD project." >&2
    exit 1
fi

RESULT=$(argocd_get "/api/v1/projects/${PROJECT}")
echo "$RESULT" | jq -r '
    "Project:      \(.metadata.name)",
    "Description:  \(.spec.description // "-")",
    "",
    "Source Repos:",
    (.spec.sourceRepos // ["*"] | .[] | "  - \(.)"),
    "",
    "Destinations:",
    (.spec.destinations // [] | if length == 0 then "  - * (any)" else .[] | "  - \(.server // "*") / \(.namespace // "*")" end),
    "",
    if (.spec.roles // [] | length) > 0 then
        "Roles:",
        (.spec.roles[] | "  - \(.name): \(.description // "-")"),
        ""
    else empty end,
    if (.spec.clusterResourceWhitelist // [] | length) > 0 then
        "Cluster Resources (allowed):",
        (.spec.clusterResourceWhitelist[] | "  - \(.group // "*")/\(.kind // "*")"),
        ""
    else empty end
'
