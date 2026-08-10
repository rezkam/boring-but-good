#!/bin/bash
# Raw Dependency-Track API access
# Usage: dtrack-api.sh <METHOD> <endpoint> [curl-options...]
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_config.sh"

_CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-10}"
_CURL_MAX_TIME="${CURL_MAX_TIME:-30}"
_CURL_RETRIES="${CURL_RETRIES:-2}"

# Retry curl on transient transport failures (connection refused, timeout, empty reply, recv failure).
_retry_curl() {
    local _attempt=0 _max=$((_CURL_RETRIES + 1)) _wait=1 _rc=0
    while [ $_attempt -lt $_max ]; do
        _attempt=$((_attempt + 1))
        curl "$@" && return 0
        _rc=$?
        case $_rc in
            7|28|52|56)
                if [ $_attempt -lt $_max ]; then
                    echo "RETRY: curl failed (exit ${_rc}), attempt ${_attempt}/${_max}. Waiting ${_wait}s..." >&2
                    sleep $_wait
                    _wait=$((_wait * 2))
                    continue
                fi ;;
        esac
        return $_rc
    done
    return $_rc
}

METHOD="${1:-GET}"; ENDPOINT="$2"; shift 2 2>/dev/null || true

if [[ -z "$ENDPOINT" ]]; then
    echo "Usage: $0 <METHOD> <endpoint> [curl-options...]" >&2
    echo "  $0 GET /v1/project" >&2
    echo "  $0 PUT /v1/analysis -d '{...}'" >&2
    exit 1
fi

_URL="${DTRACK_URL}/api${ENDPOINT}"
_tmpfile=$(mktemp)
_code=$(_retry_curl -sL \
    --connect-timeout "$_CURL_CONNECT_TIMEOUT" --max-time "$_CURL_MAX_TIME" \
    -w "%{http_code}" -o "$_tmpfile" \
    -X "$METHOD" \
    -H "X-Api-Key: ${DTRACK_API_KEY}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    "$_URL" "$@") || _code="000"
_body=$(cat "$_tmpfile"); rm -f "$_tmpfile"

if [[ "$_code" -ge 200 && "$_code" -lt 300 ]]; then
    printf '%s' "$_body"
else
    cat >&2 <<EOF
ERROR: Dependency-Track API returned HTTP ${_code}.

Context: ${METHOD} ${_URL}
Response: $(printf '%.500s' "$_body")

Common causes:
  - HTTP 401: API key invalid or expired. Regenerate in Dependency-Track > Administration > Access Management
  - HTTP 403: API key lacks required permission (e.g., VIEW_PORTFOLIO, VULNERABILITY_ANALYSIS)
  - HTTP 404: project UUID or endpoint does not exist. Verify with dtrack-projects.sh
  - HTTP 000: network unreachable or DNS failure. Check DTRACK_URL in ~/.boring/dependency-track/url

Recovery: verify connectivity with: dtrack-api.sh GET /v1/project?limit=1
EOF
    exit 1
fi
