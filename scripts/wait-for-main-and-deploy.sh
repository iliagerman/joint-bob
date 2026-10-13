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
LOCK_WAIT_SECONDS="${JOINT_BOB_DEPLOY_LOCK_WAIT_SECONDS:-300}"
# No deployment holds the lock this long: it is held while installing, never while waiting.
LOCK_MAX_MINUTES=120
lock_held=false
release_lock() { rm -f "${LOCK}/holder"; rmdir "${LOCK}" 2>/dev/null || true; lock_held=false; }
# A deployment that is killed must not leave its lock behind: the next push would wait five minutes and give up.
trap '[ "${lock_held}" != true ] || release_lock' EXIT

label_lock() { ( set -o noclobber; echo "$$ $(date +%s)" > "${LOCK}/holder" ) 2>/dev/null; }

# The trap above does not run when the deployment is killed outright, as it is when the service
# it was started under restarts. Its lock then stayed for good: every later push gave up with
# "Could not acquire deployment lock" and the machines fell releases behind. The lock therefore
# names its holder, and one whose holder is gone, or that is older than any deployment lasts,
# is taken over in place. Moving the old label away decides between two finders, and the
# directory is never removed by anyone but its holder, so a lock just taken cannot be cleared.
take_lock() {
  if mkdir "${LOCK}" 2>/dev/null; then label_lock || true; return 0; fi
  local holder="" since=""
  if { read -r holder since < "${LOCK}/holder"; } 2>/dev/null && [[ "${holder}" =~ ^[0-9]+$ && "${since}" =~ ^[0-9]+$ ]]; then
    if kill -0 "${holder}" 2>/dev/null && [ $(( $(date +%s) - since )) -lt $(( LOCK_MAX_MINUTES * 60 )) ]; then return 1; fi
    mv "${LOCK}/holder" "${LOCK}/holder.$$" 2>/dev/null || return 1
    rm -f "${LOCK}/holder.$$"
  else
    # Taken a moment ago and not yet labelled, or left by a version that did not label it.
    [ -n "$(find "${LOCK}" -maxdepth 0 -mmin "+${LOCK_MAX_MINUTES}" 2>/dev/null)" ] || return 1
  fi
  label_lock || return 1
  echo "Took over a deployment lock whose deployment is gone."
}

deploy_once() {
  local status=0 waited=0
  until take_lock; do
    [ "${waited}" -lt "${LOCK_WAIT_SECONDS}" ] || { echo "Could not acquire deployment lock" >&2; return 1; }
    sleep 2; waited=$(( waited + 2 ))
  done
  lock_held=true
  # The lock is held only while deploying, never while waiting for a busy machine: a newer
  # push must be able to deploy meanwhile.
  "${ROOT}/scripts/deploy-installed-nodes.sh" "${COMMIT}" || status=$?
  release_lock
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
