#!/usr/bin/env bash
#
# Run a disposable Joint Bob node — or a paired two-node cluster — with dummy
# data, for looking at the UI and exercising cluster features.
#
# Everything lives under one directory (default: .dev-env in the checkout): one
# SQLite database per node, a shared HOME, dummy projects, and dummy Pi and
# Claude transcripts. Nothing touches ~/.joint-bob, ~/.pi, or ~/.claude.
#
# Usage:
#   ./scripts/dev-local.sh                      # one node on :8791
#   ./scripts/dev-local.sh cluster              # two paired nodes on :8791 and :8792
#   PORT=9000 ./scripts/dev-local.sh            # different port for the first node
#   JOINT_BOB_DEV_ROOT=/tmp/jb ./scripts/dev-local.sh
#
# Reset it with: npm run dev:seed -- --force
#
set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${JOINT_BOB_DEV_ROOT:-${REPOSITORY_ROOT}/.dev-env}"
MODE="${1:-single}"
# 8791 and 8792, not 8790: an installed node on this machine already owns the
# default port.
PORT_A="${PORT:-${JOINT_BOB_DEV_PORT_A:-8791}}"
PORT_B="${JOINT_BOB_DEV_PORT_B:-8792}"

if [ "${MODE}" = "cluster" ]; then NODES=2; else NODES=1; fi

cd "${REPOSITORY_ROOT}"

if [ ! -f "${ROOT}/nodes/a/data/node.db" ] || { [ "${NODES}" = "2" ] && [ ! -f "${ROOT}/nodes/b/data/node.db" ]; }; then
  node --import tsx scripts/dev-seed.ts --root "${ROOT}" --nodes "${NODES}"
fi

# A port already in use would otherwise kill the script with a raw stack trace,
# and in cluster mode take the other node down with it.
require_free_port() {
  if lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $1 is already in use. Stop what is listening there, or set a different port." >&2
    exit 1
  fi
}

run_node() {
  # Each node needs its own session cookie name: cookies ignore the port, so two
  # nodes on 127.0.0.1 would otherwise sign each other out. JOINT_BOB_INSECURE_COOKIE
  # drops the Secure flag, which browsers reject over plain HTTP.
  env JOINT_BOB_DATA_DIR="${ROOT}/nodes/$1/data" \
      HOME="${ROOT}/home" \
      PORT="$2" \
      JOINT_BOB_SESSION_COOKIE="mb_session_dev_$1" \
      JOINT_BOB_INSECURE_COOKIE=1 \
      node --import tsx src/server.ts
}

echo
echo "Sign in with ${JOINT_BOB_DEV_USERNAME:-dev} / ${JOINT_BOB_DEV_PASSWORD:-joint-bob-dev-password}"
echo "  node A  http://127.0.0.1:${PORT_A}"
if [ "${NODES}" = "2" ]; then echo "  node B  http://127.0.0.1:${PORT_B}"; fi
echo

require_free_port "${PORT_A}"
if [ "${NODES}" = "2" ]; then require_free_port "${PORT_B}"; fi

if [ "${NODES}" = "2" ]; then
  run_node b "${PORT_B}" &
  NODE_B_PID=$!
  trap 'kill "${NODE_B_PID}" 2>/dev/null || true' EXIT INT TERM
fi

run_node a "${PORT_A}"
