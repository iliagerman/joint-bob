#!/usr/bin/env bash
#
# One-command onboarding: install Joint Bob, and when Tailscale is present,
# expose it over tailnet HTTPS, then verify local and served health.
#
# Usage (pipe over SSH or run locally):
#   curl -fsSL https://raw.githubusercontent.com/iliagerman/joint-bob/main/scripts/bootstrap.sh | bash
#
# Environment:
#   PORT / HTTPS_PORT       forwarded to the app and Tailscale Serve (defaults 8787 / 8443)
#   JOINT_BOB_SKIP_SERVE=1  install only, skip the Tailscale Serve step
#
set -euo pipefail

PORT="${PORT:-8787}"
HTTPS_PORT="${HTTPS_PORT:-8443}"
APP_DIR="${HOME}/.local/share/joint-bob/app"
BASE_URL="https://raw.githubusercontent.com/iliagerman/joint-bob/main/scripts"

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || { echo "Run as a normal user, not root" >&2; exit 1; }

echo "==> Installing Joint Bob"
curl -fsSL "${BASE_URL}/install.sh" | PORT="${PORT}" bash

if [ "${JOINT_BOB_SKIP_SERVE:-0}" = "1" ]; then
  echo "==> Skipping Tailscale Serve (JOINT_BOB_SKIP_SERVE=1)"
elif command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  echo "==> Configuring Tailscale Serve on :${HTTPS_PORT}"
  PORT="${PORT}" HTTPS_PORT="${HTTPS_PORT}" "${APP_DIR}/scripts/serve-https.sh"
else
  echo "==> Tailscale not found or signed out; skipping Serve. Install and sign in to Tailscale, then run:" >&2
  echo "    PORT=${PORT} HTTPS_PORT=${HTTPS_PORT} ${APP_DIR}/scripts/serve-https.sh" >&2
fi

echo "==> Checking local health"
for _ in 1 2 3 4 5 6; do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "Local health OK: http://127.0.0.1:${PORT}/"
    break
  fi
  sleep 5
done
curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null || {
  echo "Local health check failed. Inspect the service logs before continuing." >&2
  exit 1
}

if command -v tailscale >/dev/null 2>&1 && [ "${JOINT_BOB_SKIP_SERVE:-0}" != "1" ] \
  && tailscale serve --https="${HTTPS_PORT}" status >/dev/null 2>&1; then
  host="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\).*/\1/p' | head -1)"
  if [ -n "${host}" ]; then
    echo "==> Expected private origin: https://${host}:${HTTPS_PORT}"
    echo "Verify it from ANOTHER tailnet node: curl -fsS https://${host}:${HTTPS_PORT}/api/health"
  fi
fi

echo "==> Next steps: open the URL above, create the administrator, sign in to Pi/Claude,"
echo "    then pair clusters or twins only after every peer passes /api/health."
