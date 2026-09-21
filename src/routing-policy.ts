import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getDifficultyClassifier, listDifficultyClassifiers } from "./classifiers/registry.js";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { resolveDataDirectory } from "./data-directory.js";
import { enqueueReplicationEvent, type ReplicationEvent } from "./replication.js";
import { resourceClusterIds } from "./cluster-sharing-policy.js";
import { selectiveSharingActiveInDatabase } from "./cluster-v2-mode-state.js";

/** The routing policy of the implicit legacy cluster, where every peer sees every project. */
export const LEGACY_CLUSTER_ID = "";
export const ROUTING_LEVELS = 10;

const levelKeys = Array.from({ length: ROUTING_LEVELS }, (_, index) => String(index + 1));

export const routingMappingSchema = z.object({
  provider: z.string().trim().min(1).max(200).optional(),
  modelId: z.string().trim().min(1).max(300),
  thinkingLevel: z.string().trim().min(1).max(16),
}).strict();
export type RoutingMapping = z.infer<typeof routingMappingSchema>;

export const routingCadenceSchema = z.object({
  mode: z.enum(["first-message", "every-n"]),
  n: z.number().int().min(1).max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === "every-n" && value.n === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "Every-n cadence requires n" });
  if (value.mode === "first-message" && value.n !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "First-message cadence cannot carry n" });
});

export const routingPolicySchema = z.object({
  enabled: z.boolean(),
  classifierId: z.string().trim().min(1).max(80),
  /** Free-text calibration the classifier embeds into its question, for example
      what the easiest and hardest work looks like on this cluster. */
  instructions: z.string().trim().max(4000).optional(),
  evalCadence: routingCadenceSchema,
  confidenceThreshold: z.number().min(0).max(1),
  harnesses: z.record(z.string().trim().min(1).max(80), z.object({
    levels: z.record(z.string().trim().regex(/^(10|[1-9])$/), routingMappingSchema.nullable()),
  }).strict()),
}).strict();
export type RoutingPolicy = z.infer<typeof routingPolicySchema>;

export interface StoredRoutingPolicy {
  clusterId: string;
  policy: RoutingPolicy;
  revision: number;
  leaderNodeId: string;
  updatedBy: string;
  updatedAt: string;
}

export class RoutingPolicyError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

interface PolicyRow { cluster_id: string; policy: string; revision: number; leader_node_id: string; updated_by: string; updated_at: string }

let database: DatabaseSync | undefined;

