import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensureHubSchema } from "../src/server/cluster-hubs.js";
import { EVENT_HISTORY_DAYS, housekeepReplication, INBOX_DAYS } from "../src/server/replication-housekeeping.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const expired = (entityType: string) => ago((EVENT_HISTORY_DAYS[entityType] + 1) * DAY);

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureHubSchema(db);
  return db;
}

function outbox(db: DatabaseSync, entityType: string, createdAt: string): string {
  const id = randomUUID();
  db.prepare("INSERT INTO replication_outbox VALUES(?,'node-a',?,?,'upsert','{}',?)").run(id, entityType, randomUUID(), createdAt);
  return id;
}

function relay(db: DatabaseSync, entityType: string, createdAt: string): string {
  const id = randomUUID();
  const event = { id, originNodeId: "node-b", entityType, entityKey: randomUUID(), operation: "upsert", payload: {}, createdAt };
  db.prepare("INSERT INTO cluster_v2_relay_log(cluster_id,event_id,event,signature,from_node_id) VALUES('cluster-1',?,?,'sig','node-b')").run(id, JSON.stringify(event));
  return id;
}

function ids(db: DatabaseSync, sql: string): string[] {
  return (db.prepare(sql).all() as unknown as Array<{ id: string }>).map((row) => row.id).sort();
}

test("usage and recent-conversation events expire after their windows; every other type stays however old", async () => {
  const db = database();
  const oldUsage = outbox(db, "model.usage", expired("model.usage"));
  const oldTask = outbox(db, "task", ago(365 * DAY));
  outbox(db, "user.recent", expired("user.recent"));
  const keptUsage = outbox(db, "model.usage", ago((EVENT_HISTORY_DAYS["model.usage"] - 1) * DAY));
  const freshRecent = outbox(db, "user.recent", ago(DAY));
  const delivery = db.prepare("INSERT INTO replication_deliveries VALUES(?,'peer',1,?,?,NULL)");
  delivery.run(oldUsage, ago(0), ago(0));
  delivery.run(freshRecent, ago(0), ago(0));

  const relayOldUsage = relay(db, "model.usage", expired("model.usage"));
  const relayOldTask = relay(db, "task", ago(365 * DAY));
  const relayOldRecent = relay(db, "user.recent", expired("user.recent"));
  const relayFreshRecent = relay(db, "user.recent", ago(DAY));
  const queue = db.prepare("INSERT INTO cluster_v2_hub_queue(event_id,cluster_id,slot,next_attempt_at) VALUES(?,'cluster-1','low',?)");
  queue.run(relayOldRecent, ago(0));
  queue.run(relayFreshRecent, ago(0));

  const result = await housekeepReplication(db, NOW);

  assert.deepEqual(ids(db, "SELECT event_id id FROM replication_outbox"), [oldTask, keptUsage, freshRecent].sort());
  assert.deepEqual(ids(db, "SELECT event_id id FROM replication_deliveries"), [freshRecent], "an expired event takes its delivery rows along");
  assert.deepEqual(ids(db, "SELECT event_id id FROM cluster_v2_relay_log"), [relayOldTask, relayFreshRecent].sort());
  assert.deepEqual(ids(db, "SELECT event_id id FROM cluster_v2_hub_queue"), [relayFreshRecent], "a queue row must not outlive its relay entry");
  assert.deepEqual(result, { expiredOutbox: 2, expiredRelay: 2, repeatedRecents: 0, expiredInbox: 0, deliveredHubQueue: 0 });
});

test("the newest outbox row stays even when expired, so its rowid is never reused", async () => {
  const db = database();
  const only = outbox(db, "model.usage", expired("model.usage"));
  await housekeepReplication(db, NOW);
  assert.deepEqual(ids(db, "SELECT event_id id FROM replication_outbox"), [only]);

  const next = outbox(db, "task", ago(0));
  await housekeepReplication(db, NOW);
  assert.deepEqual(ids(db, "SELECT event_id id FROM replication_outbox"), [next]);
});

