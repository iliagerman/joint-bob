import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import type { ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { ensureClusterSharingPolicySchema } from "../src/cluster-sharing-policy.js";
import { ensureUsageSchema } from "../src/usage-ledger.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

let root: string; let environment: DevEnvironment; let node: SeededNode; let session: SignedIn; let child: ChildProcess;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-usage-integration-")); environment = await seedDevEnvironment(root, 1); node = environment.nodes[0];
  const db = new DatabaseSync(path.join(node.dataDir, "node.db")); ensureUsageSchema(db);
  const insert = db.prepare("INSERT INTO model_usage_events(id,project_id,conversation_id,session_id,engine,occurred_at,payload,origin_node_id) VALUES(?,?,?,?,?,?,?,?)");
  for (let index = 0; index < 45; index++) {
    const id = `pagination-${String(index).padStart(2, "0")}`; const occurredAt = `2025-01-${String(index % 28 + 1).padStart(2, "0")}T12:00:00.000Z`;
    const payload = { id, projectId: node.projects[0].id, conversationId: id, sessionId: id, engine: "pi", provider: "test", modelId: "fixture", occurredAt, requestId: null, input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, reasoning: 0, apiCostUsd: 1, pricing: null, usageStatus: "reported", difficultyLevel: null, difficultyConfidence: null, difficultyStatus: "unknown", turnId: null, toolCalls: 0, toolErrors: 0 };
    insert.run(id, payload.projectId, id, id, "pi", occurredAt, JSON.stringify(payload), node.nodeId);
  }
  db.close(); child = await startDevNode(environment, node); session = await signIn(environment, node);
});
after(async () => { if (child) await stopDevNode(child); if (root) await rm(root, { recursive: true, force: true }); });

