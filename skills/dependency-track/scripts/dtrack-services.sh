#!/bin/bash
# List services for a project
# Usage: dtrack-services.sh <project-uuid> [page]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_UUID="${1:-}"; PAGE="${2:-1}"

[[ -z "$PROJECT_UUID" ]] && { echo "Usage: $0 <project-uuid> [page]" >&2; exit 1; }

"$SCRIPT_DIR/dtrack-api.sh" GET "/v1/service/project/${PROJECT_UUID}?pageNumber=${PAGE}&pageSize=100" | \
    jq '[.[] | { uuid, name, version, group, description, authenticated, crossesTrustBoundary, endpoints }]'
