// Two real twin nodes, each with its own HOME and a fake Syncthing, hand a ticket
// across only once both sides report the shared project folder synchronized.
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
import { projectTicketSyncFolderId } from "../src/task-workspaces.js";
import { freePort, pairTwinNodes, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

interface TwinNode extends SeededNode { home: string }
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
interface Job { root: string; key: string; claudeExecutable: string; project?: { name: string; path: string }; mirror?: { project: SeededNode["projects"][number]; path: string }; events?: unknown[] }

const username = "admin";
const password = "syncthing-handoff-password";
// Syncthing device IDs are eight groups of seven base32 characters.
const SOURCE_DEVICE = Array(8).fill("SOURCEA").join("-");
const DESTINATION_DEVICE = Array(8).fill("DESTINA").join("-");

async function listen(server: Server): Promise<number> {
  return await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

function runScript(dataDir: string, home: string, code: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, "--", ...args], {
      cwd: process.cwd(), env: { ...process.env, HOME: home, JOINT_BOB_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => status === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `child exited ${status}`)));
  });
}

/** Seeds one stopped node: its own HOME, an administrator, its identity, one project,
    and any locally originated replication events (which it replicates to its twin once running). */
async function seedNode(job: Job): Promise<TwinNode> {
  const port = await freePort();
  const home = path.join(job.root, `${job.key}-home`);
  const node = { key: job.key, name: `Node ${job.key}`, port, url: `http://127.0.0.1:${port}`, dataDir: path.join(job.root, `${job.key}-data`), cookieName: `mb_session_syncthing_${job.key}` };
  await mkdir(home, { recursive: true });
  const output = await runScript(node.dataDir, home, `
    const job = JSON.parse(process.argv[1]);
    const { updateSettings } = await import('./src/settings.ts');
    const { createAdministrator } = await import('./src/auth.ts');
    const { addProject, importProject } = await import('./src/store.ts');
    const { updateClusterNode } = await import('./src/cluster.ts');
    const { receiveReplicationBatch } = await import('./src/replication.ts');
    updateSettings({ pi: { executable: '', configPath: '', sessionPath: '' }, claude: { executable: job.claudeExecutable, configPath: '', sessionPath: '' }, syncthing: { endpoint: '' }, projects: { homePath: job.home + '/JointBob' } });
    createAdministrator(job.username, job.password, false);
    const cluster = await updateClusterNode(job.name, job.url);
    const project = job.mirror ? await importProject(job.mirror.project, job.mirror.path) : await addProject(job.project.name, job.project.path, { synced: true });
    const events = (job.events ?? []).map((event) => JSON.parse(JSON.stringify(event).replaceAll('__NODE__', cluster.id).replaceAll('__PROJECT__', project.id)));
    if (events.length) await receiveReplicationBatch({ events });
    console.log(JSON.stringify({ nodeId: cluster.id, project }));
  `, [JSON.stringify({ ...job, ...node, home, username, password })]);
  const parsed = JSON.parse(output) as { nodeId: string; project: SeededNode["projects"][number] };
  return { ...node, home, nodeId: parsed.nodeId, projects: [parsed.project] };
}

function nodeEnvironment(root: string, nodes: TwinNode[]): DevEnvironment {
  return { root, home: nodes[0].home, username, password, nodes };
}

// Each node runs with its own HOME, so its conversation roots differ from its twin's.
async function startNode(node: TwinNode, syncthingUrl: string): Promise<ChildProcess> {
  return startDevNode({ root: path.dirname(node.home), home: node.home, username, password, nodes: [node] }, node, { PI_MOBILE_WEB_SYNCTHING_URL: syncthingUrl, PI_MOBILE_WEB_SYNCTHING_API_KEY: "test-key" });
}

