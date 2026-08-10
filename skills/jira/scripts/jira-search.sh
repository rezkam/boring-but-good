#!/bin/bash
# Quick text search for Jira issues
# Usage: jira-search.sh <text> [--project KEY] [--limit N]
#
# Examples:
#   jira-search.sh "memory leak"
#   jira-search.sh "NPE" --project PROJ --limit 10

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_config.sh"

TEXT="${1:-}"
shift 2>/dev/null || true

PROJECT="${JIRA_PROJECT}" LIMIT="20"

while [ $# -gt 0 ]; do
    case "$1" in
        --project) PROJECT="$2"; shift 2 ;;
        --limit)   LIMIT="$2";   shift 2 ;;
        *)
            cat >&2 << EOF
ERROR: Unknown option '$1'.

Usage: jira-search.sh <text> [--project KEY] [--limit N]

Options:
  --project KEY   Search within a specific project (default: ${JIRA_PROJECT:-not set})
  --limit N       Max results (default: 20)

Examples:
  jira-search.sh "memory leak"
  jira-search.sh "NPE" --project PROJ --limit 10

For advanced queries, use jira-list.sh with --jql:
  jira-list.sh --jql "text ~ 'memory leak' AND status = 'In Progress'"
EOF
            exit 1
            ;;
    esac
done

if [ -z "$TEXT" ]; then
    cat >&2 << 'EOF'
ERROR: Missing search text.

Usage: jira-search.sh <text> [--project KEY] [--limit N]

The search text is matched against issue summary, description, and comments.

Examples:
  jira-search.sh "timeout"
  jira-search.sh "NullPointerException" --project PROJ
  jira-search.sh "customer reported" --limit 5

For structured queries, use jira-list.sh:
  jira-list.sh --jql "summary ~ 'timeout' AND status = 'In Progress'"
EOF
    exit 1
fi

JQL="text ~ \"${TEXT}\""
[ -n "$PROJECT" ] && JQL="project = ${PROJECT} AND ${JQL}"
JQL="${JQL} ORDER BY updated DESC"

# Build JSON payload for search (Jira Cloud deprecated GET /rest/api/3/search)
SEARCH_PAYLOAD=$(jq -n \
    --arg jql "$JQL" \
    --argjson max "$LIMIT" \
    '{jql: $jql, maxResults: $max, fields: ["key","summary","status","issuetype","updated"]}')

RESPONSE=$("$SCRIPT_DIR/jira-api.sh" POST "/rest/api/3/search/jql" "$SEARCH_PAYLOAD" 2>&1)
RC=$?

if [ $RC -ne 0 ]; then
    # Fallback: try the old endpoint (works on Jira Server/DC)
    ENCODED_JQL=$(printf '%s' "$JQL" | jq -sRr @uri)
    RESPONSE=$("$SCRIPT_DIR/jira-api.sh" GET "/rest/api/2/search?jql=${ENCODED_JQL}&maxResults=${LIMIT}&fields=key,summary,status,issuetype,updated" 2>&1)
    RC=$?
fi

if [ $RC -ne 0 ]; then
    cat >&2 << EOF
ERROR: Search failed.

Query: ${JQL}
Response: ${RESPONSE}

Common causes:
  - Auth expired: test with $SCRIPT_DIR/jira-api.sh GET /rest/api/3/myself
  - Project doesn't exist: check with $SCRIPT_DIR/jira-meta.sh types --project ${PROJECT}
EOF
    exit $RC
fi

RESULT=$(echo "$RESPONSE" | jq --arg text "$TEXT" '
    if .errorMessages then
        {error: .errorMessages}
    elif .issues then
        if (.issues | length) == 0 then
            {message: "No issues found matching the search.", search_text: $text}
        else
            [.issues[] | {
                key: .key,
                summary: .fields.summary,
                status: .fields.status.name,
                type: .fields.issuetype.name,
                updated: .fields.updated
            }]
        end
    else
        {error: "Unexpected response format", raw: .}
    end' 2>&1)
RC_JQ=$?

if [ $RC_JQ -ne 0 ] || [ -z "$RESULT" ]; then
    cat >&2 << EOF
ERROR: Could not parse Jira response.

jq exit code: ${RC_JQ}
jq output: ${RESULT}
Raw API response (first 500 chars): $(echo "$RESPONSE" | head -c 500)

Try the raw API to debug:
  $SCRIPT_DIR/jira-api.sh POST "/rest/api/3/search/jql" '{"jql":"text ~ \"${TEXT}\"","maxResults":5,"fields":["key","summary","status"]}'
EOF
    exit 1
fi

echo "$RESULT"
