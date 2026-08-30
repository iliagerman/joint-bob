import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

interface NodeFixture {
  dataDir: string;
  port: number;
  url: string;
  id: string;
  token: string;
  projectId: string;
}

function runScript(dataDir: string, home: string, code: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, ...args], {
      cwd: process.cwd(), env: { ...process.env, HOME: home, JOINT_BOB_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => status === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `child exited ${status}`)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") throw new Error("Could not allocate test port");
      socket.close(() => resolve(address.port));
    });
  });
}

// Both nodes share one HOME, which is what Syncthing's wholesale replication of
// ~/.claude looks like from the transcript's point of view. What differs is the
// project checkout path, and that is exactly what the defect turns on.
async function initializeNode(dataDir: string, home: string, projectPath: string, peerProjectPath: string, port: number): Promise<NodeFixture> {
  const url = `http://127.0.0.1:${port}`;
  const output = await runScript(dataDir, home, `
    const cluster = await import('./src/cluster.ts');
    const store = await import('./src/store.ts');
    const settings = await import('./src/settings.ts');
    const node = await cluster.updateClusterNode('node-' + process.argv[1], process.argv[2]);
    const project = await store.addProject('Takeover project', process.argv[3]);
    await store.updateProjectMacPath(project.id, process.argv[4]);
    settings.updateSettings({ pi: { executable: '', configPath: process.argv[5], sessionPath: process.argv[6] }, claude: { executable: '', configPath: process.argv[7], sessionPath: process.argv[8] }, syncthing: { endpoint: '' }, projects: { homePath: process.argv[9] } });
    console.log(JSON.stringify({ node, token: await cluster.getClusterMachineToken(), projectId: project.id }));
  `, [
    String(port), url, projectPath, peerProjectPath,
    path.join(home, ".pi"), path.join(home, ".pi", "sessions"),
    path.join(home, ".claude"), path.join(home, ".claude", "projects"),
    path.join(home, "JointBob"),
  ]);
  const parsed = JSON.parse(output) as { node: { id: string }; token: string; projectId: string };
  return { dataDir, port, url, id: parsed.node.id, token: parsed.token, projectId: parsed.projectId };
}

async function pairNode(local: NodeFixture, remote: NodeFixture, home: string): Promise<void> {
  await runScript(local.dataDir, home, `
    const cluster = await import('./src/cluster.ts');
    const store = await import('./src/store.ts');
    const now = new Date().toISOString();
    await cluster.saveClusterPeer({ id: process.argv[1], name: 'peer', url: process.argv[2], token: process.argv[3], pairedAt: now, lastSeenAt: now, createdAt: now, updatedAt: now });
    await store.registerProjectAliases(process.argv[4], [process.argv[5]]);
  `, [remote.id, remote.url, remote.token, local.projectId, remote.projectId]);
}

async function listedClaudeSessionIds(node: NodeFixture, home: string): Promise<string[]> {
  const output = await runScript(node.dataDir, home, `
    const store = await import('./src/store.ts');
    const claude = await import('./src/claude-service.ts');
    const project = await store.getProject(process.argv[1]);
    console.log(JSON.stringify((await claude.listClaudeSessions(project)).map((session) => session.id)));
  `, [node.projectId]);
  return JSON.parse(output) as string[];
}

function startNode(node: NodeFixture, home: string, invocationLog: string, holdDir: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(node.port), NODE_ENV: "test", HOME: home, JOINT_BOB_DATA_DIR: node.dataDir, JOINT_BOB_TEST_ENGINE_LOG: invocationLog, JOINT_BOB_TEST_ENGINE_HOLD_DIR: holdDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => reject(new Error("Server startup timed out")), 15_000);
    child.once("exit", (status) => reject(new Error(`Server exited during startup: ${status}`)));
    child.stdout!.on("data", (chunk) => {
      if (!String(chunk).includes("Joint Bob listening")) return;
      clearTimeout(timeout);
      resolve(child);
    });
  });
}

async function stopNode(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
}

async function machinePost(node: NodeFixture, route: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${node.url}${route}`, {
    method: "POST", headers: { Authorization: `Bearer ${node.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function machineGet(node: NodeFixture, route: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${node.url}${route}`, { headers: { Authorization: `Bearer ${node.token}` } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function openConversation(node: NodeFixture, projectId: string, sessionPath: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = new URL("/ws", node.url.replace(/^http/, "ws"));
    url.searchParams.set("projectId", projectId);
    url.searchParams.set("sessionPath", sessionPath);
    url.searchParams.set("nodeSession", "1");
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${node.token}` } });
    const timeout = setTimeout(() => reject(new Error("WebSocket ready timed out")), 10_000);
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as { type?: string };
      if (event.type !== "ready") return;
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("error", reject);
    socket.once("close", (code, reason) => reject(new Error(`WebSocket closed ${code}: ${reason.toString()}`)));
  });
}

function prompt(socket: WebSocket, message: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Prompt result timed out")), 15_000);
    const onMessage = (raw: WebSocket.RawData): void => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!["textDelta", "error"].includes(String(event.type))) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(event);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ type: "prompt", message }));
  });
}

function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-");
}

