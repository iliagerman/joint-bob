import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("opening a conversation pins the transcript to the newest message", async () => {
  const app = await readFile("public/app.js", "utf8");
  const start = app.indexOf("function appendTranscript(messages)");
  assert.ok(start >= 0, "Missing appendTranscript");
  const body = app.slice(start, app.indexOf("\n}", start));

  // Bubbles render their markdown on a later animation frame, so the scroll
  // height during the loop is not final. The transcript must force itself to
  // the bottom once that frame has run.
  assert.match(body, /requestAnimationFrame\(\(\) => stickyScroll\(true\)\)/);
});
