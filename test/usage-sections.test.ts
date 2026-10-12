// The Costs dashboard reads its parts one at a time so totals show at once and a slow grouping
// does not hold the page back, and polls a cheap status instead of re-reading everything.
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
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-usage-sections-")); environment = await seedDevEnvironment(root, 1); node = environment.nodes[0];
  const db = new DatabaseSync(path.join(node.dataDir, "node.db")); ensureUsageSchema(db);
  const insert = db.prepare("INSERT INTO model_usage_events(id,project_id,conversation_id,session_id,engine,occurred_at,payload,origin_node_id) VALUES(?,?,?,?,?,?,?,?)");
  for (let index = 0; index < 12; index++) {
    const id = `request-${String(index).padStart(2, "0")}`; const occurredAt = `2025-01-${String(index % 4 + 1).padStart(2, "0")}T12:00:00.000Z`;
    const payload = { id, projectId: node.projects[0].id, conversationId: `chat-${index % 6}`, sessionId: `chat-${index % 6}`, engine: "pi", provider: "test", modelId: index % 2 ? "model-a" : "model-b", occurredAt, requestId: null, input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, reasoning: 0, apiCostUsd: 1, pricing: null, usageStatus: "reported", difficultyLevel: null, difficultyConfidence: null, difficultyStatus: "unknown", turnId: null, toolCalls: 0, toolErrors: 0 };
    insert.run(id, payload.projectId, payload.conversationId, payload.sessionId, "pi", occurredAt, JSON.stringify(payload), node.nodeId);
  }
  db.close(); child = await startDevNode(environment, node); session = await signIn(environment, node);
});
after(async () => { if (child) await stopDevNode(child); if (root) await rm(root, { recursive: true, force: true }); });

const usage = (query: string) => api<any>(node, session, "GET", `/usage?refresh=false&${query}`);

test("asking for no sections returns the whole dashboard, as before", async () => {
  const { status, body } = await usage("from=2025-01-01&to=2025-01-31");
  assert.equal(status, 200);
  assert.equal(body.summary.requests, 12);
  assert.deepEqual(Object.keys(body.breakdowns).sort(), ["classifications", "conversations", "days", "difficulties", "models", "projects"]);
  assert.equal(body.conversationPagination.total, 6);
  assert.equal(typeof body.coverage.revision, "number");
});

test("one section returns only that part, with the same numbers as the whole", async () => {
  const whole = (await usage("from=2025-01-01&to=2025-01-31")).body;

  const totals = (await usage("from=2025-01-01&to=2025-01-31&sections=summary")).body;
  assert.deepEqual(totals.summary, whole.summary);
  assert.deepEqual(totals.breakdowns, {}, "no grouping is read for a totals request");
  assert.equal(totals.conversationPagination, undefined);
  assert.equal(totals.conversations, undefined);
  assert.deepEqual(totals.projects, whole.projects, "project names always come along");
  assert.ok(totals.coverage, "coverage always comes along");

  for (const section of ["projects", "classifications", "difficulties", "models", "days"]) {
    const part = (await usage(`from=2025-01-01&to=2025-01-31&sections=${section}`)).body;
    assert.deepEqual(Object.keys(part.breakdowns), [section]);
    assert.deepEqual(part.breakdowns[section], whole.breakdowns[section], `${section} matches the whole dashboard`);
    assert.equal(part.summary, undefined);
  }
  assert.deepEqual(whole.breakdowns.models.map((row: any) => [row.key, row.totals.requests]), [["model-a", 6], ["model-b", 6]]);
  assert.equal(whole.breakdowns.days.length, 4);
});

test("the conversations section pages on its own", async () => {
  const first = (await usage("sections=conversations&pageSize=4&page=1")).body;
  assert.deepEqual(Object.keys(first.breakdowns), ["conversations"]);
  assert.equal(first.breakdowns.conversations.length, 4);
  assert.deepEqual(first.conversationPagination, { page: 1, pageSize: 4, total: 6, totalPages: 2 });
  assert.equal(first.conversations.length, 4, "names for the visible page only");
  const second = (await usage("sections=conversations&pageSize=4&page=2")).body;
  assert.equal(second.breakdowns.conversations.length, 2);
  const keys = [...first.breakdowns.conversations, ...second.breakdowns.conversations].map((row: any) => row.key);
  assert.equal(new Set(keys).size, 6, "no conversation repeats across pages");
});

test("several sections can be asked for together, and unknown ones are refused", async () => {
  const pair = (await usage("sections=models,days")).body;
  assert.deepEqual(Object.keys(pair.breakdowns).sort(), ["days", "models"]);
  assert.equal((await usage("sections=nope")).status, 400);
  assert.equal((await usage("sections=")).status, 400);
  assert.equal((await usage("sections=summary,nope")).status, 400);
});

test("the status route is cheap to poll and needs a signed-in person", async () => {
  assert.equal((await fetch(`${node.url}/api/usage/status`)).status, 401);
  const { status, body } = await api<any>(node, session, "GET", "/usage/status");
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["error", "refreshedAt", "refreshing", "revision"]);
  assert.equal(typeof body.refreshing, "boolean");
  const coverage = (await usage("sections=summary")).body.coverage;
  assert.equal(coverage.revision, body.revision, "an unchanged ledger keeps its revision, so a poll finds nothing to reload");
});
