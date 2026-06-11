#!/bin/bash
# View a Jira issue
# Usage: jira-view.sh <issue-key> [--comments]
#
# Examples:
#   jira-view.sh PROJ-123
#   jira-view.sh PROJ-123 --comments

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_config.sh"

ISSUE="${1:-}"
if [ -z "$ISSUE" ]; then
    cat >&2 << 'EOF'
ERROR: Missing issue key.

Usage:
  jira-view.sh <issue-key>              View issue details
  jira-view.sh <issue-key> --comments   Include comments

The issue key is the project prefix + number (e.g. PROJ-123, PROJ-456).

Examples:
  jira-view.sh PROJ-123
  jira-view.sh PROJ-123 --comments
EOF
    exit 1
fi
shift

SHOW_COMMENTS=false
for arg in "$@"; do
    case "$arg" in
        --comments) SHOW_COMMENTS=true ;;
    esac
done

# Get issue details via API for structured output
RESPONSE=$("$SCRIPT_DIR/jira-api.sh" GET "/rest/api/3/issue/${ISSUE}?fields=summary,status,issuetype,assignee,reporter,priority,labels,created,updated,description" 2>&1)
RC=$?

if [ $RC -ne 0 ]; then
    cat >&2 << EOF
ERROR: Failed to fetch issue ${ISSUE}.

${RESPONSE}

Common causes:
  - Issue does not exist: double-check the key (e.g. PROJ-123, not PROJ123).
  - Permission denied: you may not have access to this project.
  - Auth expired: test with $SCRIPT_DIR/jira-api.sh GET /rest/api/3/myself

To search for issues instead:
  $SCRIPT_DIR/jira-search.sh "keyword"
  $SCRIPT_DIR/jira-list.sh --assignee me
EOF
    exit $RC
fi

# Print metadata fields
echo "$RESPONSE" | jq '{
    key: .key,
    summary: .fields.summary,
    status: .fields.status.name,
    type: .fields.issuetype.name,
    priority: .fields.priority.name,
    assignee: (.fields.assignee.displayName // "Unassigned"),
    reporter: .fields.reporter.displayName,
    labels: .fields.labels,
    created: .fields.created,
    updated: .fields.updated
}'

# Render description: convert ADF to Markdown via _adf-to-md.js
DESC_ADF=$(echo "$RESPONSE" | jq '.fields.description')
if [ "$DESC_ADF" != "null" ] && [ -n "$DESC_ADF" ]; then
    echo ""
    echo "=== Description ==="
    if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/_adf-to-md.js" ]; then
        echo "$DESC_ADF" | node "$SCRIPT_DIR/_adf-to-md.js" 2>/dev/null || echo "$DESC_ADF"
    else
        # Fallback: plain text extraction from ADF
        echo "$DESC_ADF" | jq -r '.. | .text? // empty' 2>/dev/null | tr -s '\n'
    fi
fi

if [ "$SHOW_COMMENTS" = "true" ]; then
    COMMENTS=$("$SCRIPT_DIR/jira-api.sh" GET "/rest/api/3/issue/${ISSUE}/comment" 2>&1)
    if [ $? -ne 0 ]; then
        echo "WARNING: Could not fetch comments: ${COMMENTS}" >&2
    else
        echo ""
        echo "=== Comments ==="
        # Render each comment: header line + ADF body converted to markdown
        COMMENT_COUNT=$(echo "$COMMENTS" | jq '.comments | length' 2>/dev/null)
        COMMENT_COUNT=${COMMENT_COUNT:-0}
        if [ "$COMMENT_COUNT" -eq 0 ]; then
            echo "(no comments)"
        fi
        i=0
        while [ "$i" -lt "$COMMENT_COUNT" ]; do
            echo ""
            echo "$COMMENTS" | jq -r "\"--- \(.comments[$i].author.displayName) (\(.comments[$i].created)) ---\"" 2>/dev/null
            CBODY=$(echo "$COMMENTS" | jq ".comments[$i].body" 2>/dev/null)
            if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/_adf-to-md.js" ]; then
                echo "$CBODY" | node "$SCRIPT_DIR/_adf-to-md.js" 2>/dev/null || echo "$CBODY" | jq -r '.. | .text? // empty' 2>/dev/null
            else
                echo "$CBODY" | jq -r '.. | .text? // empty' 2>/dev/null | tr -s '\n'
            fi
            i=$((i + 1))
        done
    fi
fi
