#!/bin/bash
# SonarQube configuration loader
set -e

_SONAR_CONFIG_DIR="${SONAR_CONFIG_DIR:-$HOME/.boring/sonarqube}"

# Read URL from file
if [ -z "$SONARQUBE_URL" ] && [ -f "${_SONAR_CONFIG_DIR}/url" ]; then
    SONARQUBE_URL=$(tr -d '[:space:]' < "${_SONAR_CONFIG_DIR}/url")
fi

SONARQUBE_URL="${SONARQUBE_URL:-}"
SONARQUBE_TOKEN_FILE="${SONARQUBE_TOKEN_FILE:-${_SONAR_CONFIG_DIR}/token}"

if [ -z "$SONARQUBE_URL" ]; then
    cat >&2 <<EOF
ERROR: SONARQUBE_URL not set.

Context: Loading SonarQube configuration from ${_SONAR_CONFIG_DIR}/

The SonarQube server URL must be configured before any SonarQube operations can run.

Recovery:
  mkdir -p ${_SONAR_CONFIG_DIR}
  echo 'https://your-sonarqube.example.com' > ${_SONAR_CONFIG_DIR}/url
  echo 'your-user-token' > ${_SONAR_CONFIG_DIR}/token
  chmod 600 ${_SONAR_CONFIG_DIR}/token

Or run the interactive setup: ./setup.sh
EOF
    exit 1
fi

if [ ! -f "$SONARQUBE_TOKEN_FILE" ]; then
    cat >&2 <<EOF
ERROR: Token file not found at ${SONARQUBE_TOKEN_FILE}

Context: Loading SonarQube token for ${SONARQUBE_URL}

Recovery:
  mkdir -p ${_SONAR_CONFIG_DIR}
  echo 'your-user-token' > ${SONARQUBE_TOKEN_FILE}
  chmod 600 ${SONARQUBE_TOKEN_FILE}

Generate a token at: ${SONARQUBE_URL}/account/security
Or run the interactive setup: ./setup.sh
EOF
    exit 1
fi

SONARQUBE_TOKEN=$(tr -d '[:space:]' < "$SONARQUBE_TOKEN_FILE")
if [ -z "$SONARQUBE_TOKEN" ]; then
    cat >&2 <<EOF
ERROR: Token file is empty at ${SONARQUBE_TOKEN_FILE}

Context: Loading SonarQube token for ${SONARQUBE_URL}

The file exists but contains no token value.

Recovery:
  echo 'your-user-token' > ${SONARQUBE_TOKEN_FILE}
  chmod 600 ${SONARQUBE_TOKEN_FILE}

Generate a token at: ${SONARQUBE_URL}/account/security
EOF
    exit 1
fi

# Read auth method from file (default: token-as-login)
if [ -z "${SONARQUBE_AUTH_METHOD:-}" ] && [ -f "${_SONAR_CONFIG_DIR}/auth_method" ]; then
    SONARQUBE_AUTH_METHOD=$(tr -d '[:space:]' < "${_SONAR_CONFIG_DIR}/auth_method")
fi
SONARQUBE_AUTH_METHOD="${SONARQUBE_AUTH_METHOD:-token}"
