import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";
import { applyClusterRoutingEvent, defaultRoutingPolicy, ensureRoutingPolicySchema, LEGACY_CLUSTER_ID, readRoutingPolicy, resolveAdaptiveMapping, RoutingPolicyError, routingEvalDue, routingPolicyDatabase, routingPolicyForProject, routingPolicySchema, updateClusterRoutingPolicy, validateRoutingPolicy, type RoutingPolicy } from "../src/routing-policy.js";
import { ensureClusterSharingPolicySchema } from "../src/cluster-sharing-policy.js";
import { ensureReplicationSchema } from "../src/replication.js";
import { ensurePromptQueueSchema } from "../src/prompt-queue.js";

let dataDirectory: string;

const nodeA = randomUUID();
const nodeB = randomUUID();

function policy(overrides: Partial<RoutingPolicy> = {}): RoutingPolicy {
  return routingPolicySchema.parse({
    enabled: true,
    classifierId: "typesafe",
    evalCadence: { mode: "every-n", n: 3 },
    confidenceThreshold: 0.3,
    harnesses: { kiro: { levels: { "7": { modelId: "default", thinkingLevel: "high" } } } },
    ...overrides,
  });
}

function replicationEvent(payload: Record<string, unknown>, updatedAt: string, originNodeId: string) {
  return {
    id: randomUUID(),
    originNodeId,
    entityType: "cluster.routing",
    entityKey: (payload.clusterId as string) || "legacy",
    operation: payload.policy ? "upsert" : "delete",
    payload: { revision: 1, leaderNodeId: nodeA, updatedBy: nodeA, ...payload, updatedAt, originNodeId },
    createdAt: updatedAt,
  };
}

before(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "routing-policy-"));
  // Point the module's resolver at the throwaway directory before any call opens it.
  process.env.PI_WEB_DATA_DIR = dataDirectory;
  const db = routingPolicyDatabase();
  ensureReplicationSchema(db);
  ensurePromptQueueSchema(db);
  ensureClusterSharingPolicySchema(db);
  db.exec("CREATE TABLE IF NOT EXISTS cluster_node (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.prepare("INSERT INTO cluster_node (singleton, id, name, url, created_at, updated_at) VALUES (1, ?, 'local', 'http://localhost', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run(nodeA);
});

after(async () => {
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
});

test("validateRoutingPolicy rejects mappings the local harnesses cannot serve", () => {
  assert.throws(() => validateRoutingPolicy({ ...policy(), classifierId: "nope" }), /Unknown classifier/);
  assert.throws(() => validateRoutingPolicy(policy({ harnesses: { smol: { levels: {} } } })), /Unknown harness/);
  // Kiro has a fixed kiro provider, so another provider is invalid.
  assert.throws(() => validateRoutingPolicy(policy({ harnesses: { kiro: { levels: { "7": { provider: "openai", modelId: "x", thinkingLevel: "high" } } } } })), /provider/);
  // Kiro supports low to max thinking levels only.
  assert.throws(() => validateRoutingPolicy(policy({ harnesses: { kiro: { levels: { "7": { modelId: "default", thinkingLevel: "off" } } } } })), /thinking level/);
});

test("validateRoutingPolicy accepts a valid policy", () => {
  const parsed = validateRoutingPolicy(policy());
  assert.equal(parsed.harnesses.kiro.levels["7"]?.modelId, "default");
});

test("every-n cadence requires n and first-message forbids it", () => {
  assert.throws(() => policy({ evalCadence: { mode: "every-n" } }), /requires n/);
  assert.throws(() => policy({ evalCadence: { mode: "first-message", n: 2 } }), /cannot carry n/);
});

