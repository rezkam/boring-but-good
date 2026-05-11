#!/bin/bash
# List or run resource actions for an ArgoCD application
# Usage: argocd-app-actions.sh <app-name> --kind KIND --name RESOURCE_NAME [--run ACTION] [--namespace NS] [--group GROUP] [--project PROJECT]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

APP="" KIND="" RESOURCE_NAME="" NAMESPACE="" GROUP="" ACTION="" PROJECT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --kind)      KIND="$2"; shift 2 ;;
        --name)      RESOURCE_NAME="$2"; shift 2 ;;
        --namespace) NAMESPACE="$2"; shift 2 ;;
        --group)     GROUP="$2"; shift 2 ;;
        --run)       ACTION="$2"; shift 2 ;;
        --project)   PROJECT="$2"; shift 2 ;;
        -*)          echo "Usage: $0 <app-name> --kind KIND --name RESOURCE_NAME [--run ACTION] [--namespace NS] [--group GROUP] [--project PROJECT]" >&2; exit 1 ;;
        *)           APP="$1"; shift ;;
    esac
done

if [ -z "$APP" ] || [ -z "$KIND" ] || [ -z "$RESOURCE_NAME" ]; then
    echo "Usage: $0 <app-name> --kind KIND --name RESOURCE_NAME [--run ACTION] [--namespace NS] [--group GROUP] [--project PROJECT]" >&2
    echo "  List available actions: omit --run" >&2
    echo "  Run an action: include --run ACTION_NAME" >&2
    echo "  Example: $0 myapp --kind Deployment --name web --run restart" >&2
    exit 1
fi

QUERY="resourceName=${RESOURCE_NAME}&kind=${KIND}"
[ -n "$NAMESPACE" ] && QUERY="${QUERY}&namespace=${NAMESPACE}"
[ -n "$GROUP" ]     && QUERY="${QUERY}&group=${GROUP}"
[ -n "$PROJECT" ]   && QUERY="${QUERY}&project=${PROJECT}"

if [ -z "$ACTION" ]; then
    # List available actions
    RESULT=$(argocd_get "/api/v1/applications/${APP}/resource/actions?${QUERY}")
    echo "$RESULT" | jq -r '
        if (.actions // [] | length) == 0 then
            "No actions available for this resource."
        else
            "Available actions for \("'"${KIND}"'")/\("'"${RESOURCE_NAME}"'"):",
            (.actions[] | "  - \(.name)" + if .disabled then " (disabled)" else "" end)
        end
    '
else
    # Run the action
    BODY='{"action":"'"${ACTION}"'"}'
    RESULT=$(argocd_post "/api/v1/applications/${APP}/resource/actions?${QUERY}" "$BODY")
    echo "Action '${ACTION}' triggered on ${KIND}/${RESOURCE_NAME} in ${APP}."
fi
