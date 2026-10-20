import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pruneReceivedCommands, readReceivedCommands, replaceReceivedCommands, retainCommandGrants, type CommandOffer, type CommandPeer } from "../src/received-commands.js";

function fixture() {
  const cluster = randomUUID(), twinRelationshipId = randomUUID(), nodeId = randomUUID();
  const peer: CommandPeer = { nodeId, twinRelationshipId, incarnations: [`${cluster}:1:2`] };
  const command: CommandOffer = { id: `${nodeId}/owner/${randomUUID()}`, ownerNodeId: nodeId, name: "Shared", prompt: "Saved prompt", global: false, grantClusterIds: [cluster], twinRelationshipId, projectIds: ["project"], conversations: [] };
  return { peer, command, cluster };
}

test("stored command grants cannot survive a re-pair or either machine rejoining a cluster", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const { peer, command, cluster } = fixture();
    replaceReceivedCommands(db, peer, [command]);
    assert.deepEqual(readReceivedCommands(db, peer), [command]);
    for (const incarnations of [[`${cluster}:3:2`], [`${cluster}:1:4`], []]) {
      assert.deepEqual(readReceivedCommands(db, { ...peer, incarnations, twinRelationshipId: randomUUID() }), []);
    }
    const clusterOnly = readReceivedCommands(db, { ...peer, twinRelationshipId: undefined });
    assert.equal(clusterOnly.length, 1);
    assert.equal(clusterOnly[0].twinRelationshipId, undefined);
    assert.equal(clusterOnly[0].global, false, "losing twin trust must not broaden a scoped cluster command");
    assert.deepEqual(clusterOnly[0].projectIds, ["project"]);
    const twinOnly = readReceivedCommands(db, { ...peer, incarnations: [] });
    assert.deepEqual(twinOnly[0].grantClusterIds, []);
    assert.equal(twinOnly[0].twinRelationshipId, peer.twinRelationshipId);
  } finally { db.close(); }
});

test("in-flight replies retain only grants valid before and after the fetch", () => {
  const { peer, command, cluster } = fixture();
  const current = { ...peer, twinRelationshipId: randomUUID(), incarnations: [`${cluster}:1:3`] };
  assert.deepEqual(retainCommandGrants([command], peer, current), []);
  assert.deepEqual(retainCommandGrants([{ ...command, twinRelationshipId: current.twinRelationshipId }], peer, current), [], "a new relationship cannot authorize a reply requested under old trust");
});

test("complete snapshots replace edits and deletions; removing a peer deletes its stored prompts", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const { peer, command } = fixture(), other = fixture();
    replaceReceivedCommands(db, peer, [command]);
    replaceReceivedCommands(db, other.peer, [other.command]);
    replaceReceivedCommands(db, peer, [{ ...command, prompt: "Edited" }]);
    assert.equal(readReceivedCommands(db, peer)[0].prompt, "Edited");
    replaceReceivedCommands(db, peer, []);
    assert.deepEqual(readReceivedCommands(db, peer), []);
    replaceReceivedCommands(db, peer, [command]);
    pruneReceivedCommands(db, [other.peer]);
    assert.deepEqual(readReceivedCommands(db, peer), []);
    assert.deepEqual(readReceivedCommands(db, other.peer), [other.command]);
    assert.equal(db.prepare("SELECT count(*) AS count FROM received_command_snapshots").get()!.count, 1);
  } finally { db.close(); }
});
