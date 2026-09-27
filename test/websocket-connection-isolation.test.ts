// A malformed task that reached this node (for example replicated from a peer) must
// fail only the socket that opens it, never the whole node.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import WebSocket from "ws";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("a task with an unowned session path closes its socket without crashing the node", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "socket-isolation-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0], project = node.projects[0];
  const child = await startDevNode(environment, node);
  try {
    const script = `import { createTask } from "./src/tasks.ts"; process.stdout.write(JSON.stringify(await createTask(${JSON.stringify(project.id)}, ${JSON.stringify(project.path)}, "Malformed", "", "backlog", "pi", false, false, {}))); process.exit(0);`;
    const task = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir }, encoding: "utf8" })) as { id: string };
    const unowned = "pi:/nowhere/unowned-session.jsonl";
    const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
    try { assert.equal(db.prepare("UPDATE tasks SET session_path=? WHERE id=?").run(unowned, task.id).changes, 1); } finally { db.close(); }

    const session = await signIn(environment, node);
    const url = new URL("/ws", node.url);
    url.protocol = "ws:";
    for (const [key, value] of Object.entries({ projectId: project.id, sessionPath: unowned, taskId: task.id })) url.searchParams.set(key, value);
    const closed = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(url, { origin: node.url, headers: { Cookie: session.cookie } });
      socket.once("close", (code) => resolve(code));
      socket.once("error", reject);
    });
    assert.equal(closed, 1011, "the failing connection is closed with an error");
    assert.equal(child.exitCode, null, "the node process keeps running");
    assert.equal((await fetch(`${node.url}/api/health`)).status, 200, "the node keeps serving requests");
  } finally {
    await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
