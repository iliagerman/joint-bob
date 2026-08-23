#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/versions.sh"
VERSION="${JOINT_BOB_SYNCTHING_VERSION}"
INSTALL_ROOT="${JOINT_BOB_RUNTIME_DIR:-${HOME}/.local/share/joint-bob/runtime}/syncthing-v${VERSION}"
BINARY="${INSTALL_ROOT}/bin/syncthing"

is_pinned_version() { "$1" --version 2>/dev/null | grep -q "syncthing v${VERSION} "; }
managed_binary=""
if [ -n "${JOINT_BOB_SYNCTHING_BIN:-}" ] && [ -x "${JOINT_BOB_SYNCTHING_BIN}" ] && is_pinned_version "${JOINT_BOB_SYNCTHING_BIN}"; then
  managed_binary="${JOINT_BOB_SYNCTHING_BIN}"
elif [ -x "${BINARY}" ] && is_pinned_version "${BINARY}"; then
  managed_binary="${BINARY}"
elif command -v syncthing >/dev/null 2>&1 && is_pinned_version "$(command -v syncthing)"; then
  managed_binary="$(command -v syncthing)"
fi

if [ -z "${managed_binary}" ]; then
  case "$(uname -s):$(uname -m)" in
    Linux:x86_64|Linux:amd64) platform=linux; architecture=amd64; extension=tar.gz; checksum="${JOINT_BOB_SYNCTHING_LINUX_AMD64_SHA256}" ;;
    Linux:arm64|Linux:aarch64) platform=linux; architecture=arm64; extension=tar.gz; checksum="${JOINT_BOB_SYNCTHING_LINUX_ARM64_SHA256}" ;;
    Darwin:x86_64|Darwin:amd64) platform=macos; architecture=amd64; extension=zip; checksum="${JOINT_BOB_SYNCTHING_MACOS_AMD64_SHA256}" ;;
    Darwin:arm64|Darwin:aarch64) platform=macos; architecture=arm64; extension=zip; checksum="${JOINT_BOB_SYNCTHING_MACOS_ARM64_SHA256}" ;;
    *) echo "Unsupported Syncthing platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
  esac
  archive_name="syncthing-${platform}-${architecture}-v${VERSION}.${extension}"
  temporary="$(mktemp -d)"
  trap 'rm -rf "${temporary}"' EXIT
  curl -fsSL "https://github.com/syncthing/syncthing/releases/download/v${VERSION}/${archive_name}" -o "${temporary}/${archive_name}"
  if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "${temporary}/${archive_name}" | awk '{print $1}')"; else actual="$(shasum -a 256 "${temporary}/${archive_name}" | awk '{print $1}')"; fi
  [ "${actual}" = "${checksum}" ] || { echo "Syncthing checksum mismatch" >&2; exit 1; }
  extract_root="${temporary}/extract"
  mkdir "${extract_root}"
  if [ "${extension}" = zip ]; then /usr/bin/ditto -x -k "${temporary}/${archive_name}" "${extract_root}"; else tar -xzf "${temporary}/${archive_name}" -C "${extract_root}"; fi
  extracted_binary="$(find "${extract_root}" -type f -name syncthing -perm -u+x -print -quit)"
  [ -n "${extracted_binary}" ] || { echo "Syncthing archive has no executable" >&2; exit 1; }
  mkdir -p "$(dirname "${BINARY}")"
  cp "${extracted_binary}" "${BINARY}"
  chmod 755 "${BINARY}"
  managed_binary="${BINARY}"
fi

if ! "${managed_binary}" cli show system >/dev/null 2>&1; then
  case "$(uname -s)" in
    Linux)
      export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
      export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
      unit_dir="${HOME}/.config/systemd/user"
      mkdir -p "${unit_dir}"
      cat > "${unit_dir}/joint-bob-syncthing.service" <<UNIT
[Unit]
Description=Joint Bob managed Syncthing
After=network-online.target

[Service]
ExecStart=${managed_binary} serve --no-browser --no-restart
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
      systemctl --user daemon-reload
      systemctl --user enable --now joint-bob-syncthing.service
      ;;
    Darwin)
      plist="${HOME}/Library/LaunchAgents/com.joint-bob.syncthing.plist"
      mkdir -p "$(dirname "${plist}")"
      escaped_binary="$(printf '%s' "${managed_binary}" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')"
      cat > "${plist}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>com.joint-bob.syncthing</string><key>ProgramArguments</key><array><string>${escaped_binary}</string><string>serve</string><string>--no-browser</string><string>--no-restart</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>
PLIST
      launchctl bootout "gui/$(id -u)/com.joint-bob.syncthing" >/dev/null 2>&1 || true
      launchctl bootstrap "gui/$(id -u)" "${plist}"
      ;;
  esac
  for _ in {1..30}; do "${managed_binary}" cli show system >/dev/null 2>&1 && break; sleep 1; done
fi
"${managed_binary}" cli show system >/dev/null 2>&1 || { echo "Managed Syncthing did not become ready" >&2; exit 1; }
printf '%s\n' "$(dirname "${managed_binary}")"
