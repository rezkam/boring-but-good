#!/bin/bash
# Fetch project metadata — issue types, transitions, priorities, statuses
# Results are cached in ~/.boring/jira/cache/ and refreshed when older than 24h.
#
# Usage:
#   jira-meta.sh types [--project KEY]           # list issue types
#   jira-meta.sh transitions <issue-key>         # list transitions for an issue
#   jira-meta.sh statuses [--project KEY]        # list all statuses
#   jira-meta.sh priorities                      # list priorities
#   jira-meta.sh fields                          # list all fields
#   jira-meta.sh refresh [--project KEY]         # force refresh cache

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_config.sh"

CACHE_DIR="$HOME/.boring/jira/cache"
CACHE_TTL=86400  # 24 hours in seconds
mkdir -p "$CACHE_DIR"

_cache_file() { echo "${CACHE_DIR}/$1"; }

_cache_fresh() {
    local file="$1"
    if [ ! -f "$file" ]; then return 1; fi
    local now file_age
    now=$(date +%s)
    if stat -f %m "$file" >/dev/null 2>&1; then
        file_age=$(stat -f %m "$file")  # macOS
    else
        file_age=$(stat -c %Y "$file")  # Linux
    fi
    [ $((now - file_age)) -lt $CACHE_TTL ]
}

ACTION="${1:-}"
shift 2>/dev/null || true

PROJECT="${JIRA_PROJECT}"
ISSUE=""
FORCE=false

while [ $# -gt 0 ]; do
    case "$1" in
        --project) PROJECT="$2"; shift 2 ;;
        --force)   FORCE=true;   shift ;;
        *)         ISSUE="$1";   shift ;;
    esac
done

case "$ACTION" in
types)
    if [ -z "$PROJECT" ]; then
        cat >&2 << 'EOF'
ERROR: Project key is required to list issue types.

Usage:
  jira-meta.sh types --project KEY
  jira-meta.sh types                    (uses default project from ~/.boring/jira/defaults)

To set a default project:
  echo "JIRA_PROJECT=PROJ" >> ~/.boring/jira/defaults

This fetches the valid issue types you can use with jira-create.sh --type.
EOF
        exit 1
    fi
    CACHE=$(_cache_file "types_${PROJECT}.json")
    if [ "$FORCE" = "true" ] || ! _cache_fresh "$CACHE"; then
        RESPONSE=$("$SCRIPT_DIR/jira-api.sh" GET "/rest/api/3/project/${PROJECT}" 2>&1)
        RC=$?
        if [ $RC -ne 0 ]; then
            cat >&2 << EOF
ERROR: Failed to fetch issue types for project ${PROJECT}.

API response: ${RESPONSE}

Common causes:
  - Project key '${PROJECT}' does not exist. Project keys are case-sensitive (e.g. PROJ, not proj).
  - Permission denied: you may not have access to this project.
  - Auth expired: test with $SCRIPT_DIR/jira-api.sh GET /rest/api/3/myself
EOF
            exit $RC
        fi
        echo "$RESPONSE" | jq '[.issueTypes[]? | {name: .name, description: .description, subtask: .subtask}]' > "$CACHE" 2>/dev/null
        if [ ! -s "$CACHE" ]; then
            cat >&2 << EOF
ERROR: Could not parse issue types from API response for project ${PROJECT}.

The API returned data but it didn't contain issueTypes. This can happen with
older Jira Server versions. Try the createmeta endpoint instead:
  $SCRIPT_DIR/jira-api.sh GET "/rest/api/2/issue/createmeta?projectKeys=${PROJECT}"

Or use go-jira directly:
  jira issuetypes -p ${PROJECT}
EOF
            exit 1
        fi
    fi
    cat "$CACHE"
    ;;

transitions)
    if [ -z "$ISSUE" ]; then
        cat >&2 << 'EOF'
ERROR: Issue key is required to list transitions.

Usage: jira-meta.sh transitions <issue-key>

Transitions are the available actions to move an issue from its current status.
They depend on the issue's current state (workflow).

Example:
  jira-meta.sh transitions PROJ-123

To then perform a transition:
  jira-transition.sh PROJ-123 "Start progress"
EOF
        exit 1
    fi
    RESPONSE=$("$SCRIPT_DIR/jira-api.sh" GET "/rest/api/3/issue/${ISSUE}/transitions" 2>&1)
    RC=$?
    if [ $RC -ne 0 ]; then
        cat >&2 << EOF
ERROR: Failed to fetch transitions for ${ISSUE}.

API response: ${RESPONSE}

The issue key might not exist. Verify with:
  $SCRIPT_DIR/jira-view.sh ${ISSUE}
EOF
        exit $RC
    fi
    echo "$RESPONSE" | jq '[.transitions[] | {id: .id, name: .name, to: .to.name}]'
    ;;

statuses)
    if [ -z "$PROJECT" ]; then
        cat >&2 << 'EOF'
