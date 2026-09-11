import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";

function sessionCookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected a session cookie");
  return value.split(";", 1)[0];
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Terminal message timed out for ${socket.url}`)), 10_000);
    socket.once("message", (raw) => { clearTimeout(timer); resolve(JSON.parse(raw.toString()) as Record<string, unknown>); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function outputUntil(socket: WebSocket, expected: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const cleanup = (): void => { clearTimeout(timer); socket.off("message", onMessage); socket.off("error", onError); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onMessage = (raw: WebSocket.RawData): void => {
      const payload = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (payload.type === "terminalOutput") output += String(payload.data ?? "");
      if (expected.every((value) => output.includes(value))) { cleanup(); resolve(output); }
    };
    const timer = setTimeout(() => onError(new Error("Terminal output timed out")), 10_000);
    // One listener for the whole command: multiple frames can arrive in one socket read.
    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.send(JSON.stringify({ type: "terminalInput", data: input }));
  });
}

test("embedded terminal runs in the project directory or proxies to the selected peer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-terminal-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  process.env.PI_WEB_DATA_DIR = root;
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";

  const peerHttpServer = createServer();
  const peerSockets = new WebSocketServer({ noServer: true });
  let appServer: import("node:http").Server | undefined;
  let socket: WebSocket | undefined;
  let forwarded: { authorization?: string; url?: string } = {};
  try {
    const moduleUrl = new URL(`../src/server.ts?terminal=${Date.now()}`, import.meta.url);
    ({ server: appServer } = await import(moduleUrl.href));
    const { getClusterNode, saveClusterPeer } = await import("../src/cluster.js");
    const { createTask } = await import("../src/tasks.js");
    await new Promise<void>((resolve) => appServer?.listen(0, "127.0.0.1", resolve));
    const address = appServer.address();
    if (!address || typeof address === "string") throw new Error("App server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;

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

    const projectPath = path.join(root, "project");
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Terminal project", path: projectPath }),
    });
    const project = (await created.json() as { project: { id: string } }).project;
    const local = await getClusterNode();
    const terminalUrl = new URL(`/ws?mode=terminal&projectId=${project.id}&nodeId=${local.id}`, baseUrl);
    terminalUrl.protocol = "ws:";
    socket = new WebSocket(terminalUrl, { origin: baseUrl, headers: { Cookie: cookie } });

    assert.deepEqual(await nextMessage(socket), { type: "terminalReady", cwd: projectPath, nodeId: local.id });
    const output = await outputUntil(socket, ["terminal-ok", projectPath], "printf terminal-ok; pwd\n");
    assert.match(output, /terminal-ok/);
    assert.match(output, new RegExp(projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    socket.close();

    // A board ticket owns its own copy of the project, so its terminal must land there.
    await mkdir(projectPath, { recursive: true });
    const ticket = await createTask(project.id, projectPath, "Terminal ticket", "", "backlog", "pi", false, false, {});
    const ticketUrl = new URL(`/ws?mode=terminal&projectId=${project.id}&nodeId=${local.id}&taskId=${ticket.id}`, baseUrl);
    ticketUrl.protocol = "ws:";
    socket = new WebSocket(ticketUrl, { origin: baseUrl, headers: { Cookie: cookie } });
    assert.deepEqual(await nextMessage(socket), { type: "terminalReady", cwd: ticket.worktreePath, nodeId: local.id });
    socket.close();
    await rm(path.dirname(ticket.worktreePath ?? ""), { recursive: true, force: true });

    peerHttpServer.on("upgrade", (request, rawSocket, head) => {
      forwarded = { authorization: request.headers.authorization, url: request.url };
      peerSockets.handleUpgrade(request, rawSocket, head, (upstream) => peerSockets.emit("connection", upstream, request));
    });
    const peerId = randomUUID();
    peerSockets.on("connection", (upstream) => upstream.send(JSON.stringify({ type: "terminalReady", cwd: "/remote/project", nodeId: peerId })));
    await new Promise<void>((resolve) => peerHttpServer.listen(0, "127.0.0.1", resolve));
    const peerAddress = peerHttpServer.address();
    if (!peerAddress || typeof peerAddress === "string") throw new Error("Peer server did not bind");
    await saveClusterPeer({
      id: peerId,
      name: "Mac",
      url: `http://127.0.0.1:${peerAddress.port}`,
      token: "peer-machine-token",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const remoteUrl = new URL(`/ws?mode=terminal&projectId=${project.id}&nodeId=${peerId}`, baseUrl);
    remoteUrl.protocol = "ws:";
    socket = new WebSocket(remoteUrl, { origin: baseUrl, headers: { Cookie: cookie } });
    assert.deepEqual(await nextMessage(socket), { type: "terminalReady", cwd: "/remote/project", nodeId: peerId });
    assert.equal(forwarded.authorization, "Bearer peer-machine-token");
    const forwardedUrl = new URL(forwarded.url ?? "", "http://peer");
    assert.equal(forwardedUrl.searchParams.get("mode"), "terminal");
    assert.equal(forwardedUrl.searchParams.get("nodeSession"), "1");
    assert.equal(forwardedUrl.searchParams.has("nodeId"), false);
  } finally {
    socket?.terminate();
    peerSockets.close();
    if (appServer?.listening) await new Promise<void>((resolve) => appServer?.close(() => resolve()));
    if (peerHttpServer.listening) await new Promise<void>((resolve) => peerHttpServer.close(() => resolve()));
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousUsername === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME;
    else process.env.MASTER_BOB_ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD;
    else process.env.MASTER_BOB_INITIAL_PASSWORD = previousPassword;
    await rm(root, { recursive: true, force: true });
  }
});
