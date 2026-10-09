import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { pinnedClusterPublicKey, signClusterMessage, verifyClusterMessage } from "../cluster-identity.js";
import { isTrustedTwin, listSharingClusterMembers, listSharingMemberships, mayReceiveResource } from "../cluster-sharing-policy.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { ensureReplicationSchema, receiveReplicationBatch } from "../replication.js";
import { removeTranscriptsDeletedBy } from "./deleted-transcripts.js";
import { ensureResourceSharingSchema } from "../cluster-sharing.js";
import { signedPost } from "./cluster-v2.js";
import { broadcastReplicationInvalidations } from "./realtime.js";
import { mayReplicateEvent, replicationEventProject } from "./replication-v2.js";
import { replicationReceiptSchema } from "./schemas.js";
const BATCH = 100;
const eventSchema = z.object({
  id: z.string().uuid(),
  originNodeId: z.string().uuid(),
  entityType: z.string().min(1).max(80),
  entityKey: z.string().min(1).max(300),
  operation: z.enum(["upsert", "delete", "settings"]),
  payload: z.unknown(),
  createdAt: z.string().datetime()
}).strict();
const relayRequestSchema = z.object({
  clusterId: z.string().uuid(),
  relay: z.boolean(),
  envelopes: z.array(z.object({ event: eventSchema, signature: z.string() }).strict()).max(BATCH)
}).strict();
const relayPullSchema = z.object({ clusterId: z.string().uuid(), after: z.number().int().nonnegative() }).strict();
function ensureHubSchema(db) {
  ensureReplicationSchema(db);
  ensureResourceSharingSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_relay_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, cluster_id TEXT NOT NULL, event_id TEXT NOT NULL, event TEXT NOT NULL, signature TEXT NOT NULL, from_node_id TEXT NOT NULL, UNIQUE(cluster_id,event_id));
CREATE TABLE IF NOT EXISTS cluster_v2_hub_queue(event_id TEXT NOT NULL, cluster_id TEXT NOT NULL, slot TEXT NOT NULL CHECK(slot IN ('low','high')), node_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT, PRIMARY KEY(event_id,cluster_id,slot));
CREATE TABLE IF NOT EXISTS cluster_v2_hub_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1), outbox_rowid INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cluster_v2_hub_projects(cluster_id TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY(cluster_id,project_id));
CREATE TABLE IF NOT EXISTS cluster_v2_pull_cursors(source_node_id TEXT NOT NULL, cluster_id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(source_node_id,cluster_id));
CREATE TABLE IF NOT EXISTS cluster_v2_relay_deferred(cluster_id TEXT NOT NULL, event_id TEXT NOT NULL, event TEXT NOT NULL, signature TEXT NOT NULL, from_node_id TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY(cluster_id,event_id));`);
}
function canonical(event) {
  return JSON.stringify([event.id, event.originNodeId, event.entityType, event.entityKey, event.operation, event.payload, event.createdAt]);
}
function otherMembers(db, clusterId, local) {
  return listSharingClusterMembers(db, clusterId).map((member) => member.nodeId).filter((node) => node !== local);
}
function isMember(db, clusterId, node) {
  return listSharingClusterMembers(db, clusterId).some((member) => member.nodeId === node);
}
function hubClusters(db, local, event) {
  if (!replicationEventProject(db, event)) return [];
  return listSharingMemberships(db, local).map((membership) => membership.clusterId).filter((clusterId) => otherMembers(db, clusterId, local).some((member) => !isTrustedTwin(db, local, member) && mayReplicateEvent(db, local, member, event)));
}
function logEnvelope(db, clusterId, envelope, from) {
  db.prepare("INSERT OR IGNORE INTO cluster_v2_relay_log(cluster_id,event_id,event,signature,from_node_id) VALUES(?,?,?,?,?)").run(clusterId, envelope.event.id, JSON.stringify(envelope.event), envelope.signature, from);
}
function queueForCluster(db, local, clusterId, event, now) {
  logEnvelope(db, clusterId, { event, signature: signClusterMessage(db, local, "replication-event", canonical(event)) }, local);
  const slots = otherMembers(db, clusterId, local).length > 1 ? ["low", "high"] : ["low"];
  for (const slot of slots) db.prepare("INSERT OR IGNORE INTO cluster_v2_hub_queue(event_id,cluster_id,slot,next_attempt_at) VALUES(?,?,?,?)").run(event.id, clusterId, slot, now);
}
function eventFromRow(row) {
  return { id: row.event_id, originNodeId: row.origin_node_id, entityType: row.entity_type, entityKey: row.entity_key, operation: row.operation, payload: JSON.parse(row.payload), createdAt: row.created_at };
}
const ENQUEUE_BATCH = 500;
function enqueueOwnEvents(db, local) {
  ensureHubSchema(db);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const shared = /* @__PURE__ */ new Set();
  for (const { clusterId } of listSharingMemberships(db, local)) {
    for (const { id } of db.prepare("SELECT resource_id id FROM cluster_v2_resource_policy WHERE kind='project' AND deleted=0").all()) {
      if (mayReceiveResource(db, local, "project", id) && otherMembers(db, clusterId, local).some((member) => !isTrustedTwin(db, local, member) && mayReceiveResource(db, member, "project", id))) shared.add(`${clusterId}
