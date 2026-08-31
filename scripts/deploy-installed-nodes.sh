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
[[ "${COMMIT}" =~ ^[0-9a-f]{40}$ ]] || { echo "Expected a 40-character commit" >&2; exit 1; }
case "${DESTINATION}" in
  local | homeserver | all) ;;
  *) echo "Destination must be local, homeserver, or all" >&2; exit 1 ;;
esac
git -C "${ROOT}" cat-file -e "${COMMIT}^{commit}"

work="$(mktemp -d "${HOME}/.joint-bob-deploy.XXXXXX")"
trap 'rm -rf "${work}"' EXIT
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

backup_local_state() {
  local state_dir="${HOME}/.joint-bob" backup_dir="${HOME}/.joint-bob/backups"
  [ -f "${state_dir}/node.db" ] || return
  mkdir -p "${backup_dir}"
  chmod 700 "${backup_dir}"
  local backup_db="${backup_dir}/pre-deploy-${COMMIT}-$(date -u +%Y%m%dT%H%M%SZ).db"
  BACKUP_DB="${backup_db}" JOINT_BOB_DATA_DIR="${state_dir}" node - <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(`${process.env.JOINT_BOB_DATA_DIR}/node.db`);
db.exec(`VACUUM INTO '${process.env.BACKUP_DB.replaceAll("'", "''")}'`);
db.close();
NODE
  chmod 600 "${backup_db}"
}

if [ "${DESTINATION}" != "local" ]; then
  DEPLOY_TARGET="${JOINT_BOB_DEPLOY_SSH_TARGET:?Set JOINT_BOB_DEPLOY_SSH_TARGET in ~/.joint-bob/env}"
  remote_package=".joint-bob/deploy/${COMMIT}/joint-bob.tgz"
  ssh "${DEPLOY_TARGET}" "mkdir -p ~/.joint-bob/deploy/${COMMIT} ~/.joint-bob/backups; chmod 700 ~/.joint-bob/deploy ~/.joint-bob/deploy/${COMMIT} ~/.joint-bob/backups"
  scp "${package}" "${DEPLOY_TARGET}:${remote_package}"
  ssh "${DEPLOY_TARGET}" "COMMIT='${COMMIT}' PACKAGE='${remote_package}' bash -s" <<'REMOTE'
set -euo pipefail
node_bin="$(command -v node)"
if [ -f "$HOME/.joint-bob/node.db" ]; then
  backup_db="$HOME/.joint-bob/backups/pre-deploy-${COMMIT}-$(date -u +%Y%m%dT%H%M%SZ).db"
  BACKUP_DB="$backup_db" JOINT_BOB_DATA_DIR="$HOME/.joint-bob" "$node_bin" - <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(`${process.env.JOINT_BOB_DATA_DIR}/node.db`);
db.exec(`VACUUM INTO '${process.env.BACKUP_DB.replaceAll("'", "''")}'`);
db.close();
NODE
  chmod 600 "$backup_db"
fi
extract="$HOME/.joint-bob/deploy/${COMMIT}/extract"
rm -rf "$extract"
mkdir "$extract"
tar -xzf "$HOME/$PACKAGE" -C "$extract"
JOINT_BOB_RELEASE_COMMIT="$COMMIT" "$node_bin" "$extract/package/bin/joint-bob.mjs" install
bash "$extract/package/scripts/post-deploy-smoke.sh" http://127.0.0.1:8787 "$COMMIT"
REMOTE
fi

if [ "${DESTINATION}" != "homeserver" ]; then
  backup_local_state
  JOINT_BOB_RELEASE_COMMIT="${COMMIT}" node "${work}/package/package/bin/joint-bob.mjs" install
  bash "${work}/package/package/scripts/post-deploy-smoke.sh" http://127.0.0.1:8790 "${COMMIT}"
fi

printf 'Deployed %s to %s installed copies.\n' "${COMMIT}" "${DESTINATION}"
