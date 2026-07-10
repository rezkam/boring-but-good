#!/bin/bash
# Fetch SonarQube issues for a project or PR
# Usage: sonarqube-issues.sh <project-key> [pr-number] [--status S] [--severity S] [--type T] [--branch B] [--limit N]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

PROJECT_KEY="${1:-}"; shift 2>/dev/null || true
PR_NUMBER=""; STATUS="OPEN,CONFIRMED"; SEVERITY=""; TYPE=""; BRANCH=""; LIMIT="100"

# If next arg looks like a number, it's the PR
[[ "${1:-}" =~ ^[0-9]+$ ]] && { PR_NUMBER="$1"; shift; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --status)   STATUS="$2";    shift 2 ;;
        --severity) SEVERITY="$2";  shift 2 ;;
        --type)     TYPE="$2";      shift 2 ;;
        --branch)   BRANCH="$2";    shift 2 ;;
        --pr)       PR_NUMBER="$2"; shift 2 ;;
        --limit)    LIMIT="$2";     shift 2 ;;
        *) shift ;;
    esac
done

if [[ -z "$PROJECT_KEY" ]]; then
    echo "Usage: $0 <project-key> [pr] [--status S] [--severity S] [--type T] [--branch B]" >&2
    echo "Severities: INFO,MINOR,MAJOR,CRITICAL,BLOCKER" >&2
    echo "Types: CODE_SMELL,BUG,VULNERABILITY,SECURITY_HOTSPOT" >&2
    exit 1
fi

ENDPOINT="/api/issues/search?componentKeys=${PROJECT_KEY}&issueStatuses=${STATUS}&ps=${LIMIT}"
[[ -n "$PR_NUMBER" ]] && ENDPOINT="${ENDPOINT}&pullRequest=${PR_NUMBER}"
[[ -n "$BRANCH" ]]    && ENDPOINT="${ENDPOINT}&branch=${BRANCH}"
[[ -n "$SEVERITY" ]]  && ENDPOINT="${ENDPOINT}&severities=${SEVERITY}"
[[ -n "$TYPE" ]]      && ENDPOINT="${ENDPOINT}&types=${TYPE}"

RESPONSE=$(sonar_get "$ENDPOINT")

if echo "$RESPONSE" | jq -e '.errors' >/dev/null 2>&1; then
    echo "SonarQube API error:" >&2; echo "$RESPONSE" | jq '.errors' >&2; exit 1
fi

echo "$RESPONSE" | jq '{ total: .total, issues: [.issues[] | {
    key, file: (.component | split(":")[1]), line, message, rule, severity, type, effort, status, tags, creationDate
}]}'
