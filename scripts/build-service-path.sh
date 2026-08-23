#!/usr/bin/env bash
set -euo pipefail

NODE_BIN="$1"
NPM_BIN="$2"
candidates=(
  "$(dirname "${NODE_BIN}")"
  "$(dirname "${NPM_BIN}")"
)

for tool in pi claude syncthing rg gh; do
  if tool_bin="$(command -v "${tool}" 2>/dev/null)"; then
    candidates+=("$(dirname "${tool_bin}")")
  fi
done

remaining_path="${PATH}"
while [ -n "${remaining_path}" ]; do
  if [[ "${remaining_path}" == *:* ]]; then
    segment="${remaining_path%%:*}"
    remaining_path="${remaining_path#*:}"
  else
    segment="${remaining_path}"
    remaining_path=""
  fi
  if [ -n "${segment}" ]; then
    candidates+=("${segment}")
  fi
done

candidates+=(
  "${HOME}/.local/bin"
  "/opt/homebrew/bin"
  "/usr/local/bin"
  "/usr/bin"
  "/bin"
  "/snap/bin"
)

service_segments=()
for candidate in "${candidates[@]}"; do
  duplicate=false
  for ((index = 0; index < ${#service_segments[@]}; index++)); do
    if [ "${candidate}" = "${service_segments[index]}" ]; then
      duplicate=true
      break
    fi
  done
  if [ "${duplicate}" = false ]; then
    service_segments+=("${candidate}")
  fi
done

IFS=:
printf '%s\n' "${service_segments[*]}"
