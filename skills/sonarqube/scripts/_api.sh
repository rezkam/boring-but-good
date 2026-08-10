#!/bin/bash
set -eo pipefail
# SonarQube HTTP helper — sourced by all scripts, single place for curl flags.
#
# Usage (after sourcing _config.sh):
#   source "$SCRIPT_DIR/_api.sh"
#   sonar_get "/api/issues/search?componentKeys=myproject"
#   sonar_post "/api/issues/do_transition" -d "issue=AY123&transition=resolve"
#   sonar_raw -X POST -w "%{http_code}" "${SONARQUBE_URL}/api/..."
#
# All functions follow redirects (-L) and carry auth automatically.
# Supports both bearer token and basic auth (token:) based on SONARQUBE_AUTH_METHOD.
# Transient failures (connection refused, timeout) are retried automatically.

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

# Internal: build auth flags for curl based on SONARQUBE_AUTH_METHOD.
_sonar_auth_flags() {
    case "${SONARQUBE_AUTH_METHOD:-token}" in
        bearer) echo "-H"; echo "Authorization: Bearer ${SONARQUBE_TOKEN}" ;;
        *)      echo "-u"; echo "${SONARQUBE_TOKEN}:" ;;
    esac
}

# GET request. Captures HTTP status code; returns body on success,
# structured error on failure. Does NOT use -f (callers get error context).
sonar_get() {
    local _endpoint="$1"; shift
    local _url="${SONARQUBE_URL}${_endpoint}"
    local _tmpfile _code _body _auth_flag _auth_val
    _tmpfile=$(mktemp)

    # Read auth flags
    case "${SONARQUBE_AUTH_METHOD:-token}" in
        bearer) _auth_flag="-H"; _auth_val="Authorization: Bearer ${SONARQUBE_TOKEN}" ;;
        *)      _auth_flag="-u"; _auth_val="${SONARQUBE_TOKEN}:" ;;
    esac

    _code=$(_retry_curl -sL \
        --connect-timeout "$_CURL_CONNECT_TIMEOUT" --max-time "$_CURL_MAX_TIME" \
        -w "%{http_code}" -o "$_tmpfile" \
        "$_auth_flag" "$_auth_val" "$_url" "$@") || _code="000"
    _body=$(cat "$_tmpfile"); rm -f "$_tmpfile"

    if [[ "$_code" -ge 200 && "$_code" -lt 300 ]]; then
        printf '%s' "$_body"
    else
        cat >&2 <<EOF
ERROR: SonarQube API returned HTTP ${_code}.

Context: GET ${_url}
Response: $(printf '%.500s' "$_body")

Common causes:
  - HTTP 401: token invalid or expired. Regenerate at SonarQube > My Account > Security > Tokens
  - HTTP 403: token lacks permission for this project. Check token scope
  - HTTP 404: project key or endpoint does not exist. Verify with sonarqube-projects.sh
  - HTTP 000: network unreachable or DNS failure. Check SONARQUBE_URL in ~/.boring/sonarqube/url

Recovery: verify connectivity with: sonarqube-api.sh /api/system/status
EOF
        return 1
    fi
}

# POST request, returns HTTP body + status code on last line.
# Caller splits with: body=$(sed '$d' <<< "$resp"); code=$(tail -1 <<< "$resp")
sonar_post() {
    local endpoint="$1"; shift
    case "${SONARQUBE_AUTH_METHOD:-token}" in
        bearer) _retry_curl -sL \
            --connect-timeout "$_CURL_CONNECT_TIMEOUT" --max-time "$_CURL_MAX_TIME" \
            -w "\n%{http_code}" -X POST \
            -H "Authorization: Bearer ${SONARQUBE_TOKEN}" "${SONARQUBE_URL}${endpoint}" "$@" ;;
        *) _retry_curl -sL \
            --connect-timeout "$_CURL_CONNECT_TIMEOUT" --max-time "$_CURL_MAX_TIME" \
            -w "\n%{http_code}" -X POST \
            -u "${SONARQUBE_TOKEN}:" "${SONARQUBE_URL}${endpoint}" "$@" ;;
    esac
}

# Raw curl with auth pre-filled. Caller controls all other flags.
sonar_raw() {
    case "${SONARQUBE_AUTH_METHOD:-token}" in
        bearer) _retry_curl -L \
            --connect-timeout "$_CURL_CONNECT_TIMEOUT" --max-time "$_CURL_MAX_TIME" \
            -H "Authorization: Bearer ${SONARQUBE_TOKEN}" "$@" ;;
        *) _retry_curl -L \
            --connect-timeout "$_CURL_CONNECT_TIMEOUT" --max-time "$_CURL_MAX_TIME" \
            -u "${SONARQUBE_TOKEN}:" "$@" ;;
    esac
}