${id}`);
    }
  }
  const known = new Set(db.prepare("SELECT cluster_id,project_id FROM cluster_v2_hub_projects").all().map((row) => `${row.cluster_id}
${row.project_id}`));
  const added = [...shared].filter((pair) => !known.has(pair));
  db.exec("SAVEPOINT hub_enqueue");
  try {
    for (const pair of known) if (!shared.has(pair)) {
      const [clusterId, projectId] = pair.split("\n");
      db.prepare("DELETE FROM cluster_v2_hub_projects WHERE cluster_id=? AND project_id=?").run(clusterId, projectId);
    }
    if (added.length) {
      for (const row of db.prepare("SELECT rowid,* FROM replication_outbox WHERE origin_node_id=? ORDER BY rowid").iterate(local)) {
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
    const cursor = db.prepare("SELECT outbox_rowid FROM cluster_v2_hub_cursor WHERE singleton=1").get()?.outbox_rowid ?? 0;
    let last = cursor, examined = 0;
    for (const row of db.prepare("SELECT rowid,* FROM replication_outbox WHERE rowid>? AND origin_node_id=? ORDER BY rowid LIMIT ?").iterate(cursor, local, ENQUEUE_BATCH)) {
      last = row.rowid;
      examined += 1;
      const event = eventFromRow(row);
      for (const clusterId of hubClusters(db, local, event)) queueForCluster(db, local, clusterId, event, now);
    }
    const more = examined === ENQUEUE_BATCH;
    const newest = more ? last : db.prepare("SELECT max(rowid) id FROM replication_outbox").get().id ?? 0;
    db.prepare("INSERT INTO cluster_v2_hub_cursor VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET outbox_rowid=excluded.outbox_rowid").run(Math.max(last, newest));
    db.exec("RELEASE hub_enqueue");
    return more;
  } catch (error) {
    db.exec("ROLLBACK TO hub_enqueue; RELEASE hub_enqueue");
    throw error;
  }
}
async function sendToHub(db, local, clusterId, hub, eventIds) {
  const envelopes = eventIds.map((id) => {
    const row = db.prepare("SELECT event,signature FROM cluster_v2_relay_log WHERE cluster_id=? AND event_id=?").get(clusterId, id);
    return { event: JSON.parse(row.event), signature: row.signature };
  });
  replicationReceiptSchema.parse(await signedPost(db, local, hub, clusterId, "/api/cluster/v2/relay", { clusterId, relay: true, envelopes }));
}
async function deliverToHubs(db, local) {
  const due = db.prepare("SELECT event_id,cluster_id,slot,attempts FROM cluster_v2_hub_queue WHERE delivered_at IS NULL AND next_attempt_at<=? ORDER BY rowid LIMIT 500").all((/* @__PURE__ */ new Date()).toISOString());
  const groups = /* @__PURE__ */ new Map();
  for (const row of due) groups.set(`${row.cluster_id}
