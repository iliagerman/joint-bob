import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource } from "./source.js";

const text = (path: string) => readFile(path, "utf8");

test("one shared module owns the digit shortcut rule", async () => {
  const [module, worker] = await Promise.all([
    text("public/app/list-shortcuts.js"),
    text("public/sw.js"),
  ]);

  assert.match(module, /export const LIST_SHORTCUT_LIMIT = 10;/);
  // 0 selects the tenth row, so the keypad reaches rows 1-10 without two-key chords.
  assert.match(module, /event\.key === "0" \? LIST_SHORTCUT_LIMIT : Number\(event\.key\)/);
  // Digits a user is typing into a text field must type, not select a row;
  // checkboxes and radios take no text, so a digit still selects there.
  assert.match(module, /checkbox.*radio|radio.*checkbox/s);
  assert.match(module, /export function attachDigitShortcuts\(dialog, rows, activate\)/);

  // The service worker must cache the module or offline dialogs lose the shortcuts.
  assert.match(worker, /"\/app\/list-shortcuts\.js"/);
});

test("every pick-list dialog opens a row with its digit", async () => {
  const [recents, reviews, running, composer, spotlight] = await Promise.all([
    text("public/app/recents.js"),
    text("public/app/reviews.js"),
    text("public/app/running.js"),
    text("public/app/composer-dialogs.js"),
    text("public/app/spotlight.js"),
  ]);

  for (const [source, dialog] of [
    [recents, "recentSessionsDialog"],
    [reviews, "pendingReviewsDialog"],
    [running, "runningConversationsDialog"],
    [composer, "skillsDialog"],
    [composer, "toolsDialog"],
    [composer, "modelDialog"],
    [spotlight, "spotlightDialog"],
  ] as const) {
    assert.match(
      source,
      new RegExp(`attachDigitShortcuts\\(elements\\.${dialog}, `),
      `${dialog} does not wire digit shortcuts`,
    );
  }

  // Each dialog hands over the shortcuts its latest render installed, so a
  // filtered list renumbers and a stale row cannot answer a digit.
  for (const source of [recents, reviews, running, composer, spotlight]) {
    assert.match(source, /attachDigitShortcuts\(elements\.\w+, \(\) => /);
  }
});

test("the first ten rows of each list are numbered", async () => {
  const [recents, reviews, running, composer, spotlight] = await Promise.all([
    text("public/app/recents.js"),
    text("public/app/reviews.js"),
    text("public/app/running.js"),
    text("public/app/composer-dialogs.js"),
    text("public/app/spotlight.js"),
  ]);

  for (const [source, testid] of [
    [recents, "recent-session-index"],
    [reviews, "pending-review-index"],
    [running, "running-conversation-index"],
    [composer, "skill-option-index"],
    [composer, "tool-option-index"],
    [composer, "model-option-index"],
    [spotlight, "spotlight-option-index"],
  ] as const) {
    assert.match(
      source,
      new RegExp(`shortcutIndexBadge\\("${testid}"`),
      `${testid} badge is not drawn on its rows`,
    );
  }
});

test("the digit chip is styled once for every list", async () => {
  const styles = await text("public/styles.css");

  assert.match(styles, /\.list-shortcut-index \{/);
  // Session-card lists keep the 38px lane the recents list established.
  for (const container of ["recent-sessions-list", "pending-reviews-list", "running-conversations-list"]) {
    assert.match(styles, new RegExp(`\\.${container} \\.session-card \\{[^}]*padding-left: 38px;`), `${container} rows have no shortcut lane`);
  }
  for (const row of ["skill-option", "tool-option", "model-option", "spotlight-option"]) {
    assert.match(styles, new RegExp(`\\.${row} \\{[^}]*padding-left: 36px;`), `.${row} rows have no shortcut lane`);
  }
});
