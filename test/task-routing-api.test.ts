import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

interface NodeProcess { baseUrl: string; child: ChildProcess; homeDir: string; output: () => string; }
interface Session { headers: Record<string, string>; }

async function startNode(root: string, name: string): Promise<NodeProcess> {
  const homeDir = path.join(root, `${name}-home`);
  await mkdir(homeDir, { recursive: true });
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: path.resolve("."), env: { ...process.env, PORT: "0", HOME: homeDir, PI_WEB_DATA_DIR: path.join(root, `${name}-data`), MASTER_BOB_ADMIN_USERNAME: "admin", MASTER_BOB_INITIAL_PASSWORD: "initial-password" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${name} exited during startup (${child.exitCode})\n${output}`);
    const match = output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/);
    if (match && (await fetch(`http://127.0.0.1:${match[1]}/api/health`)).ok) return { baseUrl: `http://127.0.0.1:${match[1]}`, child, homeDir, output: () => output };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGTERM");
  throw new Error(`${name} did not become healthy\n${output}`);
}

async function stopNode(node: NodeProcess): Promise<void> {
  if (node.child.exitCode !== null) return;
  node.child.kill("SIGTERM");
  await new Promise((resolve) => node.child.once("exit", resolve));
}

async function login(node: NodeProcess): Promise<Session> {
  const response = await fetch(`${node.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
  const body = await response.json() as { csrfToken: string };
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error(node.output());
  const headers = { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" };
  assert.equal((await fetch(`${node.baseUrl}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) })).status, 204);
  return { headers };
}

async function nodeId(node: NodeProcess, auth: Session): Promise<string> {
  return ((await (await fetch(`${node.baseUrl}/api/cluster/node`, { headers: auth.headers })).json()) as { node: { id: string } }).node.id;
}

async function pair(source: NodeProcess, sourceAuth: Session, destination: NodeProcess, destinationAuth: Session): Promise<void> {
  const token = ((await (await fetch(`${destination.baseUrl}/api/cluster/invite`, { headers: destinationAuth.headers })).json()) as { token: string }).token;
  const response = await fetch(`${source.baseUrl}/api/cluster/peers`, { method: "POST", headers: sourceAuth.headers, body: JSON.stringify({ url: destination.baseUrl, token }) });
  assert.equal(response.status, 201, source.output());
}

async function waitForTask(node: NodeProcess, auth: Session, projectId: string, taskId: string, predicate: (task: any) => boolean): Promise<any> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(`${node.baseUrl}/api/projects/${projectId}/tasks`, { headers: auth.headers });
    const task = ((await response.json()) as { tasks: any[] }).tasks.find((item) => item.id === taskId);
    if (task && predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(node.output());
}

async function waitForAbsentTask(node: NodeProcess, auth: Session, projectId: string, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const body = await (await fetch(`${node.baseUrl}/api/projects/${projectId}/tasks`, { headers: auth.headers })).json() as { tasks: any[] };
    if (!body.tasks.some((task) => task.id === taskId)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(node.output());
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.once("close", (code) => resolve(code));
    socket.once("error", reject);
  });
}

function socketMessage(socket: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    socket.once("error", reject);
  });
}

