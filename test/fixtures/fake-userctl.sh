#!/bin/sh
# Test stand-in for joint-bob-userctl: the same OS user, with a separate home per account
# under $JOINT_BOB_ACCOUNT_HOME_ROOT. It proves the server's plumbing, not the machine wall.
set -eu
command=$1; shift
root=${JOINT_BOB_ACCOUNT_HOME_ROOT:?}
case "$command" in
  version) echo 1 ;;
  create) mkdir -p "$root/jb-$1/.tmp" "$root/jb-$1/JointBob"; echo "$root/jb-$1" ;;
  delete) rm -rf "$root/jb-$1" ;;
  home) echo "$root/jb-$1" ;;
  run)
    name=$1; cwd=$2; shift 2
    [ "$1" = -- ] && shift
    home="$root/jb-$name"
    mkdir -p "$home/.tmp"
    printf '%s\n' "$name" >>"$root/runs.log"
    cd "$cwd"
    HOME="$home" TMPDIR="$home/.tmp" JOINT_BOB_FAKE_ACCOUNT="$name" exec "$@"
    ;;
  kill) kill -s "$2" -- "$3" ;;
  killgroup) pkill "-$2" -g "$3" -u "$(id -u)" || [ "$?" = 1 ] ;;
  repair|ports-sync) : ;;
  *) echo "unknown command" >&2; exit 2 ;;
esac
