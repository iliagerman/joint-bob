import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";
import {
  activeRoutingConfig, applyRoutingConfigEvents, createRoutingConfig, currentRoutingConfigTarget, deleteRoutingConfig, dueRoutingConfigDeliveries, dropRoutingConfigDelivery,
  enqueueRoutingConfigDeliveries, ensureRoutingConfigSchema, listRoutingConfigs, migrateRoutingConfigs, pendingRoutingConfigDeliveryCount, routingConfigDatabase, routingConfigEventFor,
  routingConfigShareTargets, routingConfigWarning, RoutingConfigError, selectedRoutingConfigId, setRoutingConfigSelection, updateRoutingConfig,
} from "../src/routing-configs.js";
import { ensureClusterSharingPolicySchema } from "../src/cluster-sharing-policy.js";
import { ensureSelectiveSharingModeSchema } from "../src/cluster-v2-mode-state.js";
import { ensureRoutingPolicySchema, routingPolicySchema, type RoutingPolicy } from "../src/routing-policy.js";

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

function event(configId: string, operation: "upsert" | "delete", revision: number, extra: { name?: string; policy?: RoutingPolicy } = {}) {
  return { id: randomUUID(), configId, operation, revision, updatedAt: new Date(Date.UTC(2026, 0, revision)).toISOString(), ownerNodeId: nodeA, ...extra };
}

function upsertEvent(configId: string, revision: number, name = "Team routing", policyValue: RoutingPolicy = policy()) {
  return event(configId, "upsert", revision, { name, policy: policyValue });
}

before(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "routing-configs-"));
  // Point the module's resolver at the throwaway directory before any call opens it.
  process.env.PI_WEB_DATA_DIR = dataDirectory;
  const db = routingConfigDatabase();
  db.exec("CREATE TABLE IF NOT EXISTS cluster_node (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.prepare("INSERT OR REPLACE INTO cluster_node (singleton, id, name, url, created_at, updated_at) VALUES (1, ?, 'local', 'http://localhost', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run(nodeB);
});

after(async () => {
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
});

test("a node keeps multiple named configurations, local by default, and selects one independently", () => {
  const db = routingConfigDatabase();
  const first = createRoutingConfig(db, nodeB, "Daily driving", policy());
  const second = createRoutingConfig(db, nodeB, "Heavy lifting", policy({ confidenceThreshold: 0.6 }));
  assert.equal(first.shared, false, "a new configuration stays local until it is explicitly shared");
  assert.equal(first.ownerNodeId, nodeB);
  assert.equal(listRoutingConfigs(db).length, 2, "both configurations coexist");
  assert.equal(activeRoutingConfig(db), null, "without a selection nothing routes");
  setRoutingConfigSelection(db, second.id);
  assert.equal(activeRoutingConfig(db)?.id, second.id);
  assert.equal(selectedRoutingConfigId(db), second.id);
  setRoutingConfigSelection(db, "");
  assert.equal(activeRoutingConfig(db), null, "an empty selection turns routing off");
  deleteRoutingConfig(db, nodeB, first.id);
  deleteRoutingConfig(db, nodeB, second.id);
});

test("a disabled selected configuration does not route", () => {
  const db = routingConfigDatabase();
  const config = createRoutingConfig(db, nodeB, "Paused", policy({ enabled: false }));
  setRoutingConfigSelection(db, config.id);
  assert.equal(activeRoutingConfig(db), null, "a disabled configuration must not route");
  setRoutingConfigSelection(db, "");
  deleteRoutingConfig(db, nodeB, config.id);
});

test("only the original owner may update or delete, locally and through events", () => {
  const db = routingConfigDatabase();
  const configId = randomUUID();
  // A copy received from its owner: the local node can neither edit nor delete it.
  applyRoutingConfigEvents(db, [upsertEvent(configId, 1)], nodeA);
  assert.throws(() => updateRoutingConfig(db, nodeB, configId, { policy: policy() }), RoutingConfigError);
  assert.throws(() => deleteRoutingConfig(db, nodeB, configId), RoutingConfigError);
  // A peer that is not the owner cannot push updates for it either.
  assert.throws(() => applyRoutingConfigEvents(db, [upsertEvent(configId, 2)], nodeB), /Only the owner may distribute/);
  deleteRoutingConfig(db, nodeA, configId);
});

