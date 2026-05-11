#!/bin/bash
# ArgoCD configuration loader
set -e

_ARGOCD_CONFIG_DIR="${ARGOCD_CONFIG_DIR:-$HOME/.boring/argocd}"

# Read URL from file
if [ -z "$ARGOCD_URL" ] && [ -f "${_ARGOCD_CONFIG_DIR}/url" ]; then
    ARGOCD_URL=$(tr -d '[:space:]' < "${_ARGOCD_CONFIG_DIR}/url")
fi

# Read token from file
if [ -z "$ARGOCD_TOKEN" ] && [ -f "${_ARGOCD_CONFIG_DIR}/token" ]; then
    ARGOCD_TOKEN=$(tr -d '[:space:]' < "${_ARGOCD_CONFIG_DIR}/token")
fi

ARGOCD_URL="${ARGOCD_URL:-}"
ARGOCD_TOKEN="${ARGOCD_TOKEN:-}"

if [ -z "$ARGOCD_URL" ]; then
    cat >&2 <<EOF
ERROR: ARGOCD_URL not set.

Context: Loading ArgoCD configuration from ${_ARGOCD_CONFIG_DIR}/

The ArgoCD server URL must be configured before any operations can run.

Recovery:
  mkdir -p ${_ARGOCD_CONFIG_DIR}
  echo 'https://argocd.example.com' > ${_ARGOCD_CONFIG_DIR}/url
  echo 'your-bearer-token' > ${_ARGOCD_CONFIG_DIR}/token
  chmod 600 ${_ARGOCD_CONFIG_DIR}/token

Or run the interactive setup: ./setup.sh
EOF
    exit 1
fi

if [ -z "$ARGOCD_TOKEN" ]; then
    cat >&2 <<EOF
ERROR: ARGOCD_TOKEN not set.

Context: Loading ArgoCD credentials from ${_ARGOCD_CONFIG_DIR}/
  URL is configured: ${ARGOCD_URL}
  Token file: ${_ARGOCD_CONFIG_DIR}/token $([ -f "${_ARGOCD_CONFIG_DIR}/token" ] && echo "(exists)" || echo "(MISSING)")

ArgoCD uses Bearer token (JWT) authentication.

How to generate a token:
  argocd account generate-token --account <account-name>

Or exchange credentials:
  curl -s ${ARGOCD_URL}/api/v1/session -d '{"username":"admin","password":"PASSWORD"}'

Recovery:
  echo 'your-bearer-token' > ${_ARGOCD_CONFIG_DIR}/token
  chmod 600 ${_ARGOCD_CONFIG_DIR}/token

Or run the interactive setup: ./setup.sh
EOF
    exit 1
fi
