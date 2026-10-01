// Keeps replication bookkeeping bounded. Nothing else deletes from these tables, and on a
// busy node they grew to most of node.db (2026-10: 1 GB, ~90 MB a day): usage events and
// the same few recent-conversation rows re-sent thousands of times a day.
//
// - Usage and recent-conversation events expire from the outbox (with their delivery rows)
//   and the relay log (with their hub queue rows) after their window. A node or project
//   share added later gets that much of their history; model_usage_events keeps every usage
//   event. Every other type stays: late joiners rebuild state from it, and keeping only an
//   entity's newest event is not safe in general (some appliers merge or keep maximums, and
//   a re-delivered event is re-logged at a higher seq than the one that superseded it).
// - A recent-conversation event that a later one from the same origin repeats word for word
//   (same row, higher stamp) adds nothing anywhere, in any order of arrival. Browsers sent such
//   repeats every few seconds until recent-sessions.ts stopped publishing unchanged rows, and
//   peers on older releases still may.
// - The inbox only stops a duplicate delivery from applying twice; duplicates arrive within
//   minutes, not weeks.
// - A hub queue row stays until every slot of its event is delivered.
import type { DatabaseSync } from "node:sqlite";
import { clusterV2Database } from "../cluster-v2-store.js";
import { ensureHubSchema } from "./cluster-hubs.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const EVENT_HISTORY_DAYS: Readonly<Record<string, number>> = { "model.usage": 30, "user.recent": 7 };
export const INBOX_DAYS = 14;
const HUB_QUEUE_DAYS = 1;
/** Rows handled per transaction. node:sqlite is synchronous, so a page holds the event loop. */
const PAGE = 500;
/** Expressions the relay log's expiry index is built on; queries must repeat them exactly. */
const RELAY_TYPE = "json_extract(event,'$.entityType')";
const RELAY_CREATED = "json_extract(event,'$.createdAt')";

export interface HousekeepingResult { expiredOutbox: number; expiredRelay: number; repeatedRecents: number; expiredInbox: number; deliveredHubQueue: number }
interface RecentEventPayload { recent: unknown; updatedAt: string }

function ensureHousekeepingSchema(db: DatabaseSync): void {
  ensureHubSchema(db);
  db.exec(`CREATE INDEX IF NOT EXISTS replication_outbox_expiry ON replication_outbox(entity_type, created_at);
    CREATE INDEX IF NOT EXISTS cluster_v2_relay_log_expiry ON cluster_v2_relay_log(${RELAY_TYPE}, ${RELAY_CREATED});`);
}

