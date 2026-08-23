import assert from "node:assert/strict";
import test from "node:test";
import { webSocketCloseReason } from "../src/websocket.js";

test("WebSocket close reasons stay within the protocol byte limit", () => {
  assert.equal(webSocketCloseReason("short error"), "short error");
  const truncated = webSocketCloseReason("Failure 🔥 ".repeat(40));
  assert.ok(Buffer.byteLength(truncated) <= 123);
  assert.doesNotMatch(truncated, /�/);
});
