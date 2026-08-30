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

test("a ticket card shows only open-chat, open-ticket, overflow and the two move arrows", async () => {
  const board = await readFile("public/board.js", "utf8");
  const actions = functionBody(board, "function taskCardActions(task, handlers) {");

  for (const testid of [
    "board-task-open-chat-button",
    "board-task-open-ticket-button",
    "board-task-menu-button",
    "board-task-move-left-button",
    "board-task-move-right-button",
  ]) {
    assert.ok(actions.includes(testid), `the action row is missing ${testid}`);
  }

  // Everything else moved into the overflow menu, so the row can never wrap.
  for (const testid of [
    "board-task-merge-button",
    "board-task-models-button",
    "board-task-archive-button",
    "board-task-delete-button",
  ]) {
    assert.ok(!actions.includes(testid), `${testid} still sits in the action row`);
  }

  // The two visible actions are icon buttons with an accessible name.
  assert.match(actions, /label: `Open chat for \$\{task\.title\}`/);
  assert.match(actions, /label: `Open ticket \$\{task\.title\}`/);
  assert.match(actions, /icon: "chat"/);
  assert.match(actions, /icon: "ticket"/);
});

test("the overflow menu owns every remaining ticket action", async () => {
  const board = await readFile("public/board.js", "utf8");
  const items = functionBody(board, "function taskMenuItems(task, handlers) {");

  for (const testid of [
    "board-task-merge-button",
    "board-task-handoff-button",
    "board-task-models-button",
    "board-task-archive-button",
    "board-task-delete-button",
  ]) {
    assert.ok(items.includes(testid), `the overflow menu is missing ${testid}`);
  }

  // Same contract as the project and session menus: one icon per item.
  const icons = items.match(/icon: "/g)?.length ?? 0;
  const testids = items.match(/testid: "/g)?.length ?? 0;
  assert.equal(icons, testids, `taskMenuItems has ${testids} items but only ${icons} icons`);
});

test("every board menu icon is defined in the shared icon set", async () => {
  const [app, board] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/board.js", "utf8"),
  ]);

  const defined = functionBody(app, "const rowMenuIconPaths = {");
  const items = functionBody(board, "function taskMenuItems(task, handlers) {");
  for (const match of items.matchAll(/icon: "([a-z-]+)"/g)) {
    assert.ok(defined.includes(`${match[1]}:`), `rowMenuIconPaths is missing "${match[1]}"`);
  }
  assert.match(app, /onMenu: \(anchor, items\) => openRowMenu\(anchor, items\)/);

  // The card's own icon buttons draw from the board's icon set.
  const cardIcons = functionBody(board, "const cardIconPaths = {");
  for (const match of functionBody(board, "function taskCardActions(task, handlers) {").matchAll(/icon: "([a-z-]+)"/g)) {
    assert.ok(cardIcons.includes(`${match[1]}:`), `cardIconPaths is missing "${match[1]}"`);
  }
});

test("the card action row is a single non-wrapping strip", async () => {
  const styles = await readFile("public/styles.css", "utf8");

  assert.match(styles, /\.task-card-actions \{[^}]*display: flex;[^}]*/);
  assert.doesNotMatch(functionBodyCss(styles, ".task-card-actions {"), /flex-wrap: wrap/);
  assert.match(styles, /\.task-card-icon \{[^}]*width: 16px;[^}]*height: 16px;/);
});

function functionBodyCss(styles: string, header: string): string {
  const start = styles.indexOf(header);
  assert.notEqual(start, -1, `${header} not found`);
  return styles.slice(start, styles.indexOf("}", start));
}

test("a running ticket links to its conversation before the run finishes", async () => {
  const server = await readFile("src/server.ts", "utf8");

  // The session path is written to the ticket as soon as the run owns a session.
  assert.match(server, /async function persistTaskSessionPath\(/);
  assert.match(server, /await persistTaskSessionPath\(/);
  // The conversation is named after the ticket instead of the workspace preamble.
  assert.match(server, /ensureSessionTitle/);
});

test("a ticket conversation keeps a user rename", async () => {
  const names = await readFile("src/names.ts", "utf8");

  assert.match(names, /export async function ensureSessionTitle\(conversationId: string, title: string\): Promise<void>/);
  assert.match(names, /if \(overrides\[conversationId\]\) return;/);
});

test("opening a ticket conversation searches the ticket workspaces too", async () => {
  const server = await readFile("src/server.ts", "utf8");

  // The websocket open path must list the same conversations the sidebar lists,
  // or a ticket-workspace conversation is rejected as "Conversation not found".
  const open = server.slice(server.indexOf('if (rawSessionPath === "watch")'));
  const listed = open.indexOf("const listed = requestedSessionPath");
  assert.notEqual(listed, -1, "the websocket open path no longer lists sessions");
  assert.match(open.slice(listed, listed + 400), /additionalPaths/);
});

test("a reconnect never pulls the user off the board", async () => {
  const app = await readFile("public/app.js", "utf8");

  // openSession doubles as the reconnect path, so it may only change the visible
  // panel when the caller is a deliberate open (which also clears the transcript).
  const open = functionBody(app, "function openSession(sessionPath, title = ");
  assert.match(open, /if \(!preserveChat\) setMobileView\("chat"\);/);
  assert.ok(!/^  setMobileView\("chat"\);$/m.test(open), "openSession still switches view unconditionally");
});
