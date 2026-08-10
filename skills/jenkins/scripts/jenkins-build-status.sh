#!/bin/bash
# Get build status for a job
# Usage: jenkins-build-status.sh <job-path> [build-number]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

JOB_PATH="$1"; BUILD="${2:-lastBuild}"
[[ -z "$JOB_PATH" ]] && { echo "Usage: $0 <job-path> [build-number]" >&2; exit 1; }

JOB_URL=$(echo "$JOB_PATH" | sed 's|/|/job/|g')
QUERY="tree=number,result,building,duration,timestamp,displayName,changeSets%5Bitems%5Bmsg,id,author%5BfullName%5D%5D%5D"

RESULT=$(jenkins_get "/job/${JOB_URL}/${BUILD}/api/json?${QUERY}")
echo "$RESULT" | jq -r '
    "Build #\(.number)",
    "Status: \(if .building then "BUILDING" else .result end)",
    "Duration: \((.duration / 1000 | floor))s",
    "Timestamp: \(.timestamp / 1000 | strftime("%Y-%m-%d %H:%M:%S UTC"))",
    "",
    "Commits:",
    (.changeSets[]?.items[]? | "  - \(.id[0:7]): \(.msg | split("\n")[0])" +
        (if .author.fullName then " (\(.author.fullName))" else "" end))
'
