#!/bin/bash
# Upload a BOM (SBOM) to a project
# Usage: dtrack-bom-upload.sh <project-uuid> <bom-file> [--auto-create]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"

PROJECT_UUID="${1:-}"; BOM_FILE="${2:-}"; AUTO_CREATE="false"
shift 2 2>/dev/null || true
[[ "$1" == "--auto-create" ]] && AUTO_CREATE="true"

if [[ -z "$PROJECT_UUID" || -z "$BOM_FILE" ]]; then
    echo "Usage: $0 <project-uuid> <bom-file> [--auto-create]" >&2; exit 1
fi
[[ ! -f "$BOM_FILE" ]] && { echo "Error: File not found: $BOM_FILE" >&2; exit 1; }

BOM_CONTENT=$(base64 < "$BOM_FILE" | tr -d '\n')
PAYLOAD=$(jq -n --arg p "$PROJECT_UUID" --arg b "$BOM_CONTENT" --arg a "$AUTO_CREATE" \
    '{ project: $p, bom: $b, autoCreate: ($a == "true") }')

echo "Uploading BOM..." >&2
"$SCRIPT_DIR/dtrack-api.sh" PUT "/v1/bom" -d "$PAYLOAD" | jq '.'
echo "BOM uploaded. Metrics will update after processing." >&2
