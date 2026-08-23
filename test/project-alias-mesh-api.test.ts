import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

interface NodeProcess { baseUrl: string; child: ChildProcess; homeDir: string; dataDir: string; output: () => string; }
interface Session { headers: Record<string, string>; }
interface SyncthingServer { url: string; apiKey: string; server: Server; }

async function startSyncthing(): Promise<SyncthingServer> {
  const apiKey = "test-syncthing-api-key";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("Content-Type", "application/json");
    if (request.headers["x-api-key"] !== apiKey) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/rest/system/status") {
      response.end(JSON.stringify({ myID: "TEST-DEVICE" }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/rest/config/folders") {
      response.end(JSON.stringify([{ id: "legacy-folder", label: "Legacy", path: "/tmp/legacy-folder", type: "sendreceive", devices: [] }]));
      return;
    }
    if (request.method === "GET" && url.pathname === "/rest/db/ignores" && url.searchParams.get("folder") === "legacy-folder") {
      response.end(JSON.stringify({ ignore: [] }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/rest/db/ignores" && url.searchParams.get("folder") === "legacy-folder") {
      response.end(JSON.stringify({}));
      return;
    }
    if (request.method === "GET" && url.pathname === "/rest/db/status" && url.searchParams.get("folder") === "legacy-folder") {
      response.end(JSON.stringify({ state: "idle", needTotalItems: 0, needBytes: 0, errors: [] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  return { url: `http://127.0.0.1:${port}`, apiKey, server };
}

async function stopSyncthing(syncthing: SyncthingServer): Promise<void> {
  await new Promise<void>((resolve, reject) => syncthing.server.close((error) => error ? reject(error) : resolve()));
}

async function startNode(root: string, name: string, syncthing: SyncthingServer): Promise<NodeProcess> {
  const homeDir = path.join(root, `${name}-home`);
  const dataDir = path.join(root, `${name}-data`);
  await mkdir(homeDir, { recursive: true });
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."),
    env: { ...process.env, PORT: "0", HOME: homeDir, PI_WEB_DATA_DIR: dataDir, MASTER_BOB_ADMIN_USERNAME: "admin", MASTER_BOB_INITIAL_PASSWORD: "initial-password", PI_MOBILE_WEB_SYNCTHING_URL: syncthing.url, PI_MOBILE_WEB_SYNCTHING_API_KEY: syncthing.apiKey },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${name} exited during startup (${child.exitCode})\n${output}`);
    const match = output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/);
    if (match) {
      const node = { baseUrl: `http://127.0.0.1:${match[1]}`, child, homeDir, dataDir, output: () => output };
      try {
        if ((await fetch(`${node.baseUrl}/api/health`)).ok) return node;
      } catch {
        // The child has not started accepting requests yet.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGTERM");
  throw new Error(`${name} did not become healthy\n${output}`);
}

async function stopNode(node: NodeProcess): Promise<void> {
  if (node.child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => node.child.once("exit", () => resolve()));
  node.child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (node.child.exitCode === null) node.child.kill("SIGKILL");
}

async function login(node: NodeProcess): Promise<Session> {
  const response = await fetch(`${node.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
  assert.equal(response.status, 200, node.output());
  const body = await response.json() as { csrfToken: string };
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error(node.output());
  const headers = { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" };
  const changed = await fetch(`${node.baseUrl}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) });
  assert.equal(changed.status, 204, node.output());
  return { headers };
}

async function nodeId(node: NodeProcess, auth: Session): Promise<string> {
  const response = await fetch(`${node.baseUrl}/api/cluster/node`, { headers: auth.headers });
  assert.equal(response.status, 200, node.output());
  return (await response.json() as { node: { id: string } }).node.id;
}

async function waitForTask(node: NodeProcess, auth: Session, projectId: string, taskId: string, predicate: (task: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${node.baseUrl}/api/projects/${projectId}/tasks`, { headers: auth.headers });
    assert.equal(response.status, 200, node.output());
    const task = (await response.json() as { tasks: Array<Record<string, unknown>> }).tasks.find((candidate) => candidate.id === taskId);
    if (task && predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(node.output());
}

async function waitForTaskAbsent(node: NodeProcess, auth: Session, projectIds: string[], taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const responses = await Promise.all(projectIds.map((projectId) => fetch(`${node.baseUrl}/api/projects/${projectId}/tasks`, { headers: auth.headers })));
    assert(responses.every((response) => response.status === 200), node.output());
    const tasks = await Promise.all(responses.map(async (response) => (await response.json() as { tasks: Array<Record<string, unknown>> }).tasks));
    if (tasks.every((items) => !items.some((task) => task.id === taskId))) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(node.output());
}

async function waitForName(node: NodeProcess, auth: Session, projectId: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${node.baseUrl}/api/projects`, { headers: auth.headers });
    assert.equal(response.status, 200, node.output());
    const project = (await response.json() as { projects: Array<{ id: string; name: string }> }).projects.find((candidate) => candidate.id === projectId);
    if (project?.name === "Renamed across aliases") return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(node.output());
}

test("legacy project aliases converge names, tasks, and handoff across paired nodes", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-project-alias-mesh-"));
  const nodes: NodeProcess[] = [];
  const syncthing = await startSyncthing();
  try {
    const [a, b] = await Promise.all([startNode(root, "a", syncthing), startNode(root, "b", syncthing)]);
    nodes.push(a, b);
    const [aAuth, bAuth] = await Promise.all([login(a), login(b)]);
    for (const [node, auth, name] of [[a, aAuth, "A"], [b, bAuth, "B"]] as const) {
      const response = await fetch(`${node.baseUrl}/api/cluster/node`, { method: "PUT", headers: auth.headers, body: JSON.stringify({ name, url: node.baseUrl }) });
      assert.equal(response.status, 200, node.output());
    }
    const [aProjectResponse, bProjectResponse] = await Promise.all([
      fetch(`${a.baseUrl}/api/projects`, { method: "POST", headers: aAuth.headers, body: JSON.stringify({ name: "shared", path: path.join(a.homeDir, "project") }) }),
      fetch(`${b.baseUrl}/api/projects`, { method: "POST", headers: bAuth.headers, body: JSON.stringify({ name: "shared", path: path.join(b.homeDir, "project") }) }),
    ]);
    assert.equal(aProjectResponse.status, 201, a.output());
    assert.equal(bProjectResponse.status, 201, b.output());
    const aProject = (await aProjectResponse.json() as { project: { id: string } }).project;
    const bProject = (await bProjectResponse.json() as { project: { id: string } }).project;
    assert.notEqual(aProject.id, bProject.id);

    for (const node of [a, b]) {
      const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
      db.prepare("UPDATE projects SET sync_folder_id = 'legacy-folder' WHERE id = ?").run(node === a ? aProject.id : bProject.id);
      db.close();
    }

    const bTokenResponse = await fetch(`${b.baseUrl}/api/cluster/invite`, { headers: bAuth.headers });
    assert.equal(bTokenResponse.status, 200, b.output());
    const bToken = (await bTokenResponse.json() as { token: string }).token;
    const paired = await fetch(`${a.baseUrl}/api/cluster/peers`, { method: "POST", headers: aAuth.headers, body: JSON.stringify({ url: b.baseUrl, token: bToken }) });
    assert.equal(paired.status, 201, `${a.output()}\n${b.output()}`);
    assert.deepEqual((await paired.json() as { pending: unknown[] }).pending, []);

    const [aAliasProject, bAliasProject] = await Promise.all([
      fetch(`${a.baseUrl}/api/projects/${bProject.id}`, { headers: aAuth.headers }),
      fetch(`${b.baseUrl}/api/projects/${aProject.id}`, { headers: bAuth.headers }),
    ]);
    assert.equal(aAliasProject.status, 200, a.output());
    assert.equal(bAliasProject.status, 200, b.output());
    assert.equal((await aAliasProject.json() as { project: { id: string } }).project.id, aProject.id);
    assert.equal((await bAliasProject.json() as { project: { id: string } }).project.id, bProject.id);

    const renamed = await fetch(`${a.baseUrl}/api/projects/${aProject.id}`, { method: "PATCH", headers: aAuth.headers, body: JSON.stringify({ name: "Renamed across aliases" }) });
    assert.equal(renamed.status, 200, a.output());
    await waitForName(b, bAuth, bProject.id);

    const aId = await nodeId(a, aAuth);
    const taskId = "legacy-alias-task";
    const task = { id: taskId, title: "Legacy task", description: "No Git", status: "backlog", engine: "pi", planMode: false, reviewMode: false, phaseConfig: {}, sessionPath: null, worktreePath: null, worktreeBranch: null, mergedAt: null, currentNodeId: aId, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, originNodeId: aId, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const event = { id: randomUUID(), originNodeId: aId, entityType: "task", entityKey: `${aProject.id}:${taskId}`, operation: "upsert", payload: { projectId: aProject.id, task, originNodeId: aId }, createdAt: task.updatedAt };
    for (const [node, token] of [[a, await (await fetch(`${a.baseUrl}/api/cluster/invite`, { headers: aAuth.headers })).json() as { token: string }], [b, { token: bToken }]] as const) {
      const response = await fetch(`${node.baseUrl}/api/cluster/events`, { method: "POST", headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ events: [event] }) });
      assert.equal(response.status, 200, node.output());
    }
    await waitForTask(b, bAuth, bProject.id, taskId, () => true);
    await waitForTask(b, bAuth, aProject.id, taskId, () => true);

    const bId = await nodeId(b, bAuth);
    const handed = await fetch(`${a.baseUrl}/api/projects/${aProject.id}/tasks/${taskId}/handoff`, { method: "POST", headers: aAuth.headers, body: JSON.stringify({ peerId: bId }) });
    assert.equal(handed.status, 200, `${a.output()}\n${b.output()}`);
    await waitForTask(b, bAuth, bProject.id, taskId, (item) => item.currentNodeId === bId && item.executionState === "idle");
    const handoffDb = new DatabaseSync(path.join(b.dataDir, "node.db"));
    const incomingHandoff = handoffDb.prepare("SELECT handoff_id, project_id, protocol_project_id FROM task_handoffs WHERE direction = 'incoming' ORDER BY created_at DESC LIMIT 1").get() as { handoff_id: string; project_id: string; protocol_project_id: string };
    handoffDb.close();
    assert.equal(incomingHandoff.project_id, bProject.id);
    assert.equal(incomingHandoff.protocol_project_id, aProject.id);
    const status = await fetch(`${b.baseUrl}/api/cluster/tasks/status`, { method: "POST", headers: { Authorization: `Bearer ${bToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ handoffId: incomingHandoff.handoff_id }) });
    assert.equal(status.status, 200, b.output());
    assert.equal((await status.json() as { projectId: string }).projectId, aProject.id);

    const updated = await fetch(`${b.baseUrl}/api/projects/${bProject.id}/tasks/${taskId}`, { method: "PATCH", headers: bAuth.headers, body: JSON.stringify({ title: "Updated by B" }) });
    assert.equal(updated.status, 200, b.output());
    await waitForTask(a, aAuth, aProject.id, taskId, (item) => item.title === "Updated by B");

    const deleted = await fetch(`${b.baseUrl}/api/projects/${bProject.id}/tasks/${taskId}`, { method: "DELETE", headers: bAuth.headers });
    assert.equal(deleted.status, 204, b.output());
    await Promise.all([
      waitForTaskAbsent(a, aAuth, [aProject.id, bProject.id], taskId),
      waitForTaskAbsent(b, bAuth, [bProject.id, aProject.id], taskId),
    ]);
  } finally {
    await Promise.all(nodes.map(stopNode));
    await stopSyncthing(syncthing);
    await rm(root, { recursive: true, force: true });
  }
});

test("third node learns every legacy alias through one paired node", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-project-alias-third-node-"));
  const nodes: NodeProcess[] = [];
  const syncthing = await startSyncthing();
  try {
    const [a, b, c] = await Promise.all([startNode(root, "a", syncthing), startNode(root, "b", syncthing), startNode(root, "c", syncthing)]);
    nodes.push(a, b, c);
    const [aAuth, bAuth, cAuth] = await Promise.all([login(a), login(b), login(c)]);
    for (const [node, auth, name] of [[a, aAuth, "A"], [b, bAuth, "B"], [c, cAuth, "C"]] as const) {
      const response = await fetch(`${node.baseUrl}/api/cluster/node`, { method: "PUT", headers: auth.headers, body: JSON.stringify({ name, url: node.baseUrl }) });
      assert.equal(response.status, 200, node.output());
    }
    const created = await Promise.all(([[a, aAuth], [b, bAuth], [c, cAuth]] as const).map(async ([node, auth]) => {
      const response = await fetch(`${node.baseUrl}/api/projects`, { method: "POST", headers: auth.headers, body: JSON.stringify({ name: "shared", path: path.join(node.homeDir, "project") }) });
      assert.equal(response.status, 201, node.output());
      return (await response.json() as { project: { id: string } }).project;
    }));
    const [aProject, bProject, cProject] = created;
    for (const [node, project] of [[a, aProject], [b, bProject], [c, cProject]] as const) {
      const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
      db.prepare("UPDATE projects SET sync_folder_id = 'legacy-folder' WHERE id = ?").run(project.id);
      db.close();
    }

    const bTokenResponse = await fetch(`${b.baseUrl}/api/cluster/invite`, { headers: bAuth.headers });
    assert.equal(bTokenResponse.status, 200, b.output());
    const bToken = (await bTokenResponse.json() as { token: string }).token;
    const pairedAB = await fetch(`${a.baseUrl}/api/cluster/peers`, { method: "POST", headers: aAuth.headers, body: JSON.stringify({ url: b.baseUrl, token: bToken }) });
    assert.equal(pairedAB.status, 201, `${a.output()}\n${b.output()}`);

    const aTokenResponse = await fetch(`${a.baseUrl}/api/cluster/invite`, { headers: aAuth.headers });
    assert.equal(aTokenResponse.status, 200, a.output());
    const pairedCA = await fetch(`${c.baseUrl}/api/cluster/peers`, { method: "POST", headers: cAuth.headers, body: JSON.stringify({ url: a.baseUrl, token: (await aTokenResponse.json() as { token: string }).token }) });
    assert.equal(pairedCA.status, 201, `${a.output()}\n${c.output()}`);

    for (const aliasId of [aProject.id, bProject.id]) {
      const response = await fetch(`${c.baseUrl}/api/projects/${aliasId}`, { headers: cAuth.headers });
      assert.equal(response.status, 200, c.output());
      assert.equal((await response.json() as { project: { id: string } }).project.id, cProject.id);
    }
    const inventoryResponse = await fetch(`${c.baseUrl}/api/cluster/local-inventory`, { headers: cAuth.headers });
    assert.equal(inventoryResponse.status, 200, c.output());
    const inventory = await inventoryResponse.json() as { projects: Array<{ project: { id: string }; aliases: string[] }> };
    assert.deepEqual(inventory.projects.find((entry) => entry.project.id === cProject.id)?.aliases, [aProject.id, bProject.id].sort());

    const bId = await nodeId(b, bAuth);
    const taskId = "b-origin-alias-task";
    const updatedAt = "2026-03-04T00:00:00.000Z";
    const task = { id: taskId, title: "From B", description: "Replicated through A identity", status: "backlog", engine: "pi", planMode: false, reviewMode: false, phaseConfig: {}, sessionPath: null, worktreePath: null, worktreeBranch: null, mergedAt: null, currentNodeId: bId, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, originNodeId: bId, createdAt: updatedAt, updatedAt };
    const cTokenResponse = await fetch(`${c.baseUrl}/api/cluster/invite`, { headers: cAuth.headers });
    assert.equal(cTokenResponse.status, 200, c.output());
    const replicated = await fetch(`${c.baseUrl}/api/cluster/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${(await cTokenResponse.json() as { token: string }).token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ events: [
        { id: randomUUID(), originNodeId: bId, entityType: "task", entityKey: `${bProject.id}:${taskId}`, operation: "upsert", payload: { projectId: bProject.id, task, originNodeId: bId }, createdAt: updatedAt },
        { id: randomUUID(), originNodeId: bId, entityType: "name.override", entityKey: `projects:${bProject.id}`, operation: "upsert", payload: { scope: "projects", key: bProject.id, name: "Renamed across aliases", updatedAt, originNodeId: bId }, createdAt: updatedAt },
      ] }),
    });
    assert.equal(replicated.status, 200, c.output());
    await waitForTask(c, cAuth, cProject.id, taskId, (item) => item.title === "From B");
    await waitForName(c, cAuth, cProject.id);
  } finally {
    await Promise.all(nodes.map(stopNode));
    await stopSyncthing(syncthing);
    await rm(root, { recursive: true, force: true });
  }
});