export function ensureRoutingPolicySchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_routing_policies(cluster_id TEXT PRIMARY KEY, policy TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), leader_node_id TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL DEFAULT '')`);
}

export function routingPolicyDatabase(): DatabaseSync {
  if (database) return database;
  const directory = resolveDataDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, "node.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensureRoutingPolicySchema(db);
  database = db;
  return db;
}

/** Validates a policy against the registered harnesses and classifiers on this node. */
export function validateRoutingPolicy(policy: unknown): RoutingPolicy {
  const parsed = routingPolicySchema.parse(policy);
  if (!getDifficultyClassifier(parsed.classifierId)) throw new RoutingPolicyError(400, `Unknown classifier: ${parsed.classifierId}`);
  for (const adapter of listDiscoveredHarnesses()) {
    const entry = parsed.harnesses[adapter.id];
    if (!entry) continue;
    for (const level of levelKeys) {
      const mapping = entry.levels[level];
      if (!mapping) continue;
      if (adapter.configuration?.fixedProvider && mapping.provider !== undefined && mapping.provider !== adapter.configuration.fixedProvider) {
        throw new RoutingPolicyError(400, `${adapter.label} models must use provider ${adapter.configuration.fixedProvider}`);
      }
      if (!adapter.configuration?.fixedProvider && !mapping.provider) throw new RoutingPolicyError(400, `${adapter.label} level ${level} mapping needs a provider`);
      if (adapter.configuration && !adapter.configuration.thinkingLevels.includes(mapping.thinkingLevel as never)) {
        throw new RoutingPolicyError(400, `${adapter.label} does not support thinking level ${mapping.thinkingLevel}`);
      }
    }
  }
  for (const harnessId of Object.keys(parsed.harnesses)) {
    if (!listDiscoveredHarnesses().some((adapter) => adapter.id === harnessId)) throw new RoutingPolicyError(400, `Unknown harness: ${harnessId}`);
  }
  return parsed;
}

function rowToStored(row: PolicyRow): StoredRoutingPolicy {
  return { clusterId: row.cluster_id, policy: routingPolicySchema.parse(JSON.parse(row.policy)), revision: row.revision, leaderNodeId: row.leader_node_id, updatedBy: row.updated_by, updatedAt: row.updated_at };
}

export function readRoutingPolicy(db: DatabaseSync, clusterId: string): StoredRoutingPolicy | null {
  const row = db.prepare("SELECT cluster_id,policy,revision,leader_node_id,updated_by,updated_at FROM cluster_routing_policies WHERE cluster_id = ?").get(clusterId) as PolicyRow | undefined;
  return row ? rowToStored(row) : null;
}

/** Whether the local node may edit this stored policy: the v2 cluster manager, or
    the legacy policy's leader. */
export function routingPolicyEditableBy(db: DatabaseSync, stored: StoredRoutingPolicy, localNodeId: string): boolean {
  if (stored.clusterId !== LEGACY_CLUSTER_ID) {
    const row = db.prepare("SELECT manager_node_id FROM sharing_clusters WHERE id = ?").get(stored.clusterId) as { manager_node_id: string | null } | undefined;
    return row?.manager_node_id === localNodeId;
  }
  return stored.leaderNodeId === localNodeId;
}

export function listRoutingPolicies(db: DatabaseSync): StoredRoutingPolicy[] {
  return (db.prepare("SELECT cluster_id,policy,revision,leader_node_id,updated_by,updated_at FROM cluster_routing_policies ORDER BY cluster_id").all() as unknown as PolicyRow[]).map(rowToStored);
}

function localNodeId(db: DatabaseSync): string | undefined {
  return (db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get() as { id: string } | undefined)?.id;
}

function requiresClusterManager(db: DatabaseSync, clusterId: string, actorNodeId: string): string {
  // In v2 selective sharing the manager node is the leader. In the legacy cluster the
  // policy's first author is the leader until they clear it.
  if (clusterId !== LEGACY_CLUSTER_ID) {
    const row = db.prepare("SELECT manager_node_id FROM sharing_clusters WHERE id = ?").get(clusterId) as { manager_node_id: string | null } | undefined;
    if (!row) throw new RoutingPolicyError(404, `Unknown cluster: ${clusterId}`);
    if (!row.manager_node_id) throw new RoutingPolicyError(409, "Cluster is closed");
    if (row.manager_node_id !== actorNodeId) throw new RoutingPolicyError(403, "Only the current cluster manager can change the routing policy");
    return row.manager_node_id;
  }
  const existing = readRoutingPolicy(db, clusterId);
  if (existing && existing.leaderNodeId !== actorNodeId) throw new RoutingPolicyError(403, "Only the current routing policy leader can change it. Clear the policy on the leader node to hand the role over.");
  return existing?.leaderNodeId ?? actorNodeId;
}

function storeRoutingPolicyRow(db: DatabaseSync, input: Omit<StoredRoutingPolicy, "revision" | "updatedAt"> & { revision?: number; updatedAt?: string; originNodeId?: string }): StoredRoutingPolicy {
  const previous = db.prepare("SELECT revision, updated_at, origin_node_id FROM cluster_routing_policies WHERE cluster_id = ?").get(input.clusterId) as { revision: number; updated_at: string; origin_node_id: string } | undefined;
  const revision = input.revision ?? (previous?.revision ?? 0) + 1;
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const originNodeId = input.originNodeId ?? localNodeId(db) ?? "";
  db.prepare(`INSERT INTO cluster_routing_policies(cluster_id,policy,revision,leader_node_id,updated_by,updated_at,origin_node_id) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(cluster_id) DO UPDATE SET policy=excluded.policy, revision=excluded.revision, leader_node_id=excluded.leader_node_id, updated_by=excluded.updated_by, updated_at=excluded.updated_at, origin_node_id=excluded.origin_node_id`)
    .run(input.clusterId, JSON.stringify(input.policy), revision, input.leaderNodeId, input.updatedBy, updatedAt, originNodeId);
  return { clusterId: input.clusterId, policy: input.policy, revision, leaderNodeId: input.leaderNodeId, updatedBy: input.updatedBy, updatedAt };
}

/** Saves (or, with policy null, clears) the routing policy after checking leadership. */
export function updateClusterRoutingPolicy(db: DatabaseSync, clusterId: string, policy: RoutingPolicy | null, actorNodeId: string): StoredRoutingPolicy | null {
  const leaderNodeId = requiresClusterManager(db, clusterId, actorNodeId);
  const originNodeId = localNodeId(db);
  if (!originNodeId) throw new Error("Routing policy requires a node identity");
  if (policy === null) {
    const previousRevision = (db.prepare("SELECT revision FROM cluster_routing_policies WHERE cluster_id = ?").get(clusterId) as { revision: number } | undefined)?.revision ?? 0;
    db.prepare("DELETE FROM cluster_routing_policies WHERE cluster_id = ?").run(clusterId);
    enqueueClusterRoutingEvent(db, originNodeId, clusterId, null, previousRevision + 1, leaderNodeId, actorNodeId);
    return null;
  }
  const stored = storeRoutingPolicyRow(db, { clusterId, policy, leaderNodeId, updatedBy: actorNodeId });
  enqueueClusterRoutingEvent(db, originNodeId, clusterId, stored.policy, stored.revision, leaderNodeId, actorNodeId, stored.updatedAt);
  return stored;
}

function enqueueClusterRoutingEvent(db: DatabaseSync, originNodeId: string, clusterId: string, policy: RoutingPolicy | null, revision: number, leaderNodeId: string, updatedBy: string, updatedAt?: string): void {
  enqueueReplicationEvent(db, {
    originNodeId,
    entityType: "cluster.routing",
    entityKey: clusterId || "legacy",
    operation: policy ? "upsert" : "delete",
    payload: { clusterId, policy, revision, leaderNodeId, updatedBy, updatedAt: updatedAt ?? new Date().toISOString(), originNodeId },
  });
}

export const clusterRoutingEventPayloadSchema = z.object({
  clusterId: z.string(),
  policy: routingPolicySchema.nullable(),
  revision: z.number().int().positive(),
  leaderNodeId: z.string().min(1),
  updatedBy: z.string().min(1),
  updatedAt: z.string().min(1),
  originNodeId: z.string().min(1),
}).strict();

/** Replication applier: last writer wins on (updatedAt, originNodeId). A v2 cluster
    policy is only stored where the cluster is known locally. */
export function applyClusterRoutingEvent(db: DatabaseSync, event: ReplicationEvent): void {
  if (event.entityType !== "cluster.routing" || !["upsert", "delete"].includes(event.operation)) throw new Error("Unsupported routing replication event");
  const payload = clusterRoutingEventPayloadSchema.parse(event.payload);
  if ((event.operation === "upsert") !== (payload.policy !== null)) throw new Error("Malformed routing replication event");
  if (event.entityKey !== (payload.clusterId || "legacy")) throw new Error("Malformed routing replication event");
  if (payload.clusterId !== LEGACY_CLUSTER_ID && !db.prepare("SELECT 1 FROM sharing_clusters WHERE id = ?").get(payload.clusterId)) return;
  const existing = db.prepare("SELECT updated_at, origin_node_id FROM cluster_routing_policies WHERE cluster_id = ?").get(payload.clusterId) as { updated_at: string; origin_node_id: string } | undefined;
  if (existing && `${payload.updatedAt}\n${payload.originNodeId}` <= `${existing.updated_at}\n${existing.origin_node_id}`) return;
  if (payload.policy === null) {
    db.prepare("DELETE FROM cluster_routing_policies WHERE cluster_id = ?").run(payload.clusterId);
    return;
  }
  db.prepare(`INSERT INTO cluster_routing_policies(cluster_id,policy,revision,leader_node_id,updated_by,updated_at,origin_node_id) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(cluster_id) DO UPDATE SET policy=excluded.policy, revision=excluded.revision, leader_node_id=excluded.leader_node_id, updated_by=excluded.updated_by, updated_at=excluded.updated_at, origin_node_id=excluded.origin_node_id`)
    .run(payload.clusterId, JSON.stringify(payload.policy), payload.revision, payload.leaderNodeId, payload.updatedBy, payload.updatedAt, payload.originNodeId);
}

/** True when this prompt ordinal is an evaluation point under the policy's cadence. */
export function routingEvalDue(policy: RoutingPolicy, promptOrdinal: number, lastEvalOrdinal: number | null): boolean {
  if (!policy.enabled) return false;
  if (lastEvalOrdinal === null) return true;
  if (policy.evalCadence.mode === "first-message") return false;
  return promptOrdinal - lastEvalOrdinal >= (policy.evalCadence.n ?? Number.POSITIVE_INFINITY);
}

/** Resolves the mapped entry for a difficulty level, spreading the 1 to 10 scale
    across the filled rows in order: fewer filled levels each cover a wider band. */
export function resolveAdaptiveMapping(harnessPolicy: RoutingPolicy["harnesses"][string] | undefined, level: number): RoutingMapping | null {
  const entries = Object.entries(harnessPolicy?.levels ?? {})
    .filter(([, mapping]) => mapping !== null)
    .map(([key, mapping]) => ({ level: Number(key), mapping: mapping! }))
    .filter((entry) => Number.isInteger(entry.level) && entry.level >= 1 && entry.level <= ROUTING_LEVELS)
    .sort((left, right) => left.level - right.level);
  if (!entries.length) return null;
  const rank = Math.min(entries.length, Math.max(1, Math.ceil((level * entries.length) / ROUTING_LEVELS)));
  return entries[rank - 1].mapping;
}

export interface DefaultPolicyModel { provider: string; id: string; label: string }

const cheapModel = /flash|mini|lite|haiku|fast|small|nano|air/i;
const topModel = /opus|ultra|\bpro\b|pro[-_.]|max|big|large/i;

/** Builds a starting policy from each harness's conversation default and live model
    list: a cheap, a default, and a strongest pair when the catalog allows one. */
export function defaultRoutingPolicy(modelsByHarness: Record<string, DefaultPolicyModel[]>): RoutingPolicy {
  const harnesses: RoutingPolicy["harnesses"] = {};
  for (const adapter of listDiscoveredHarnesses()) {
    if (!adapter.configuration) continue;
    const levels = adapter.configuration.thinkingLevels;
    const models = modelsByHarness[adapter.id] ?? [];
    const fixed = adapter.configuration.fixedProvider;
    const pick = (model: DefaultPolicyModel | undefined, thinkingLevel: string) => model
      ? { ...(fixed ? {} : { provider: model.provider }), modelId: model.id, thinkingLevel: thinkingLevel as never }
      : null;
    const cheap = models.find((model) => cheapModel.test(`${model.id} ${model.label}`) && !(`${model.provider}/${model.id}` === `${adapter.defaults.provider}/${adapter.defaults.modelId}`));
    const top = models.find((model) => topModel.test(`${model.id} ${model.label}`) && model !== cheap && !(`${model.provider}/${model.id}` === `${adapter.defaults.provider}/${adapter.defaults.modelId}`));
    const mid = models.find((model) => model.provider === adapter.defaults.provider && model.id === adapter.defaults.modelId)
      ?? models[Math.floor(models.length / 2)]
      ?? models[0]
      ?? { provider: adapter.defaults.provider, id: adapter.defaults.modelId, label: adapter.defaults.modelId };
    const low = levels[0];
    const high = levels.at(-1)!;
    const medium = levels[Math.floor((levels.length - 1) / 2)];
    const levelsMap: RoutingPolicy["harnesses"][string]["levels"] = {
      "1": pick(cheap ?? mid, low)!,
      "5": pick(mid, medium)!,
      "10": pick(top ?? mid, high)!,
    };
    harnesses[adapter.id] = { levels: levelsMap };
  }
  return { enabled: true, classifierId: listDifficultyClassifiers()[0]?.id ?? "typesafe", instructions: "", evalCadence: { mode: "first-message" }, confidenceThreshold: 0.3, harnesses };
}

/** Resolves the routing policy that governs a project on this node, or null.
    Deterministic on every node: v2 shares resolve per cluster with the lowest cluster
    ID winning; the legacy policy applies to all projects on a legacy-paired node.
    Never throws: an unreadable store means no routing. */
export function routingPolicyForProject(projectId: string): StoredRoutingPolicy | null {
  try {
    const db = routingPolicyDatabase();
    const local = localNodeId(db);
    if (!local) return null;
    if (selectiveSharingActiveInDatabase(db)) {
      const clusterIds = resourceClusterIds(db, local, "project", projectId);
      const candidates = clusterIds.map((clusterId) => readRoutingPolicy(db, clusterId)).filter((stored): stored is StoredRoutingPolicy => Boolean(stored?.policy.enabled));
      return candidates.sort((left, right) => left.clusterId.localeCompare(right.clusterId))[0] ?? null;
    }
    const legacy = readRoutingPolicy(db, LEGACY_CLUSTER_ID);
    return legacy?.policy.enabled ? legacy : null;
  } catch (error) {
    console.warn("Routing policy resolution failed", error instanceof Error ? error.message.slice(0, 200) : "unknown error");
    return null;
  }
}
