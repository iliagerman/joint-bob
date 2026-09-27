// Every two seconds a node asks which of its events a twin still needs. Before this, each
// poll walked the whole outbox from the first event, so a node with a long history spent
// most of its CPU re-reading events it had delivered long ago, and every page waited.
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveDataDirectory } from "../src/data-directory.js";
import { enqueueReplicationEvent, ensureReplicationSchema, eventsForPeer, pendingEventsForPeer } from "../src/replication.js";

test("polling a twin reads only new and due events, not the delivered history", async () => {
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  ensureReplicationSchema(db);
  const peer = "scan-cost-peer", ids: string[] = [];
  const start = new Date("2026-05-01T00:00:00.000Z");
  const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
  db.exec("BEGIN");
  for (let i = 0; i < 20_000; i++) {
    const id = enqueueReplicationEvent(db, { originNodeId: "local", entityType: "project.lock", entityKey: `scan-${i}`, operation: "upsert", payload: { projectId: "scan" } }).id;
    ids.push(id);
    db.prepare("INSERT INTO replication_deliveries VALUES(?,?,1,?,?,NULL)").run(id, peer, start.toISOString(), start.toISOString());
  }
  db.exec("COMMIT");
  try {
    assert.deepEqual(await eventsForPeer(peer, at(1), () => true), [], "the delivered history needs nothing");
    const started = performance.now();
    for (let second = 2; second < 22; second++) assert.deepEqual(await eventsForPeer(peer, at(second), () => true), []);
    const perPoll = (performance.now() - started) / 20;
    assert.ok(perPoll < 5, `a poll must not re-read the delivered history (${perPoll.toFixed(1)} ms per poll)`);
    assert.equal((await pendingEventsForPeer(peer, () => true)).pending, 0);

    const fresh = enqueueReplicationEvent(db, { originNodeId: "local", entityType: "project.lock", entityKey: "scan-new", operation: "upsert", payload: { projectId: "scan" } });
    assert.deepEqual((await eventsForPeer(peer, at(23), () => true)).map((event) => event.id), [fresh.id], "a new event is picked up");
    db.prepare("UPDATE replication_deliveries SET delivered_at=NULL, next_attempt_at=? WHERE event_id=? AND peer_id=?").run(at(10).toISOString(), ids[7], peer);
    assert.deepEqual((await eventsForPeer(peer, at(24), () => true)).map((event) => event.id).sort(), [fresh.id, ids[7]].sort(), "due retries from the history are picked up, with the unacknowledged new event");
    assert.equal((await pendingEventsForPeer(peer, () => true)).pending, 2);
  } finally {
    db.prepare("DELETE FROM replication_deliveries WHERE peer_id=?").run(peer);
    db.prepare("DELETE FROM replication_outbox WHERE entity_key LIKE 'scan-%'").run();
    db.close();
  }
});
