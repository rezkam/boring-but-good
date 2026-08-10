#!/bin/bash
# Lookup project by name (and optionally version)
# Usage: dtrack-project-lookup.sh <name> [version]
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

NAME="${1:-}"; VERSION="${2:-}"
[[ -z "$NAME" ]] && { echo "Usage: $0 <project-name> [version]" >&2; exit 1; }

ENDPOINT="/v1/project/lookup?name=$(urlencode "$NAME")"
[[ -n "$VERSION" ]] && ENDPOINT="${ENDPOINT}&version=$(urlencode "$VERSION")"

"$SCRIPT_DIR/dtrack-api.sh" GET "$ENDPOINT"
