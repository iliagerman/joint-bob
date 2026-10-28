import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAutomationExecution, automationExecutions, transitionAutomationExecution, type AutomationExecution } from "../src/automation-executions.js";

const execution = (): AutomationExecution => ({ id: randomUUID(), sourceKind: "scheduled", sourceId: randomUUID(), sourceName: "Nightly", workspaceId: "w", projectId: "p", ownerNodeId: randomUUID(), engine: "pi", requestId: randomUUID(), sessionId: null, tags: [{ key: "nightly", name: "Nightly", managedTagId: null }], status: "queued", error: null, acceptedAt: new Date().toISOString(), startedAt: null, finishedAt: null });

test("execution records retain tag snapshots and do not regress after completion", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const item = execution();
    createAutomationExecution(db, item);
    transitionAutomationExecution(db, item.requestId, "running", null, "session");
    transitionAutomationExecution(db, item.requestId, "succeeded");
    transitionAutomationExecution(db, item.requestId, "running");
    const row = automationExecutions(db, "w")[0];
    assert.deepEqual(row.tags, item.tags);
    assert.equal(row.status, "succeeded");
    assert.equal(row.sessionId, "session");
    assert.ok(row.startedAt && row.finishedAt);
  } finally { db.close(); }
});

test("duplicate identical execution creates are idempotent and conflicting IDs fail", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const item = execution();
    createAutomationExecution(db, item);
    createAutomationExecution(db, item);
    assert.equal(automationExecutions(db, "w").length, 1);
    assert.throws(() => createAutomationExecution(db, { ...item, tags: [{ key: "other", name: "Other", managedTagId: null }] }), /Conflicting/);
  } finally { db.close(); }
});
