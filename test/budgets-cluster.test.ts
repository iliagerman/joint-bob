// A cluster's manager sets its budget: it limits the manager's own projects at once, reaches
// the other members, and is theirs to read but not to change.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensureUsageSchema } from "../src/usage-ledger.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

async function eventually(check: () => Promise<void>, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await check(); return; } catch (error) { if (Date.now() > deadline) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
const policy = (patch: Record<string, unknown> = {}) => ({ limits: [{ period: "day", usd: 5 }], defaults: { workspace: [], project: [], conversation: [{ period: "total", usd: 2 }] }, utcOffsetMinutes: 0, ...patch });

test("the manager's cluster budget limits its projects, reaches members, and only the manager can change it", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "budgets-cluster-"));
  const environment = await seedDevEnvironment(root, 2);
  const [manager, member] = environment.nodes;
  const project = manager.projects[0];
  const db = new DatabaseSync(path.join(manager.dataDir, "node.db")); ensureUsageSchema(db);
  const occurredAt = new Date().toISOString();
  const event = (id: string, conversationId: string, cost: number) => ({ id, projectId: project.id, conversationId, sessionId: id, engine: "pi", provider: "test", modelId: "fixture", occurredAt, requestId: null, input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, reasoning: 0, apiCostUsd: cost, pricing: null, usageStatus: "reported", difficultyLevel: null, difficultyConfidence: null, difficultyStatus: "unknown", turnId: null, toolCalls: 0, toolErrors: 0 });
  for (const row of [event("a", "chat-a", 3), event("b", "chat-b", 1)]) {
    db.prepare("INSERT INTO model_usage_events(id,project_id,conversation_id,session_id,engine,occurred_at,payload,origin_node_id) VALUES(?,?,?,?,?,?,?,?)").run(row.id, row.projectId, row.conversationId, row.sessionId, "pi", occurredAt, JSON.stringify(row), manager.nodeId);
  }
  db.close();
  const children = [await startDevNode(environment, manager), await startDevNode(environment, member)];
  try {
    const managerSession = await signIn(environment, manager), memberSession = await signIn(environment, member);
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(manager, managerSession, "POST", "/clusters", { name: "Team" });
    assert.equal(created.status, 201);
    const clusterId = created.body.snapshot.body.clusterId;
    const invitation = await api<{ link: string }>(manager, managerSession, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(member, memberSession, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    assert.equal((await api(manager, managerSession, "POST", `/clusters/${clusterId}/share-all-projects`, {})).status, 200);

    const statusOf = async (conversation: string) => (await api<any>(manager, managerSession, "GET", `/budgets/status?projectId=${encodeURIComponent(project.id)}&conversationId=${conversation}`)).body;
    assert.equal((await statusOf("chat-a")).blocked, false, "no budget yet");

    // $4 is spent across the project: under the $5 cluster limit, but chat-a ($3) is over its $2 default.
    const set = await api<any>(manager, managerSession, "PUT", `/budgets/clusters/${clusterId}`, policy());
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.isManager, true);
    assert.equal(set.body.revision, 1);
    const chatA = await statusOf("chat-a");
    assert.equal(chatA.blocked, true);
    assert.match(chatA.message, /total limit of \$2\.00 for this conversation is used up \(\$3\.00 spent\).*The cluster manager set this limit/);
    assert.equal((await statusOf("chat-b")).blocked, false, "the same default leaves a conversation under it alone");

    // A tighter cluster total stops every conversation in the project.
    await api(manager, managerSession, "PUT", `/budgets/clusters/${clusterId}`, policy({ limits: [{ period: "day", usd: 4 }] }));
    const total = await statusOf("chat-b");
    assert.equal(total.blocked, true);
    assert.match(total.message, /daily limit of \$4\.00 for cluster Team/);

    // The member receives it, sees it as read-only, and cannot change it.
    await eventually(async () => {
      const seen = await api<any>(member, memberSession, "GET", "/budgets/clusters");
      assert.equal(seen.body.clusters.length, 1);
      assert.equal(seen.body.clusters[0].revision, 2);
      assert.equal(seen.body.clusters[0].isManager, false);
      assert.equal(seen.body.clusters[0].policy.limits[0].usd, 4);
    });
    const refused = await api(member, memberSession, "PUT", `/budgets/clusters/${clusterId}`, policy({ limits: [] }));
    assert.equal(refused.status, 403);
    await eventually(async () => {
      const view = (await api<any>(manager, managerSession, "GET", "/budgets/clusters")).body.clusters[0];
      assert.deepEqual(view.pendingNodeIds, [], "the manager sees the member confirmed");
    });

    // Clearing the budget lifts the block.
    await api(manager, managerSession, "PUT", `/budgets/clusters/${clusterId}`, policy({ limits: [], defaults: { workspace: [], project: [], conversation: [] } }));
    assert.equal((await statusOf("chat-a")).blocked, false);
  } finally {
    for (const child of children) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