test("sharing never changes the receiver's active selection", () => {
  const db = routingConfigDatabase();
  const own = createRoutingConfig(db, nodeB, "Own choice", policy());
  setRoutingConfigSelection(db, own.id);
  const sharedId = randomUUID();
  applyRoutingConfigEvents(db, [upsertEvent(sharedId, 1)], nodeA);
  assert.equal(selectedRoutingConfigId(db), own.id, "an arriving share must not become active by itself");
  assert.equal(listRoutingConfigs(db).find((config) => config.id === sharedId)?.shared, true);
  // And the receiver may adopt it — that is its own decision.
  setRoutingConfigSelection(db, sharedId);
  assert.equal(activeRoutingConfig(db)?.id, sharedId);
  setRoutingConfigSelection(db, "");
  deleteRoutingConfig(db, nodeA, sharedId);
  deleteRoutingConfig(db, nodeB, own.id);
});

test("a configuration naming an unknown classifier is kept with a warning and stays selectable", () => {
  const db = routingConfigDatabase();
  const future = policy({ classifierId: "future-classifier" });
  const sharedId = randomUUID();
  applyRoutingConfigEvents(db, [upsertEvent(sharedId, 1, "From the future", future)], nodeA);
  const stored = listRoutingConfigs(db).find((config) => config.id === sharedId)!;
  assert.match(routingConfigWarning(stored)!, /future-classifier/);
  setRoutingConfigSelection(db, sharedId);
  assert.equal(activeRoutingConfig(db)?.policy.classifierId, "future-classifier");
  setRoutingConfigSelection(db, "");
  deleteRoutingConfig(db, nodeA, sharedId);
});

test("events converge on the owner's revision and stale events are ignored", () => {
  const db = routingConfigDatabase();
  const id = randomUUID();
  applyRoutingConfigEvents(db, [upsertEvent(id, 3, "v3", policy({ confidenceThreshold: 0.3 }))], nodeA);
  applyRoutingConfigEvents(db, [upsertEvent(id, 2, "v2", policy({ confidenceThreshold: 0.2 }))], nodeA);
  assert.equal(listRoutingConfigs(db).find((config) => config.id === id)?.policy.confidenceThreshold, 0.3, "a stale upsert must not win");
  applyRoutingConfigEvents(db, [upsertEvent(id, 4, "v4", policy({ confidenceThreshold: 0.4 }))], nodeA);
  assert.equal(listRoutingConfigs(db).find((config) => config.id === id)?.policy.confidenceThreshold, 0.4);
  deleteRoutingConfig(db, nodeA, id);
});

test("a delayed delete cannot remove a newer configuration", () => {
  const db = routingConfigDatabase();
  const id = randomUUID();
  applyRoutingConfigEvents(db, [upsertEvent(id, 6, "newest", policy({ confidenceThreshold: 0.6 }))], nodeA);
  // The delete of revision 5 arrives after revision 6 was applied.
  applyRoutingConfigEvents(db, [event(id, "delete", 5)], nodeA);
  assert.ok(listRoutingConfigs(db).some((config) => config.id === id), "a delayed delete must not remove a newer revision");
  deleteRoutingConfig(db, nodeA, id);
});

