import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { taskApi } from "../bin/joint-bob-task.mjs";
import { mintTaskToken, readSupervisorControl, supervisorRequest } from "../scripts/supervisor-client.mjs";
import { backgroundClusterFixture, closeBackgroundClusterFixture, startSyntheticTask } from "./background-tasks-fixture.js";

const execute = promisify(execFile);
const cli = path.resolve("bin/joint-bob-task.mjs");

function agentFetch(url: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${url}/api/background-tasks/agent`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function runCli(nodeUrl: string, dataDir: string, token: string, args: string[]) {
  return execute(process.execPath, [cli, ...args], {
    cwd: path.resolve("."),
    env: {
      PATH: process.env.PATH ?? "",
      JOINT_BOB_TASK_TOKEN: token,
      JOINT_BOB_TASK_SOCKET: readSupervisorControl(dataDir)!.socketPath,
      JOINT_BOB_TASK_API: `${nodeUrl}/api/background-tasks/agent`,
    },
  });
}

function seedReturnedShellCalls(dataDir: string, root: string, identity: string): void {
  const node = new DatabaseSync(path.join(dataDir, "node.db"));
  const supervisor = new DatabaseSync(path.join(dataDir, "supervisor.db"));
  try {
    node.exec("PRAGMA busy_timeout=5000");
    supervisor.exec("PRAGMA busy_timeout=5000");
    node.exec("CREATE TABLE IF NOT EXISTS supervised_shell_calls(task_id TEXT PRIMARY KEY,state TEXT NOT NULL,foreground_until INTEGER NOT NULL)");
    const insertTask = supervisor.prepare("INSERT INTO supervisor_tasks(id,identity,name,executable,args_json,cwd,status,pid,started_at,ended_at,exit_code,signal,error) VALUES (?,?,?,'synthetic','[]',?,'completed',NULL,?,NULL,0,NULL,NULL)");
    const insertPolicy = node.prepare("INSERT INTO supervised_shell_calls(task_id,state,foreground_until) VALUES (?,'returned',0)");
    const startedAt = new Date().toISOString();
    for (let index = 0; index < 101; index++) {
      const taskId = randomUUID();
      insertTask.run(taskId, identity, `returned-shell-${index}`, root, startedAt);
      insertPolicy.run(taskId);
    }
  } finally {
    supervisor.close();
    node.close();
  }
}

test("task relay URL accepts the normalized HTTP port and rejects unsafe endpoints", () => {
  const endpoint = "http://127.0.0.1/api/background-tasks/agent";
  assert.equal(taskApi("http://127.0.0.1:80/api/background-tasks/agent"), endpoint);
  assert.equal(taskApi(endpoint), endpoint);
  for (const invalid of [
    "http://127.0.0.1:0/api/background-tasks/agent",
    "http://localhost:80/api/background-tasks/agent",
    "http://127.0.0.1:80/wrong",
    "http://127.0.0.1:80/api/background-tasks/agent?query=1",
    "http://user:password@127.0.0.1:80/api/background-tasks/agent",
  ]) assert.throws(() => taskApi(invalid), /Remote background task relay is unavailable/);
});

test("scoped task CLI reads and stops a task on its explicit source node", { timeout: 60_000 }, async () => {
  const fixture = await backgroundClusterFixture();
  const [nodeA, nodeB] = fixture.nodes;
  const projectA = nodeA.projects.find((project) => project.name === "Joint Bob")!;
  const projectB = nodeB.projects.find((project) => project.name === "Joint Bob")!;
  const conversationId = randomUUID();
  const taskA = randomUUID();
  const taskB = randomUUID();
  const token = mintTaskToken(nodeA.dataDir, JSON.stringify([projectA.id, conversationId]));
  try {
    await startSyntheticTask({ node: nodeA, root: fixture.root }, projectA.id, conversationId, taskA, true);
    await startSyntheticTask({ node: nodeB, root: fixture.root }, projectB.id, conversationId, taskB, true);

    let output = "";
    for (let attempt = 0; attempt < 40 && !output.includes("safe-output"); attempt++) {
      output = (await runCli(nodeA.url, nodeA.dataDir, token, ["output", taskB, "--node", nodeB.nodeId])).stdout;
      if (!output.includes("safe-output")) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(output, /safe-output/);
    const status = JSON.parse((await runCli(nodeA.url, nodeA.dataDir, token, ["status", taskB, "--node", nodeB.nodeId])).stdout) as { id: string };
    assert.equal(status.id, taskB);
    await runCli(nodeA.url, nodeA.dataDir, token, ["stop", taskB, "--node", nodeB.nodeId]);
    assert.equal((await supervisorRequest<{ status: string }>(nodeA.dataDir, { action: "task", id: taskA })).status, "running");

    seedReturnedShellCalls(nodeA.dataDir, fixture.root, JSON.stringify([projectA.id, conversationId]));
    const listed = JSON.parse((await runCli(nodeA.url, nodeA.dataDir, token, ["status"])).stdout) as Array<{ id: string }>;
    assert.deepEqual(listed.map((task) => task.id), [taskA]);

    const wrong = mintTaskToken(nodeA.dataDir, JSON.stringify([projectA.id, randomUUID()]));
    assert.equal((await agentFetch(nodeA.url, wrong, { nodeId: nodeB.nodeId, action: "get", id: taskB })).status, 404);
    assert.equal((await agentFetch(nodeA.url, randomBytes(32).toString("base64url"), { nodeId: nodeB.nodeId, action: "get", id: taskB })).status, 401);
    assert.equal((await agentFetch(nodeA.url, token, { nodeId: nodeB.nodeId, action: "list", projectId: projectA.id })).status, 400);
    assert.equal((await agentFetch(nodeA.url, token, { nodeId: randomUUID(), action: "list" })).status, 404);

    const operation = await fetch(`${nodeA.url}/api/background-tasks/operation`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(operation.status, 401);
    const cluster = await fetch(`${nodeA.url}/api/cluster/background-tasks`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(cluster.status, 401);

    const expired = mintTaskToken(nodeA.dataDir, JSON.stringify([projectA.id, conversationId]));
    const database = new DatabaseSync(path.join(nodeA.dataDir, "supervisor.db"));
    database.prepare("UPDATE supervisor_task_tokens SET expires_at=0 WHERE token_hash=?").run((await import("node:crypto")).createHash("sha256").update(expired).digest("hex"));
    database.close();
    assert.equal((await agentFetch(nodeA.url, expired, { nodeId: nodeB.nodeId, action: "list" })).status, 401);

    await assert.rejects(runCli(nodeA.url, nodeA.dataDir, token, ["start", "--node", nodeB.nodeId, "--", process.execPath, "-e", "process.exit()"]), /Remote task starts are not supported/);
    await assert.rejects(execute(process.execPath, [cli, "status", "--node", nodeB.nodeId], { env: { PATH: process.env.PATH ?? "", JOINT_BOB_TASK_TOKEN: token, JOINT_BOB_TASK_API: "http://localhost:1234/api/background-tasks/agent" } }), /Remote background task relay is unavailable/);
  } finally {
    await closeBackgroundClusterFixture(fixture);
  }
});
