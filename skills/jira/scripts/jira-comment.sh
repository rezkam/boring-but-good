#!/bin/bash
# Add a comment to a Jira issue
# Usage: jira-comment.sh <issue-key> "comment text"
#
# Examples:
#   jira-comment.sh PROJ-123 "Fixed in commit abc123"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_config.sh"

ISSUE="${1:-}"
COMMENT="${2:-}"

if [ -z "$ISSUE" ] || [ -z "$COMMENT" ]; then
    cat >&2 << 'EOF'
ERROR: Missing required arguments.

Usage: jira-comment.sh <issue-key> "comment text"

Both arguments are required:
  issue-key    The issue to comment on (e.g. PROJ-123)
  comment      The comment text (wrap in quotes if it contains spaces)

Examples:
  jira-comment.sh PROJ-123 "Fixed in commit abc123"
  jira-comment.sh PROJ-123 "Deployed to staging. Tested OK."
  jira-comment.sh PROJ-123 "Root cause: NPE in FooService.process() when input is null"
EOF
    exit 1
fi

OUTPUT=$(jira comment --noedit "$ISSUE" -m "$COMMENT" 2>&1)
RC=$?

if [ $RC -ne 0 ]; then
    cat >&2 << EOF
ERROR: Failed to add comment to ${ISSUE}.

go-jira returned: ${OUTPUT}

Common causes:
  - Issue does not exist: verify with $SCRIPT_DIR/jira-view.sh ${ISSUE}
  - Permission denied: you may not have comment permission on this project.
  - Auth expired: test with $SCRIPT_DIR/jira-api.sh GET /rest/api/3/myself
EOF
    exit $RC
fi

echo "Comment added to ${ISSUE}"
