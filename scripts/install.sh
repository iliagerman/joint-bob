#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${JOINT_BOB_INSTALL_DIR:-${MASTER_BOB_INSTALL_DIR:-${HOME}/.local/share/joint-bob/app}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." 2>/dev/null && pwd || true)"

if [ -f "${SOURCE_DIR}/package.json" ]; then
  export JOINT_BOB_INSTALL_DIR="${INSTALL_DIR}"
  exec "${SOURCE_DIR}/scripts/install-service.sh"
fi

REF="${JOINT_BOB_REF:-${MASTER_BOB_REF:-}}"
ARCHIVE_SHA256="${JOINT_BOB_ARCHIVE_SHA256:-${MASTER_BOB_ARCHIVE_SHA256:-}}"
LATEST_ARCHIVE_URL="https://github.com/iliagerman/joint-bob/releases/latest/download/joint-bob.tar.gz"
LATEST_CHECKSUM_URL="https://github.com/iliagerman/joint-bob/releases/latest/download/joint-bob.tar.gz.sha256"
if [ -n "${REF}" ] && ! [[ "${REF}" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "JOINT_BOB_REF must be a full 40-character Git commit SHA" >&2
  exit 1
fi
if [ -n "${REF}" ] && ! [[ "${ARCHIVE_SHA256}" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "JOINT_BOB_ARCHIVE_SHA256 must be a 64-character SHA-256 digest" >&2
  exit 1
fi

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }
install_parent="$(dirname "${INSTALL_DIR}")"
mkdir -p "${install_parent}"
staging="$(mktemp -d "${install_parent}/.joint-bob-install.XXXXXX")"
installer_pid=""
cleanup() {
  local status=$?
  trap '' INT TERM
  if [ -n "${installer_pid}" ]; then
    kill -TERM "${installer_pid}" 2>/dev/null || true
    wait "${installer_pid}" || true
  fi
  rm -rf "${staging}" || echo "Could not remove installer staging: ${staging}" >&2
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

archive="${staging}/joint-bob.tar.gz"
if [ -n "${REF}" ]; then
  archive_url="https://github.com/iliagerman/joint-bob/archive/${REF}.tar.gz"
  expected_sha256="${ARCHIVE_SHA256}"
else
  curl -fsSL "${LATEST_CHECKSUM_URL}" -o "${staging}/joint-bob.tar.gz.sha256"
  expected_sha256="$(awk 'NR == 1 { print $1 }' "${staging}/joint-bob.tar.gz.sha256")"
  [[ "${expected_sha256}" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "Release checksum file is invalid" >&2; exit 1; }
  archive_url="${LATEST_ARCHIVE_URL}"
fi
curl -fsSL "${archive_url}" -o "${archive}"
if command -v sha256sum >/dev/null 2>&1; then actual_sha256="$(sha256sum "${archive}" | awk '{print $1}')"; else actual_sha256="$(shasum -a 256 "${archive}" | awk '{print $1}')"; fi
expected_sha256="$(printf '%s' "${expected_sha256}" | tr '[:upper:]' '[:lower:]')"
actual_sha256="$(printf '%s' "${actual_sha256}" | tr '[:upper:]' '[:lower:]')"
[ "${actual_sha256}" = "${expected_sha256}" ] || { echo "Downloaded archive checksum mismatch" >&2; exit 1; }

extract_dir="${staging}/extract"
mkdir "${extract_dir}"
tar -xzf "${archive}" -C "${extract_dir}"
shopt -s nullglob dotglob
entries=("${extract_dir}"/*)
if [ "${#entries[@]}" -eq 1 ] && [ -d "${entries[0]}" ]; then verified_source="${entries[0]}"; else verified_source="${extract_dir}"; fi
[ -f "${verified_source}/package.json" ] && [ -f "${verified_source}/scripts/install-service.sh" ] || { echo "Archive is missing required installer files" >&2; exit 1; }

if [ -e "${INSTALL_DIR}" ]; then
  if [ ! -d "${INSTALL_DIR}" ] || { [ ! -f "${INSTALL_DIR}/.joint-bob-release" ] && [ ! -f "${INSTALL_DIR}/.master-bob-release" ]; }; then
    echo "Refusing to replace unrecognized installation: ${INSTALL_DIR}" >&2
    exit 1
  fi
fi
[ -f "${verified_source}/bin/joint-bob.mjs" ] || { echo "Archive is missing the transactional installer" >&2; exit 1; }
runtime_bin="$(bash "${verified_source}/scripts/install-node-runtime.sh")"
if [ -n "${runtime_bin}" ]; then export PATH="${runtime_bin}:${PATH}"; fi
export JOINT_BOB_INSTALL_DIR="${INSTALL_DIR}"
if [ -n "${REF}" ]; then export JOINT_BOB_RELEASE_COMMIT="${REF}"; fi
node "${verified_source}/bin/joint-bob.mjs" install &
installer_pid=$!
install_status=0
wait "${installer_pid}" || install_status=$?
installer_pid=""
exit "${install_status}"