${row.slot}`, [...groups.get(`${row.cluster_id}
${row.slot}`) ?? [], row]);
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
      const sendable = pending.filter((row) => slot === "low" || db.prepare("SELECT node_id FROM cluster_v2_hub_queue WHERE event_id=? AND cluster_id=? AND slot='low'").get(row.event_id, clusterId)?.node_id !== hub);
      if (!sendable.length) continue;
      try {
        for (let index = 0; index < sendable.length; index += BATCH) {
          const batch = sendable.slice(index, index + BATCH);
          await sendToHub(db, local, clusterId, hub, batch.map((row) => row.event_id));
          const delivered = (/* @__PURE__ */ new Date()).toISOString();
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
      db.prepare("UPDATE cluster_v2_hub_queue SET attempts=?,next_attempt_at=?,last_error=? WHERE event_id=? AND cluster_id=? AND slot=?").run(attempts, new Date(Date.now() + Math.min(300, 2 ** Math.min(attempts, 8)) * 1e3).toISOString(), lastError, row.event_id, clusterId, slot);
    }
    if (pending.length) console.warn(`Hub delivery for cluster ${clusterId} (${slot}) is pending: ${lastError}`);
  }
}
let flushing = false;
async function flushHubDeliveries() {
  if (flushing) return;
  flushing = true;
  try {
    const db = await clusterV2Database(), local = (await getClusterNode()).id;
    while (enqueueOwnEvents(db, local)) await new Promise((resolve) => setImmediate(resolve));
    await deliverToHubs(db, local);
    for (const { clusterId } of listSharingMemberships(db, local)) await applyDeferred(db, local, clusterId);
  } finally {
    flushing = false;
  }
}
const DEFERRED_MS = 7 * 24 * 60 * 60 * 1e3;
function inScope(db, local, sender, event) {
  return mayReplicateEvent(db, local, event.originNodeId, event) && mayReplicateEvent(db, local, sender, event);
}
function acceptEnvelopes(db, local, clusterId, sender, envelopes) {
  ensureHubSchema(db);
  if (!isMember(db, clusterId, local) || !isMember(db, clusterId, sender)) throw new ClusterV2HttpError(403, "Sender and receiver must share the cluster");
  for (const envelope of envelopes) {
    const { event } = envelope, key = pinnedClusterPublicKey(db, event.originNodeId);
    if (!isMember(db, clusterId, event.originNodeId) || !key || !verifyClusterMessage(key, "replication-event", canonical(event), envelope.signature)) {
      throw new ClusterV2HttpError(403, "Relayed event signature is invalid");
    }
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return envelopes.filter((envelope) => {
    if (inScope(db, local, sender, envelope.event)) return true;
    if (isTrustedTwin(db, local, envelope.event.originNodeId)) return false;
    db.prepare("INSERT OR IGNORE INTO cluster_v2_relay_deferred VALUES(?,?,?,?,?,?)").run(clusterId, envelope.event.id, JSON.stringify(envelope.event), envelope.signature, sender, now);
    return false;
  });
}
async function applyBatch(db, clusterId, from, envelopes) {
  const received = await receiveReplicationBatch({ events: envelopes.map((envelope) => envelope.event) });
  for (const envelope of envelopes) logEnvelope(db, clusterId, envelope, from);
  const applied = envelopes.filter((envelope) => received.includes(envelope.event.id)).map((envelope) => envelope.event);
  await removeTranscriptsDeletedBy(applied);
  broadcastReplicationInvalidations(applied);
  return received;
}
const DEFERRED_PAGE = 200;
const DEFERRED_IDLE_MS = 3e4;
const deferredChecks = /* @__PURE__ */ new Map();
async function applyDeferred(db, local, clusterId, arrived = false) {
  const previous = deferredChecks.get(clusterId);
  if (!arrived && previous && Date.now() - previous.checkedAt < DEFERRED_IDLE_MS) return previous.running;
  const running = (previous?.running ?? Promise.resolve()).then(() => applyDeferredPasses(db, local, clusterId));
  deferredChecks.set(clusterId, { running: running.catch(() => void 0), checkedAt: Date.now() });
  return running;
}
async function applyDeferredPasses(db, local, clusterId) {
  db.prepare("DELETE FROM cluster_v2_relay_deferred WHERE received_at<?").run(new Date(Date.now() - DEFERRED_MS).toISOString());
  const remove = db.prepare("DELETE FROM cluster_v2_relay_deferred WHERE cluster_id=? AND event_id=?");
  for (; ; ) {
    let applied = 0, after = 0;
    for (; ; ) {
      const rows = db.prepare("SELECT rowid,event,signature,from_node_id FROM cluster_v2_relay_deferred WHERE cluster_id=? AND rowid>? ORDER BY rowid LIMIT ?").all(clusterId, after, DEFERRED_PAGE);
      if (!rows.length) break;
      after = rows[rows.length - 1].rowid;
      for (const row of rows) {
        const envelope = { event: JSON.parse(row.event), signature: row.signature };
        const ready = isMember(db, clusterId, row.from_node_id) && inScope(db, local, row.from_node_id, envelope.event);
        if (!ready && isTrustedTwin(db, local, envelope.event.originNodeId)) {
          remove.run(clusterId, envelope.event.id);
          continue;
        }
        if (!ready) continue;
        await applyBatch(db, clusterId, row.from_node_id, [envelope]);
        remove.run(clusterId, envelope.event.id);
        applied += 1;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (!applied) return;
  }
}
async function applyEnvelopes(db, local, clusterId, from, envelopes) {
  const received = envelopes.length ? await applyBatch(db, clusterId, from, envelopes) : [];
  await applyDeferred(db, local, clusterId, envelopes.length > 0);
  return received;
}
async function receiveRelay(sender, input) {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  if (input.relay && input.envelopes.some((envelope) => envelope.event.originNodeId !== sender)) throw new ClusterV2HttpError(403, "Only the origin asks a hub to relay");
  const envelopes = acceptEnvelopes(db, local, input.clusterId, sender, input.envelopes);
  const received = await applyEnvelopes(db, local, input.clusterId, sender, envelopes);
  if (input.relay) void forward(db, local, input.clusterId, sender, envelopes);
  return [...received, ...input.envelopes.map((envelope) => envelope.event.id).filter((id) => !envelopes.some((envelope) => envelope.event.id === id))];
}
async function forward(db, local, clusterId, origin, envelopes) {
  for (const member of otherMembers(db, clusterId, local).filter((member2) => member2 !== origin)) {
    const allowed = envelopes.filter((envelope) => mayReplicateEvent(db, local, member, envelope.event));
    if (!allowed.length) continue;
    try {
      await signedPost(db, local, member, clusterId, "/api/cluster/v2/relay", { clusterId, relay: false, envelopes: allowed });
    } catch (error) {
      console.warn(`Hub forward to ${member} failed; it will pull the change: ${error instanceof Error ? error.message : error}`);
    }
  }
}
async function relayPage(sender, input) {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  ensureHubSchema(db);
  if (!isMember(db, input.clusterId, local) || !isMember(db, input.clusterId, sender)) throw new ClusterV2HttpError(403, "Sender and receiver must share the cluster");
  const rows = db.prepare("SELECT seq,event,signature FROM cluster_v2_relay_log WHERE cluster_id=? AND seq>? ORDER BY seq LIMIT ?").all(input.clusterId, input.after, BATCH);
  const envelopes = rows.map((row) => ({ event: JSON.parse(row.event), signature: row.signature })).filter((envelope) => envelope.event.originNodeId !== sender && mayReplicateEvent(db, local, sender, envelope.event));
  return { envelopes, next: rows.length ? rows[rows.length - 1].seq : input.after };
}
async function pullFrom(db, local, clusterId, source) {
  for (; ; ) {
    const after = db.prepare("SELECT seq FROM cluster_v2_pull_cursors WHERE source_node_id=? AND cluster_id=?").get(source, clusterId)?.seq ?? 0;
    const page = await signedPost(db, local, source, clusterId, "/api/cluster/v2/relay/pull", { clusterId, after });
    if (page.envelopes.length) await applyEnvelopes(db, local, clusterId, source, acceptEnvelopes(db, local, clusterId, source, page.envelopes));
    db.prepare("INSERT INTO cluster_v2_pull_cursors VALUES(?,?,?) ON CONFLICT(source_node_id,cluster_id) DO UPDATE SET seq=excluded.seq").run(source, clusterId, page.next);
    if (page.next === after) return;
  }
}
let pulling = false;
async function pullFromHubs() {
  if (pulling) return;
  pulling = true;
  try {
    const db = await clusterV2Database(), local = (await getClusterNode()).id;
    ensureHubSchema(db);
    for (const { clusterId } of listSharingMemberships(db, local)) {
      const members = otherMembers(db, clusterId, local);
      let low;
      for (const candidate of members) {
        try {
          await pullFrom(db, local, clusterId, candidate);
          low = candidate;
          break;
        } catch {
        }
      }
      for (const candidate of [...members].reverse()) {
        if (candidate === low) break;
        try {
          await pullFrom(db, local, clusterId, candidate);
          break;
        } catch {
        }
      }
    }
  } finally {
    pulling = false;
  }
}
export {
  acceptEnvelopes,
  ensureHubSchema,
  flushHubDeliveries,
  pullFromHubs,
  receiveRelay,
  relayPage,
  relayPullSchema,
  relayRequestSchema
};
