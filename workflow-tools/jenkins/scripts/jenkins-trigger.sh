#!/bin/bash
# Trigger a new build, optionally with parameters
# Usage: jenkins-trigger.sh <job-path> [--param KEY=VALUE]...
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

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

JOB_PATH="$1"; shift 2>/dev/null || true
PARAMS=()
while [[ $# -gt 0 ]]; do
    case "$1" in --param) PARAMS+=("$2"); shift 2 ;; *) shift ;; esac
done

[[ -z "$JOB_PATH" ]] && { echo "Usage: $0 <job-path> [--param KEY=VALUE]..." >&2; exit 1; }
JOB_URL=$(echo "$JOB_PATH" | sed 's|/|/job/|g')

# Parameterized jobs (the typical case for multibranch/PR pipelines) reject empty
# POSTs to /build with HTTP 400 "Nothing is submitted". /buildWithParameters works
# for those, and also for non-parameterized jobs whose params all have defaults.
# True non-parameterized freestyle jobs reject /buildWithParameters with 405 —
# in that case fall back to /build.
if [[ ${#PARAMS[@]} -gt 0 ]]; then
    ENCODED_PARAMS=()
    for param in "${PARAMS[@]}"; do
        key="${param%%=*}"
        value="${param#*=}"
        ENCODED_PARAMS+=("$(urlencode "$key")=$(urlencode "$value")")
    done
    PARAM_STRING=$(IFS='&'; echo "${ENCODED_PARAMS[*]}")
    ENDPOINT="/job/${JOB_URL}/buildWithParameters?${PARAM_STRING}"
    HTTP_CODE=$(jenkins_post "$ENDPOINT")
else
    ENDPOINT="/job/${JOB_URL}/buildWithParameters"
    HTTP_CODE=$(jenkins_post "$ENDPOINT" 2>/dev/null)
    if [[ "$HTTP_CODE" == "405" || "$HTTP_CODE" == "404" ]]; then
        ENDPOINT="/job/${JOB_URL}/build"
        HTTP_CODE=$(jenkins_post "$ENDPOINT")
    fi
fi

if [[ "$HTTP_CODE" == "201" || "$HTTP_CODE" == "200" ]]; then
    echo "Build triggered: ${JOB_PATH}"
    if [[ ${#PARAMS[@]} -gt 0 ]]; then echo "Parameters: ${PARAMS[*]}"; fi
else
    cat >&2 <<EOF
ERROR: Failed to trigger build. HTTP ${HTTP_CODE}.

Context: POST ${ENDPOINT} for job '${JOB_PATH}'

Common causes:
  - HTTP 400: parameterized job rejecting empty body. Pass at least one --param KEY=VALUE.
  - HTTP 404: job path does not exist. Check spelling, verify with: jenkins-list-jobs.sh
  - HTTP 403: user lacks Build permission, or CSRF crumb missing/invalid.
  - HTTP 405: job is disabled or does not support this build endpoint.
  - HTTP 409: job already has a build queued.

Recovery: verify the job exists with: jenkins-list-jobs.sh
EOF
    exit 1
fi
