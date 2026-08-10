#!/bin/bash
# List/search Jira issues using JQL
# Usage: jira-list.sh [--jql "query"] [--assignee me] [--status "status"] [--type "type"] [--project KEY] [--limit N]
#
# Examples:
#   jira-list.sh --assignee me --status "In Progress"
#   jira-list.sh --status "In Progress,In code review" --type Bug
#   jira-list.sh --jql "project = PROJ AND created >= -7d ORDER BY priority DESC"
#   jira-list.sh --project PROJ --limit 20

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_config.sh"

JQL="" ASSIGNEE="" STATUS="" TYPE="" PROJECT="${JIRA_PROJECT}" LIMIT="50"

while [ $# -gt 0 ]; do
    case "$1" in
        --jql)      JQL="$2";      shift 2 ;;
        --assignee) ASSIGNEE="$2"; shift 2 ;;
        --status)   STATUS="$2";   shift 2 ;;
        --type)     TYPE="$2";     shift 2 ;;
        --project)  PROJECT="$2";  shift 2 ;;
        --limit)    LIMIT="$2";    shift 2 ;;
        *)
            cat >&2 << EOF
ERROR: Unknown option '$1'.

Valid options:
  --jql "query"      Raw JQL query (overrides other filters)
  --assignee me      Filter by assignee ("me" = current user)
  --status "name"    Filter by status (comma-separated for multiple)
  --type "name"      Filter by issue type
  --project KEY      Project key (default: ${JIRA_PROJECT:-not set})
  --limit N          Max results (default: 50)

Examples:
  jira-list.sh --assignee me --status "In Progress"
  jira-list.sh --status "In Progress,In code review" --type Bug
  jira-list.sh --jql "project = PROJ AND created >= -7d ORDER BY priority DESC"
EOF
            exit 1
            ;;
    esac
done

# Build JQL if not provided directly
if [ -z "$JQL" ]; then
    PARTS=""
    if [ -n "$PROJECT" ]; then
        PARTS="project = ${PROJECT}"
    fi
    if [ -n "$ASSIGNEE" ]; then
        if [ "$ASSIGNEE" = "me" ]; then
            PARTS="${PARTS:+${PARTS} AND }assignee = currentUser()"
        else
            PARTS="${PARTS:+${PARTS} AND }assignee = \"${ASSIGNEE}\""
        fi
    fi
    if [ -n "$STATUS" ]; then
        # Support comma-separated statuses
        if echo "$STATUS" | grep -q ','; then
            STATUS_LIST=""
            IFS=',' read -ra STATUSES <<< "$STATUS"
            for s in "${STATUSES[@]}"; do
                s="$(echo "$s" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
                STATUS_LIST="${STATUS_LIST:+${STATUS_LIST},}\"${s}\""
            done
            PARTS="${PARTS:+${PARTS} AND }status in (${STATUS_LIST})"
        else
            PARTS="${PARTS:+${PARTS} AND }status = \"${STATUS}\""
        fi
    fi
    if [ -n "$TYPE" ]; then
        PARTS="${PARTS:+${PARTS} AND }issuetype = \"${TYPE}\""
    fi
    if [ -z "$PARTS" ]; then
        cat >&2 << EOF
ERROR: No search criteria provided and no default project configured.

Provide at least one filter or set a default project:
  echo "JIRA_PROJECT=PROJ" >> ~/.boring/jira/defaults

Examples:
  jira-list.sh --project PROJ
  jira-list.sh --assignee me
  jira-list.sh --jql "project = PROJ AND status = 'In Progress'"

To see valid statuses: $SCRIPT_DIR/jira-meta.sh statuses
To see valid types:    $SCRIPT_DIR/jira-meta.sh types
EOF
        exit 1
    fi
    JQL="${PARTS} ORDER BY updated DESC"
fi

# Build JSON payload for search (Jira Cloud deprecated GET /rest/api/3/search)
SEARCH_PAYLOAD=$(jq -n \
    --arg jql "$JQL" \
    --argjson max "$LIMIT" \
    '{jql: $jql, maxResults: $max, fields: ["key","summary","status","issuetype","priority","assignee","updated"]}')

RESPONSE=$("$SCRIPT_DIR/jira-api.sh" POST "/rest/api/3/search/jql" "$SEARCH_PAYLOAD" 2>&1)
RC=$?

if [ $RC -ne 0 ]; then
    # Fallback: try the old endpoint (works on Jira Server/DC)
    ENCODED_JQL=$(printf '%s' "$JQL" | jq -sRr @uri)
    RESPONSE=$("$SCRIPT_DIR/jira-api.sh" GET "/rest/api/2/search?jql=${ENCODED_JQL}&maxResults=${LIMIT}&fields=key,summary,status,issuetype,priority,assignee,updated" 2>&1)
    RC=$?
fi

if [ $RC -ne 0 ]; then
    cat >&2 << EOF
ERROR: Jira search failed.

JQL query: ${JQL}
API response: ${RESPONSE}

Common causes:
  - Invalid JQL syntax: check quoting and field names.
  - Unknown field or status name in query.
    To see valid statuses: $SCRIPT_DIR/jira-meta.sh statuses
    To see valid types:    $SCRIPT_DIR/jira-meta.sh types
  - Auth expired: test with $SCRIPT_DIR/jira-api.sh GET /rest/api/3/myself

JQL reference: https://support.atlassian.com/jira-service-management-cloud/docs/use-advanced-search-with-jira-query-language-jql/
EOF
    exit $RC
fi

# Parse and handle empty results gracefully
RESULT=$(echo "$RESPONSE" | jq --arg jql "$JQL" '
    if .errorMessages then
        {error: .errorMessages}
    elif .issues then
        if (.issues | length) == 0 then
            {message: "No issues found matching the query.", jql: $jql}
        else
            [.issues[] | {
                key: .key,
                summary: .fields.summary,
                status: .fields.status.name,
                type: .fields.issuetype.name,
                priority: .fields.priority.name,
                assignee: (.fields.assignee.displayName // "Unassigned"),
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

This usually means the API returned an unexpected format.
Try the raw API to debug:
  $SCRIPT_DIR/jira-api.sh POST "/rest/api/3/search/jql" '{"jql":"project = ${PROJECT:-PROJ}","maxResults":5,"fields":["key","summary","status"]}'
EOF
    exit 1
fi

echo "$RESULT"