test("legacy leadership: the first writer becomes the leader and only the leader may change the policy", () => {
  const db = routingPolicyDatabase();
  const stored = updateClusterRoutingPolicy(db, LEGACY_CLUSTER_ID, policy(), nodeA);
  assert.equal(stored?.leaderNodeId, nodeA);
  assert.throws(() => updateClusterRoutingPolicy(db, LEGACY_CLUSTER_ID, policy({ confidenceThreshold: 0.5 }), nodeB), RoutingPolicyError);
  const updated = updateClusterRoutingPolicy(db, LEGACY_CLUSTER_ID, policy({ confidenceThreshold: 0.5 }), nodeA);
  assert.equal(updated?.revision, 2);
  assert.equal(readRoutingPolicy(db, LEGACY_CLUSTER_ID)?.policy.confidenceThreshold, 0.5);
});

test("legacy leadership clears with the policy and another node can claim it", () => {
  const db = routingPolicyDatabase();
  assert.throws(() => updateClusterRoutingPolicy(db, LEGACY_CLUSTER_ID, null, nodeB), RoutingPolicyError);
  assert.equal(updateClusterRoutingPolicy(db, LEGACY_CLUSTER_ID, null, nodeA), null);
  assert.equal(readRoutingPolicy(db, LEGACY_CLUSTER_ID), null);
  const claimed = updateClusterRoutingPolicy(db, LEGACY_CLUSTER_ID, policy(), nodeB);
  assert.equal(claimed?.leaderNodeId, nodeB);
  updateClusterRoutingPolicy(db, LEGACY_CLUSTER_ID, null, nodeB);
});

test("v2 clusters reject writes from non-manager nodes", () => {
  const db = routingPolicyDatabase();
  const clusterId = randomUUID();
  db.prepare("INSERT INTO sharing_clusters(id,name,original_node_id,manager_node_id,manager_epoch,next_join_sequence,closed) VALUES (?,?,?,?,1,2,0)").run(clusterId, "main", nodeA, nodeB);
  db.prepare("INSERT INTO sharing_memberships(cluster_id,node_id,join_sequence) VALUES (?,?,1)").run(clusterId, nodeB);
  assert.throws(() => updateClusterRoutingPolicy(db, clusterId, policy(), nodeA), RoutingPolicyError);
  assert.equal(updateClusterRoutingPolicy(db, clusterId, policy(), nodeB)?.leaderNodeId, nodeB);
});

test("replication applies the newest writer and ignores stale events", () => {
  const db = routingPolicyDatabase();
  const fresh = { clusterId: LEGACY_CLUSTER_ID, policy: policy({ confidenceThreshold: 0.9 }) };
  applyClusterRoutingEvent(db, replicationEvent(fresh, "2026-01-02T00:00:00Z", nodeB));
  assert.equal(readRoutingPolicy(db, LEGACY_CLUSTER_ID)?.policy.confidenceThreshold, 0.9);
  applyClusterRoutingEvent(db, replicationEvent({ clusterId: LEGACY_CLUSTER_ID, policy: policy({ confidenceThreshold: 0.1 }) }, "2026-01-01T00:00:00Z", nodeB));
  assert.equal(readRoutingPolicy(db, LEGACY_CLUSTER_ID)?.policy.confidenceThreshold, 0.9, "stale event must not win");
  applyClusterRoutingEvent(db, replicationEvent({ clusterId: LEGACY_CLUSTER_ID, policy: null }, "2026-01-03T00:00:00Z", nodeB));
  assert.equal(readRoutingPolicy(db, LEGACY_CLUSTER_ID), null);
});

test("replication drops policies for clusters this node does not know", () => {
  const db = routingPolicyDatabase();
  const unknown = randomUUID();
  applyClusterRoutingEvent(db, replicationEvent({ clusterId: unknown, policy: policy() }, "2026-01-02T00:00:00Z", nodeB));
  assert.equal(readRoutingPolicy(db, unknown), null);
});

