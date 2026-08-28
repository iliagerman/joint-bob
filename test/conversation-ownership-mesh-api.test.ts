import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
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

async function freePort(): Promise<number> {
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

async function initializeNode(dataDir: string, home: string, projectPath: string, sessionRoot: string, port: number): Promise<NodeFixture> {
  const url = `http://127.0.0.1:${port}`;
  const output = await runScript(dataDir, home, `
    const cluster = await import('./src/cluster.ts');
    const store = await import('./src/store.ts');
    const settings = await import('./src/settings.ts');
    const node = await cluster.updateClusterNode('node-' + process.argv[1], process.argv[2]);
    const project = await store.addProject('Mesh project', process.argv[3]);
    settings.updateSettings({ pi: { executable: '', configPath: process.argv[4], sessionPath: process.argv[5] }, claude: { executable: '', configPath: process.argv[6], sessionPath: process.argv[7] }, syncthing: { endpoint: '' }, projects: { homePath: process.argv[8] } });
    console.log(JSON.stringify({ node, token: await cluster.getClusterMachineToken(), projectId: project.id }));
  `, [String(port), url, projectPath, path.join(home, ".pi"), sessionRoot, path.join(home, ".claude"), path.join(home, ".claude", "projects"), path.join(home, "JointBob")]);
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

function startNode(node: NodeFixture, home: string, invocationLog: string, holdDir: string, dropAck = false): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const code = `
      const { server } = await import('./src/server.ts');
      server.listen(Number(process.argv[1]), '127.0.0.1', () => console.log('READY'));
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, String(node.port)], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "test", HOME: home, JOINT_BOB_DATA_DIR: node.dataDir, JOINT_BOB_TEST_ENGINE_LOG: invocationLog, JOINT_BOB_TEST_ENGINE_HOLD_DIR: holdDir, ...(dropAck ? { JOINT_BOB_TEST_DROP_TRANSFER_ACK_ONCE: "1" } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => reject(new Error("Server startup timed out")), 10_000);
    child.once("exit", (status) => reject(new Error(`Server exited during startup: ${status}`)));
    child.stdout!.on("data", (chunk) => {
      if (!String(chunk).includes("READY")) return;
      clearTimeout(timeout);
      resolve(child);
    });
  });
}

async function stopNode(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
}

async function machinePostAs(authenticator: NodeFixture, target: NodeFixture, route: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${target.url}${route}`, {
    method: "POST", headers: { Authorization: `Bearer ${authenticator.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function machinePost(node: NodeFixture, route: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return machinePostAs(node, node, route, body);
}

async function waitForInvocation(invocationLog: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(invocationLog, "utf8")).split("\n").includes(expected)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected}`);
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
  });
}

