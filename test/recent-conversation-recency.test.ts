import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/** Returns the source text of a function, from its header to its closing brace at column 0. */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} not found`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `${header} has no closing brace`);
  return source.slice(start, end);
}

test("recents are ordered by the conversation's own activity, not by when it was opened", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /function recentSessionActivityAt\(entry\)/);
  const render = functionBody(app, "function renderRecentSessionsDialog() {");
  assert.match(render, /recentSessionActivityAt\(right\)[\s\S]*?localeCompare[\s\S]*?recentSessionActivityAt\(left\)/);
  // The row's own timestamp shows that same activity time.
  assert.match(render, /formatDate\(recentSessionActivityAt\(entry\)\)/);
  assert.ok(!render.includes("formatDate(entry.openedAt)"), "the row still shows the open time");
});

test("an opened conversation records its latest activity, and the list keeps it fresh", async () => {
  const app = await readFile("public/app.js", "utf8");

  const remember = functionBody(app, "function rememberRecentSession(session) {");
  assert.match(remember, /updatedAt: session\.updatedAt \?\? session\.createdAt \?\? null/);

  // Conversations move on while the recents dialog is closed, so the stored time
  // is refreshed from every session-list render.
  assert.match(app, /function syncRecentSessionActivity\(\)/);
  const sync = functionBody(app, "function syncRecentSessionActivity() {");
  assert.match(sync, /state\.sessions\.find/);
  const renderSessions = functionBody(app, "function renderSessions() {");
  assert.match(renderSessions, /syncRecentSessionActivity\(\);/);
});
