import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { sessionToolSelection } from "../src/pi-service.js";

test("the latest tool selection on the active branch is restored", () => {
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendCustomEntry("joint-bob:tools", { enabledTools: ["read", "bash"] });
  sessionManager.appendCustomEntry("joint-bob:tools", { enabledTools: ["read"] });

  assert.deepEqual(sessionToolSelection(sessionManager), ["read"]);
});

test("a session without a saved tool selection keeps its configured defaults", () => {
  assert.equal(sessionToolSelection(SessionManager.inMemory()), undefined);
});

test("malformed persisted tool selections fail instead of changing permissions", () => {
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendCustomEntry("joint-bob:tools", { enabledTools: ["read", 3] });

  assert.throws(() => sessionToolSelection(sessionManager), /Invalid session tool selection/);
});
