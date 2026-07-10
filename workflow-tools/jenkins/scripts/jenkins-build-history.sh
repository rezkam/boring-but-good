#!/bin/bash
# Get recent build history for a job
# Usage: jenkins-build-history.sh <job-path> [count]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

JOB_PATH="$1"; COUNT="${2:-10}"
[[ -z "$JOB_PATH" ]] && { echo "Usage: $0 <job-path> [count]" >&2; exit 1; }

JOB_URL=$(echo "$JOB_PATH" | sed 's|/|/job/|g')
QUERY="tree=builds[number,result,building,duration,timestamp,changeSets[items[msg]]]{0,${COUNT}}"

RESULT=$(jenkins_get "/job/${JOB_URL}/api/json?${QUERY}")
echo "$RESULT" | jq -r '.builds[] |
    "#\(.number) \(if .building then "BUILDING" else .result // "UNKNOWN" end) " +
    "\((.duration / 1000 | floor))s " +
    "\(.timestamp / 1000 | strftime("%Y-%m-%d %H:%M"))" +
    (if (.changeSets | length > 0) and (.changeSets[0].items | length > 0) then
        " — \(.changeSets[0].items[0].msg | split("\n")[0] | .[0:60])"
    else "" end)'