function headers(session: SignedIn): Record<string, string> {
  return { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" };
}

async function waitForTask(node: TwinNode, auth: SignedIn, projectId: string, taskId: string, predicate: (task: any) => boolean): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const body = await (await fetch(`${node.url}/api/projects/${projectId}/tasks`, { headers: headers(auth) })).json() as { tasks: any[] };
    const task = body.tasks.find((item) => item.id === taskId);
    last = task;
    if (task && predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Task ${taskId} on node ${node.key} never matched: ${JSON.stringify(last)}`);
}

async function waitUntil(what: string, check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function openTaskSocket(node: TwinNode, auth: SignedIn, projectId: string, taskId: string, sessionPath: string, sessionId?: string): Promise<{ socket: WebSocket; ready: TaskReadyPayload }> {
  const url = new URL("/ws", node.url);
  url.protocol = "ws:";
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("taskId", taskId);
  if (sessionId) url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("sessionPath", sessionPath);
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Origin: node.url, Cookie: auth.cookie } });
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

function taskEvent(task: Record<string, unknown>): Record<string, unknown> {
  return { id: randomUUID(), originNodeId: "__NODE__", entityType: "task", entityKey: `__PROJECT__:${task.id}`, operation: "upsert", payload: { projectId: "__PROJECT__", task, originNodeId: "__NODE__" }, createdAt: task.updatedAt };
}

class FakeSyncthing {
  readonly requests: Array<{ method: string; url: string }> = [];
  readonly folders: Array<{ id: string; label: string; path: string; type: string; paused?: boolean; devices: Array<{ deviceID: string }> }> = [];
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
        if (request.method === "DELETE" && url.startsWith("/rest/config/folders/")) {
          const id = decodeURIComponent(url.slice("/rest/config/folders/".length));
          this.folders.splice(this.folders.findIndex((candidate) => candidate.id === id), 1);
          response.end("{}");
          return;
        }
        if (request.method === "GET" && url === "/rest/system/connections") { response.end(JSON.stringify({ connections: Object.fromEntries(this.devices.map((device) => [device.deviceID, { connected: true }])) })); return; }
        if (request.method === "GET" && url.startsWith("/rest/db/completion?")) { response.end(JSON.stringify({ completion: 100, needItems: 0, needBytes: 0, needDeletes: 0, remoteState: "valid" })); return; }
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

test("Syncthing readiness fences handoff ownership until both nodes are synchronized", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-syncthing-handoff-"));
  const children: ChildProcess[] = [];
  const sourceSyncthing = new FakeSyncthing();
  const destinationSyncthing = new FakeSyncthing();
  try {
    const [sourceUrl, destinationUrl] = await Promise.all([sourceSyncthing.start(SOURCE_DEVICE), destinationSyncthing.start(DESTINATION_DEVICE)]);
    const seededTask = { id: "synced-task", title: "Synced", description: "No Git", status: "backlog", engine: "pi", planMode: false, reviewMode: false, phaseConfig: {}, sessionPath: null, worktreePath: null, worktreeBranch: null, mergedAt: null, currentNodeId: "__NODE__", leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, originNodeId: "__NODE__", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const source = await seedNode({ root, key: "source", claudeExecutable: "", project: { name: "shared", path: path.join(root, "source-project") }, events: [taskEvent(seededTask)] });
    const project = source.projects[0] as SeededNode["projects"][number] & { syncFolderId?: string };
    assert.ok(project.syncFolderId);
    const destination = await seedNode({ root, key: "destination", claudeExecutable: "", mirror: { project, path: path.join(root, "destination-home", "project") } });
    const [sourceId, destinationId] = [source.nodeId, destination.nodeId];
    const task = { ...seededTask, currentNodeId: sourceId, originNodeId: sourceId };
    children.push(await startNode(source, sourceUrl), await startNode(destination, destinationUrl));
    await pairTwinNodes(nodeEnvironment(root, [source, destination]));
    const [sourceAuth, destinationAuth] = await Promise.all([signIn(nodeEnvironment(root, [source]), source), signIn(nodeEnvironment(root, [destination]), destination)]);
    await Promise.all([waitForTask(source, sourceAuth, project.id, task.id, () => true), waitForTask(destination, destinationAuth, project.id, task.id, () => true)]);
    // Each twin enrolls the shared project's own Syncthing folders with the other's device.
    await waitUntil("per-project folder enrollment", async () => [[sourceSyncthing, DESTINATION_DEVICE], [destinationSyncthing, SOURCE_DEVICE]].every(([syncthing, peer]) =>
      (syncthing as FakeSyncthing).folders.find((folder) => folder.id === project.syncFolderId)?.devices.some((device) => device.deviceID === peer)));

    destinationSyncthing.status = { state: "syncing", needTotalItems: 1, needBytes: 2048 };
    const readiness = await fetch(`${source.url}/api/projects/${project.id}/tasks/${task.id}/eligibility`, { headers: headers(sourceAuth) });
    assert.equal(readiness.status, 200);
    const destinationEntry = (await readiness.json() as { nodes: Array<{ node: { id: string }; eligible: boolean; waitingForSync: boolean; syncStatuses: Array<{ state: string; remainingFiles: number; remainingBytes: number }> }> }).nodes.find((entry) => entry.node.id === destinationId);
    assert.ok(destinationEntry);
    assert.equal(destinationEntry.eligible, false);
    assert.equal(destinationEntry.waitingForSync, true);
    assert.deepEqual(destinationEntry.syncStatuses.find((status) => status.state === "syncing"), { label: "shared", state: "syncing", remainingFiles: 1, remainingBytes: 2048, message: "Syncthing is synchronizing this folder" });
    const rejected = await fetch(`${source.url}/api/projects/${project.id}/tasks/${task.id}/handoff`, { method: "POST", headers: headers(sourceAuth), body: JSON.stringify({ peerId: destinationId }) });
    assert.equal(rejected.status, 409);
    assert.equal((await waitForTask(source, sourceAuth, project.id, task.id, (candidate) => candidate.executionState === "idle")).currentNodeId, sourceId);

    destinationSyncthing.status = { state: "idle", needTotalItems: 0, needBytes: 0, errors: 1 };
    const errorReadiness = await fetch(`${source.url}/api/projects/${project.id}/tasks/${task.id}/eligibility`, { headers: headers(sourceAuth) });
    assert.equal(errorReadiness.status, 200);
    const errorDestinationEntry = (await errorReadiness.json() as { nodes: Array<{ node: { id: string }; eligible: boolean; waitingForSync: boolean; syncStatuses: Array<{ state: string }> }> }).nodes.find((entry) => entry.node.id === destinationId);
    assert.ok(errorDestinationEntry);
    assert.equal(errorDestinationEntry.eligible, false);
    assert.equal(errorDestinationEntry.waitingForSync, true);
    assert.equal(errorDestinationEntry.syncStatuses.find((status) => status.state === "error")?.state, "error");

    destinationSyncthing.status = { state: "idle", needTotalItems: 0, needBytes: 0 };
    sourceSyncthing.status = { state: "scanning", needTotalItems: 0, needBytes: 0 };
    const sourceReadiness = await fetch(`${source.url}/api/projects/${project.id}/tasks/${task.id}/eligibility`, { headers: headers(sourceAuth) });
    assert.equal(sourceReadiness.status, 200);
    const sourceEntry = (await sourceReadiness.json() as { source: { node: { id: string }; eligible: boolean; waitingForSync: boolean; syncStatuses: Array<{ state: string }> } }).source;
    assert.equal(sourceEntry.node.id, sourceId);
    assert.equal(sourceEntry.eligible, false);
    assert.equal(sourceEntry.waitingForSync, true);
    assert.equal(sourceEntry.syncStatuses.find((status) => status.state === "syncing")?.state, "syncing");
    const remoteReadiness = await fetch(`${destination.url}/api/projects/${project.id}/tasks/${task.id}/eligibility`, { headers: headers(destinationAuth) });
    assert.equal(remoteReadiness.status, 200);
    const remoteSourceEntry = (await remoteReadiness.json() as { source: { node: { id: string }; waitingForSync: boolean; syncStatuses: Array<{ state: string }> } }).source;
    assert.equal(remoteSourceEntry.node.id, sourceId);
    assert.equal(remoteSourceEntry.waitingForSync, true);
    assert.equal(remoteSourceEntry.syncStatuses.find((status) => status.state === "syncing")?.state, "syncing");

    assert.ok(sourceSyncthing.ignoreRequests() > 0);
    assert.ok(destinationSyncthing.ignoreRequests() > 0);
    for (const [syncthing, peerDevice] of [[sourceSyncthing, DESTINATION_DEVICE], [destinationSyncthing, SOURCE_DEVICE]] as const) {
      assert.ok(!syncthing.folders.some((folder) => folder.id === "dot-pi"));
      assert.ok(!syncthing.folders.some((folder) => folder.id === "dot-claude"));
      // A twin never receives whole transcript roots or the global ticket folder; it gets the
      // shared project's folder and that project's ticket folder.
      for (const id of ["joint-bob-conversations-pi", "joint-bob-conversations-claude", "joint-bob-ticket-workspaces"]) {
        assert.equal(syncthing.folders.find((folder) => folder.id === id)?.devices.some((device) => device.deviceID === peerDevice) ?? false, false, id);
      }
      assert.ok(syncthing.folders.find((folder) => folder.id === project.syncFolderId)?.devices.some((device) => device.deviceID === peerDevice));
      assert.ok(syncthing.folders.find((folder) => folder.id === projectTicketSyncFolderId(project.id))?.devices.some((device) => device.deviceID === peerDevice));
    }

    sourceSyncthing.status = { state: "idle", needTotalItems: 0, needBytes: 0 };
    destinationSyncthing.statusSequence = [destinationSyncthing.status, { state: "syncing", needTotalItems: 1, needBytes: 0 }];
    const pending = await fetch(`${source.url}/api/projects/${project.id}/tasks/${task.id}/handoff`, { method: "POST", headers: headers(sourceAuth), body: JSON.stringify({ peerId: destinationId }) });
    assert.equal(pending.status, 202);
    const restored = await waitForTask(source, sourceAuth, project.id, task.id, (candidate) => candidate.currentNodeId === sourceId && candidate.executionState === "idle");
    assert.equal(restored.currentNodeId, sourceId);
    assert.equal((await waitForTask(destination, destinationAuth, project.id, task.id, (candidate) => candidate.executionState === "idle")).currentNodeId, sourceId);

    destinationSyncthing.statusSequence = [];
    const completed = await fetch(`${source.url}/api/projects/${project.id}/tasks/${task.id}/handoff`, { method: "POST", headers: headers(sourceAuth), body: JSON.stringify({ peerId: destinationId }) });
    assert.equal(completed.status, 200);
    await Promise.all([
      waitForTask(source, sourceAuth, project.id, task.id, (candidate) => candidate.currentNodeId === destinationId && candidate.executionState === "idle"),
      waitForTask(destination, destinationAuth, project.id, task.id, (candidate) => candidate.currentNodeId === destinationId && candidate.executionState === "idle"),
    ]);
  } finally {
    await Promise.all(children.map(stopDevNode));
    await Promise.all([sourceSyncthing.stop(), destinationSyncthing.stop()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("task handoff preserves an undiscovered Claude ticket transcript and moves its ownership", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-ticket-handoff-"));
  const children: ChildProcess[] = [];
  const sourceSyncthing = new FakeSyncthing();
  const destinationSyncthing = new FakeSyncthing();
  try {
    const [sourceUrl, destinationUrl] = await Promise.all([sourceSyncthing.start(SOURCE_DEVICE), destinationSyncthing.start(DESTINATION_DEVICE)]);
    const sessionId = randomUUID();
    const sourceSessionFile = path.join(root, "source-home", ".claude", "projects", "-legacy-ticket", `${sessionId}.jsonl`);
    const destinationSessionFile = path.join(root, "destination-home", ".claude", "projects", "-legacy-ticket", `${sessionId}.jsonl`);
    const transcript = `${JSON.stringify({ type: "user", sessionId, cwd: "/legacy/ticket", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "preserved ticket message" } })}\n`;
    await Promise.all([
      mkdir(path.dirname(sourceSessionFile), { recursive: true }).then(() => writeFile(sourceSessionFile, transcript)),
      mkdir(path.dirname(destinationSessionFile), { recursive: true }).then(() => writeFile(destinationSessionFile, transcript)),
    ]);
    const now = "2026-01-01T00:00:00.000Z";
    const seededTask = {
      id: "legacy-ticket-task", title: "Legacy ticket", description: "Preserve transcript", attachments: [], status: "done", engine: "claude", planMode: false, reviewMode: false, phaseConfig: {}, sessionPath: `claude:${sourceSessionFile}`, worktreePath: null, worktreeBranch: null, mergedAt: null,
      mergeState: "none", conflictCount: 0, mergeWarning: null, mergeTx: null, mergeDigests: null, runKind: null,
      currentNodeId: "__NODE__", leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, originNodeId: "__NODE__", createdAt: now, updatedAt: now,
    };
    const record = { projectId: "__PROJECT__", engine: "claude", sessionId, createdAt: now, updatedAt: now, originNodeId: "__NODE__", taskId: seededTask.id };
    // Claims are local-first: node A records its own ownership, which replicates to its twin.
    const ownershipRecord = { engine: "claude", sessionId, ownerNodeId: "__NODE__", epoch: 1, status: "owned", transferToNodeId: null };
    const events = [
      taskEvent(seededTask),
      { id: randomUUID(), originNodeId: "__NODE__", entityType: "conversation.record", entityKey: `__PROJECT__:claude:${sessionId}`, operation: "upsert", payload: { projectId: "__PROJECT__", engine: "claude", sessionId, record, updatedAt: now, originNodeId: "__NODE__" }, createdAt: now },
      { id: randomUUID(), originNodeId: "__NODE__", entityType: "conversation.ownership", entityKey: `claude:${sessionId}`, operation: "upsert", payload: { ...ownershipRecord, originNodeId: "__NODE__" }, createdAt: now },
    ];
    const source = await seedNode({ root, key: "source", claudeExecutable: "true", project: { name: "shared", path: path.join(root, "source-project") }, events });
    const project = source.projects[0];
    const destination = await seedNode({ root, key: "destination", claudeExecutable: "true", mirror: { project, path: path.join(root, "destination-home", "project") } });
    const [sourceId, destinationId] = [source.nodeId, destination.nodeId];
    const environment = nodeEnvironment(root, [source, destination]);
    const task = { ...seededTask, currentNodeId: sourceId, originNodeId: sourceId } as TaskRecord;
    children.push(await startNode(source, sourceUrl), await startNode(destination, destinationUrl));
    await pairTwinNodes(environment);
    const [sourceAuth, destinationAuth] = await Promise.all([signIn(nodeEnvironment(root, [source]), source), signIn(nodeEnvironment(root, [destination]), destination)]);
    await Promise.all([waitForTask(source, sourceAuth, project.id, task.id, () => true), waitForTask(destination, destinationAuth, project.id, task.id, () => true)]);
    const ownershipTarget = `/api/cluster/v2/runtime/sessions/ownership?engine=claude&sessionId=${sessionId}`;
    await waitUntil("replicated ownership", async () => ((await (await signedNodeRequest(environment, source, destination, "GET", ownershipTarget)).json()) as { ownership: { ownerNodeId: string } | null }).ownership?.ownerNodeId === sourceId);

    const handoff = await fetch(`${source.url}/api/projects/${project.id}/tasks/${task.id}/handoff`, { method: "POST", headers: headers(sourceAuth), body: JSON.stringify({ peerId: destinationId }) });
    assert.equal(handoff.status, 200);
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

    const renamed = await fetch(`${destination.url}/api/projects/${project.id}/sessions/title`, {
      method: "PUT",
      headers: headers(destinationAuth),
      body: JSON.stringify({ engine: "claude", sessionId, title: "Mutated title" }),
    });
    assert.equal(renamed.status, 409, "Done conversation title must be immutable");
    const removed = await fetch(`${source.url}/api/projects/${project.id}/sessions?engine=claude&sessionId=${sessionId}&taskId=${task.id}`, {
      method: "DELETE",
      headers: headers(sourceAuth),
    });
    assert.equal(removed.status, 409, "Done conversation transcript must not be removable");

    const rejected = nextSocketPayload(opened.socket, "error");
    opened.socket.send(JSON.stringify({ type: "prompt", message: "mutate a finished ticket" }));
    assert.deepEqual(await rejected, { type: "error", error: "Done ticket conversations are read-only" });
    opened.socket.close();
    const ownership = await (await signedNodeRequest(environment, source, destination, "GET", ownershipTarget)).json() as { ownership: { ownerNodeId: string; status: string } };
    assert.equal(ownership.ownership.ownerNodeId, destinationId);
    assert.equal(ownership.ownership.status, "owned");
  } finally {
    await Promise.all(children.map(stopDevNode));
    await Promise.all([sourceSyncthing.stop(), destinationSyncthing.stop()]);
    await rm(root, { recursive: true, force: true });
  }
});
