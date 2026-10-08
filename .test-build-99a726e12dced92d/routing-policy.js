import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getDifficultyClassifier, listDifficultyClassifiers } from "./classifiers/registry.js";
import { DIFFICULTY_RUBRIC } from "./classifiers/typesafe.js";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { resolveDataDirectory } from "./data-directory.js";
const LEGACY_CLUSTER_ID = "";
const ROUTING_LEVELS = 10;
const CODEX_ROUTING_MODELS = ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"];
const codexRoutingModels = new Set(CODEX_ROUTING_MODELS);
function automaticRoutingModelAllowed(provider, modelId) {
  if (/^gpt-(?:4|5\.6)(?:[.-]|$)/i.test(modelId)) return false;
  return provider !== "openai-codex" || codexRoutingModels.has(modelId);
}
const levelKeys = Array.from({ length: ROUTING_LEVELS }, (_, index) => String(index + 1));
const routingMappingSchema = z.object({
  provider: z.string().trim().min(1).max(200).optional(),
  modelId: z.string().trim().min(1).max(300),
  thinkingLevel: z.string().trim().min(1).max(16),
  description: z.string().trim().min(1).max(1e3)
}).strict();
const routingCadenceSchema = z.object({
  mode: z.enum(["first-message", "every-n"]),
  n: z.number().int().min(1).max(500).optional()
}).strict().superRefine((value, context) => {
  if (value.mode === "every-n" && value.n === void 0) context.addIssue({ code: z.ZodIssueCode.custom, message: "Every-n cadence requires n" });
  if (value.mode === "first-message" && value.n !== void 0) context.addIssue({ code: z.ZodIssueCode.custom, message: "First-message cadence cannot carry n" });
});
const routingPolicySchema = z.object({
  enabled: z.boolean(),
  classifierId: z.string().trim().min(1).max(80),
  evalCadence: routingCadenceSchema,
  /** Number of recent user/assistant messages, including the current prompt, sent to the classifier. Optional for policies saved by older releases. */
  contextMessages: z.number().int().min(1).max(100).optional(),
  confidenceThreshold: z.number().min(0).max(1),
  harnesses: z.record(z.string().trim().min(1).max(80), z.object({
    levels: z.record(z.string().trim().regex(/^(10|[1-9])$/), routingMappingSchema.nullable())
  }).strict())
}).strict();
class RoutingPolicyError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
  statusCode;
}
let database;
function ensureRoutingPolicySchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_routing_policies(cluster_id TEXT PRIMARY KEY, policy TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), leader_node_id TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS cluster_routing_pending(cluster_id TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT NOT NULL,origin_node_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cluster_v2_routing_deliveries(cluster_id TEXT NOT NULL,peer_id TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,PRIMARY KEY(cluster_id,peer_id,revision));`);
}
function routingPolicyDatabase() {
  if (database) return database;
  const directory = resolveDataDirectory();
  mkdirSync(directory, { recursive: true, mode: 448 });
  const db = new DatabaseSync(path.join(directory, "node.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensureRoutingPolicySchema(db);
  database = db;
  return db;
}
function validateRoutingPolicy(policy) {
  const parsed = routingPolicySchema.parse(policy);
  if (!getDifficultyClassifier(parsed.classifierId)) throw new RoutingPolicyError(400, `Unknown classifier: ${parsed.classifierId}`);
  for (const adapter of listDiscoveredHarnesses()) {
    const entry = parsed.harnesses[adapter.id];
    if (!entry) continue;
    for (const level of levelKeys) {
      const mapping = entry.levels[level];
      if (!mapping) continue;
      if (adapter.configuration?.fixedProvider && mapping.provider !== void 0 && mapping.provider !== adapter.configuration.fixedProvider) {
        throw new RoutingPolicyError(400, `${adapter.label} models must use provider ${adapter.configuration.fixedProvider}`);
      }
      if (!adapter.configuration?.fixedProvider && !mapping.provider) throw new RoutingPolicyError(400, `${adapter.label} level ${level} mapping needs a provider`);
      const provider = mapping.provider ?? adapter.configuration?.fixedProvider;
      if (!automaticRoutingModelAllowed(provider, mapping.modelId)) throw new RoutingPolicyError(400, `${mapping.modelId} is not allowed for automatic routing`);
      if (adapter.configuration && !adapter.configuration.thinkingLevels.includes(mapping.thinkingLevel)) {
        throw new RoutingPolicyError(400, `${adapter.label} does not support thinking level ${mapping.thinkingLevel}`);
      }
    }
  }
  for (const harnessId of Object.keys(parsed.harnesses)) {
    if (!listDiscoveredHarnesses().some((adapter) => adapter.id === harnessId)) throw new RoutingPolicyError(400, `Unknown harness: ${harnessId}`);
  }
  return parsed;
}
function parseStoredRoutingPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return routingPolicySchema.parse(value);
  const candidate = { ...value };
  delete candidate.instructions;
  if (candidate.harnesses && typeof candidate.harnesses === "object" && !Array.isArray(candidate.harnesses)) {
    for (const harness of Object.values(candidate.harnesses)) {
      if (!harness || typeof harness !== "object" || Array.isArray(harness)) continue;
      const levels = harness.levels;
      if (!levels || typeof levels !== "object" || Array.isArray(levels)) continue;
      for (const [level, mapping] of Object.entries(levels)) {
        if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) continue;
        const record = mapping;
        if (typeof record.description !== "string" || !record.description.trim()) record.description = DIFFICULTY_RUBRIC[Number(level) - 1];
      }
    }
  }
  return routingPolicySchema.parse(candidate);
}
function rowToStored(row) {
  return { clusterId: row.cluster_id, policy: parseStoredRoutingPolicy(JSON.parse(row.policy)), revision: row.revision, leaderNodeId: row.leader_node_id, updatedBy: row.updated_by, updatedAt: row.updated_at };
}
function readRoutingPolicy(db, clusterId) {
  activateAvailablePendingRoutingPolicies(db);
  const row = db.prepare("SELECT cluster_id,policy,revision,leader_node_id,updated_by,updated_at FROM cluster_routing_policies WHERE cluster_id = ?").get(clusterId);
  return row ? rowToStored(row) : null;
}
function listRoutingPolicies(db) {
  activateAvailablePendingRoutingPolicies(db);
  return db.prepare("SELECT cluster_id,policy,revision,leader_node_id,updated_by,updated_at FROM cluster_routing_policies ORDER BY cluster_id").all().map(rowToStored);
}
const clusterRoutingEventPayloadSchema = z.object({
  clusterId: z.string(),
  policy: routingPolicySchema.nullable(),
  revision: z.number().int().positive(),
  leaderNodeId: z.string().min(1),
  updatedBy: z.string().min(1),
  updatedAt: z.string().min(1),
  originNodeId: z.string().min(1)
}).strict();
function routingVersion(value) {
  return `${value.updatedAt}
${value.originNodeId}`;
}
function applyRoutingPayload(db, payload) {
  const existing = db.prepare("SELECT updated_at,origin_node_id FROM cluster_routing_policies WHERE cluster_id=?").get(payload.clusterId);
  const pending = db.prepare("SELECT updated_at,origin_node_id FROM cluster_routing_pending WHERE cluster_id=?").get(payload.clusterId);
  if (pending && routingVersion(payload) <= routingVersion({ updatedAt: pending.updated_at, originNodeId: pending.origin_node_id })) return;
  if (existing && routingVersion(payload) <= routingVersion({ updatedAt: existing.updated_at, originNodeId: existing.origin_node_id })) return;
  if (payload.policy === null) {
    db.prepare("DELETE FROM cluster_routing_policies WHERE cluster_id=?").run(payload.clusterId);
    db.prepare("DELETE FROM cluster_routing_pending WHERE cluster_id=?").run(payload.clusterId);
    return;
  }
  if (!getDifficultyClassifier(payload.policy.classifierId)) {
    db.prepare(`INSERT INTO cluster_routing_pending(cluster_id,payload,updated_at,origin_node_id) VALUES (?,?,?,?)
      ON CONFLICT(cluster_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at,origin_node_id=excluded.origin_node_id`).run(payload.clusterId, JSON.stringify(payload), payload.updatedAt, payload.originNodeId);
    return;
  }
  db.prepare(`INSERT INTO cluster_routing_policies(cluster_id,policy,revision,leader_node_id,updated_by,updated_at,origin_node_id) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(cluster_id) DO UPDATE SET policy=excluded.policy,revision=excluded.revision,leader_node_id=excluded.leader_node_id,updated_by=excluded.updated_by,updated_at=excluded.updated_at,origin_node_id=excluded.origin_node_id`).run(payload.clusterId, JSON.stringify(payload.policy), payload.revision, payload.leaderNodeId, payload.updatedBy, payload.updatedAt, payload.originNodeId);
  db.prepare("DELETE FROM cluster_routing_pending WHERE cluster_id=?").run(payload.clusterId);
}
function activateAvailablePendingRoutingPolicies(db) {
  const rows = db.prepare("SELECT payload FROM cluster_routing_pending").all();
  for (const row of rows) {
    const payload = clusterRoutingEventPayloadSchema.parse(JSON.parse(row.payload));
    if (payload.policy && getDifficultyClassifier(payload.policy.classifierId)) {
      db.prepare("DELETE FROM cluster_routing_pending WHERE cluster_id=?").run(payload.clusterId);
      applyRoutingPayload(db, payload);
    }
  }
}
function routingPolicyWarning(db, clusterId) {
  activateAvailablePendingRoutingPolicies(db);
  const row = db.prepare("SELECT payload FROM cluster_routing_pending WHERE cluster_id=?").get(clusterId);
  if (!row) return null;
  const payload = clusterRoutingEventPayloadSchema.parse(JSON.parse(row.payload));
  if (!payload.policy) return null;
  return { classifierId: payload.policy.classifierId, revision: payload.revision, message: `Routing update paused: classifier ${payload.policy.classifierId} is not installed on this node. Using the previous policy.` };
}
function applyClusterRoutingEvent(db, event) {
  if (event.entityType !== "cluster.routing" || !["upsert", "delete"].includes(event.operation)) throw new Error("Unsupported routing replication event");
  const payload = clusterRoutingEventPayloadSchema.parse(event.payload);
  if (event.operation === "upsert" !== (payload.policy !== null) || event.entityKey !== (payload.clusterId || "legacy")) throw new Error("Malformed routing replication event");
  if (payload.clusterId !== LEGACY_CLUSTER_ID && !db.prepare("SELECT 1 FROM sharing_clusters WHERE id=?").get(payload.clusterId)) return;
  applyRoutingPayload(db, payload);
}
function routingEvalDue(policy, promptOrdinal, lastEvalOrdinal) {
  if (!policy.enabled) return false;
  if (lastEvalOrdinal === null) return true;
  if (policy.evalCadence.mode === "first-message") return false;
  return promptOrdinal - lastEvalOrdinal >= (policy.evalCadence.n ?? Number.POSITIVE_INFINITY);
}
function defaultRoutingPolicy() {
  const harnesses = {};
  for (const adapter of listDiscoveredHarnesses()) {
    if (!adapter.configuration) continue;
    const levelsMap = {};
    const tiers = adapter.id === "pi" ? [
      { level: "1", provider: "zai", modelId: "glm-5.3-flash", thinkingLevel: "low", description: "Direct CLI commands, shell inspection, lookups, and other short mechanical terminal work that does not change git history." },
      { level: "3", provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "medium", description: "Git operations such as reviewing diffs, preparing commits, resolving straightforward conflicts, and managing an existing branch." },
      { level: "5", provider: "openai-codex", modelId: "gpt-6-sol", thinkingLevel: "medium", description: "Debugging a reported error, reproducing a failure, tracing its cause, and making a focused fix." },
      { level: "7", provider: "openai-codex", modelId: "gpt-6-sol", thinkingLevel: "high", description: "Software development that implements or refactors a feature across the codebase and verifies the result." },
      { level: "10", provider: "openai-codex", modelId: "gpt-6-astra", thinkingLevel: "xhigh", description: "Complex planning, architecture, ambiguous multi-system design, or high-risk work that needs deep analysis before implementation." }
    ] : adapter.id === "claude" ? [
      { level: "1", provider: "claude", modelId: "haiku", thinkingLevel: "low", description: "Direct CLI commands, shell inspection, lookups, and other short mechanical terminal work that does not change git history." },
      { level: "3", provider: "claude", modelId: "haiku", thinkingLevel: "low", description: "Git operations such as reviewing diffs, preparing commits, resolving straightforward conflicts, and managing an existing branch." },
      { level: "5", provider: "claude", modelId: "opus", thinkingLevel: "medium", description: "Debugging a reported error, reproducing a failure, tracing its cause, and making a focused fix." },
      { level: "7", provider: "claude", modelId: "opus", thinkingLevel: "high", description: "Software development that implements or refactors a feature across the codebase and verifies the result." },
      { level: "10", provider: "claude", modelId: "opus", thinkingLevel: "xhigh", description: "Complex planning, architecture, ambiguous multi-system design, or high-risk work that needs deep analysis before implementation." }
    ] : [];
    for (const tier of tiers) {
      levelsMap[tier.level] = { ...adapter.configuration.fixedProvider ? {} : { provider: tier.provider }, modelId: tier.modelId, thinkingLevel: tier.thinkingLevel, description: tier.description };
    }
    harnesses[adapter.id] = { levels: levelsMap };
  }
  return { enabled: true, classifierId: listDifficultyClassifiers()[0]?.id ?? "typesafe", evalCadence: { mode: "every-n", n: 1 }, contextMessages: 1, confidenceThreshold: 0.3, harnesses };
}
export {
  CODEX_ROUTING_MODELS,
  LEGACY_CLUSTER_ID,
  ROUTING_LEVELS,
  RoutingPolicyError,
  applyClusterRoutingEvent,
  automaticRoutingModelAllowed,
  clusterRoutingEventPayloadSchema,
  defaultRoutingPolicy,
  ensureRoutingPolicySchema,
  listRoutingPolicies,
  readRoutingPolicy,
  routingCadenceSchema,
  routingEvalDue,
  routingMappingSchema,
  routingPolicyDatabase,
  routingPolicySchema,
  routingPolicyWarning,
  validateRoutingPolicy
};