test("a delayed upsert cannot resurrect a deleted configuration", () => {
  const db = routingConfigDatabase();
  const id = randomUUID();
  applyRoutingConfigEvents(db, [upsertEvent(id, 4, "shared", policy({ confidenceThreshold: 0.4 }))], nodeA);
  applyRoutingConfigEvents(db, [event(id, "delete", 4)], nodeA);
  assert.ok(!listRoutingConfigs(db).some((config) => config.id === id), "the delete removes the shared copy");
  // The original share of revision 4 arrives late; the tombstone must hold.
  applyRoutingConfigEvents(db, [upsertEvent(id, 4, "shared", policy({ confidenceThreshold: 0.4 }))], nodeA);
  assert.ok(!listRoutingConfigs(db).some((config) => config.id === id), "a delayed upsert must not resurrect a deleted configuration");
  // A genuinely newer upsert from the owner is still accepted.
  applyRoutingConfigEvents(db, [upsertEvent(id, 5, "recreated", policy({ confidenceThreshold: 0.5 }))], nodeA);
  assert.ok(listRoutingConfigs(db).some((config) => config.id === id));
  deleteRoutingConfig(db, nodeA, id);
});

test("deleting the selected configuration clears the selection", () => {
  const db = routingConfigDatabase();
  const id = randomUUID();
  applyRoutingConfigEvents(db, [upsertEvent(id, 1)], nodeA);
  setRoutingConfigSelection(db, id);
  applyRoutingConfigEvents(db, [event(id, "delete", 1)], nodeA);
  assert.equal(selectedRoutingConfigId(db), "", "deleting the selected configuration ends that selection");
});

test("duplicate events are acknowledged without reapplying", () => {
  const db = routingConfigDatabase();
  const id = randomUUID();
  const once = upsertEvent(id, 2);
  assert.deepEqual(applyRoutingConfigEvents(db, [once], nodeA), [once.id]);
  assert.deepEqual(applyRoutingConfigEvents(db, [once], nodeA), [once.id], "a replayed event is acknowledged");
  assert.equal(listRoutingConfigs(db).find((config) => config.id === id)?.revision, 2);
  deleteRoutingConfig(db, nodeA, id);
});

test("delivery enrolment keeps one pending event per target and retries survive offline receivers", () => {
  const db = routingConfigDatabase();
  const config = createRoutingConfig(db, nodeB, "Outbox", policy());
  const first = routingConfigEventFor(config);
  const second = routingConfigEventFor({ ...config, revision: 2, policy: policy({ confidenceThreshold: 0.9 }) });
  const targets = [{ nodeId: nodeA, name: "Alpha", url: "http://127.0.0.1:4001", kind: "legacy" as const }];
  enqueueRoutingConfigDeliveries(db, first, targets);
  enqueueRoutingConfigDeliveries(db, second, targets);
  const due = dueRoutingConfigDeliveries(db);
  assert.equal(due.length, 1, "a newer event replaces the older pending one for the same target");
  assert.equal(due[0].event.revision, 2);
  assert.equal(due[0].kind, "legacy");
  assert.equal(due[0].event.policy.confidenceThreshold, 0.9, "the retry carries the newest content");
  dropRoutingConfigDelivery(db, due[0].id);
  deleteRoutingConfig(db, nodeB, config.id);
});

test("due deliveries and pending counts stay scoped to one configuration", () => {
  const db = routingConfigDatabase();
  const owner = createRoutingConfig(db, nodeB, "Outbox", policy());
  const other = createRoutingConfig(db, nodeB, "Other", policy());
  const targets = [{ nodeId: nodeA, name: "Alpha", url: "http://127.0.0.1:4001", kind: "legacy" as const }];
  enqueueRoutingConfigDeliveries(db, routingConfigEventFor(owner), targets);
  enqueueRoutingConfigDeliveries(db, routingConfigEventFor(other), targets);
  assert.equal(dueRoutingConfigDeliveries(db).length, 2, "the unscoped view still covers every configuration");
  assert.deepEqual(dueRoutingConfigDeliveries(db, new Date(), owner.id).map((delivery) => delivery.configId), [owner.id], "a scoped flush reports only the sharing configuration's deliveries");
  assert.equal(pendingRoutingConfigDeliveryCount(db, owner.id), 1, "the pending count is per configuration, not global");
  assert.equal(pendingRoutingConfigDeliveryCount(db), 2, "the global count still serves the maintenance flush");
  deleteRoutingConfig(db, nodeB, owner.id);
  deleteRoutingConfig(db, nodeB, other.id);
});

