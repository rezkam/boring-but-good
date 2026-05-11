#!/bin/bash
# Delete an ArgoCD application
# Usage: argocd-app-delete.sh <app-name> [--cascade] [--project PROJECT]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

APP="" CASCADE=true PROJECT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --cascade)    CASCADE=true; shift ;;
        --no-cascade) CASCADE=false; shift ;;
        --project)    PROJECT="$2"; shift 2 ;;
        -*)           echo "Usage: $0 <app-name> [--cascade|--no-cascade] [--project PROJECT]" >&2; exit 1 ;;
        *)            APP="$1"; shift ;;
    esac
done

if [ -z "$APP" ]; then
    echo "Usage: $0 <app-name> [--cascade|--no-cascade] [--project PROJECT]" >&2
    echo "  Delete an application. --cascade (default) also deletes Kubernetes resources." >&2
    echo "  --no-cascade removes the app from ArgoCD but keeps resources running." >&2
    exit 1
fi

QUERY="cascade=${CASCADE}"
[ -n "$PROJECT" ] && QUERY="${QUERY}&project=${PROJECT}"

argocd_delete "/api/v1/applications/${APP}?${QUERY}" > /dev/null
echo "Application '${APP}' deleted (cascade=${CASCADE})."
