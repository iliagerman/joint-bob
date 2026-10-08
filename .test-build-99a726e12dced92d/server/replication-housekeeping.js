import { clusterV2Database } from "../cluster-v2-store.js";
import { ensureHubSchema } from "./cluster-hubs.js";
const DAY_MS = 24 * 60 * 60 * 1e3;
const EVENT_HISTORY_DAYS = { "model.usage": 30, "user.recent": 7 };
const INBOX_DAYS = 14;
const HUB_QUEUE_DAYS = 1;
const PAGE = 500;
const RELAY_TYPE = "json_extract(event,'$.entityType')";
const RELAY_CREATED = "json_extract(event,'$.createdAt')";
function ensureHousekeepingSchema(db) {
  ensureHubSchema(db);
  db.exec(`CREATE INDEX IF NOT EXISTS replication_outbox_expiry ON replication_outbox(entity_type, created_at);
    CREATE INDEX IF NOT EXISTS cluster_v2_relay_log_expiry ON cluster_v2_relay_log(${RELAY_TYPE}, ${RELAY_CREATED});`);
}
async function pages(db, step) {
  for (; ; ) {
    db.exec("SAVEPOINT replication_housekeeping");
    let more;
    try {
      more = step();
      db.exec("RELEASE replication_housekeeping");
    } catch (error) {
      db.exec("ROLLBACK TO replication_housekeeping; RELEASE replication_housekeeping");
      throw error;
    }
    if (!more) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}
function removeOutboxEvent(db, eventId) {
  db.prepare("DELETE FROM replication_deliveries WHERE event_id=?").run(eventId);
  db.prepare("DELETE FROM replication_outbox WHERE event_id=?").run(eventId);
}
function removeRelayEvent(db, clusterId, eventId) {
  db.prepare("DELETE FROM cluster_v2_hub_queue WHERE cluster_id=? AND event_id=?").run(clusterId, eventId);
  db.prepare("DELETE FROM cluster_v2_relay_log WHERE cluster_id=? AND event_id=?").run(clusterId, eventId);
}
function expireOutboxPage(db, entityType, cutoff, result) {
  const rows = db.prepare(`SELECT event_id FROM replication_outbox WHERE entity_type=? AND created_at<?
    AND rowid<(SELECT max(rowid) FROM replication_outbox) LIMIT ?`).all(entityType, cutoff, PAGE);
  for (const { event_id } of rows) removeOutboxEvent(db, event_id);
  result.expiredOutbox += rows.length;
  return rows.length === PAGE;
}
function expireRelayPage(db, entityType, cutoff, result) {
  const rows = db.prepare(`SELECT cluster_id, event_id FROM cluster_v2_relay_log WHERE ${RELAY_TYPE}=? AND ${RELAY_CREATED}<? LIMIT ?`).all(entityType, cutoff, PAGE);
  for (const row of rows) removeRelayEvent(db, row.cluster_id, row.event_id);
  result.expiredRelay += rows.length;
  return rows.length === PAGE;
}
function dropRepeatedRecents(db, result) {
  const kept = /* @__PURE__ */ new Map();
  const offer = (group, payload, remove) => {
    if (typeof payload?.updatedAt !== "string") return;
    const previous = kept.get(group);
    if (!previous) {
      kept.set(group, { stamp: payload.updatedAt, remove });
      return;
    }
    if (payload.updatedAt > previous.stamp) {
      previous.remove();
      kept.set(group, { stamp: payload.updatedAt, remove });
    } else remove();
    result.repeatedRecents += 1;
  };
  let outboxAfter = ["", 0], relayAfter = ["", 0];
  return {
    outbox: () => {
      const rows = db.prepare(`SELECT rowid, event_id, entity_key, origin_node_id, created_at, payload FROM replication_outbox WHERE entity_type='user.recent'
        AND (created_at, rowid)>(?, ?) AND rowid<(SELECT max(rowid) FROM replication_outbox) ORDER BY created_at, rowid LIMIT ?`).all(...outboxAfter, PAGE);
      for (const row of rows) {
        const payload = JSON.parse(row.payload);
        offer(`outbox
${row.entity_key}
${row.origin_node_id}
${JSON.stringify(payload.recent)}`, payload, () => removeOutboxEvent(db, row.event_id));
      }
      if (rows.length) outboxAfter = [rows[rows.length - 1].created_at, rows[rows.length - 1].rowid];
      return rows.length === PAGE;
    },
    relay: () => {
      const rows = db.prepare(`SELECT seq, cluster_id, event_id, ${RELAY_CREATED} created_at, event FROM cluster_v2_relay_log WHERE ${RELAY_TYPE}='user.recent'
        AND ${RELAY_CREATED}>=? AND (${RELAY_CREATED}>? OR seq>?) ORDER BY ${RELAY_CREATED}, seq LIMIT ?`).all(relayAfter[0], relayAfter[0], relayAfter[1], PAGE);
      for (const row of rows) {
        const event = JSON.parse(row.event);
        offer(`relay
${row.cluster_id}
${event.entityKey}
${event.originNodeId}
${JSON.stringify(event.payload.recent)}`, event.payload, () => removeRelayEvent(db, row.cluster_id, row.event_id));
      }
      if (rows.length) relayAfter = [rows[rows.length - 1].created_at, rows[rows.length - 1].seq];
      return rows.length === PAGE;
    }
  };
}
function expireInboxPage(db, cutoff, result) {
  const rows = db.prepare("SELECT rowid, received_at FROM replication_inbox ORDER BY rowid LIMIT ?").all(PAGE);
  const expired = rows.filter((row) => row.received_at < cutoff);
  const remove = db.prepare("DELETE FROM replication_inbox WHERE rowid=?");
  for (const row of expired) remove.run(row.rowid);
  result.expiredInbox += expired.length;
  return rows.length === PAGE && expired.length === rows.length;
}
function expireHubQueuePage(db, cutoff, result) {
  const removed = Number(db.prepare(`DELETE FROM cluster_v2_hub_queue WHERE rowid IN (SELECT q.rowid FROM cluster_v2_hub_queue q WHERE q.delivered_at<?
    AND NOT EXISTS (SELECT 1 FROM cluster_v2_hub_queue p WHERE p.event_id=q.event_id AND p.cluster_id=q.cluster_id AND p.delivered_at IS NULL) LIMIT ?)`).run(cutoff, PAGE).changes);
  result.deliveredHubQueue += removed;
  return removed === PAGE;
}
async function housekeepReplication(db, now = Date.now()) {
  ensureHousekeepingSchema(db);
  const result = { expiredOutbox: 0, expiredRelay: 0, repeatedRecents: 0, expiredInbox: 0, deliveredHubQueue: 0 };
  const before = (days) => new Date(now - days * DAY_MS).toISOString();
  for (const [entityType, days] of Object.entries(EVENT_HISTORY_DAYS)) {
    await pages(db, () => expireOutboxPage(db, entityType, before(days), result));
    await pages(db, () => expireRelayPage(db, entityType, before(days), result));
  }
  const repeats = dropRepeatedRecents(db, result);
  await pages(db, repeats.outbox);
  await pages(db, repeats.relay);
  await pages(db, () => expireInboxPage(db, before(INBOX_DAYS), result));
  await pages(db, () => expireHubQueuePage(db, before(HUB_QUEUE_DAYS), result));
  return result;
}
let activeRun;
function runReplicationHousekeeping() {
  activeRun ??= (async () => {
    const result = await housekeepReplication(await clusterV2Database());
    if (Object.values(result).some(Boolean)) console.log(`Replication housekeeping removed ${JSON.stringify(result)}`);
    return result;
  })().finally(() => {
    activeRun = void 0;
  });
  return activeRun;
}
export {
  EVENT_HISTORY_DAYS,
  INBOX_DAYS,
  housekeepReplication,
  runReplicationHousekeeping
};
