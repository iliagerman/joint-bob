import assert from "node:assert/strict";
import test from "node:test";
import { clearUsageTotalsCache, saveUsageEvent, usageDatabase, usageTotals, upsertUsageInventory } from "../src/usage-ledger.js";
import type { UsageEvent } from "../src/usage-types.js";

function event(id: string, overrides: Partial<UsageEvent> = {}): UsageEvent {
  return { id, projectId: "cost-project", conversationId: "conversation", sessionId: "session", engine: "pi", provider: "fixture", modelId: "fixture",
    occurredAt: "2026-01-01T00:00:00.000Z", requestId: null, input: 10, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0,
    cacheWriteUnknown: 0, reasoning: null, apiCostUsd: 0.25, pricing: null, usageStatus: "reported", difficultyLevel: null,
    difficultyConfidence: null, difficultyStatus: "not-classified", turnId: null, toolCalls: 1, toolErrors: 0, ...overrides };
}

test("cold listing totals read numeric index entries, not every event's JSON payload", t => {
  const db = usageDatabase();
  const count = 20_000;
  const insert = db.prepare("INSERT INTO model_usage_events VALUES(?,?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < count; i++) {
    const value = event(`cost-${i}`, { conversationId: `c-${i % 100}`, sessionId: `s-${i % 100}` });
    insert.run(value.id, value.projectId, value.conversationId, value.sessionId, value.engine, value.occurredAt, JSON.stringify(value), "node");
  }
  db.exec("COMMIT");
  t.after(() => { db.exec("DELETE FROM model_usage_events WHERE project_id='cost-project'"); clearUsageTotalsCache(); });
  const prepare = db.prepare.bind(db);
  const queries: string[] = [];
  const spy = t.mock.method(db, "prepare", (sql: string) => { if (sql.startsWith("SELECT COUNT(*) requests")) queries.push(sql); return prepare(sql); });
  for (const filters of [{ projectIds: ["cost-project"] }, { projectIds: ["cost-project"], conversationId: "c-1" }]) {
    clearUsageTotalsCache();
    const start = performance.now();
    const totals = usageTotals(filters);
    t.diagnostic(`${filters.conversationId ? "conversation" : "project"} cold totals: ${(performance.now() - start).toFixed(1)} ms`);
    const expected = filters.conversationId ? count / 100 : count;
    assert.equal(totals.requests, expected);
    assert.equal(totals.apiCostUsd, expected / 4);
    assert.equal(totals.totalTokens, expected * 15);
  }
  spy.mock.restore();
  assert.equal(queries.length, 2);
  for (const [i, sql] of queries.entries()) {
    const args = i ? ["cost-project", "c-1"] : ["cost-project"];
    const operations = prepare(`EXPLAIN ${sql}`).all(...args) as Array<{ opcode: string; p4: string | null }>;
    assert.ok(!operations.some(row => row.opcode === "Function" && row.p4?.startsWith("json_extract")),
      "listing totals must not decode the entire event history after each usage write");
  }
});

test("indexed totals preserve missing and free usage, upgrades, inventory, and filtered reads", t => {
  const db = usageDatabase();
  t.after(() => { db.exec("DELETE FROM model_usage_events WHERE project_id='cost-project'; DELETE FROM usage_inventory WHERE project_id='cost-project'"); clearUsageTotalsCache(); });
  saveUsageEvent(event("free", { apiCostUsd: 0 }), "node");
  saveUsageEvent(event("missing", { apiCostUsd: null, usageStatus: "missing", input: null, output: null }), "node");
  const filters = { projectIds: ["cost-project"] };
  let totals = usageTotals(filters);
  assert.deepEqual([totals.requests, totals.pricedRequests, totals.missingRequests, totals.apiCostUsd, totals.partial], [2, 1, 1, 0, true]);
  saveUsageEvent(event("missing", { output: 20, pricing: { source: "pi-reported", capturedAt: "2026-01-01T00:00:00.000Z" } }), "node");
  totals = usageTotals(filters);
  assert.deepEqual([totals.requests, totals.pricedRequests, totals.missingRequests, totals.apiCostUsd, totals.partial], [2, 2, 0, 0.25, false]);
  upsertUsageInventory({ projectId: "cost-project", conversationId: "other", sessionId: "other", engine: "kiro", title: "Other", classification: null, usageStatus: "unavailable" });
  assert.equal(usageTotals(filters).unavailableSessions, 1);
  assert.equal(usageTotals({ ...filters, provider: "other" }).requests, 0);
  assert.equal(usageTotals({ ...filters, modelId: "fixture", from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" }).requests, 2);
  assert.equal(usageTotals({ ...filters, originNodeIds: ["other"] }).requests, 0);
});
