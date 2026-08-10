#!/bin/bash
# Manage labels on a Jira issue
# Usage: jira-labels.sh <issue-key> <set|add|remove> [labels...]
#
# Examples:
#   jira-labels.sh PROJ-123 set label1 label2 label3
#   jira-labels.sh PROJ-123 add new-label
#   jira-labels.sh PROJ-123 remove old-label

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_config.sh"

ISSUE="${1:-}"
ACTION="${2:-}"
shift 2 2>/dev/null || true

if [ -z "$ISSUE" ] || [ -z "$ACTION" ]; then
    cat >&2 << 'EOF'
ERROR: Missing required arguments.

Usage: jira-labels.sh <issue-key> <set|add|remove> [labels...]

Actions:
  set      Replace all labels with the given list
  add      Add labels (keeps existing ones)
  remove   Remove specific labels

Examples:
  jira-labels.sh PROJ-123 set backend urgent fix-v2
  jira-labels.sh PROJ-123 add needs-review
  jira-labels.sh PROJ-123 remove outdated-label

Labels are space-separated, no quotes needed for individual labels.
Labels cannot contain spaces — use underscores or hyphens.
EOF
    exit 1
fi

if [ $# -eq 0 ]; then
    cat >&2 << EOF
ERROR: No labels provided.

Usage: jira-labels.sh ${ISSUE} ${ACTION} label1 [label2 ...]

Example:
  jira-labels.sh ${ISSUE} ${ACTION} my-label another-label
EOF
    exit 1
fi

case "$ACTION" in
    set)
        OUTPUT=$(jira labels set "$ISSUE" "$@" 2>&1)
        ;;
    add)
        OUTPUT=$(jira labels add "$ISSUE" "$@" 2>&1)
        ;;
    remove)
        OUTPUT=$(jira labels remove "$ISSUE" "$@" 2>&1)
        ;;
    *)
        cat >&2 << EOF
ERROR: Unknown action '${ACTION}'.

Valid actions: set, add, remove

  set    — Replace all labels:    jira-labels.sh ${ISSUE} set label1 label2
  add    — Add to existing:       jira-labels.sh ${ISSUE} add new-label
  remove — Remove specific:       jira-labels.sh ${ISSUE} remove old-label
EOF
        exit 1
        ;;
esac

RC=$?
if [ $RC -ne 0 ]; then
    cat >&2 << EOF
ERROR: Failed to ${ACTION} labels on ${ISSUE}.

Output: ${OUTPUT}

Common causes:
  - Issue does not exist: verify with $SCRIPT_DIR/jira-view.sh ${ISSUE}
  - Permission denied: you may not have edit permission on this project.

To check current labels: $SCRIPT_DIR/jira-view.sh ${ISSUE}
EOF
    exit $RC
fi

echo "Labels ${ACTION} on ${ISSUE}: $*"
