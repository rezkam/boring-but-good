#!/bin/bash
# Jira defaults and authentication loader.
# go-jira normally reads ~/.jira.d/config.yml + the OS keyring. On macOS,
# its legacy keyring library cannot find the user's login keychain from some
# non-GUI sessions (notably SSH), so this file supplies a scoped fallback.
# Our defaults (project, assignee, labels) live in ~/.boring/jira/.

_JIRA_CONFIG_DIR="${JIRA_CONFIG_DIR:-$HOME/.boring/jira}"

JIRA_PROJECT="${JIRA_PROJECT:-}"
JIRA_ASSIGNEE="${JIRA_ASSIGNEE:-}"
JIRA_DEFAULT_LABELS="${JIRA_DEFAULT_LABELS:-}"

# Load defaults if file exists
if [ -f "${_JIRA_CONFIG_DIR}/defaults" ]; then
    . "${_JIRA_CONFIG_DIR}/defaults"
fi

# Also read default-labels file
if [ -z "$JIRA_DEFAULT_LABELS" ] && [ -f "${_JIRA_CONFIG_DIR}/default-labels" ]; then
    JIRA_DEFAULT_LABELS="$(cat "${_JIRA_CONFIG_DIR}/default-labels")"
fi

# Verify go-jira is installed
if ! command -v jira >/dev/null 2>&1; then
    cat >&2 << 'EOF'
ERROR: go-jira CLI is not installed.

go-jira is required for all Jira operations. It handles authentication
and API calls. The scripts in this skill are wrappers around it.

To install:
  macOS:   brew install go-jira
  Linux:   go install github.com/go-jira/jira/cmd/jira@latest

After installing, run setup.sh to configure authentication.

Docs: https://github.com/go-jira/jira
EOF
    exit 1
fi
_JIRA_CLI_BIN="$(command -v jira)"

# Verify go-jira is configured
if [ ! -f "$HOME/.jira.d/config.yml" ]; then
    cat >&2 << 'EOF'
ERROR: go-jira is not configured. Missing ~/.jira.d/config.yml

Run setup.sh to configure, or create manually:

  mkdir -p ~/.jira.d
  cat > ~/.jira.d/config.yml << 'CONF'
  endpoint: https://your-org.atlassian.net
  user: you@example.com
  password-source: keyring
  CONF

Then store the API token in your OS keychain:
  macOS: security add-generic-password -a "api-token:you@example.com" -s "go-jira" -U \
           "$HOME/Library/Keychains/login.keychain-db" -w
EOF
    exit 1
fi

# Read a top-level scalar from go-jira's simple YAML config. This intentionally
# handles only the scalar fields needed to locate credentials; go-jira remains
# responsible for parsing the complete configuration.
_jira_config_value() {
    local key="$1" file="$2"
    awk -v key="$key" '
        $0 ~ "^[[:space:]]*" key "[[:space:]]*:" {
            line = $0
            sub("^[[:space:]]*" key "[[:space:]]*:[[:space:]]*", "", line)
            sub("[[:space:]]+#.*$", "", line)
            sub("^[[:space:]]+", "", line)
            sub("[[:space:]]+$", "", line)
            if ((substr(line, 1, 1) == "\"" && substr(line, length(line), 1) == "\"") ||
                (substr(line, 1, 1) == "\047" && substr(line, length(line), 1) == "\047")) {
                line = substr(line, 2, length(line) - 2)
            }
            print line
            exit
        }
    ' "$file"
}

# Set a process-local token from a specific macOS Keychain item without
# printing it. Return 0 when loaded, 1 when absent, and 2 when inaccessible.
_jira_load_macos_keychain_item() {
    local security_bin="$1" service="$2" account="$3" keychain="$4" token=""

    if ! "$security_bin" find-generic-password \
        -s "$service" -a "$account" "$keychain" >/dev/null 2>&1; then
        return 1
    fi

    _JIRA_KEYCHAIN_ITEM_FOUND=1
    if ! token=$("$security_bin" find-generic-password \
        -s "$service" -a "$account" -w "$keychain" 2>/dev/null); then
        return 2
    fi
    if [ -z "$token" ]; then
        return 2
    fi

    _JIRA_RESOLVED_TOKEN="$token"
    token=""
    return 0
}

