import assert from "node:assert/strict";
import test from "node:test";
import { pushToIdlePeers } from "../src/server/maintenance.js";

// The homeserver pushed its running set every six seconds instead of every two, because
// each push waited for an offline peer's five-second timeout before the next could start.
test("an unresponsive peer holds back only its own lease pushes", async () => {
  const pushes: string[] = [];
  let answerOffline!: () => void;
  const offlineAnswered = new Promise<void>((resolve) => { answerOffline = resolve; });
  const peers = [{ id: "offline" }, { id: "twin" }];
  const push = (peer: { id: string }) => {
    pushes.push(peer.id);
    return peer.id === "offline" ? offlineAnswered : Promise.resolve();
  };
  for (let tick = 0; tick < 3; tick += 1) {
    pushToIdlePeers(peers, push);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(pushes.filter((id) => id === "twin").length, 3, "the twin gets every snapshot");
  assert.deepEqual(pushes.filter((id) => id === "offline").length, 1, "the offline peer never gets overlapping pushes");
  answerOffline();
  await new Promise((resolve) => setImmediate(resolve));
  pushToIdlePeers(peers, push);
  assert.deepEqual(pushes.filter((id) => id === "offline").length, 2, "the peer is pushed again once its previous push settles");
});
