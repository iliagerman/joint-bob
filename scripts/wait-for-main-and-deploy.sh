#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT="$1"
REMOTE="${2:-origin}"
[[ "${COMMIT}" =~ ^[0-9a-f]{40}$ ]] || exit 2
# A machine refuses an update while it finishes a turn that an earlier update interrupted,
# which can take hours. The deployment is tried again every few minutes until every machine
# has it, instead of leaving that machine (and, before, the other one too) on the old release.
RETRY_SECONDS="${JOINT_BOB_DEPLOY_RETRY_SECONDS:-180}"
RETRY_HOURS="${JOINT_BOB_DEPLOY_RETRY_HOURS:-12}"
BUSY=75

remote_main() { git -C "${ROOT}" ls-remote "${REMOTE}" refs/heads/main | awk '{print $1}'; }

LOCK="${HOME}/.joint-bob/deploy.lock"
lock_held=false
# A deployment that is killed must not leave its lock behind: the next push would wait five minutes and give up.
trap '[ "${lock_held}" != true ] || rmdir "${LOCK}" 2>/dev/null || true' EXIT

deploy_once() {
  local status=0
  for _ in {1..150}; do
    if mkdir "${LOCK}" 2>/dev/null; then lock_held=true; break; fi
    sleep 2
  done
  [ "${lock_held}" = true ] || { echo "Could not acquire deployment lock" >&2; return 1; }
  # The lock is held only while deploying, never while waiting for a busy machine: a newer
  # push must be able to deploy meanwhile.
  "${ROOT}/scripts/deploy-installed-nodes.sh" "${COMMIT}" || status=$?
  rmdir "${LOCK}" 2>/dev/null || true
  lock_held=false
  return "${status}"
}

for _ in {1..90}; do
  if [ "$(remote_main)" = "${COMMIT}" ]; then
    deadline=$(( $(date +%s) + RETRY_HOURS * 3600 ))
    while true; do
      status=0
      deploy_once || status=$?
      [ "${status}" = "${BUSY}" ] || exit "${status}"
      if [ "$(date +%s)" -ge "${deadline}" ]; then
        echo "A machine stayed busy for ${RETRY_HOURS} hours; ${COMMIT} was not deployed to it." >&2
        exit 1
      fi
      sleep "${RETRY_SECONDS}"
      # A newer push deploys a release that contains this one, to every machine.
      if [ "$(remote_main)" != "${COMMIT}" ]; then
        echo "A newer push replaced ${COMMIT}; its own deployment covers the machine that was busy."
        exit 0
      fi
    done
  fi
  sleep 2
done
echo "Remote main did not reach ${COMMIT}; deployment skipped." >&2
exit 1
