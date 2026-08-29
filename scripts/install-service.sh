#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LEGACY_STATE_DIR="${HOME}/.pi-mobile-web"
DEFAULT_STATE_DIR="${HOME}/.joint-bob"
STATE_DIR="${JOINT_BOB_DATA_DIR:-${PI_WEB_DATA_DIR:-${DEFAULT_STATE_DIR}}}"
if [ "${STATE_DIR}" = "${DEFAULT_STATE_DIR}" ] && [ ! -e "${STATE_DIR}" ] && [ -d "${LEGACY_STATE_DIR}" ]; then
  mv "${LEGACY_STATE_DIR}" "${STATE_DIR}"
fi
if [ -f "${STATE_DIR}/env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "${STATE_DIR}/env"
  set +a
fi
PORT_VALUE="${PORT:-8787}"
LOG_DIR="${STATE_DIR}/logs"
RELEASE_METADATA="${REPO_ROOT}/.joint-bob-release"
[ -f "${RELEASE_METADATA}" ] || RELEASE_METADATA="${REPO_ROOT}/.master-bob-release"
if [ -f "${RELEASE_METADATA}" ]; then
  release_count="$(awk -F= '$1 == "commit" { count++ } END { print count + 0 }' "${RELEASE_METADATA}")"
  release_commit="$(awk -F= '$1 == "commit" { print $2 }' "${RELEASE_METADATA}")"
  if [ "${release_count}" -ne 1 ] || ! [[ "${release_commit}" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "Invalid Joint Bob release metadata" >&2
    exit 1
  fi
  EXPECTED_RELEASE="${release_commit}"
else
  EXPECTED_RELEASE="development"
fi

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
chmod +x "${REPO_ROOT}/scripts/run-node.sh" "${REPO_ROOT}/scripts/install-node-runtime.sh" "${REPO_ROOT}/scripts/check-prerequisites.sh" "${REPO_ROOT}/scripts/build-service-path.sh" "${REPO_ROOT}/scripts/install-syncthing.sh"
runtime_bin="$("${REPO_ROOT}/scripts/install-node-runtime.sh")"
if [ -n "${runtime_bin}" ]; then export PATH="${runtime_bin}:${PATH}"; fi
NODE_BIN="$(command -v node)" || { echo "Node.js is required after runtime setup" >&2; exit 1; }
NPM_BIN="$(command -v npm)" || { echo "npm is required after runtime setup" >&2; exit 1; }
"${NODE_BIN}" --version >/dev/null
"${NPM_BIN}" --version >/dev/null
cd "${REPO_ROOT}"
"${NPM_BIN}" ci
package_bin="${REPO_ROOT}/node_modules/.bin"
syncthing_bin="$("${REPO_ROOT}/scripts/install-syncthing.sh")"
export PATH="${package_bin}:${syncthing_bin}:${PATH}"
"${REPO_ROOT}/scripts/check-prerequisites.sh"
SERVICE_PATH="$("${REPO_ROOT}/scripts/build-service-path.sh" "${NODE_BIN}" "${NPM_BIN}")"

mkdir -p "${STATE_DIR}" "${LOG_DIR}"
chmod 700 "${STATE_DIR}" "${LOG_DIR}"
if [ ! -e "${STATE_DIR}/env" ]; then
  { printf 'PORT=%q\n' "${PORT_VALUE}"; printf 'PI_CLAUDE_MCP_AUTOLOAD=%q\n' off; } > "${STATE_DIR}/env"
fi
chmod 600 "${STATE_DIR}/env"

render() {
  local source_file="$1" target_file="$2"
  "${NODE_BIN}" - "${source_file}" "${target_file}" "__REPO_ROOT__" "${REPO_ROOT}" "__SERVICE_PATH__" "${SERVICE_PATH}" "__RUNNER__" "${REPO_ROOT}/scripts/run-node.sh" "__LOG_DIR__" "${LOG_DIR}" <<'NODE'
const fs = require("node:fs");
const [, , source, target, ...pairs] = process.argv;
let output = fs.readFileSync(source, "utf8");
const xml = target.endsWith(".plist");
for (let index = 0; index < pairs.length; index += 2) {
  const value = xml ? pairs[index + 1].replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;") : pairs[index + 1];
  output = output.replaceAll(pairs[index], value);
}
fs.writeFileSync(target, output);
NODE
}

service_platform="$(uname -s)"
previous_main_pid=""
case "${service_platform}" in
  Linux)
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
    destination="${HOME}/.config/systemd/user"
    mkdir -p "${destination}"
    legacy_dropins="${destination}/pi-mobile-web.service.d"
    joint_dropins="${destination}/joint-bob.service.d"
    if [ -d "${legacy_dropins}" ] && [ ! -e "${joint_dropins}" ]; then cp -R "${legacy_dropins}" "${joint_dropins}"; fi
    render "${REPO_ROOT}/deploy/joint-bob.service" "${destination}/joint-bob.service"
    systemctl --user daemon-reload
    systemctl --user enable joint-bob.service
    previous_main_pid="$(systemctl --user show joint-bob.service --property=MainPID --value 2>/dev/null || true)"
    systemctl --user stop pi-mobile-web.service >/dev/null 2>&1 || true
    systemctl --user restart joint-bob.service
    ;;
  Darwin)
    destination="${HOME}/Library/LaunchAgents"
    plist="${destination}/com.joint-bob.node.plist"
    mkdir -p "${destination}"
    render "${REPO_ROOT}/deploy/com.joint-bob.node.plist" "${plist}"
    plutil -lint "${plist}" >/dev/null
    launchctl bootout "gui/$(id -u)/com.master-bob.node" >/dev/null 2>&1 || true
    launchctl bootout "gui/$(id -u)/com.joint-bob.node" >/dev/null 2>&1 || true
    launchd_loaded=false
    for _ in {1..5}; do
      if launchctl bootstrap "gui/$(id -u)" "${plist}"; then launchd_loaded=true; break; fi
      sleep 1
    done
    [ "${launchd_loaded}" = true ] || { echo "Could not load com.joint-bob.node" >&2; exit 1; }
    launchctl kickstart -k "gui/$(id -u)/com.joint-bob.node"
    ;;
  *) echo "Unsupported operating system: ${service_platform}" >&2; exit 1 ;;
