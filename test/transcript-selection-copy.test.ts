import assert from "node:assert/strict";
import test from "node:test";
import { appSource } from "./source.js";

test("finishing a selection inside the transcript copies it to the clipboard", async () => {
  const app = await appSource();
  const start = app.indexOf("function copySelectionFromTranscript()");
  assert.ok(start >= 0, "Missing copySelectionFromTranscript");
  const body = app.slice(start, app.indexOf("\n}", start));

  // The copy must run on the gesture that ends the selection: Safari and
  // Firefox refuse clipboard writes outside a user gesture. The listeners live in
  // a feature module, which the entry point loads before it boots the app.
  for (const gesture of ["mouseup", "touchend", "keyup"]) {
    assert.ok(app.includes(`document.addEventListener("${gesture}", copySelectionFromTranscript`), `Missing ${gesture} listener`);
  }

  // Only selections that live inside the transcript are copied, so selecting
  // in the composer or the sidebar is left alone.
  assert.match(body, /elements\.messages\.contains\(/);
  assert.match(body, /navigator\.clipboard\.writeText\(/);
  assert.match(body, /isCollapsed/);
});
