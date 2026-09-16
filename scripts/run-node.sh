#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_STATE_DIR="${HOME}/.joint-bob"
LEGACY_STATE_DIR="${HOME}/.pi-mobile-web"
STATE_DIR="${JOINT_BOB_DATA_DIR:-${PI_WEB_DATA_DIR:-${DEFAULT_STATE_DIR}}}"
if [ "${STATE_DIR}" = "${DEFAULT_STATE_DIR}" ] && [ ! -e "${STATE_DIR}" ] && [ -d "${LEGACY_STATE_DIR}" ]; then STATE_DIR="${LEGACY_STATE_DIR}"; fi
if [ -f "${STATE_DIR}/env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "${STATE_DIR}/env"
  set +a
fi
unset ANTHROPIC_BASE_URL OPENAI_BASE_URL
export JOINT_BOB_DATA_DIR="${STATE_DIR}"
export PI_WEB_DATA_DIR="${STATE_DIR}"
export PORT="${PORT:-8787}"

RELEASE_METADATA="${REPO_ROOT}/.joint-bob-release"
[ -f "${RELEASE_METADATA}" ] || RELEASE_METADATA="${REPO_ROOT}/.master-bob-release"
if [ -f "${RELEASE_METADATA}" ]; then
  release_count="$(awk -F= '$1 == "commit" { count++ } END { print count + 0 }' "${RELEASE_METADATA}")"
  release_commit="$(awk -F= '$1 == "commit" { print $2 }' "${RELEASE_METADATA}")"
  if [ "${release_count}" -ne 1 ] || ! [[ "${release_commit}" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "Invalid Joint Bob release metadata" >&2
    exit 1
  fi
  export JOINT_BOB_RELEASE="${release_commit}"
  export MASTER_BOB_RELEASE="${release_commit}"
else
  export JOINT_BOB_RELEASE=development
  export MASTER_BOB_RELEASE=development
fi
cd "${REPO_ROOT}"
case "${JOINT_BOB_BROWSER_MODE:-headless}" in
  headless)
    exec node "${REPO_ROOT}/scripts/supervisor-service.mjs" "${REPO_ROOT}" "${STATE_DIR}"
    ;;
  virtual)
    if [ "$(uname -s)" != "Linux" ]; then
      echo "Virtual browser display is supported only on Linux" >&2
      exit 1
    fi
    if ! command -v xvfb-run >/dev/null 2>&1; then
      echo "Virtual browser display requires xvfb-run; install Xvfb using your system administrator" >&2
      exit 1
    fi
    if ! command -v xauth >/dev/null 2>&1; then
      echo "Virtual browser display requires xauth; install xauth using your system administrator" >&2
      exit 1
    fi
    exec xvfb-run --auto-servernum --server-args='-screen 0 1100x740x24 -nolisten tcp' node "${REPO_ROOT}/scripts/supervisor-service.mjs" "${REPO_ROOT}" "${STATE_DIR}"
    ;;
  *)
    echo "JOINT_BOB_BROWSER_MODE must be headless or virtual" >&2
    exit 1
    ;;
esac
