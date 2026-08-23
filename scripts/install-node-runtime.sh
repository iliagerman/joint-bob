#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/versions.sh"

MINIMUM_NODE_VERSION="22.19.0"
NODE_VERSION="${JOINT_BOB_NODE_VERSION_OVERRIDE:-${MASTER_BOB_NODE_VERSION:-${JOINT_BOB_NODE_VERSION}}}"
RUNTIME_ROOT="${JOINT_BOB_RUNTIME_DIR:-${MASTER_BOB_RUNTIME_DIR:-${HOME}/.local/share/joint-bob/runtime}}"
NODE_ROOT="${RUNTIME_ROOT}/node-v${NODE_VERSION}"

version_at_least() {
  local version="$1"
  local minimum="$2"
  local major minor patch minimum_major minimum_minor minimum_patch

  [[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  [[ "${minimum}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  IFS=. read -r major minor patch <<< "${version}"
  IFS=. read -r minimum_major minimum_minor minimum_patch <<< "${minimum}"

  (( 10#${major} > 10#${minimum_major} )) && return 0
  (( 10#${major} < 10#${minimum_major} )) && return 1
  (( 10#${minor} > 10#${minimum_minor} )) && return 0
  (( 10#${minor} < 10#${minimum_minor} )) && return 1
  (( 10#${patch} >= 10#${minimum_patch} ))
}

node_is_supported() {
  local node_binary="$1"

  MINIMUM_NODE_VERSION="${MINIMUM_NODE_VERSION}" "${node_binary}" -e '
const parseVersion = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
};
const version = parseVersion(process.versions.node);
const minimum = parseVersion(process.env.MINIMUM_NODE_VERSION);
if (!version || !minimum) process.exit(1);
for (let index = 0; index < version.length; index += 1) {
  if (version[index] > minimum[index]) process.exit(0);
  if (version[index] < minimum[index]) process.exit(1);
}
process.exit(0);
'
}

if ! version_at_least "${NODE_VERSION}" "${MINIMUM_NODE_VERSION}"; then
  echo "JOINT_BOB_NODE_VERSION_OVERRIDE must be at least 22.19.0" >&2
  exit 1
fi

if command -v node >/dev/null 2>&1 && node_is_supported "$(command -v node)"; then
  exit 0
fi
if [ -e "${NODE_ROOT}/bin/node" ]; then
  if ! node_is_supported "${NODE_ROOT}/bin/node"; then
    echo "Cached Joint Bob Node runtime must be at least 22.19.0" >&2
    exit 1
  fi
  printf '%s\n' "${NODE_ROOT}/bin"
  exit 0
fi

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) echo "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) architecture="x64" ;;
  arm64|aarch64) architecture="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

archive="node-v${NODE_VERSION}-${platform}-${architecture}.tar.xz"
base_url="https://nodejs.org/dist/v${NODE_VERSION}"
temporary="$(mktemp -d)"
trap 'rm -rf "${temporary}"' EXIT
curl -fsSL "${base_url}/${archive}" -o "${temporary}/${archive}"
curl -fsSL "${base_url}/SHASUMS256.txt" -o "${temporary}/SHASUMS256.txt"
expected="$(awk -v archive="${archive}" '$2 == archive { print $1 }' "${temporary}/SHASUMS256.txt")"
[ -n "${expected}" ] || { echo "Node checksum not found" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${temporary}/${archive}" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "${temporary}/${archive}" | awk '{print $1}')"
fi
[ "${actual}" = "${expected}" ] || { echo "Node checksum mismatch" >&2; exit 1; }
mkdir -p "${NODE_ROOT}"
tar -xJf "${temporary}/${archive}" --strip-components=1 -C "${NODE_ROOT}"
printf '%s\n' "${NODE_ROOT}/bin"
