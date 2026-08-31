#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:?Usage: post-deploy-smoke.sh BASE_URL EXPECTED_RELEASE}"
EXPECTED_RELEASE="${2:?Usage: post-deploy-smoke.sh BASE_URL EXPECTED_RELEASE}"
BASE_URL="${BASE_URL%/}"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

curl -fsS -o "${work}/health.json" -- "${BASE_URL}/api/health"
curl -fsS -o "${work}/index.html" -- "${BASE_URL}/"
for asset in boot.js app.js styles.css sw.js vendor/xterm/xterm.js; do
  mkdir -p "${work}/$(dirname "${asset}")"
  curl -fsS -o "${work}/${asset}" -- "${BASE_URL}/${asset}"
done
node --check "${work}/boot.js"
node --check "${work}/app.js"

EXPECTED_RELEASE="${EXPECTED_RELEASE}" node - "${work}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const health = JSON.parse(fs.readFileSync(path.join(root, "health.json"), "utf8"));
if (health.status !== "ok" || health.release !== process.env.EXPECTED_RELEASE) {
  throw new Error(`Unexpected deployed release: ${JSON.stringify(health)}`);
}
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
for (const asset of ["/boot.js", "/app.js", "/styles.css"]) {
  if (!html.includes(asset)) throw new Error(`Application shell does not load ${asset}`);
}
const bindings = new Set([...app.matchAll(/^  ([A-Za-z_$][\w$]*): (?:document\.querySelector|Array\.from\(document\.querySelectorAll)/gm)].map((match) => match[1]));
const references = new Set([...app.matchAll(/elements\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]));
const missingBindings = [...references].filter((name) => !bindings.has(name)).sort();
if (missingBindings.length) throw new Error(`Unbound UI elements: ${missingBindings.join(", ")}`);
const ids = [...app.matchAll(/^  [A-Za-z_$][\w$]*: document\.querySelector\("#([A-Za-z_$][\w$-]*)/gm)].map((match) => match[1]);
const missingIds = ids.filter((id) => !html.includes(`id="${id}"`)).sort();
if (missingIds.length) throw new Error(`Missing application shell elements: ${missingIds.join(", ")}`);
NODE

printf 'Post-deploy smoke passed for %s at %s.\n' "${EXPECTED_RELEASE}" "${BASE_URL}"
