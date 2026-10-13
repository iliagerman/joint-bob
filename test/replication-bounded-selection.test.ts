import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "../src/data-directory.js";
import { enqueueReplicationEvent, ensureReplicationSchema, eventsForPeer, recordPeerReceipt } from "../src/replication.js";

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
    // Refused events are offered again by the next full search, a few minutes later.
    const later = await eventsForPeer(peer, new Date(Date.now() + 6 * 60_000), event => event.id === ids[0]);
    assert.deepEqual(later.map(event => event.id), [ids[0]], "a later grant must revisit blocked events");
  } finally {
    db.prepare("DELETE FROM replication_deliveries WHERE peer_id=?").run(peer);
    for (const id of ids) db.prepare("DELETE FROM replication_outbox WHERE event_id=?").run(id);
    db.close();
  }
});

test("the search of older events advances a little on each pass and never holds up new ones", async () => {
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  ensureReplicationSchema(db);
  const peer = "paced-peer", ids: string[] = [];
  const add = (key: string): string => enqueueReplicationEvent(db, { originNodeId: "local", entityType: "project.lock", entityKey: key, operation: "upsert", payload: { projectId: key } }).id;
  db.exec("BEGIN");
  for (let i = 0; i < 3000; i++) ids.push(add(`paced-${i}`));
  db.exec("COMMIT");
  const granted = new Set<string>();
  let judged = 0;
  // A sharing check costs a few lookups per event; three thousand of them are a third of a second.
  const check = (event: { id: string }): boolean => { judged++; const until = performance.now() + 0.1; while (performance.now() < until) { /* working */ } return granted.has(event.id); };
  const start = Date.now();
  try {
    assert.deepEqual(await eventsForPeer(peer, new Date(start), check), []);
    assert.ok(judged > 0 && judged < 2000, `one pass judges part of the outbox, not all of it (${judged})`);

    const fresh = add("paced-fresh");
    ids.push(fresh);
    granted.add(fresh);
    assert.deepEqual((await eventsForPeer(peer, new Date(start + 2_000), check)).map((event) => event.id), [fresh], "a new event goes out on the next pass, ahead of the search of older ones");

    await recordPeerReceipt(peer, [fresh]);

    // An older event that becomes allowed is found by a later search, a few minutes on.
    granted.add(ids[5]);
    let found: string[] = [];
    for (let pass = 2; pass < 60 && !found.length; pass++) found = (await eventsForPeer(peer, new Date(start + pass * 30_000), check)).map((event) => event.id);
    assert.deepEqual(found, [ids[5]]);
  } finally {
    db.prepare("DELETE FROM replication_deliveries WHERE peer_id=?").run(peer);
    db.exec("BEGIN");
    for (const id of ids) db.prepare("DELETE FROM replication_outbox WHERE event_id=?").run(id);
    db.exec("COMMIT");
    db.close();
  }
});

