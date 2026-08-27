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

  // Pinning moved into the row overflow menu on both lists, so no row carries a pin
  // button any more and the inline marker is the only indicator — it always shows.
  assert.match(styles, /\.project-card\.pinned strong::after,\n\.session-card\.pinned strong::after \{[^}]*content: "\u{1F4CC}"/u);
  // The recents dialog still suppresses it — that list keeps a real pin button — but
  // no row in either main list does.
  assert.doesNotMatch(styles, /\.list-row[^\n]*\.pinned strong::after \{ content: none; \}/);
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
