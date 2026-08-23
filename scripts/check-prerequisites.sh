#!/usr/bin/env bash
set -euo pipefail

require_tool() {
  command -v "$1" >/dev/null 2>&1 || { echo "$1 is required after managed runtime installation" >&2; exit 1; }
}

require_tool pi
require_tool claude
require_tool syncthing
pi_version="$(pi --version)"
claude_version="$(claude --version)"
syncthing_version="$(syncthing --version)"
model="${PI_PREREQUISITE_MODEL:-${JOINT_BOB_MODEL:-${PI_MOBILE_WEB_MODEL:-openai-codex/gpt-5.6-sol}}}"

if pi_auth="$(pi auth check --model "${model}" --json --no-refresh 2>/dev/null)" && [[ "${pi_auth}" =~ \"status\"[[:space:]]*:[[:space:]]*\"ready\" ]]; then
  echo "Pi authentication ready for ${model}."
else
  echo "Authentication pending for Pi model ${model}." >&2
fi
if claude_auth="$(claude auth status 2>/dev/null)" && [[ "${claude_auth}" =~ \"loggedIn\"[[:space:]]*:[[:space:]]*true ]]; then
  echo "Claude authentication ready."
else
  echo "Authentication pending for Claude." >&2
fi
syncthing cli show system >/dev/null || { echo "Syncthing must be running and adopted by its CLI" >&2; exit 1; }
printf 'Validated Pi: %s\nValidated Claude: %s\nValidated Syncthing: %s\n' "${pi_version}" "${claude_version}" "${syncthing_version}"
