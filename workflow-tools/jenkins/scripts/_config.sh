#!/bin/bash
# Jenkins configuration loader
set -e

_JENKINS_CONFIG_DIR="${JENKINS_CONFIG_DIR:-$HOME/.boring/jenkins}"

# Read URL from file
if [ -z "$JENKINS_URL" ] && [ -f "${_JENKINS_CONFIG_DIR}/url" ]; then
    JENKINS_URL=$(tr -d '[:space:]' < "${_JENKINS_CONFIG_DIR}/url")
fi

# Read user from file
if [ -z "$JENKINS_USER" ] && [ -f "${_JENKINS_CONFIG_DIR}/user" ]; then
    JENKINS_USER=$(tr -d '[:space:]' < "${_JENKINS_CONFIG_DIR}/user")
fi

# Read token from file
if [ -z "$JENKINS_TOKEN" ] && [ -f "${_JENKINS_CONFIG_DIR}/token" ]; then
    JENKINS_TOKEN=$(tr -d '[:space:]' < "${_JENKINS_CONFIG_DIR}/token")
fi

JENKINS_URL="${JENKINS_URL:-}"
JENKINS_USER="${JENKINS_USER:-}"
JENKINS_TOKEN="${JENKINS_TOKEN:-}"

if [ -z "$JENKINS_URL" ]; then
    cat >&2 <<EOF
ERROR: JENKINS_URL not set.

Context: Loading Jenkins configuration from ${_JENKINS_CONFIG_DIR}/

The Jenkins URL must be configured before any Jenkins operations can run.

Recovery:
  mkdir -p ${_JENKINS_CONFIG_DIR}
  echo 'https://your-jenkins.example.com' > ${_JENKINS_CONFIG_DIR}/url
  echo 'your-username' > ${_JENKINS_CONFIG_DIR}/user
  echo 'your-api-token' > ${_JENKINS_CONFIG_DIR}/token
  chmod 600 ${_JENKINS_CONFIG_DIR}/token

Or run the interactive setup: ./setup.sh
EOF
    exit 1
fi
if [ -z "$JENKINS_USER" ] || [ -z "$JENKINS_TOKEN" ]; then
    cat >&2 <<EOF
ERROR: JENKINS_USER and/or JENKINS_TOKEN not set.

Context: Loading Jenkins credentials from ${_JENKINS_CONFIG_DIR}/
  URL is configured: ${JENKINS_URL}
  User file: ${_JENKINS_CONFIG_DIR}/user $([ -f "${_JENKINS_CONFIG_DIR}/user" ] && echo "(exists)" || echo "(MISSING)")
  Token file: ${_JENKINS_CONFIG_DIR}/token $([ -f "${_JENKINS_CONFIG_DIR}/token" ] && echo "(exists)" || echo "(MISSING)")

Recovery:
  echo 'your-username' > ${_JENKINS_CONFIG_DIR}/user
  echo 'your-api-token' > ${_JENKINS_CONFIG_DIR}/token
  chmod 600 ${_JENKINS_CONFIG_DIR}/token

Generate an API token at: ${JENKINS_URL}/me/configure
Or run the interactive setup: ./setup.sh
EOF
    exit 1
fi
