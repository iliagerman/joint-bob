#!/usr/bin/env bash
#
# Expose Joint Bob over HTTPS inside your tailnet.
#
# This runs `tailscale serve`, which terminates TLS with a valid *.ts.net
# certificate and proxies to the local app. It is TAILNET-ONLY: reachable
# only by devices signed into your Tailscale account, NOT the public
# internet. (Public access would require `tailscale funnel`, which this
# script never runs.)
#
# Run this ON THE HOME SERVER, after the app is started (`npm run start`).
#
# Usage:
#   ./scripts/serve-https.sh                         # installed app on 8787 -> HTTPS :8443
#   PORT=9000 ./scripts/serve-https.sh               # custom app port
#   HTTPS_PORT=443 ./scripts/serve-https.sh          # serve on 443 if it is free
#
# Tailscale HTTPS ports must be one of: 443, 8443, 10000. We default to 8443
# because many home servers already run another web server on 443. A PWA
# secure context (and the install prompt) works on any HTTPS port, so :8443
# is perfectly fine.
#
set -euo pipefail

PORT="${PORT:-8787}"
HTTPS_PORT="${HTTPS_PORT:-8443}"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "Error: the 'tailscale' CLI was not found on this machine." >&2
  echo "Run this on the home server with Tailscale installed: https://tailscale.com/download" >&2
  exit 1
fi

echo "Enabling tailnet HTTPS on :${HTTPS_PORT} -> http://127.0.0.1:${PORT} ..."
# --bg keeps it running in the background and persists across reboots.
tailscale serve --bg --https="${HTTPS_PORT}" "${PORT}"

echo
echo "Serve is active. Current configuration:"
tailscale serve status || true

cat <<EOF

Open the app on your phone at the https://<machine>.<tailnet>.ts.net URL
shown above (no :${PORT} in the URL — Serve proxies it for you). The install
prompt will now work because the page is served over HTTPS.

Manage it later with:
  tailscale serve status                      # show what is currently served
  tailscale serve --https=${HTTPS_PORT} off   # turn this proxy off
  tailscale serve reset                       # clear all serve config

Note: this is tailnet-only. Do NOT run 'tailscale funnel' unless you
specifically want to publish the app to the public internet.
EOF
