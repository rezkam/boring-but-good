#!/bin/bash
# Watch a build until it completes
# Usage: jenkins-watch.sh <job-path> [build-number]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

JOB_PATH="$1"; BUILD="${2:-lastBuild}"
[[ -z "$JOB_PATH" ]] && { echo "Usage: $0 <job-path> [build-number]" >&2; exit 1; }

JOB_URL=$(echo "$JOB_PATH" | sed 's|/|/job/|g')

echo "Watching build ${BUILD} for ${JOB_PATH}..."

while true; do
    RESULT=$(jenkins_get "/job/${JOB_URL}/${BUILD}/api/json?tree=number,result,building,estimatedDuration,duration")
    BUILDING=$(echo "$RESULT" | jq -r '.building')
    BUILD_NUM=$(echo "$RESULT" | jq -r '.number')

    if [[ "$BUILDING" == "true" ]]; then
        DURATION=$(echo "$RESULT" | jq -r '.duration // 0')
        ESTIMATED=$(echo "$RESULT" | jq -r '.estimatedDuration // 0')
        printf "\r\033[K"
        if [[ "$ESTIMATED" -gt 0 ]]; then
            printf "Build #%s in progress... %d%% (%ds)" "$BUILD_NUM" "$((DURATION * 100 / ESTIMATED))" "$((DURATION / 1000))"
        else
            printf "Build #%s in progress..." "$BUILD_NUM"
        fi
        sleep 5
    else
        STATUS=$(echo "$RESULT" | jq -r '.result')
        DURATION=$(echo "$RESULT" | jq -r '.duration')
        printf "\r\033[KBuild #%s finished: %s (%ds)\n" "$BUILD_NUM" "$STATUS" "$((DURATION / 1000))"
        [[ "$STATUS" == "SUCCESS" ]] && exit 0 || exit 1
    fi
done
