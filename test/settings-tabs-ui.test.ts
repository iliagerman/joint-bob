import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("settings tabs absorb notification, secret, and cluster configuration", async () => {
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
  // Workspaces live in the Projects tab; the Secrets tab carries every secret account.
  assert.match(html, /id="settingsPanel-projects"[\s\S]*id="workspaceList"/);
  assert.match(html, /id="workspaceAddButton"/);
  assert.match(html, /id="settingsPanel-github"[\s\S]*id="secretAccountList"/);

  // Personal/Sela are no longer hardcoded anywhere in the UI.
  assert.doesNotMatch(html, /personalTokenInput|selaTokenInput/);
  assert.doesNotMatch(app, /personalTokenInput|selaTokenInput/);
  // The per-project GitHub override is gone; a project attaches secret accounts instead.
  assert.doesNotMatch(html, /id="projectGithubGroupInput"/);

  // One gear button opens Settings; the old toolbar strip and its shortcuts are gone.
  assert.match(html, /id="settingsButton"[^>]*aria-label="Settings"/);
  assert.doesNotMatch(html, /id="projectsToolbar"/);
  assert.doesNotMatch(app, /projectsMenuButton|githubSettingsButton|clusterButton/);
  assert.match(html, /id="settingsPanel-account"[\s\S]*id="themeToggleButton"/);
  assert.match(app, /function selectSettingsTab/);
  assert.match(app, /ArrowRight|ArrowLeft/);

  // Styling: a scrollable strip on narrow screens, and no animation for reduced-motion users.
  assert.match(styles, /\.settings-tabs\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(styles, /\.settings-tab\[aria-selected="true"\]/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.settings-tab/);

  // Workspaces are data now, not two hardcoded options.
  assert.match(html, /id="workspaceList"/);
  assert.match(html, /id="workspaceAddButton"/);
  assert.doesNotMatch(html, /<option value="personal">Personal<\/option>/);
  assert.match(app, /api\("\/api\/workspaces"\)/);
  assert.match(app, /function fillWorkspaceSelect/);

  // The dialog widens on the dense tabs, and its opening focus draws no ring.
  assert.match(app, /elements\.settingsForm\.dataset\.tab = name/);
  assert.doesNotMatch(styles, /\.settings-card\[data-tab=/);
  assert.match(styles, /\.settings-card \{[^}]*width: min\(900px/);
  assert.match(styles, /\.settings-panel \{[^}]*height: min\(440px/);
  assert.match(html, /class="dialog-heading" tabindex="-1" autofocus/);
  assert.match(styles, /\.dialog-heading:focus \{ outline: none; \}/);

  // Engine paths and Syncthing are automatic; normal settings do not ask for Syncthing credentials.
  assert.match(html, /Engine paths are detected automatically/);
  assert.match(html, /Syncthing is installed, started, discovered, and configured automatically/);
  assert.doesNotMatch(html, /settingsSyncthingEndpoint|settingsSyncthingApiKey/);
  assert.doesNotMatch(app, /settingsSyncthingEndpoint|settingsSyncthingApiKey/);

  // Managed project folders sit directly under the home folder.
  assert.doesNotMatch(app, /\/projects\/\$\{elements\.projectWorkspaceInput\.value\}/);

  // Installed PWA clients must not keep the old shell.
  assert.match(serviceWorker, /joint-bob-v(?:[2-9]|\d{2,})/);
});
