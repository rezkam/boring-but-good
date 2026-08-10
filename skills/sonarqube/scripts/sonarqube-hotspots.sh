#!/bin/bash
# Fetch security hotspots for a project or PR
# Usage: sonarqube-hotspots.sh <project-key> [--pr N] [--branch NAME] [--status STATUS]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

PROJECT_KEY="${1:-}"; shift 2>/dev/null || true
PR_NUMBER=""; BRANCH=""; STATUS="TO_REVIEW"
while [[ $# -gt 0 ]]; do
    case "$1" in --pr) PR_NUMBER="$2"; shift 2 ;; --branch) BRANCH="$2"; shift 2 ;; --status) STATUS="$2"; shift 2 ;; *) shift ;; esac
done

[[ -z "$PROJECT_KEY" ]] && { echo "Usage: $0 <project-key> [--pr N] [--branch NAME] [--status TO_REVIEW|REVIEWED|SAFE]" >&2; exit 1; }

ENDPOINT="/api/hotspots/search?projectKey=${PROJECT_KEY}&status=${STATUS}&ps=100"
[[ -n "$PR_NUMBER" ]] && ENDPOINT="${ENDPOINT}&pullRequest=${PR_NUMBER}"
[[ -n "$BRANCH" ]] && ENDPOINT="${ENDPOINT}&branch=${BRANCH}"

RESPONSE=$(sonar_get "$ENDPOINT")

[[ $(echo "$RESPONSE" | jq -e '.errors' 2>/dev/null) ]] && { echo "$RESPONSE" | jq '.errors' >&2; exit 1; }

echo "$RESPONSE" | jq '{ total: (.paging.total // (.hotspots | length)),
    hotspots: [.hotspots[] | {
        key, file: (.component | split(":")[1]), line, message,
        securityCategory, vulnerabilityProbability, status, resolution
    }]}'
