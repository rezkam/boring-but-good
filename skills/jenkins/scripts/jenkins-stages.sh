#!/bin/bash
# Get pipeline stages and their status (requires Pipeline plugin / wfapi)
# Usage: jenkins-stages.sh <job-path> [build-number]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

JOB_PATH="$1"; BUILD="${2:-lastBuild}"
[[ -z "$JOB_PATH" ]] && { echo "Usage: $0 <job-path> [build-number]" >&2; exit 1; }

JOB_URL=$(echo "$JOB_PATH" | sed 's|/|/job/|g')
RESULT=$(jenkins_get "/job/${JOB_URL}/${BUILD}/wfapi/describe" 2>/dev/null || echo "")

if [[ -z "$RESULT" || "$RESULT" == "null" ]]; then
    cat >&2 <<EOF
ERROR: No pipeline stage data available.

Context: GET /job/${JOB_URL}/${BUILD}/wfapi/describe for job '${JOB_PATH}'

Common causes:
  - Job is a Freestyle project (stages are only available for Pipeline/Declarative jobs)
  - Pipeline plugin or Pipeline REST API plugin is not installed
  - Build has not started yet (no stage data until first stage runs)

Recovery: check build status instead with: jenkins-build-status.sh '${JOB_PATH}' ${BUILD}
EOF
    exit 1
fi

echo "$RESULT" | jq -r '
    "Pipeline: \(.name)",
    "Status: \(.status)",
    "Duration: \(.durationMillis / 1000 | floor)s",
    "",
    "Stages:",
    (.stages[] | "  [\(.status | if . == "SUCCESS" then "✓" elif . == "FAILED" then "✗" elif . == "IN_PROGRESS" then "⟳" else . end)] \(.name) (\(.durationMillis / 1000 | floor)s)")'
