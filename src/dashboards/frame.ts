import { readFileSync } from "node:fs";
import path from "node:path";
import { dashboardKitDirectory } from "./creator-prompt.js";

const kitCss = readFileSync(path.join(dashboardKitDirectory, "kit.css"), "utf8");
const kitJs = readFileSync(path.join(dashboardKitDirectory, "kit.js"), "utf8");

/**
 * The dashboard frame runs in a sandbox without the app's origin; this policy also leaves it no
 * way to load or send anything: inline kit and page only, images only as data URLs.
 */
export const FRAME_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  // Opened as a page of its own, it still gets an opaque origin: never the app's cookies or API.
  "sandbox allow-scripts",
].join("; ");

/** `<` is escaped so no value can close the JSON element and become markup. */
function embeddedJson(value: unknown): string {
  return JSON.stringify(value ?? {}).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

/** One self-contained document: the kit, the latest payload, then the dashboard's own page. */
export function composeFrame(input: { html: string; payload: unknown; theme: "light" | "dark" }): string {
  return `<!doctype html>
<html lang="en" data-theme="${input.theme}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${kitCss}</style></head>
<body>
<script type="application/json" id="payload">${embeddedJson(input.payload)}</script>
<main id="app"></main>
<script>${kitJs}</script>
${input.html}
</body>
</html>`;
}
