import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import type { TaskRecord } from "../src/types.js";

interface NodeProcess { baseUrl: string; child: ChildProcess; homeDir: string; output: () => string; }
interface Session { headers: Record<string, string>; }
interface TaskReadyPayload {
  type: string;
  engine: string;
  sessionId: string;
  sessionFile: string | null;
  messages: Array<{ text: string }>;
  ownership: unknown;
  executionNodeId: string;
  readOnly: boolean;
}
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
    const match = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
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

async function openTaskSocket(node: NodeProcess, auth: Session, projectId: string, taskId: string, sessionPath: string, sessionId?: string): Promise<{ socket: WebSocket; ready: TaskReadyPayload }> {
  const url = new URL("/ws", node.baseUrl);
  url.protocol = "ws:";
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("taskId", taskId);
  if (sessionId) url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("sessionPath", sessionPath);
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Origin: node.baseUrl, Cookie: auth.headers.Cookie } });
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Task WebSocket did not send ready"));
    }, 10_000);
    const fail = (error: Error) => { clearTimeout(timeout); reject(error); };
    socket.once("error", fail);
    socket.once("close", (code, reason) => fail(new Error(`Task WebSocket closed before ready (${code}): ${reason}`)));
    socket.on("message", (raw) => {
      const payload = JSON.parse(raw.toString()) as TaskReadyPayload;
      if (payload.type !== "ready") return;
      clearTimeout(timeout);
      socket.off("error", fail);
      resolve({ socket, ready: payload });
    });
  });
}

