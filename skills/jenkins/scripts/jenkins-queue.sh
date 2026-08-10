#!/bin/bash
# Show the Jenkins build queue
# Usage: jenkins-queue.sh
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

RESULT=$(jenkins_get "/queue/api/json?tree=items[id,why,inQueueSince,task[name,url]]")
ITEMS=$(echo "$RESULT" | jq '.items | length')

if [[ "$ITEMS" == "0" ]]; then
    echo "Build queue is empty."
else
    echo "$RESULT" | jq -r '.items[] | "  [\(.id)] \(.task.name) — \(.why // "waiting")"'
    echo ""; echo "Total: $ITEMS item(s) in queue"
fi
