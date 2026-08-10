#!/bin/bash
# Get test failures for a build
# Usage: jenkins-test-failures.sh <job-path> [build-number] [--full]
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

JOB_PATH=""; BUILD="lastBuild"; SHOW_FULL=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --full) SHOW_FULL="true"; shift ;;
        *)      [[ -z "$JOB_PATH" ]] && JOB_PATH="$1" || BUILD="$1"; shift ;;
    esac
done

[[ -z "$JOB_PATH" ]] && { echo "Usage: $0 <job-path> [build-number] [--full]" >&2; exit 1; }

JOB_URL=$(echo "$JOB_PATH" | sed 's|/|/job/|g')
RESULT=$(jenkins_get "/job/${JOB_URL}/${BUILD}/testReport/api/json" 2>/dev/null || true)

[[ -z "$RESULT" ]] && { echo "No test report found for build ${BUILD}"; exit 0; }

echo "$RESULT" | jq -r '"Test Results: \(.passCount) passed, \(.failCount) failed, \(.skipCount) skipped"'
echo ""

FAILURES=$(echo "$RESULT" | jq -r '.suites[].cases[] | select(.status == "FAILED" or .status == "REGRESSION" or .status == "ERROR")')

if [[ -n "$FAILURES" ]]; then
    echo "Failed Tests:"
    echo "$RESULT" | jq -r '.suites[].cases[] | select(.status == "FAILED" or .status == "REGRESSION" or .status == "ERROR") | "  [\(.status)] \(.className).\(.name)"'
    echo ""
    echo "Error Details:"
    if [[ "$SHOW_FULL" == "true" ]]; then
        echo "$RESULT" | jq -r '.suites[].cases[] | select(.status == "FAILED" or .status == "REGRESSION" or .status == "ERROR") | "---\n\(.className).\(.name):\n\(.errorDetails // "No details")\n\nStack Trace:\n\(.errorStackTrace // "No stack trace")\n"'
    else
        echo "$RESULT" | jq -r '.suites[].cases[] | select(.status == "FAILED" or .status == "REGRESSION" or .status == "ERROR") | "---\n\(.className).\(.name):\n\(.errorDetails // "No details")\n"'
    fi
else
    echo "All tests passed!"
fi