function recentPayload(stamp: string, title: string): Record<string, unknown> {
  return { username: "ilia", projectId: "p", engine: "claude", sessionId: "s1", updatedAt: stamp, originNodeId: "node-a",
    recent: { projectId: "p", engine: "claude", sessionId: "s1", sessionPath: "~/s1.jsonl", title, openedAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T10:05:00.000Z" } };
}

function recentOutbox(db: DatabaseSync, payload: Record<string, unknown>, origin = "node-a"): string {
  const id = randomUUID();
  db.prepare("INSERT INTO replication_outbox VALUES(?,?,'user.recent','ilia:p:claude:s1','upsert',?,?)").run(id, origin, JSON.stringify(payload), ago(60_000));
  return id;
}

function recentRelay(db: DatabaseSync, payload: Record<string, unknown>): string {
  const id = randomUUID();
  const event = { id, originNodeId: "node-b", entityType: "user.recent", entityKey: "ilia:p:claude:s1", operation: "upsert", payload, createdAt: ago(60_000) };
  db.prepare("INSERT INTO cluster_v2_relay_log(cluster_id,event_id,event,signature,from_node_id) VALUES('cluster-1',?,?,'sig','node-b')").run(id, JSON.stringify(event));
  return id;
}

test("a recent-conversation event repeated word for word keeps only its highest stamp", async () => {
  const db = database();
  const repeatA = recentOutbox(db, recentPayload("2026-10-01T11:00:00.001Z", "A"));
  const changed = recentOutbox(db, recentPayload("2026-10-01T11:00:00.002Z", "B"));
  recentOutbox(db, recentPayload("2026-10-01T11:00:00.003Z", "A"));
  const otherOrigin = recentOutbox(db, recentPayload("2026-10-01T11:00:00.001Z", "A"), "node-c");
  const keptA = recentOutbox(db, recentPayload("2026-10-01T11:00:00.004Z", "A"));
  const newest = outbox(db, "task", ago(0));
  db.prepare("INSERT INTO replication_deliveries VALUES(?,'peer',1,?,?,NULL)").run(repeatA, ago(0), ago(0));

  // Stamps, not log order, pick the keeper: the copy logged last here is the stale one.
  const relayNewer = recentRelay(db, recentPayload("2026-10-01T11:00:00.009Z", "A"));
  const relayStale = recentRelay(db, recentPayload("2026-10-01T11:00:00.005Z", "A"));
  db.prepare("INSERT INTO cluster_v2_hub_queue(event_id,cluster_id,slot,next_attempt_at) VALUES(?,'cluster-1','low',?)").run(relayStale, ago(0));

  const result = await housekeepReplication(db, NOW);

  assert.deepEqual(ids(db, "SELECT event_id id FROM replication_outbox"), [changed, otherOrigin, keptA, newest].sort());
  assert.deepEqual(ids(db, "SELECT event_id id FROM replication_deliveries"), []);
  assert.deepEqual(ids(db, "SELECT event_id id FROM cluster_v2_relay_log"), [relayNewer]);
  assert.deepEqual(ids(db, "SELECT event_id id FROM cluster_v2_hub_queue"), []);
  assert.equal(result.repeatedRecents, 3);
});

test("inbox receipts expire after the inbox window", async () => {
  const db = database();
  const old = randomUUID(), fresh = randomUUID();
  db.prepare("INSERT INTO replication_inbox VALUES(?,'node-b',?)").run(old, ago((INBOX_DAYS + 1) * DAY));
  db.prepare("INSERT INTO replication_inbox VALUES(?,'node-b',?)").run(fresh, ago(DAY));

  const result = await housekeepReplication(db, NOW);

  assert.deepEqual(ids(db, "SELECT event_id id FROM replication_inbox"), [fresh]);
  assert.equal(result.expiredInbox, 1);
});

test("delivered hub queue rows expire, but not while a sibling slot is pending", async () => {
  const db = database();
  const queue = db.prepare("INSERT INTO cluster_v2_hub_queue(event_id,cluster_id,slot,node_id,next_attempt_at,delivered_at) VALUES(?,'cluster-1',?,?,?,?)");
  const done = relay(db, "task", ago(0)), waiting = relay(db, "task", ago(0)), fresh = relay(db, "task", ago(0));
  queue.run(done, "low", "hub-1", ago(2 * DAY), ago(2 * DAY));
  queue.run(done, "high", "hub-2", ago(2 * DAY), ago(2 * DAY));
  queue.run(waiting, "low", "hub-1", ago(2 * DAY), ago(2 * DAY));
  queue.run(waiting, "high", null, ago(0), null);
  queue.run(fresh, "low", "hub-1", ago(60_000), ago(60_000));

  const result = await housekeepReplication(db, NOW);

  const left = (db.prepare("SELECT event_id, slot FROM cluster_v2_hub_queue").all() as unknown as Array<{ event_id: string; slot: string }>)
    .map((row) => `${row.event_id === waiting ? "waiting" : row.event_id === fresh ? "fresh" : "done"}:${row.slot}`).sort();
  assert.deepEqual(left, ["fresh:low", "waiting:high", "waiting:low"]);
  assert.equal(result.deliveredHubQueue, 2);
});

test("relay expiry and the repeat walk use the expiry index, not a scan of the log", async () => {
  const db = database();
  await housekeepReplication(db, NOW);
  const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT cluster_id, event_id FROM cluster_v2_relay_log WHERE json_extract(event,'$.entityType')=? AND json_extract(event,'$.createdAt')<? LIMIT 500`)
    .all("model.usage", ago(0)) as unknown as Array<{ detail: string }>).map((row) => row.detail).join("\n");
  assert.match(plan, /cluster_v2_relay_log_expiry/);
  const walk = (db.prepare(`EXPLAIN QUERY PLAN SELECT seq FROM cluster_v2_relay_log WHERE json_extract(event,'$.entityType')='user.recent' AND json_extract(event,'$.createdAt')>=? AND (json_extract(event,'$.createdAt')>? OR seq>?) ORDER BY json_extract(event,'$.createdAt'), seq LIMIT 500`)
    .all("", "", 0) as unknown as Array<{ detail: string }>).map((row) => row.detail).join("\n");
  assert.match(walk, /cluster_v2_relay_log_expiry \(<expr>=\? AND <expr>>\?\)/, "the repeat walk must resume by range, not rescan from the start");
});
