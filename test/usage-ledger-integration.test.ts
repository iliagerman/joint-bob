import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { ConversationRecord } from "../src/conversation-records.js";
import { applyUsageEvent, ensureUsageSchema, latestDifficultyForConversation, saveDifficulty, saveUsageEvent, saveUsageEvents, usageBreakdown, usageConversations, usageDatabase, usageInventoryCoverage, usageTotals, upsertUsageInventory } from "../src/usage-ledger.js";
import { ingestUsageSessions } from "../src/usage-ingest.js";
import { ensureReplicationSchema } from "../src/replication.js";
import type { ProjectRecord, SessionSummary } from "../src/types.js";
import type { UsageEvent } from "../src/usage-types.js";

const db = usageDatabase();
const now = "2025-01-01T00:00:00.000Z";
function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return { id: "pi:event", projectId: "p", conversationId: "c", sessionId: "s", engine: "pi", provider: "anthropic", modelId: "m", occurredAt: now, requestId: "native-request", input: 100, output: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, reasoning: null, apiCostUsd: null, pricing: null, usageStatus: "reported", difficultyLevel: null, difficultyConfidence: null, difficultyStatus: "not-classified", turnId: null, toolCalls: 0, toolErrors: 0, ...overrides };
}
function stored(id = "pi:event"): UsageEvent { return JSON.parse((db.prepare("SELECT payload FROM model_usage_events WHERE id=?").get(id) as { payload: string }).payload) as UsageEvent; }
beforeEach(() => {
  for (const table of ["model_usage_events", "usage_difficulty", "usage_inventory", "replication_outbox"]) db.exec(`DELETE FROM ${table}`);
  db.exec("DROP TABLE IF EXISTS name_overrides; DROP TABLE IF EXISTS project_aliases");
});

test("registry pricing snapshot is frozen, replicated exactly, and duplicates are idempotent", () => {
  const pricing = { source: "registry", capturedAt: now, rates: { input: 1, output: 2 } };
  saveUsageEvent(event({ input: 100, output: 10, pricing, apiCostUsd: .00012 }), "n");
  saveUsageEvent(event({ output: 20, pricing: { ...pricing, rates: { input: 100, output: 100 } }, apiCostUsd: .002 }), "n");
  assert.equal(stored().apiCostUsd, .00014); assert.deepEqual(stored().pricing, pricing);
  const row = db.prepare("SELECT * FROM replication_outbox ORDER BY created_at DESC LIMIT 1").get() as { payload: string };
  const payload = JSON.parse(row.payload) as { event: UsageEvent; projectId: string; originNodeId: string };
  assert.deepEqual(payload.event, stored());
  const replica = new DatabaseSync(":memory:"); ensureUsageSchema(replica); ensureReplicationSchema(replica);
  applyUsageEvent(replica, { id: "r", originNodeId: "n", entityType: "model.usage", entityKey: payload.event.id, operation: "upsert", payload, createdAt: now });
  assert.deepEqual(JSON.parse((replica.prepare("SELECT payload FROM model_usage_events").get() as { payload: string }).payload), stored());
  const count = (db.prepare("SELECT count(*) n FROM replication_outbox").get() as { n: number }).n; saveUsageEvent(event({ output: 20, pricing, apiCostUsd: .00014 }), "n"); assert.equal((db.prepare("SELECT count(*) n FROM replication_outbox").get() as { n: number }).n, count);
});

test("native prices upgrade without registry recomputation and invalid batches roll back", () => {
  const native = { source: "pi-reported", capturedAt: now, rates: { input: 99, output: 99 } };
  saveUsageEvent(event({ output: 1, apiCostUsd: .645, pricing: native }), "n"); saveUsageEvent(event({ output: 2, apiCostUsd: 1.123, pricing: native }), "n");
  assert.equal(stored().apiCostUsd, 1.123); assert.equal(stored().pricing?.source, "pi-reported");
  saveUsageEvent(event({ id: "upgrade", usageStatus: "missing" }), "n"); saveUsageEvent(event({ id: "upgrade", output: 11, apiCostUsd: .5, pricing: native }), "n"); assert.equal(stored("upgrade").pricing?.source, "pi-reported");
  const before = (db.prepare("SELECT count(*) n FROM model_usage_events").get() as { n: number }).n;
  assert.throws(() => saveUsageEvents([event({ id: "batch" }), event({ id: "bad", input: -1 })], "n")); assert.equal((db.prepare("SELECT count(*) n FROM model_usage_events").get() as { n: number }).n, before);
});

