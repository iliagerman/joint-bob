import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { api, projectNamed, signIn } from "./dev-nodes.js";
import { backgroundClusterFixture, backgroundFixture, closeBackgroundClusterFixture, closeBackgroundFixture, startSyntheticTask } from "./background-tasks-fixture.js";
import { mintTaskToken, readSupervisorControl } from "../scripts/supervisor-client.mjs";

test("background task API exposes scoped metadata and output without a web start action", async () => {
  const f = await backgroundFixture();
  try {
    const session = await signIn(f.environment, f.node);
    const project = projectNamed(f.node, "Joint Bob");
    const conversationId = "logical-conversation";
    const id = "00000000-0000-4000-8000-000000000121";
    await startSyntheticTask(f, project.id, conversationId, id, true);
    const listed = await api<{ tasks: Array<Record<string, unknown>> }>(f.node, session, "GET", `/background-tasks?projectId=${project.id}&conversationId=${conversationId}`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.tasks.length, 1);
    assert.equal(listed.body.tasks[0].id, id);
    for (const secret of ["executable", "args", "cwd", "env", "error", "identity"]) {
      assert.equal(secret in listed.body.tasks[0], false);
    }
    let output: { status: number; body: { chunk: string } } | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      output = await api<{ chunk: string }>(f.node, session, "POST", "/background-tasks/operation", {
        nodeId: f.node.nodeId,
        command: { action: "output", projectId: project.id, conversationId, id, offset: 0, limit: 64 },
      });
      if (Buffer.from(output.body.chunk ?? "", "base64").toString().includes("safe-output")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(output?.status, 200);
    assert.match(Buffer.from(output?.body.chunk ?? "", "base64").toString(), /safe-output/);
    const invalidRange = await api<{ error: string }>(f.node, session, "POST", "/background-tasks/operation", {
      nodeId: f.node.nodeId,
      command: { action: "output", projectId: project.id, conversationId, id, offset: Number.MAX_SAFE_INTEGER, limit: 64 },
    });
    assert.equal(invalidRange.status, 400);
    assert.equal(invalidRange.body.error, "Invalid output range");
    const forbidden = await api<{ error: string }>(f.node, session, "POST", "/background-tasks/operation", {
      nodeId: f.node.nodeId,
      command: { action: "start", projectId: project.id, conversationId, id },
    });
    assert.equal(forbidden.status, 400);
    const wrong = await api(f.node, session, "POST", "/background-tasks/operation", {
      nodeId: f.node.nodeId,
      command: { action: "stop", projectId: project.id, conversationId: "wrong", id },
    });
    assert.equal(wrong.status, 404);
  } finally {
    await closeBackgroundFixture(f);
  }
});

test("short foreground shell commands are absent from background task history", async () => {
  const f = await backgroundFixture();
  try {
    const session = await signIn(f.environment, f.node);
    const project = projectNamed(f.node, "Joint Bob"); const conversationId = "short-shell";
    const control = readSupervisorControl(f.node.dataDir)!;
    const token = mintTaskToken(f.node.dataDir, JSON.stringify([project.id, conversationId]));
    const child = spawn(process.execPath, [path.resolve("bin/joint-bob-bash.mjs"), "-lc", "exit 0"], { cwd: f.root, env: { PATH: process.env.PATH ?? "", HOME: f.root, NODE_NO_WARNINGS: "1", JOINT_BOB_TASK_DATA_DIR: f.node.dataDir, JOINT_BOB_TASK_SOCKET: control.socketPath, JOINT_BOB_TASK_TOKEN: token }, stdio: "ignore" });
    const [code] = await once(child, "close"); assert.equal(code, 0);
    const listed = await api<{ tasks: Array<Record<string, unknown>> }>(f.node, session, "GET", `/background-tasks?projectId=${project.id}&conversationId=${conversationId}`);
    assert.equal(listed.status, 200); assert.deepEqual(listed.body.tasks, []);
  } finally { await closeBackgroundFixture(f); }
});

test("background task keyset pagination returns every tied row exactly once", async () => {
  const f = await backgroundFixture();
  try {
    const session = await signIn(f.environment, f.node);
    const project = projectNamed(f.node, "Joint Bob");
    const conversationId = "pagination-conversation";
    const identity = JSON.stringify([project.id, conversationId]);
    const ids = Array.from({ length: 124 }, () => randomUUID());
    const db = new DatabaseSync(path.join(f.node.dataDir, "supervisor.db"));
    try {
      const insert = db.prepare("INSERT INTO supervisor_tasks(id,identity,name,executable,args_json,cwd,status,pid,started_at,ended_at,exit_code,signal,error) VALUES (?,?,?,'synthetic','[]',?,'completed',NULL,?,NULL,0,NULL,NULL)");
      for (const [index, taskId] of ids.entries()) {
        insert.run(taskId, identity, `synthetic-${index}`, f.root, index < 121 ? "2026-01-02T00:00:00.000Z" : "2026-01-01T00:00:00.000Z");
      }
    } finally {
      db.close();
    }
    const seen: string[] = [];
    let before: { startedAt: string; id: string } | undefined;
    do {
      const page = await api<{ tasks: Array<{ id: string }>; node: { nextCursor: typeof before | null } }>(f.node, session, "POST", "/background-tasks/operation", {
        nodeId: f.node.nodeId,
        command: { action: "list", projectId: project.id, conversationId, limit: 30, ...(before ? { before } : {}) },
      });
      assert.equal(page.status, 200, JSON.stringify(page.body));
      seen.push(...page.body.tasks.map((task) => task.id));
      before = page.body.node.nextCursor ?? undefined;
    } while (before);
    assert.equal(seen.length, ids.length, `expected ${ids.length} rows, received ${seen.length}`);
    assert.equal(new Set(seen).size, ids.length, "keyset pages must not contain duplicate task IDs");
    assert.deepEqual([...seen].sort(), [...ids].sort());

    const stale = await api(f.node, session, "POST", "/background-tasks/operation", {
      nodeId: f.node.nodeId,
      command: { action: "list", projectId: project.id, conversationId, limit: 30, before: { startedAt: "2026-01-01", id: "not-a-uuid" } },
    });
    assert.equal(stale.status, 400);
  } finally {
    await closeBackgroundFixture(f);
  }
});

test("background task routes require authenticated human and CSRF", async () => {
  const f = await backgroundFixture();
  try {
    const project = projectNamed(f.node, "Joint Bob");
    const unauth = await fetch(`${f.node.url}/api/background-tasks?projectId=${project.id}&conversationId=x`);
    assert.equal(unauth.status, 401);
    const session = await signIn(f.environment, f.node);
    const noCsrf = await fetch(`${f.node.url}/api/background-tasks/operation`, {
      method: "POST",
      headers: { Cookie: session.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(noCsrf.status, 403);
  } finally {
    await closeBackgroundFixture(f);
  }
});

test("background task discovery tolerates a rolling-upgrade peer without weakening denials", async () => {
  const cluster = await backgroundClusterFixture();
  const [nodeA, nodeB] = cluster.nodes;
  const f = { ...cluster, nodeA, nodeB };
  let legacyStatus = 401;
  let legacyError = "Authentication required";
  const legacy = createServer((request, response) => {
    request.resume();
    response.writeHead(legacyStatus, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: legacyError }));
  });
  try {
    legacy.listen(0, "127.0.0.1");
    await once(legacy, "listening");
    const address = legacy.address();
    assert(address && typeof address === "object");
    const db = new DatabaseSync(path.join(f.nodeA.dataDir, "node.db"));
    try {
      db.exec("PRAGMA busy_timeout=5000");
      db.prepare("UPDATE cluster_peers SET url = ? WHERE id = ?").run(`http://127.0.0.1:${address.port}`, f.nodeB.nodeId);
    } finally {
      db.close();
    }

    const project = projectNamed(f.nodeA, "Joint Bob");
    const session = await signIn(f.environment, f.nodeA);
    const conversationId = "legacy-peer";
    const taskId = randomUUID();
    await startSyntheticTask({ node: f.nodeA, root: f.root }, project.id, conversationId, taskId, true);

    for (const status of [401, 404]) {
      legacyStatus = status;
      legacyError = status === 401 ? "Authentication required" : "Not found";
      const overview = await api<{ tasks: Array<{ id: string }>; nodes: Array<{ nodeId: string; available: boolean }> }>(
        f.nodeA, session, "GET", `/background-tasks?projectId=${project.id}&conversationId=${conversationId}`,
      );
      assert.equal(overview.status, 200, JSON.stringify(overview.body));
      assert.equal(overview.body.tasks.some((task) => task.id === taskId), true);
      assert.equal(overview.body.nodes.find((node) => node.nodeId === f.nodeB.nodeId)?.available, false);
    }

    legacyStatus = 401;
    const unavailable = await api(f.nodeA, session, "POST", "/background-tasks/operation", {
      nodeId: f.nodeB.nodeId,
      command: { action: "output", projectId: project.id, conversationId, id: taskId, offset: 0, limit: 64 },
    });
    assert.equal(unavailable.status, 503);

    legacyStatus = 404;
    const missing = await api(f.nodeA, session, "POST", "/background-tasks/operation", {
      nodeId: f.nodeB.nodeId,
      command: { action: "get", projectId: project.id, conversationId, id: taskId },
    });
    assert.equal(missing.status, 404);

    legacyStatus = 403;
    legacyError = "Project is not shared with this node";
    const deniedOverview = await api(f.nodeA, session, "GET", `/background-tasks?projectId=${project.id}&conversationId=${conversationId}`);
    assert.equal(deniedOverview.status, 403);
    const deniedOperation = await api<{ error: string }>(f.nodeA, session, "POST", "/background-tasks/operation", {
      nodeId: f.nodeB.nodeId,
      command: { action: "get", projectId: project.id, conversationId, id: taskId },
    });
    assert.equal(deniedOperation.status, 403);
    assert.equal(deniedOperation.body.error, "Project is not shared with this node");
  } finally {
    legacy.closeAllConnections();
    await new Promise<void>((resolve, reject) => legacy.close((error) => error ? reject(error) : resolve()));
    await closeBackgroundClusterFixture(f);
  }
});
