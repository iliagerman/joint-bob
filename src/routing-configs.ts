import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getDifficultyClassifier } from "./classifiers/registry.js";
import { listSharingClusterMembers, listSharingMemberships } from "./cluster-sharing-policy.js";
import { selectiveSharingActiveInDatabase } from "./cluster-v2-mode-state.js";
import { routingPolicySchema, readRoutingPolicy, routingPolicyDatabase, type RoutingPolicy } from "./routing-policy.js";

/** Named classifier/routing configurations, modelled on secret accounts: each node
    keeps any number of named configurations, defaults to local-only storage, and
    independently selects the one that drives prompt routing here. Sharing copies a
    configuration to the eligible nodes of every cluster this node belongs to (and to
    legacy paired peers) without ever touching the receiver's own selection. */
export interface StoredRoutingConfig {
  id: string;
  name: string;
  policy: RoutingPolicy;
  ownerNodeId: string;
  shared: boolean;
  revision: number;
  updatedAt: string;
}

export interface RoutingConfigShareTarget {
  nodeId: string;
  name: string;
  url: string;
  /** `legacy` peers authenticate with the pairing token; `cluster` members use the signed v2 cluster protocol. */
  kind: "legacy" | "cluster";
  clusterId?: string;
  clusterName?: string;
}

/** A pending distribution step: the latest event for one configuration to one node. */
export interface PendingRoutingConfigDelivery {
  id: number;
  configId: string;
  event: RoutingConfigEvent;
  kind: "legacy" | "cluster";
  nodeId: string;
  url: string;
  name: string;
  clusterId: string | null;
  attempts: number;
  nextAttemptAt: string;
}

interface ConfigRow { id: string; name: string; policy: string; owner_node_id: string; shared: number; revision: number; updated_at: string }

export class RoutingConfigError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/i;

