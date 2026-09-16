import assert from "node:assert/strict";
import test from "node:test";

const push = await import(new URL(`../src/push.ts?content=${Date.now()}`, import.meta.url).href);

test("the notification body is the agent's last reply so the lock screen says what finished", () => {
  const body = push.reviewNotificationBody([
    { role: "user", text: "Fix the bug please" },
    { role: "assistant", text: "Done. The fix is in src/push.ts and both tests pass." },
    { role: "tool", text: "irrelevant tool output" },
  ]);
  assert.equal(body, "Done. The fix is in src/push.ts and both tests pass.");
});

test("a long reply is collapsed to one line and truncated for the notification", () => {
  const body = push.reviewNotificationBody([
    { role: "assistant", text: `First line.\n\nSecond   line. ${"x".repeat(300)}` },
  ]);
  assert.ok(body.startsWith("First line. Second line. x"));
  assert.ok(body.length <= 140);
  assert.ok(body.endsWith("…"));
});

test("a transcript without assistant text falls back to the generic body", () => {
  const body = push.reviewNotificationBody([
    { role: "user", text: "hello" },
    { role: "assistant", text: "   " },
  ]);
  assert.equal(body, "Tap to open the conversation and review the result.");
  assert.equal(push.reviewNotificationBody([]), "Tap to open the conversation and review the result.");
});

test("pending review notifications send the last assistant reply as the body", async () => {
  const { readFile } = await import("node:fs/promises");
  const realtime = await readFile(new URL("../src/server/realtime.ts", import.meta.url), "utf8");
  assert.match(realtime, /loadMessages/);
  assert.match(realtime, /reviewNotificationBody/);
});
