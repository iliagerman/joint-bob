import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("the changelog parses versions, dates, and bullets newest first", async () => {
  const { parseChangelog } = await import("../src/changelog.js");

  const entries = parseChangelog([
    "# Changelog",
    "",
    "## 0.3.0 — 2026-09-01",
    "",
    "- Added a changelog view",
    "- Showed the semantic version",
    "",
    "## 0.2.1 — 2026-08-30",
    "",
    "- Fixed a board regression",
    "",
  ].join("\n"));

  assert.deepEqual(entries, [
    { version: "0.3.0", date: "2026-09-01", changes: ["Added a changelog view", "Showed the semantic version"] },
    { version: "0.2.1", date: "2026-08-30", changes: ["Fixed a board regression"] },
  ]);
});

test("the changelog keeps at most ten versions", async () => {
  const { parseChangelog } = await import("../src/changelog.js");

  const source = Array.from({ length: 14 }, (_, index) => `## 1.0.${13 - index}\n\n- Change ${13 - index}\n`).join("\n");
  const entries = parseChangelog(source);

  assert.equal(entries.length, 10);
  assert.equal(entries[0].version, "1.0.13");
  assert.equal(entries[9].version, "1.0.4");
  assert.deepEqual(entries[9].changes, ["Change 4"]);
});

test("a heading without a date and a version without bullets still parse", async () => {
  const { parseChangelog } = await import("../src/changelog.js");

  assert.deepEqual(parseChangelog("## 1.2.3\n\n## 1.2.2\n\n- Only here\n"), [
    { version: "1.2.3", date: null, changes: [] },
    { version: "1.2.2", date: null, changes: ["Only here"] },
  ]);
});

test("the running version is the semantic version from package.json", async () => {
  const { appVersion } = await import("../src/changelog.js");
  const manifest = JSON.parse(await readFile("package.json", "utf8"));

  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(appVersion(), manifest.version);
});

test("the shipped changelog documents the version being released", async () => {
  const { readChangelog } = await import("../src/changelog.js");
  const manifest = JSON.parse(await readFile("package.json", "utf8"));

  const entries = readChangelog();
  assert.ok(entries.length >= 1, "CHANGELOG.md has no versions");
  assert.equal(entries[0].version, manifest.version, "CHANGELOG.md is missing a section for the current package version");
  assert.ok(entries[0].changes.length >= 1, "The current version has no changes listed");

  // CHANGELOG.md must reach every installed node, so it belongs in the published files.
  assert.ok(manifest.files.includes("CHANGELOG.md"));
});

test("the last seen version round-trips through user preferences", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-changelog-prefs-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const suffix = `${Date.now()}-${Math.random()}`;
  const { createAdministrator, authenticate } = await import(`../src/auth.js?changelog=${suffix}`);
  const { getUserPreferences, updateUserPreferences } = await import(`../src/preferences.js?changelog=${suffix}`);

  try {
    createAdministrator("changelog-reader", "correct horse battery staple", false);
    const { userId } = authenticate("changelog-reader", "correct horse battery staple");
    assert.equal(getUserPreferences(userId).lastSeenVersion, null);

    assert.equal(updateUserPreferences(userId, { lastSeenVersion: "0.2.0" }).lastSeenVersion, "0.2.0");
    assert.equal(getUserPreferences(userId).lastSeenVersion, "0.2.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the server reports the semantic version and serves the changelog", async () => {
  const server = await readFile("src/server.ts", "utf8");

  assert.match(server, /import \{ appVersion, readChangelog \} from "\.\/changelog\.js";/);
  assert.match(server, /response\.json\(\{ status: "ok", version, release \}\)/);
  assert.match(server, /app\.get\("\/api\/changelog"/);
  assert.match(server, /response\.json\(\{ version: appVersion\(\), entries: readChangelog\(\) \}\)/);
  assert.match(server, /lastSeenVersion: z\.string\(\)\.trim\(\)\.regex\(\/\^\\d\+\\\.\\d\+\\\.\\d\+\$\/\)\.nullable\(\)\.optional\(\)/);

  // The changelog is behind the session guard like every other authenticated read.
  assert.ok(!server.includes('"GET /changelog"'));
});

test("the app menu shows the semantic version and settings has a changelog tab", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  assert.match(app, /elements\.appMenuVersion\.textContent = `Version \$\{health\.version\}`;/);
  assert.doesNotMatch(app, /\^\[0-9a-f\]\{40\}\$/);

  assert.match(html, /data-settings-tab="changelog"/);
  assert.match(html, /data-testid="settings-tab-changelog"/);
  assert.match(html, /id="settingsPanel-changelog"/);
  assert.match(html, /data-testid="settings-changelog-list"/);
  assert.match(app, /renderChangelogEntries\(elements\.settingsChangelogList, entries\)/);
});

test("the what's new dialog opens once per upgrade and never on a fresh install", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  assert.match(html, /<dialog id="whatsNewDialog" data-testid="whats-new-dialog">/);
  assert.match(html, /data-testid="whats-new-list"/);
  assert.match(html, /data-testid="whats-new-dismiss-button"/);

  const start = app.indexOf("async function showWhatsNew(");
  assert.ok(start >= 0, "Missing showWhatsNew");
  const body = app.slice(start, app.indexOf("\n}", start));

  // A first-ever visit records the version silently; only a newer version opens the dialog.
  assert.match(body, /if \(!lastSeenVersion\) \{[\s\S]*savePreferencesInBackground\(\{ lastSeenVersion: version \}\);[\s\S]*return;/);
  assert.match(body, /if \(!isNewerVersion\(version, lastSeenVersion\)\) return;/);
  assert.match(body, /entries\.filter\(\(entry\) => isNewerVersion\(entry\.version, lastSeenVersion\)\)/);
  assert.match(body, /elements\.whatsNewDialog\.showModal\(\);/);

  assert.match(app, /void showWhatsNew\(preferences\.lastSeenVersion\)/);

  const compareStart = app.indexOf("function isNewerVersion(");
  assert.ok(compareStart >= 0, "Missing isNewerVersion");
  const compare = app.slice(compareStart, app.indexOf("\n}", compareStart));
  assert.match(compare, /split\("\."\)\.map\(Number\)/);
});
