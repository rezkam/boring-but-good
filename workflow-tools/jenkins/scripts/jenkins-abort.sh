#!/bin/bash
# Abort a running build
# Usage: jenkins-abort.sh <job-path> [build-number]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

JOB_PATH="$1"; BUILD="${2:-lastBuild}"
[[ -z "$JOB_PATH" ]] && { echo "Usage: $0 <job-path> [build-number]" >&2; exit 1; }

JOB_URL=$(echo "$JOB_PATH" | sed 's|/|/job/|g')
HTTP_CODE=$(jenkins_post "/job/${JOB_URL}/${BUILD}/stop")

if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "302" ]]; then
    echo "Build ${BUILD} aborted for ${JOB_PATH}"
else
    cat >&2 <<EOF
ERROR: Failed to abort build. HTTP ${HTTP_CODE}.

Context: POST /job/${JOB_URL}/${BUILD}/stop for job '${JOB_PATH}'

Common causes:
  - HTTP 404: job path or build number does not exist
  - HTTP 403: user lacks Cancel permission
  - Build may have already completed (cannot abort a finished build)

Recovery: check current build status with: jenkins-build-status.sh '${JOB_PATH}'
EOF
    exit 1
fi
