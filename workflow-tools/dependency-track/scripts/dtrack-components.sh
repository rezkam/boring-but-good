#!/bin/bash
# List components (dependencies) for a project
# Usage: dtrack-components.sh <project-uuid> [--page N] [--search NAME]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# URL-encode a string
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

PROJECT_UUID=""; PAGE="1"; SEARCH=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --page)   PAGE="$2";   shift 2 ;;
        --search) SEARCH="$2"; shift 2 ;;
        *)        [[ -z "$PROJECT_UUID" ]] && PROJECT_UUID="$1"; shift ;;
    esac
done

[[ -z "$PROJECT_UUID" ]] && { echo "Usage: $0 <project-uuid> [--page N] [--search NAME]" >&2; exit 1; }

ENDPOINT="/v1/component/project/${PROJECT_UUID}?pageNumber=${PAGE}&pageSize=100"
[[ -n "$SEARCH" ]] && ENDPOINT="${ENDPOINT}&searchText=$(urlencode "$SEARCH")"

"$SCRIPT_DIR/dtrack-api.sh" GET "$ENDPOINT" | jq '[.[] | { uuid, group, name, version, purl, classifier, license, isInternal }]'
