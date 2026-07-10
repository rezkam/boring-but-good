#!/bin/bash
# Jira defaults loader — no credentials here.
# Auth is handled by go-jira via ~/.jira.d/config.yml + Keychain.
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
  macOS: security add-generic-password -a "api-token:you@example.com" -s "go-jira" -w "YOUR_TOKEN"
EOF
    exit 1
fi
