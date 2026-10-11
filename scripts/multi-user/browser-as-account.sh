#!/bin/sh
# Starts the browser as a person's account (multi-user mode). Playwright talks to the browser
# over file descriptors 3 and 4, which sudo does not pass on, so they travel as standard input
# and output and the command named in JOINT_BOB_BROWSER_LAUNCH_* puts them back.
# JOINT_BOB_BROWSER_LAUNCH_COUNT words, JOINT_BOB_BROWSER_LAUNCH_0.. each, come before the
# browser's own arguments.
set -eu
i=${JOINT_BOB_BROWSER_LAUNCH_COUNT:?}
case "$i" in ''|*[!0-9]*) echo "browser-as-account: invalid launch" >&2; exit 2 ;; esac
while [ "$i" -gt 0 ]; do
  i=$((i - 1))
  eval "word=\${JOINT_BOB_BROWSER_LAUNCH_$i}"
  set -- "$word" "$@"
done
exec "$@" 0<&3 1>&4
