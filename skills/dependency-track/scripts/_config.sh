#!/bin/bash
# Dependency-Track configuration loader
set -e

_DTRACK_CONFIG_DIR="${DTRACK_CONFIG_DIR:-$HOME/.boring/dependency-track}"

# Read URL from file
if [ -z "$DTRACK_URL" ] && [ -f "${_DTRACK_CONFIG_DIR}/url" ]; then
    DTRACK_URL=$(tr -d '[:space:]' < "${_DTRACK_CONFIG_DIR}/url")
fi

DTRACK_URL="${DTRACK_URL:-}"
DTRACK_API_KEY_FILE="${DTRACK_API_KEY_FILE:-${_DTRACK_CONFIG_DIR}/apikey}"

if [ -z "$DTRACK_URL" ]; then
    cat >&2 <<EOF
ERROR: DTRACK_URL not set.

Context: Loading Dependency-Track configuration from ${_DTRACK_CONFIG_DIR}/

The Dependency-Track server URL must be configured before any operations can run.

Recovery:
  mkdir -p ${_DTRACK_CONFIG_DIR}
  echo 'https://your-dtrack.example.com' > ${_DTRACK_CONFIG_DIR}/url
  echo 'your-api-key' > ${_DTRACK_CONFIG_DIR}/apikey
  chmod 600 ${_DTRACK_CONFIG_DIR}/apikey

Or run the interactive setup: ./setup.sh
EOF
    exit 1
fi

if [ ! -f "$DTRACK_API_KEY_FILE" ]; then
    cat >&2 <<EOF
ERROR: API key file not found at ${DTRACK_API_KEY_FILE}

Context: Loading Dependency-Track API key for ${DTRACK_URL}

Recovery:
  mkdir -p ${_DTRACK_CONFIG_DIR}
  echo 'your-api-key' > ${DTRACK_API_KEY_FILE}
  chmod 600 ${DTRACK_API_KEY_FILE}

Generate an API key at: ${DTRACK_URL} > Administration > Access Management > Teams
Or run the interactive setup: ./setup.sh
EOF
    exit 1
fi

DTRACK_API_KEY=$(tr -d '[:space:]' < "$DTRACK_API_KEY_FILE")
if [ -z "$DTRACK_API_KEY" ]; then
    cat >&2 <<EOF
ERROR: API key file is empty at ${DTRACK_API_KEY_FILE}

Context: Loading Dependency-Track API key for ${DTRACK_URL}

The file exists but contains no API key value.

Recovery:
  echo 'your-api-key' > ${DTRACK_API_KEY_FILE}
  chmod 600 ${DTRACK_API_KEY_FILE}

Generate an API key at: ${DTRACK_URL} > Administration > Access Management > Teams
EOF
    exit 1
fi
