#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${JOINT_BOB_INSTALL_DIR:-${MASTER_BOB_INSTALL_DIR:-${HOME}/.local/share/joint-bob/app}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." 2>/dev/null && pwd || true)"

if [ -f "${SOURCE_DIR}/package.json" ]; then
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
backup="${staging}/previous-install"
had_existing_install=false
install_swapped=false
install_succeeded=false

cleanup() {
  local status=$?
  if [ "${install_swapped}" = true ] && [ "${install_succeeded}" != true ]; then
    if [ "${had_existing_install}" != true ] || [ -e "${backup}" ]; then rm -rf "${INSTALL_DIR}"; fi
    if [ -e "${backup}" ]; then mv "${backup}" "${INSTALL_DIR}"; fi
  fi
  rm -rf "${backup}" "${staging}"
  trap - EXIT INT TERM
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
  had_existing_install=true
  install_swapped=true
  mv "${INSTALL_DIR}" "${backup}"
fi
mv "${verified_source}" "${INSTALL_DIR}"
install_swapped=true
if [ -n "${REF}" ]; then printf 'commit=%s\narchive_sha256=%s\n' "${REF}" "${expected_sha256}" > "${INSTALL_DIR}/.joint-bob-release"; fi

if "${INSTALL_DIR}/scripts/install-service.sh"; then
  install_succeeded=true
  exit 0
fi
install_status=$?
echo "New installation failed; restoring previous installation." >&2
rm -rf "${INSTALL_DIR}"
if [ -e "${backup}" ]; then
  mv "${backup}" "${INSTALL_DIR}"
  install_swapped=false
  "${INSTALL_DIR}/scripts/install-service.sh" || echo "Failed to restore previous installation and service." >&2
else
  install_swapped=false
fi
exit "${install_status}"