test("an event id cannot move to another session", () => { saveUsageEvent(event({ apiCostUsd: 1 }), "n"); saveUsageEvent(event({ sessionId: "other", output: 999, apiCostUsd: 9 }), "n"); assert.equal(stored().sessionId, "s"); assert.equal(usageTotals({ projectIds: ["p"] }).apiCostUsd, 1); });

test("difficulty intervals close inclusively and inheritance respects newer manual or configuration", () => {
  saveUsageEvent(event({ occurredAt: "2025-01-01T00:00:01.000Z" }), "n");
  const base = { turnId: "t", projectId: "p", conversationId: "c", sessionId: "s", engine: "pi", occurredAt: now, status: "classified", level: 7, confidence: 1, configId: "cfg", configRevision: 1, startedAt: now, endedAt: "2025-01-01T00:00:01.000Z" };
  saveDifficulty(base, "n"); assert.equal(usageBreakdown({ projectIds: ["p"] }, "difficulty")[0].key, "7"); saveDifficulty({ ...base, endedAt: null }, "n"); assert.equal(usageBreakdown({ projectIds: ["p"] }, "difficulty")[0].key, "7");
  saveDifficulty({ ...base, turnId: "manual", occurredAt: "2025-01-02T00:00:00.000Z", status: "manual", level: 8 }, "n"); assert.equal(latestDifficultyForConversation("p", "c", "cfg", 1), null); assert.equal(latestDifficultyForConversation("p", "c", "other", 1), null);
});

test("inventory availability excludes empty drafts and labels use current optional overrides", () => {
  upsertUsageInventory({ projectId: "p", conversationId: "c", sessionId: "k", engine: "kiro", title: "K", classification: "Old", usageStatus: "unavailable" }); upsertUsageInventory({ projectId: "p", conversationId: "draft", sessionId: "d", engine: "kiro", title: "D", classification: null, usageStatus: "empty" });
  assert.equal(usageTotals({ projectIds: ["p"] }).unavailableSessions, 1); assert.equal(usageConversations(["p"]).length, 2);
  db.exec("CREATE TABLE name_overrides(scope TEXT,key TEXT,name TEXT,PRIMARY KEY(scope,key))"); db.prepare("INSERT INTO name_overrides VALUES(?,?,?)").run("session_classifications", "c", "New"); assert.equal((usageConversations(["p"]) as Array<{conversationId:string;classification:string}>).find((row) => row.conversationId === "c")?.classification, "New"); db.exec("DELETE FROM name_overrides"); assert.equal((usageConversations(["p"]) as Array<{conversationId:string;classification:string}>).find((row) => row.conversationId === "c")?.classification, "Unclassified");
});

test("project aliases canonicalize totals, groups, difficulty, and replicated requests", () => {
  db.exec("CREATE TABLE project_aliases(alias_id TEXT PRIMARY KEY,project_id TEXT NOT NULL)"); db.prepare("INSERT INTO project_aliases VALUES('old','new')").run(); saveUsageEvent(event({ projectId: "old" }), "n");
  assert.equal(usageTotals({ projectIds: ["new"] }).requests, 1); assert.equal(usageBreakdown({ projectIds: ["new"] }, "project")[0].key, "new");
  saveDifficulty({ turnId: "a", projectId: "old", conversationId: "c", sessionId: "s", engine: "pi", occurredAt: now, status: "classified", level: 7, confidence: 1, startedAt: now, endedAt: now }, "n"); assert.equal(usageBreakdown({ projectIds: ["new"] }, "difficulty")[0].key, "7");
});

