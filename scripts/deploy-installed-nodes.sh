#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "${HOME}/.joint-bob/env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "${HOME}/.joint-bob/env"
  set +a
fi
COMMIT="${1:-$(git -C "${ROOT}" rev-parse HEAD)}"
DESTINATION="${2:-all}"
# Each backup is a full node.db copy (2.6 GB on the homeserver in 2026-10); only the newest is kept unless asked.
BACKUP_KEEP="${JOINT_BOB_DEPLOY_BACKUP_KEEP:-1}"
[[ "${COMMIT}" =~ ^[0-9a-f]{40}$ ]] || { echo "Expected a 40-character commit" >&2; exit 1; }
[[ "${BACKUP_KEEP}" =~ ^[1-9][0-9]*$ ]] || { echo "JOINT_BOB_DEPLOY_BACKUP_KEEP must be a positive integer" >&2; exit 1; }
case "${DESTINATION}" in
  local | homeserver | all) ;;
  *) echo "Destination must be local, homeserver, or all" >&2; exit 1 ;;
esac
git -C "${ROOT}" cat-file -e "${COMMIT}^{commit}"

# Each machine is updated on its own: one that is busy or fails no longer keeps the other on
# an old release. A machine refuses an update while a turn that an earlier update interrupted
# is still running, so that is checked first, before anything is built or the machine is
# asked (asking makes every open page reconnect). Exit status 75 means a machine was busy
# that way; wait-for-main-and-deploy.sh runs the deployment again until it has gone through.
BUSY=75
NOTHING_TO_DO=10

# Prints how many interrupted turns a machine is still finishing. Reads its database without
# touching it: `node - <database>` with this script on standard input.
PENDING_RECOVERIES='
const fs = require("node:fs");
const file = process.argv[2];
let pending = 0;
if (fs.existsSync(file)) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try { pending = db.prepare("SELECT count(*) AS pending FROM update_recoveries WHERE status = ?").get("pending").pending; } catch { /* no update has run yet */ }
  db.close();
}
console.log(pending);
'

release_in() { sed -n 's/.*"release":"\([0-9a-f]\{40\}\)".*/\1/p' | head -n 1; }

# plan LABEL RUNNING_RELEASE PENDING_RECOVERIES
# Returns 0 when the machine should be updated. Otherwise says why not and returns
# NOTHING_TO_DO or BUSY.
plan() {
  local label="$1" running="$2" pending="$3"
  if [ "${running}" = "${COMMIT}" ]; then
    echo "${label} already runs ${COMMIT}."
    return "${NOTHING_TO_DO}"
  fi
  # A deployment that waited for a busy machine must not put an older release over a newer one.
  if [ -n "${running}" ] && git -C "${ROOT}" cat-file -e "${running}^{commit}" 2>/dev/null \
    && git -C "${ROOT}" merge-base --is-ancestor "${COMMIT}" "${running}"; then
    echo "${label} runs ${running}, which already contains ${COMMIT}; it is left as it is."
    return "${NOTHING_TO_DO}"
  fi
  if [[ "${pending}" =~ ^[1-9][0-9]*$ ]]; then
    echo "${label} is still finishing ${pending} conversation turn(s) that an earlier update interrupted. It is updated once they end."
    return "${BUSY}"
  fi
  return 0
}

homeserver_plan="${NOTHING_TO_DO}"
local_plan="${NOTHING_TO_DO}"
if [ "${DESTINATION}" != "local" ]; then
  DEPLOY_TARGET="${JOINT_BOB_DEPLOY_SSH_TARGET:?Set JOINT_BOB_DEPLOY_SSH_TARGET in ~/.joint-bob/env}"
  running="$(ssh "${DEPLOY_TARGET}" 'curl -fsS -m 10 http://127.0.0.1:8787/api/health' 2>/dev/null | release_in || true)"
  pending="$(ssh "${DEPLOY_TARGET}" 'node --no-warnings - "$HOME/.joint-bob/node.db"' <<<"${PENDING_RECOVERIES}" 2>/dev/null || true)"
  homeserver_plan=0
  plan "The homeserver" "${running}" "${pending}" || homeserver_plan=$?
fi
if [ "${DESTINATION}" != "homeserver" ]; then
  running="$(curl -fsS -m 10 http://127.0.0.1:8790/api/health 2>/dev/null | release_in || true)"
  pending="$(node --no-warnings - "${HOME}/.joint-bob/node.db" <<<"${PENDING_RECOVERIES}" 2>/dev/null || true)"
  local_plan=0
  plan "This machine" "${running}" "${pending}" || local_plan=$?
fi

work=""
package=""
trap '[ -z "${work}" ] || rm -rf "${work}"' EXIT
if [ "${homeserver_plan}" = 0 ] || [ "${local_plan}" = 0 ]; then
  work="$(mktemp -d "${HOME}/.joint-bob-deploy.XXXXXX")"
  mkdir "${work}/source" "${work}/package"
  git -C "${ROOT}" archive "${COMMIT}" | tar -xf - -C "${work}/source"
  (
    cd "${work}/source"
    npm ci
    npm pack --pack-destination "${work}" >/dev/null
  )
  package="$(find "${work}" -maxdepth 1 -type f -name 'joint-bob-*.tgz' -print -quit)"
  [ -n "${package}" ] || { echo "npm pack did not create Joint Bob" >&2; exit 1; }
  tar -xzf "${package}" -C "${work}/package"
fi