esac

service_healthy=false
for _ in {1..120}; do
  if health_response="$(curl -fsS "http://127.0.0.1:${PORT_VALUE}/api/health")" && HEALTH_RESPONSE="${health_response}" EXPECTED_RELEASE="${EXPECTED_RELEASE}" "${NODE_BIN}" -e '
    const health = JSON.parse(process.env.HEALTH_RESPONSE);
    if (health.status !== "ok" || health.release !== process.env.EXPECTED_RELEASE) process.exit(1);
  '; then
    if [ "${service_platform}" = Linux ]; then
      current_main_pid="$(systemctl --user show joint-bob.service --property=MainPID --value 2>/dev/null || true)"
      [[ "${current_main_pid}" =~ ^[1-9][0-9]*$ ]] || { sleep 1; continue; }
      if [ -n "${previous_main_pid}" ] && [ "${current_main_pid}" = "${previous_main_pid}" ]; then sleep 1; continue; fi
    fi
    service_healthy=true
    break
  fi
  sleep 1
done
if [ "${service_healthy}" != true ]; then
  if [ "${service_platform}" = Linux ]; then systemctl --user restart pi-mobile-web.service >/dev/null 2>&1 || true; fi
  echo "Joint Bob service did not become healthy" >&2
  exit 1
fi
"${NODE_BIN}" "${REPO_ROOT}/scripts/install-claude-hooks.mjs" "${NODE_BIN}" "${REPO_ROOT}" "${STATE_DIR}"
chmod 600 "${STATE_DIR}/node.db" "${STATE_DIR}/node.db-wal" "${STATE_DIR}/node.db-shm" 2>/dev/null || true

if [ "${service_platform}" = Linux ]; then
  systemctl --user disable pi-mobile-web.service pi-mobile-web-restart.path pi-mobile-web-restart.service >/dev/null 2>&1 || true
  rm -f "${HOME}/.config/systemd/user/pi-mobile-web.service" "${HOME}/.config/systemd/user/pi-mobile-web-restart.path" "${HOME}/.config/systemd/user/pi-mobile-web-restart.service"
  systemctl --user daemon-reload
  if command -v loginctl >/dev/null 2>&1 && [ "$(loginctl show-user "${USER}" -p Linger --value 2>/dev/null || true)" != yes ]; then
    echo "Warning: run 'sudo loginctl enable-linger ${USER}' for startup before login." >&2
  fi
else
  rm -f "${HOME}/Library/LaunchAgents/com.master-bob.node.plist"
fi

JOINT_BOB_DATA_DIR="${STATE_DIR}" PI_WEB_DATA_DIR="${STATE_DIR}" "${NODE_BIN}" --input-type=module -e 'const auth = await import("./dist/github-auth.js"); auth.cleanupLegacyGitHubCredentialFiles();'
set +e
echo
echo "Joint Bob node installed."
echo "Open: http://127.0.0.1:${PORT_VALUE}/"
echo "Create the administrator in the browser on first open."
echo "Local settings: ${STATE_DIR}/env"
exit 0
