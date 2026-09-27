import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource } from "./source.js";

test("every running conversations trigger carries a running count badge", async () => {
  const html = await readFile("public/index.html", "utf8");
  for (const testId of ["running-conversations-open-button", "chats-running-conversations-open-button", "chat-running-conversations-open-button"]) {
    const start = html.indexOf(`data-testid="${testId}"`);
    assert.ok(start >= 0, `Missing ${testId}`);
    const button = html.slice(start, html.indexOf("</button>", start));
    assert.match(button, /data-running-count[^>]*hidden>0</, `${testId} has no running count badge`);
  }
  const focusStart = html.indexOf('id="focusRunning"');
  const focusButton = html.slice(focusStart, html.indexOf("</button>", focusStart));
  assert.match(focusButton, /data-running-count[^>]*hidden>0</);
});

test("the running count refreshes with the review inbox triggers", async () => {
  const app = await appSource();
  assert.match(app, /export function scheduleRunningRefresh\(\)/);
  assert.match(app, /document\.querySelectorAll\("\[data-running-count\]"\)/);
  const socket = await readFile("public/app/socket.js", "utf8");
  assert.equal(socket.match(/scheduleRunningRefresh\(\);/g)?.length, socket.match(/schedulePendingReviewsRefresh\(\);/g)?.length);
});