ERROR: Project key is required to list statuses.

Usage:
  jira-meta.sh statuses --project KEY
  jira-meta.sh statuses                 (uses default project from ~/.boring/jira/defaults)

This shows all possible statuses in the project's workflow.
Note: not all statuses may be reachable from every issue state.
Use 'jira-meta.sh transitions ISSUE-KEY' to see what moves are available.
EOF
        exit 1
    fi
    CACHE=$(_cache_file "statuses_${PROJECT}.json")
    if [ "$FORCE" = "true" ] || ! _cache_fresh "$CACHE"; then
        RESPONSE=$("$SCRIPT_DIR/jira-api.sh" GET "/rest/api/3/project/${PROJECT}/statuses" 2>&1)
        RC=$?
        if [ $RC -ne 0 ]; then
            cat >&2 << EOF
ERROR: Failed to fetch statuses for project ${PROJECT}.

API response: ${RESPONSE}

Trying fallback endpoint...
EOF
            RESPONSE=$("$SCRIPT_DIR/jira-api.sh" GET "/rest/api/3/status" 2>&1) || true
            # Fallback endpoint returns different shape: [{"name":"...", "statusCategory":{...}}, ...]
            echo "$RESPONSE" | jq '[.[].name] | unique' > "$CACHE" 2>/dev/null
        else
            # Primary endpoint: [{"id":"...", "statuses":[{"name":"..."}, ...]}, ...]
            echo "$RESPONSE" | jq '[.[].statuses[]? | .name] | unique' > "$CACHE" 2>/dev/null
        fi
        if [ ! -s "$CACHE" ]; then
            cat >&2 << EOF
ERROR: Could not parse statuses for project ${PROJECT}.

Try fetching directly:
  $SCRIPT_DIR/jira-api.sh GET "/rest/api/3/project/${PROJECT}/statuses"
EOF
            exit 1
        fi
    fi
    cat "$CACHE"
    ;;

priorities)
    CACHE=$(_cache_file "priorities.json")
    if [ "$FORCE" = "true" ] || ! _cache_fresh "$CACHE"; then
        RESPONSE=$("$SCRIPT_DIR/jira-api.sh" GET "/rest/api/3/priority" 2>&1)
        RC=$?
        if [ $RC -ne 0 ]; then
            cat >&2 << EOF
ERROR: Failed to fetch priorities.

API response: ${RESPONSE}

This usually means auth has expired. Test with:
  $SCRIPT_DIR/jira-api.sh GET /rest/api/3/myself
EOF
            exit $RC
        fi
        echo "$RESPONSE" | jq '[.[] | {name: .name, id: .id}]' > "$CACHE" 2>/dev/null
    fi
    cat "$CACHE"
    ;;

fields)
    CACHE=$(_cache_file "fields.json")
    if [ "$FORCE" = "true" ] || ! _cache_fresh "$CACHE"; then
        RESPONSE=$("$SCRIPT_DIR/jira-api.sh" GET "/rest/api/3/field" 2>&1)
        RC=$?
        if [ $RC -ne 0 ]; then
            cat >&2 << EOF
ERROR: Failed to fetch fields.

API response: ${RESPONSE}
EOF
            exit $RC
        fi
        echo "$RESPONSE" | jq '[.[] | {id: .id, name: .name, custom: .custom}]' > "$CACHE" 2>/dev/null
    fi
    cat "$CACHE"
    ;;

refresh)
    rm -f "${CACHE_DIR}"/*.json "${CACHE_DIR}"/*.txt 2>/dev/null
    REFRESHED="cache cleared"
    if [ -n "$PROJECT" ]; then
        "$0" types --project "$PROJECT" --force >/dev/null 2>&1 && REFRESHED="${REFRESHED}, types"
        "$0" statuses --project "$PROJECT" --force >/dev/null 2>&1 && REFRESHED="${REFRESHED}, statuses"
    fi
    "$0" priorities --force >/dev/null 2>&1 && REFRESHED="${REFRESHED}, priorities"
    echo "Cache refreshed: ${REFRESHED}"
    ;;

*)
    cat >&2 << 'EOF'
ERROR: Missing or unknown action.

Usage: jira-meta.sh <action> [options]

Actions:
  types [--project KEY]           List issue types (for jira-create.sh --type)
  transitions <issue-key>         List available transitions (for jira-transition.sh)
  statuses [--project KEY]        List all statuses in the workflow
  priorities                      List priority levels (for --priority flag)
  fields                          List all fields (system + custom)
  refresh [--project KEY]         Clear cache and re-fetch metadata

Metadata is cached in ~/.boring/jira/cache/ for 24 hours.
Use --force or 'refresh' to update sooner.

Examples:
  jira-meta.sh types --project PROJ
  jira-meta.sh transitions PROJ-123
  jira-meta.sh priorities
  jira-meta.sh refresh --project PROJ
EOF
    exit 1
    ;;
esac