test("usage API rejects unauthenticated fetch", async () => assert.equal((await fetch(`${node.url}/api/usage`)).status, 401));
test("usage API rejects malformed and reversed dates", async () => {
  assert.equal((await api(node, session, "GET", "/usage?from=2025-99-01")).status, 400);
  assert.equal((await api(node, session, "GET", "/usage?from=2025-02-02&to=2025-01-01")).status, 400);
});
test("usage API rejects an unknown project", async () => assert.equal((await api(node, session, "GET", "/usage?projectId=unknown")).status, 404));
test("usage API validates pagination", async () => {
  for (const query of ["page=0", "page=-1", "pageSize=0", "pageSize=51", "page=nope"]) assert.equal((await api(node, session, "GET", `/usage?refresh=false&${query}`)).status, 400);
});
test("real usage fixture pages 20/20/5 stably without changing summary", async () => {
  const pages = await Promise.all([1, 2, 3].map((page) => api<any>(node, session, "GET", `/usage?refresh=false&page=${page}&pageSize=20`)));
  assert.deepEqual(pages.map(({ body }) => body.breakdowns.conversations.length), [20, 20, 5]);
  assert.deepEqual(pages.map(({ body }) => body.summary), [pages[0].body.summary, pages[0].body.summary, pages[0].body.summary]);
  assert.equal(pages[0].body.conversationPagination.total, 45);
  assert.equal(pages.every(({ body }) => body.conversations.length <= 20), true, "conversation metadata is bounded to the visible page");
  const repeated = await api<any>(node, session, "GET", "/usage?refresh=false&page=1&pageSize=20");
  assert.deepEqual(repeated.body.breakdowns.conversations.map((row: any) => row.key), pages[0].body.breakdowns.conversations.map((row: any) => row.key));
});
test("usage refresh requires authentication and CSRF, then accepts asynchronously", async () => {
  assert.equal((await fetch(`${node.url}/api/usage/refresh`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${node.url}/api/usage/refresh`, { method: "POST", headers: { Cookie: session.cookie } })).status, 403);
  assert.equal((await api(node, session, "POST", "/usage/refresh")).status, 202);
});
test("manual subscription persists, validates price, and deletes", async () => {
  const payload = { harnessId: "claude", provider: "anthropic", accountLabel: "work", planName: "Max", price: { amount: 200, currency: "USD", billingPeriod: "month" }, renewalAt: null, quotaWindows: [], status: "available", source: "manual" };
  const saved = await api<{ id: string }>(node, session, "PUT", "/subscription-usage", payload); assert.equal(saved.status, 200);
  const pi = await api<{ id: string }>(node, session, "PUT", "/subscription-usage", { ...payload, harnessId: "pi", provider: "", accountLabel: "personal", price: { ...payload.price, amount: 20 } }); assert.equal(pi.status, 200);
  const legacy = await api<{ id: string }>(node, session, "PUT", "/subscription-usage", { ...payload, harnessId: undefined, provider: "legacy-provider", accountLabel: "legacy" }); assert.equal(legacy.status, 200);
  const listed = await api<{ plans: Array<{ id: string; harnessId: string|null; provider: string; price: { amount: number } }> }>(node, session, "GET", "/subscription-usage");
  assert.equal(listed.body.plans.find(plan => plan.id === saved.body.id)?.harnessId, "claude");
  assert.equal(listed.body.plans.find(plan => plan.id === pi.body.id)?.harnessId, "pi");
  assert.equal(listed.body.plans.find(plan => plan.id === legacy.body.id)?.harnessId, null);
  assert.equal(listed.body.plans.find(plan => plan.id === legacy.body.id)?.provider, "legacy-provider");
  assert.equal((await api(node, session, "PUT", "/subscription-usage", { ...payload, price: { ...payload.price, amount: -1 } })).status, 400);
  const response = await fetch(`${node.url}/api/subscription-usage/${saved.body.id}`, { method: "DELETE", headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken } }); assert.equal(response.status, 204);
});
test("custom label filter is accepted and accounts are not exposed", async () => {
  const response = await api<Record<string, unknown>>(node, session, "GET", "/usage?classification=Custom%20label"); assert.equal(response.status, 200); assert.equal("accounts" in response.body, false);
});
test("usage API filters by the node the usage was recorded on", async () => {
  const clusterId = "6f1f6a8e-2b0e-4c55-9f53-0d1b6e2a7c11";
  const peerId = "9b2c7d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d";
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  ensureClusterSharingPolicySchema(db);
  db.prepare("INSERT INTO sharing_clusters(id,name,original_node_id,manager_node_id,manager_epoch,next_join_sequence,closed) VALUES(?,?,?,?,1,3,0)").run(clusterId, "Usage cluster", node.nodeId, node.nodeId);
  db.prepare("INSERT INTO sharing_memberships(cluster_id,node_id,join_sequence) VALUES(?,?,1),(?,?,2)").run(clusterId, node.nodeId, clusterId, peerId);
  const payload = { id: "peer-usage", projectId: node.projects[0].id, conversationId: "peer-usage", sessionId: "peer-usage", engine: "pi", provider: "test", modelId: "fixture", occurredAt: "2025-02-01T12:00:00.000Z", requestId: null, input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, reasoning: 0, apiCostUsd: 7, pricing: null, usageStatus: "reported", difficultyLevel: null, difficultyConfidence: null, difficultyStatus: "unknown", turnId: null, toolCalls: 0, toolErrors: 0 };
  db.prepare("INSERT INTO model_usage_events(id,project_id,conversation_id,session_id,engine,occurred_at,payload,origin_node_id) VALUES(?,?,?,?,?,?,?,?)").run(payload.id, payload.projectId, payload.id, payload.id, "pi", payload.occurredAt, JSON.stringify(payload), peerId);
  try {
    const cost = async (query: string) => (await api<any>(node, session, "GET", `/usage?refresh=false&${query}`)).body.summary.apiCostUsd;
    assert.equal(await cost("clusters=local"), 45, "this node excludes the peer's usage");
    assert.equal(await cost(`clusters=${clusterId}`), 7, "a cluster is its other members");
    assert.equal(await cost(`clusters=local,${clusterId}`), 52);
    assert.equal(await cost(""), 52);
    assert.equal((await api(node, session, "GET", "/usage?refresh=false&clusters=00000000-0000-4000-8000-000000000000")).status, 404);
    assert.equal((await api(node, session, "GET", "/usage?refresh=false&clusters=not-a-cluster")).status, 400);
  } finally {
    db.exec(`DELETE FROM model_usage_events WHERE id='peer-usage'; DELETE FROM sharing_memberships WHERE cluster_id='${clusterId}'; DELETE FROM sharing_clusters WHERE id='${clusterId}';`);
    db.close();
  }
});
