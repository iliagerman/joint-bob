import assert from "node:assert/strict";
import test from "node:test";
import { canonicalCanvasKeyToken, CANVAS_KEY_TOKENS } from "../src/canvas-keys.ts";
import { canonicalCanvasKey } from "../public/canvas-layout.js";

// The browser and the node each hold their own copy of the vocabulary: one is an ES
// module the page loads, the other is TypeScript the server compiles. A key the page
// offers but the node rejects would fail only when the user saved it, so the two
// copies are compared here instead.
test("the page and the node agree on which keys a shortcut may use", () => {
  for (const token of CANVAS_KEY_TOKENS) {
    assert.equal(canonicalCanvasKey(token), token, `${token} is bindable in the page`);
  }
  for (const rejected of [" ", "SPACE", "/", "\\", "ESC", "F1", "", "AB"]) {
    assert.equal(canonicalCanvasKeyToken(rejected), null, `${rejected} is refused by the node`);
    assert.equal(canonicalCanvasKey(rejected), null, `${rejected} is refused by the page`);
  }
  assert.equal(canonicalCanvasKeyToken("["), "[");
  assert.equal(canonicalCanvasKeyToken("enter"), "ENTER");
  assert.equal(canonicalCanvasKeyToken("b"), "B");
});
