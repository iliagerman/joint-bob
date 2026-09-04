import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import WebSocket, { WebSocketServer } from "ws";

interface PeerFixture {
  httpServer: Server;
  sockets: WebSocketServer;
  url: string;
  forwardedUrl: () => string;
}

interface AuthFixture {
  cookie: string;
  headers: Record<string, string>;
}

function sessionCookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected a session cookie");
  return value.split(";", 1)[0];
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
    socket.once("error", reject);
  });
}

async function startPeer(): Promise<PeerFixture> {
  const httpServer = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  let forwardedUrl = "";
  httpServer.on("upgrade", (request, rawSocket, head) => {
    forwardedUrl = request.url ?? "";
    sockets.handleUpgrade(request, rawSocket, head, (upstream) => sockets.emit("connection", upstream, request));
  });
  sockets.on("connection", (upstream) => upstream.send(JSON.stringify({ type: "ready" })));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Peer server did not bind");
  return { httpServer, sockets, url: `http://127.0.0.1:${address.port}`, forwardedUrl: () => forwardedUrl };
}

async function startApp(): Promise<{ server: Server; baseUrl: string }> {
  const moduleUrl = new URL(`../src/server.ts?task-conversation-proxy=${Date.now()}`, import.meta.url);
  const { server } = await import(moduleUrl.href) as { server: Server };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("App server did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function signIn(baseUrl: string): Promise<AuthFixture> {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "initial-password" }),
  });
  const auth = await login.json() as { csrfToken: string };
  const cookie = sessionCookie(login);
  const headers = { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": auth.csrfToken };
  await fetch(`${baseUrl}/api/auth/change-password`, {
    method: "POST",
    headers,
    body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }),
  });
  return { cookie, headers };
}

async function createRemoteTask(root: string, baseUrl: string, auth: AuthFixture, peerUrl: string): Promise<{ projectId: string; taskId: string; peerId: string }> {
  const projectPath = path.join(root, "project");
  await mkdir(projectPath, { recursive: true });
  const created = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: auth.headers,
    body: JSON.stringify({ name: "Task conversation project", path: projectPath }),
  });
  const project = (await created.json() as { project: { id: string } }).project;
  const { createTask } = await import("../src/tasks.js");
  const task = await createTask(project.id, projectPath, "Remote conversation", "", "backlog", "claude", false, false, {});
  const peerId = randomUUID();
  const { saveClusterPeer } = await import("../src/cluster.js");
  const now = new Date().toISOString();
  await saveClusterPeer({ id: peerId, name: "Homeserver", url: peerUrl, token: "peer-machine-token", pairedAt: now, lastSeenAt: now, createdAt: now, updatedAt: now });
  return { projectId: project.id, taskId: task.id, peerId };
}

function routeTaskToPeer(root: string, taskId: string, peerId: string, sessionPath: string): void {
  const db = new DatabaseSync(path.join(root, "node.db"));
  db.prepare("UPDATE tasks SET current_node_id = ?, session_path = ? WHERE id = ?").run(peerId, sessionPath, taskId);
  db.close();
}

async function closeServer(server: Server): Promise<void> {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("task conversation proxy preserves the session ID across node-specific paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-task-conversation-proxy-"));
  const previous = [process.env.PI_WEB_DATA_DIR, process.env.MASTER_BOB_ADMIN_USERNAME, process.env.MASTER_BOB_INITIAL_PASSWORD];
  process.env.PI_WEB_DATA_DIR = root;
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  let peer: PeerFixture | undefined;
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  let socket: WebSocket | undefined;
  try {
    peer = await startPeer();
    app = await startApp();
    const auth = await signIn(app.baseUrl);
    const task = await createRemoteTask(root, app.baseUrl, auth, peer.url);
    const conversationId = randomUUID();
    const remotePath = `claude:/home/remote/.claude/projects/task/${conversationId}.jsonl`;
    routeTaskToPeer(root, task.taskId, task.peerId, remotePath);
    const localPath = `claude:/Users/local/.claude/projects/task/${conversationId}.jsonl`;
    const url = new URL("/ws", app.baseUrl.replace(/^http/, "ws"));
    for (const [key, value] of Object.entries({ projectId: task.projectId, taskId: task.taskId, sessionPath: localPath, sessionId: conversationId })) url.searchParams.set(key, value);
    socket = new WebSocket(url, { origin: app.baseUrl, headers: { Cookie: auth.cookie } });
    assert.deepEqual(await nextMessage(socket), { type: "ready" });
    const forwarded = new URL(peer.forwardedUrl(), "http://peer");
    assert.equal(forwarded.searchParams.get("sessionPath"), localPath);
    assert.equal(forwarded.searchParams.get("sessionId"), conversationId);
    assert.equal(forwarded.searchParams.get("taskId"), task.taskId);
  } finally {
    socket?.terminate();
    peer?.sockets.close();
    if (app) await closeServer(app.server);
    if (peer) await closeServer(peer.httpServer);
    restoreEnvironment("PI_WEB_DATA_DIR", previous[0]);
    restoreEnvironment("MASTER_BOB_ADMIN_USERNAME", previous[1]);
    restoreEnvironment("MASTER_BOB_INITIAL_PASSWORD", previous[2]);
    await rm(root, { recursive: true, force: true });
  }
});
