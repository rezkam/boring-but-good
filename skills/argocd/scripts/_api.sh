#!/bin/bash
set -eo pipefail
# ArgoCD HTTP helper — sourced by all scripts, single place for curl flags.
#
# Usage (after sourcing _config.sh):
#   source "$SCRIPT_DIR/_api.sh"
#   argocd_get  "/api/v1/applications"
#   argocd_post "/api/v1/applications/myapp/sync" '{"revision":"HEAD"}'
#   argocd_delete "/api/v1/applications/myapp"
#   argocd_raw  -X POST -o /dev/null "${ARGOCD_URL}/api/v1/..."
#
# All functions follow redirects (-L) and carry Bearer token auth automatically.
# Transient failures (connection refused, timeout) are retried automatically.
# All curl calls use -g (--globoff) to prevent curl from interpreting [ ] { }
# in URLs as glob patterns.

_CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-10}"
_CURL_MAX_TIME="${CURL_MAX_TIME:-30}"
_CURL_RETRIES="${CURL_RETRIES:-2}"

# Retry curl on transient transport failures (connection refused, timeout, empty reply, recv failure).
# Usage: _retry_curl [curl-args...]
_retry_curl() {
    local _attempt=0 _max=$((_CURL_RETRIES + 1)) _wait=1 _rc=0
    while [ $_attempt -lt $_max ]; do
        _attempt=$((_attempt + 1))
        curl "$@" && return 0
        _rc=$?
        # Retry only on transport-level failures
        case $_rc in
            7|28|52|56)  # 7=connect refused, 28=timeout, 52=empty reply, 56=recv failure
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

# GET request. Captures HTTP status code; returns body on success,
# structured error on failure.
argocd_get() {
    local _url="${ARGOCD_URL}$1"; shift
    local _tmpfile _code _body
    _tmpfile=$(mktemp)
    _code=$(_retry_curl -g -sL \
        --connect-timeout "$_CURL_CONNECT_TIMEOUT" --max-time "$_CURL_MAX_TIME" \
        -w "%{http_code}" -o "$_tmpfile" \
        -H "Authorization: Bearer ${ARGOCD_TOKEN}" \
        -H "Content-Type: application/json" \
        "$_url" "$@") || _code="000"
    _body=$(cat "$_tmpfile"); rm -f "$_tmpfile"

    if [ "$_code" -ge 200 ] && [ "$_code" -lt 300 ]; then
        printf '%s' "$_body"
    else
        cat >&2 <<EOF
ERROR: ArgoCD API returned HTTP ${_code}.

Context: GET ${_url}
Response: $(printf '%.500s' "$_body")

Common causes:
  - HTTP 401/403: token invalid or expired. Regenerate with: argocd account generate-token
  - HTTP 404: resource not found. Check application/project name
  - HTTP 000: network unreachable or DNS failure. Check ARGOCD_URL in ~/.boring/argocd/url

Recovery: verify connectivity with: argocd-api.sh /api/v1/session/userinfo
EOF
        return 1
    fi
}

# POST request with optional JSON body. Returns response body on success.
argocd_post() {
    local _endpoint="$1"; shift
    local _data="${1:-}"; [ -n "$_data" ] && shift
    local _url="${ARGOCD_URL}${_endpoint}"
    local _tmpfile _code _body
    _tmpfile=$(mktemp)

    local _curl_args=(-g -sL \
        --connect-timeout "$_CURL_CONNECT_TIMEOUT" --max-time "$_CURL_MAX_TIME" \
        -w "%{http_code}" -o "$_tmpfile" \
        -X POST \
        -H "Authorization: Bearer ${ARGOCD_TOKEN}" \
        -H "Content-Type: application/json")

    if [ -n "$_data" ]; then
        _curl_args+=(-d "$_data")
    fi

    _code=$(_retry_curl "${_curl_args[@]}" "$_url" "$@") || _code="000"
    _body=$(cat "$_tmpfile"); rm -f "$_tmpfile"

    if [ "$_code" -ge 200 ] && [ "$_code" -lt 300 ]; then
        printf '%s' "$_body"
    else
        cat >&2 <<EOF
ERROR: ArgoCD API returned HTTP ${_code}.

Context: POST ${_url}
Response: $(printf '%.500s' "$_body")

Common causes:
  - HTTP 401/403: token invalid or expired
  - HTTP 404: resource not found
  - HTTP 400: invalid request body

Recovery: verify connectivity with: argocd-api.sh /api/v1/session/userinfo
EOF
        return 1
    fi
}

# PUT request with JSON body. Returns response body on success.
argocd_put() {
    local _endpoint="$1"; shift
    local _data="${1:-}"; [ -n "$_data" ] && shift
    local _url="${ARGOCD_URL}${_endpoint}"
    local _tmpfile _code _body
    _tmpfile=$(mktemp)

    local _curl_args=(-g -sL \
        --connect-timeout "$_CURL_CONNECT_TIMEOUT" --max-time "$_CURL_MAX_TIME" \
        -w "%{http_code}" -o "$_tmpfile" \
        -X PUT \
        -H "Authorization: Bearer ${ARGOCD_TOKEN}" \
        -H "Content-Type: application/json")

    if [ -n "$_data" ]; then
        _curl_args+=(-d "$_data")
    fi

    _code=$(_retry_curl "${_curl_args[@]}" "$_url" "$@") || _code="000"
    _body=$(cat "$_tmpfile"); rm -f "$_tmpfile"

    if [ "$_code" -ge 200 ] && [ "$_code" -lt 300 ]; then
        printf '%s' "$_body"
    else
        cat >&2 <<EOF
ERROR: ArgoCD API returned HTTP ${_code}.

Context: PUT ${_url}
Response: $(printf '%.500s' "$_body")

Common causes:
  - HTTP 401/403: token invalid or expired
  - HTTP 404: resource not found
  - HTTP 400/422: invalid request body

Recovery: verify connectivity with: argocd-api.sh /api/v1/session/userinfo
EOF
        return 1
    fi
}

# DELETE request. Returns response body on success.
argocd_delete() {
    local _url="${ARGOCD_URL}$1"; shift
    local _tmpfile _code _body
    _tmpfile=$(mktemp)
    _code=$(_retry_curl -g -sL \
        --connect-timeout "$_CURL_CONNECT_TIMEOUT" --max-time "$_CURL_MAX_TIME" \
        -w "%{http_code}" -o "$_tmpfile" \
        -X DELETE \
        -H "Authorization: Bearer ${ARGOCD_TOKEN}" \
        -H "Content-Type: application/json" \
        "$_url" "$@") || _code="000"
    _body=$(cat "$_tmpfile"); rm -f "$_tmpfile"

    if [ "$_code" -ge 200 ] && [ "$_code" -lt 300 ]; then
        printf '%s' "$_body"
    else
        cat >&2 <<EOF
ERROR: ArgoCD API returned HTTP ${_code}.

Context: DELETE ${_url}
Response: $(printf '%.500s' "$_body")

Common causes:
  - HTTP 401/403: token invalid or insufficient RBAC permissions
  - HTTP 404: resource not found

Recovery: verify connectivity with: argocd-api.sh /api/v1/session/userinfo
EOF
        return 1
    fi
}

# Raw curl with auth pre-filled. Caller controls all other flags.
argocd_raw() {
    _retry_curl -g -L \
        --connect-timeout "$_CURL_CONNECT_TIMEOUT" --max-time "$_CURL_MAX_TIME" \
        -H "Authorization: Bearer ${ARGOCD_TOKEN}" \
        -H "Content-Type: application/json" \
        "$@"
}
