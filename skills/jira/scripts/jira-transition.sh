#!/bin/bash
# Transition a Jira issue to a new status
# Usage: jira-transition.sh <issue-key> <transition-name>
#        jira-transition.sh <issue-key> --list
#
# Examples:
#   jira-transition.sh PROJ-123 --list
#   jira-transition.sh PROJ-123 "In Progress"
#   jira-transition.sh PROJ-123 "Review"
#   jira-transition.sh PROJ-123 "Mark as in production"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_config.sh"

ISSUE="${1:-}"
ACTION="${2:-}"

if [ -z "$ISSUE" ] || [ -z "$ACTION" ]; then
    cat >&2 << 'EOF'
ERROR: Missing required arguments.

Usage:
  jira-transition.sh <issue-key> <transition-name>   Transition an issue
  jira-transition.sh <issue-key> --list               List available transitions

You must provide both the issue key and either a transition name or --list.

IMPORTANT: Transition names are NOT the same as status names.
  Status = where the issue IS now (e.g. "In Progress")
  Transition = an action to MOVE it (e.g. "Start progress", "Review")

Always list transitions first to see what's available for the issue's current state:
  jira-transition.sh PROJ-123 --list

Examples:
  jira-transition.sh PROJ-123 --list
  jira-transition.sh PROJ-123 "Start progress"
  jira-transition.sh PROJ-123 "Review"
EOF
    exit 1
fi

if [ "$ACTION" = "--list" ]; then
    OUTPUT=$("$SCRIPT_DIR/jira-api.sh" GET "/rest/api/3/issue/${ISSUE}/transitions" 2>&1)
    RC=$?
    if [ $RC -ne 0 ]; then
        cat >&2 << EOF
ERROR: Failed to fetch transitions for ${ISSUE}.

${OUTPUT}

The issue key might not exist. Verify with:
  $SCRIPT_DIR/jira-view.sh ${ISSUE}
EOF
        exit $RC
    fi

    FORMATTED=$(echo "$OUTPUT" | jq '[.transitions[] | {id: .id, name: .name, to: .to.name}]' 2>/dev/null)
    COUNT=$(echo "$FORMATTED" | jq 'length' 2>/dev/null)

    if [ "$COUNT" = "0" ] || [ -z "$COUNT" ]; then
        cat >&2 << EOF
WARNING: No transitions available for ${ISSUE}.

This usually means:
  - The issue is in a terminal state (e.g. Closed, Done) with no outgoing transitions.
  - Your user doesn't have permission to transition this issue.

Check the issue's current status:
  $SCRIPT_DIR/jira-view.sh ${ISSUE}
EOF
        exit 0
    fi

    echo "$FORMATTED"
else
    OUTPUT=$(jira transition --noedit "$ACTION" "$ISSUE" 2>&1)
    RC=$?
    if [ $RC -ne 0 ]; then
        # Fetch available transitions to help the LLM pick the right one
        AVAILABLE=$("$SCRIPT_DIR/jira-api.sh" GET "/rest/api/3/issue/${ISSUE}/transitions" 2>/dev/null | \
            jq -r '[.transitions[] | "  - \"" + .name + "\" → moves to " + .to.name] | join("\n")' 2>/dev/null)

        CURRENT_STATUS=$("$SCRIPT_DIR/jira-api.sh" GET "/rest/api/3/issue/${ISSUE}?fields=status" 2>/dev/null | \
            jq -r '.fields.status.name' 2>/dev/null)

        cat >&2 << EOF
ERROR: Failed to transition ${ISSUE} using "${ACTION}".

go-jira returned: ${OUTPUT}

Current status: ${CURRENT_STATUS:-unknown}

Available transitions from current state:
${AVAILABLE:-  (could not fetch — check issue exists)}

Common mistakes:
  - Using a status name instead of a transition name (e.g. "In Progress" vs "Start progress")
  - The transition is not available from the current status
  - Typo in the transition name (names are case-sensitive)

To see all transitions: $SCRIPT_DIR/jira-transition.sh ${ISSUE} --list
EOF
        exit $RC
    fi
    echo "Transitioned ${ISSUE} → ${ACTION}"
fi
