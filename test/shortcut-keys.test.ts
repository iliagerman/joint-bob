import assert from "node:assert/strict";
import test from "node:test";
import { canonicalShortcutKeyToken, SHORTCUT_KEY_TOKENS } from "../src/shortcut-keys.ts";
import { canonicalShortcutKey } from "../public/keymap.js";

// The browser and the node each hold their own copy of the vocabulary: one is an ES
// module the page loads, the other is TypeScript the server compiles. A key the page
// offers but the node rejects would fail only when the user saved it, so the two
// copies are compared here instead.
test("the page and the node agree on which keys a shortcut may use", () => {
  for (const token of SHORTCUT_KEY_TOKENS) {
    assert.equal(canonicalShortcutKey(token), token, `${token} is bindable in the page`);
  }
  for (const rejected of [" ", "SPACE", "/", "\\", "ESC", "F1", "", "AB"]) {
    assert.equal(canonicalShortcutKeyToken(rejected), null, `${rejected} is refused by the node`);
    assert.equal(canonicalShortcutKey(rejected), null, `${rejected} is refused by the page`);
  }
  assert.equal(canonicalShortcutKeyToken("["), "[");
  assert.equal(canonicalShortcutKeyToken("enter"), "ENTER");
  assert.equal(canonicalShortcutKeyToken("b"), "B");
});
