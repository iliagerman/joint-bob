import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDifficultyClassifier } from "./classifiers/registry.js";
import { listTwinUpdateTargets } from "./twin-updates.js";
import { listSharingClusterMembers, listSharingMemberships } from "./cluster-sharing-policy.js";
import { defaultRoutingPolicy, routingPolicySchema, readRoutingPolicy, routingPolicyDatabase } from "./routing-policy.js";
const DEFAULT_ROUTING_CONFIG_ID = "00000000-0000-4000-8000-000000000001";
function defaultRoutingConfig() {
  return {
    id: DEFAULT_ROUTING_CONFIG_ID,
    name: "Joint Bob default",
    policy: defaultRoutingPolicy(),
    ownerNodeId: "joint-bob",
    shared: false,
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
class RoutingConfigError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
  statusCode;
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/i;
const DELIVERY_COLUMNS = `id INTEGER PRIMARY KEY AUTOINCREMENT, config_id TEXT NOT NULL, event_id TEXT NOT NULL, event TEXT NOT NULL, target_kind TEXT NOT NULL CHECK(target_kind IN ('cluster','twin')), target_node_id TEXT NOT NULL, target_url TEXT NOT NULL, target_name TEXT NOT NULL, cluster_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL, UNIQUE(target_node_id, config_id)`;
function ensureRoutingConfigSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS routing_configs(id TEXT PRIMARY KEY, name TEXT NOT NULL, policy TEXT NOT NULL, owner_node_id TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS routing_config_selection(singleton INTEGER PRIMARY KEY CHECK(singleton=1), config_id TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS routing_config_inbox(event_id TEXT PRIMARY KEY, origin_node_id TEXT NOT NULL, received_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS routing_config_tombstones(config_id TEXT PRIMARY KEY, owner_node_id TEXT NOT NULL, revision INTEGER NOT NULL, deleted_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS routing_config_deliveries(${DELIVERY_COLUMNS});
CREATE TABLE IF NOT EXISTS routing_config_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const deliveries = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='routing_config_deliveries'").get();
  if (!deliveries.sql.includes("'twin'")) {
    db.exec(`SAVEPOINT routing_delivery_kinds;
CREATE TABLE routing_config_deliveries_next(${DELIVERY_COLUMNS});
INSERT INTO routing_config_deliveries_next SELECT id, config_id, event_id, event, 'cluster', target_node_id, target_url, target_name, cluster_id, attempts, next_attempt_at, last_error, created_at FROM routing_config_deliveries;
DROP TABLE routing_config_deliveries;
ALTER TABLE routing_config_deliveries_next RENAME TO routing_config_deliveries;
RELEASE routing_delivery_kinds;`);
  }
}
function assertConfigName(name) {
  if (!name.trim() || name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error("Routing configuration name must be between 1 and 80 characters without control characters");
}
function rowToConfig(row) {
  return { id: row.id, name: row.name, policy: routingPolicySchema.parse(JSON.parse(row.policy)), ownerNodeId: row.owner_node_id, shared: row.shared === 1, revision: row.revision, updatedAt: row.updated_at };
}
function listRoutingConfigs(db) {
  ensureRoutingConfigSchema(db);
  return db.prepare("SELECT id,name,policy,owner_node_id,shared,revision,updated_at FROM routing_configs ORDER BY name, id").all().map(rowToConfig);
}
function getRoutingConfig(db, id) {
  ensureRoutingConfigSchema(db);
  if (!UUID_PATTERN.test(id)) return null;
  const row = db.prepare("SELECT id,name,policy,owner_node_id,shared,revision,updated_at FROM routing_configs WHERE id = ?").get(id);
  return row ? rowToConfig(row) : null;
}
function insertConfigRow(db, config) {
  db.prepare("INSERT INTO routing_configs(id,name,policy,owner_node_id,shared,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,policy=excluded.policy,owner_node_id=excluded.owner_node_id,shared=excluded.shared,revision=excluded.revision,updated_at=excluded.updated_at").run(config.id, config.name, JSON.stringify(config.policy), config.ownerNodeId, config.shared ? 1 : 0, config.revision, config.updatedAt, config.updatedAt);
}
function createRoutingConfig(db, localNodeId, name, policy) {
  ensureRoutingConfigSchema(db);
  assertConfigName(name);
  const config = { id: randomUUID(), name: name.trim(), policy, ownerNodeId: localNodeId, shared: false, revision: 1, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  db.exec("BEGIN IMMEDIATE");
  try {
    insertConfigRow(db, config);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return config;
}
function updateRoutingConfig(db, localNodeId, id, changes) {
  ensureRoutingConfigSchema(db);
  const existing = getRoutingConfig(db, id);
  if (!existing) throw new RoutingConfigError(404, "Routing configuration not found");
  if (existing.ownerNodeId !== localNodeId) throw new RoutingConfigError(403, "Only the node that created this configuration can change it");
  const updated = {
    ...existing,
    ...changes.name === void 0 ? {} : (() => {
      assertConfigName(changes.name);
      return { name: changes.name.trim() };
    })(),
    ...changes.policy === void 0 ? {} : { policy: changes.policy },
    revision: existing.revision + 1,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    insertConfigRow(db, updated);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return updated;
}
function deleteRoutingConfig(db, localNodeId, id) {
  ensureRoutingConfigSchema(db);
  const existing = getRoutingConfig(db, id);
  if (!existing) throw new RoutingConfigError(404, "Routing configuration not found");
  if (existing.ownerNodeId !== localNodeId) throw new RoutingConfigError(403, "Only the node that created this configuration can delete it");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM routing_configs WHERE id = ?").run(id);
    db.prepare("DELETE FROM routing_config_deliveries WHERE config_id = ?").run(id);
    db.prepare("INSERT INTO routing_config_tombstones(config_id, owner_node_id, revision, deleted_at) VALUES (?,?,?,?) ON CONFLICT(config_id) DO UPDATE SET revision=MAX(routing_config_tombstones.revision, excluded.revision), deleted_at=excluded.deleted_at").run(id, existing.ownerNodeId, existing.revision, (/* @__PURE__ */ new Date()).toISOString());
    if (selectedRoutingConfigId(db) === id) setRoutingConfigSelection(db, "");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function selectedRoutingConfigId(db) {
  ensureRoutingConfigSchema(db);
  return db.prepare("SELECT config_id FROM routing_config_selection WHERE singleton = 1").get()?.config_id ?? "";
}
function setRoutingConfigSelection(db, configId) {
  ensureRoutingConfigSchema(db);
  if (configId !== "" && configId !== DEFAULT_ROUTING_CONFIG_ID && !getRoutingConfig(db, configId)) throw new RoutingConfigError(404, "Routing configuration not found");
  db.prepare("INSERT INTO routing_config_selection(singleton, config_id) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET config_id = excluded.config_id").run(configId);
}
function activeRoutingConfig(db) {
  ensureRoutingConfigSchema(db);
  const selected = selectedRoutingConfigId(db);
  if (!selected) return null;
  if (selected === DEFAULT_ROUTING_CONFIG_ID) return defaultRoutingConfig();
  const config = getRoutingConfig(db, selected);
  if (!config) {
    setRoutingConfigSelection(db, "");
    return null;
  }
  return config.policy.enabled ? config : null;
}
function routingConfigWarning(config) {
  return getDifficultyClassifier(config.policy.classifierId) ? null : `Routing configuration "${config.name}" uses classifier ${config.policy.classifierId}, which is not installed on this node. Prompts keep each conversation's current model.`;
}
const routingConfigEventSchema = z.object({
  id: z.string().uuid(),
  configId: z.string().uuid(),
  operation: z.enum(["upsert", "delete"]),
  name: z.string().trim().min(1).max(80).optional(),
  policy: routingPolicySchema.optional(),
  revision: z.number().int().positive(),
  updatedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "updatedAt must be an ISO timestamp"),
  ownerNodeId: z.string().min(1)
}).strict().superRefine((value, context) => {
  if (value.operation === "upsert" && (value.name === void 0 || value.policy === void 0)) context.addIssue({ code: z.ZodIssueCode.custom, message: "An upsert needs a name and a policy" });
  if (value.operation === "delete" && (value.name !== void 0 || value.policy !== void 0)) context.addIssue({ code: z.ZodIssueCode.custom, message: "A delete carries no name or policy" });
});
function routingConfigEventFor(config, operation = "upsert") {
  return routingConfigEventSchema.parse({
    id: randomUUID(),
    configId: config.id,
    operation,
    ...operation === "upsert" ? { name: config.name, policy: config.policy } : {},
    revision: config.revision,
    updatedAt: config.updatedAt,
    ownerNodeId: config.ownerNodeId
  });
}
function tombstone(db, configId) {
  const row = db.prepare("SELECT owner_node_id, revision FROM routing_config_tombstones WHERE config_id = ?").get(configId);
  return row ?? null;
}
function applyRoutingConfigEvents(db, events, senderNodeId) {
  for (const event of events) routingConfigEventSchema.parse(event);
  ensureRoutingConfigSchema(db);
  const received = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const inbox = db.prepare("INSERT OR IGNORE INTO routing_config_inbox(event_id, origin_node_id, received_at) VALUES (?, ?, ?)");
    for (const event of events) {
      if (event.ownerNodeId !== senderNodeId) throw new RoutingConfigError(403, `Only the owner may distribute routing configuration ${event.configId}`);
      if (!inbox.run(event.id, senderNodeId, (/* @__PURE__ */ new Date()).toISOString()).changes) {
        received.push(event.id);
        continue;
      }
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
          db.prepare("INSERT INTO routing_config_tombstones(config_id, owner_node_id, revision, deleted_at) VALUES (?,?,?,?) ON CONFLICT(config_id) DO UPDATE SET revision=MAX(routing_config_tombstones.revision, excluded.revision), deleted_at=excluded.deleted_at").run(event.configId, event.ownerNodeId, event.revision, (/* @__PURE__ */ new Date()).toISOString());
        }
      } else if ((!grave || event.revision > grave.revision) && (!existing || event.revision > existing.revision || event.revision === existing.revision && event.updatedAt > existing.updatedAt)) {
        insertConfigRow(db, { id: event.configId, name: event.name, policy: event.policy, ownerNodeId: event.ownerNodeId, shared: true, revision: event.revision, updatedAt: event.updatedAt });
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
function routingConfigShareTargets(db, localNodeId) {
  ensureRoutingConfigSchema(db);
  const targets = /* @__PURE__ */ new Map();
  for (const membership of listSharingMemberships(db, localNodeId)) {
    for (const member of listSharingClusterMembers(db, membership.clusterId)) {
      if (member.nodeId === localNodeId || targets.has(member.nodeId)) continue;
      const descriptor = db.prepare("SELECT name, url FROM cluster_v2_membership_nodes WHERE cluster_id = ? AND node_id = ?").get(membership.clusterId, member.nodeId);
      if (!descriptor) continue;
      const clusterName = db.prepare("SELECT name FROM sharing_clusters WHERE id = ?").get(membership.clusterId)?.name;
      targets.set(member.nodeId, { nodeId: member.nodeId, name: descriptor.name, url: descriptor.url, kind: "cluster", clusterId: membership.clusterId, ...clusterName ? { clusterName } : {} });
    }
  }
  for (const twin of listTwinUpdateTargets(db, localNodeId)) {
    if (!targets.has(twin.nodeId)) targets.set(twin.nodeId, { nodeId: twin.nodeId, name: twin.name, url: twin.url, kind: "twin", relationshipId: twin.relationshipId });
  }
  return [...targets.values()];
}
function currentRoutingConfigTarget(db, localNodeId, targetNodeId) {
  return routingConfigShareTargets(db, localNodeId).find((target) => target.nodeId === targetNodeId) ?? null;
}
function enqueueRoutingConfigDeliveries(db, event, targets) {
  ensureRoutingConfigSchema(db);
  const now = (/* @__PURE__ */ new Date()).toISOString();
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
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function dropRoutingConfigDelivery(db, id) {
  db.prepare("DELETE FROM routing_config_deliveries WHERE id = ?").run(id);
}
function recordRoutingConfigDeliveryFailure(db, id, attempts, message, now = /* @__PURE__ */ new Date()) {
  db.prepare("UPDATE routing_config_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?").run(attempts, new Date(now.getTime() + Math.min(3600, 2 ** Math.min(attempts, 12)) * 1e3).toISOString(), message.slice(0, 300), id);
}
function recordRoutingConfigDeliverySuccess(db, id) {
  db.prepare("DELETE FROM routing_config_deliveries WHERE id = ?").run(id);
}
function dueRoutingConfigDeliveries(db, now = /* @__PURE__ */ new Date(), configId) {
  ensureRoutingConfigSchema(db);
  const scoped = configId !== void 0;
  const sql = `SELECT id, config_id, event, target_kind, target_node_id, target_url, target_name, cluster_id, attempts, next_attempt_at FROM routing_config_deliveries WHERE next_attempt_at <= ?${scoped ? " AND config_id = ?" : ""} ORDER BY created_at, id LIMIT 50`;
  const rows = db.prepare(sql).all(...scoped ? [now.toISOString(), configId] : [now.toISOString()]);
  return rows.map((row) => ({ id: row.id, configId: row.config_id, event: routingConfigEventSchema.parse(JSON.parse(row.event)), kind: row.target_kind, nodeId: row.target_node_id, url: row.target_url, name: row.target_name, clusterId: row.cluster_id, attempts: row.attempts, nextAttemptAt: row.next_attempt_at }));
}
function pendingRoutingConfigDeliveryCount(db, configId) {
  ensureRoutingConfigSchema(db);
  const row = configId === void 0 ? db.prepare("SELECT count(*) AS count FROM routing_config_deliveries").get() : db.prepare("SELECT count(*) AS count FROM routing_config_deliveries WHERE config_id = ?").get(configId);
  return row.count;
}
function migrateRoutingConfigs(db, localNodeId) {
  ensureRoutingConfigSchema(db);
  if (db.prepare("SELECT 1 FROM routing_config_meta WHERE key = 'migrated'").get()) return 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const hasPolicies = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cluster_routing_policies'").get());
    const policies = hasPolicies ? db.prepare("SELECT cluster_id FROM cluster_routing_policies ORDER BY cluster_id").all().map((row) => readRoutingPolicy(db, row.cluster_id)).filter((stored) => Boolean(stored)) : [];
    const created = [];
    for (const stored of policies) {
      const legacy = stored.clusterId === "";
      const clusterName = legacy ? null : db.prepare("SELECT name FROM sharing_clusters WHERE id = ?").get(stored.clusterId)?.name;
      const config = { id: randomUUID(), name: legacy ? "Migrated cluster routing" : `Migrated "${clusterName ?? "cluster"}" routing`, policy: stored.policy, ownerNodeId: localNodeId, shared: false, revision: stored.revision, updatedAt: stored.updatedAt };
      insertConfigRow(db, config);
      created.push({ config, legacy, clusterId: stored.clusterId, enabled: stored.policy.enabled });
    }
    const effective = created.filter((entry) => !entry.legacy && entry.enabled).sort((left, right) => left.clusterId.localeCompare(right.clusterId))[0] ?? created.find((entry) => entry.legacy && entry.enabled);
    setRoutingConfigSelection(db, effective?.config.id ?? "");
    if (hasPolicies) {
      db.exec("DELETE FROM cluster_routing_policies; DELETE FROM cluster_routing_pending; DELETE FROM cluster_v2_routing_deliveries;");
    }
    db.prepare("INSERT INTO routing_config_meta(key, value) VALUES ('migrated', ?)").run((/* @__PURE__ */ new Date()).toISOString());
    db.exec("COMMIT");
    return created.length;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
let migrated = false;
function routingConfigDatabase() {
  const db = routingPolicyDatabase();
  ensureRoutingConfigSchema(db);
  if (!migrated) {
    const hasNode = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cluster_node'").get());
    const local = hasNode ? db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get()?.id : void 0;
    if (local) {
      migrateRoutingConfigs(db, local);
      migrated = true;
    }
  }
  return db;
}
export {
  DEFAULT_ROUTING_CONFIG_ID,
  RoutingConfigError,
  activeRoutingConfig,
  applyRoutingConfigEvents,
  createRoutingConfig,
  currentRoutingConfigTarget,
  defaultRoutingConfig,
  deleteRoutingConfig,
  dropRoutingConfigDelivery,
  dueRoutingConfigDeliveries,
  enqueueRoutingConfigDeliveries,
  ensureRoutingConfigSchema,
  getRoutingConfig,
  listRoutingConfigs,
  migrateRoutingConfigs,
  pendingRoutingConfigDeliveryCount,
  recordRoutingConfigDeliveryFailure,
  recordRoutingConfigDeliverySuccess,
  routingConfigDatabase,
  routingConfigEventFor,
  routingConfigEventSchema,
  routingConfigShareTargets,
  routingConfigWarning,
  selectedRoutingConfigId,
  setRoutingConfigSelection,
  updateRoutingConfig
};
