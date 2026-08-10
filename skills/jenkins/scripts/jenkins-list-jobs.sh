#!/bin/bash
# List jobs/pipelines, optionally within a folder
# Usage: jenkins-list-jobs.sh [folder-path] [--depth N]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

FOLDER_PATH=""; DEPTH="1"
while [[ $# -gt 0 ]]; do
    case "$1" in --depth) DEPTH="$2"; shift 2 ;; *) FOLDER_PATH="$1"; shift ;; esac
done

if [[ -n "$FOLDER_PATH" ]]; then
    JOB_URL=$(echo "$FOLDER_PATH" | sed 's|/|/job/|g')
    ENDPOINT="/job/${JOB_URL}/api/json"
else
    ENDPOINT="/api/json"
fi

TREE="jobs[name,url,color,lastBuild[number,result,timestamp]]"
for ((i=1; i<DEPTH; i++)); do
    TREE="jobs[name,url,color,lastBuild[number,result,timestamp],${TREE}]"
done

RESULT=$(jenkins_get "${ENDPOINT}?tree=${TREE}")
echo "$RESULT" | jq '[
    .. | objects | select(has("name") and has("color")) | {
        name, url, status: .color,
        lastBuild: (if .lastBuild then {
            number: .lastBuild.number, result: .lastBuild.result,
            timestamp: (.lastBuild.timestamp / 1000 | strftime("%Y-%m-%d %H:%M:%S UTC"))
        } else null end)
    }]'
