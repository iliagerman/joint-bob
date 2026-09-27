import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

interface Mesh { environment: DevEnvironment; projectId: string; invocationLog: string; holdDir: string; sessions: Map<SeededNode, SignedIn> }

function startNode(mesh: Mesh, node: SeededNode): Promise<ChildProcess> {
  return startDevNode(mesh.environment, node, { JOINT_BOB_TEST_ENGINE_LOG: mesh.invocationLog, JOINT_BOB_TEST_ENGINE_HOLD_DIR: mesh.holdDir });
}

async function browserSession(mesh: Mesh, node: SeededNode): Promise<SignedIn> {
  const session = await signIn(mesh.environment, node);
  mesh.sessions.set(node, session);
  return session;
}

async function json(response: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function signedPost(mesh: Mesh, sender: SeededNode, recipient: SeededNode, suffix: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return json(await signedNodeRequest(mesh.environment, sender, recipient, "POST", `/api/cluster/v2/runtime/${suffix}`, body));
}

/** The takeover a user starts from the conversation on this node. */
async function takeOwnership(mesh: Mesh, node: SeededNode, body: { sessionId?: string; sessionPath: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  const session = mesh.sessions.get(node)!;
  return json(await fetch(`${node.url}/api/projects/${mesh.projectId}/sessions/take-ownership`, {
    method: "POST",
    headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ peerId: node.nodeId, ...body }),
  }));
}

/** Claims are local-first, so a test that needs an owned conversation takes it on the
    owner, which applies the same record on its twin before answering. */
async function seedConversationOwnership(mesh: Mesh, owner: SeededNode, sessionPath: string): Promise<void> {
  const claimed = await takeOwnership(mesh, owner, { sessionPath });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal((claimed.body.ownership as Record<string, unknown>).epoch, 1);
  assert.deepEqual(claimed.body.pendingPeerIds, []);
}

