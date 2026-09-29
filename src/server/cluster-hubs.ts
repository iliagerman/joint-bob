// Two-hub dissemination of project events inside each cluster.
//
// The node that makes a change sends it only to two hubs: the lowest and the highest
// numbered (by join order) other members that answer. A hub applies the change and
// forwards it to every other member of that cluster. Every node keeps each cluster
// event it holds in `cluster_v2_relay_log`, so a node that was offline, or missed a
// forward, catches up by pulling "everything after my cursor" from the two hubs.
// Relayed events carry the origin's signature, so a hub cannot forge or alter them.
// Twins keep direct delivery (flushReplicationOutbox); events outside any project
// never take this path.
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { pinnedClusterPublicKey, signClusterMessage, verifyClusterMessage } from "../cluster-identity.js";
import { isTrustedTwin, listSharingClusterMembers, listSharingMemberships, mayReceiveResource } from "../cluster-sharing-policy.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { ensureReplicationSchema, receiveReplicationBatch, type ReplicationEvent } from "../replication.js";
import { removeTranscriptsDeletedBy } from "./deleted-transcripts.js";
import { ensureResourceSharingSchema } from "../cluster-sharing.js";
import { signedPost } from "./cluster-v2.js";
import { broadcastReplicationInvalidations } from "./realtime.js";
import { mayReplicateEvent, replicationEventProject } from "./replication-v2.js";
import { replicationReceiptSchema } from "./schemas.js";

export interface RelayEnvelope { event: ReplicationEvent; signature: string }

const BATCH = 100;
const eventSchema = z.object({
  id: z.string().uuid(), originNodeId: z.string().uuid(), entityType: z.string().min(1).max(80),
  entityKey: z.string().min(1).max(300), operation: z.enum(["upsert", "delete", "settings"]),
  payload: z.unknown(), createdAt: z.string().datetime(),
}).strict();
export const relayRequestSchema = z.object({
  clusterId: z.string().uuid(), relay: z.boolean(),
  envelopes: z.array(z.object({ event: eventSchema, signature: z.string() }).strict()).max(BATCH),
}).strict();
export const relayPullSchema = z.object({ clusterId: z.string().uuid(), after: z.number().int().nonnegative() }).strict();

export function ensureHubSchema(db: DatabaseSync): void {
  ensureReplicationSchema(db);
  ensureResourceSharingSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_relay_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, cluster_id TEXT NOT NULL, event_id TEXT NOT NULL, event TEXT NOT NULL, signature TEXT NOT NULL, from_node_id TEXT NOT NULL, UNIQUE(cluster_id,event_id));
