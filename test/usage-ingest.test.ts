import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUsageRecords } from "../src/usage-import.js";

const context = { projectId: "project", conversationId: "conversation", createdAt: "2025-01-01T00:00:00.000Z" };
function records(count: number) {
  return Array.from({ length: count }, (_, index) => ({ timestamp: 1735689600000 + index,
    message: { role: "assistant", responseId: `response-${index}`, provider: "synthetic", model: "fixture",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: .1 } } } }));
}

test("normalizer handles more than one ingestion page without dropping requests", () => {
  const first = normalizeUsageRecords("pi", "session", records(63), context);
  const repeated = normalizeUsageRecords("pi", "session", records(63), context);
  const appended = normalizeUsageRecords("pi", "session", records(64), context);
  assert.equal(first.length, 63); assert.equal(new Set(first.map((event) => event.id)).size, 63);
  assert.deepEqual(repeated.map((event) => event.id), first.map((event) => event.id));
  assert.equal(appended.length, 64); assert.ok(Math.abs(appended.reduce((sum, event) => sum + (event.apiCostUsd ?? 0), 0) - 6.4) < 1e-12);
});

test("copied fork records are excluded from attribution", () => {
  const copied = records(1).map((record) => ({ ...record, jointBobUsageOrigin: { sessionId: "parent" } }));
  assert.equal(normalizeUsageRecords("pi", "child", copied, context).length, 0);
});
