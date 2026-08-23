#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT="$1"
REMOTE="${2:-origin}"
[[ "${COMMIT}" =~ ^[0-9a-f]{40}$ ]] || exit 2
for _ in {1..90}; do
  remote_commit="$(git -C "${ROOT}" ls-remote "${REMOTE}" refs/heads/main | awk '{print $1}')"
  if [ "${remote_commit}" = "${COMMIT}" ]; then
    lock="${HOME}/.joint-bob/deploy.lock"
    lock_acquired=false
    for _ in {1..150}; do
      if mkdir "${lock}" 2>/dev/null; then lock_acquired=true; break; fi
      sleep 2
    done
    [ "${lock_acquired}" = true ] || { echo "Could not acquire deployment lock" >&2; exit 1; }
    trap 'rmdir "${lock}" 2>/dev/null || true' EXIT
    "${ROOT}/scripts/deploy-installed-nodes.sh" "${COMMIT}"
    exit 0
  fi
  sleep 2
done
echo "Remote main did not reach ${COMMIT}; deployment skipped." >&2
exit 1
