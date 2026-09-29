import assert from "node:assert/strict";
import test from "node:test";
import { serverSource } from "./source.js";

test("newly opened sessions can react immediately to synced file changes", async () => {
  const server = await serverSource();

  assert.match(server, /lastLocalEventAt:\s*0,/);
  assert.doesNotMatch(server, /lastLocalEventAt:\s*Date\.now\(\),/);
});
