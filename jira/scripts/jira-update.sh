#!/bin/bash
# Update fields on a Jira issue
# Usage: jira-update.sh <issue-key> [--summary "text"] [--description "text"] [--assignee id] [--priority name]
#
# Uses the Jira REST API directly (via jira request) to handle special characters safely.
#
# Examples:
#   jira-update.sh PROJ-123 --summary "[Service] New title"
#   jira-update.sh PROJ-123 --description "Updated description"
#   jira-update.sh PROJ-123 --priority High

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_config.sh"

ISSUE="${1:-}"
shift 2>/dev/null || true

if [ -z "$ISSUE" ]; then
    cat >&2 << 'EOF'
ERROR: Missing issue key.

Usage: jira-update.sh <issue-key> [options]

Options:
  --summary "text"       Update the issue title
  --description "text"   Update the description
  --assignee username    Change the assignee
  --priority name        Change priority (e.g. High, Medium, Low)

Examples:
  jira-update.sh PROJ-123 --summary "[Service] New title"
  jira-update.sh PROJ-123 --description "Root cause was a null pointer in FooService"
  jira-update.sh PROJ-123 --priority High --assignee john.doe

To see valid priorities: jira-meta.sh priorities
EOF
    exit 1
fi

SUMMARY="" DESCRIPTION="" ASSIGNEE="" PRIORITY=""

while [ $# -gt 0 ]; do
    case "$1" in
        --summary)     SUMMARY="$2";     shift 2 ;;
        --description) DESCRIPTION="$2"; shift 2 ;;
        --assignee)    ASSIGNEE="$2";    shift 2 ;;
        --priority)    PRIORITY="$2";    shift 2 ;;
        *)
            cat >&2 << EOF
ERROR: Unknown option '$1'.

Valid options: --summary, --description, --assignee, --priority

Example:
  jira-update.sh ${ISSUE} --summary "New title" --priority High
EOF
            exit 1
            ;;
    esac
done

# Build JSON payload for raw API (handles special chars safely).
# Description is converted from markdown to Atlassian Document Format (ADF) before
# posting, because the v3 API rejects raw strings for `description` and v2's wiki
# interpretation mangles markdown headings/code spans.
FIELDS="{}"
[ -n "$SUMMARY" ]     && FIELDS=$(echo "$FIELDS" | jq --arg v "$SUMMARY" '.summary = $v')
if [ -n "$DESCRIPTION" ]; then
    DESC_ADF=$(printf '%s' "$DESCRIPTION" | python3 "$SCRIPT_DIR/md_to_adf.py" 2>/dev/null)
    if [ -z "$DESC_ADF" ]; then
        cat >&2 << EOF
ERROR: Failed to convert description from markdown to ADF.
md_to_adf.py returned an empty document. Check that python3 is on PATH and
that the script at $SCRIPT_DIR/md_to_adf.py is intact.
EOF
        exit 1
    fi
    FIELDS=$(echo "$FIELDS" | jq --argjson v "$DESC_ADF" '.description = $v')
fi
# Assignee: use jira-assign.sh which handles Cloud (accountId) vs Server (name) correctly.
# For the raw fields payload, we set it as a separate step after the main update.
if [ -n "$ASSIGNEE" ]; then
    _ASSIGNEE_PENDING="$ASSIGNEE"
    # Don't add to FIELDS — handled separately below
fi
[ -n "$PRIORITY" ]    && FIELDS=$(echo "$FIELDS" | jq --arg v "$PRIORITY" '.priority = {"name": $v}')

if [ "$FIELDS" = "{}" ] && [ -z "${_ASSIGNEE_PENDING:-}" ]; then
    cat >&2 << EOF
ERROR: No fields to update. Provide at least one of:
  --summary "text"
  --description "text"
  --assignee username
  --priority name

Example:
  jira-update.sh ${ISSUE} --summary "Updated title"

For other fields not listed above, use the raw API:
  $SCRIPT_DIR/jira-api.sh PUT "/rest/api/2/issue/${ISSUE}" '{"fields":{"customfield_10001":"value"}}'
EOF
    exit 1
fi

# Only send PUT if there are field changes (not just assignee)
if [ "$FIELDS" != "{}" ]; then
    PAYLOAD=$(jq -n --argjson fields "$FIELDS" '{"fields": $fields}')

    OUTPUT=$(jira request -M PUT "/rest/api/3/issue/${ISSUE}" "$PAYLOAD" 2>&1)
    RC=$?
else
    RC=0
fi

if [ $RC -ne 0 ]; then
    cat >&2 << EOF
ERROR: Failed to update ${ISSUE}.

go-jira returned: ${OUTPUT}
Payload sent: ${PAYLOAD}

Common causes:
  - Issue does not exist: verify with $SCRIPT_DIR/jira-view.sh ${ISSUE}
  - Invalid field value: e.g. priority name must match exactly.
    Valid priorities: $SCRIPT_DIR/jira-meta.sh priorities
  - Read-only field: some fields can't be updated after creation.
  - Permission denied: you may not have edit permission on this project.
EOF
    exit $RC
fi

# Handle assignee separately via go-jira (Cloud/Server compatible)
if [ -n "${_ASSIGNEE_PENDING:-}" ]; then
    ASSIGN_RC=0
    if [ "$_ASSIGNEE_PENDING" = "--me" ]; then
        ASSIGN_OUT=$(jira take "$ISSUE" 2>&1) || ASSIGN_RC=$?
    elif [ "$_ASSIGNEE_PENDING" = "--unassign" ]; then
        ASSIGN_OUT=$(jira unassign "$ISSUE" 2>&1) || ASSIGN_RC=$?
    else
        ASSIGN_OUT=$(jira assign "$ISSUE" "$_ASSIGNEE_PENDING" 2>&1) || ASSIGN_RC=$?
    fi
    
    if [ $ASSIGN_RC -ne 0 ]; then
        cat >&2 << EOF
WARNING: Fields updated but assignee change failed.

Target assignee: ${_ASSIGNEE_PENDING}
go-jira output: ${ASSIGN_OUT}

Possible causes:
  - User not found: check username with jira-api.sh GET /rest/api/3/myself
  - Permission denied: you may lack assign permission in this project
  - Invalid operation: cannot unassign from a project with required assignee

To fix assignee separately:
  $SCRIPT_DIR/jira-assign.sh ${ISSUE} ${_ASSIGNEE_PENDING}
EOF
        exit 1
    fi
fi

echo "Updated ${ISSUE}"
