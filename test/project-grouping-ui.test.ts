import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the projects list is grouped by type and each group collapses", async () => {
  const [app, styles, serviceWorker] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);

  // Grouping is driven by the configured workspaces, which must load before the projects render.
  assert.match(app, /function groupedProjects\(projects\)/);
  assert.match(app, /await loadWorkspaces\(\);\s*\n\s*await loadProjects\(\);/);

  // A native <details> carries the collapsing, so there is no hand-rolled toggle state.
  assert.match(app, /document\.createElement\("details"\)/);
  assert.match(app, /document\.createElement\("summary"\)/);
  assert.match(app, /dataset\.testid = "project-group"/);
  assert.match(app, /function projectRow\(project\)/);

  // Collapsed groups are page-view state only: Web Storage stays banned in this file.
  assert.match(app, /const collapsedProjectGroups = new Set\(\);/);
  assert.doesNotMatch(app, /\.setItem\(/);

  assert.match(styles, /\.project-group-summary \{/);
  assert.match(styles, /\.project-group\[open\] > \.project-group-summary::before/);
  for (const selector of [".message-content.md", ".task-card", ".settings-tabs", ".reconnect-banner", ".folder-browser", ".project-sync-status", ".session-agent-label"]) {
    assert.ok(styles.includes(selector));
  }

  assert.match(serviceWorker, /joint-bob-v82/);
});

test("the branded boot screen releases before project discovery", async () => {
  const [html, app, styles, boot] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("public/boot.js", "utf8"),
  ]);

  // The theme is set before first paint by a same-origin script; CSP forbids an inline one.
  assert.match(html, /<script src="\/boot\.js"><\/script>/);
  assert.match(boot, /document\.documentElement\.dataset\.theme = theme;/);
  assert.doesNotMatch(boot, /localStorage|sessionStorage/);

  assert.match(html, /<body class="view-projects booting">/);
  assert.match(html, /class="app-boot"/);
  assert.match(html, /class="boot-smoke/);
  assert.match(html, /class="app-boot-wordmark">Joint Bob</);
  assert.doesNotMatch(html.match(/<div class="app-boot"[\s\S]*?<\/div>\s*<\/div>/)?.[0] || "", /list-loading/);
  assert.match(styles, /body\.booting :is\(\.shell, \.mobile-nav\) \{ visibility: hidden; \}/);
  assert.match(styles, /@keyframes boot-smoke-rise/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
  assert.match(app, /const BOOT_MINIMUM_MS = 700;/);
  assert.match(app, /const BOOT_REQUEST_TIMEOUT_MS = 8_000;/);
  assert.match(app, /api\("\/api\/auth\/status", \{ signal: AbortSignal\.timeout\(BOOT_REQUEST_TIMEOUT_MS\) \}\)/);
  assert.match(app, /api\("\/api\/preferences", \{ signal: AbortSignal\.timeout\(BOOT_REQUEST_TIMEOUT_MS\) \}\)/);
  assert.match(app, /function revealApplication\(\)/);
  assert.match(app, /if \(!status\.authenticated\) \{\s*revealApplication\(\);\s*showLogin\(\);/);
  assert.match(app, /void api\("\/api\/cluster\/projects\/discover"[\s\S]*?\.then\(async \(discovery\) =>/);

  const themeReady = app.indexOf("setTheme(preferences.theme");
  const reveal = app.indexOf("revealApplication();", themeReady);
  const discovery = app.indexOf('api("/api/cluster/projects/discover"', themeReady);
  assert.ok(themeReady >= 0 && reveal > themeReady && reveal < discovery, "boot must release before project discovery");
});
