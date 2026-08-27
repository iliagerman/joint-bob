import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Enter sends on a hardware keyboard and stays a newline on touch", async () => {
  const app = await readFile("public/app.js", "utf8");

  // Pointer capability, not viewport width: a narrow desktop window still has a keyboard.
  assert.match(app, /function enterKeySends\(\) \{[\s\S]*?matchMedia\("\(hover: hover\) and \(pointer: fine\)"\)\.matches/);

  const start = app.indexOf('elements.messageInput.addEventListener("keydown"');
  assert.ok(start > -1, "the composer has no keydown handler");
  const handler = app.slice(start, app.indexOf("});", start));

  // Shift+Enter is always a newline; a bare Enter only sends where enterKeySends() is true.
  assert.match(handler, /event\.shiftKey \|\| !enterKeySends\(\)/);
  // Enter that is confirming an IME candidate must not send.
  assert.match(handler, /event\.isComposing/);
  assert.match(handler, /elements\.composer\.requestSubmit\(\)/);
  // The old rule (Shift+Enter sends) is gone.
  assert.doesNotMatch(handler, /!event\.shiftKey/);
});
