import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("projects and conversations can be pinned to the top of their list", async () => {
  const [app, styles] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  assert.match(app, /testid: "project-pin-button"/);
  assert.match(app, /testid: "session-pin-button"/);
  assert.match(app, /button\.dataset\.testid = testid;/);
  assert.match(app, /function isProjectPinned\(projectId\)/);
  assert.match(app, /function isSessionPinned\(sessionPath\)/);
  assert.match(app, /function togglePinnedProject\(projectId\)/);
  assert.match(app, /function togglePinnedSession\(sessionPath\)/);

  // Pinned projects float inside their own type group, so the type grouping survives.
  assert.match(app, /function sortPinnedFirst\(/);
  assert.match(app, /savePreferencesInBackground\(\{ pinnedProjectIds/);
  assert.match(app, /savePreferencesInBackground\(\{ pinnedSessionPaths/);
  assert.doesNotMatch(app, /\.setItem\(/);

  assert.match(styles, /\.pin-button\.pinned/);

  // The inline pin marker stands in only while the pin button is hidden; when the
  // button is on screen the marker is suppressed so the row shows exactly one pin.
  assert.match(styles, /\.list-row:is\(:hover, :focus-within\) :is\(\.project-card, \.session-card\)\.pinned strong::after \{ content: none; \}/);
  assert.match(styles, /\.list-row\.active :is\(\.project-card, \.session-card\)\.pinned strong::after \{ content: none; \}/);
});

test("a pinned conversation survives the recency cap on the session list", async () => {
  const harnesses = await readFile("src/harnesses.ts", "utf8");

  // The cap keeps the list fast, but a pinned conversation must never fall off it.
  assert.match(harnesses, /pinnedSessionPaths/);
  assert.match(harnesses, /export async function listHarnessSessions\(project: HarnessProject, pinnedSessionPaths: string\[\] = \[\]\)/);
});

test("pinned ids and panel collapse round-trip through the preferences API", async () => {
  const [preferences, server] = await Promise.all([
    readFile("src/preferences.ts", "utf8"),
    readFile("src/server.ts", "utf8"),
  ]);

  for (const field of ["pinnedProjectIds", "pinnedSessionPaths", "projectsPanelCollapsed", "chatsPanelCollapsed"]) {
    assert.ok(preferences.includes(field), `preferences.ts is missing ${field}`);
    assert.ok(server.includes(field), `server.ts is missing ${field}`);
  }

  // Added with the same guarded ALTER TABLE recipe the other late columns use.
  assert.match(preferences, /ALTER TABLE user_preferences ADD COLUMN pinned_project_ids TEXT NOT NULL DEFAULT '\[\]'/);
  assert.match(preferences, /ALTER TABLE user_preferences ADD COLUMN pinned_session_paths TEXT NOT NULL DEFAULT '\[\]'/);
  assert.match(preferences, /ALTER TABLE user_preferences ADD COLUMN projects_panel_collapsed INTEGER NOT NULL DEFAULT 0/);
  assert.match(preferences, /ALTER TABLE user_preferences ADD COLUMN chats_panel_collapsed INTEGER NOT NULL DEFAULT 0/);
});
