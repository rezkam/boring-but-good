#!/bin/bash
# Raw Jenkins API access
# Usage: jenkins-api.sh <endpoint> [curl-options...]
#
# Defaults to GET. If the caller passes -X <METHOD> (POST/PUT/DELETE/PATCH),
# the request is routed through jenkins_raw so the method override is honored
# and the response body is returned verbatim instead of being treated as a GET
# error. A CSRF crumb header is added for non-GET methods.
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_api.sh"

ENDPOINT="$1"; shift 2>/dev/null || true
[[ -z "$ENDPOINT" ]] && { echo "Usage: $0 <endpoint> [curl-options...]" >&2; exit 1; }

# Scan remaining args for a method override.
METHOD="GET"
prev=""
for arg in "$@"; do
    if [[ "$prev" == "-X" || "$prev" == "--request" ]]; then
        METHOD="${arg^^}"
        break
    fi
    prev="$arg"
done

if [[ "$METHOD" == "GET" ]]; then
    jenkins_get "$ENDPOINT" "$@"
else
    _jenkins_load_crumb
    CRUMB_ARGS=()
    [[ "$_JENKINS_CRUMB_HEADER" != "NONE" ]] && CRUMB_ARGS=(-H "$_JENKINS_CRUMB_HEADER")
    jenkins_raw "${CRUMB_ARGS[@]}" "${JENKINS_URL}${ENDPOINT}" "$@"
fi