# Work around go-jira 1.x using `security find-generic-password` without an
# explicit keychain path. In SSH/non-GUI sessions that implicit search often
# contains only System.keychain even though the token exists in login.keychain.
_jira_prepare_auth() {
    [ "${_JIRA_AUTH_PREPARED:-0}" = "1" ] && return 0

    # go-jira already supports this environment variable for API-token auth.
    if [ -n "${JIRA_API_TOKEN:-}" ]; then
        _JIRA_AUTH_PREPARED=1
        return 0
    fi

    if [ "$(uname -s 2>/dev/null)" != "Darwin" ]; then
        _JIRA_AUTH_PREPARED=1
        return 0
    fi

    local config="$HOME/.jira.d/config.yml"
    local security_bin="${JIRA_SECURITY_BIN:-/usr/bin/security}"
    local endpoint identity auth_method account keychain endpoint_service

    [ -x "$security_bin" ] || {
        _JIRA_AUTH_PREPARED=1
        return 0
    }

    endpoint="$(_jira_config_value endpoint "$config")"
    identity="$(_jira_config_value login "$config")"
    [ -n "$identity" ] || identity="$(_jira_config_value user "$config")"
    auth_method="$(_jira_config_value authentication-method "$config" | tr '[:upper:]' '[:lower:]')"

    # JIRA_API_TOKEN is understood by go-jira only for API-token auth. Jira
    # Cloud defaults to that mode even when authentication-method is omitted.
    case "$auth_method" in
        api-token) ;;
        "") case "$endpoint" in *.atlassian.net*) ;; *) _JIRA_AUTH_PREPARED=1; return 0 ;; esac ;;
        *) _JIRA_AUTH_PREPARED=1; return 0 ;;
    esac

    [ -n "$identity" ] || {
        _JIRA_AUTH_PREPARED=1
        return 0
    }
    account="api-token:${identity}"

    # Preserve normal go-jira behavior whenever its implicit lookup can see
    # the canonical item (the common local desktop case).
    if "$security_bin" find-generic-password \
        -s "go-jira" -a "$account" >/dev/null 2>&1; then
        _JIRA_AUTH_PREPARED=1
        return 0
    fi

    keychain="${JIRA_KEYCHAIN_PATH:-}"
    if [ -z "$keychain" ]; then
        keychain=$("$security_bin" login-keychain -d user 2>/dev/null | \
            sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//' | head -1)
    fi
    [ -n "$keychain" ] || keychain="$HOME/Library/Keychains/login.keychain-db"

    _JIRA_KEYCHAIN_ITEM_FOUND=0

    if _jira_load_macos_keychain_item "$security_bin" "go-jira" "$account" "$keychain"; then
        _JIRA_AUTH_PREPARED=1
        return 0
    fi

    # Also recognize older/common endpoint-style entries so an existing token
    # does not need to be duplicated under the go-jira-specific item name.
    if [ "$account" != "$identity" ]; then
        if _jira_load_macos_keychain_item "$security_bin" "go-jira" "$identity" "$keychain"; then
            _JIRA_AUTH_PREPARED=1
            return 0
        fi
    fi

    endpoint_service="${endpoint%/}"
    if [ -n "$endpoint_service" ]; then
        if _jira_load_macos_keychain_item "$security_bin" "$endpoint_service" "$identity" "$keychain"; then
            _JIRA_AUTH_PREPARED=1
            return 0
        fi
    fi

    if [ "${_JIRA_KEYCHAIN_ITEM_FOUND:-0}" = "1" ]; then
        cat >&2 << EOF
ERROR: The Jira API token exists in macOS Keychain, but this session cannot read it.

This commonly happens over SSH when the login keychain is locked or has not
approved access for the session. Run this interactively, then retry the same
Jira skill command:

  security unlock-keychain "$keychain"

The skill will load the token without printing it.
EOF
    else
        cat >&2 << EOF
ERROR: Jira authentication is configured, but go-jira cannot see its API token.

Expected macOS Keychain item:
  service: go-jira
  account: $account
  keychain: $keychain

Store or update it interactively (the token is not echoed):

  security add-generic-password -a "$account" -s "go-jira" -U \\
    "$keychain" -w
EOF
    fi
    return 1
}

# Every Jira skill script calls `jira`; this function keeps those commands
# unchanged while making authentication deterministic in non-GUI sessions.
jira() {
    _jira_prepare_auth || return 1
    if [ -n "${_JIRA_RESOLVED_TOKEN:-}" ]; then
        JIRA_API_TOKEN="$_JIRA_RESOLVED_TOKEN" "$_JIRA_CLI_BIN" "$@"
    else
        "$_JIRA_CLI_BIN" "$@"
    fi
}