test("share targets follow membership: legacy peers pair-wise, selective clusters member-wise", () => {
  const db = routingConfigDatabase();
  assert.deepEqual(routingConfigShareTargets(db, nodeB, [{ id: nodeA, name: "Alpha", url: "http://127.0.0.1:4001" }]).map((target) => [target.nodeId, target.kind]), [[nodeA, "legacy"]]);
});

test("pending deliveries re-resolve current eligibility instead of the enrolled cluster", () => {
  const handle = migrationDatabase();
  try {
    handle.exec("INSERT INTO cluster_v2_mode(singleton, active) VALUES (1, 1)");
    handle.exec("CREATE TABLE IF NOT EXISTS cluster_v2_membership_nodes(cluster_id TEXT,node_id TEXT,name TEXT,url TEXT,public_key TEXT,invited_by_node_id TEXT,PRIMARY KEY(cluster_id,node_id))");
    const low = "10000000-0000-4000-8000-000000000001";
    const high = "90000000-0000-4000-8000-000000000009";
    for (const [clusterId, name] of [[low, "First"], [high, "Second"]] as const) {
      handle.prepare("INSERT INTO sharing_clusters(id,name,original_node_id,manager_node_id,manager_epoch,next_join_sequence,closed) VALUES (?,?,?,?,1,3,0)").run(clusterId, name, nodeA, nodeA);
      handle.prepare("INSERT INTO sharing_memberships(cluster_id,node_id,join_sequence) VALUES (?,?,1)").run(clusterId, nodeB);
      handle.prepare("INSERT INTO sharing_memberships(cluster_id,node_id,join_sequence) VALUES (?,?,2)").run(clusterId, nodeA);
      handle.prepare("INSERT INTO cluster_v2_membership_nodes(cluster_id,node_id,name,url,public_key,invited_by_node_id) VALUES (?,?,?,?,?,NULL)").run(clusterId, nodeA, "Alpha", "http://127.0.0.1:4001", "key");
    }
    // A delivery enrolled under the first cluster still resolves while both exist.
    const both = currentRoutingConfigTarget(handle, nodeB, [], nodeA);
    assert.equal(both?.kind, "cluster");
    assert.equal(both?.clusterId, low);
    // The original membership is removed but the second shared cluster remains: the peer
    // stays eligible through it, so the pending delivery must not be dropped.
    handle.prepare("DELETE FROM sharing_memberships WHERE cluster_id = ? AND node_id = ?").run(low, nodeB);
    const throughSecond = currentRoutingConfigTarget(handle, nodeB, [], nodeA);
    assert.equal(throughSecond?.kind, "cluster", "a peer still in a second shared cluster remains a target");
    assert.equal(throughSecond?.clusterId, high, "the push uses the currently shared cluster");
    // No current membership at all: dropped.
    handle.prepare("DELETE FROM sharing_memberships WHERE cluster_id = ? AND node_id = ?").run(high, nodeB);
    assert.equal(currentRoutingConfigTarget(handle, nodeB, [], nodeA), null);
    // A legacy pending stops transmitting once selective mode is active.
    assert.equal(currentRoutingConfigTarget(handle, nodeB, [{ id: nodeA, name: "Alpha", url: "http://127.0.0.1:4001" }], nodeA), null, "legacy targets are not eligible in selective mode");
  } finally { handle.close(); }
});

