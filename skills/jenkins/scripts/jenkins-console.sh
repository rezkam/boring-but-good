#!/bin/bash
# Get console output for a build, optionally grep for a pattern
# Usage: jenkins-console.sh <job-path> [build-number] [grep-pattern]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

JOB_PATH="$1"; BUILD="${2:-lastBuild}"; PATTERN="${3:-}"
[[ -z "$JOB_PATH" ]] && { echo "Usage: $0 <job-path> [build-number] [grep-pattern]" >&2; exit 1; }

JOB_URL=$(echo "$JOB_PATH" | sed 's|/|/job/|g')

CONSOLE=$(jenkins_get "/job/${JOB_URL}/${BUILD}/consoleText")
if [[ -n "$PATTERN" ]]; then
    echo "$CONSOLE" | grep -i --color=never "$PATTERN" || echo "No matches for: $PATTERN"
else
    echo "$CONSOLE"
fi
