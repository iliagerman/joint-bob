import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("finishing a selection inside the transcript copies it to the clipboard", async () => {
  const app = await readFile("public/app.js", "utf8");
  const start = app.indexOf("function copySelectionFromTranscript()");
  assert.ok(start >= 0, "Missing copySelectionFromTranscript");
  const body = app.slice(start, app.indexOf("\n}", start));

  // The copy must run on the gesture that ends the selection: Safari and
  // Firefox refuse clipboard writes outside a user gesture.
  const initialization = app.lastIndexOf("initializeApplication()");
  for (const gesture of ["mouseup", "touchend", "keyup"]) {
    const listener = app.indexOf(`document.addEventListener("${gesture}", copySelectionFromTranscript`);
    assert.ok(listener >= 0 && listener < initialization, `Missing ${gesture} listener`);
  }

  // Only selections that live inside the transcript are copied, so selecting
  // in the composer or the sidebar is left alone.
  assert.match(body, /elements\.messages\.contains\(/);
  assert.match(body, /navigator\.clipboard\.writeText\(/);
  assert.match(body, /isCollapsed/);
});