/** Runs one page in its own savepoint and yields before the next; `step` says whether more remain. */
async function pages(db: DatabaseSync, step: () => boolean): Promise<void> {
  for (;;) {
    db.exec("SAVEPOINT replication_housekeeping");
    let more: boolean;
    try { more = step(); db.exec("RELEASE replication_housekeeping"); }
    catch (error) { db.exec("ROLLBACK TO replication_housekeeping; RELEASE replication_housekeeping"); throw error; }
    if (!more) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function removeOutboxEvent(db: DatabaseSync, eventId: string): void {
  db.prepare("DELETE FROM replication_deliveries WHERE event_id=?").run(eventId);
  db.prepare("DELETE FROM replication_outbox WHERE event_id=?").run(eventId);
}

function removeRelayEvent(db: DatabaseSync, clusterId: string, eventId: string): void {
  // A queue row without its relay entry would fail every delivery attempt.
  db.prepare("DELETE FROM cluster_v2_hub_queue WHERE cluster_id=? AND event_id=?").run(clusterId, eventId);
  db.prepare("DELETE FROM cluster_v2_relay_log WHERE cluster_id=? AND event_id=?").run(clusterId, eventId);
}

/** The newest row stays (here and below): the outbox has no AUTOINCREMENT, so removing it
    would let the next event reuse its rowid, behind the peer scan and hub cursors. */
function expireOutboxPage(db: DatabaseSync, entityType: string, cutoff: string, result: HousekeepingResult): boolean {
  const rows = db.prepare(`SELECT event_id FROM replication_outbox WHERE entity_type=? AND created_at<?
    AND rowid<(SELECT max(rowid) FROM replication_outbox) LIMIT ?`).all(entityType, cutoff, PAGE) as unknown as Array<{ event_id: string }>;
  for (const { event_id } of rows) removeOutboxEvent(db, event_id);
  result.expiredOutbox += rows.length;
  return rows.length === PAGE;
}

function expireRelayPage(db: DatabaseSync, entityType: string, cutoff: string, result: HousekeepingResult): boolean {
  const rows = db.prepare(`SELECT cluster_id, event_id FROM cluster_v2_relay_log WHERE ${RELAY_TYPE}=? AND ${RELAY_CREATED}<? LIMIT ?`)
    .all(entityType, cutoff, PAGE) as unknown as Array<{ cluster_id: string; event_id: string }>;
  for (const row of rows) removeRelayEvent(db, row.cluster_id, row.event_id);
  result.expiredRelay += rows.length;
  return rows.length === PAGE;
}

/** Walks every recent-conversation event once, keeping the highest stamp of each repeated row.
    Stamps, not rowids, pick the keeper: a re-delivered copy is re-logged at a higher seq. */
function dropRepeatedRecents(db: DatabaseSync, result: HousekeepingResult): { outbox: () => boolean; relay: () => boolean } {
  const kept = new Map<string, { stamp: string; remove: () => void }>();
  const offer = (group: string, payload: RecentEventPayload, remove: () => void): void => {
    if (typeof payload?.updatedAt !== "string") return;
    const previous = kept.get(group);
    if (!previous) { kept.set(group, { stamp: payload.updatedAt, remove }); return; }
    if (payload.updatedAt > previous.stamp) { previous.remove(); kept.set(group, { stamp: payload.updatedAt, remove }); } else remove();
    result.repeatedRecents += 1;
  };
  let outboxAfter = ["", 0] as [string, number], relayAfter = ["", 0] as [string, number];
  return {
    outbox: () => {
      const rows = db.prepare(`SELECT rowid, event_id, entity_key, origin_node_id, created_at, payload FROM replication_outbox WHERE entity_type='user.recent'
        AND (created_at, rowid)>(?, ?) AND rowid<(SELECT max(rowid) FROM replication_outbox) ORDER BY created_at, rowid LIMIT ?`)
        .all(...outboxAfter, PAGE) as unknown as Array<{ rowid: number; event_id: string; entity_key: string; origin_node_id: string; created_at: string; payload: string }>;
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as RecentEventPayload;
        offer(`outbox\n${row.entity_key}\n${row.origin_node_id}\n${JSON.stringify(payload.recent)}`, payload, () => removeOutboxEvent(db, row.event_id));
      }
      if (rows.length) outboxAfter = [rows[rows.length - 1].created_at, rows[rows.length - 1].rowid];
      return rows.length === PAGE;
    },
    relay: () => {
      // Spelled out rather than a row value, which SQLite cannot turn into a range on this expression index.
      const rows = db.prepare(`SELECT seq, cluster_id, event_id, ${RELAY_CREATED} created_at, event FROM cluster_v2_relay_log WHERE ${RELAY_TYPE}='user.recent'
        AND ${RELAY_CREATED}>=? AND (${RELAY_CREATED}>? OR seq>?) ORDER BY ${RELAY_CREATED}, seq LIMIT ?`)
        .all(relayAfter[0], relayAfter[0], relayAfter[1], PAGE) as unknown as Array<{ seq: number; cluster_id: string; event_id: string; created_at: string; event: string }>;
      for (const row of rows) {
        const event = JSON.parse(row.event) as { entityKey: string; originNodeId: string; payload: RecentEventPayload };
        offer(`relay\n${row.cluster_id}\n${event.entityKey}\n${event.originNodeId}\n${JSON.stringify(event.payload.recent)}`, event.payload, () => removeRelayEvent(db, row.cluster_id, row.event_id));
      }
      if (rows.length) relayAfter = [rows[rows.length - 1].created_at, rows[rows.length - 1].seq];
      return rows.length === PAGE;
    },
  };
}

/** Receipts are written in arrival order, so the oldest are always at the front. */
function expireInboxPage(db: DatabaseSync, cutoff: string, result: HousekeepingResult): boolean {
  const rows = db.prepare("SELECT rowid, received_at FROM replication_inbox ORDER BY rowid LIMIT ?").all(PAGE) as unknown as Array<{ rowid: number; received_at: string }>;
  const expired = rows.filter((row) => row.received_at < cutoff);
  const remove = db.prepare("DELETE FROM replication_inbox WHERE rowid=?");
  for (const row of expired) remove.run(row.rowid);
  result.expiredInbox += expired.length;
  return rows.length === PAGE && expired.length === rows.length;
}

/** The high slot looks up which hub took the low slot, so a slot stays while its sibling is pending. */
function expireHubQueuePage(db: DatabaseSync, cutoff: string, result: HousekeepingResult): boolean {
  const removed = Number(db.prepare(`DELETE FROM cluster_v2_hub_queue WHERE rowid IN (SELECT q.rowid FROM cluster_v2_hub_queue q WHERE q.delivered_at<?
    AND NOT EXISTS (SELECT 1 FROM cluster_v2_hub_queue p WHERE p.event_id=q.event_id AND p.cluster_id=q.cluster_id AND p.delivered_at IS NULL) LIMIT ?)`).run(cutoff, PAGE).changes);
  result.deliveredHubQueue += removed;
  return removed === PAGE;
}

export async function housekeepReplication(db: DatabaseSync, now = Date.now()): Promise<HousekeepingResult> {
  ensureHousekeepingSchema(db);
  const result: HousekeepingResult = { expiredOutbox: 0, expiredRelay: 0, repeatedRecents: 0, expiredInbox: 0, deliveredHubQueue: 0 };
  const before = (days: number) => new Date(now - days * DAY_MS).toISOString();
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

let activeRun: Promise<HousekeepingResult> | undefined;

/** Runs housekeeping on this node's database; overlapping calls share one run. */
export function runReplicationHousekeeping(): Promise<HousekeepingResult> {
  activeRun ??= (async () => {
    const result = await housekeepReplication(await clusterV2Database());
    if (Object.values(result).some(Boolean)) console.log(`Replication housekeeping removed ${JSON.stringify(result)}`);
    return result;
  })().finally(() => { activeRun = undefined; });
  return activeRun;
}
