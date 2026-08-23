import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("settings tabs absorb notification, GitHub, and cluster configuration", async () => {
  const [html, app, styles, serviceWorker] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);

  // The tab strip is a real tablist so screen readers and arrow keys work.
  assert.match(html, /class="settings-tabs"[^>]*role="tablist"/);
  for (const tab of ["account", "notifications", "github", "cluster", "projects", "engines"]) {
    assert.match(html, new RegExp(`data-settings-tab="${tab}"[^>]*role="tab"`));
    assert.match(html, new RegExp(`id="settingsPanel-${tab}"[^>]*role="tabpanel"`));
  }
  assert.match(html, /aria-selected="true"/);

  // The standalone GitHub and cluster dialogs are gone; their bodies live in tabs.
  assert.doesNotMatch(html, /<dialog id="githubSettingsDialog"/);
  assert.doesNotMatch(html, /<dialog id="clusterDialog"/);
  assert.match(html, /id="settingsPanel-cluster"[\s\S]*id="clusterNodeNameInput"/);
  assert.match(html, /id="settingsPanel-github"[\s\S]*id="githubGroupList"/);
  assert.match(html, /id="githubGroupAddButton"/);

  // Personal/Sela are no longer hardcoded anywhere in the UI.
  assert.doesNotMatch(html, /personalTokenInput|selaTokenInput/);
  assert.doesNotMatch(app, /personalTokenInput|selaTokenInput/);
  assert.match(html, /id="projectGithubGroupInput"/);

  // Toolbar shortcuts open settings on the matching tab instead of separate dialogs.
  assert.match(app, /openSettings\("github"\)/);
  assert.match(app, /openSettings\("cluster"\)/);
  assert.match(app, /function selectSettingsTab/);
  assert.match(app, /ArrowRight|ArrowLeft/);

  // Styling: a scrollable strip on narrow screens, and no animation for reduced-motion users.
  assert.match(styles, /\.settings-tabs\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(styles, /\.settings-tab\[aria-selected="true"\]/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.settings-tab/);

  // Installed PWA clients must not keep the old shell.
  assert.match(serviceWorker, /joint-bob-v[2-9]\d*/);
});
