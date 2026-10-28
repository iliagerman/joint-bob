import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAutomationExecution } from "../src/automation-executions.js";
import { ensureUsageSchema, usageEventSchema } from "../src/usage-ledger.js";
import { queryAutomationExecutions } from "../src/automation-execution-report.js";

test("execution report filters inaccessible projects and computes totals over all pages", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensureUsageSchema(db);
    const first = randomUUID(), second = randomUUID();
    for (const [id, projectId, status, day] of [[first, "visible", "succeeded", "2026-01-01"], [second, "hidden", "failed", "2026-01-02"]] as const) {
      createAutomationExecution(db, { id, sourceKind: "scheduled", sourceId: "task", sourceName: "Nightly", workspaceId: "w", projectId, ownerNodeId: "node", engine: "pi", requestId: id, sessionId: id, tags: [{ key: "nightly", name: "Nightly", managedTagId: null }], status, error: null, acceptedAt: `${day}T01:00:00.000Z`, startedAt: `${day}T01:01:00.000Z`, finishedAt: `${day}T01:03:00.000Z` });
    }
    createAutomationExecution(db, { id: randomUUID(), sourceKind: "webhook", sourceId: "hook", sourceName: "Deploy", workspaceId: "w", projectId: "visible", ownerNodeId: "node", engine: "pi", requestId: randomUUID(), sessionId: first, tags: [{ key: "nightly", name: "Nightly", managedTagId: null }], status: "failed", error: "failed", acceptedAt: "2026-01-03T01:00:00.000Z", startedAt: "2026-01-03T01:00:00.000Z", finishedAt: "2026-01-03T01:01:00.000Z" });
    const report = queryAutomationExecutions(db, { workspaceId: "w", tagKey: "nightly", from: "2026-01-01T00:00:00.000Z", to: "2026-01-04T00:00:00.000Z", timeZone: "UTC", page: 1, pageSize: 1 }, ["visible"]);
    assert.equal(report.total, 2);
    assert.equal(report.rows.length, 1);
    assert.equal(report.statistics.succeeded, 1);
    assert.equal(report.statistics.failed, 1);
    assert.equal(report.statistics.averageDurationMs, 90000);
    assert.equal(report.trend.length, 2);
  } finally { db.close(); }
});
