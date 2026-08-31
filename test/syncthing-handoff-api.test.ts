import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

interface NodeProcess { baseUrl: string; child: ChildProcess; homeDir: string; output: () => string; }
interface Session { headers: Record<string, string>; }
interface SyncthingStatus { state: string; needTotalItems: number; needBytes: number; errors?: unknown[] | number; }

async function listen(server: Server): Promise<number> {
  return await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

async function startNode(root: string, name: string, syncthingUrl: string): Promise<NodeProcess> {
  const homeDir = path.join(root, `${name}-home`);
  await mkdir(homeDir, { recursive: true });
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."),
    env: { ...process.env, PORT: "0", HOME: homeDir, PI_WEB_DATA_DIR: path.join(root, `${name}-data`), MASTER_BOB_ADMIN_USERNAME: "admin", MASTER_BOB_INITIAL_PASSWORD: "initial-password", PI_MOBILE_WEB_SYNCTHING_URL: syncthingUrl, PI_MOBILE_WEB_SYNCTHING_API_KEY: "test-key" },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  let stopped = false;
  node.child.once("exit", () => { stopped = true; });
  node.child.kill("SIGKILL");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (stopped) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Node process did not stop");
}

async function login(node: NodeProcess): Promise<Session> {
  const response = await fetch(`${node.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
  const body = await response.json() as { csrfToken: string };
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error(node.output());
  const headers = { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" };
  await fetch(`${node.baseUrl}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) });
  return { headers };
}

async function waitForTask(node: NodeProcess, auth: Session, projectId: string, taskId: string, predicate: (task: any) => boolean): Promise<any> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const body = await (await fetch(`${node.baseUrl}/api/projects/${projectId}/tasks`, { headers: auth.headers })).json() as { tasks: any[] };
    const task = body.tasks.find((item) => item.id === taskId);
    if (task && predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(node.output());
}

class FakeSyncthing {
  readonly requests: Array<{ method: string; url: string }> = [];
  readonly folders: Array<{ id: string; label: string; path: string; type: string; devices: Array<{ deviceID: string }> }> = [];
  readonly devices: Array<{ deviceID: string; name: string; addresses: string[] }> = [];
  statusSequence: SyncthingStatus[] = [];
  status: SyncthingStatus = { state: "idle", needTotalItems: 0, needBytes: 0 };
  server!: Server;

