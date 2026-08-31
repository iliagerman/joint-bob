import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("project rows put every action behind one overflow menu", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /menuButton\.dataset\.testid = "project-menu-button"/);
  assert.match(app, /function projectMenuItems\(project\)/);

  // Every remaining inline button now lives in the menu.
  for (const testid of [
    "project-pin-button",
    "project-rename-button",
    "project-lock-button",
    "project-path-mapping-button",
    "project-secrets-button",
    "project-rescan-button",
    "project-remove-button",
  ]) {
    assert.ok(app.includes(`testid: "${testid}"`), `the row menu is missing ${testid}`);
  }

  // ...and none of them is built as a row button any more.
  assert.doesNotMatch(app, /function projectRescanButton\(/);
  assert.doesNotMatch(app, /row-action-button (lock|rename|mapping|credential|rescan)-button/);

  // The stack of right-offsets those buttons needed goes with them.
  const styles = await readFile("public/styles.css", "utf8");
  assert.doesNotMatch(styles, /\.(lock|rename|mapping|credential|rescan|transfer)-button/);
});

test("both lists show their row menu button at all times", async () => {
  const [app, styles] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  // Conversations and projects build the identical row: card plus one menu button.
  assert.equal(app.match(/row\.append\(button, menuButton\);/g)?.length, 2);

  // Nothing is revealed on hover or on selection any more, so that machinery is gone...
  assert.doesNotMatch(styles, /:is\(:hover, :focus-within\) \.row-action-button/);
  assert.doesNotMatch(styles, /\.list-row:not\(\.active\) \.row-action-button/);
  // ...along with the gradient that used to hide text behind a button appearing on hover.
  assert.doesNotMatch(styles, /\.list-row::after/);

  // Instead both card kinds permanently reserve the button's lane.
  assert.match(styles, /\.project-card, \.session-card \{[\s\S]*?padding: 10px 46px 10px 12px;/);
  // The menu is the only affordance on touch, so it gets a real touch target there.
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*\.row-menu-button[^{]*\{[^}]*min-height: 34px/);
  // A bigger button needs a wider lane, or the title lands right up against it.
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*\.project-card, \.session-card \{ padding-right: 52px; \}/);
});