test("replicated event-only conversations are visible once, titled safely, classified currently, and scoped", () => {
  saveUsageEvent(event(), "n"); saveUsageEvent(event({ id: "two", sessionId: "s2" }), "n"); saveUsageEvent(event({ id: "other", projectId: "deleted", conversationId: "x" }), "n");
  db.exec("CREATE TABLE name_overrides(scope TEXT,key TEXT,name TEXT,PRIMARY KEY(scope,key)); INSERT INTO name_overrides VALUES('session_classifications','c','Current')");
  assert.deepEqual((usageConversations(["p"]) as object[]).map((row) => ({ ...row })), [{ projectId: "p", conversationId: "c", title: "c", classification: "Current", usageStatus: "reported" }]); assert.equal(usageInventoryCoverage(["p"]).projects, 0);
});

test("file ingestion imports many sessions, switched segments, subagents, and appended requests idempotently", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "joint-bob-usage-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "project");
  await mkdir(root);
  const project: ProjectRecord = { id: "ingest-project", name: "Ingest", path: root, createdAt: now, updatedAt: now };
  const sessions: SessionSummary[] = [];
  const records: ConversationRecord[] = [];
  const piRecord = (responseId: string, timestamp: number | string = 1735689600000) => ({ timestamp, message: { role: "assistant", responseId, provider: "openai-codex", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: .01 } } } });
  const writePiSession = async (id: string, responseId: string) => {
    const file = path.join(root, `${id}.jsonl`);
    await writeFile(file, `${JSON.stringify({ type: "session", id, timestamp: now })}\n${JSON.stringify(piRecord(responseId))}\n`);
    sessions.push({ id, path: file, harnessId: "pi", agentId: "pi", agentLabel: "Pi", title: id, createdAt: now });
    return file;
  };
  for (let index = 0; index < 64; index++) await writePiSession(`plain-${index}`, `plain-response-${index}`);
  const pathA = await writePiSession("sA", "segment-response-a");
  await writePiSession("sB", "segment-response-b");
  sessions.find((session) => session.id === "sA")!.conversationId = "switched";
  sessions.find((session) => session.id === "sB")!.conversationId = "switched";
  for (const [index, sessionId] of ["sA", "sB"].entries()) records.push({ projectId: project.id, engine: "pi", sessionId, conversationId: "switched", segmentIndex: index, createdAt: now, updatedAt: now, originNodeId: "test", taskId: null });
  const childPath = path.join(root, "child.jsonl");
  const child = { type: "assistant", timestamp: "2025-01-01T00:00:01.000Z", message: { role: "assistant", id: "child-response", model: "unknown-ingestion-fixture", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
  await writeFile(childPath, `${JSON.stringify({ type: "session", id: "child", timestamp: now })}\n${JSON.stringify(child)}\n`);
  sessions.push({ id: "child", path: childPath, harnessId: "claude", agentId: "claude", agentLabel: "Claude", title: "child", createdAt: now, readOnly: true, parentSessionPath: pathA });

  await ingestUsageSessions(project, sessions, records);
  assert.equal(usageTotals({ projectIds: [project.id] }).requests, 67);
  assert.equal(usageTotals({ projectIds: [project.id], conversationId: "switched" }).requests, 3);
  const eventCount = (db.prepare("SELECT count(*) n FROM model_usage_events").get() as { n: number }).n;
  const outboxCount = (db.prepare("SELECT count(*) n FROM replication_outbox").get() as { n: number }).n;
  await ingestUsageSessions(project, sessions, records);
  assert.equal((db.prepare("SELECT count(*) n FROM model_usage_events").get() as { n: number }).n, eventCount);
  assert.equal((db.prepare("SELECT count(*) n FROM replication_outbox").get() as { n: number }).n, outboxCount);
  await appendFile(sessions[0].path, `${JSON.stringify(piRecord("appended-response", "2025-01-01T00:00:02.000Z"))}\n`);
  await ingestUsageSessions(project, sessions, records);
  assert.equal(usageTotals({ projectIds: [project.id] }).requests, 68);
});
