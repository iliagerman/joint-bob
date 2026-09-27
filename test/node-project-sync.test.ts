import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function withStore(run: (root: string, store: typeof import("../src/store.js")) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "master-bob-node-sync-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  try {
    const moduleUrl = new URL(`../src/store.ts?node-sync=${Date.now()}-${Math.random()}`, import.meta.url);
    await run(root, await import(moduleUrl.href));
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("project records migrate from JSON into machine-local SQLite", async () => {
  await withStore(async (root, store) => {
    const dataDir = path.join(root, "data");
    const localPath = path.join(root, "projects", "julian");
    await mkdir(dataDir, { recursive: true });
    await mkdir(localPath, { recursive: true });
    const legacy = { projects: [{ id: "shared-julian", name: "julian", path: localPath, macPath: "/remote/julian", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }] };
    await writeFile(path.join(dataDir, "projects.json"), JSON.stringify(legacy));

    const projects = await store.listProjects();

    assert.equal(projects[0].path, localPath);
    assert.equal(projects[0].id, "shared-julian");
    assert.equal((await readFile(path.join(dataDir, "projects.json"), "utf8")), JSON.stringify(legacy));
    assert.equal((await readFile(path.join(dataDir, "node.db"))).subarray(0, 15).toString(), "SQLite format 3");
  });
});

test("explicit import mapping preserves shared identity and local path", async () => {
  await withStore(async (root, store) => {
    const localPath = path.join(root, "mapped", "julian");
    await mkdir(localPath, { recursive: true });
    const remote = {
      id: "shared-julian",
      name: "julian",
      path: "/srv/projects/sample",
      syncFolderId: "julian",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };

    const imported = await store.importProject(remote, localPath);
    const originalSourcePath = "/Users/example/Work/sample";
    const reimported = await store.importProject({ ...remote, macPath: originalSourcePath });

    assert.equal(imported.id, remote.id);
    assert.equal(imported.path, localPath);
    assert.equal(imported.macPath, remote.path);
    assert.equal(imported.syncFolderId, "julian");
    assert.equal(reimported.path, localPath);
    assert.equal(reimported.macPath, originalSourcePath);
    assert.equal((await store.listProjects()).length, 1);
  });
});

test("importing a legacy project matched by sync folder keeps the local ID and records its source", async () => {
  await withStore(async (root, store) => {
    const localPath = path.join(root, "node-local", "demo");
    await mkdir(localPath, { recursive: true });
    await store.importProject({
      id: "local-id",
      name: "demo",
      path: "/node-local/demo",
      syncFolderId: "shared-folder",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }, localPath);

    const imported = await store.importProject({
      id: "remote-id",
      name: "demo",
      path: "/node-remote/demo",
      syncFolderId: "shared-folder",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    }, undefined, "node-remote");

    assert.equal(imported.id, "local-id");
    assert.equal(imported.path, localPath);
    assert.deepEqual(imported.locations, [{ nodeId: "node-remote", path: "/node-remote/demo" }]);
    assert.equal((await store.getProject("remote-id"))?.id, "local-id");
    assert.equal(await store.canonicalProjectId("remote-id"), "local-id");

    const reloaded = await import(new URL(`../src/store.ts?node-sync-reload=${Date.now()}-${Math.random()}`, import.meta.url).href);
    assert.equal((await reloaded.getProject("remote-id"))?.id, "local-id");
    await reloaded.removeProject("remote-id");
    assert.equal((await reloaded.getProject("local-id")), undefined);
    assert.equal(await reloaded.canonicalProjectId("remote-id"), undefined);
  });
});

test("project keeps paths from three nodes without changing its local path", async () => {
  await withStore(async (root, store) => {
    const localPath = path.join(root, "node-b", "demo");
    await mkdir(localPath, { recursive: true });
    const base = {
      id: "shared-demo",
      name: "demo",
      syncFolderId: "demo-folder",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };

    await store.importProject({ ...base, path: "/node-a/demo" }, localPath, "node-a");
    await store.importProject({ ...base, path: "/node-c/demo", locations: [{ nodeId: "node-a", path: "/node-a/demo" }] }, undefined, "node-c");

    const project = (await store.listProjects())[0];
    assert.equal(project.path, localPath);
    assert.deepEqual(project.locations, [
      { nodeId: "node-a", path: "/node-a/demo" },
      { nodeId: "node-c", path: "/node-c/demo" },
    ]);
  });
});

test("an unmapped project cannot be imported without an explicit local path", async () => {
  await withStore(async (_root, store) => {
    await assert.rejects(
      store.importProject({ id: "shared", name: "demo", path: "/remote/demo", syncFolderId: "demo", createdAt: "now", updatedAt: "now" }),
      /local folder mapping/i,
    );
  });
});

test("project removal atomically settles project task state and reservations", async () => {
  await withStore(async (root, store) => {
    const tasks = await import(new URL(`../src/tasks.ts?project-remove=${Date.now()}-${Math.random()}`, import.meta.url).href);
    const replication = await import(new URL(`../src/replication.ts?project-remove=${Date.now()}-${Math.random()}`, import.meta.url).href);
    const cluster = await import(new URL(`../src/cluster.ts?project-remove=${Date.now()}-${Math.random()}`, import.meta.url).href);
    const local = await cluster.getClusterNode();
    const taskFor = (id: string, owner = local.id) => ({
      id, title: id, description: "task", status: "backlog" as const, engine: "pi" as const, planMode: false, reviewMode: false, phaseConfig: {},
      sessionPath: null, worktreePath: null, worktreeBranch: null, mergedAt: null, currentNodeId: owner, leaseOwnerNodeId: null, leaseExpiresAt: null,
      executionState: "idle" as const, handoffContext: null, originNodeId: owner, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z",
    });
    const inject = async (projectId: string, task: ReturnType<typeof taskFor>) => {
      await replication.receiveReplicationBatch({ events: [{ id: randomUUID(), originNodeId: task.originNodeId, entityType: "task", entityKey: `${projectId}:${task.id}`, operation: "upsert", payload: { projectId, task, originNodeId: task.originNodeId }, createdAt: task.updatedAt }] });
    };

    const settled = await store.addProject("settled", path.join(root, "settled"));
    const settledTask = taskFor("settled-task");
    await inject(settled.id, settledTask);
    const settledHandoff = await tasks.beginOutgoingTaskHandoff(settled.id, settledTask, local.id, randomUUID());
    await tasks.abortOutgoingTaskHandoff(settledHandoff.handoffId);
    const settledDb = new DatabaseSync(path.join(root, "data", "node.db"));
    settledDb.prepare("INSERT INTO task_tombstones (project_id, task_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?)").run(settled.id, "settled-deleted", "2026-06-01T00:00:01.000Z", local.id);
    settledDb.close();
    await store.removeProject(settled.id);
    const removedDb = new DatabaseSync(path.join(root, "data", "node.db"));
    assert.equal((removedDb.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?").get(settled.id) as { count: number }).count, 0);
    for (const table of ["tasks", "task_tombstones", "task_migrations", "task_handoffs"]) assert.equal((removedDb.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`).get(settled.id) as { count: number }).count, 0);
    removedDb.close();

    const unfinished = await store.addProject("unfinished", path.join(root, "unfinished"));
    const unfinishedTask = taskFor("unfinished-task", randomUUID());
    const unfinishedHandoffId = randomUUID();
    await tasks.reserveTaskHandoff(unfinishedHandoffId, unfinished.id, unfinished.id, unfinishedTask, local.id, "", "2026-06-01T00:00:02.000Z");
    await assert.rejects(store.removeProject(unfinished.id), (error: Error) => error.message === "Settle task handoffs before deleting project");
    const unfinishedDb = new DatabaseSync(path.join(root, "data", "node.db"));
    assert.ok(unfinishedDb.prepare("SELECT 1 FROM projects WHERE id = ?").get(unfinished.id));
    assert.ok(unfinishedDb.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND id = ?").get(unfinished.id, unfinishedTask.id));
    assert.ok(unfinishedDb.prepare("SELECT 1 FROM task_handoffs WHERE handoff_id = ?").get(unfinishedHandoffId));
    unfinishedDb.close();

    const unacknowledged = await store.addProject("unacknowledged", path.join(root, "unacknowledged"));
    const unacknowledgedTask = taskFor("unacknowledged-task", randomUUID());
    const unacknowledgedHandoffId = randomUUID();
    await tasks.prepareTaskHandoff(unacknowledgedHandoffId, unacknowledged.id, unacknowledged.id, unacknowledgedTask, local.id, null, "", "2026-06-01T00:00:03.000Z");
    await tasks.commitPreparedTaskHandoff(unacknowledgedHandoffId, local.id);
    await tasks.deleteTask(unacknowledged.id, unacknowledgedTask.id);
    await assert.rejects(store.removeProject(unacknowledged.id), (error: Error) => error.message === "Wait for task handoff settlement before deleting project");
    const unacknowledgedDb = new DatabaseSync(path.join(root, "data", "node.db"));
    assert.ok(unacknowledgedDb.prepare("SELECT 1 FROM projects WHERE id = ?").get(unacknowledged.id));
    assert.ok(unacknowledgedDb.prepare("SELECT 1 FROM task_tombstones WHERE project_id = ? AND task_id = ?").get(unacknowledged.id, unacknowledgedTask.id));
    assert.ok(unacknowledgedDb.prepare("SELECT 1 FROM task_handoffs WHERE handoff_id = ?").get(unacknowledgedHandoffId));
    unacknowledgedDb.close();
    await tasks.acknowledgeIncomingTaskHandoff(unacknowledgedHandoffId, local.id);
    await store.removeProject(unacknowledged.id);

    const unacknowledgedOutgoing = await store.addProject("unacknowledged-outgoing", path.join(root, "unacknowledged-outgoing"));
    const unacknowledgedOutgoingTask = taskFor("unacknowledged-outgoing-task");
    await inject(unacknowledgedOutgoing.id, unacknowledgedOutgoingTask);
    const unacknowledgedOutgoingHandoff = await tasks.beginOutgoingTaskHandoff(unacknowledgedOutgoing.id, unacknowledgedOutgoingTask, local.id, randomUUID());
    await tasks.markOutgoingTaskHandoff(unacknowledgedOutgoingHandoff.handoffId, "prepared");
    await tasks.completeTaskHandoff(unacknowledgedOutgoingHandoff.handoffId, unacknowledgedOutgoing.id, unacknowledgedOutgoingTask.id, local.id, unacknowledgedOutgoingHandoff.destinationNodeId);
    await assert.rejects(store.removeProject(unacknowledgedOutgoing.id), (error: Error) => error.message === "Wait for task handoff settlement before deleting project");
    const unacknowledgedOutgoingDb = new DatabaseSync(path.join(root, "data", "node.db"));
    assert.ok(unacknowledgedOutgoingDb.prepare("SELECT 1 FROM projects WHERE id = ?").get(unacknowledgedOutgoing.id));
    assert.ok(unacknowledgedOutgoingDb.prepare("SELECT 1 FROM task_handoffs WHERE handoff_id = ?").get(unacknowledgedOutgoingHandoff.handoffId));
    unacknowledgedOutgoingDb.close();
    await tasks.acknowledgeOutgoingTaskHandoff(unacknowledgedOutgoingHandoff.handoffId);
    await store.removeProject(unacknowledgedOutgoing.id);
    assert.equal(await store.getProject(unacknowledgedOutgoing.id), undefined);

    const running = await store.addProject("running", path.join(root, "running"));
    const runningTask = { ...taskFor("running-task"), executionState: "running" as const };
    await inject(running.id, runningTask);
    await assert.rejects(store.removeProject(running.id), (error: Error) => error.message === "Wait for task agents to finish before deleting project");
    let activeDb = new DatabaseSync(path.join(root, "data", "node.db"));
    assert.ok(activeDb.prepare("SELECT 1 FROM projects WHERE id = ?").get(running.id));
    assert.ok(activeDb.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND id = ?").get(running.id, runningTask.id));
    activeDb.prepare("UPDATE tasks SET execution_state = 'idle' WHERE project_id = ? AND id = ?").run(running.id, runningTask.id);
    activeDb.close();
    await store.removeProject(running.id);

    const liveLeased = await store.addProject("live-leased", path.join(root, "live-leased"));
    const liveLeasedTask = { ...taskFor("live-leased-task"), leaseOwnerNodeId: local.id, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
    await inject(liveLeased.id, liveLeasedTask);
    await assert.rejects(store.removeProject(liveLeased.id), (error: Error) => error.message === "Wait for task agents to finish before deleting project");
    activeDb = new DatabaseSync(path.join(root, "data", "node.db"));
    assert.ok(activeDb.prepare("SELECT 1 FROM projects WHERE id = ?").get(liveLeased.id));
    assert.ok(activeDb.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND id = ?").get(liveLeased.id, liveLeasedTask.id));
    activeDb.prepare("UPDATE tasks SET lease_owner_node_id = NULL, lease_expires_at = NULL WHERE project_id = ? AND id = ?").run(liveLeased.id, liveLeasedTask.id);
    activeDb.close();
    await store.removeProject(liveLeased.id);

    const raced = await store.addProject("raced", path.join(root, "raced"));
    const racedTask = taskFor("raced-task", randomUUID());
    const raceHandoffId = randomUUID();
    const [removal, reservation] = await Promise.allSettled([
      store.removeProject(raced.id),
      tasks.reserveTaskHandoff(raceHandoffId, raced.id, raced.id, racedTask, local.id, "", "2026-06-01T00:00:03.000Z"),
    ]);
    const raceDb = new DatabaseSync(path.join(root, "data", "node.db"));
    if (reservation.status === "fulfilled") {
      assert.equal(removal.status, "rejected");
      assert.equal((removal as PromiseRejectedResult).reason.message, "Settle task handoffs before deleting project");
      assert.ok(raceDb.prepare("SELECT 1 FROM projects WHERE id = ?").get(raced.id));
      assert.ok(raceDb.prepare("SELECT 1 FROM task_handoffs WHERE handoff_id = ? AND status = 'pending'").get(raceHandoffId));
    } else {
      assert.equal(removal.status, "fulfilled");
      assert.equal((reservation as PromiseRejectedResult).reason.message, "Project not found");
      assert.equal((raceDb.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?").get(raced.id) as { count: number }).count, 0);
      for (const table of ["tasks", "task_handoffs"]) assert.equal((raceDb.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`).get(raced.id) as { count: number }).count, 0);
    }
    raceDb.close();
  });
});

test("removing a project deletes the secret accounts it owns along with their files", async () => {
  await withStore(async (root, store) => {
    const tag = `${Date.now()}-${Math.random()}`;
    const secrets = await import(new URL(`../src/secrets.ts?owned-delete=${tag}`, import.meta.url).href) as typeof import("../src/secrets.js");
    const project = await store.addProject("owned", path.join(root, "owned"));
    const owned = await secrets.saveSecretAccount({ label: "Owned", provider: "google", projectId: project.id, variables: [{ name: "GOOGLE_APPLICATION_CREDENTIALS", kind: "file", value: "{}" }] });
    const global = await secrets.saveSecretAccount({ label: "Global", provider: "custom", variables: [{ name: "G", kind: "value", value: "g" }] });
    await secrets.setScopeSecretAccounts("project", project.id, [owned.id, global.id]);
    const filePath = secrets.genericSecretEnvironment(project.id).GOOGLE_APPLICATION_CREDENTIALS!;
    await readFile(filePath, "utf8");

    await store.removeProject(project.id);

    assert.deepEqual((await secrets.listSecretAccounts()).map((account) => account.id), [global.id]);
    await assert.rejects(readFile(filePath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  });
});
