#!/bin/bash
# Transition a SonarQube issue (confirm, resolve, false-positive, etc.)
#
# Usage:
#   sonarqube-transition.sh <issue-key> <transition> [--comment "text"]
#
# Transitions:
#   confirm        — Confirm the issue is valid
#   unconfirm      — Revert a confirmed issue back to open
#   reopen         — Reopen a resolved/closed issue
#   resolve        — Mark as resolved (fixed)
#   falsepositive  — Mark as false positive (won't show up again)
#   wontfix        — Mark as won't fix (accepted risk)
#   accept         — Accept the issue (SonarQube 10.x+)
#
# Examples:
#   sonarqube-transition.sh AY1234abcXYZ confirm
#   sonarqube-transition.sh AY1234abcXYZ falsepositive --comment "Not reachable in production"
#   sonarqube-transition.sh AY1234abcXYZ resolve

set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

ISSUE_KEY=""
TRANSITION=""
COMMENT=""

while [ $# -gt 0 ]; do
    case "$1" in
        --comment) COMMENT="$2"; shift 2 ;;
        --help|-h)
            echo "Usage: $0 <issue-key> <transition> [--comment \"text\"]"
            echo ""
            echo "Transitions: confirm, unconfirm, reopen, resolve, falsepositive, wontfix, accept"
            exit 0
            ;;
        *)
            if [ -z "$ISSUE_KEY" ]; then
                ISSUE_KEY="$1"
            elif [ -z "$TRANSITION" ]; then
                TRANSITION="$1"
            else
                echo "ERROR: Unexpected argument: $1" >&2
                echo "Usage: $0 <issue-key> <transition> [--comment \"text\"]" >&2
                exit 1
            fi
            shift
            ;;
    esac
done

if [ -z "$ISSUE_KEY" ] || [ -z "$TRANSITION" ]; then
    echo "ERROR: Both issue key and transition are required." >&2
    echo "" >&2
    echo "Usage: $0 <issue-key> <transition> [--comment \"text\"]" >&2
    echo "" >&2
    echo "Transitions: confirm, unconfirm, reopen, resolve, falsepositive, wontfix, accept" >&2
    echo "" >&2
    echo "Example:" >&2
    echo "  $0 AY1234abcXYZ falsepositive --comment \"Not reachable\"" >&2
    exit 1
fi

# Validate transition name
VALID_TRANSITIONS="confirm unconfirm reopen resolve falsepositive wontfix accept"
FOUND=false
for t in $VALID_TRANSITIONS; do
    if [ "$TRANSITION" = "$t" ]; then
        FOUND=true
        break
    fi
done

if [ "$FOUND" != "true" ]; then
    echo "ERROR: Invalid transition '${TRANSITION}'." >&2
    echo "" >&2
    echo "Valid transitions:" >&2
    echo "  confirm        — Confirm the issue is valid" >&2
    echo "  unconfirm      — Revert a confirmed issue back to open" >&2
    echo "  reopen         — Reopen a resolved/closed issue" >&2
    echo "  resolve        — Mark as resolved (fixed)" >&2
    echo "  falsepositive  — Mark as false positive (won't show up again)" >&2
    echo "  wontfix        — Mark as won't fix (accepted risk)" >&2
    echo "  accept         — Accept the issue (SonarQube 10.x+)" >&2
    echo "" >&2
    echo "Note: Not all transitions are available from every status." >&2
    echo "An OPEN issue can be: confirm, resolve, falsepositive, wontfix" >&2
    echo "A CONFIRMED issue can be: unconfirm, resolve, falsepositive, wontfix" >&2
    echo "A RESOLVED issue can be: reopen" >&2
    exit 1
fi

# Perform transition
RESPONSE=$(sonar_post "/api/issues/do_transition" \
    -d "issue=${ISSUE_KEY}" \
    -d "transition=${TRANSITION}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
    echo "ERROR: Transition '${TRANSITION}' failed for issue ${ISSUE_KEY} (HTTP ${HTTP_CODE})." >&2
    echo "" >&2
    if echo "$BODY" | jq -e '.errors' >/dev/null 2>&1; then
        echo "Server said:" >&2
        echo "$BODY" | jq -r '.errors[].msg' >&2
    else
        echo "Response: ${BODY}" >&2
    fi
    echo "" >&2
    echo "Common causes:" >&2
    echo "  - The issue is not in a status that allows '${TRANSITION}'" >&2
    echo "  - You don't have 'Administer Issues' permission on this project" >&2
    echo "  - The issue key is wrong" >&2
    echo "" >&2
    echo "To check current status:" >&2
    echo "  $SCRIPT_DIR/sonarqube-api.sh '/api/issues/search?issues=${ISSUE_KEY}' | jq '.issues[0].status'" >&2
    exit 1
fi

# Add comment if provided
if [ -n "$COMMENT" ]; then
    COMMENT_RESP=$(sonar_post "/api/issues/add_comment" \
        -d "issue=${ISSUE_KEY}" \
        --data-urlencode "text=${COMMENT}")

    COMMENT_CODE=$(echo "$COMMENT_RESP" | tail -1)
    if [ "$COMMENT_CODE" -lt 200 ] || [ "$COMMENT_CODE" -ge 300 ]; then
        echo "WARNING: Transition succeeded but comment failed (HTTP ${COMMENT_CODE})." >&2
    fi
fi

# Output the updated issue
echo "$BODY" | jq '{
    key: .issue.key,
    status: .issue.status,
    resolution: .issue.resolution,
    transition: "'"${TRANSITION}"'",
    comment_added: (if "'"${COMMENT}"'" != "" then true else false end)
}' 2>/dev/null || echo "{\"key\":\"${ISSUE_KEY}\",\"transition\":\"${TRANSITION}\",\"status\":\"ok\"}"