function nextSocketPayload(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Task WebSocket did not send ${type}`)), 10_000);
    const onMessage = (raw: WebSocket.RawData): void => {
      const payload = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (payload.type !== type) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(payload);
    };
    socket.on("message", onMessage);
  });
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

    destinationSyncthing.status = { state: "syncing", needTotalItems: 1, needBytes: 2048 };
    const readiness = await fetch(`${source.baseUrl}/api/projects/${project.id}/tasks/${task.id}/eligibility`, { headers: sourceAuth.headers });
    assert.equal(readiness.status, 200, source.output());
    const destinationEntry = (await readiness.json() as { nodes: Array<{ node: { id: string }; eligible: boolean; waitingForSync: boolean; syncStatuses: Array<{ state: string; remainingFiles: number; remainingBytes: number }> }> }).nodes.find((entry) => entry.node.id === destinationId);
    assert.ok(destinationEntry);
    assert.equal(destinationEntry.eligible, false);
    assert.equal(destinationEntry.waitingForSync, true);
    assert.deepEqual(destinationEntry.syncStatuses.find((status) => status.state === "syncing"), { label: "shared", state: "syncing", remainingFiles: 1, remainingBytes: 2048, message: "Syncthing is synchronizing this folder" });
    const rejected = await fetch(`${source.baseUrl}/api/projects/${project.id}/tasks/${task.id}/handoff`, { method: "POST", headers: sourceAuth.headers, body: JSON.stringify({ peerId: destinationId }) });
    assert.equal(rejected.status, 409, source.output());
    assert.equal((await waitForTask(source, sourceAuth, project.id, task.id, (candidate) => candidate.executionState === "idle")).currentNodeId, sourceId);

    destinationSyncthing.status = { state: "idle", needTotalItems: 0, needBytes: 0, errors: 1 };
    const errorReadiness = await fetch(`${source.baseUrl}/api/projects/${project.id}/tasks/${task.id}/eligibility`, { headers: sourceAuth.headers });
    assert.equal(errorReadiness.status, 200, source.output());
    const errorDestinationEntry = (await errorReadiness.json() as { nodes: Array<{ node: { id: string }; eligible: boolean; waitingForSync: boolean; syncStatuses: Array<{ state: string }> }> }).nodes.find((entry) => entry.node.id === destinationId);
    assert.ok(errorDestinationEntry);
    assert.equal(errorDestinationEntry.eligible, false);
    assert.equal(errorDestinationEntry.waitingForSync, true);
    assert.equal(errorDestinationEntry.syncStatuses.find((status) => status.state === "error")?.state, "error");

    destinationSyncthing.status = { state: "idle", needTotalItems: 0, needBytes: 0 };
    sourceSyncthing.status = { state: "scanning", needTotalItems: 0, needBytes: 0 };
    const sourceReadiness = await fetch(`${source.baseUrl}/api/projects/${project.id}/tasks/${task.id}/eligibility`, { headers: sourceAuth.headers });
    assert.equal(sourceReadiness.status, 200, source.output());
    const sourceEntry = (await sourceReadiness.json() as { source: { node: { id: string }; eligible: boolean; waitingForSync: boolean; syncStatuses: Array<{ state: string }> } }).source;
    assert.equal(sourceEntry.node.id, sourceId);
    assert.equal(sourceEntry.eligible, false);
    assert.equal(sourceEntry.waitingForSync, true);
    assert.equal(sourceEntry.syncStatuses.find((status) => status.state === "syncing")?.state, "syncing");
    const remoteReadiness = await fetch(`${destination.baseUrl}/api/projects/${project.id}/tasks/${task.id}/eligibility`, { headers: destinationAuth.headers });
    assert.equal(remoteReadiness.status, 200, destination.output());
    const remoteSourceEntry = (await remoteReadiness.json() as { source: { node: { id: string }; waitingForSync: boolean; syncStatuses: Array<{ state: string }> } }).source;
    assert.equal(remoteSourceEntry.node.id, sourceId);
    assert.equal(remoteSourceEntry.waitingForSync, true);
    assert.equal(remoteSourceEntry.syncStatuses.find((status) => status.state === "syncing")?.state, "syncing");

    sourceSyncthing.status = { state: "idle", needTotalItems: 0, needBytes: 0 };
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
    for (const [syncthing, node, peerDevice] of [[sourceSyncthing, source, "DESTINATION"], [destinationSyncthing, destination, "SOURCE"]] as const) {
      assert.equal(syncthing.folders.find((folder) => folder.id === "joint-bob-conversations-pi")?.path, path.join(node.homeDir, ".pi", "agent", "sessions"));
      assert.equal(syncthing.folders.find((folder) => folder.id === "joint-bob-conversations-claude")?.path, path.join(node.homeDir, ".claude", "projects"));
      assert.ok(syncthing.folders.find((folder) => folder.id === "joint-bob-conversations-pi")?.devices.some((device) => device.deviceID === peerDevice));
      assert.ok(syncthing.folders.find((folder) => folder.id === "joint-bob-conversations-claude")?.devices.some((device) => device.deviceID === peerDevice));
    }
    assert.ok(sourceSyncthing.folders.find((folder) => folder.id === "joint-bob-ticket-workspaces")?.devices.some((device) => device.deviceID === "DESTINATION"));
    assert.ok(destinationSyncthing.folders.find((folder) => folder.id === "joint-bob-ticket-workspaces")?.devices.some((device) => device.deviceID === "SOURCE"));
  } finally {
    await Promise.all(nodes.map(stopNode));
    await Promise.all([sourceSyncthing.stop(), destinationSyncthing.stop()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("task handoff preserves an undiscovered Claude ticket transcript and moves its ownership", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-ticket-handoff-"));
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
      assert.equal((await fetch(`${node.baseUrl}/api/settings`, { method: "PUT", headers: auth.headers, body: JSON.stringify({ pi: { executable: "", configPath: "", sessionPath: "" }, claude: { executable: "true", configPath: "", sessionPath: "" }, syncthing: { endpoint: node === source ? sourceUrl : destinationUrl } }) })).status, 200);
    }
    const destinationToken = (await (await fetch(`${destination.baseUrl}/api/cluster/invite`, { headers: destinationAuth.headers })).json() as { token: string }).token;
    assert.equal((await fetch(`${source.baseUrl}/api/cluster/peers`, { method: "POST", headers: sourceAuth.headers, body: JSON.stringify({ url: destination.baseUrl, token: destinationToken }) })).status, 201, source.output());
    const [sourceId, destinationId, sourceToken] = await Promise.all([
      (async () => ((await (await fetch(`${source.baseUrl}/api/cluster/node`, { headers: sourceAuth.headers })).json() as { node: { id: string } }).node.id))(),
      (async () => ((await (await fetch(`${destination.baseUrl}/api/cluster/node`, { headers: destinationAuth.headers })).json() as { node: { id: string } }).node.id))(),
      (async () => ((await (await fetch(`${source.baseUrl}/api/cluster/invite`, { headers: sourceAuth.headers })).json() as { token: string }).token))(),
    ]);
    const sourceProjectPath = path.join(root, "source-project");
    const destinationProjectPath = path.join(destination.homeDir, "project");
    await Promise.all([mkdir(sourceProjectPath, { recursive: true }), mkdir(destinationProjectPath, { recursive: true })]);
    const project = (await (await fetch(`${source.baseUrl}/api/projects`, { method: "POST", headers: sourceAuth.headers, body: JSON.stringify({ name: "shared", path: sourceProjectPath, synced: true }) })).json() as { project: { id: string } }).project;
    assert.equal((await fetch(`${destination.baseUrl}/api/cluster/projects/import`, { method: "POST", headers: destinationAuth.headers, body: JSON.stringify({ peerId: sourceId }) })).status, 200);
    assert.equal((await fetch(`${destination.baseUrl}/api/cluster/projects/map`, { method: "POST", headers: destinationAuth.headers, body: JSON.stringify({ peerId: sourceId, projectId: project.id, localPath: destinationProjectPath }) })).status, 201, destination.output());

    const sessionId = randomUUID();
    const sourceSessionFile = path.join(source.homeDir, ".claude", "projects", "-legacy-ticket", `${sessionId}.jsonl`);
    const destinationSessionFile = path.join(destination.homeDir, ".claude", "projects", "-legacy-ticket", `${sessionId}.jsonl`);
    const transcript = `${JSON.stringify({ type: "user", sessionId, cwd: "/legacy/ticket", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "preserved ticket message" } })}\n`;
    await Promise.all([
      mkdir(path.dirname(sourceSessionFile), { recursive: true }).then(() => writeFile(sourceSessionFile, transcript)),
      mkdir(path.dirname(destinationSessionFile), { recursive: true }).then(() => writeFile(destinationSessionFile, transcript)),
    ]);
    const now = "2026-01-01T00:00:00.000Z";
    const task: TaskRecord = {
      id: "legacy-ticket-task", title: "Legacy ticket", description: "Preserve transcript", attachments: [], status: "done", engine: "claude", planMode: false, reviewMode: false, phaseConfig: {}, sessionPath: `claude:${sourceSessionFile}`, worktreePath: null, worktreeBranch: null, mergedAt: null,
      mergeState: "none", conflictCount: 0, mergeWarning: null, mergeTx: null, mergeDigests: null, runKind: null,
      currentNodeId: sourceId, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, originNodeId: sourceId, createdAt: now, updatedAt: now,
    };
    const record = { projectId: project.id, engine: "claude", sessionId, createdAt: now, updatedAt: now, originNodeId: sourceId, taskId: task.id };
    const events = [
      { id: randomUUID(), originNodeId: sourceId, entityType: "task", entityKey: `${project.id}:${task.id}`, operation: "upsert", payload: { projectId: project.id, task, originNodeId: sourceId }, createdAt: now },
      { id: randomUUID(), originNodeId: sourceId, entityType: "conversation.record", entityKey: `${project.id}:claude:${sessionId}`, operation: "upsert", payload: { projectId: project.id, engine: "claude", sessionId, record, updatedAt: now, originNodeId: sourceId }, createdAt: now },
    ];
    assert.equal((await fetch(`${source.baseUrl}/api/cluster/events`, { method: "POST", headers: { Authorization: `Bearer ${sourceToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ events }) })).status, 200, source.output());
    await Promise.all([waitForTask(source, sourceAuth, project.id, task.id, () => true), waitForTask(destination, destinationAuth, project.id, task.id, () => true)]);

    // Claims are local-first, so the handoff's owner is established by applying the
    // same ownership record through the replication endpoint instead of the removed
    // coordinator claim.
    const ownershipRecord = { engine: "claude", sessionId, ownerNodeId: sourceId, epoch: 1, status: "owned", transferToNodeId: null };
    for (const node of [source, destination]) {
      const apply = await fetch(`${node.baseUrl}/api/cluster/sessions/ownership/apply`, { method: "POST", headers: { Authorization: `Bearer ${sourceToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ record: ownershipRecord, originNodeId: sourceId }) });
      assert.equal(apply.status, 200, node.output());
      assert.equal(((await apply.json()) as { accepted: boolean }).accepted, true, node.output());
    }

    const handoff = await fetch(`${source.baseUrl}/api/projects/${project.id}/tasks/${task.id}/handoff`, { method: "POST", headers: sourceAuth.headers, body: JSON.stringify({ peerId: destinationId }) });
    assert.equal(handoff.status, 200, source.output());
    const handedOff = await handoff.json() as { task: TaskRecord };
    assert.equal(handedOff.task.sessionPath, `claude:${destinationSessionFile}`);
    await Promise.all([
      waitForTask(source, sourceAuth, project.id, task.id, (candidate) => candidate.currentNodeId === destinationId && candidate.executionState === "idle"),
      waitForTask(destination, destinationAuth, project.id, task.id, (candidate) => candidate.currentNodeId === destinationId && candidate.executionState === "idle"),
    ]);

    const sourceReplica = await waitForTask(source, sourceAuth, project.id, task.id, (candidate) => candidate.currentNodeId === destinationId);
    assert.equal(sourceReplica.sessionPath, `claude:${sourceSessionFile}`, "Previous owner retains the synchronized conversation pointer");

    // Board cards only carry their node-local task path, not the session id.
    // The owner must recover the stable identity after the source proxies this path.
    const opened = await openTaskSocket(source, sourceAuth, project.id, task.id, sourceReplica.sessionPath!);
    const { ready } = opened;
    assert.equal(ready.engine, "claude");
    assert.equal(ready.sessionId, sessionId);
    assert.equal(ready.sessionFile, `claude:${destinationSessionFile}`);
    assert.equal(ready.messages.some((message: { text: string }) => message.text === "preserved ticket message"), true);
    assert.equal(ready.ownership, null);
    assert.equal(ready.executionNodeId, destinationId);
    assert.equal(ready.readOnly, true);

    const renamed = await fetch(`${destination.baseUrl}/api/projects/${project.id}/sessions/title`, {
      method: "PUT",
      headers: destinationAuth.headers,
      body: JSON.stringify({ engine: "claude", sessionId, title: "Mutated title" }),
    });
    assert.equal(renamed.status, 409, "Done conversation title must be immutable");
    const removed = await fetch(`${source.baseUrl}/api/projects/${project.id}/sessions?engine=claude&sessionId=${sessionId}&taskId=${task.id}`, {
      method: "DELETE",
      headers: sourceAuth.headers,
    });
    assert.equal(removed.status, 409, "Done conversation transcript must not be removable");

    const rejected = nextSocketPayload(opened.socket, "error");
    opened.socket.send(JSON.stringify({ type: "prompt", message: "mutate a finished ticket" }));
    assert.deepEqual(await rejected, { type: "error", error: "Done ticket conversations are read-only" });
    opened.socket.close();
    const ownership = await (await fetch(`${destination.baseUrl}/api/cluster/sessions/ownership?engine=claude&sessionId=${sessionId}`, { headers: { Authorization: `Bearer ${destinationToken}` } })).json() as { ownership: { ownerNodeId: string; status: string } };
    assert.equal(ownership.ownership.ownerNodeId, destinationId);
    assert.equal(ownership.ownership.status, "owned");
  } finally {
    await Promise.all(nodes.map(stopNode));
    await Promise.all([sourceSyncthing.stop(), destinationSyncthing.stop()]);
    await rm(root, { recursive: true, force: true });
  }
});