test("a Claude conversation is claimed from a node whose checkout sits elsewhere and resumes its existing transcript", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-takeover-"));
  const home = path.join(root, "home");
  const projectA = path.join(root, "checkout-a", "project");
  const projectB = path.join(root, "workspace-b", "project");
  const projectsRoot = path.join(home, ".claude", "projects");
  const sourceDir = path.join(projectsRoot, claudeProjectDirName(projectA));
  const localDir = path.join(projectsRoot, claudeProjectDirName(projectB));
  const sessionId = "claude-takeover-session";
  const sourcePath = path.join(sourceDir, `${sessionId}.jsonl`);
  const localPath = path.join(localDir, `${sessionId}.jsonl`);
  const invocationLog = path.join(root, "invocations.log");
  const holdDir = path.join(root, "engine-holds");
  const children: ChildProcess[] = [];
  const sockets: WebSocket[] = [];
  try {
    await Promise.all([
      mkdir(projectA, { recursive: true }), mkdir(projectB, { recursive: true }),
      mkdir(sourceDir, { recursive: true }), mkdir(holdDir, { recursive: true }),
      mkdir(path.join(home, ".pi", "sessions"), { recursive: true }),
    ]);
    // The stubbed engine waits for this file, so every turn below runs straight through.
    await writeFile(path.join(holdDir, "claude.release"), "release");
    const originalTranscript = `${JSON.stringify({ type: "user", sessionId, cwd: projectA, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "preserve me" } })}\n`;
    await writeFile(sourcePath, originalTranscript);

    const [nodeA, nodeB] = await Promise.all([
      initializeNode(path.join(root, "node-a-data"), home, projectA, projectB, await freePort()),
      initializeNode(path.join(root, "node-b-data"), home, projectB, projectA, await freePort()),
    ]);
    await Promise.all([pairNode(nodeA, nodeB, home), pairNode(nodeB, nodeA, home)]);
    children.push(await startNode(nodeA, home, invocationLog, holdDir), await startNode(nodeB, home, invocationLog, holdDir));

    const coordinator = nodeA.id.localeCompare(nodeB.id) < 0 ? nodeA : nodeB;
    const claim = await machinePost(coordinator, "/api/cluster/sessions/ownership/claim", { engine: "claude", sessionId, ownerNodeId: nodeA.id });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));

    // FR1.1/FR1.2 — the takeover no longer refuses a `claude:` path and derives the engine from it.
    const takeover = await machinePost(nodeB, "/api/cluster/sessions/take-ownership", {
      projectId: nodeB.projectId, peerId: nodeB.id, sessionId, sessionPath: `claude:${sourcePath}`,
    });
    assert.equal(takeover.status, 200, JSON.stringify(takeover.body));
    const ownership = takeover.body.ownership as Record<string, unknown>;
    assert.equal(ownership.engine, "claude");
    assert.equal(ownership.ownerNodeId, nodeB.id);
    assert.deepEqual(takeover.body.pendingPeerIds, []);

    // FR3.1/FR3.2 — node B lists the conversation and its turn resumes the existing transcript.
    assert.deepEqual(await listedClaudeSessionIds(nodeB, home), [sessionId]);
    const socket = await openConversation(nodeB, nodeB.projectId, `claude:${sourcePath}`);
    sockets.push(socket);
    assert.equal((await prompt(socket, "continue on node B")).type, "textDelta");

    const resumed = await readFile(localPath, "utf8");
    assert.match(resumed, /preserve me/);
    assert.equal(resumed.trim().split("\n").length, 3, resumed);

    // FR3.3/NFR3 — the transcript node A still holds on disk is untouched.
    assert.equal(await readFile(sourcePath, "utf8"), originalTranscript);

    // A3 from the requirements: the copy must not duplicate the conversation in the list.
    assert.deepEqual(await listedClaudeSessionIds(nodeB, home), [sessionId]);

    for (const open of sockets.splice(0)) open.terminate();

    // FR1.4 — a peer that is offline does not fail the takeover; it is reported as pending.
    await stopNode(children.shift()!);
    const offlineTakeover = await machinePost(nodeB, "/api/cluster/sessions/take-ownership", {
      projectId: nodeB.projectId, peerId: nodeB.id, sessionId, sessionPath: `claude:${localPath}`,
    });
    assert.equal(offlineTakeover.status, 200, JSON.stringify(offlineTakeover.body));
    assert.deepEqual(offlineTakeover.body.pendingPeerIds, [nodeA.id]);
    const offlineOwnership = offlineTakeover.body.ownership as Record<string, unknown>;
    assert.equal(offlineOwnership.ownerNodeId, nodeB.id);

    // FR1.4 — ownership survives a restart of the claiming node.
    await stopNode(children.pop()!);
    children.push(await startNode(nodeB, home, invocationLog, holdDir));
    const persisted = await machineGet(nodeB, `/api/cluster/sessions/ownership?engine=claude&sessionId=${encodeURIComponent(sessionId)}`);
    assert.equal(persisted.status, 200);
    assert.deepEqual(persisted.body.ownership, offlineOwnership);
  } finally {
    for (const socket of sockets) socket.close();
    await Promise.all(children.map(stopNode));
    await rm(root, { recursive: true, force: true });
  }
});
