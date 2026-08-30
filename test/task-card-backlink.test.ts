import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("a chat opened from a board card links back to that card", async () => {
  const [html, app, board, styles] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/board.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  // The card is addressable from the DOM.
  assert.match(board, /card\.dataset\.taskId = task\.id;/);
  assert.match(board, /task\.executionState === "running" \? "Running"/);
  assert.match(board, /if \(task\.sessionPath\)/);
  assert.match(app, /Creating ticket…/);
  assert.match(app, /taskForm\.setAttribute\("aria-busy", "true"\)/);

  // The chat header owns a hidden back-link control.
  assert.match(html, /id="taskBacklinkButton"[^>]*hidden/);
  assert.match(html, /data-testid="chat-task-backlink-button"/);
  assert.match(html, /class="chat-title-meta"/);

  // The control is wired to state and to the board.
  assert.match(app, /taskBacklinkButton: document\.querySelector\("#taskBacklinkButton"\)/);
  assert.match(app, /function renderTaskBacklink\(\)/);
  assert.match(app, /function focusTaskCard\(taskId\)/);
  assert.match(app, /renderTaskBacklink\(\);\n\}/);
  assert.match(app, /elements\.taskBacklinkButton\.addEventListener\("click"/);
  assert.match(app, /setMobileView\("board"\);/);
  assert.match(app, /\[data-task-id="\$\{CSS\.escape\(taskId\)\}"\]/);

  // The control is labelled for assistive technology.
  assert.match(app, /setAttribute\("aria-label", `Back to ticket \$\{task\.title\}`\)/);

  // The flash uses design tokens, not raw colors.
  assert.match(styles, /@keyframes task-card-focus/);
  assert.match(styles, /\.task-card-focus[^{]*\{[^}]*var\(--accent\)/);
  assert.match(styles, /\.chat-title-meta[^{]*\{[^}]*display: flex/);
});
