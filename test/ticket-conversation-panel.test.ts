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

test("the ticket dialog has a Settings tab and a Conversation tab", async () => {
  const html = await readFile("public/index.html", "utf8");

  assert.match(html, /data-task-tab="settings"[^>]*role="tab"/);
  assert.match(html, /data-task-tab="conversation"[^>]*role="tab"/);
  assert.match(html, /data-testid="task-tab-settings"/);
  assert.match(html, /data-testid="task-tab-conversation"/);
  // The ticket's own fields live under Settings; the tab label says so.
  assert.match(html, /data-testid="task-tab-settings">Settings</);
  // The live chat is moved into this host, so it starts empty.
  assert.match(html, /id="taskChatHost"[^>]*role="tabpanel"/);
});

test("the composer is not nested inside the ticket form", async () => {
  const html = await readFile("public/index.html", "utf8");

  // A <form> inside a <form> is invalid HTML and the browser drops it, so the
  // chat host must be a sibling of #taskForm, not a descendant.
  const dialog = html.slice(html.indexOf('<dialog id="taskDialog">'), html.indexOf('<dialog id="taskDialog">') + 6000);
  const formStart = dialog.indexOf('id="taskForm"');
  const formEnd = dialog.indexOf("</form>", formStart);
  const hostAt = dialog.indexOf('id="taskChatHost"');
  assert.notEqual(hostAt, -1, "the ticket dialog has no chat host");
  assert.ok(hostAt > formEnd, "the chat host is inside #taskForm");
});

test("the dialog hosts the real chat nodes instead of a copy", async () => {
  const app = await readFile("public/app.js", "utf8");

  // Relocating the live nodes keeps streaming, tool bubbles and attachments
  // working, because every existing `elements.*` reference still points at them.
  assert.match(app, /function taskChatNodes\(\)/);
  const nodes = functionBody(app, "function taskChatNodes() {");
  for (const id of ["messages", "reconnectBanner", "commandStrip", "conversationLock", "composer"]) {
    assert.ok(nodes.includes(`elements.${id}`), `taskChatNodes is missing ${id}`);
  }
  assert.match(app, /function attachChatToTaskDialog\(\)/);
  assert.match(app, /function detachChatFromTaskDialog\(\)/);
  // Put back in the same order, so the chat panel is unchanged after closing.
  assert.match(functionBody(app, "function detachChatFromTaskDialog() {"), /elements\.chatPanel\.append/);
});

test("opening a ticket with a conversation connects it and restores the view on close", async () => {
  const app = await readFile("public/app.js", "utf8");

  const open = functionBody(app, "function openEditTaskDialog(task) {");
  assert.match(open, /task\.sessionPath/);
  assert.match(open, /openSession\(task\.sessionPath, task\.title, false, true\)/);
  assert.match(open, /setTaskDialogTab\(/);

  // Closing puts the chat back where it came from and returns to the board.
  assert.match(app, /function closeTaskDialog\(\)/);
  const close = functionBody(app, "function closeTaskDialog() {");
  assert.match(close, /detachChatFromTaskDialog\(\)/);
});

test("a ticket with no conversation cannot open the Conversation tab", async () => {
  const app = await readFile("public/app.js", "utf8");

  const setTab = functionBody(app, "function setTaskDialogTab(tab) {");
  assert.match(setTab, /aria-selected/);
  assert.match(setTab, /elements\.taskForm\.hidden = tab !== "settings"/);
  assert.match(functionBody(app, "function openEditTaskDialog(task) {"), /conversationTabButton\(\)\.disabled = !task\.sessionPath/);
});

test("the new-ticket dialog opens on Settings with the Conversation tab locked", async () => {
  const app = await readFile("public/app.js", "utf8");

  // The dialog is shared. Without this reset it reopens on whichever tab the
  // previously edited ticket left selected, showing an empty chat host.
  const open = functionBody(app, "function openNewTaskDialog(status = \"backlog\") {");
  assert.match(open, /conversationTabButton\(\)\.disabled = true/);
  assert.match(open, /setTaskDialogTab\("settings"\)/);
});

test("the chat host gives the transcript a bounded, scrollable height", async () => {
  const styles = await readFile("public/styles.css", "utf8");

  assert.match(styles, /\.task-chat-host \{[^}]*display: flex;[^}]*flex-direction: column;/);
  assert.match(styles, /\.task-chat-host \{[^}]*height:/);
});
