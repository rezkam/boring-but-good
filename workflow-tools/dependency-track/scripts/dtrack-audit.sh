#!/bin/bash
# Record an analysis decision on a vulnerability finding
# Usage: dtrack-audit.sh <project-uuid> <component-uuid> <vulnerability-uuid> --state <STATE> [options]
# States:         EXPLOITABLE | IN_TRIAGE | FALSE_POSITIVE | NOT_AFFECTED | RESOLVED | NOT_SET
# Justifications: CODE_NOT_PRESENT | CODE_NOT_REACHABLE | REQUIRES_CONFIGURATION | REQUIRES_DEPENDENCY |
#                 REQUIRES_ENVIRONMENT | PROTECTED_BY_COMPILER | PROTECTED_AT_RUNTIME |
#                 PROTECTED_AT_PERIMETER | PROTECTED_BY_MITIGATING_CONTROL | NOT_SET
# Responses:      CAN_NOT_FIX | WILL_NOT_FIX | UPDATE | ROLLBACK | WORKAROUND_AVAILABLE | NOT_SET
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

PROJECT_UUID="${1:-}"; COMPONENT_UUID="${2:-}"; VULNERABILITY_UUID="${3:-}"
shift 3 2>/dev/null || true

STATE=""; JUSTIFICATION=""; RESPONSE=""; COMMENT=""; DETAILS=""; SUPPRESS=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --state)         STATE="$2";         shift 2 ;;
        --justification) JUSTIFICATION="$2"; shift 2 ;;
        --response)      RESPONSE="$2";      shift 2 ;;
        --comment)       COMMENT="$2";       shift 2 ;;
        --details)       DETAILS="$2";       shift 2 ;;
        --suppress)      SUPPRESS="true";    shift ;;
        --unsuppress)    SUPPRESS="false";   shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$PROJECT_UUID" || -z "$COMPONENT_UUID" || -z "$VULNERABILITY_UUID" || -z "$STATE" ]]; then
    cat >&2 <<'EOF'
Usage: dtrack-audit.sh <project> <component> <vulnerability> --state STATE [opts]
  --justification JUST   Why not affected (CODE_NOT_PRESENT, CODE_NOT_REACHABLE, etc.)
  --response RESP        Resolution (UPDATE, ROLLBACK, WILL_NOT_FIX, etc.)
  --comment "text"       Audit comment
  --details "text"       Detailed analysis notes
  --suppress             Suppress finding    --unsuppress           Un-suppress finding
EOF
    exit 1
fi

PAYLOAD=$(jq -n \
    --arg p "$PROJECT_UUID" --arg c "$COMPONENT_UUID" --arg v "$VULNERABILITY_UUID" \
    --arg state "$STATE" --arg just "$JUSTIFICATION" --arg resp "$RESPONSE" \
    --arg comment "$COMMENT" --arg details "$DETAILS" --arg suppress "$SUPPRESS" \
    '{ project: $p, component: $c, vulnerability: $v, analysisState: $state }
    + (if $just != "" then {analysisJustification: $just} else {} end)
    + (if $resp != "" then {analysisResponse: $resp} else {} end)
    + (if $comment != "" then {comment: $comment} else {} end)
    + (if $details != "" then {analysisDetails: $details} else {} end)
    + (if $suppress == "true" then {isSuppressed: true} elif $suppress == "false" then {isSuppressed: false} else {} end)')

echo "Submitting analysis decision..." >&2
"$SCRIPT_DIR/dtrack-api.sh" PUT "/v1/analysis" -d "$PAYLOAD" | jq '{
    analysisState, analysisJustification, analysisResponse, analysisDetails, isSuppressed,
    comments: [.analysisComments[]? | { timestamp, commenter, comment }]
}'
