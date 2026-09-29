import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { priceUsage } from "../src/usage-pricing.js";
import { saveUsageEvent, saveUsageEvents, usageDatabase, usageTotals } from "../src/usage-ledger.js";
import type { UsageEvent } from "../src/usage-types.js";

const db = usageDatabase();
beforeEach(() => db.exec("DELETE FROM model_usage_events; DELETE FROM usage_inventory; DELETE FROM replication_outbox;"));
function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return { id: "request", projectId: "project", conversationId: "conversation", sessionId: "session", engine: "pi", provider: "provider", modelId: "model",
    occurredAt: "2025-01-01T00:00:00.000Z", requestId: null, input: 10, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0,
    cacheWriteUnknown: 0, reasoning: 2, apiCostUsd: null, pricing: null, usageStatus: "reported", difficultyLevel: null,
    difficultyConfidence: null, difficultyStatus: "not-classified", turnId: null, toolCalls: 0, toolErrors: 0, ...overrides };
}
function stored(): UsageEvent { return JSON.parse((db.prepare("SELECT payload FROM model_usage_events").get() as { payload: string }).payload) as UsageEvent; }

test("pricing an event ignores nullable metadata", () => {
  assert.equal(priceUsage(event(), { input: 1, output: 2 }), .00002);
});

test("native request updates retain exact cost and canonical owner", () => {
  const pricing = { source: "pi-reported", capturedAt: "2025-01-01T00:00:00.000Z", rates: { input: 99, output: 99 } };
  saveUsageEvent(event({ apiCostUsd: .7, pricing }), "node");
  saveUsageEvent(event({ projectId: "other", conversationId: "other", output: 50, apiCostUsd: .7, pricing }), "node");
  assert.equal(stored().apiCostUsd, .7); assert.equal(stored().projectId, "project");
  assert.deepEqual(usageTotals({ projectIds: ["project"] }), { apiCostUsd: .7, input: 10, output: 50, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, reasoning: 2, totalTokens: 60, requests: 1, pricedRequests: 1, missingRequests: 0, unavailableSessions: 0, toolCalls: 0, toolErrors: 0, partial: false });
});

test("catalog updates retain captured rates and later tool errors", () => {
  const old = { source: "runtime-catalog", capturedAt: "2025-01-01T00:00:00.000Z", rates: { input: 1, output: 1 } };
  const newer = { source: "runtime-catalog", capturedAt: "2025-02-01T00:00:00.000Z", rates: { input: 100, output: 100 } };
  saveUsageEvent(event({ pricing: old, apiCostUsd: .000015 }), "node");
  saveUsageEvent(event({ output: 10, pricing: newer, apiCostUsd: .002 }), "node");
  saveUsageEvent(event({ output: 10, pricing: newer, apiCostUsd: .002, toolCalls: 1, toolErrors: 1 }), "node");
  assert.equal(stored().apiCostUsd, .00002); assert.equal(stored().pricing?.capturedAt, old.capturedAt); assert.equal(stored().toolErrors, 1);
});

test("malformed usage batch rolls back every event", () => {
  assert.throws(() => saveUsageEvents([event(), { ...event({ id: "bad" }), input: -1 }], "node"));
  assert.equal((db.prepare("SELECT count(*) count FROM model_usage_events").get() as { count: number }).count, 0);
});