function prompt(socket: WebSocket, message: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Prompt result timed out")), 10_000);
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

function piTranscript(sessionId: string, cwd: string): string {
  return `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`;
}

async function assertSpoofRejected(source: NodeFixture, destination: NodeFixture, engine: "pi" | "claude", sessionId: string, sessionPath: string): Promise<void> {
  const record = { engine, sessionId, ownerNodeId: destination.id, epoch: 99, status: "transferring", transferToNodeId: destination.id };
  const apply = await machinePostAs(source, destination, "/api/cluster/sessions/ownership/apply", { record, originNodeId: destination.id });
  assert.equal(apply.status, 403);
  assert.match(String(apply.body.error), /authenticated peer/);
  const receive = await machinePostAs(source, destination, "/api/cluster/sessions/receive", {
    projectId: source.projectId, engine, sessionId, sessionPath, sourceNodeId: destination.id, sourceEpoch: 99,
  });
  assert.notEqual(receive.status, 201);
  assert.match(String(receive.body.error), /authenticated peer/);
}

async function exerciseConcurrentBoundary(
  engine: "pi" | "claude", source: NodeFixture, destination: NodeFixture,
  sessionPath: string, invocationLog: string, holdDir: string, sockets: WebSocket[],
): Promise<void> {
  const wirePath = engine === "claude" ? `claude:${sessionPath}` : sessionPath;
  const sourceSocket = await openConversation(source, source.projectId, wirePath);
  const destinationSocket = await openConversation(destination, source.projectId, wirePath);
  sockets.push(sourceSocket, destinationSocket);
  const before = await readFile(sessionPath, "utf8");
  const ownerTurn = prompt(sourceSocket, `${engine} owner write`);
  await waitForInvocation(invocationLog, `${engine}:${source.id}`);
  const rejected = await prompt(destinationSocket, `${engine} spoofed continuation`);
  assert.equal(rejected.type, "error");
  assert.match(String(rejected.error), new RegExp(source.id));
  assert.equal(await readFile(sessionPath, "utf8"), before);
  await writeFile(path.join(holdDir, `${engine}.release`), "release");
  assert.equal((await ownerTurn).type, "textDelta");
  const addedLines = (await readFile(sessionPath, "utf8")).trim().split("\n").length - before.trim().split("\n").length;
  assert.equal(addedLines, 2);
  const invocations = (await readFile(invocationLog, "utf8")).trim().split("\n").filter((line) => line === `${engine}:${source.id}`);
  assert.equal(invocations.length, 1);
}

async function exerciseClaudeOwnership(coordinator: NodeFixture, source: NodeFixture, destination: NodeFixture, sessionPath: string, invocationLog: string, holdDir: string, sockets: WebSocket[]): Promise<void> {
  const sessionId = path.basename(sessionPath, ".jsonl");
  const claim = await machinePost(coordinator, "/api/cluster/sessions/ownership/claim", { engine: "claude", sessionId, ownerNodeId: source.id });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  await assertSpoofRejected(source, destination, "claude", sessionId, `claude:${sessionPath}`);
  await exerciseConcurrentBoundary("claude", source, destination, sessionPath, invocationLog, holdDir, sockets);
  const beforeTransfer = await readFile(sessionPath, "utf8");
  const transfer = await machinePost(source, "/api/cluster/sessions/transfer", { projectId: source.projectId, peerId: destination.id, sessionPath: `claude:${sessionPath}` });
  assert.equal(transfer.status, 200, JSON.stringify(transfer.body));
  assert.equal((transfer.body.ownership as Record<string, unknown>).ownerNodeId, destination.id);
  assert.equal(await readFile(sessionPath, "utf8"), beforeTransfer);
}

async function exercisePiOwnership(
  source: NodeFixture, destination: NodeFixture, coordinator: NodeFixture,
  sessionId: string, transcriptPath: string, invocationLog: string,
  home: string, sessionRoot: string, holdDir: string, children: ChildProcess[], sockets: WebSocket[],
): Promise<void> {
  const claim = await machinePost(coordinator, "/api/cluster/sessions/ownership/claim", { engine: "pi", sessionId, ownerNodeId: source.id });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  await assertSpoofRejected(source, destination, "pi", sessionId, transcriptPath);
  await exerciseConcurrentBoundary("pi", source, destination, transcriptPath, invocationLog, holdDir, sockets);
  const sourceSocket = sockets[sockets.length - 2];
  const destinationSocket = sockets[sockets.length - 1];
  const transfer = await machinePost(source, "/api/cluster/sessions/transfer", {
    projectId: source.projectId, peerId: destination.id, sessionId, sessionPath: transcriptPath,
  });
  assert.equal(transfer.status, 200, JSON.stringify(transfer.body));
  assert.equal(((transfer.body.ownership as Record<string, unknown>).ownerNodeId), destination.id);
  assert.equal((await prompt(sourceSocket, "source after transfer")).type, "error");
  assert.equal((await prompt(destinationSocket, "destination write")).type, "textDelta");
  for (const socket of sockets.splice(0)) socket.terminate();
  await stopNode(children.pop()!);
  children.push(await startNode(destination, home, invocationLog, holdDir));
  const restartedSocket = await openConversation(destination, source.projectId, transcriptPath);
  sockets.push(restartedSocket);
  assert.equal((await prompt(restartedSocket, "write after restart")).type, "textDelta");
  assert.deepEqual((await readFile(invocationLog, "utf8")).trim().split("\n"), [
    `claude:${source.id}`, `pi:${source.id}`, `pi:${destination.id}`, `pi:${destination.id}`,
  ]);
  assert.equal((await readdir(sessionRoot)).some((name) => name.includes(".sync-conflict-")), false);
}

test("two real servers fence a second writer and preserve transfer across lost acknowledgement and restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-real-mesh-"));
  const home = path.join(root, "home");
  const projectPath = path.join(root, "project");
  const sessionRoot = path.join(home, ".pi", "sessions");
  const transcriptPath = path.join(sessionRoot, "mesh-session.jsonl");
  const claudeDir = path.join(home, ".claude", "projects", projectPath.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-"));
  const claudePath = path.join(claudeDir, "claude-mesh.jsonl");
  const invocationLog = path.join(root, "invocations.log");
  const holdDir = path.join(root, "engine-holds");
  const children: ChildProcess[] = [];
  const sockets: WebSocket[] = [];
  try {
    await Promise.all([mkdir(projectPath, { recursive: true }), mkdir(sessionRoot, { recursive: true }), mkdir(claudeDir, { recursive: true }), mkdir(holdDir, { recursive: true })]);
    await writeFile(transcriptPath, piTranscript("mesh-session", projectPath));
    await writeFile(claudePath, `${JSON.stringify({ type: "user", sessionId: "claude-mesh", cwd: projectPath, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "preserve me" } })}\n`);
    const [source, destination] = await Promise.all([
      initializeNode(path.join(root, "source-data"), home, projectPath, sessionRoot, await freePort()),
      initializeNode(path.join(root, "destination-data"), home, projectPath, sessionRoot, await freePort()),
    ]);
    await Promise.all([pairNode(source, destination, home), pairNode(destination, source, home)]);
    children.push(await startNode(source, home, invocationLog, holdDir), await startNode(destination, home, invocationLog, holdDir, true));
    const coordinator = source.id.localeCompare(destination.id) < 0 ? source : destination;
    await exerciseClaudeOwnership(coordinator, source, destination, claudePath, invocationLog, holdDir, sockets);
    await exercisePiOwnership(source, destination, coordinator, "mesh-session", transcriptPath, invocationLog, home, sessionRoot, holdDir, children, sockets);
  } finally {
    for (const socket of sockets) socket.close();
    await Promise.all(children.map(stopNode));
    await rm(root, { recursive: true, force: true });
  }
});