test("routingEvalDue follows the configured cadence", () => {
  const firstMessage = policy({ evalCadence: { mode: "first-message" } });
  assert.equal(routingEvalDue(firstMessage, 1, null), true);
  assert.equal(routingEvalDue(firstMessage, 5, 1), false);
  const everyThree = policy({ evalCadence: { mode: "every-n", n: 3 } });
  assert.equal(routingEvalDue(everyThree, 1, null), true);
  assert.equal(routingEvalDue(everyThree, 2, 1), false);
  assert.equal(routingEvalDue(everyThree, 4, 1), true);
  assert.equal(routingEvalDue({ ...everyThree, enabled: false }, 9, null), false);
});

test("routingPolicyForProject applies the enabled legacy policy to any project", () => {
  updateClusterRoutingPolicy(routingPolicyDatabase(), LEGACY_CLUSTER_ID, policy(), nodeA);
  const resolved = routingPolicyForProject(randomUUID());
  assert.equal(resolved?.clusterId, LEGACY_CLUSTER_ID);
  updateClusterRoutingPolicy(routingPolicyDatabase(), LEGACY_CLUSTER_ID, policy({ enabled: false }), nodeA);
  assert.equal(routingPolicyForProject(randomUUID()), null, "a disabled policy must not route");
  updateClusterRoutingPolicy(routingPolicyDatabase(), LEGACY_CLUSTER_ID, null, nodeA);
});

test("resolveAdaptiveMapping spreads the 1 to 10 scale across the filled levels", () => {
  const two = { levels: { "1": { modelId: "easy", thinkingLevel: "low" }, "8": { modelId: "hard", thinkingLevel: "high" } } };
  assert.equal(resolveAdaptiveMapping(two, 1)?.modelId, "easy");
  assert.equal(resolveAdaptiveMapping(two, 5)?.modelId, "easy", "difficulty 5 of 10 lands on the first of two rows");
  assert.equal(resolveAdaptiveMapping(two, 6)?.modelId, "hard", "difficulty 6 of 10 lands on the second of two rows");
  assert.equal(resolveAdaptiveMapping(two, 10)?.modelId, "hard");
  const full = policy({ harnesses: { kiro: { levels: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [String(index + 1), { modelId: `m${index + 1}`, thinkingLevel: "high" }])) } } });
  for (const level of [1, 5, 10]) assert.equal(resolveAdaptiveMapping(full.harnesses.kiro, level)?.modelId, `m${level}`, "a full grid maps levels literally");
  assert.equal(resolveAdaptiveMapping({ levels: {} }, 7), null, "no filled levels means no mapping");
  assert.equal(resolveAdaptiveMapping(undefined, 7), null);
});

test("defaultRoutingPolicy prefills model and reasoning pairs for every harness", () => {
  const generated = defaultRoutingPolicy({
    pi: [
      { provider: "zai", id: "glm-flash", label: "GLM Flash" },
      { provider: "openai-codex", id: "gpt-5.6-sol", label: "GPT 5.6 Sol" },
      { provider: "anthropic", id: "claude-opus-5", label: "Claude Opus" },
    ],
    kiro: [],
  });
  const pi = generated.harnesses.pi.levels;
  assert.equal(pi["1"]?.modelId, "glm-flash", "the flash-style model takes the easy tier");
  assert.equal(pi["5"]?.modelId, "gpt-5.6-sol", "the conversation default takes the middle tier");
  assert.equal(pi["10"]?.modelId, "claude-opus-5", "the strongest-named model takes the top tier");
  assert.notEqual(pi["1"]?.thinkingLevel, pi["10"]?.thinkingLevel, "reasoning scales with difficulty");
  const kiro = generated.harnesses.kiro.levels;
  assert.ok(kiro["1"] && kiro["5"] && kiro["10"], "a harness without models still gets default pairs");
  assert.doesNotThrow(() => validateRoutingPolicy(generated), "generated defaults must satisfy the policy schema");
});

test("the policy carries trimmed calibration instructions", () => {
  const parsed = validateRoutingPolicy(policy({ instructions: "  easiest is a rename; hardest is a migration  " }));
  assert.equal(parsed.instructions, "easiest is a rename; hardest is a migration");
  assert.throws(() => policy({ instructions: "x".repeat(4001) }), /instructions/);
});
