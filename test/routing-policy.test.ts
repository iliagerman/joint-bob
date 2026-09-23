import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";
import { applyClusterRoutingEvent, defaultRoutingPolicy, ensureRoutingPolicySchema, LEGACY_CLUSTER_ID, readRoutingPolicy, routingEvalDue, routingPolicyDatabase, routingPolicySchema, routingPolicyWarning, validateRoutingPolicy, type RoutingPolicy } from "../src/routing-policy.js";
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
    contextMessages: 10,
    confidenceThreshold: 0.3,
    harnesses: { kiro: { levels: { "7": { modelId: "default", thinkingLevel: "high", description: "Complex multi-file work" } } } },
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
  assert.throws(() => validateRoutingPolicy(policy({ harnesses: { kiro: { levels: { "7": { provider: "openai", modelId: "x", thinkingLevel: "high", description: "Complex multi-file work" } } } } })), /provider/);
  // Kiro supports low to max thinking levels only.
  assert.throws(() => validateRoutingPolicy(policy({ harnesses: { kiro: { levels: { "7": { modelId: "default", thinkingLevel: "off", description: "Complex multi-file work" } } } } })), /thinking level/);
});

test("validateRoutingPolicy accepts a valid policy", () => {
  const parsed = validateRoutingPolicy(policy());
  assert.equal(parsed.harnesses.kiro.levels["7"]?.modelId, "default");
});

test("stored policies from before classifier descriptions remain readable", () => {
  const db = routingPolicyDatabase();
  const legacy = {
    enabled: true,
    classifierId: "typesafe",
    instructions: "Retired custom classifier prompt",
    evalCadence: { mode: "first-message" },
    confidenceThreshold: 0.3,
    harnesses: { kiro: { levels: { "7": { modelId: "default", thinkingLevel: "high" } } } },
  };
  db.prepare("INSERT OR REPLACE INTO cluster_routing_policies(cluster_id,policy,revision,leader_node_id,updated_by,updated_at,origin_node_id) VALUES ('',?,1,?,?,?,?)")
    .run(JSON.stringify(legacy), nodeA, nodeA, "2026-01-01T00:00:00Z", nodeA);
  try {
    const stored = readRoutingPolicy(db, LEGACY_CLUSTER_ID);
    assert.equal(stored?.policy.harnesses.kiro.levels["7"]?.description, "Hard: an architectural change, refactoring coupled systems, or debugging an unclear failure");
    assert.equal("instructions" in (stored?.policy ?? {}), false, "the retired classifier prompt is discarded");
  } finally {
    db.prepare("DELETE FROM cluster_routing_policies WHERE cluster_id = ''").run();
  }
});

test("classifier cadence and context window are bounded", () => {
  assert.throws(() => policy({ evalCadence: { mode: "every-n" } }), /requires n/);
  assert.throws(() => policy({ evalCadence: { mode: "first-message", n: 2 } }), /cannot carry n/);
  assert.throws(() => policy({ contextMessages: 0 }), /greater than or equal to 1/);
  assert.throws(() => policy({ contextMessages: 101 }), /less than or equal to 100/);
  const legacy = structuredClone(policy()) as Partial<RoutingPolicy>;
  delete legacy.contextMessages;
  assert.equal(validateRoutingPolicy(legacy).contextMessages, undefined, "policies saved before context windows remain valid");
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

test("an unavailable classifier keeps the last usable policy and records a warning", () => {
  const db = routingPolicyDatabase();
  db.prepare("INSERT OR REPLACE INTO cluster_routing_policies(cluster_id,policy,revision,leader_node_id,updated_by,updated_at,origin_node_id) VALUES ('',?,?,?,?,?,?)")
    .run(JSON.stringify(policy({ confidenceThreshold: 0.4 })), 1, nodeA, nodeA, "2026-01-01T00:00:00Z", nodeA);
  applyClusterRoutingEvent(db, replicationEvent({ clusterId: LEGACY_CLUSTER_ID, policy: policy({ classifierId: "future-classifier", confidenceThreshold: 0.8 }) }, "2030-01-01T00:00:00Z", nodeB));
  assert.equal(readRoutingPolicy(db, LEGACY_CLUSTER_ID)?.policy.classifierId, "typesafe", "the previous usable policy stays active");
  assert.match(routingPolicyWarning(db, LEGACY_CLUSTER_ID)?.message ?? "", /future-classifier/);
  applyClusterRoutingEvent(db, replicationEvent({ clusterId: LEGACY_CLUSTER_ID, policy: null }, "2031-01-01T00:00:00Z", nodeB));
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


test("defaultRoutingPolicy uses only the approved Codex routing tiers", () => {
  const generated = defaultRoutingPolicy({
    pi: [
      { provider: "openai-codex", id: "gpt-4.1", label: "GPT 4.1" },
      { provider: "openai-codex", id: "gpt-5.6-luna", label: "GPT 5.6 Luna" },
      { provider: "openai-codex", id: "gpt-5.6-terra", label: "GPT 5.6 Terra" },
      { provider: "openai-codex", id: "gpt-5.6-sol", label: "GPT 5.6 Sol" },
      { provider: "openai-codex", id: "gpt-6-astra", label: "GPT 6 Astra" },
    ],
    kiro: [],
  });
  const pi = generated.harnesses.pi.levels;
  assert.deepEqual(Object.entries(pi).filter(([, mapping]) => mapping).map(([level, mapping]) => [level, mapping!.modelId]), [
    ["1", "gpt-5.6-luna"],
    ["4", "gpt-5.6-terra"],
    ["7", "gpt-5.6-sol"],
    ["10", "gpt-6-astra"],
  ]);
  assert.ok(Object.values(generated.harnesses.kiro.levels).every((mapping) => !mapping), "harnesses without approved models stay blank");
  assert.equal(generated.contextMessages, 10);
  assert.doesNotThrow(() => validateRoutingPolicy(generated), "generated defaults must satisfy the policy schema");
});

test("routing policy rejects retired GPT-4 and unapproved Codex models", () => {
  assert.throws(() => validateRoutingPolicy(policy({ harnesses: { pi: { levels: { "1": { provider: "openai-codex", modelId: "gpt-4.1", thinkingLevel: "low", description: "Small obvious request" } } } } })), /not allowed for automatic routing/);
  assert.throws(() => validateRoutingPolicy(policy({ harnesses: { pi: { levels: { "1": { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "low", description: "Small obvious request" } } } } })), /not allowed for automatic routing/);
});

test("every configured model option requires a classifier description", () => {
  const invalid = structuredClone(policy()) as unknown as { harnesses: { kiro: { levels: { "7": Record<string, unknown> } } } };
  delete invalid.harnesses.kiro.levels["7"].description;
  assert.throws(() => validateRoutingPolicy(invalid), /description/);
  assert.equal(policy().harnesses.kiro.levels["7"]?.description, "Complex multi-file work");
});
