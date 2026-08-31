import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("upward scroll intent stops streaming from pulling the transcript back down", async () => {
  const app = await readFile("public/app.js", "utf8");
  const initialization = app.lastIndexOf("initializeApplication()");
  const wheelListener = app.indexOf('elements.messages.addEventListener("wheel"');
  const touchStartListener = app.indexOf('elements.messages.addEventListener("touchstart"');
  const touchMoveListener = app.indexOf('elements.messages.addEventListener("touchmove"');

  assert.ok(wheelListener >= 0 && wheelListener < initialization);
  assert.ok(touchStartListener >= 0 && touchStartListener < initialization);
  assert.ok(touchMoveListener >= 0 && touchMoveListener < initialization);
  assert.match(app, /event\.deltaY < 0[\s\S]*releaseStickyScroll\(\)/);
  assert.match(app, /event\.touches\[0\]\.clientY > touchScrollY[\s\S]*releaseStickyScroll\(\)/);
  assert.match(app, /state\.stickToBottom = state\.stickToBottom \? isNearBottom\(\) : isAtBottom\(\)/);
});

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
