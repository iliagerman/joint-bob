import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("legacy task migration publishes each inserted task once", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-legacy-task-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  const projectId = "legacy-project";
  const task = {
    id: "legacy-task", title: "Legacy title", description: "Legacy description", status: "review", engine: "claude", planMode: true, reviewMode: true, phaseConfig: { review: { engine: "claude", provider: "anthropic", modelId: "claude-opus-5", effort: "high" } }, sessionPath: "legacy-session", worktreePath: "/legacy/worktree", worktreeBranch: "legacy-branch", mergedAt: null, currentNodeId: "legacy-current", leaseOwnerNodeId: "legacy-lease", leaseExpiresAt: "2026-01-02T00:00:00.000Z", executionState: "running", handoffContext: "legacy context", originNodeId: "legacy-origin", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    await mkdir(path.join(dataDir, "tasks"), { recursive: true });
    await writeFile(path.join(dataDir, "tasks", `${projectId}.json`), JSON.stringify({ tasks: [task] }));
    const tasks = await import(new URL(`../src/tasks.ts?legacy=${Date.now()}`, import.meta.url).href);
    const migrated = await tasks.listTasks(projectId);
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    const node = db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get() as { id: string };
    const events = db.prepare("SELECT origin_node_id, entity_type, entity_key, operation, payload FROM replication_outbox").all() as Array<{ origin_node_id: string; entity_type: string; entity_key: string; operation: string; payload: string }>;
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].currentNodeId, node.id);
    assert.equal(migrated[0].originNodeId, node.id);
    assert.equal(migrated[0].executionState, "idle");
    assert.equal(events.length, 1);
    assert.deepEqual({ originNodeId: events[0].origin_node_id, entityType: events[0].entity_type, entityKey: events[0].entity_key, operation: events[0].operation }, { originNodeId: node.id, entityType: "task", entityKey: `${projectId}:${task.id}`, operation: "upsert" });
    const payload = JSON.parse(events[0].payload) as { projectId: string; task: typeof task; originNodeId: string };
    assert.equal(payload.projectId, projectId);
    assert.equal(payload.originNodeId, node.id);
    assert.equal(payload.task.currentNodeId, node.id);
    assert.equal(payload.task.originNodeId, node.id);
    assert.equal(payload.task.executionState, "idle");
    await tasks.listTasks(projectId);
    const reloaded = await import(new URL(`../src/tasks.ts?legacy-reload=${Date.now()}`, import.meta.url).href);
    await reloaded.listTasks(projectId);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM replication_outbox").get() as { count: number }).count, 1);
    db.close();
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});
