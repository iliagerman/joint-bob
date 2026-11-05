import type { DatabaseSync } from "node:sqlite";
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { enqueueReplicationEvent, ensureReplicationSchema, type ReplicationEvent } from "../replication.js";
import { applyTopicText, MAX_BODY, memoryRoot, onTopicApplied, TOPIC_NAME } from "./memory-store.js";

/** Bob's memory follows the person to their other machines: the newest write of each topic wins. */
export const MEMORY_EVENT = "control.memory";

type Stamp = { updatedAt: string; originNodeId: string };

function ensureStamps(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS control_center_memory_stamps (
    account_id TEXT NOT NULL, topic TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY(account_id, topic))`);
}

function held(db: DatabaseSync, accountId: string, topic: string): Stamp | undefined {
  const row = db.prepare("SELECT updated_at, origin_node_id FROM control_center_memory_stamps WHERE account_id = ? AND topic = ?").get(accountId, topic) as { updated_at: string; origin_node_id: string } | undefined;
  return row && { updatedAt: row.updated_at, originNodeId: row.origin_node_id };
}

const newer = (candidate: Stamp, current: Stamp | undefined): boolean =>
  !current || candidate.updatedAt > current.updatedAt || candidate.updatedAt === current.updatedAt && candidate.originNodeId > current.originNodeId;

function record(db: DatabaseSync, accountId: string, topic: string, stamp: Stamp): void {
  db.prepare(`INSERT INTO control_center_memory_stamps (account_id, topic, updated_at, origin_node_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, topic) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id`).run(accountId, topic, stamp.updatedAt, stamp.originNodeId);
}

/** Sends a topic this machine just wrote (or removed, with null text) to the person's other machines. */
export function publishTopic(db: DatabaseSync, originNodeId: string, accountId: string, topic: string, text: string | null): void {
  ensureReplicationSchema(db);
  ensureStamps(db);
  const current = held(db, accountId, topic);
  const now = new Date().toISOString();
  // A clock behind the last write must still produce the newest stamp.
  const updatedAt = current && current.updatedAt >= now ? new Date(Date.parse(current.updatedAt) + 1).toISOString() : now;
  const stamp = { updatedAt, originNodeId };
  record(db, accountId, topic, stamp);
  enqueueReplicationEvent(db, { originNodeId, entityType: MEMORY_EVENT, entityKey: `${accountId}:${topic}`, operation: text === null ? "delete" : "upsert", payload: { accountId, topic, text, ...stamp } });
}

function payloadOf(event: ReplicationEvent): { accountId: string; topic: string; text: string | null } & Stamp {
  const value = event.payload as Record<string, unknown> | null;
  if (!value || typeof value.accountId !== "string" || value.accountId.length < 1 || value.accountId.length > 200
    || typeof value.topic !== "string" || !TOPIC_NAME.test(value.topic)
    || !(value.text === null || typeof value.text === "string" && value.text.length <= MAX_BODY + 2_000)
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
    || value.originNodeId !== event.originNodeId || event.entityKey !== `${value.accountId}:${value.topic}`
    || (event.operation === "delete") !== (value.text === null)) {
    throw new Error("Malformed Bob memory replication payload");
  }
  return { accountId: value.accountId, topic: value.topic, text: value.text, updatedAt: value.updatedAt, originNodeId: event.originNodeId };
}

/** A topic written on another of the person's machines. The newest write wins; it is not sent on again from here. */
export function applyMemoryEvent(db: DatabaseSync, event: ReplicationEvent): void {
  const incoming = payloadOf(event);
  ensureStamps(db);
  if (!newer(incoming, held(db, incoming.accountId, incoming.topic))) return;
  applyTopicText(memoryRoot(incoming.accountId), incoming.topic, incoming.text);
  record(db, incoming.accountId, incoming.topic, incoming);
}

let started = false;

export function startMemorySync(): void {
  if (started) return;
  started = true;
  onTopicApplied((accountId, topic, text) => {
    void (async () => publishTopic(await clusterV2Database(), (await getClusterNode()).id, accountId, topic, text))()
      .catch((error) => console.warn("Bob's memory could not be sent to your other machines", error instanceof Error ? error.message : error));
  });
}
