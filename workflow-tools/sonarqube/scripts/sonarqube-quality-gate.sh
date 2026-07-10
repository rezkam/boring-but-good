#!/bin/bash
# Check quality gate status for a project, branch, or PR
# Usage: sonarqube-quality-gate.sh <project-key> [--pr N] [--branch NAME]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

PROJECT_KEY="${1:-}"; shift 2>/dev/null || true
PR_NUMBER=""; BRANCH=""
while [[ $# -gt 0 ]]; do
    case "$1" in --pr) PR_NUMBER="$2"; shift 2 ;; --branch) BRANCH="$2"; shift 2 ;; *) shift ;; esac
done

[[ -z "$PROJECT_KEY" ]] && { echo "Usage: $0 <project-key> [--pr N] [--branch NAME]" >&2; exit 1; }

ENDPOINT="/api/qualitygates/project_status?projectKey=${PROJECT_KEY}"
[[ -n "$PR_NUMBER" ]] && ENDPOINT="${ENDPOINT}&pullRequest=${PR_NUMBER}"
[[ -n "$BRANCH" ]] && ENDPOINT="${ENDPOINT}&branch=${BRANCH}"

RESPONSE=$(sonar_get "$ENDPOINT")

[[ $(echo "$RESPONSE" | jq -e '.errors' 2>/dev/null) ]] && { echo "$RESPONSE" | jq '.errors' >&2; exit 1; }

STATUS_VAL=$(echo "$RESPONSE" | jq -r '.projectStatus.status')
echo "$RESPONSE" | jq '{ status: .projectStatus.status,
    conditions: [.projectStatus.conditions[] | { metric: .metricKey, status, value: .actualValue, threshold: .errorThreshold, comparator }],
    periods: .projectStatus.periods }'

[[ "$STATUS_VAL" != "OK" && "$STATUS_VAL" != "NONE" ]] && exit 1 || exit 0
