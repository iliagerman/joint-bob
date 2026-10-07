#!/bin/sh
# Installs the Joint Bob multi-user helper. Run once, as an administrator of this machine:
#   sudo sh scripts/multi-user/install-multi-user.sh <service-user>
# It installs a root-owned helper the Joint Bob service may run through one sudoers rule,
# hides other users' processes (Linux), and prepares the local port rules (Linux). It never
# creates a Joint Bob user by itself; the admin adds people in Settings > Users.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin

[ "$(id -u)" = 0 ] || { echo "Run this with sudo." >&2; exit 1; }
SERVICE_USER=${1:-${SUDO_USER:-}}
case "$SERVICE_USER" in ''|root) echo "Name the account Joint Bob runs as: sudo sh $0 <service-user>" >&2; exit 1 ;; esac
id -u "$SERVICE_USER" >/dev/null 2>&1 || { echo "No such account: $SERVICE_USER" >&2; exit 1; }

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
OS=$(uname -s)
HELPER=/usr/local/libexec/joint-bob-userctl
ROOT_GROUP=root; [ "$OS" = Darwin ] && ROOT_GROUP=wheel

command -v sudo >/dev/null 2>&1 || { echo "sudo is required." >&2; exit 1; }
if [ "$OS" = Linux ]; then
  command -v setfacl >/dev/null 2>&1 || { echo "Install the acl package first (apt-get install acl)." >&2; exit 1; }
  command -v useradd >/dev/null 2>&1 || { echo "useradd is required." >&2; exit 1; }
fi

install -d -m 0755 /etc/joint-bob /usr/local/libexec
printf 'SERVICE_USER=%s\n' "$SERVICE_USER" >/etc/joint-bob/userctl.conf
chmod 0644 /etc/joint-bob/userctl.conf
install -m 0755 -o root -g "$ROOT_GROUP" "$HERE/joint-bob-userctl" "$HELPER"

if [ "$OS" = Darwin ]; then
  dseditgroup -o read jointbob-users >/dev/null 2>&1 || dseditgroup -o create jointbob-users
else
  getent group jointbob-users >/dev/null || groupadd jointbob-users
fi

RULE=/etc/sudoers.d/joint-bob-userctl
TMP=$(mktemp)
printf '# Joint Bob may manage and run as its jb-* accounts, through this helper only.\n%s ALL=(root) NOPASSWD:SETENV: %s\n' "$SERVICE_USER" "$HELPER" >"$TMP"
visudo -cf "$TMP" >/dev/null
install -m 0440 -o root -g "$ROOT_GROUP" "$TMP" "$RULE"
rm -f "$TMP"

if [ "$OS" = Linux ]; then
  # Other people's processes are invisible; the service, in group jointbob-proc, sees all.
  getent group jointbob-proc >/dev/null || groupadd jointbob-proc
  usermod -a -G jointbob-proc "$SERVICE_USER"
  GID=$(getent group jointbob-proc | cut -d: -f3)
  if ! grep -q '^proc[[:space:]]\+/proc[[:space:]].*hidepid' /etc/fstab; then
    printf 'proc /proc proc defaults,hidepid=invisible,gid=%s 0 0\n' "$GID" >>/etc/fstab
  fi
  mount -o remount,hidepid=invisible,gid="$GID" /proc 2>/dev/null || mount -o remount,hidepid=2,gid="$GID" /proc || true
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    [ -f /etc/systemd/system/jointbob.slice ] || printf '[Unit]\nDescription=Joint Bob accounts\n\n[Slice]\n' >/etc/systemd/system/jointbob.slice
    systemctl daemon-reload
    systemctl start jointbob.slice
  fi
  command -v nft >/dev/null 2>&1 || echo "nftables is not installed: local ports between people stay open until it is (apt-get install nftables)." >&2
fi

"$HELPER" version >/dev/null
echo "Installed. Restart Joint Bob, then turn on multi-user mode in Settings > Users; it runs a self-test first."
