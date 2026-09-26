import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "../src/data-directory.js";
import { enqueueReplicationEvent, ensureReplicationSchema, eventsForPeer } from "../src/replication.js";

test("selective outbox allocates only eligible deliveries and revisits future grants", async () => {
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  ensureReplicationSchema(db);
  const peer = "bounded-peer";
  const ids: string[] = [];
  for (let i = 0; i < 350; i++) ids.push(enqueueReplicationEvent(db, {
    originNodeId: "local", entityType: "project.lock", entityKey: String(i), operation: "upsert", payload: { projectId: String(i) },
  }).id);
  try {
    const result = await eventsForPeer(peer, new Date(), event => event.id === ids[349]);
    assert.deepEqual(result.map(event => event.id), [ids[349]], "blocked backlog must not starve eligible events");
    assert.equal((db.prepare("SELECT count(*) n FROM replication_deliveries WHERE peer_id=?").get(peer) as {n:number}).n, 1,
      "unselected events must not allocate peer delivery rows");
    const later = await eventsForPeer(peer, new Date(), event => event.id === ids[0]);
    assert.deepEqual(later.map(event => event.id), [ids[0]], "a later grant must revisit blocked events");
  } finally {
    db.prepare("DELETE FROM replication_deliveries WHERE peer_id=?").run(peer);
    for (const id of ids) db.prepare("DELETE FROM replication_outbox WHERE event_id=?").run(id);
    db.close();
  }
});
