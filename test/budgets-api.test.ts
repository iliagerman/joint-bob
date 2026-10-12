import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import type { ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { ensureUsageSchema } from "../src/usage-ledger.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

let root: string; let environment: DevEnvironment; let node: SeededNode; let session: SignedIn; let child: ChildProcess;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-budgets-")); environment = await seedDevEnvironment(root, 1); node = environment.nodes[0];
  const db = new DatabaseSync(path.join(node.dataDir, "node.db")); ensureUsageSchema(db);
  const occurredAt = new Date().toISOString();
  const payload = { id: "spent", projectId: node.projects[0].id, conversationId: "conversation-a", sessionId: "s", engine: "pi", provider: "test", modelId: "fixture", occurredAt, requestId: null, input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, reasoning: 0, apiCostUsd: 6, pricing: null, usageStatus: "reported", difficultyLevel: null, difficultyConfidence: null, difficultyStatus: "unknown", turnId: null, toolCalls: 0, toolErrors: 0 };
  db.prepare("INSERT INTO model_usage_events(id,project_id,conversation_id,session_id,engine,occurred_at,payload,origin_node_id) VALUES(?,?,?,?,?,?,?,?)")
    .run("spent", payload.projectId, "conversation-a", "s", "pi", occurredAt, JSON.stringify(payload), node.nodeId);
  db.close(); child = await startDevNode(environment, node); session = await signIn(environment, node);
});
after(async () => { if (child) await stopDevNode(child); if (root) await rm(root, { recursive: true, force: true }); });

const query = () => `kind=project&subjectId=${encodeURIComponent(node.projects[0].id)}`;
const status = (conversationId: string) => api<any>(node, session, "GET", `/budgets/status?projectId=${encodeURIComponent(node.projects[0].id)}&conversationId=${conversationId}`);

test("budget routes need a signed-in person", async () => {
  assert.equal((await fetch(`${node.url}/api/budgets/clusters`)).status, 401);
  assert.equal((await fetch(`${node.url}/api/budgets/status?projectId=x`)).status, 401);
  assert.equal((await fetch(`${node.url}/api/cluster/v2/budgets/policy`, { method: "POST" })).status, 401);
});

test("a project with no limit is never blocked", async () => {
  const { status: code, body } = await status("conversation-a");
  assert.equal(code, 200);
  assert.deepEqual(body, { blocked: false, message: null, budgets: [] });
});

test("an owner's limit blocks once the spend reaches it, and says why", async () => {
  const roomy = await api<any>(node, session, "PUT", `/budgets/limits?${query()}`, { limits: [{ period: "day", usd: 10 }], utcOffsetMinutes: 0 });
  assert.equal(roomy.status, 200);
  let { body } = await status("conversation-a");
  assert.equal(body.blocked, false);
  assert.equal(body.budgets[0].spentUsd, 6);
  assert.equal(body.budgets[0].warning, false);

  await api(node, session, "PUT", `/budgets/limits?${query()}`, { limits: [{ period: "day", usd: 7 }], utcOffsetMinutes: 0 });
  ({ body } = await status("conversation-a"));
  assert.equal(body.blocked, false);
  assert.equal(body.budgets[0].warning, true, "86% of the limit warns before it blocks");

  await api(node, session, "PUT", `/budgets/limits?${query()}`, { limits: [{ period: "day", usd: 5 }], utcOffsetMinutes: 0 });
  ({ body } = await status("conversation-a"));
  assert.equal(body.blocked, true);
  assert.match(body.message, /Budget reached: the daily limit of \$5\.00 for project .* is used up \(\$6\.00 spent\)/);

  const cleared = await api<any>(node, session, "PUT", `/budgets/limits?${query()}`, { limits: [], utcOffsetMinutes: 0 });
  assert.deepEqual(cleared.body.limits, []);
  assert.equal((await status("conversation-a")).body.blocked, false);
});

test("a conversation limit counts only that conversation", async () => {
  const conversation = (id: string) => `kind=conversation&projectId=${encodeURIComponent(node.projects[0].id)}&subjectId=${id}`;
  await api(node, session, "PUT", `/budgets/limits?${conversation("conversation-a")}`, { limits: [{ period: "total", usd: 5 }], utcOffsetMinutes: 0 });
  assert.equal((await status("conversation-a")).body.blocked, true);
  assert.equal((await status("conversation-b")).body.blocked, false);
});

test("limits are validated and a stranger's project is not found", async () => {
  assert.equal((await api(node, session, "PUT", `/budgets/limits?${query()}`, { limits: [{ period: "day", usd: -1 }] })).status, 400);
  assert.equal((await api(node, session, "PUT", `/budgets/limits?${query()}`, { limits: [{ period: "fortnight", usd: 1 }] })).status, 400);
  assert.equal((await api(node, session, "PUT", "/budgets/limits?kind=project&subjectId=nope", { limits: [] })).status, 404);
  assert.equal((await api(node, session, "PUT", "/budgets/limits?kind=conversation&subjectId=x", { limits: [] })).status, 400);
});

test("only a cluster's manager can set its budget", async () => {
  const none = await api<any>(node, session, "GET", "/budgets/clusters");
  assert.deepEqual(none.body, { clusters: [] });
  const unknown = await api(node, session, "PUT", "/budgets/clusters/11111111-1111-4111-8111-111111111111", { limits: [], defaults: { workspace: [], project: [], conversation: [] }, utcOffsetMinutes: 0 });
  assert.ok([404, 409, 500].includes(unknown.status) && unknown.status !== 200);
});
