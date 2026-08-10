#!/bin/bash
# Sync an ArgoCD application
# Usage: argocd-app-sync.sh <app-name> [--revision REV] [--prune] [--dry-run] [--project PROJECT]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

APP="" REVISION="" PRUNE=false DRY_RUN=false PROJECT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --revision) REVISION="$2"; shift 2 ;;
        --prune)    PRUNE=true; shift ;;
        --dry-run)  DRY_RUN=true; shift ;;
        --project)  PROJECT="$2"; shift 2 ;;
        -*)         echo "Usage: $0 <app-name> [--revision REV] [--prune] [--dry-run] [--project PROJECT]" >&2; exit 1 ;;
        *)          APP="$1"; shift ;;
    esac
done

if [ -z "$APP" ]; then
    echo "Usage: $0 <app-name> [--revision REV] [--prune] [--dry-run] [--project PROJECT]" >&2
    echo "  Trigger a sync operation on an ArgoCD application." >&2
    exit 1
fi

# Build sync request body
BODY='{"prune":'"${PRUNE}"',"dryRun":'"${DRY_RUN}"
if [ -n "$REVISION" ]; then
    BODY="${BODY}"',"revision":"'"${REVISION}"'"'
fi
BODY="${BODY}"'}'

QUERY=""
[ -n "$PROJECT" ] && QUERY="?project=${PROJECT}"

RESULT=$(argocd_post "/api/v1/applications/${APP}/sync${QUERY}" "$BODY")
echo "$RESULT" | jq -r '
    "Sync triggered for: \(.metadata.name // "'"${APP}"'")",
    "",
    "Operation:",
    "  Phase:    \(.status.operationState.phase // "Pending")",
    "  Message:  \(.status.operationState.message // "Sync initiated")",
    "  Revision: \(.status.operationState.operation.sync.revision // "'"${REVISION:-HEAD}"'")",
    "  Prune:    '"${PRUNE}"'",
    "  Dry Run:  '"${DRY_RUN}"'",
    "",
    "Use argocd-app-wait.sh '"${APP}"' to watch progress."
'