export function ensureRoutingConfigSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS routing_configs(id TEXT PRIMARY KEY, name TEXT NOT NULL, policy TEXT NOT NULL, owner_node_id TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS routing_config_selection(singleton INTEGER PRIMARY KEY CHECK(singleton=1), config_id TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS routing_config_inbox(event_id TEXT PRIMARY KEY, origin_node_id TEXT NOT NULL, received_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS routing_config_tombstones(config_id TEXT PRIMARY KEY, owner_node_id TEXT NOT NULL, revision INTEGER NOT NULL, deleted_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS routing_config_deliveries(id INTEGER PRIMARY KEY AUTOINCREMENT, config_id TEXT NOT NULL, event_id TEXT NOT NULL, event TEXT NOT NULL, target_kind TEXT NOT NULL CHECK(target_kind IN ('legacy','cluster')), target_node_id TEXT NOT NULL, target_url TEXT NOT NULL, target_name TEXT NOT NULL, cluster_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL, UNIQUE(target_node_id, config_id));
CREATE TABLE IF NOT EXISTS routing_config_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
}

function assertConfigName(name: string): void {
  if (!name.trim() || name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error("Routing configuration name must be between 1 and 80 characters without control characters");
}

function rowToConfig(row: ConfigRow): StoredRoutingConfig {
  return { id: row.id, name: row.name, policy: routingPolicySchema.parse(JSON.parse(row.policy)), ownerNodeId: row.owner_node_id, shared: row.shared === 1, revision: row.revision, updatedAt: row.updated_at };
}

export function listRoutingConfigs(db: DatabaseSync): StoredRoutingConfig[] {
  ensureRoutingConfigSchema(db);
  return (db.prepare("SELECT id,name,policy,owner_node_id,shared,revision,updated_at FROM routing_configs ORDER BY name, id").all() as unknown as ConfigRow[]).map(rowToConfig);
}

export function getRoutingConfig(db: DatabaseSync, id: string): StoredRoutingConfig | null {
  ensureRoutingConfigSchema(db);
  if (!UUID_PATTERN.test(id)) return null;
  const row = db.prepare("SELECT id,name,policy,owner_node_id,shared,revision,updated_at FROM routing_configs WHERE id = ?").get(id) as ConfigRow | undefined;
  return row ? rowToConfig(row) : null;
}

function insertConfigRow(db: DatabaseSync, config: StoredRoutingConfig): void {
  db.prepare("INSERT INTO routing_configs(id,name,policy,owner_node_id,shared,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,policy=excluded.policy,owner_node_id=excluded.owner_node_id,shared=excluded.shared,revision=excluded.revision,updated_at=excluded.updated_at")
    .run(config.id, config.name, JSON.stringify(config.policy), config.ownerNodeId, config.shared ? 1 : 0, config.revision, config.updatedAt, config.updatedAt);
}

/** Creates a local configuration. Sharing is a separate, explicit step. */
export function createRoutingConfig(db: DatabaseSync, localNodeId: string, name: string, policy: RoutingPolicy): StoredRoutingConfig {
  ensureRoutingConfigSchema(db);
  assertConfigName(name);
  const config: StoredRoutingConfig = { id: randomUUID(), name: name.trim(), policy, ownerNodeId: localNodeId, shared: false, revision: 1, updatedAt: new Date().toISOString() };
  db.exec("BEGIN IMMEDIATE");
  try {
    insertConfigRow(db, config);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return config;
}

/** Updates a configuration. Only the original owner may change a shared one; a local
    edit of someone else's shared copy is refused rather than forking silently. */
export function updateRoutingConfig(db: DatabaseSync, localNodeId: string, id: string, changes: { name?: string; policy?: RoutingPolicy }): StoredRoutingConfig {
  ensureRoutingConfigSchema(db);
  const existing = getRoutingConfig(db, id);
  if (!existing) throw new RoutingConfigError(404, "Routing configuration not found");
  if (existing.ownerNodeId !== localNodeId) throw new RoutingConfigError(403, "Only the node that created this configuration can change it");
  const updated: StoredRoutingConfig = {
    ...existing,
    ...(changes.name === undefined ? {} : (() => { assertConfigName(changes.name); return { name: changes.name.trim() }; })()),
    ...(changes.policy === undefined ? {} : { policy: changes.policy }),
    revision: existing.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    insertConfigRow(db, updated);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return updated;
}

/** Deletes a configuration; only the owner may delete. Deleting the selected one
    clears this node's selection, which is the only way a deletion ends a selection. */
export function deleteRoutingConfig(db: DatabaseSync, localNodeId: string, id: string): void {
  ensureRoutingConfigSchema(db);
  const existing = getRoutingConfig(db, id);
  if (!existing) throw new RoutingConfigError(404, "Routing configuration not found");
  if (existing.ownerNodeId !== localNodeId) throw new RoutingConfigError(403, "Only the node that created this configuration can delete it");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM routing_configs WHERE id = ?").run(id);
    db.prepare("DELETE FROM routing_config_deliveries WHERE config_id = ?").run(id);
    db.prepare("INSERT INTO routing_config_tombstones(config_id, owner_node_id, revision, deleted_at) VALUES (?,?,?,?) ON CONFLICT(config_id) DO UPDATE SET revision=MAX(routing_config_tombstones.revision, excluded.revision), deleted_at=excluded.deleted_at")
      .run(id, existing.ownerNodeId, existing.revision, new Date().toISOString());
    if (selectedRoutingConfigId(db) === id) setRoutingConfigSelection(db, "");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function selectedRoutingConfigId(db: DatabaseSync): string {
  ensureRoutingConfigSchema(db);
  return ((db.prepare("SELECT config_id FROM routing_config_selection WHERE singleton = 1").get() as { config_id: string } | undefined)?.config_id) ?? "";
}

/** Sets this node's active configuration. An empty id turns automatic routing off. */
export function setRoutingConfigSelection(db: DatabaseSync, configId: string): void {
  ensureRoutingConfigSchema(db);
  if (configId !== "" && !getRoutingConfig(db, configId)) throw new RoutingConfigError(404, "Routing configuration not found");
  db.prepare("INSERT INTO routing_config_selection(singleton, config_id) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET config_id = excluded.config_id").run(configId);
}

/** The configuration that drives routing on this node right now: the local selection,
    resolved independently of any cluster. A disabled or missing selection means no routing. */
export function activeRoutingConfig(db: DatabaseSync): StoredRoutingConfig | null {
  ensureRoutingConfigSchema(db);
  const selected = selectedRoutingConfigId(db);
  if (!selected) return null;
  const config = getRoutingConfig(db, selected);
  if (!config) {
    setRoutingConfigSelection(db, "");
    return null;
  }
  return config.policy.enabled ? config : null;
}

/** Warns when a configuration names a classifier this node does not have installed;
    routing then quietly keeps each conversation's current model. */
export function routingConfigWarning(config: StoredRoutingConfig): string | null {
  return getDifficultyClassifier(config.policy.classifierId) ? null : `Routing configuration "${config.name}" uses classifier ${config.policy.classifierId}, which is not installed on this node. Prompts keep each conversation's current model.`;
}

/** One sharing step: what a configuration looks like on the wire. A delete carries the
    revision it obsoletes, so a late-arriving older event can neither resurrect nor remove. */
export const routingConfigEventSchema = z.object({
  id: z.string().uuid(),
  configId: z.string().uuid(),
  operation: z.enum(["upsert", "delete"]),
  name: z.string().trim().min(1).max(80).optional(),
  policy: routingPolicySchema.optional(),
  revision: z.number().int().positive(),
  updatedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "updatedAt must be an ISO timestamp"),
  ownerNodeId: z.string().min(1),
}).strict().superRefine((value, context) => {
  if (value.operation === "upsert" && (value.name === undefined || value.policy === undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: "An upsert needs a name and a policy" });
  if (value.operation === "delete" && (value.name !== undefined || value.policy !== undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: "A delete carries no name or policy" });
});
export type RoutingConfigEvent = z.infer<typeof routingConfigEventSchema>;

export function routingConfigEventFor(config: StoredRoutingConfig, operation: "upsert" | "delete" = "upsert"): RoutingConfigEvent {
  return routingConfigEventSchema.parse({
    id: randomUUID(), configId: config.id, operation,
    ...(operation === "upsert" ? { name: config.name, policy: config.policy } : {}),
    revision: config.revision, updatedAt: config.updatedAt, ownerNodeId: config.ownerNodeId,
  });
}

interface TombstoneRow { owner_node_id: string; revision: number }

function tombstone(db: DatabaseSync, configId: string): TombstoneRow | null {
  const row = db.prepare("SELECT owner_node_id, revision FROM routing_config_tombstones WHERE config_id = ?").get(configId) as unknown as TombstoneRow | undefined;
  return row ?? null;
}

/** Applies events pushed by a peer. The sender must be the configuration's original
    owner and an authenticated, eligible peer (checked by the transport routes). Events
    converge on the owner's revision with durable tombstones, so a delayed delete cannot
    remove a newer configuration and a delayed upsert cannot resurrect a deleted one. The
    local selection is never changed by an arriving share — except that deleting the
    selected configuration necessarily ends it. */
export function applyRoutingConfigEvents(db: DatabaseSync, events: RoutingConfigEvent[], senderNodeId: string): string[] {
  for (const event of events) routingConfigEventSchema.parse(event);
  ensureRoutingConfigSchema(db);
  const received: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const inbox = db.prepare("INSERT OR IGNORE INTO routing_config_inbox(event_id, origin_node_id, received_at) VALUES (?, ?, ?)");
    for (const event of events) {
      if (event.ownerNodeId !== senderNodeId) throw new RoutingConfigError(403, `Only the owner may distribute routing configuration ${event.configId}`);
      if (!inbox.run(event.id, senderNodeId, new Date().toISOString()).changes) { received.push(event.id); continue; }
      const existing = getRoutingConfig(db, event.configId);
      if (existing && existing.ownerNodeId !== event.ownerNodeId) throw new RoutingConfigError(403, `Routing configuration ${event.configId} is owned by another node`);
      const grave = tombstone(db, event.configId);
      if (grave && grave.owner_node_id !== event.ownerNodeId) throw new RoutingConfigError(403, `Routing configuration ${event.configId} is owned by another node`);
      if (event.operation === "delete") {
        if ((!existing || event.revision >= existing.revision) && (!grave || event.revision >= grave.revision)) {
          if (existing) {
            db.prepare("DELETE FROM routing_configs WHERE id = ?").run(event.configId);
            if (selectedRoutingConfigId(db) === event.configId) setRoutingConfigSelection(db, "");
          }
          db.prepare("INSERT INTO routing_config_tombstones(config_id, owner_node_id, revision, deleted_at) VALUES (?,?,?,?) ON CONFLICT(config_id) DO UPDATE SET revision=MAX(routing_config_tombstones.revision, excluded.revision), deleted_at=excluded.deleted_at")
            .run(event.configId, event.ownerNodeId, event.revision, new Date().toISOString());
        }
      } else if ((!grave || event.revision > grave.revision) && (!existing || event.revision > existing.revision || (event.revision === existing.revision && event.updatedAt > existing.updatedAt))) {
        // The policy is schema-checked only: classifier and model availability differ per node,
        // and a receiver without them keeps the configuration with a warning instead of rejecting it.
        insertConfigRow(db, { id: event.configId, name: event.name!, policy: event.policy!, ownerNodeId: event.ownerNodeId, shared: true, revision: event.revision, updatedAt: event.updatedAt });
      }
      received.push(event.id);
    }
    db.exec("COMMIT");
    return received;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** The nodes a shared configuration may be distributed to right now: legacy paired
    peers, or — when selective sharing is active — every member of every cluster this
    node belongs to. Membership decides eligibility; nothing propagates beyond it. */
export function routingConfigShareTargets(db: DatabaseSync, localNodeId: string, legacyPeers: Array<{ id: string; name: string; url: string }>): RoutingConfigShareTarget[] {
  ensureRoutingConfigSchema(db);
  if (selectiveSharingActiveInDatabase(db)) {
    const targets = new Map<string, RoutingConfigShareTarget>();
    for (const membership of listSharingMemberships(db, localNodeId)) {
      for (const member of listSharingClusterMembers(db, membership.clusterId)) {
        if (member.nodeId === localNodeId || targets.has(member.nodeId)) continue;
        const descriptor = db.prepare("SELECT name, url FROM cluster_v2_membership_nodes WHERE cluster_id = ? AND node_id = ?").get(membership.clusterId, member.nodeId) as { name: string; url: string } | undefined;
        if (!descriptor) continue;
        const clusterName = (db.prepare("SELECT name FROM sharing_clusters WHERE id = ?").get(membership.clusterId) as { name: string } | undefined)?.name;
        targets.set(member.nodeId, { nodeId: member.nodeId, name: descriptor.name, url: descriptor.url, kind: "cluster", clusterId: membership.clusterId, ...(clusterName ? { clusterName } : {}) });
      }
    }
    return [...targets.values()];
  }
  return legacyPeers.map((peer) => ({ nodeId: peer.id, name: peer.name, url: peer.url, kind: "legacy" as const }));
}

/** Re-resolves a pending delivery's target against current eligibility: the peer
    must still be reachable through a current cluster membership (or legacy pairing) —
    never merely through the cluster the delivery was originally enrolled under. A
    peer that left one shared cluster but remains in another stays eligible through
    that one, and a legacy pending stops transmitting once selective mode is active. */
export function currentRoutingConfigTarget(db: DatabaseSync, localNodeId: string, legacyPeers: Array<{ id: string; name: string; url: string }>, targetNodeId: string): RoutingConfigShareTarget | null {
  return routingConfigShareTargets(db, localNodeId, legacyPeers).find((target) => target.nodeId === targetNodeId) ?? null;
}

/** Enrols the latest event of one configuration for delivery to the given targets.
    Offline receivers keep their pending row — the flush retries with backoff — and a
    newer event for the same configuration and target replaces the older pending one. */
export function enqueueRoutingConfigDeliveries(db: DatabaseSync, event: RoutingConfigEvent, targets: RoutingConfigShareTarget[]): number {
  ensureRoutingConfigSchema(db);
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const clear = db.prepare("DELETE FROM routing_config_deliveries WHERE target_node_id = ? AND config_id = ? AND event_id <> ?");
    const insert = db.prepare("INSERT OR IGNORE INTO routing_config_deliveries(config_id, event_id, event, target_kind, target_node_id, target_url, target_name, cluster_id, attempts, next_attempt_at, created_at) VALUES (?,?,?,?,?,?,?,?,0,?,?)");
    let enrolled = 0;
    for (const target of targets) {
      clear.run(target.nodeId, event.configId, event.id);
      enrolled += Number(insert.run(event.configId, event.id, JSON.stringify(event), target.kind, target.nodeId, target.url, target.name, target.clusterId ?? null, now, now).changes);
    }
    db.exec("COMMIT");
    return enrolled;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** Drops a pending delivery: used when the target is no longer an eligible member,
    so a departed node stops receiving updates the moment membership is revoked. */
export function dropRoutingConfigDelivery(db: DatabaseSync, id: number): void {
  db.prepare("DELETE FROM routing_config_deliveries WHERE id = ?").run(id);
}

/** Records a delivery outcome: success clears the row, failure keeps it with backoff. */
export function recordRoutingConfigDeliveryFailure(db: DatabaseSync, id: number, attempts: number, message: string, now = new Date()): void {
  db.prepare("UPDATE routing_config_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?").run(attempts, new Date(now.getTime() + Math.min(3600, 2 ** Math.min(attempts, 12)) * 1000).toISOString(), message.slice(0, 300), id);
}

/** Records a successful delivery by clearing its pending row. */
export function recordRoutingConfigDeliverySuccess(db: DatabaseSync, id: number): void {
  db.prepare("DELETE FROM routing_config_deliveries WHERE id = ?").run(id);
}

/** The deliveries whose retry time has come, oldest first. With a configuration id
    the query stays scoped to that configuration, so one share's result reporting
    cannot absorb another configuration's retry outcomes. */
export function dueRoutingConfigDeliveries(db: DatabaseSync, now = new Date(), configId?: string): PendingRoutingConfigDelivery[] {
  ensureRoutingConfigSchema(db);
  const scoped = configId !== undefined;
  const sql = `SELECT id, config_id, event, target_kind, target_node_id, target_url, target_name, cluster_id, attempts, next_attempt_at FROM routing_config_deliveries WHERE next_attempt_at <= ?${scoped ? " AND config_id = ?" : ""} ORDER BY created_at, id LIMIT 50`;
  const rows = db.prepare(sql).all(...(scoped ? [now.toISOString(), configId] : [now.toISOString()])) as unknown as Array<{ id: number; config_id: string; event: string; target_kind: "legacy" | "cluster"; target_node_id: string; target_url: string; target_name: string; cluster_id: string | null; attempts: number; next_attempt_at: string }>;
  return rows.map((row) => ({ id: row.id, configId: row.config_id, event: routingConfigEventSchema.parse(JSON.parse(row.event)), kind: row.target_kind, nodeId: row.target_node_id, url: row.target_url, name: row.target_name, clusterId: row.cluster_id, attempts: row.attempts, nextAttemptAt: row.next_attempt_at }));
}

/** Pending deliveries for one configuration, or across all of them. */
export function pendingRoutingConfigDeliveryCount(db: DatabaseSync, configId?: string): number {
  ensureRoutingConfigSchema(db);
  const row = configId === undefined
    ? db.prepare("SELECT count(*) AS count FROM routing_config_deliveries").get() as { count: number }
    : db.prepare("SELECT count(*) AS count FROM routing_config_deliveries WHERE config_id = ?").get(configId) as { count: number };
  return row.count;
}

/** One-shot, transaction-atomic conversion of the retired per-cluster routing policies
    into named configurations. Every node converts its own copy into a configuration it
    owns locally and that is not implicitly shared: the old cluster-wide policy had no
    identity shared across nodes, so pretending otherwise would leave every node holding
    an uneditable orphan of a different ID. The previously effective policy is selected,
    so routing behaviour is preserved; the others become selectable local copies.

    The old resolution was: the enabled legacy policy everywhere, or the enabled policy
    of the lowest-ID selective cluster. When several cluster policies existed at once,
    that rule picked one silently — the migration keeps every copy and names the cluster
    it came from, so the ambiguity is visible and reversible instead of hidden. */
export function migrateRoutingConfigs(db: DatabaseSync, localNodeId: string): number {
  ensureRoutingConfigSchema(db);
  if (db.prepare("SELECT 1 FROM routing_config_meta WHERE key = 'migrated'").get()) return 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const hasPolicies = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cluster_routing_policies'").get());
    const policies = hasPolicies
      ? (db.prepare("SELECT cluster_id FROM cluster_routing_policies ORDER BY cluster_id").all() as unknown as Array<{ cluster_id: string }>)
        .map((row) => readRoutingPolicy(db, row.cluster_id))
        .filter((stored): stored is NonNullable<typeof stored> => Boolean(stored))
      : [];
    const created: Array<{ config: StoredRoutingConfig; legacy: boolean; clusterId: string; enabled: boolean }> = [];
    for (const stored of policies) {
      const legacy = stored.clusterId === "";
      const clusterName = legacy ? null : (db.prepare("SELECT name FROM sharing_clusters WHERE id = ?").get(stored.clusterId) as { name: string } | undefined)?.name;
      const config: StoredRoutingConfig = { id: randomUUID(), name: legacy ? "Migrated cluster routing" : `Migrated "${clusterName ?? "cluster"}" routing`, policy: stored.policy, ownerNodeId: localNodeId, shared: false, revision: stored.revision, updatedAt: stored.updatedAt };
      insertConfigRow(db, config);
      created.push({ config, legacy, clusterId: stored.clusterId, enabled: stored.policy.enabled });
    }
    const effective = selectiveSharingActiveInDatabase(db)
      ? created.filter((entry) => !entry.legacy && entry.enabled).sort((left, right) => left.clusterId.localeCompare(right.clusterId))[0]
      : created.find((entry) => entry.legacy && entry.enabled);
    setRoutingConfigSelection(db, effective?.config.id ?? "");
    if (hasPolicies) {
      db.exec("DELETE FROM cluster_routing_policies; DELETE FROM cluster_routing_pending; DELETE FROM cluster_v2_routing_deliveries;");
    }
    db.prepare("INSERT INTO routing_config_meta(key, value) VALUES ('migrated', ?)").run(new Date().toISOString());
    db.exec("COMMIT");
    return created.length;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

let migrated = false;

/** The node-local handle for routing configurations, migrated once from the old store. */
export function routingConfigDatabase(): DatabaseSync {
  const db = routingPolicyDatabase();
  ensureRoutingConfigSchema(db);
  if (!migrated) {
    const hasNode = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cluster_node'").get());
    const local = hasNode ? (db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get() as { id: string } | undefined)?.id : undefined;
    // Without a node identity yet the conversion waits; the marker is only set once it ran.
    if (local) {
      migrateRoutingConfigs(db, local);
      migrated = true;
    }
  }
  return db;
}
