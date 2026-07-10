#!/bin/bash
# List policy violations for a project
# Usage: dtrack-violations.sh <project-uuid> [--suppressed]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_UUID="${1:-}"; SUPPRESSED="false"
[[ "$2" == "--suppressed" ]] && SUPPRESSED="true"

[[ -z "$PROJECT_UUID" ]] && { echo "Usage: $0 <project-uuid> [--suppressed]" >&2; exit 1; }

"$SCRIPT_DIR/dtrack-api.sh" GET "/v1/violation/project/${PROJECT_UUID}?suppressed=${SUPPRESSED}&pageSize=100" | \
    jq '[.[] | {
        uuid, type,
        policyCondition: { policy: .policyCondition.policy.name, operator: .policyCondition.operator,
            subject: .policyCondition.subject, value: .policyCondition.value,
            violationType: .policyCondition.policy.violationState },
        component: { uuid: .component.uuid, name: .component.name, version: .component.version, purl: .component.purl }
    }]'
