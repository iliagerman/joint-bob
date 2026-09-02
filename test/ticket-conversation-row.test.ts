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

test("a conversation that belongs to a ticket is marked in the conversations list", async () => {
  const app = await readFile("public/app.js", "utf8");

  // The ticket is resolved from the board's task list, keyed by the session's taskId.
  assert.match(app, /function sessionTicketTask\(session\) \{/);
  const resolve = functionBody(app, "function sessionTicketTask(session) {");
  assert.match(resolve, /state\.tasks\.find\(\(task\) => task\.id === session\.taskId\)/);

  // The row carries a class, so CSS can widen the button lane without probing the DOM.
  const render = functionBody(app, "function renderSessions() {");
  assert.match(render, /sessionTicketTask\(session\)/);
  assert.match(render, /has-ticket/);
  const badge = functionBody(app, "function ticketBadge(task) {");
  assert.match(badge, /setAttribute\("data-testid", "session-ticket-badge"\)/);
  assert.match(badge, /textContent = "Ticket"|createTextNode\("Ticket"\)/);

  // Tasks load after the sessions can already be painted, so a late task list
  // must repaint the marks instead of leaving the rows bare.
  const loadTasks = functionBody(app, "async function loadTasks() {");
  assert.match(loadTasks, /renderSessions\(\);/);
});

test("the ticket mark is a quick button into the ticket, not just a label", async () => {
  const app = await readFile("public/app.js", "utf8");

  const button = functionBody(app, "function ticketRowButton(task) {");
  assert.match(button, /data-testid", "session-ticket-button"/);
  assert.match(button, /aria-label", `Open ticket \$\{task\.title\}`/);
  assert.match(button, /openEditTaskDialog\(task\)/);
  // A click on the lane button must not also open the conversation behind it.
  assert.match(button, /event\.stopPropagation\(\)/);

  // The row wires it in, next to the overflow menu.
  const render = functionBody(app, "function renderSessions() {");
  assert.match(render, /row\.append\(ticketRowButton\(ticketTask\)\)/);
});

test("the ticket glyph is the board's own glyph, so both read as the same object", async () => {
  const [board, app] = await Promise.all([
    readFile("public/board.js", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  assert.match(board, /export function ticketGlyph\(className\) \{/);
  assert.match(app, /import \{ renderBoard, ticketGlyph \} from "\.\/board\.js";/);
});

test("the ticket mark and its button lane are styled with design tokens", async () => {
  const styles = await readFile("public/styles.css", "utf8");

  // The badge shares the chat badge anatomy and the accent hue of the board's engine chips.
  assert.match(styles, /\.session-ticket-badge \{[^}]*display: inline-flex/);
  assert.match(styles, /\.session-ticket-badge \{[^}]*color: var\(--accent\)/);
  assert.match(styles, /\.session-ticket-badge \{[^}]*color-mix\(in srgb, var\(--accent\) 12%, transparent\)/);

  // The jump button owns a lane left of the menu button, and the row pays for
  // the lane with padding so the title never runs under it.
  assert.match(styles, /\.session-list \.ticket-link-button \{[^}]*right: 42px/);
  assert.match(styles, /\.session-list \.list-row\.has-ticket \.session-card \{[^}]*padding-right: 78px/);
  // A pinned ticket conversation needs three lanes: menu, ticket, unpin.
  assert.match(styles, /\.session-list \.list-row\.pinned\.has-ticket \.pin-button \{[^}]*right: 74px/);
  assert.match(styles, /\.session-list \.list-row\.pinned\.has-ticket \.session-card \{[^}]*padding-right: 110px/);

  // Phones get the same real touch targets the other lane buttons get.
  const mobile = styles.slice(styles.indexOf("@media (max-width: 1023px)"));
  assert.match(mobile, /\.session-list \.ticket-link-button \{[^}]*min-height: 34px/);
  assert.match(mobile, /\.session-list \.list-row\.pinned\.has-ticket \.session-card \{[^}]*padding-right: 128px/);
});
