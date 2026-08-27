import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("conversation rows put every action behind one overflow menu", async () => {
  const [html, app, styles] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  // One shared menu in the top layer: the conversation list scrolls, so an in-row
  // popup would be clipped by its overflow.
  assert.match(html, /id="rowMenu"[^>]*popover="auto"[^>]*data-testid="session-row-menu"/);
  assert.match(styles, /\.row-menu \{[\s\S]*?position: fixed;[\s\S]*?\}/);
  assert.match(styles, /\.row-menu \{[\s\S]*?inset: auto;[\s\S]*?\}/);

  // The row carries exactly one action button.
  assert.match(app, /menuButton\.dataset\.testid = "session-menu-button"/);
  assert.match(app, /row\.append\(button, menuButton\);/);
  assert.match(app, /function openRowMenu\(anchor, items\)/);

  // Pin, rename, transfer and remove all live inside the menu now.
  assert.match(app, /function sessionMenuItems\(session, sessionActive\)/);
  for (const testid of [
    "session-pin-button",
    "session-rename-button",
    "session-transfer-button",
    "session-remove-button",
  ]) {
    assert.ok(app.includes(`testid: "${testid}"`), `the row menu is missing ${testid}`);
  }

  // The menu button never hides and the title stops before it — both rules are shared
  // with the project list, so they are asserted in project-row-menu.test.ts.
});

test("any conversation can be renamed, not only the open one", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /async function renameSession\(sessionPath, title\)/);
  assert.match(app, /state\.renameSessionPath/);
  // The live-rename mirror only makes sense for the conversation the socket is on.
  assert.match(app, /sessionPath === state\.activeSessionPath/);
});
