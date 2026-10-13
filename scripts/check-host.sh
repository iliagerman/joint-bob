#!/usr/bin/env bash
#
# Refuses a host the installer cannot finish on, before anything is built.
# Windows is supported through WSL 2 only; see README "Install on Windows".
#
set -euo pipefail

WINDOWS_GUIDE="https://github.com/iliagerman/joint-bob#install-on-windows"

kernel="$(uname -s)"
case "${kernel}" in
  Darwin) exit 0 ;;
  Linux) ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "Joint Bob does not run in Git Bash, MSYS, or Cygwin. On Windows, install it inside WSL 2: ${WINDOWS_GUIDE}" >&2
    exit 1
    ;;
  *) echo "Unsupported operating system: ${kernel}" >&2; exit 1 ;;
esac

kernel_release="$(uname -r | tr '[:upper:]' '[:lower:]')"
wsl=false
case "${kernel_release}" in
  *microsoft-standard*|*wsl2*) wsl=true ;;
  *microsoft*)
    echo "This distribution runs under WSL 1, which has no systemd. From PowerShell run 'wsl --set-version <distribution> 2', then install again: ${WINDOWS_GUIDE}" >&2
    exit 1
    ;;
esac

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
if ! systemctl --user show-environment >/dev/null 2>&1; then
  if [ "${wsl}" = true ]; then
    cat >&2 <<EOF
Joint Bob needs systemd, which this WSL distribution has not started. Enable it:

  printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf

Then run 'wsl --shutdown' from PowerShell, reopen the distribution, and install again.
Guide: ${WINDOWS_GUIDE}
EOF
  else
    echo "Joint Bob needs a user systemd session, and 'systemctl --user show-environment' failed. Log in as this user over SSH or on a console (not through su or sudo) and install again." >&2
  fi
  exit 1
fi

if [ "${wsl}" = true ]; then
  case "${JOINT_BOB_INSTALL_DIR:-${HOME}}" in
    /mnt/*) echo "Warning: installing under a Windows drive (/mnt/...) is slow and loses file permissions. Use a path inside the Linux filesystem." >&2 ;;
  esac
fi
