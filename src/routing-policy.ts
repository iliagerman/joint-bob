import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getDifficultyClassifier, listDifficultyClassifiers } from "./classifiers/registry.js";
import { DIFFICULTY_RUBRIC } from "./classifiers/typesafe.js";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { resolveDataDirectory } from "./data-directory.js";
import { type ReplicationEvent } from "./replication.js";

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

function parseStoredRoutingPolicy(value: unknown): RoutingPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return routingPolicySchema.parse(value);
  const candidate = { ...value } as Record<string, unknown>;
  // Releases before classifier choices used one free-form prompt and mappings had no descriptions.
  delete candidate.instructions;
  if (candidate.harnesses && typeof candidate.harnesses === "object" && !Array.isArray(candidate.harnesses)) {
    for (const harness of Object.values(candidate.harnesses)) {
      if (!harness || typeof harness !== "object" || Array.isArray(harness)) continue;
      const levels = (harness as Record<string, unknown>).levels;
      if (!levels || typeof levels !== "object" || Array.isArray(levels)) continue;
      for (const [level, mapping] of Object.entries(levels)) {
        if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) continue;
        const record = mapping as Record<string, unknown>;
        if (typeof record.description !== "string" || !record.description.trim()) record.description = DIFFICULTY_RUBRIC[Number(level) - 1];
      }
    }
  }
  return routingPolicySchema.parse(candidate);
}

function rowToStored(row: PolicyRow): StoredRoutingPolicy {
  return { clusterId: row.cluster_id, policy: parseStoredRoutingPolicy(JSON.parse(row.policy)), revision: row.revision, leaderNodeId: row.leader_node_id, updatedBy: row.updated_by, updatedAt: row.updated_at };
}

export function readRoutingPolicy(db: DatabaseSync, clusterId: string): StoredRoutingPolicy | null {
  activateAvailablePendingRoutingPolicies(db);
  const row = db.prepare("SELECT cluster_id,policy,revision,leader_node_id,updated_by,updated_at FROM cluster_routing_policies WHERE cluster_id = ?").get(clusterId) as PolicyRow | undefined;
  return row ? rowToStored(row) : null;
}

export function listRoutingPolicies(db: DatabaseSync): StoredRoutingPolicy[] {
  activateAvailablePendingRoutingPolicies(db);
  return (db.prepare("SELECT cluster_id,policy,revision,leader_node_id,updated_by,updated_at FROM cluster_routing_policies ORDER BY cluster_id").all() as unknown as PolicyRow[]).map(rowToStored);
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

/** Builds approved tiers per harness. Kiro and unknown harnesses stay blank, so
    defaults never guess how a native model catalogue ranks its models. */
export function defaultRoutingPolicy(modelsByHarness: Record<string, DefaultPolicyModel[]>): RoutingPolicy {
  const harnesses: RoutingPolicy["harnesses"] = {};
  for (const adapter of listDiscoveredHarnesses()) {
    if (!adapter.configuration) continue;
    const levelsMap: RoutingPolicy["harnesses"][string]["levels"] = {};
    const models = modelsByHarness[adapter.id] ?? [];
    const tiers = adapter.id === "pi"
      ? [
        { level: "1", provider: "zai", modelId: "glm-5.3-flash", thinking: "low", description: "Fast, low-cost work such as summaries, lookups, small edits, and requests with an obvious answer." },
        { level: "4", provider: "zai", modelId: "glm-5.3", thinking: "high", description: "Substantial implementation, analysis, or debugging that benefits from strong reasoning at lower cost." },
        { level: "7", provider: "openai-codex", modelId: "gpt-5.6-sol", thinking: "high", description: "Complex development work across several files where implementation quality matters more than broad architecture." },
        { level: "10", provider: "openai-codex", modelId: "gpt-6-astra", thinking: "max", description: "The hardest ambiguous, high-risk, or cross-system architecture requiring sustained reasoning and verification." },
      ]
      : adapter.id === "claude"
        ? [{ level: "10", provider: "claude", modelId: "claude-opus-5-5", thinking: "max", description: "The hardest Claude work requiring Opus 5.5's sustained architectural reasoning and judgment." }]
        : [];
    for (const tier of tiers) {
      const model = models.find((candidate) => candidate.provider === tier.provider && candidate.id === tier.modelId);
      if (!model) continue;
      const thinkingLevel = adapter.configuration.thinkingLevels.includes(tier.thinking as never)
        ? tier.thinking
        : adapter.configuration.thinkingLevels.at(-1)!;
      levelsMap[tier.level] = { ...(adapter.configuration.fixedProvider ? {} : { provider: model.provider }), modelId: model.id, thinkingLevel, description: tier.description };
    }
    harnesses[adapter.id] = { levels: levelsMap };
  }
  return { enabled: true, classifierId: listDifficultyClassifiers()[0]?.id ?? "typesafe", evalCadence: { mode: "first-message" }, contextMessages: 10, confidenceThreshold: 0.3, harnesses };
}
