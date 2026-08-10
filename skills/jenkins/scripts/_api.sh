#!/bin/bash
set -eo pipefail
# Jenkins HTTP helper — sourced by all scripts, single place for curl flags.
#
# Usage (after sourcing _config.sh):
#   source "$SCRIPT_DIR/_api.sh"
#   jenkins_get  "/job/MyOrg/job/main/lastBuild/api/json?tree=result"
#   jenkins_post "/job/MyOrg/job/main/build"
#   jenkins_raw  -X POST -o /dev/null -w "%{http_code}" "${JENKINS_URL}/job/..."
#
# All functions follow redirects (-L) and carry auth automatically.
# Transient failures (connection refused, timeout) are retried automatically.
# All curl calls use -g (--globoff) to prevent curl from interpreting [ ] { }
# in URLs as glob patterns — Jenkins tree queries use these characters heavily.

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
# structured error on failure. Does NOT use -f (callers get error context).
jenkins_get() {
    local _url="${JENKINS_URL}$1"; shift
    local _tmpfile _code _body
    _tmpfile=$(mktemp)
    _code=$(_retry_curl -g -sL \
        --connect-timeout "$_CURL_CONNECT_TIMEOUT" --max-time "$_CURL_MAX_TIME" \
        -w "%{http_code}" -o "$_tmpfile" \
        -u "${JENKINS_USER}:${JENKINS_TOKEN}" "$_url" "$@") || _code="000"
    _body=$(cat "$_tmpfile"); rm -f "$_tmpfile"

    if [[ "$_code" -ge 200 && "$_code" -lt 300 ]]; then
        printf '%s' "$_body"
    else
        cat >&2 <<EOF
ERROR: Jenkins API returned HTTP ${_code}.

Context: GET ${_url}
Response: $(printf '%.500s' "$_body")

Common causes:
  - HTTP 401/403: credentials invalid or expired. Verify token in ~/.boring/jenkins/token
  - HTTP 404: job path does not exist. Check spelling, use jenkins-list-jobs.sh to browse
  - HTTP 000: network unreachable or DNS failure. Check JENKINS_URL in ~/.boring/jenkins/url

Recovery: verify connectivity with: jenkins-api.sh /api/json
EOF
        return 1
    fi
}

# Per-process cache for the CSRF crumb header. Resolved lazily on first POST.
# Set to literal "NONE" once we determine the Jenkins instance does not issue crumbs,
# so we don't keep refetching.
_JENKINS_CRUMB_HEADER=""

# Fetch a CSRF crumb header (form "Jenkins-Crumb:abc123…") if the instance issues
# them, or set the cache to "NONE" if /crumbIssuer is absent. Idempotent.
_jenkins_load_crumb() {
    [[ -n "$_JENKINS_CRUMB_HEADER" ]] && return 0
    local _body _code
    _body=$(_retry_curl -g -sL \
        --connect-timeout "$_CURL_CONNECT_TIMEOUT" --max-time "$_CURL_MAX_TIME" \
        -w "\n%{http_code}" \
        -u "${JENKINS_USER}:${JENKINS_TOKEN}" "${JENKINS_URL}/crumbIssuer/api/json" 2>/dev/null) || {
            _JENKINS_CRUMB_HEADER="NONE"
            return 0
        }
    _code="${_body##*$'\n'}"
    _body="${_body%$'\n'*}"
    if [[ "$_code" == "200" ]]; then
        # Parse without depending on jq/python being present.
        local _field _crumb
        _field=$(printf '%s' "$_body" | sed -n 's/.*"crumbRequestField"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
        _crumb=$(printf '%s' "$_body" | sed -n 's/.*"crumb"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
        if [[ -n "$_field" && -n "$_crumb" ]]; then
            _JENKINS_CRUMB_HEADER="${_field}:${_crumb}"
            return 0
        fi
    fi
    _JENKINS_CRUMB_HEADER="NONE"
}

# POST request, returns HTTP status code on stdout. On non-2xx the response body
# is printed to stderr (truncated to 500 chars) so callers can diagnose 4xx like
# "Nothing is submitted" instead of guessing from a bare status code.
# Includes a CSRF crumb header automatically when the Jenkins instance issues one.
# Does NOT use -f: callers check the returned status code themselves.
jenkins_post() {
    local _url="${JENKINS_URL}$1"; shift
    local _tmpfile _code
    _tmpfile=$(mktemp)
    _jenkins_load_crumb
    local _crumb_args=()
    [[ "$_JENKINS_CRUMB_HEADER" != "NONE" ]] && _crumb_args=(-H "$_JENKINS_CRUMB_HEADER")
    _code=$(_retry_curl -g -sL \
        --connect-timeout "$_CURL_CONNECT_TIMEOUT" --max-time "$_CURL_MAX_TIME" \
        -o "$_tmpfile" -w "%{http_code}" -X POST \
        "${_crumb_args[@]}" \
        -u "${JENKINS_USER}:${JENKINS_TOKEN}" "$_url" "$@") || _code="000"
    if [[ "$_code" -lt 200 || "$_code" -ge 300 ]]; then
        local _body
        _body=$(cat "$_tmpfile")
        if [[ -n "$_body" ]]; then
            printf 'Response body: %.500s\n' "$_body" >&2
        fi
    fi
    rm -f "$_tmpfile"
    printf '%s' "$_code"
}

# Raw curl with auth pre-filled. Caller controls all other flags.
jenkins_raw() {
    _retry_curl -g -L \
        --connect-timeout "$_CURL_CONNECT_TIMEOUT" --max-time "$_CURL_MAX_TIME" \
        -u "${JENKINS_USER}:${JENKINS_TOKEN}" "$@"
}
