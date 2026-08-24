import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the projects list is grouped by type and each group collapses", async () => {
  const [app, styles, serviceWorker] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);

  // Grouping is driven by the configured types, which must load before the projects render.
  assert.match(app, /function groupedProjects\(projects\)/);
  assert.match(app, /await loadProjectTypes\(\);\s*\n\s*await loadProjects\(\);/);

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

  assert.match(serviceWorker, /joint-bob-v(?:[2-9]|\d{2,})/);
});

test("the app holds a boot screen until the first load settles", async () => {
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

  // The shell stays hidden until initialisation settles, success or failure.
  assert.match(html, /<body class="view-projects booting">/);
  assert.match(html, /class="app-boot"/);
  assert.match(styles, /body\.booting :is\(\.shell, \.mobile-nav\) \{ visibility: hidden; \}/);
  assert.match(app, /\.finally\(\(\) => document\.body\.classList\.remove\("booting"\)\)/);
});