CREATE TABLE IF NOT EXISTS cluster_v2_hub_queue(event_id TEXT NOT NULL, cluster_id TEXT NOT NULL, slot TEXT NOT NULL CHECK(slot IN ('low','high')), node_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT, PRIMARY KEY(event_id,cluster_id,slot));
CREATE TABLE IF NOT EXISTS cluster_v2_hub_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1), outbox_rowid INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cluster_v2_hub_projects(cluster_id TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY(cluster_id,project_id));
CREATE TABLE IF NOT EXISTS cluster_v2_pull_cursors(source_node_id TEXT NOT NULL, cluster_id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(source_node_id,cluster_id));
CREATE TABLE IF NOT EXISTS cluster_v2_relay_deferred(cluster_id TEXT NOT NULL, event_id TEXT NOT NULL, event TEXT NOT NULL, signature TEXT NOT NULL, from_node_id TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY(cluster_id,event_id));`);
}

function canonical(event: ReplicationEvent): string {
  return JSON.stringify([event.id, event.originNodeId, event.entityType, event.entityKey, event.operation, event.payload, event.createdAt]);
}

/** Other members of a cluster in join order (lowest number first). */
function otherMembers(db: DatabaseSync, clusterId: string, local: string): string[] {
  return listSharingClusterMembers(db, clusterId).map((member) => member.nodeId).filter((node) => node !== local);
}

function isMember(db: DatabaseSync, clusterId: string, node: string): boolean {
  return listSharingClusterMembers(db, clusterId).some((member) => member.nodeId === node);
}

/** Clusters whose non-twin members may receive this event. Twins already get it directly. */
function hubClusters(db: DatabaseSync, local: string, event: ReplicationEvent): string[] {
  if (!replicationEventProject(db, event)) return [];
  return listSharingMemberships(db, local).map((membership) => membership.clusterId).filter((clusterId) =>
    otherMembers(db, clusterId, local).some((member) => !isTrustedTwin(db, local, member) && mayReplicateEvent(db, local, member, event)));
}

function logEnvelope(db: DatabaseSync, clusterId: string, envelope: RelayEnvelope, from: string): void {
  db.prepare("INSERT OR IGNORE INTO cluster_v2_relay_log(cluster_id,event_id,event,signature,from_node_id) VALUES(?,?,?,?,?)")
    .run(clusterId, envelope.event.id, JSON.stringify(envelope.event), envelope.signature, from);
}

function queueForCluster(db: DatabaseSync, local: string, clusterId: string, event: ReplicationEvent, now: string): void {
  logEnvelope(db, clusterId, { event, signature: signClusterMessage(db, local, "replication-event", canonical(event)) }, local);
  const slots = otherMembers(db, clusterId, local).length > 1 ? ["low", "high"] : ["low"];
  for (const slot of slots) db.prepare("INSERT OR IGNORE INTO cluster_v2_hub_queue(event_id,cluster_id,slot,next_attempt_at) VALUES(?,?,?,?)").run(event.id, clusterId, slot, now);
}

interface OutboxRow { rowid: number; event_id: string; origin_node_id: string; entity_type: string; entity_key: string; operation: string; payload: string; created_at: string }
function eventFromRow(row: OutboxRow): ReplicationEvent {
  return { id: row.event_id, originNodeId: row.origin_node_id, entityType: row.entity_type, entityKey: row.entity_key, operation: row.operation, payload: JSON.parse(row.payload), createdAt: row.created_at };
}

/** Outbox rows examined per transaction. A backlog of many thousand events in one transaction
    blocks the event loop for minutes, and its stale snapshot then fails the cursor write, so
    the same backlog was rescanned forever. */
const ENQUEUE_BATCH = 500;

/** Queues this node's own events for the hubs of every cluster that may receive them. A
    project that becomes shared with a cluster later gets its earlier events queued once.
    Returns whether more of the outbox remains past the cursor. */
function enqueueOwnEvents(db: DatabaseSync, local: string): boolean {
  ensureHubSchema(db);
  const now = new Date().toISOString();
  const shared = new Set<string>();
  for (const { clusterId } of listSharingMemberships(db, local)) {
    for (const { id } of db.prepare("SELECT resource_id id FROM cluster_v2_resource_policy WHERE kind='project' AND deleted=0").all() as unknown as Array<{ id: string }>) {
      if (mayReceiveResource(db, local, "project", id) && otherMembers(db, clusterId, local).some((member) => !isTrustedTwin(db, local, member) && mayReceiveResource(db, member, "project", id))) shared.add(`${clusterId}\n${id}`);
    }
  }
  const known = new Set((db.prepare("SELECT cluster_id,project_id FROM cluster_v2_hub_projects").all() as unknown as Array<{ cluster_id: string; project_id: string }>).map((row) => `${row.cluster_id}\n${row.project_id}`));
  const added = [...shared].filter((pair) => !known.has(pair));
  db.exec("SAVEPOINT hub_enqueue");
  try {
    for (const pair of known) if (!shared.has(pair)) {
      const [clusterId, projectId] = pair.split("\n");
      db.prepare("DELETE FROM cluster_v2_hub_projects WHERE cluster_id=? AND project_id=?").run(clusterId, projectId);
    }
    if (added.length) {
      for (const row of db.prepare("SELECT rowid,* FROM replication_outbox WHERE origin_node_id=? ORDER BY rowid").iterate(local) as unknown as Iterable<OutboxRow>) {
        const event = eventFromRow(row), project = replicationEventProject(db, event);
        for (const pair of added) {
          const [clusterId, projectId] = pair.split("\n");
          if (project === projectId) queueForCluster(db, local, clusterId, event, now);
        }
      }
      for (const pair of added) {
        const [clusterId, projectId] = pair.split("\n");
        db.prepare("INSERT INTO cluster_v2_hub_projects VALUES(?,?)").run(clusterId, projectId);
      }
    }
    const cursor = (db.prepare("SELECT outbox_rowid FROM cluster_v2_hub_cursor WHERE singleton=1").get() as { outbox_rowid: number } | undefined)?.outbox_rowid ?? 0;
    let last = cursor, examined = 0;
    for (const row of db.prepare("SELECT rowid,* FROM replication_outbox WHERE rowid>? AND origin_node_id=? ORDER BY rowid LIMIT ?").iterate(cursor, local, ENQUEUE_BATCH) as unknown as Iterable<OutboxRow>) {
      last = row.rowid;
      examined += 1;
      const event = eventFromRow(row);
      for (const clusterId of hubClusters(db, local, event)) queueForCluster(db, local, clusterId, event, now);
    }
    const more = examined === ENQUEUE_BATCH;
    // Only a drained outbox may skip ahead past other nodes' rows.
    const newest = more ? last : (db.prepare("SELECT max(rowid) id FROM replication_outbox").get() as { id: number | null }).id ?? 0;
    db.prepare("INSERT INTO cluster_v2_hub_cursor VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET outbox_rowid=excluded.outbox_rowid").run(Math.max(last, newest));
    db.exec("RELEASE hub_enqueue");
    return more;
  } catch (error) { db.exec("ROLLBACK TO hub_enqueue; RELEASE hub_enqueue"); throw error; }
}

interface QueueRow { event_id: string; cluster_id: string; slot: "low" | "high"; attempts: number }

async function sendToHub(db: DatabaseSync, local: string, clusterId: string, hub: string, eventIds: string[]): Promise<void> {
  const envelopes = eventIds.map((id) => {
    const row = db.prepare("SELECT event,signature FROM cluster_v2_relay_log WHERE cluster_id=? AND event_id=?").get(clusterId, id) as { event: string; signature: string };
    return { event: JSON.parse(row.event) as ReplicationEvent, signature: row.signature };
  });
  replicationReceiptSchema.parse(await signedPost(db, local, hub, clusterId, "/api/cluster/v2/relay", { clusterId, relay: true, envelopes }));
}

/** Delivers queued events to the hubs. A hub that does not answer is skipped: the next
    member in line takes its place, from the low end or the high end. */
async function deliverToHubs(db: DatabaseSync, local: string): Promise<void> {
  const due = db.prepare("SELECT event_id,cluster_id,slot,attempts FROM cluster_v2_hub_queue WHERE delivered_at IS NULL AND next_attempt_at<=? ORDER BY rowid LIMIT 500")
    .all(new Date().toISOString()) as unknown as QueueRow[];
  const groups = new Map<string, QueueRow[]>();
  for (const row of due) groups.set(`${row.cluster_id}\n${row.slot}`, [...(groups.get(`${row.cluster_id}\n${row.slot}`) ?? []), row]);
  for (const [key, rows] of groups) {
    const [clusterId, slot] = key.split("\n");
    if (!listSharingMemberships(db, local).some((membership) => membership.clusterId === clusterId)) {
      db.prepare("DELETE FROM cluster_v2_hub_queue WHERE cluster_id=?").run(clusterId);
      continue;
    }
    const members = otherMembers(db, clusterId, local);
    const candidates = slot === "low" ? members : [...members].reverse();
    let pending = rows;
    let lastError = "No hub answered";
    for (const hub of candidates) {
      // The high hub must differ from the node that already holds an event as its low hub.
      const sendable = pending.filter((row) => slot === "low" || (db.prepare("SELECT node_id FROM cluster_v2_hub_queue WHERE event_id=? AND cluster_id=? AND slot='low'").get(row.event_id, clusterId) as { node_id: string | null } | undefined)?.node_id !== hub);
      if (!sendable.length) continue;
      try {
        for (let index = 0; index < sendable.length; index += BATCH) {
          const batch = sendable.slice(index, index + BATCH);
          await sendToHub(db, local, clusterId, hub, batch.map((row) => row.event_id));
          const delivered = new Date().toISOString();
          for (const row of batch) db.prepare("UPDATE cluster_v2_hub_queue SET node_id=?,delivered_at=?,last_error=NULL WHERE event_id=? AND cluster_id=? AND slot=?").run(hub, delivered, row.event_id, clusterId, slot);
        }
        pending = pending.filter((row) => !sendable.includes(row));
        if (!pending.length) break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Hub delivery failed";
      }
    }
    for (const row of pending) {
      const attempts = row.attempts + 1;
      db.prepare("UPDATE cluster_v2_hub_queue SET attempts=?,next_attempt_at=?,last_error=? WHERE event_id=? AND cluster_id=? AND slot=?")
        .run(attempts, new Date(Date.now() + Math.min(300, 2 ** Math.min(attempts, 8)) * 1000).toISOString(), lastError, row.event_id, clusterId, slot);
    }
    if (pending.length) console.warn(`Hub delivery for cluster ${clusterId} (${slot}) is pending: ${lastError}`);
  }
}

let flushing = false;
/** Queues this node's new events and delivers them to the hubs of each cluster. */
export async function flushHubDeliveries(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const db = await clusterV2Database(), local = (await getClusterNode()).id;
    while (enqueueOwnEvents(db, local)) await new Promise((resolve) => setImmediate(resolve));
    await deliverToHubs(db, local);
    // Events set aside may fit now that other data arrived, by any path.
    for (const { clusterId } of listSharingMemberships(db, local)) await applyDeferred(db, local, clusterId);
  } finally { flushing = false; }
}

const DEFERRED_MS = 7 * 24 * 60 * 60 * 1000;

function inScope(db: DatabaseSync, local: string, sender: string, event: ReplicationEvent): boolean {
  return mayReplicateEvent(db, local, event.originNodeId, event) && mayReplicateEvent(db, local, sender, event);
}

/** Accepts events a cluster member sent: each must carry its origin's valid signature, and
    this node, the origin, and the sender must all be allowed to see the event's project.
    An event whose project this node cannot place yet (a conversation's ownership before
    its record) is set aside and applied once it can; it never blocks the rest. */
export function acceptEnvelopes(db: DatabaseSync, local: string, clusterId: string, sender: string, envelopes: RelayEnvelope[]): RelayEnvelope[] {
  ensureHubSchema(db);
  if (!isMember(db, clusterId, local) || !isMember(db, clusterId, sender)) throw new ClusterV2HttpError(403, "Sender and receiver must share the cluster");
  for (const envelope of envelopes) {
    const { event } = envelope, key = pinnedClusterPublicKey(db, event.originNodeId);
    if (!isMember(db, clusterId, event.originNodeId) || !key || !verifyClusterMessage(key, "replication-event", canonical(event), envelope.signature)) {
      throw new ClusterV2HttpError(403, "Relayed event signature is invalid");
    }
  }
  const now = new Date().toISOString();
  return envelopes.filter((envelope) => {
    if (inScope(db, local, sender, envelope.event)) return true;
    db.prepare("INSERT OR IGNORE INTO cluster_v2_relay_deferred VALUES(?,?,?,?,?,?)")
      .run(clusterId, envelope.event.id, JSON.stringify(envelope.event), envelope.signature, sender, now);
    return false;
  });
}

async function applyBatch(db: DatabaseSync, clusterId: string, from: string, envelopes: RelayEnvelope[]): Promise<string[]> {
  const received = await receiveReplicationBatch({ events: envelopes.map((envelope) => envelope.event) });
  for (const envelope of envelopes) logEnvelope(db, clusterId, envelope, from);
  const applied = envelopes.filter((envelope) => received.includes(envelope.event.id)).map((envelope) => envelope.event);
  await removeTranscriptsDeletedBy(applied);
  broadcastReplicationInvalidations(applied);
  return received;
}

/** Applies set-aside events that this node can place now, until none are left that it can. */
async function applyDeferred(db: DatabaseSync, local: string, clusterId: string): Promise<void> {
  db.prepare("DELETE FROM cluster_v2_relay_deferred WHERE received_at<?").run(new Date(Date.now() - DEFERRED_MS).toISOString());
  for (;;) {
    const rows = db.prepare("SELECT event,signature,from_node_id FROM cluster_v2_relay_deferred WHERE cluster_id=? ORDER BY rowid").all(clusterId) as unknown as Array<{ event: string; signature: string; from_node_id: string }>;
    const ready = rows.map((row) => ({ from: row.from_node_id, envelope: { event: JSON.parse(row.event) as ReplicationEvent, signature: row.signature } }))
      .filter(({ from, envelope }) => isMember(db, clusterId, from) && inScope(db, local, from, envelope.event));
    if (!ready.length) return;
    for (const { from, envelope } of ready) {
      await applyBatch(db, clusterId, from, [envelope]);
      db.prepare("DELETE FROM cluster_v2_relay_deferred WHERE cluster_id=? AND event_id=?").run(clusterId, envelope.event.id);
    }
  }
}

async function applyEnvelopes(db: DatabaseSync, local: string, clusterId: string, from: string, envelopes: RelayEnvelope[]): Promise<string[]> {
  const received = envelopes.length ? await applyBatch(db, clusterId, from, envelopes) : [];
  await applyDeferred(db, local, clusterId);
  return received;
}

/** A hub or member receiving relayed events. A hub (`relay: true`, sent by the origin)
    forwards them to every other member of the cluster that may see them. */
export async function receiveRelay(sender: string, input: z.infer<typeof relayRequestSchema>): Promise<string[]> {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  if (input.relay && input.envelopes.some((envelope) => envelope.event.originNodeId !== sender)) throw new ClusterV2HttpError(403, "Only the origin asks a hub to relay");
  const envelopes = acceptEnvelopes(db, local, input.clusterId, sender, input.envelopes as RelayEnvelope[]);
  const received = await applyEnvelopes(db, local, input.clusterId, sender, envelopes);
  if (input.relay) void forward(db, local, input.clusterId, sender, envelopes);
  // Set-aside events count as received: this node applies them itself once it can.
  return [...received, ...input.envelopes.map((envelope) => envelope.event.id).filter((id) => !envelopes.some((envelope) => envelope.event.id === id))];
}

async function forward(db: DatabaseSync, local: string, clusterId: string, origin: string, envelopes: RelayEnvelope[]): Promise<void> {
  for (const member of otherMembers(db, clusterId, local).filter((member) => member !== origin)) {
    const allowed = envelopes.filter((envelope) => mayReplicateEvent(db, local, member, envelope.event));
    if (!allowed.length) continue;
    try { await signedPost(db, local, member, clusterId, "/api/cluster/v2/relay", { clusterId, relay: false, envelopes: allowed }); }
    catch (error) { console.warn(`Hub forward to ${member} failed; it will pull the change: ${error instanceof Error ? error.message : error}`); }
  }
}

/** Events after `after` in this node's log for a cluster that the puller may see. */
export async function relayPage(sender: string, input: z.infer<typeof relayPullSchema>): Promise<{ envelopes: RelayEnvelope[]; next: number }> {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  ensureHubSchema(db);
  if (!isMember(db, input.clusterId, local) || !isMember(db, input.clusterId, sender)) throw new ClusterV2HttpError(403, "Sender and receiver must share the cluster");
  const rows = db.prepare("SELECT seq,event,signature FROM cluster_v2_relay_log WHERE cluster_id=? AND seq>? ORDER BY seq LIMIT ?").all(input.clusterId, input.after, BATCH) as unknown as Array<{ seq: number; event: string; signature: string }>;
  const envelopes = rows.map((row) => ({ event: JSON.parse(row.event) as ReplicationEvent, signature: row.signature }))
    .filter((envelope) => envelope.event.originNodeId !== sender && mayReplicateEvent(db, local, sender, envelope.event));
  return { envelopes, next: rows.length ? rows[rows.length - 1].seq : input.after };
}

async function pullFrom(db: DatabaseSync, local: string, clusterId: string, source: string): Promise<void> {
  for (;;) {
    const after = (db.prepare("SELECT seq FROM cluster_v2_pull_cursors WHERE source_node_id=? AND cluster_id=?").get(source, clusterId) as { seq: number } | undefined)?.seq ?? 0;
    const page = await signedPost<{ envelopes: RelayEnvelope[]; next: number }>(db, local, source, clusterId, "/api/cluster/v2/relay/pull", { clusterId, after });
    if (page.envelopes.length) await applyEnvelopes(db, local, clusterId, source, acceptEnvelopes(db, local, clusterId, source, page.envelopes));
    db.prepare("INSERT INTO cluster_v2_pull_cursors VALUES(?,?,?) ON CONFLICT(source_node_id,cluster_id) DO UPDATE SET seq=excluded.seq").run(source, clusterId, page.next);
    if (page.next === after) return;
  }
}

let pulling = false;
/** Catches up on every cluster from its two hubs: the lowest and highest numbered other
    members that answer. Runs at start-up and every minute. */
export async function pullFromHubs(): Promise<void> {
  if (pulling) return;
  pulling = true;
  try {
    const db = await clusterV2Database(), local = (await getClusterNode()).id;
    ensureHubSchema(db);
    for (const { clusterId } of listSharingMemberships(db, local)) {
      const members = otherMembers(db, clusterId, local);
      let low: string | undefined;
      for (const candidate of members) {
        try { await pullFrom(db, local, clusterId, candidate); low = candidate; break; } catch { /* The next member in line takes its place. */ }
      }
      for (const candidate of [...members].reverse()) {
        if (candidate === low) break;
        try { await pullFrom(db, local, clusterId, candidate); break; } catch { /* The next member in line takes its place. */ }
      }
    }
  } finally { pulling = false; }
}
