#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_helpers.sh"

codex_review_require_cmds

LIMIT="20"

if [[ ${1:-} == "--help" || ${1:-} == "-h" ]]; then
    echo "Usage: codex-review-list.sh [limit]"
    echo "List recent Codex runs (review sessions and MCP servers) from local cache."
    echo "Example: codex-review-list.sh 10"
    exit 0
fi

if [[ ${1:-} != "" ]]; then
    LIMIT="$1"
fi

count=0
printf $'run_id\tkind\tstatus\tcreated\ttitle\n'
for run_dir in $(find "$REVIEW_RUNS_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -rn | awk -v limit="$LIMIT" '{print $2}' | head -n "$LIMIT"); do
    meta_file="$(codex_review_meta_file "$run_dir")"
    if [[ ! -f "$meta_file" ]]; then
        continue
    fi
    kind="$(jq -r '.kind // "review"' "$meta_file")"
    status="$(jq -r '.status // "unknown"' "$meta_file")"
    created_ts="$(jq -r '.created_at // 0' "$meta_file")"
    title="$(jq -r '.title // ""' "$meta_file")"
    created="$(date -u -d "@${created_ts}" +"%Y-%m-%d %H:%M:%S")"
    printf "%s\t%s\t%s\t%s\t%s\n" "$run_dir" "$kind" "$status" "$created" "${title:0:40}"
    count=$((count + 1))
done

if [[ $count -eq 0 ]]; then
    echo "No runs yet."
fi
