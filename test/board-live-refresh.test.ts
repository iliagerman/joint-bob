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

test("the watch socket is rebound when the active project changes", async () => {
  const app = await readFile("public/app.js", "utf8");
  const ensure = functionBody(app, "function ensureWatchSocket() {");

  // The subscription is bound to one project at connect time, so reusing a live
  // socket from the project we left drops every tasksChanged broadcast for the
  // project we are on — the board then only catches up on a page reload.
  assert.match(ensure, /state\.watchProjectId === state\.activeProjectId/);
  assert.match(ensure, /state\.watchProjectId = state\.activeProjectId;/);
  assert.match(ensure, /url\.searchParams\.set\("projectId", state\.activeProjectId\)/);
});

test("closing the watch socket forgets the project it was watching", async () => {
  const app = await readFile("public/app.js", "utf8");
  const close = functionBody(app, "function closeWatchSocket() {");

  // Otherwise the stale id survives and the next connect is skipped as a match.
  assert.match(close, /state\.watchProjectId = null;/);
});

test("a tasksChanged broadcast reloads the board", async () => {
  const app = await readFile("public/app.js", "utf8");

  // Both sockets carry it: the chat socket and the project watch socket.
  const handlers = app.match(/payload\.type === "tasksChanged"/g) ?? [];
  assert.equal(handlers.length, 2, "tasksChanged is not handled on both sockets");
  assert.match(functionBody(app, "async function loadTasks() {"), /renderBoardView\(\);/);
});

test("the server tells the project when a ticket gains its conversation", async () => {
  const server = await readFile("src/server.ts", "utf8");
  const persist = functionBody(server, "async function persistTaskSessionPath(");

  assert.match(persist, /updateTaskSessionPath\(/);
  assert.match(persist, /broadcastToProject\(projectId, \{ type: "tasksChanged" \}\)/);
});

test("a background refresh re-anchors an open row menu instead of closing it", async () => {
  const app = await readFile("public/app.js", "utf8");
  const refresh = functionBody(app, "function refreshRowMenuAnchor() {");

  // A running ticket writes its transcript about once a second, and every write
  // refreshes the conversation list. Closing the menu on each refresh made the
  // ticket card's overflow button look dead.
  assert.match(refresh, /placeRowMenu\(/);
  assert.match(refresh, /state\.rowMenuAnchorSelector/);
  assert.match(refresh, /togglePopover\(false\)/);

  for (const header of ["function renderProjects() {", "function renderSessions() {", "function renderBoardView() {"]) {
    const body = functionBody(app, header);
    assert.match(body, /queueMicrotask\(refreshRowMenuAnchor\);/, `${header} still slams the row menu shut`);
    assert.doesNotMatch(body, /rowMenu\.togglePopover\(false\)/, `${header} still slams the row menu shut`);
  }
});

test("the board menu can find its button again after the cards are rebuilt", async () => {
  const app = await readFile("public/app.js", "utf8");
  const board = await readFile("public/board.js", "utf8");

  // renderBoard replaces every card, so the anchor node the menu was opened from
  // is gone; the selector is how it finds the fresh one.
  assert.match(board, /handlers\.onMenu\(menuButton, taskMenuItems\(task, handlers\), task\)/);
  assert.match(app, /onMenu: \(anchor, items, task\) => openRowMenu\(anchor, items, `\[data-task-id="\$\{CSS\.escape\(task\.id\)\}"\] \[data-testid="board-task-menu-button"\]`\)/);
});
