#!/bin/bash
# Get project details and current vulnerability metrics
# Usage: dtrack-project-status.sh <project-uuid>
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_UUID="${1:-}"

[[ -z "$PROJECT_UUID" ]] && { echo "Usage: $0 <project-uuid>" >&2; exit 1; }

PROJECT=$("$SCRIPT_DIR/dtrack-api.sh" GET "/v1/project/${PROJECT_UUID}")
METRICS=$("$SCRIPT_DIR/dtrack-api.sh" GET "/v1/metrics/project/${PROJECT_UUID}/current" 2>/dev/null || echo '{}')

echo "$PROJECT" | jq --argjson m "$METRICS" '{
    uuid, name, version, description, active, classifier,
    lastBomImport, lastBomImportFormat,
    tags: [.tags[]?.name],
    metrics: (if $m != {} then {
        critical: $m.critical, high: $m.high, medium: $m.medium,
        low: $m.low, unassigned: $m.unassigned,
        vulnerabilities: $m.vulnerabilities, components: $m.components,
        suppressed: $m.suppressed,
        findingsTotal: $m.findingsTotal,
        findingsAudited: $m.findingsAudited,
        findingsUnaudited: $m.findingsUnaudited,
        policyViolationsTotal: $m.policyViolationsTotal,
        inheritedRiskScore: $m.inheritedRiskScore,
        firstOccurrence: $m.firstOccurrence,
        lastOccurrence: $m.lastOccurrence
    } else "No metrics available — try refreshing" end)
}'
