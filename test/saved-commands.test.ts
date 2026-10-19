import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { addSharingMember, createSharingCluster, ensureClusterSharingPolicySchema, removeSharingMember } from "../src/cluster-sharing-policy.js";
import { commandPeerGrant, emptyCommandSelection, identifyCommandPresets, recentCommandIds, recordCommandUse, setCommandPolicy } from "../src/saved-commands.js";

test("legacy IDs survive old-client edits and duplicate IDs are rejected", () => {
  const first = identifyCommandPresets([{ name: "One", prompt: "Original" }, { name: "Two", prompt: "Other" }]);
  assert.deepEqual(identifyCommandPresets(first), first);
  assert.equal(identifyCommandPresets([{ name: "One", prompt: "Edited" }], first)[0].id, first[0].id);
  assert.equal(identifyCommandPresets([{ name: "Renamed", prompt: "Original" }], first)[0].id, first[0].id);
  assert.throws(() => identifyCommandPresets([first[0], first[0]]), /Duplicate command IDs/);
});
test("command recency is isolated by account and project, reordered on repeat, bounded to five", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (let i = 0; i < 7; i++) recordCommandUse(db, "alice", "one", String(i));
    recordCommandUse(db, "alice", "one", "3");
    assert.deepEqual(recentCommandIds(db, "alice", "one"), ["3", "6", "5", "4", "2"]);
    assert.deepEqual(recentCommandIds(db, "bob", "one"), []);
    assert.deepEqual(recentCommandIds(db, "alice", "two"), []);
  } finally { db.close(); }
});
test("command node grants never revive after receiver or owner readmission", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensureClusterSharingPolicySchema(db);
    const manager = randomUUID(), owner = randomUUID(), receiver = randomUUID(), other = randomUUID(), cluster = randomUUID();
    createSharingCluster(db, { id: cluster, name: "Commands" }, manager);
    for (const node of [owner, receiver, other]) addSharingMember(db, cluster, manager, node, 1);
    const set = () => setCommandPolicy(db, owner, "account", "preset", false, { ...emptyCommandSelection(), nodeIds: [receiver] });
    let policy = set();
    assert.equal(commandPeerGrant(db, owner, receiver, policy).global, true);
    assert.equal(commandPeerGrant(db, owner, other, policy).global, false);
    removeSharingMember(db, cluster, manager, receiver);
    addSharingMember(db, cluster, manager, receiver, 1);
    assert.equal(commandPeerGrant(db, owner, receiver, policy).global, false, "readmitted receiver is a new incarnation");
    policy = set();
    removeSharingMember(db, cluster, manager, owner);
    addSharingMember(db, cluster, manager, owner, 1);
    assert.equal(commandPeerGrant(db, owner, receiver, policy).common, false, "readmitted owner must explicitly regrant");
  } finally { db.close(); }
});
