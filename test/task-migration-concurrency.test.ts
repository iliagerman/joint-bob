import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { resolveDataDirectory } from "../src/data-directory.js";
import { listTasks, taskDatabase } from "../src/tasks.js";

test("concurrent legacy task migration imports and publishes once", async () => {
  const projectId = `legacy-concurrent-${randomUUID()}`;
  const taskId = `task-${randomUUID()}`;
  const legacyPath = path.join(resolveDataDirectory(), "tasks", `${projectId}.json`);
  const timestamp = "2026-01-01T00:00:00.000Z";
  const task = {
    id: taskId,
    title: "Legacy title",
    description: "Legacy description",
    status: "backlog",
    engine: "pi",
    planMode: false,
    reviewMode: false,
    phaseConfig: {},
    sessionPath: null,
    worktreePath: null,
    worktreeBranch: null,
    mergedAt: null,
    currentNodeId: "legacy-node",
    leaseOwnerNodeId: null,
    leaseExpiresAt: null,
    executionState: "idle",
    handoffContext: null,
    originNodeId: "legacy-node",
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await mkdir(path.dirname(legacyPath), { recursive: true });
  await writeFile(legacyPath, JSON.stringify({ tasks: [task] }));
  try {
    const results = await Promise.all(Array.from({ length: 10 }, () => listTasks(projectId)));
    for (const tasks of results) {
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].id, taskId);
    }

    const db = await taskDatabase();
    const marker = db.prepare("SELECT COUNT(*) AS count FROM task_migrations WHERE project_id = ?").get(projectId) as { count: number };
    const events = db.prepare("SELECT COUNT(*) AS count FROM replication_outbox WHERE entity_type = 'task' AND entity_key = ?").get(`${projectId}:${taskId}`) as { count: number };
    assert.equal(marker.count, 1);
    assert.equal(events.count, 1);
  } finally {
    await rm(legacyPath, { force: true });
  }
});
