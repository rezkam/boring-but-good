#!/bin/bash
# Assign a Jira issue
# Usage: jira-assign.sh <issue-key> [username | --unassign | --me]
#
# Examples:
#   jira-assign.sh PROJ-123                  # assign to default assignee from config
#   jira-assign.sh PROJ-123 --me             # assign to self (go-jira take)
#   jira-assign.sh PROJ-123 john.doe         # assign to specific user
#   jira-assign.sh PROJ-123 --unassign       # remove assignment

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_config.sh"

ISSUE="${1:-}"
TARGET="${2:-}"

if [ -z "$ISSUE" ]; then
    cat >&2 << 'EOF'
ERROR: Missing issue key.

Usage:
  jira-assign.sh <issue-key>                Assign to default assignee from config
  jira-assign.sh <issue-key> --me           Assign to yourself
  jira-assign.sh <issue-key> <username>     Assign to a specific user
  jira-assign.sh <issue-key> --unassign     Remove assignment

Examples:
  jira-assign.sh PROJ-123 --me
  jira-assign.sh PROJ-123 john.doe
  jira-assign.sh PROJ-123 --unassign
EOF
    exit 1
fi

run_assign() {
    local output rc
    output=$("$@" 2>&1)
    rc=$?
    if [ $rc -ne 0 ]; then
        cat >&2 << EOF
ERROR: Failed to assign ${ISSUE}.

Command: $*
Output: ${output}

Common causes:
  - Issue does not exist: verify with $SCRIPT_DIR/jira-view.sh ${ISSUE}
  - User not found: the username must match exactly as registered in Jira.
    Check your username: $SCRIPT_DIR/jira-api.sh GET /rest/api/3/myself
  - Permission denied: you may not have assign permission in this project.
EOF
        exit $rc
    fi
    echo "$output"
}

if [ -z "$TARGET" ]; then
    if [ -n "$JIRA_ASSIGNEE" ]; then
        run_assign jira assign "$ISSUE" "$JIRA_ASSIGNEE"
    else
        cat >&2 << EOF
ERROR: No target user specified and no default assignee configured.

Either specify a user:
  jira-assign.sh ${ISSUE} --me
  jira-assign.sh ${ISSUE} john.doe

Or set a default assignee:
  echo "JIRA_ASSIGNEE=your-username" >> ~/.boring/jira/defaults
EOF
        exit 1
    fi
elif [ "$TARGET" = "--me" ]; then
    run_assign jira take "$ISSUE"
elif [ "$TARGET" = "--unassign" ]; then
    run_assign jira unassign "$ISSUE"
else
    run_assign jira assign "$ISSUE" "$TARGET"
fi

echo "Assigned ${ISSUE} → ${TARGET:-${JIRA_ASSIGNEE}}"
