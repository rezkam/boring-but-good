#!/bin/bash
# List/search SonarQube projects
# Usage: sonarqube-projects.sh [search-query] [--limit N]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

# URL-encode a string (spaces → %20, etc.)
urlencode() {
    local string="$1"
    local strlen=${#string}
    local encoded=""
    local pos c o

    for (( pos=0 ; pos<strlen ; pos++ )); do
        c=${string:$pos:1}
        case "$c" in
            [-_.~a-zA-Z0-9] ) o="${c}" ;;
            * ) printf -v o '%%%02x' "'$c" ;;
        esac
        encoded+="${o}"
    done
    echo "${encoded}"
}

SEARCH=""; LIMIT="50"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --limit) LIMIT="$2"; shift 2 ;;
        *)       [[ -z "$SEARCH" ]] && SEARCH="$1"; shift ;;
    esac
done

ENDPOINT="/api/projects/search?ps=${LIMIT}"
[[ -n "$SEARCH" ]] && ENDPOINT="${ENDPOINT}&q=$(urlencode "$SEARCH")"

RESPONSE=$(sonar_get "$ENDPOINT")

echo "$RESPONSE" | jq '{ total: .paging.total, projects: [.components[] | { key, name, qualifier, lastAnalysis: .lastAnalysisDate, visibility }]}'