test("task mutations and task watch sockets route through the recorded owner", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-task-routing-"));
  const nodes: NodeProcess[] = [];
  try {
    const [a, b, c] = await Promise.all([startNode(root, "a"), startNode(root, "b"), startNode(root, "c")]);
    nodes.push(a, b, c);
    const [aAuth, bAuth, cAuth] = await Promise.all([login(a), login(b), login(c)]);
    for (const [node, auth, name] of [[a, aAuth, "A"], [b, bAuth, "B"], [c, cAuth, "C"]] as const) {
      assert.equal((await fetch(`${node.baseUrl}/api/cluster/node`, { method: "PUT", headers: auth.headers, body: JSON.stringify({ name, url: node.baseUrl }) })).status, 200);
    }
    await pair(a, aAuth, b, bAuth);
    await pair(a, aAuth, c, cAuth);
    await pair(b, bAuth, c, cAuth);
    const [aId, bId] = await Promise.all([nodeId(a, aAuth), nodeId(b, bAuth)]);

    const projectPath = path.join(root, "project");
    await Promise.all([mkdir(projectPath, { recursive: true }), mkdir(path.join(b.homeDir, "project"), { recursive: true }), mkdir(path.join(c.homeDir, "project"), { recursive: true })]);
    const created = await fetch(`${a.baseUrl}/api/projects`, { method: "POST", headers: aAuth.headers, body: JSON.stringify({ name: "shared", path: projectPath }) });
    assert.equal(created.status, 201);
    const project = (await created.json() as { project: { id: string } }).project;
    for (const [node, auth] of [[b, bAuth], [c, cAuth]] as const) {
      assert.equal((await fetch(`${node.baseUrl}/api/cluster/projects/import`, { method: "POST", headers: auth.headers, body: JSON.stringify({ peerId: aId }) })).status, 200, node.output());
      assert.equal((await fetch(`${node.baseUrl}/api/cluster/projects/map`, { method: "POST", headers: auth.headers, body: JSON.stringify({ peerId: aId, projectId: project.id, localPath: path.join(node.homeDir, "project") }) })).status, 201, node.output());
    }

    const aToken = ((await (await fetch(`${a.baseUrl}/api/cluster/invite`, { headers: aAuth.headers })).json()) as { token: string }).token;
    const inject = async (id: string, ownerId: string, title: string, status = "backlog", sessionPath: string | null = null, executionState = "idle", leaseOwnerNodeId: string | null = null, leaseExpiresAt: string | null = null, phaseConfig: Record<string, unknown> = {}) => {
      const task = { id, title, description: "No runtime", status, engine: "pi", planMode: false, reviewMode: false, phaseConfig, sessionPath, worktreePath: null, worktreeBranch: null, mergedAt: null, currentNodeId: ownerId, leaseOwnerNodeId, leaseExpiresAt, executionState, handoffContext: null, originNodeId: aId, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: `2026-01-01T00:00:0${id.length % 10}.000Z` };
      const response = await fetch(`${a.baseUrl}/api/cluster/events`, { method: "POST", headers: { Authorization: `Bearer ${aToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ events: [{ id: randomUUID(), originNodeId: aId, entityType: "task", entityKey: `${project.id}:${id}`, operation: "upsert", payload: { projectId: project.id, task, originNodeId: aId }, createdAt: task.updatedAt }] }) });
      assert.equal(response.status, 200, a.output());
    };

    const routedTaskId = "task-owned-by-b";
    await inject(routedTaskId, bId, "Before", "backlog", "watch");
    await Promise.all([waitForTask(a, aAuth, project.id, routedTaskId, () => true), waitForTask(b, bAuth, project.id, routedTaskId, (task) => task.sessionPath === "watch"), waitForTask(c, cAuth, project.id, routedTaskId, (task) => task.sessionPath === "watch")]);
    const socketUrl = new URL(`/ws?projectId=${encodeURIComponent(project.id)}&sessionPath=watch&taskId=${routedTaskId}`, c.baseUrl);
    socketUrl.protocol = "ws:";
    const watch = new WebSocket(socketUrl, { origin: c.baseUrl, headers: { Cookie: cAuth.headers.Cookie } });
    assert.deepEqual(await socketMessage(watch), { type: "watchReady" });
    const watchClosed = closeCode(watch);
    watch.close();
    await watchClosed;
    const unauthenticated = new WebSocket(socketUrl, { origin: c.baseUrl });
    assert.equal(await closeCode(unauthenticated), 1008);

    const patched = await fetch(`${c.baseUrl}/api/projects/${project.id}/tasks/${routedTaskId}`, { method: "PATCH", headers: cAuth.headers, body: JSON.stringify({ title: "After" }) });
    assert.equal(patched.status, 200, c.output());
    await Promise.all([waitForTask(a, aAuth, project.id, routedTaskId, (task) => task.title === "After"), waitForTask(b, bAuth, project.id, routedTaskId, (task) => task.title === "After"), waitForTask(c, cAuth, project.id, routedTaskId, (task) => task.title === "After")]);
    assert.equal((await fetch(`${a.baseUrl}/api/projects/${project.id}/tasks/${routedTaskId}`, { method: "DELETE", headers: aAuth.headers })).status, 204, a.output());
    await Promise.all([waitForAbsentTask(a, aAuth, project.id, routedTaskId), waitForAbsentTask(b, bAuth, project.id, routedTaskId), waitForAbsentTask(c, cAuth, project.id, routedTaskId)]);

    const activeTaskId = "active-owned-by-b";
    await inject(activeTaskId, bId, "Active", "backlog", null, "running", bId, new Date(Date.now() + 60_000).toISOString());
    await Promise.all([waitForTask(a, aAuth, project.id, activeTaskId, (task) => task.executionState === "running"), waitForTask(b, bAuth, project.id, activeTaskId, (task) => task.executionState === "running")]);
    const activeDeletion = await fetch(`${a.baseUrl}/api/projects/${project.id}/tasks/${activeTaskId}`, { method: "DELETE", headers: aAuth.headers });
    assert.equal(activeDeletion.status, 409, a.output());
    assert.deepEqual(await activeDeletion.json(), { error: "Wait for task agent to finish before deleting" });
    await Promise.all([waitForTask(a, aAuth, project.id, activeTaskId, (task) => task.executionState === "running"), waitForTask(b, bAuth, project.id, activeTaskId, (task) => task.executionState === "running")]);
    const bDb = new (await import("node:sqlite")).DatabaseSync(path.join(root, "b-data", "node.db"));
    bDb.prepare("UPDATE tasks SET execution_state = 'idle', lease_owner_node_id = NULL, lease_expires_at = NULL, lease_token = NULL WHERE project_id = ? AND id = ?").run(project.id, activeTaskId);
    bDb.close();
    assert.equal((await fetch(`${a.baseUrl}/api/projects/${project.id}/tasks/${activeTaskId}`, { method: "DELETE", headers: aAuth.headers })).status, 204, a.output());
    await Promise.all([waitForAbsentTask(a, aAuth, project.id, activeTaskId), waitForAbsentTask(b, bAuth, project.id, activeTaskId)]);

    const invalidModelTaskId = "invalid-model-setup";
    await inject(invalidModelTaskId, aId, "Invalid model setup", "backlog", null, "idle", null, null, { in_progress: { engine: "pi", provider: "task-test-missing-provider", modelId: "task-test-missing-model", effort: "default" } });
    await waitForTask(a, aAuth, project.id, invalidModelTaskId, () => true);
    const invalidModelStart = await fetch(`${a.baseUrl}/api/projects/${project.id}/tasks/${invalidModelTaskId}`, { method: "PATCH", headers: aAuth.headers, body: JSON.stringify({ status: "in_progress" }) });
    assert.equal(invalidModelStart.status, 200, a.output());
    const failedSetup = await waitForTask(a, aAuth, project.id, invalidModelTaskId, (task) => task.executionState === "failed");
    assert.equal(failedSetup.leaseOwnerNodeId, null);
    assert.equal(failedSetup.leaseExpiresAt, null);
    const aDb = new (await import("node:sqlite")).DatabaseSync(path.join(root, "a-data", "node.db"));
    assert.equal((aDb.prepare("SELECT lease_token FROM tasks WHERE project_id = ? AND id = ?").get(project.id, invalidModelTaskId) as { lease_token: string | null }).lease_token, null);
    aDb.close();
    assert.match(a.output(), /Task start failed Error: Model not found: task-test-missing-provider\/task-test-missing-model/);
    assert.doesNotMatch(a.output(), /Pi task run failed/);
    assert.equal((await fetch(`${a.baseUrl}/api/projects/${project.id}/tasks/${invalidModelTaskId}`, { method: "DELETE", headers: aAuth.headers })).status, 204, a.output());
    await waitForAbsentTask(a, aAuth, project.id, invalidModelTaskId);

    const doneTaskId = "done-owned-by-b";
    await inject(doneTaskId, bId, "No worktree", "done");
    await waitForTask(c, cAuth, project.id, doneTaskId, () => true);
    const merge = await fetch(`${c.baseUrl}/api/projects/${project.id}/tasks/${doneTaskId}/merge`, { method: "POST", headers: cAuth.headers });
    assert.equal(merge.status, 409, c.output());
    assert.match((await merge.json() as { error: string }).error, /no isolated worktree/i);

    const handoffTaskId = "task-owned-by-a";
    await inject(handoffTaskId, aId, "Handoff", "backlog");
    await waitForTask(c, cAuth, project.id, handoffTaskId, () => true);
    const handoff = await fetch(`${c.baseUrl}/api/projects/${project.id}/tasks/${handoffTaskId}/handoff`, { method: "POST", headers: cAuth.headers, body: JSON.stringify({ peerId: bId }) });
    assert.equal(handoff.status, 200, c.output());
    await Promise.all([waitForTask(a, aAuth, project.id, handoffTaskId, (task) => task.currentNodeId === bId), waitForTask(b, bAuth, project.id, handoffTaskId, (task) => task.currentNodeId === bId), waitForTask(c, cAuth, project.id, handoffTaskId, (task) => task.currentNodeId === bId)]);
  } finally {
    await Promise.all(nodes.map(stopNode));
    await rm(root, { recursive: true, force: true });
  }
});
