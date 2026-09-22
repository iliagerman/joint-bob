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
import { getOrCreateClusterIdentity, pinnedClusterPublicKey, signClusterMessage, verifyClusterMessage } from "./cluster-identity.js";

/** The routing policy of the implicit legacy cluster, where every peer sees every project. */
export const LEGACY_CLUSTER_ID = "";
export const ROUTING_LEVELS = 10;
export const CODEX_ROUTING_MODELS = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"] as const;
const codexRoutingModels = new Set<string>(CODEX_ROUTING_MODELS);

export function automaticRoutingModelAllowed(provider: string | undefined, modelId: string): boolean {
  if (/^gpt-4(?:[.-]|$)/i.test(modelId)) return false;
  return provider !== "openai-codex" || codexRoutingModels.has(modelId);
}

const levelKeys = Array.from({ length: ROUTING_LEVELS }, (_, index) => String(index + 1));

export const routingMappingSchema = z.object({
  provider: z.string().trim().min(1).max(200).optional(),
  modelId: z.string().trim().min(1).max(300),
  thinkingLevel: z.string().trim().min(1).max(16),
  description: z.string().trim().min(1).max(1000),
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
  evalCadence: routingCadenceSchema,
  /** Number of recent user/assistant messages, including the current prompt, sent to the classifier. Optional for policies saved by older releases. */
  contextMessages: z.number().int().min(1).max(100).optional(),
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
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_routing_policies(cluster_id TEXT PRIMARY KEY, policy TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), leader_node_id TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS cluster_routing_pending(cluster_id TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT NOT NULL,origin_node_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cluster_v2_routing_deliveries(cluster_id TEXT NOT NULL,peer_id TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,PRIMARY KEY(cluster_id,peer_id,revision));`);
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
      const provider = mapping.provider ?? adapter.configuration?.fixedProvider;
      if (!automaticRoutingModelAllowed(provider, mapping.modelId)) throw new RoutingPolicyError(400, `${mapping.modelId} is not allowed for automatic routing`);
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
  activateAvailablePendingRoutingPolicies(db);
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
  activateAvailablePendingRoutingPolicies(db);
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
    db.prepare("DELETE FROM cluster_routing_pending WHERE cluster_id = ?").run(clusterId);
    publishClusterRoutingUpdate(db, originNodeId, clusterId, null, previousRevision + 1, leaderNodeId, actorNodeId);
    return null;
  }
  const stored = storeRoutingPolicyRow(db, { clusterId, policy, leaderNodeId, updatedBy: actorNodeId });
  db.prepare("DELETE FROM cluster_routing_pending WHERE cluster_id = ?").run(clusterId);
  publishClusterRoutingUpdate(db, originNodeId, clusterId, stored.policy, stored.revision, leaderNodeId, actorNodeId, stored.updatedAt);
  return stored;
}

function publishClusterRoutingUpdate(db: DatabaseSync, originNodeId: string, clusterId: string, policy: RoutingPolicy | null, revision: number, leaderNodeId: string, updatedBy: string, updatedAt?: string): void {
  const payload = clusterRoutingEventPayloadSchema.parse({ clusterId, policy, revision, leaderNodeId, updatedBy, updatedAt: updatedAt ?? new Date().toISOString(), originNodeId });
  if (clusterId === LEGACY_CLUSTER_ID) {
    enqueueReplicationEvent(db, { originNodeId, entityType: "cluster.routing", entityKey: "legacy", operation: policy ? "upsert" : "delete", payload });
    return;
  }
  const snapshot = signRoutingPolicySnapshot(db, payload, leaderNodeId);
  const members = db.prepare("SELECT node_id FROM sharing_memberships WHERE cluster_id = ? AND node_id <> ?").all(clusterId, originNodeId) as unknown as Array<{ node_id: string }>;
  const insert = db.prepare("INSERT OR REPLACE INTO cluster_v2_routing_deliveries(cluster_id,peer_id,revision,snapshot) VALUES (?,?,?,?)");
  for (const member of members) insert.run(clusterId, member.node_id, revision, JSON.stringify(snapshot));
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

export const signedRoutingPolicySnapshotSchema = z.object({ body: clusterRoutingEventPayloadSchema, signerNodeId: z.string().min(1), signature: z.string().min(1) }).strict();
export type SignedRoutingPolicySnapshot = z.infer<typeof signedRoutingPolicySnapshotSchema>;

function routingVersion(value: { updatedAt: string; originNodeId: string }): string { return `${value.updatedAt}\n${value.originNodeId}`; }

function applyRoutingPayload(db: DatabaseSync, payload: z.infer<typeof clusterRoutingEventPayloadSchema>): void {
  const existing = db.prepare("SELECT updated_at,origin_node_id FROM cluster_routing_policies WHERE cluster_id=?").get(payload.clusterId) as { updated_at: string; origin_node_id: string } | undefined;
  const pending = db.prepare("SELECT updated_at,origin_node_id FROM cluster_routing_pending WHERE cluster_id=?").get(payload.clusterId) as { updated_at: string; origin_node_id: string } | undefined;
  if (pending && routingVersion(payload) <= routingVersion({ updatedAt: pending.updated_at, originNodeId: pending.origin_node_id })) return;
  if (existing && routingVersion(payload) <= routingVersion({ updatedAt: existing.updated_at, originNodeId: existing.origin_node_id })) return;
  if (payload.policy === null) {
    db.prepare("DELETE FROM cluster_routing_policies WHERE cluster_id=?").run(payload.clusterId);
    db.prepare("DELETE FROM cluster_routing_pending WHERE cluster_id=?").run(payload.clusterId);
    return;
  }
  if (!getDifficultyClassifier(payload.policy.classifierId)) {
    db.prepare(`INSERT INTO cluster_routing_pending(cluster_id,payload,updated_at,origin_node_id) VALUES (?,?,?,?)
      ON CONFLICT(cluster_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at,origin_node_id=excluded.origin_node_id`)
      .run(payload.clusterId, JSON.stringify(payload), payload.updatedAt, payload.originNodeId);
    return;
  }
  db.prepare(`INSERT INTO cluster_routing_policies(cluster_id,policy,revision,leader_node_id,updated_by,updated_at,origin_node_id) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(cluster_id) DO UPDATE SET policy=excluded.policy,revision=excluded.revision,leader_node_id=excluded.leader_node_id,updated_by=excluded.updated_by,updated_at=excluded.updated_at,origin_node_id=excluded.origin_node_id`)
    .run(payload.clusterId, JSON.stringify(payload.policy), payload.revision, payload.leaderNodeId, payload.updatedBy, payload.updatedAt, payload.originNodeId);
  db.prepare("DELETE FROM cluster_routing_pending WHERE cluster_id=?").run(payload.clusterId);
}

function activateAvailablePendingRoutingPolicies(db: DatabaseSync): void {
  const rows = db.prepare("SELECT payload FROM cluster_routing_pending").all() as unknown as Array<{ payload: string }>;
  for (const row of rows) {
    const payload = clusterRoutingEventPayloadSchema.parse(JSON.parse(row.payload));
    if (payload.policy && getDifficultyClassifier(payload.policy.classifierId)) {
      db.prepare("DELETE FROM cluster_routing_pending WHERE cluster_id=?").run(payload.clusterId);
      applyRoutingPayload(db, payload);
    }
  }
}

export function routingPolicyWarning(db: DatabaseSync, clusterId: string): { classifierId: string; revision: number; message: string } | null {
  activateAvailablePendingRoutingPolicies(db);
  const row = db.prepare("SELECT payload FROM cluster_routing_pending WHERE cluster_id=?").get(clusterId) as { payload: string } | undefined;
  if (!row) return null;
  const payload = clusterRoutingEventPayloadSchema.parse(JSON.parse(row.payload));
  if (!payload.policy) return null;
  return { classifierId: payload.policy.classifierId, revision: payload.revision, message: `Routing update paused: classifier ${payload.policy.classifierId} is not installed on this node. Using the previous policy.` };
}

export function requiredRoutingClassifier(db: DatabaseSync, clusterId: string): string | null { return readRoutingPolicy(db, clusterId)?.policy.classifierId ?? null; }

export function assertRoutingClassifierForJoin(db: DatabaseSync, clusterId: string, classifierIds: readonly string[]): void {
  ensureRoutingPolicySchema(db);
  const required = requiredRoutingClassifier(db, clusterId);
  if (required && !classifierIds.includes(required)) throw new RoutingPolicyError(409, `Node is missing required routing classifier: ${required}`);
}

export function signRoutingPolicySnapshot(db: DatabaseSync, body: z.infer<typeof clusterRoutingEventPayloadSchema>, signerNodeId: string): SignedRoutingPolicySnapshot {
  getOrCreateClusterIdentity(db, signerNodeId);
  return signedRoutingPolicySnapshotSchema.parse({ body, signerNodeId, signature: signClusterMessage(db, signerNodeId, "routing-policy", JSON.stringify(body)) });
}

export function currentSignedRoutingPolicy(db: DatabaseSync, clusterId: string, signerNodeId: string): SignedRoutingPolicySnapshot | null {
  ensureRoutingPolicySchema(db);
  const stored = readRoutingPolicy(db, clusterId);
  return stored ? signRoutingPolicySnapshot(db, { ...stored, originNodeId: signerNodeId }, signerNodeId) : null;
}

export function applySignedRoutingPolicySnapshot(db: DatabaseSync, snapshot: SignedRoutingPolicySnapshot): void {
  ensureRoutingPolicySchema(db);
  const parsed = signedRoutingPolicySnapshotSchema.parse(snapshot);
  const manager = db.prepare("SELECT manager_node_id FROM sharing_clusters WHERE id=?").get(parsed.body.clusterId) as { manager_node_id: string | null } | undefined;
  const key = pinnedClusterPublicKey(db, parsed.signerNodeId);
  if (!manager || manager.manager_node_id !== parsed.signerNodeId || parsed.body.leaderNodeId !== parsed.signerNodeId || !key || !verifyClusterMessage(key, "routing-policy", JSON.stringify(parsed.body), parsed.signature)) throw new RoutingPolicyError(401, "Invalid routing policy snapshot");
  applyRoutingPayload(db, parsed.body);
}

export function listRoutingPolicyDeliveries(db: DatabaseSync): Array<{ clusterId: string; peerId: string; revision: number; snapshot: SignedRoutingPolicySnapshot }> {
  ensureRoutingPolicySchema(db);
  const rows = db.prepare("SELECT cluster_id,peer_id,revision,snapshot FROM cluster_v2_routing_deliveries ORDER BY cluster_id,peer_id,revision").all() as unknown as Array<{ cluster_id: string; peer_id: string; revision: number; snapshot: string }>;
  return rows.map((row) => ({ clusterId: row.cluster_id, peerId: row.peer_id, revision: row.revision, snapshot: signedRoutingPolicySnapshotSchema.parse(JSON.parse(row.snapshot)) }));
}

export function acknowledgeRoutingPolicyDelivery(db: DatabaseSync, clusterId: string, peerId: string, revision: number): void {
  ensureRoutingPolicySchema(db);
  db.prepare("DELETE FROM cluster_v2_routing_deliveries WHERE cluster_id=? AND peer_id=? AND revision=?").run(clusterId, peerId, revision);
}

/** Legacy replication applier. Selective clusters use signed manager snapshots. */
export function applyClusterRoutingEvent(db: DatabaseSync, event: ReplicationEvent): void {
  if (event.entityType !== "cluster.routing" || !["upsert", "delete"].includes(event.operation)) throw new Error("Unsupported routing replication event");
  const payload = clusterRoutingEventPayloadSchema.parse(event.payload);
  if ((event.operation === "upsert") !== (payload.policy !== null) || event.entityKey !== (payload.clusterId || "legacy")) throw new Error("Malformed routing replication event");
  if (payload.clusterId !== LEGACY_CLUSTER_ID && !db.prepare("SELECT 1 FROM sharing_clusters WHERE id=?").get(payload.clusterId)) return;
  applyRoutingPayload(db, payload);
}

/** True when this prompt ordinal is an evaluation point under the policy's cadence. */
export function routingEvalDue(policy: RoutingPolicy, promptOrdinal: number, lastEvalOrdinal: number | null): boolean {
  if (!policy.enabled) return false;
  if (lastEvalOrdinal === null) return true;
  if (policy.evalCadence.mode === "first-message") return false;
  return promptOrdinal - lastEvalOrdinal >= (policy.evalCadence.n ?? Number.POSITIVE_INFINITY);
}

export interface DefaultPolicyModel { provider: string; id: string; label: string }

/** Builds the approved automatic-routing tiers. Other harnesses stay blank until
    configured explicitly, so defaults never guess a model. */
export function defaultRoutingPolicy(modelsByHarness: Record<string, DefaultPolicyModel[]>): RoutingPolicy {
  const harnesses: RoutingPolicy["harnesses"] = {};
  for (const adapter of listDiscoveredHarnesses()) {
    if (!adapter.configuration) continue;
    const levelsMap: RoutingPolicy["harnesses"][string]["levels"] = {};
    if (adapter.id === "pi") {
      const models = modelsByHarness[adapter.id] ?? [];
      const tiers = [
        { level: "1", modelId: "gpt-5.6-luna", thinking: "low", description: "Small, obvious requests such as a factual answer, rename, or one-line edit." },
        { level: "4", modelId: "gpt-5.6-terra", thinking: "medium", description: "Routine localized work with clear requirements and limited codebase context." },
        { level: "7", modelId: "gpt-5.6-sol", thinking: "high", description: "Complex multi-file work, architectural changes, or debugging with unclear causes." },
        { level: "10", modelId: "gpt-6-astra", thinking: "max", description: "Open-ended, high-risk, or cross-system work requiring sustained design and verification." },
      ];
      for (const tier of tiers) {
        const model = models.find((candidate) => candidate.provider === "openai-codex" && candidate.id === tier.modelId);
        if (!model) continue;
        const thinkingLevel = adapter.configuration.thinkingLevels.includes(tier.thinking as never)
          ? tier.thinking
          : adapter.configuration.thinkingLevels.at(-1)!;
        levelsMap[tier.level] = { provider: model.provider, modelId: model.id, thinkingLevel, description: tier.description };
      }
    }
    harnesses[adapter.id] = { levels: levelsMap };
  }
  return { enabled: true, classifierId: listDifficultyClassifiers()[0]?.id ?? "typesafe", evalCadence: { mode: "first-message" }, contextMessages: 10, confidenceThreshold: 0.3, harnesses };
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