async function waitForOwnership(mesh: Mesh, node: SeededNode, asker: SeededNode, sessionId: string, ownerNodeId: string, epoch: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await json(await signedNodeRequest(mesh.environment, asker, node, "GET", `/api/cluster/v2/runtime/sessions/ownership?engine=pi&sessionId=${encodeURIComponent(sessionId)}`));
    const ownership = result.body.ownership as Record<string, unknown> | null;
    if (result.status === 200 && ownership?.ownerNodeId === ownerNodeId && ownership.epoch === epoch) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for replicated ownership");
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

function openConversation(mesh: Mesh, node: SeededNode, sessionPath: string): Promise<WebSocket> {
  const url = new URL("/ws", node.url.replace(/^http/, "ws"));
  url.searchParams.set("projectId", mesh.projectId);
  url.searchParams.set("sessionPath", sessionPath);
  url.searchParams.set("nodeSession", "1");
  // A routed node session, signed by the node that serves it.
  const authorization = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import {DatabaseSync} from 'node:sqlite';
    import {signClusterRequest} from './src/cluster-protocol.ts';
    const db=new DatabaseSync(process.env.JOINT_BOB_DATA_DIR+'/node.db');
    process.stdout.write(signClusterRequest(db,${JSON.stringify(node.nodeId)},${JSON.stringify(node.nodeId)},'GET',${JSON.stringify(url.pathname + url.search)},Buffer.alloc(0)));db.close();
  `], { env: { ...process.env, HOME: mesh.environment.home, JOINT_BOB_DATA_DIR: node.dataDir }, encoding: "utf8" });
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: authorization } });
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

async function assertSpoofRejected(mesh: Mesh, source: SeededNode, destination: SeededNode, engine: "pi" | "claude", sessionId: string): Promise<void> {
  const record = { engine, sessionId, ownerNodeId: destination.nodeId, epoch: 99, status: "transferring", transferToNodeId: destination.nodeId };
  const apply = await signedPost(mesh, source, destination, "sessions/ownership/apply", { record, originNodeId: destination.nodeId });
  assert.equal(apply.status, 403);
  assert.match(String(apply.body.error), /authenticated peer/);
}

async function exerciseConcurrentBoundary(
  mesh: Mesh, engine: "pi" | "claude", source: SeededNode, destination: SeededNode, sessionPath: string, sockets: WebSocket[],
): Promise<void> {
  const wirePath = engine === "claude" ? `claude:${sessionPath}` : sessionPath;
  const sourceSocket = await openConversation(mesh, source, wirePath);
  const destinationSocket = await openConversation(mesh, destination, wirePath);
  sockets.push(sourceSocket, destinationSocket);
  const ownerTurn = prompt(sourceSocket, `${engine} owner write`);
  await waitForInvocation(mesh.invocationLog, `${engine}:${source.nodeId}`);
  // Owner preflight may append settings; snapshot only once its held execution has started.
  const before = await readFile(sessionPath, "utf8");
  const rejected = await prompt(destinationSocket, `${engine} spoofed continuation`);
  assert.equal(rejected.type, "error");
  assert.match(String(rejected.error), new RegExp(source.nodeId));
  assert.equal(await readFile(sessionPath, "utf8"), before);
  await writeFile(path.join(mesh.holdDir, `${engine}.release`), "release");
  assert.equal((await ownerTurn).type, "textDelta");
  const addedLines = (await readFile(sessionPath, "utf8")).trim().split("\n").length - before.trim().split("\n").length;
  assert.equal(addedLines, 2);
  const invocations = (await readFile(mesh.invocationLog, "utf8")).trim().split("\n").filter((line) => line === `${engine}:${source.nodeId}`);
  assert.equal(invocations.length, 1);
}

async function exerciseClaudeOwnership(mesh: Mesh, source: SeededNode, destination: SeededNode, sessionPath: string, sockets: WebSocket[]): Promise<void> {
  const sessionId = path.basename(sessionPath, ".jsonl");
  await seedConversationOwnership(mesh, source, `claude:${sessionPath}`);
  await assertSpoofRejected(mesh, source, destination, "claude", sessionId);
  await exerciseConcurrentBoundary(mesh, "claude", source, destination, sessionPath, sockets);
  const beforeTakeover = await readFile(sessionPath, "utf8");
  const takeover = await takeOwnership(mesh, destination, { sessionPath: `claude:${sessionPath}` });
  assert.equal(takeover.status, 200, JSON.stringify(takeover.body));
  assert.equal((takeover.body.ownership as Record<string, unknown>).ownerNodeId, destination.nodeId);
  assert.equal(await readFile(sessionPath, "utf8"), beforeTakeover);
}

async function exercisePiOwnership(
  mesh: Mesh, source: SeededNode, destination: SeededNode,
  sessionId: string, transcriptPath: string, sessionRoot: string, children: ChildProcess[], sockets: WebSocket[],
): Promise<void> {
  const invocationLog = mesh.invocationLog;
  await seedConversationOwnership(mesh, source, transcriptPath);
  await assertSpoofRejected(mesh, source, destination, "pi", sessionId);
  await exerciseConcurrentBoundary(mesh, "pi", source, destination, transcriptPath, sockets);
  const sourceSocket = sockets[sockets.length - 2];
  const destinationSocket = sockets[sockets.length - 1];
  const takeover = await takeOwnership(mesh, destination, { sessionId, sessionPath: transcriptPath });
  assert.equal(takeover.status, 200, JSON.stringify(takeover.body));
  assert.equal(((takeover.body.ownership as Record<string, unknown>).ownerNodeId), destination.nodeId);
  assert.equal((await prompt(sourceSocket, "source after takeover")).type, "error");
  assert.equal((await prompt(destinationSocket, "destination write")).type, "textDelta");
  for (const socket of sockets.splice(0)) socket.terminate();
  await stopDevNode(children.pop()!);
  children.push(await startNode(mesh, destination));
  const restartedSocket = await openConversation(mesh, destination, transcriptPath);
  sockets.push(restartedSocket);
  assert.equal((await prompt(restartedSocket, "write after restart")).type, "textDelta");
  assert.deepEqual((await readFile(invocationLog, "utf8")).trim().split("\n"), [
    `claude:${source.nodeId}`, `pi:${source.nodeId}`, `pi:${destination.nodeId}`, `pi:${destination.nodeId}`,
  ]);
  for (const socket of sockets.splice(0)) socket.terminate();
  await stopDevNode(children.pop()!);
  const request = { sessionId, sessionPath: transcriptPath };
  const offlineReclaim = await takeOwnership(mesh, source, request);
  assert.equal(offlineReclaim.status, 200, JSON.stringify(offlineReclaim.body));
  assert.equal((offlineReclaim.body.ownership as Record<string, unknown>).ownerNodeId, source.nodeId);
  assert.deepEqual(offlineReclaim.body.pendingPeerIds, [destination.nodeId]);
  children.push(await startNode(mesh, destination));
  const reclaim = await takeOwnership(mesh, source, request);
  assert.equal(reclaim.status, 200, JSON.stringify(reclaim.body));
  const ownership = reclaim.body.ownership as Record<string, unknown>;
  assert.equal(ownership.ownerNodeId, source.nodeId);
  assert.equal(ownership.epoch, 3);
  assert.deepEqual(reclaim.body.pendingPeerIds, []);
  await stopDevNode(children.pop()!);
  const retry = await takeOwnership(mesh, source, request);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.deepEqual(retry.body.pendingPeerIds, [destination.nodeId]);
  const sourceTakeoverSocket = await openConversation(mesh, source, transcriptPath);
  sockets.push(sourceTakeoverSocket);
  assert.equal((await prompt(sourceTakeoverSocket, "source takeover write")).type, "textDelta");
  children.push(await startNode(mesh, destination));
  await waitForOwnership(mesh, destination, source, sessionId, source.nodeId, Number(ownership.epoch));
  const staleDestinationSocket = await openConversation(mesh, destination, transcriptPath);
  sockets.push(staleDestinationSocket);
  const staleWrite = await prompt(staleDestinationSocket, "stale destination write");
  assert.equal(staleWrite.type, "error");
  assert.match(String(staleWrite.error), new RegExp(source.nodeId));
  assert.equal((await readFile(invocationLog, "utf8")).trim().split("\n").includes(`pi:${destination.nodeId}`), true);
  const invocations = (await readFile(invocationLog, "utf8")).trim().split("\n");
  assert.equal(invocations.filter((entry) => entry === `pi:${destination.nodeId}`).length, 2);
  assert.equal(invocations[invocations.length - 1], `pi:${source.nodeId}`);
  assert.equal((await readdir(sessionRoot)).some((name) => name.includes(".sync-conflict-")), false);
}

test("two real servers fence a second writer and preserve takeover across an offline peer and restart", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-real-mesh-"));
  const children: ChildProcess[] = [];
  const sockets: WebSocket[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [source, destination] = environment.nodes;
    const project = source.projects[0];
    const sessionRoot = path.join(environment.home, ".pi", "sessions");
    const transcriptPath = path.join(sessionRoot, "mesh-session.jsonl");
    const claudeDir = path.join(environment.home, ".claude", "projects", project.path.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-"));
    const claudePath = path.join(claudeDir, "claude-mesh.jsonl");
    const mesh: Mesh = { environment, projectId: project.id, invocationLog: path.join(root, "invocations.log"), holdDir: path.join(root, "engine-holds"), sessions: new Map() };
    await Promise.all([mkdir(claudeDir, { recursive: true }), mkdir(mesh.holdDir, { recursive: true })]);
    await writeFile(transcriptPath, piTranscript("mesh-session", project.path));
    await writeFile(claudePath, `${JSON.stringify({ type: "user", sessionId: "claude-mesh", cwd: project.path, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "preserve me" } })}\n`);
    children.push(await startNode(mesh, source));
    children.push(await startNode(mesh, destination));
    await pairTwinNodes(environment);
    await Promise.all([browserSession(mesh, source), browserSession(mesh, destination)]);
    await exerciseClaudeOwnership(mesh, source, destination, claudePath, sockets);
    await exercisePiOwnership(mesh, source, destination, "mesh-session", transcriptPath, sessionRoot, children, sockets);
  } finally {
    for (const socket of sockets) socket.close();
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
