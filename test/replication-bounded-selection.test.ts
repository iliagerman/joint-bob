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

test("revoked queued events cannot starve later eligible retries", async t => {
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  ensureReplicationSchema(db);
  const peer = "revoked-backlog", ids: string[] = [];
  const at = new Date("2026-06-01T00:00:00.000Z");
  db.exec("BEGIN");
  for (let i = 0; i < 350; i++) {
    const id = enqueueReplicationEvent(db, { originNodeId: "local", entityType: "project.lock", entityKey: `retry-${i}`, operation: "upsert", payload: { projectId: `p-${i}` } }).id;
    ids.push(id);
    db.prepare("INSERT INTO replication_deliveries VALUES(?,?,1,?,NULL,NULL)").run(id, peer, new Date(at.getTime() - (350 - i) * 1000).toISOString());
  }
  db.exec("COMMIT");
  t.after(() => {
    db.prepare("DELETE FROM replication_deliveries WHERE peer_id=?").run(peer);
    for (const id of ids) db.prepare("DELETE FROM replication_outbox WHERE event_id=?").run(id);
    db.close();
  });
  let found: string[] = [];
  // Advance the clock inside a sharing check to prove each pass respects its time budget.
  t.mock.timers.enable({ apis: ["Date"], now: at.getTime() });
  for (let pass = 0; pass < 60 && !found.length; pass++) {
    let checked = 0;
    found = (await eventsForPeer(peer, at, event => { checked++; t.mock.timers.tick(5); return event.id === ids.at(-1); })).map(event => event.id);
    assert.ok(checked <= 9, `even retry checks must yield within the 40 ms budget, checked ${checked}`);
  }
  assert.deepEqual(found, [ids.at(-1)], "revoked deliveries ahead of a due event must not block it forever");
  await recordPeerReceipt(peer, found);
  // A restored grant is still discovered when the retry cursor wraps.
  let restored: string[] = [];
  for (let pass = 0; pass < 40 && !restored.length; pass++) restored = (await eventsForPeer(peer, at, event => event.id === ids[0])).map(event => event.id);
  assert.deepEqual(restored, [ids[0]]);
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

test("a peer that already has every event costs one bounded look per pass, and a full batch is never exceeded", async () => {
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  ensureReplicationSchema(db);
  const peer = "caught-up-peer", ids: string[] = [];
  db.exec("BEGIN");
  for (let i = 0; i < 2600; i++) ids.push(enqueueReplicationEvent(db, { originNodeId: "local", entityType: "project.lock", entityKey: `full-${i}`, operation: "upsert", payload: { projectId: `full-${i}` } }).id);
  db.exec("COMMIT");
  const mine = new Set(ids);
  const start = Date.now();
  try {
    // Everything is allowed: batches of a hundred, in order, none skipped and none repeated.
    const delivered: string[] = [];
    for (let pass = 0; pass < 40 && delivered.length < ids.length; pass++) {
      const batch = (await eventsForPeer(peer, new Date(start + pass * 2_000), (event) => mine.has(event.id))).map((event) => event.id);
      assert.ok(batch.length <= 100, `a batch holds a hundred events at most (${batch.length})`);
      await recordPeerReceipt(peer, batch);
      delivered.push(...batch);
    }
    assert.deepEqual(delivered, ids);
    // Caught up: the search of older events, minutes later, finds nothing to offer.
    let judged = 0;
    assert.deepEqual(await eventsForPeer(peer, new Date(start + 10 * 60_000), () => { judged++; return true; }), []);
    assert.equal(judged, 0, "events it already has are not read again");
  } finally {
    db.prepare("DELETE FROM replication_deliveries WHERE peer_id=?").run(peer);
    db.exec("BEGIN");
    for (const id of ids) db.prepare("DELETE FROM replication_outbox WHERE event_id=?").run(id);
    db.exec("COMMIT");
    db.close();
  }
});

