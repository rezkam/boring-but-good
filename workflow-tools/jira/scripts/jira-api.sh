#!/bin/bash
# Raw Jira REST API access via go-jira
# Usage: jira-api.sh <METHOD> <endpoint> [json-body]
#
# Examples:
#   jira-api.sh GET /rest/api/3/myself
#   jira-api.sh GET "/rest/api/3/issue/PROJ-123"
#   jira-api.sh POST /rest/api/3/issue '{"fields":{...}}'
#   jira-api.sh PUT "/rest/api/3/issue/PROJ-123" '{"fields":{"summary":"New"}}'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_config.sh"

METHOD="${1:-}"
ENDPOINT="${2:-}"
shift 2 2>/dev/null || true

# Detect common curl/wget flags passed by mistake
DATA=""
for arg in "$@"; do
    case "$arg" in
        -d|--data|--json|-H|--header)
            cat >&2 << EOF
ERROR: '${arg}' is a curl flag, not supported here.

This script uses go-jira, not curl. Pass JSON as the 3rd positional argument:

  jira-api.sh PUT "/rest/api/3/issue/PROJ-123" '{"fields":{"summary":"New title"}}'

Not:
  jira-api.sh PUT "/rest/api/3/issue/PROJ-123" --data '{"fields":{...}}'
  jira-api.sh PUT "/rest/api/3/issue/PROJ-123" -d '{"fields":{...}}'
EOF
            exit 1
            ;;
        *)
            [ -z "$DATA" ] && DATA="$arg"
            ;;
    esac
done

if [ -z "$METHOD" ] || [ -z "$ENDPOINT" ]; then
    cat >&2 << 'EOF'
ERROR: Missing required arguments.

Usage: jira-api.sh <METHOD> <endpoint> [json-body]

Arguments:
  METHOD    HTTP method: GET, POST, PUT, DELETE
  endpoint  Jira REST API path (must start with /)
  json-body Optional JSON payload for POST/PUT requests

Examples:
  jira-api.sh GET /rest/api/3/myself
  jira-api.sh GET "/rest/api/3/issue/PROJ-123"
  jira-api.sh POST /rest/api/3/issue '{"fields":{"project":{"key":"PROJ"},"issuetype":{"name":"Bug"},"summary":"Title"}}'
  jira-api.sh PUT "/rest/api/3/issue/PROJ-123" '{"fields":{"summary":"Updated title"}}'
  jira-api.sh DELETE "/rest/api/3/issue/PROJ-123"

Jira REST API docs:
  Cloud:     https://developer.atlassian.com/cloud/jira/platform/rest/v3/
  Server/DC: https://docs.atlassian.com/software/jira/docs/api/REST/latest/
EOF
    exit 1
fi

# Validate method
case "$METHOD" in
    GET|POST|PUT|DELETE|PATCH) ;;
    *)
        cat >&2 << EOF
ERROR: Invalid HTTP method '${METHOD}'.

Valid methods: GET, POST, PUT, DELETE, PATCH

Example: jira-api.sh GET /rest/api/3/myself
EOF
        exit 1
        ;;
esac

# Validate endpoint starts with /
case "$ENDPOINT" in
    /*) ;;
    *)
        cat >&2 << EOF
ERROR: Endpoint must start with '/'. Got: ${ENDPOINT}

The endpoint is the API path, not a full URL. go-jira adds the base URL automatically.

Examples:
  /rest/api/3/myself
  /rest/api/3/issue/PROJ-123
  /rest/api/3/search?jql=project%3DPROJ
EOF
        exit 1
        ;;
esac

if [ -n "$DATA" ]; then
    OUTPUT=$(jira request -M "$METHOD" "$ENDPOINT" "$DATA" 2>&1)
else
    OUTPUT=$(jira request -M "$METHOD" "$ENDPOINT" 2>&1)
fi

RC=$?
if [ $RC -ne 0 ]; then
    cat >&2 << EOF
ERROR: Jira API request failed (exit code ${RC}).

Request: ${METHOD} ${ENDPOINT}
Response: ${OUTPUT}

Common causes:
  - 401 Unauthorized: API token expired or invalid. Re-run setup or check keychain.
  - 403 Forbidden: User lacks permission for this operation.
  - 404 Not Found: Issue key or endpoint doesn't exist. Check the path.
  - 400 Bad Request: Invalid JSON body or field values.

To test auth: jira-api.sh GET /rest/api/3/myself
EOF
    exit $RC
fi

echo "$OUTPUT"
