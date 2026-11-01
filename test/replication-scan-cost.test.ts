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

// A visitor's home node takes only that visitor's own events. Judged one by one, every other
// event of the outbox came back a hundred at a time and was refused, on every flush.
test("a peer limited to some accounts is searched only for their events", async () => {
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  ensureReplicationSchema(db);
  const peer = "scan-accounts-peer", visitor = "0123456789abcdef0123456789abcdef";
  const at = new Date("2026-05-01T00:00:00.000Z");
  db.exec("BEGIN");
  for (let i = 0; i < 20_000; i++) enqueueReplicationEvent(db, { originNodeId: "local", entityType: "user.recent", entityKey: `scan-accounts-${i}`, operation: "upsert", payload: { username: "fedcba9876543210fedcba9876543210", projectId: "scan" } });
  const own = enqueueReplicationEvent(db, { originNodeId: "local", entityType: "user.recent", entityKey: "scan-accounts-own", operation: "upsert", payload: { username: visitor, projectId: "scan" } });
  db.exec("COMMIT");
  try {
    let judged = 0;
    const accept = (event: { payload: unknown }) => { judged++; return (event.payload as { username?: string }).username === visitor; };
    assert.deepEqual((await eventsForPeer(peer, at, accept, [visitor])).map((event) => event.id), [own.id], "the visitor's own event is found");
    assert.equal(judged, 1, "other accounts' events are never handed to the sharing check");
    assert.deepEqual(await eventsForPeer(`${peer}-none`, at, accept, []), [], "a peer with no accounts gets nothing");
    assert.equal(judged, 1);
  } finally {
    db.prepare("DELETE FROM replication_deliveries WHERE peer_id IN (?, ?)").run(peer, `${peer}-none`);
    db.prepare("DELETE FROM replication_outbox WHERE entity_key LIKE 'scan-accounts-%'").run();
    db.close();
  }
});

// A visitor with no events of their own had the whole outbox read for them every five minutes:
// the payload of every event parsed to find their account (2026-11-01, about a second each on
// the Mac with 334k events). The account index makes that pass cost only the visitor's events.
test("a visitor's search reads the account index, whatever the outbox holds", async () => {
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  ensureReplicationSchema(db);
  const peer = "scan-index-peer", visitor = "abcdefabcdefabcdefabcdefabcdefab";
  const at = new Date("2026-05-01T00:00:00.000Z");
  db.exec("BEGIN");
  for (let i = 0; i < 50_000; i++) enqueueReplicationEvent(db, { originNodeId: "local", entityType: "model.usage", entityKey: `scan-index-${i}`, operation: "upsert", payload: { username: "fedcba9876543210fedcba9876543210", projectId: "scan", tokens: i } });
  db.exec("COMMIT");
  try {
    let judged = 0;
    const accept = () => { judged++; return true; };
    const started = performance.now();
    assert.deepEqual(await eventsForPeer(peer, at, accept, [visitor]), [], "nothing of the visitor's");
    const elapsed = performance.now() - started;
    assert.equal(judged, 0);
    assert.ok(elapsed < 200, `one pass covers the whole history without reading it (${elapsed.toFixed(0)} ms, index built included)`);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT o.rowid FROM replication_outbox o INDEXED BY ${"replication_outbox_account"}
      WHERE json_extract(o.payload,'$.username') IN (SELECT value FROM json_each(?)) AND o.rowid>? AND o.rowid<=? ORDER BY o.rowid LIMIT 100`)
      .all(JSON.stringify([visitor]), 0, 1e12) as Array<{ detail: string }>;
    assert.ok(plan.some((row) => /USING (COVERING )?INDEX replication_outbox_account/.test(row.detail)), JSON.stringify(plan));
    const own = enqueueReplicationEvent(db, { originNodeId: "local", entityType: "user.recent", entityKey: "scan-index-own", operation: "upsert", payload: { username: visitor, projectId: "scan" } });
    assert.deepEqual((await eventsForPeer(peer, new Date(at.getTime() + 1000), accept, [visitor])).map((event) => event.id), [own.id], "a new event of theirs is found");
    assert.equal(judged, 1);
  } finally {
    db.prepare("DELETE FROM replication_deliveries WHERE peer_id=?").run(peer);
    db.prepare("DELETE FROM replication_outbox WHERE entity_key LIKE 'scan-index-%'").run();
    db.close();
  }
});
