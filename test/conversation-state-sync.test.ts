import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

/**
 * Two real twin nodes over one shared transcript filesystem (what Syncthing looks like
 * between a Mac and a homeserver). Running state must travel as a lease while the
 * turn is in flight, and review watermarks must replicate in both directions.
 */

interface Mesh { environment: DevEnvironment; projectId: string; invocationLog: string; holdDir: string }

async function startMesh(root: string): Promise<{ mesh: Mesh; server: SeededNode; mac: SeededNode; children: ChildProcess[] }> {
  const environment = await seedDevEnvironment(root, 2);
  const [server, mac] = environment.nodes;
  const mesh: Mesh = { environment, projectId: server.projects[0].id, invocationLog: path.join(root, "invocations.log"), holdDir: path.join(root, "engine-holds") };
  await mkdir(mesh.holdDir, { recursive: true });
  return { mesh, server, mac, children: [] };
}

function startNode(mesh: Mesh, node: SeededNode): Promise<ChildProcess> {
  return startDevNode(mesh.environment, node, { JOINT_BOB_TEST_ENGINE_LOG: mesh.invocationLog, JOINT_BOB_TEST_ENGINE_HOLD_DIR: mesh.holdDir });
}

function headers(session: SignedIn): Record<string, string> {
  return { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" };
}

/** The takeover a user starts from the conversation on this node; the owner applies the
    record on its twin before answering. */
async function takeOwnership(mesh: Mesh, node: SeededNode, auth: SignedIn, sessionId: string, sessionPath: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${node.url}/api/projects/${mesh.projectId}/sessions/take-ownership`, {
    method: "POST", headers: headers(auth), body: JSON.stringify({ peerId: node.nodeId, sessionId, sessionPath }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

interface ListedSession {
  id: string;
  path: string;
  running: boolean;
  reviewState: string;
  updatedAt?: string;
}

async function listSessions(mesh: Mesh, node: SeededNode, auth: SignedIn): Promise<ListedSession[]> {
  const response = await fetch(`${node.url}/api/projects/${mesh.projectId}/sessions`, { headers: headers(auth) });
  const body = await response.text();
  assert.equal(response.status, 200, `${node.url}: ${body}`);
  return (JSON.parse(body) as { sessions: ListedSession[] }).sessions;
}

async function waitForSession(mesh: Mesh, node: SeededNode, auth: SignedIn, sessionId: string, predicate: (session: ListedSession) => boolean, deadlineMs = 20_000): Promise<ListedSession> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const session = (await listSessions(mesh, node, auth)).find((candidate) => candidate.id === sessionId);
    if (session && predicate(session)) return session;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for session ${sessionId}; last seen: ${JSON.stringify(session)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function markReviewed(mesh: Mesh, node: SeededNode, auth: SignedIn, session: ListedSession): Promise<void> {
  const response = await fetch(`${node.url}/api/projects/${mesh.projectId}/sessions/reviewed`, {
    method: "PUT", headers: headers(auth), body: JSON.stringify({ sessionPath: session.path, updatedAt: session.updatedAt }),
  });
  assert.equal(response.status, 204, `marking reviewed failed: ${response.status}`);
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

function sendPrompt(socket: WebSocket, message: string): void {
  socket.send(JSON.stringify({ type: "prompt", message }));
}

function waitForTextDelta(socket: WebSocket, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Prompt result timed out")), timeoutMs);
    const onMessage = (raw: WebSocket.RawData): void => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!["textDelta", "error"].includes(String(event.type))) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(String(event.type));
    };
    socket.on("message", onMessage);
  });
}

async function waitForInvocation(invocationLog: string, expected: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(invocationLog, "utf8")).split("\n").includes(expected)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

function piTranscript(sessionId: string, cwd: string): string {
  return `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n${JSON.stringify({ type: "message", id: `${sessionId}-message`, parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Resume this conversation" }] } })}\n`;
}

function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-");
}

test("running leases and review watermarks travel between two real nodes", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-state-sync-"));
  const sockets: WebSocket[] = [];
  const { mesh, server, mac, children } = await startMesh(root);
  const { invocationLog, holdDir } = mesh;
  const sessionId = "sync-session";
  const transcriptPath = path.join(mesh.environment.home, ".pi", "sessions", `${sessionId}.jsonl`);
  try {
    await writeFile(transcriptPath, piTranscript(sessionId, server.projects[0].path));
    children.push(await startNode(mesh, server));
    children.push(await startNode(mesh, mac));
    await pairTwinNodes(mesh.environment);
    const [macAuth, serverAuth] = await Promise.all([signIn(mesh.environment, mac), signIn(mesh.environment, server)]);

    // Phase 1: the homeserver executes, the Mac watches.
    const claimed = await takeOwnership(mesh, server, serverAuth, sessionId, transcriptPath);
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    assert.deepEqual(claimed.body.pendingPeerIds, []);
    const serverSocket = await openConversation(mesh, server, transcriptPath);
    sockets.push(serverSocket);
    const recentResponse = await fetch(`${server.url}/api/recents`, {
      method: "PUT", headers: headers(serverAuth),
      body: JSON.stringify({ projectId: mesh.projectId, engine: "pi", sessionId, sessionPath: transcriptPath, title: "Resume this conversation", openedAt: new Date().toISOString(), updatedAt: null }),
    });
    assert.equal(recentResponse.status, 200, await recentResponse.text());
    const recentList = await fetch(`${server.url}/api/recents`, { headers: headers(serverAuth) });
    assert.ok((await recentList.json() as { recentSessions: Array<{ sessionId: string }> }).recentSessions.some((recent) => recent.sessionId === sessionId));
    sendPrompt(serverSocket, "run on the homeserver");
    await waitForInvocation(invocationLog, `pi:${server.nodeId}`);
    await waitForSession(mesh, mac, macAuth, sessionId, (session) => session.running && session.reviewState === "running");
    assert.equal((await waitForSession(mesh, server, serverAuth, sessionId, (session) => session.running)).reviewState, "running");

    await writeFile(path.join(holdDir, "pi.release"), "release");
    assert.equal(await waitForTextDelta(serverSocket), "textDelta");
    const finished = await waitForSession(mesh, mac, macAuth, sessionId, (session) => !session.running && session.reviewState === "needs_review");
    await markReviewed(mesh, mac, macAuth, finished);
    await waitForSession(mesh, server, serverAuth, sessionId, (session) => session.reviewState === "reviewed");
    await new Promise((resolve) => setTimeout(resolve, 350)); // Outside the 250 ms remote-watermark skew window.

    // Phase 2: the Mac executes, the homeserver reviews.
    await rm(path.join(holdDir, "pi.release"));
    const takeover = await takeOwnership(mesh, mac, macAuth, sessionId, transcriptPath);
    assert.equal(takeover.status, 200, JSON.stringify(takeover.body));
    const macSocket = await openConversation(mesh, mac, transcriptPath);
    sockets.push(macSocket);
    sendPrompt(macSocket, "run on the mac");
    await waitForInvocation(invocationLog, `pi:${mac.nodeId}`);
    await waitForSession(mesh, server, serverAuth, sessionId, (session) => session.running && session.reviewState === "running");
    await writeFile(path.join(holdDir, "pi.release"), "release");
    assert.equal(await waitForTextDelta(macSocket), "textDelta");
    const latestRecord = JSON.parse((await readFile(transcriptPath, "utf8")).trim().split("\n").at(-1)!) as { message?: { role?: string; timestamp?: number } };
    assert.equal(latestRecord.message?.role, "assistant", "the stub appends the completed turn to the shared transcript");
    assert.ok(latestRecord.message.timestamp! > Date.parse(finished.updatedAt!) + 250, "new activity clears the remote-watermark skew window");
    const finishedAgain = await waitForSession(mesh, server, serverAuth, sessionId, (session) => !session.running && session.reviewState === "needs_review");
    await markReviewed(mesh, server, serverAuth, finishedAgain);
    await waitForSession(mesh, mac, macAuth, sessionId, (session) => session.reviewState === "reviewed");

    // Phase 3: review state survives a node restart.
    await stopDevNode(children.pop()!);
    children.push(await startNode(mesh, mac));
    const macAuthAfterRestart = await signIn(mesh.environment, mac);
    await waitForSession(mesh, mac, macAuthAfterRestart, sessionId, (session) => session.reviewState === "reviewed", 30_000);

    // Phase 4: a crashed execution node stops advertising its run once the lease expires.
    const reclaim = await takeOwnership(mesh, server, serverAuth, sessionId, transcriptPath);
    assert.equal(reclaim.status, 200, JSON.stringify(reclaim.body));
    await rm(path.join(holdDir, "pi.release"));
    const crashSocket = await openConversation(mesh, server, transcriptPath);
    sockets.push(crashSocket);
    sendPrompt(crashSocket, "run that will crash");
    await waitForInvocation(invocationLog, `pi:${server.nodeId}`);
    await waitForSession(mesh, mac, macAuthAfterRestart, sessionId, (session) => session.running, 30_000);
    const serverChild = children.shift()!;
    serverChild.kill("SIGKILL");
    await new Promise<void>((resolve) => { serverChild.once("exit", () => resolve()); });
    await waitForSession(mesh, mac, macAuthAfterRestart, sessionId, (session) => !session.running, 40_000);
  } finally {
    for (const socket of sockets) socket.close();
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("a Claude conversation's running and review states sync the same way", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-state-sync-"));
  const sockets: WebSocket[] = [];
  const { mesh, server, mac, children } = await startMesh(root);
  const { invocationLog, holdDir } = mesh;
  const projectPath = server.projects[0].path;
  const claudeDir = path.join(mesh.environment.home, ".claude", "projects", claudeProjectDirName(projectPath));
  const sessionId = "claude-sync";
  const claudePath = path.join(claudeDir, `${sessionId}.jsonl`);
  try {
    await mkdir(claudeDir, { recursive: true });
    await writeFile(claudePath, `${JSON.stringify({ type: "user", sessionId, cwd: projectPath, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "preserve me" } })}\n`);
    children.push(await startNode(mesh, server));
    children.push(await startNode(mesh, mac));
    await pairTwinNodes(mesh.environment);
    const [macAuth, serverAuth] = await Promise.all([signIn(mesh.environment, mac), signIn(mesh.environment, server)]);

    const claimed = await takeOwnership(mesh, server, serverAuth, sessionId, `claude:${claudePath}`);
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    assert.deepEqual(claimed.body.pendingPeerIds, []);
    const serverSocket = await openConversation(mesh, server, `claude:${claudePath}`);
    sockets.push(serverSocket);
    sendPrompt(serverSocket, "claude run on the homeserver");
    await waitForInvocation(invocationLog, `claude:${server.nodeId}`);
    await waitForSession(mesh, mac, macAuth, sessionId, (session) => session.running && session.reviewState === "running");

    await writeFile(path.join(holdDir, "claude.release"), "release");
    assert.equal(await waitForTextDelta(serverSocket), "textDelta");
    const finished = await waitForSession(mesh, mac, macAuth, sessionId, (session) => !session.running && session.reviewState === "needs_review");
    await markReviewed(mesh, mac, macAuth, finished);
    await waitForSession(mesh, server, serverAuth, sessionId, (session) => session.reviewState === "reviewed");
  } finally {
    for (const socket of sockets) socket.close();
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