backup_local_state() {
  local state_dir="${HOME}/.joint-bob" backup_dir="${HOME}/.joint-bob/backups"
  [ -f "${state_dir}/node.db" ] || return
  mkdir -p "${backup_dir}"
  chmod 700 "${backup_dir}"
  # Older backups go first, so a deploy never needs room for more than BACKUP_KEEP copies of node.db.
  { ls -1t "${backup_dir}"/pre-deploy-*.db 2>/dev/null || true; } | tail -n "+${BACKUP_KEEP}" | while read -r old; do rm -f -- "${old}" "${old}-journal"; done
  local backup_db="${backup_dir}/pre-deploy-${COMMIT}-$(date -u +%Y%m%dT%H%M%SZ).db"
  if ! BACKUP_DB="${backup_db}" JOINT_BOB_DATA_DIR="${state_dir}" node - <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(`${process.env.JOINT_BOB_DATA_DIR}/node.db`);
db.exec(`VACUUM INTO '${process.env.BACKUP_DB.replaceAll("'", "''")}'`);
db.close();
NODE
  then
    # A backup cut short is worthless, and left in place it keeps the disk full (homeserver, 2026-10-26).
    rm -f -- "${backup_db}" "${backup_db}-journal"
    echo "Could not back up node.db before deploying (is the disk full?); nothing was installed" >&2
    return 1
  fi
  chmod 600 "${backup_db}"
}

install_homeserver() {
  local remote_package=".joint-bob/deploy/${COMMIT}/joint-bob.tgz"
  ssh "${DEPLOY_TARGET}" "mkdir -p ~/.joint-bob/deploy/${COMMIT} ~/.joint-bob/backups; chmod 700 ~/.joint-bob/deploy ~/.joint-bob/deploy/${COMMIT} ~/.joint-bob/backups"
  scp "${package}" "${DEPLOY_TARGET}:${remote_package}"
  ssh "${DEPLOY_TARGET}" "COMMIT='${COMMIT}' PACKAGE='${remote_package}' BACKUP_KEEP='${BACKUP_KEEP}' bash -s" <<'REMOTE'
set -euo pipefail
node_bin="$(command -v node)"
if [ -f "$HOME/.joint-bob/node.db" ]; then
  { ls -1t "$HOME"/.joint-bob/backups/pre-deploy-*.db 2>/dev/null || true; } | tail -n "+${BACKUP_KEEP}" | while read -r old; do rm -f -- "$old" "$old-journal"; done
  backup_db="$HOME/.joint-bob/backups/pre-deploy-${COMMIT}-$(date -u +%Y%m%dT%H%M%SZ).db"
  if ! BACKUP_DB="$backup_db" JOINT_BOB_DATA_DIR="$HOME/.joint-bob" "$node_bin" - <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(`${process.env.JOINT_BOB_DATA_DIR}/node.db`);
db.exec(`VACUUM INTO '${process.env.BACKUP_DB.replaceAll("'", "''")}'`);
db.close();
NODE
  then
    rm -f -- "$backup_db" "$backup_db-journal"
    echo "Could not back up node.db before deploying (is the disk full?); nothing was installed" >&2
    exit 1
  fi
  chmod 600 "$backup_db"
fi
extract="$HOME/.joint-bob/deploy/${COMMIT}/extract"
rm -rf "$extract"
mkdir "$extract"
tar -xzf "$HOME/$PACKAGE" -C "$extract"
JOINT_BOB_RELEASE_COMMIT="$COMMIT" "$node_bin" "$extract/package/bin/joint-bob.mjs" install
bash "$extract/package/scripts/post-deploy-smoke.sh" http://127.0.0.1:8787 "$COMMIT"
REMOTE
}

install_local() {
  backup_local_state
  JOINT_BOB_RELEASE_COMMIT="${COMMIT}" node "${work}/package/package/bin/joint-bob.mjs" install
  bash "${work}/package/package/scripts/post-deploy-smoke.sh" http://127.0.0.1:8790 "${COMMIT}"
}

# attempt LABEL PLAN INSTALLER
# The installer runs in its own shell so that a step failing inside it stops that machine's
# installation only. (`set -e` is not honoured inside `cmd || ...`, hence the explicit toggle.)
failed=""
busy=""
installed=""
attempt() {
  local label="$1" status="$2" installer="$3"
  if [ "${status}" = 0 ]; then
    set +e
    ( set -euo pipefail; "${installer}" )
    status=$?
    set -e
    if [ "${status}" = 0 ]; then
      echo "${label} now runs ${COMMIT}."
      installed="${installed} ${label}"
    fi
  fi
  case "${status}" in
    0 | "${NOTHING_TO_DO}") ;;
    "${BUSY}") busy="${busy} ${label}" ;;
    *) echo "Updating ${label} failed with status ${status}." >&2; failed="${failed} ${label}" ;;
  esac
}

if [ "${DESTINATION}" != "local" ]; then attempt "the homeserver" "${homeserver_plan}" install_homeserver; fi
if [ "${DESTINATION}" != "homeserver" ]; then attempt "this machine" "${local_plan}" install_local; fi

if [ -n "${failed}" ]; then
  echo "Deployment of ${COMMIT} failed on:${failed}." >&2
  exit 1
fi
if [ -n "${busy}" ]; then
  echo "Deployment of ${COMMIT} is waiting for:${busy}."
  exit "${BUSY}"
fi
if [ -z "${installed}" ]; then
  echo "Nothing to deploy: ${COMMIT} or a later release is already running."
  exit 0
fi
printf 'Deployed %s to %s installed copies.\n' "${COMMIT}" "${DESTINATION}"
