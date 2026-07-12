#!/bin/bash
# Offline regression test entry point for the codex skill.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/../codex/tests/run-tests.sh" --offline