function migrationDatabase(): DatabaseSync {
  const handle = new DatabaseSync(path.join(dataDirectory, `migrate-${randomUUID()}.db`));
  handle.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensureRoutingPolicySchema(handle);
  ensureRoutingConfigSchema(handle);
  ensureClusterSharingPolicySchema(handle);
  ensureSelectiveSharingModeSchema(handle);
  handle.exec("CREATE TABLE IF NOT EXISTS cluster_node (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  handle.prepare("INSERT INTO cluster_node (singleton, id, name, url, created_at, updated_at) VALUES (1, ?, 'local', 'http://localhost', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run(nodeB);
  return handle;
}

test("legacy cluster policies migrate into locally owned configurations with the selection preserved", () => {
  const handle = migrationDatabase();
  try {
    handle.prepare("INSERT INTO cluster_routing_policies(cluster_id,policy,revision,leader_node_id,updated_by,updated_at,origin_node_id) VALUES ('',?,?,?,?,?,?)")
      .run(JSON.stringify(policy()), 2, nodeA, nodeA, "2026-01-02T00:00:00Z", nodeA);
    const created = migrateRoutingConfigs(handle, nodeB);
    assert.equal(created, 1);
    const configs = listRoutingConfigs(handle);
    assert.equal(configs.length, 1);
    assert.equal(configs[0].ownerNodeId, nodeB, "the local node owns its migrated copy, so it stays editable even if the old leader is gone");
    assert.equal(configs[0].shared, false, "a migrated copy is not implicitly shared");
    assert.equal(configs[0].name, "Migrated cluster routing");
    assert.equal(configs[0].revision, 2);
    assert.equal(selectedRoutingConfigId(handle), configs[0].id, "the previously effective policy stays selected");
    assert.equal((handle.prepare("SELECT count(*) AS count FROM cluster_routing_policies").get() as { count: number }).count, 0, "the retired rows are cleared");
    assert.equal(migrateRoutingConfigs(handle, nodeB), 0, "migration runs once");
  } finally { handle.close(); }
});

test("multiple v2 policies migrate into separate configurations and the effective one is selected", () => {
  const handle = migrationDatabase();
  try {
    handle.exec("INSERT INTO cluster_v2_mode(singleton, active) VALUES (1, 1)");
    handle.exec("CREATE TABLE IF NOT EXISTS cluster_v2_membership_nodes(cluster_id TEXT,node_id TEXT,name TEXT,url TEXT,public_key TEXT,invited_by_node_id TEXT,PRIMARY KEY(cluster_id,node_id))");
    const low = "10000000-0000-4000-8000-000000000001";
    const high = "90000000-0000-4000-8000-000000000009";
    for (const [clusterId, name, enabled, threshold] of [[low, "First", false, 0.2], [high, "Second", true, 0.7]] as const) {
      handle.prepare("INSERT INTO sharing_clusters(id,name,original_node_id,manager_node_id,manager_epoch,next_join_sequence,closed) VALUES (?,?,?,?,1,2,0)").run(clusterId, name, nodeA, nodeA);
      handle.prepare("INSERT INTO sharing_memberships(cluster_id,node_id,join_sequence) VALUES (?,?,1)").run(clusterId, nodeB);
      handle.prepare("INSERT INTO cluster_routing_policies(cluster_id,policy,revision,leader_node_id,updated_by,updated_at,origin_node_id) VALUES (?,?,?,?,?,?,?)")
        .run(clusterId, JSON.stringify(policy({ enabled, confidenceThreshold: threshold })), 1, nodeA, nodeA, "2026-01-02T00:00:00Z", nodeA);
    }
    const created = migrateRoutingConfigs(handle, nodeB);
    assert.equal(created, 2, "both cluster policies become their own configuration");
    const configs = listRoutingConfigs(handle);
    // The old rule — enabled policy of the lowest cluster ID — picked "First", which was
    // disabled, so nothing routed. The migration keeps both copies and names them.
    assert.deepEqual(configs.map((config) => config.name).sort(), ['Migrated "First" routing', 'Migrated "Second" routing']);
    const selected = configs.find((config) => config.id === selectedRoutingConfigId(handle));
    assert.equal(selected?.policy.confidenceThreshold, 0.7, "the enabled policy is the one selected");
    assert.ok(configs.every((config) => config.ownerNodeId === nodeB && !config.shared));
  } finally { handle.close(); }
});