  async start(deviceId: string): Promise<string> {
    this.server = createServer((request, response) => {
      const url = request.url ?? "";
      this.requests.push({ method: request.method ?? "", url });
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        response.setHeader("Content-Type", "application/json");
        if (request.method === "GET" && url === "/rest/config/folders") { response.end(JSON.stringify(this.folders)); return; }
        if (request.method === "GET" && url === "/rest/config/devices") { response.end(JSON.stringify(this.devices)); return; }
        if (request.method === "POST" && url === "/rest/config/devices") { this.devices.push(JSON.parse(body)); response.end("{}"); return; }
        if (request.method === "POST" && url === "/rest/config/folders") { this.folders.push(JSON.parse(body)); response.end("{}"); return; }
        if (request.method === "PUT" && url.startsWith("/rest/config/folders/")) {
          const folder = JSON.parse(body) as { id: string };
          const index = this.folders.findIndex((candidate) => candidate.id === folder.id);
          this.folders[index] = folder;
          response.end("{}");
          return;
        }
        if (request.method === "GET" && url === "/rest/system/status") { response.end(JSON.stringify({ myID: deviceId })); return; }
        if (request.method === "GET" && url.startsWith("/rest/db/ignores?folder=")) { response.end(JSON.stringify({ ignore: [] })); return; }
        if (request.method === "POST" && url.startsWith("/rest/db/ignores?folder=")) { response.end("{}"); return; }
        if (request.method === "GET" && url.startsWith("/rest/db/status?folder=")) { response.end(JSON.stringify(this.statusSequence.shift() ?? this.status)); return; }
        response.statusCode = 404;
        response.end();
      });
    });
    return `http://127.0.0.1:${await listen(this.server)}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }

  ignoreRequests(): number {
    return this.requests.filter((request) => request.url.startsWith("/rest/db/ignores?folder=")).length;
  }
}

test("Syncthing readiness fences handoff ownership until both nodes are synchronized", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-syncthing-handoff-"));
  const nodes: NodeProcess[] = [];
  const sourceSyncthing = new FakeSyncthing();
  const destinationSyncthing = new FakeSyncthing();
  try {
    const [sourceUrl, destinationUrl] = await Promise.all([sourceSyncthing.start("SOURCE"), destinationSyncthing.start("DESTINATION")]);
    const [source, destination] = await Promise.all([startNode(root, "source", sourceUrl), startNode(root, "destination", destinationUrl)]);
    nodes.push(source, destination);
    const [sourceAuth, destinationAuth] = await Promise.all([login(source), login(destination)]);
    for (const [node, auth, name] of [[source, sourceAuth, "Source"], [destination, destinationAuth, "Destination"]] as const) {
      assert.equal((await fetch(`${node.baseUrl}/api/cluster/node`, { method: "PUT", headers: auth.headers, body: JSON.stringify({ name, url: node.baseUrl }) })).status, 200);
    }
    const destinationToken = (await (await fetch(`${destination.baseUrl}/api/cluster/invite`, { headers: destinationAuth.headers })).json() as { token: string }).token;
    assert.equal((await fetch(`${source.baseUrl}/api/cluster/peers`, { method: "POST", headers: sourceAuth.headers, body: JSON.stringify({ url: destination.baseUrl, token: destinationToken }) })).status, 201, source.output());
    const [sourceId, destinationId] = await Promise.all([
      (async () => ((await (await fetch(`${source.baseUrl}/api/cluster/node`, { headers: sourceAuth.headers })).json() as { node: { id: string } }).node.id))(),
      (async () => ((await (await fetch(`${destination.baseUrl}/api/cluster/node`, { headers: destinationAuth.headers })).json() as { node: { id: string } }).node.id))(),
    ]);
    const sourceProjectPath = path.join(root, "source-project");
    const destinationProjectPath = path.join(destination.homeDir, "project");
    await Promise.all([mkdir(sourceProjectPath, { recursive: true }), mkdir(destinationProjectPath, { recursive: true })]);
    const project = (await (await fetch(`${source.baseUrl}/api/projects`, { method: "POST", headers: sourceAuth.headers, body: JSON.stringify({ name: "shared", path: sourceProjectPath, synced: true }) })).json() as { project: { id: string; syncFolderId: string } }).project;
    assert.ok(project.syncFolderId);
    assert.equal((await fetch(`${destination.baseUrl}/api/cluster/projects/import`, { method: "POST", headers: destinationAuth.headers, body: JSON.stringify({ peerId: sourceId }) })).status, 200);
    assert.equal((await fetch(`${destination.baseUrl}/api/cluster/projects/map`, { method: "POST", headers: destinationAuth.headers, body: JSON.stringify({ peerId: sourceId, projectId: project.id, localPath: destinationProjectPath }) })).status, 201, destination.output());
    const task = { id: "synced-task", title: "Synced", description: "No Git", status: "backlog", engine: "pi", planMode: false, reviewMode: false, phaseConfig: {}, sessionPath: null, worktreePath: null, worktreeBranch: null, mergedAt: null, currentNodeId: sourceId, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, originNodeId: sourceId, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const sourceToken = (await (await fetch(`${source.baseUrl}/api/cluster/invite`, { headers: sourceAuth.headers })).json() as { token: string }).token;
    assert.equal((await fetch(`${source.baseUrl}/api/cluster/events`, { method: "POST", headers: { Authorization: `Bearer ${sourceToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ events: [{ id: randomUUID(), originNodeId: sourceId, entityType: "task", entityKey: `${project.id}:${task.id}`, operation: "upsert", payload: { projectId: project.id, task, originNodeId: sourceId }, createdAt: task.updatedAt }] }) })).status, 200);
    await Promise.all([waitForTask(source, sourceAuth, project.id, task.id, () => true), waitForTask(destination, destinationAuth, project.id, task.id, () => true)]);

    destinationSyncthing.status = { state: "syncing", needTotalItems: 1, needBytes: 0 };
    const rejected = await fetch(`${source.baseUrl}/api/projects/${project.id}/tasks/${task.id}/handoff`, { method: "POST", headers: sourceAuth.headers, body: JSON.stringify({ peerId: destinationId }) });
    assert.equal(rejected.status, 409, source.output());
    assert.equal((await waitForTask(source, sourceAuth, project.id, task.id, (candidate) => candidate.executionState === "idle")).currentNodeId, sourceId);

    destinationSyncthing.status = { state: "idle", needTotalItems: 0, needBytes: 0 };
    destinationSyncthing.statusSequence = [destinationSyncthing.status, { state: "syncing", needTotalItems: 1, needBytes: 0 }];
    const pending = await fetch(`${source.baseUrl}/api/projects/${project.id}/tasks/${task.id}/handoff`, { method: "POST", headers: sourceAuth.headers, body: JSON.stringify({ peerId: destinationId }) });
    assert.equal(pending.status, 202, source.output());
    const restored = await waitForTask(source, sourceAuth, project.id, task.id, (candidate) => candidate.currentNodeId === sourceId && candidate.executionState === "idle");
    assert.equal(restored.currentNodeId, sourceId);
    assert.equal((await waitForTask(destination, destinationAuth, project.id, task.id, (candidate) => candidate.executionState === "idle")).currentNodeId, sourceId);

    destinationSyncthing.statusSequence = [];
    const completed = await fetch(`${source.baseUrl}/api/projects/${project.id}/tasks/${task.id}/handoff`, { method: "POST", headers: sourceAuth.headers, body: JSON.stringify({ peerId: destinationId }) });
    assert.equal(completed.status, 200, source.output());
    await Promise.all([
      waitForTask(source, sourceAuth, project.id, task.id, (candidate) => candidate.currentNodeId === destinationId && candidate.executionState === "idle"),
      waitForTask(destination, destinationAuth, project.id, task.id, (candidate) => candidate.currentNodeId === destinationId && candidate.executionState === "idle"),
    ]);
    assert.ok(sourceSyncthing.ignoreRequests() > 0);
    assert.ok(destinationSyncthing.ignoreRequests() > 0);
    for (const syncthing of [sourceSyncthing, destinationSyncthing]) {
      assert.ok(!syncthing.folders.some((folder) => folder.id === "dot-pi"));
      assert.ok(!syncthing.folders.some((folder) => folder.id === "dot-claude"));
    }
    assert.ok(sourceSyncthing.folders.find((folder) => folder.id === "joint-bob-ticket-workspaces")?.devices.some((device) => device.deviceID === "DESTINATION"));
    assert.ok(destinationSyncthing.folders.find((folder) => folder.id === "joint-bob-ticket-workspaces")?.devices.some((device) => device.deviceID === "SOURCE"));
  } finally {
    await Promise.all(nodes.map(stopNode));
    await Promise.all([sourceSyncthing.stop(), destinationSyncthing.stop()]);
    await rm(root, { recursive: true, force: true });
  }
});
