#!/bin/bash
# Raw ArgoCD API access
# Usage: argocd-api.sh <endpoint> [curl-options...]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

ENDPOINT="$1"; shift 2>/dev/null || true
if [ -z "$ENDPOINT" ]; then
    echo "Usage: $0 <endpoint> [curl-options...]" >&2
    echo "  Example: $0 /api/v1/applications" >&2
    echo "  Example: $0 /api/v1/session/userinfo" >&2
    exit 1
fi

argocd_get "$ENDPOINT" "$@"
