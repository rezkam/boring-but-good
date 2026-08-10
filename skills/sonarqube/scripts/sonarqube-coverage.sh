#!/bin/bash
# Fetch coverage metrics for a project, branch, or PR
# Usage: sonarqube-coverage.sh <project-key> [pr-number] [--branch NAME]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

PROJECT_KEY="${1:-}"; shift 2>/dev/null || true
PR_NUMBER=""; BRANCH=""
[[ "${1:-}" =~ ^[0-9]+$ ]] && { PR_NUMBER="$1"; shift 2>/dev/null || true; }
while [[ $# -gt 0 ]]; do
    case "$1" in --branch) BRANCH="$2"; shift 2 ;; --pr) PR_NUMBER="$2"; shift 2 ;; *) shift ;; esac
done

[[ -z "$PROJECT_KEY" ]] && { echo "Usage: $0 <project-key> [pr-number] [--branch NAME]" >&2; exit 1; }

if [[ -n "$PR_NUMBER" || -n "$BRANCH" ]]; then
    METRICS="new_coverage,new_line_coverage,new_uncovered_lines,new_lines_to_cover,new_duplicated_lines_density"
else
    METRICS="coverage,line_coverage,uncovered_lines,lines_to_cover,duplicated_lines_density,ncloc"
fi

ENDPOINT="/api/measures/component?component=${PROJECT_KEY}&metricKeys=${METRICS}"
[[ -n "$PR_NUMBER" ]] && ENDPOINT="${ENDPOINT}&pullRequest=${PR_NUMBER}"
[[ -n "$BRANCH" ]] && ENDPOINT="${ENDPOINT}&branch=${BRANCH}"

RESPONSE=$(sonar_get "$ENDPOINT")

[[ $(echo "$RESPONSE" | jq -e '.errors' 2>/dev/null) ]] && { echo "$RESPONSE" | jq '.errors' >&2; exit 1; }

echo "$RESPONSE" | jq 'def metric($n): (
    [.component.measures[] | select(.metric==$n)] | 
    if length == 0 then "N/A"
    else .[0] | (.period.value // .value // "N/A")
    end
);
{ project: .component.name, measures: (
    [.component.measures[].metric] |
    if any(. == "new_coverage") then {
        new_coverage: metric("new_coverage"), new_line_coverage: metric("new_line_coverage"),
        new_lines_to_cover: metric("new_lines_to_cover"), new_uncovered_lines: metric("new_uncovered_lines")
    } else {
        coverage: metric("coverage"), line_coverage: metric("line_coverage"),
        lines_to_cover: metric("lines_to_cover"), uncovered_lines: metric("uncovered_lines"),
        lines_of_code: metric("ncloc")
    } end)}'
