import assert from "node:assert/strict";
import test from "node:test";
import { serverSource } from "./source.js";

test("newly opened sessions can react immediately to synced file changes", async () => {
  const server = await serverSource();

  // Only a rewrite by the open itself counts as this node's own write (harness-preflight-lifecycle tests it).
  assert.match(server, /lastLocalEventAt:\s*rewritten \? Date\.now\(\) : 0,/);
  assert.doesNotMatch(server, /lastLocalEventAt:\s*Date\.now\(\),/);
});
