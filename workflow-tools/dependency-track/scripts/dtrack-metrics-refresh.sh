#!/bin/bash
# Trigger a metrics refresh for a project or the entire portfolio
# Usage: dtrack-metrics-refresh.sh [project-uuid]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_UUID="${1:-}"

if [[ -n "$PROJECT_UUID" ]]; then
    echo "Refreshing metrics for project ${PROJECT_UUID}..." >&2
    "$SCRIPT_DIR/dtrack-api.sh" GET "/v1/metrics/project/${PROJECT_UUID}/refresh" >/dev/null 2>&1 || true
    sleep 2
    "$SCRIPT_DIR/dtrack-project-status.sh" "$PROJECT_UUID"
else
    echo "Refreshing portfolio metrics..." >&2
    "$SCRIPT_DIR/dtrack-api.sh" GET "/v1/metrics/portfolio/refresh" >/dev/null 2>&1 || true
    echo "Portfolio metrics refresh triggered." >&2
fi
