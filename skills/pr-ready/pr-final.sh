#!/usr/bin/env bash
# Certifies that a ready snapshot remains ready after a settling interval.

set -uo pipefail

skill_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
state_command=${PR_READY_STATE_COMMAND:-"$skill_dir/pr-state.sh"}
stability_seconds=${PR_READY_STABILITY_SECONDS:-60}

case "$stability_seconds" in
  ''|*[!0-9]*)
    echo "PR_READY_STABILITY_SECONDS must be a non-negative integer." >&2
    exit 2
    ;;
esac

field() {
  local output=$1
  local key=$2
  printf '%s\n' "$output" | awk -v key="$key" '$1 == key {$1=""; sub(/^ +/, ""); print; exit}'
}

emit_with_stability() {
  local output=$1
  local stability=$2
  local verdict
  verdict=$(printf '%s\n' "$output" | tail -1)
  printf '%s\n' "$output" | sed '$d'
  echo "STABILITY      $stability"
  echo "$verdict"
}

first=$("$state_command" "$@")
first_verdict=$(field "$first" VERDICT)
if [ "$first_verdict" != "READY_TO_MERGE" ]; then
  printf '%s\n' "$first"
  exit 0
fi

first_local=$(field "$first" LOCAL_HEAD)
first_pr=$(field "$first" PR_HEAD)
first_base=$(field "$first" BASE_HEAD)
sleep "$stability_seconds"

second=$("$state_command" "$@")
second_verdict=$(field "$second" VERDICT)
if [ "$second_verdict" != "READY_TO_MERGE" ]; then
  emit_with_stability "$second" "changed during ${stability_seconds}s settling interval"
  exit 0
fi

second_local=$(field "$second" LOCAL_HEAD)
second_pr=$(field "$second" PR_HEAD)
second_base=$(field "$second" BASE_HEAD)
if [ "$first_local" != "$second_local" ] || [ "$first_pr" != "$second_pr" ] || [ "$first_base" != "$second_base" ]; then
  printf '%s\n' "$second" | sed '$d'
  echo "STABILITY      head or base changed during ${stability_seconds}s settling interval"
  echo "VERDICT        STABILITY_CHANGED"
  exit 0
fi

emit_with_stability "$second" "${stability_seconds}s unchanged at PR head $second_pr and base head $second_base"
