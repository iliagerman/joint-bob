import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("a project lock records the local node, replicates, and can be cleared by anyone", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-project-lock-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const suffix = `${Date.now()}-${Math.random()}`;
    const cluster = await import(new URL(`../src/cluster.ts?lock=${suffix}`, import.meta.url).href);
    const store = await import(new URL(`../src/store.ts?lock=${suffix}`, import.meta.url).href);
    const locks = await import(new URL(`../src/project-locks.ts?lock=${suffix}`, import.meta.url).href);

    const node = await cluster.getClusterNode();
    const project = await store.addProject("locked", path.join(dataDir, "server", "locked"), { type: "work" });

    assert.equal(await locks.getProjectLock(project.id), undefined);

    const held = await locks.setProjectLock(project.id, true);
    assert.equal(held.nodeId, node.id);
    assert.equal(held.nodeName, node.name);
    assert.equal(typeof held.lockedAt, "string");

    // The lock is on the row, not in memory.
    assert.equal((await locks.getProjectLock(project.id)).nodeId, node.id);
    assert.equal((await locks.projectLocks())[project.id].nodeId, node.id);

    // Locking enqueues a replication event so peers learn about it.
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    try {
      const outbox = db.prepare("SELECT entity_type, entity_key, operation FROM replication_outbox").all() as Array<{ entity_type: string; entity_key: string; operation: string }>;
      assert.equal(outbox.length, 1);
      assert.equal(outbox[0].entity_type, "project.lock");
      assert.equal(outbox[0].entity_key, project.id);
      assert.equal(outbox[0].operation, "upsert");
    } finally {
      db.close();
    }

    assert.equal(await locks.setProjectLock(project.id, false), undefined);
    assert.equal(await locks.getProjectLock(project.id), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an inbound peer lock event wins or loses by last-writer-wins", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-project-lock-lww-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const suffix = `${Date.now()}-${Math.random()}`;
    const cluster = await import(new URL(`../src/cluster.ts?lock=${suffix}`, import.meta.url).href);
    const store = await import(new URL(`../src/store.ts?lock=${suffix}`, import.meta.url).href);
    const locks = await import(new URL(`../src/project-locks.ts?lock=${suffix}`, import.meta.url).href);
    const replication = await import(new URL(`../src/replication.ts?lock=${suffix}`, import.meta.url).href);

    // A real node always has its cluster identity before it accepts peer batches.
    await cluster.getClusterNode();
    const project = await store.addProject("peer-locked", path.join(dataDir, "server", "peer-locked"), { type: "work" });
    const peerNodeId = "11111111-1111-4111-8111-111111111111";

    const lockEvent = {
      id: "22222222-2222-4222-8222-222222222222",
      originNodeId: peerNodeId,
      entityType: "project.lock",
      entityKey: project.id,
      operation: "upsert",
      payload: {
        projectId: project.id,
        lock: { nodeId: peerNodeId, nodeName: "peer", lockedAt: "2026-01-02T00:00:00.000Z" },
        updatedAt: "2026-01-02T00:00:00.000Z",
        originNodeId: peerNodeId,
      },
      createdAt: "2026-01-02T00:00:00.000Z",
    };
    await replication.receiveReplicationBatch({ events: [lockEvent] });
    // Read back through projectLocks(): getProjectLock() resolves ids through the bare
    // store module, whose data dir is frozen to whichever test loaded it first.
    assert.equal((await locks.projectLocks())[project.id].nodeId, peerNodeId);

    // An older unlock must not win.
    await replication.receiveReplicationBatch({ events: [{
      id: "33333333-3333-4333-8333-333333333333",
      originNodeId: peerNodeId,
      entityType: "project.lock",
      entityKey: project.id,
      operation: "delete",
      payload: { projectId: project.id, lock: null, updatedAt: "2026-01-01T00:00:00.000Z", originNodeId: peerNodeId },
      createdAt: "2026-01-01T00:00:00.000Z",
    }] });
    assert.equal((await locks.projectLocks())[project.id].nodeId, peerNodeId);

    // A newer unlock does.
    await replication.receiveReplicationBatch({ events: [{
      id: "44444444-4444-4444-8444-444444444444",
      originNodeId: peerNodeId,
      entityType: "project.lock",
      entityKey: project.id,
      operation: "delete",
      payload: { projectId: project.id, lock: null, updatedAt: "2026-01-03T00:00:00.000Z", originNodeId: peerNodeId },
      createdAt: "2026-01-03T00:00:00.000Z",
    }] });
    assert.equal((await locks.projectLocks())[project.id], undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the lock is exposed through the API, guards writes, and appears in the project row", async () => {
  const [types, server, app, styles, worker] = await Promise.all([
    readFile("src/types.ts", "utf8"),
    readFile("src/server.ts", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);

  assert.match(types, /export interface ProjectLock \{/);
  assert.match(types, /lockedElsewhere\?: boolean;/);

  assert.match(server, /app\.put\("\/api\/projects\/:projectId\/lock"/);
  assert.match(server, /class ProjectLockedError extends Error/);
  assert.match(server, /error instanceof ProjectLockedError/);
  assert.match(server, /assertProjectEditable/);
  // The lock must gate the terminal and the chat socket, not the read-only watcher.
  assert.match(server, /Project is locked by/);

  assert.match(app, /project-lock-button/);
  assert.match(app, /project-lock-badge/);
  // The lock control moved into the row overflow menu, so the row itself carries the
  // state as a badge rather than as a button of its own.
  assert.match(styles, /\.project-lock-badge \{/);
  assert.doesNotMatch(worker, /joint-bob-v33/);
});
