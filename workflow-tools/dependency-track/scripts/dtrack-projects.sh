#!/bin/bash
# List or search Dependency-Track projects
# Usage: dtrack-projects.sh [search-name] [--inactive] [--tag TAG]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

SEARCH_NAME="" ; INCLUDE_INACTIVE="" ; TAG_FILTER=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --inactive) INCLUDE_INACTIVE="true"; shift ;;
        --tag) TAG_FILTER="$2"; shift 2 ;;
        *) [[ -z "$SEARCH_NAME" ]] && SEARCH_NAME="$1"; shift ;;
    esac
done

# Fetch all projects with pagination (DT default max is ~500 per page)
PAGE_SIZE=500
PAGE_NUM=1
ALL_PROJECTS="[]"

while true; do
    ENDPOINT="/v1/project?pageSize=${PAGE_SIZE}&pageNumber=${PAGE_NUM}&sortName=name&sortOrder=asc"
    [[ "$INCLUDE_INACTIVE" != "true" ]] && ENDPOINT="${ENDPOINT}&excludeInactive=true"
    [[ -n "$TAG_FILTER" ]] && ENDPOINT="${ENDPOINT}&tag=${TAG_FILTER}"

    PAGE_RESULT=$("$SCRIPT_DIR/dtrack-api.sh" GET "$ENDPOINT")

    # Merge page into accumulated results
    PAGE_COUNT=$(echo "$PAGE_RESULT" | jq 'length')
    ALL_PROJECTS=$(echo "$ALL_PROJECTS" "$PAGE_RESULT" | jq -s '.[0] + .[1]')

    # Stop if this page was smaller than page size (last page)
    if [[ "$PAGE_COUNT" -lt "$PAGE_SIZE" ]]; then
        break
    fi
    PAGE_NUM=$((PAGE_NUM + 1))
done

FILTER='.'
if [[ -n "$SEARCH_NAME" ]]; then
    # Case-insensitive partial match on project name
    FILTER='[.[] | select(.name | ascii_downcase | contains($q | ascii_downcase))]'
fi

SEARCH_LOWER=$(printf '%s' "$SEARCH_NAME" | tr '[:upper:]' '[:lower:]')

echo "$ALL_PROJECTS" | jq --arg q "$SEARCH_LOWER" "$FILTER" | jq '[.[] | {
    uuid, name, version, active, lastBomImport,
    tags: ([.tags[]?.name] | if length == 0 then null else . end),
    metrics: (if .metrics then {
        critical: .metrics.critical, high: .metrics.high,
        medium: .metrics.medium, low: .metrics.low,
        unassigned: .metrics.unassigned,
        components: .metrics.components,
        riskScore: .metrics.inheritedRiskScore
    } else null end)
}]'
