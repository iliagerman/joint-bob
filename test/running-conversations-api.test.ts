import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("the running conversations endpoint groups only live conversations across projects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-running-"));
  let server;
  let database: DatabaseSync | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    const session = await signIn(environment, node);
    const project = node.projects[0];
    const listed = await api<{ sessions: Array<{ id: string; path: string; title: string; harnessId: string }> }>(node, session, "GET", `/projects/${project.id}/sessions`);
    assert.equal(listed.status, 200);
    const target = listed.body.sessions[0];
    const empty = await api<{ projects: unknown[] }>(node, session, "GET", "/running");
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual(empty.body.projects, []);

    try {
      const now = new Date();
      database = new DatabaseSync(path.join(node.dataDir, "node.db"));
      database.prepare(`INSERT INTO conversation_runtime_leases
        (engine, session_id, owner_node_id, ownership_epoch, run_id, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(target.harnessId, target.id, node.nodeId, 1, "running-test", now.toISOString(), new Date(now.getTime() + 60_000).toISOString());

      const running = await api<{ projects: Array<{ projectId: string; projectName: string; sessions: Array<{ id: string; path: string; title: string; harnessId: string; running: boolean }> }> }>(node, session, "GET", "/running");
      assert.equal(running.status, 200, JSON.stringify(running.body));
      assert.equal(running.body.projects.length, 1);
      const group = running.body.projects[0];
      assert.equal(group.projectId, project.id);
      assert.equal(group.projectName, project.name);
      assert.equal(group.sessions.length, 1);
      const entry = group.sessions[0];
      assert.equal(entry.id, target.id);
      assert.equal(entry.path, target.path);
      assert.equal(entry.title, target.title);
      assert.equal(entry.harnessId, target.harnessId);
      assert.equal(entry.running, true);
    } finally {
      database?.close();
    }
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
