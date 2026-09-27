import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode } from "./dev-nodes.js";

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

type UpgradeMode = "reject" | "forward" | "stub";
interface PeerProxy {
  url: string;
  mode: UpgradeMode;
  stubMessage: unknown;
  upgrades: Array<{ url: string; authorization?: string }>;
  requests: Array<{ method: string; url: string; body: string }>;
  close(): Promise<void>;
}

/** Stands between node A and its twin B, so the test can see and shape what A sends B. */
async function peerProxy(upstream: SeededNode): Promise<PeerProxy> {
  const target = new URL(upstream.url);
  const stubs = new WebSocketServer({ noServer: true });
  stubs.on("connection", (socket) => socket.send(JSON.stringify(proxy.stubMessage)));
  const sockets = new Set<Socket>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    proxy.requests.push({ method: request.method ?? "", url: request.url ?? "", body: body.toString() });
    const forwarded = httpRequest({ host: target.hostname, port: target.port, method: request.method, path: request.url, headers: request.headers }, (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    });
    forwarded.on("error", () => { response.statusCode = 502; response.end(); });
    forwarded.end(body);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    proxy.upgrades.push({ url: request.url ?? "", authorization: request.headers.authorization });
    if (proxy.mode === "reject") { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
    if (proxy.mode === "stub") { stubs.handleUpgrade(request, socket, head, (upgraded) => stubs.emit("connection", upgraded, request)); return; }
    const link = connect(Number(target.port), target.hostname, () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      link.write(`${lines.join("\r\n")}\r\n\r\n`);
      link.write(head);
      socket.pipe(link);
      link.pipe(socket);
    });
    sockets.add(link);
    link.on("error", () => socket.destroy());
    socket.on("error", () => link.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy did not bind");
  const proxy: PeerProxy = {
    url: `http://127.0.0.1:${address.port}`,
    mode: "forward",
    stubMessage: { type: "ready" },
    upgrades: [],
    requests: [],
    close: async () => {
      stubs.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return proxy;
}

/** Points node A at the proxy for its twin B, the address A learned when they paired. */
function routePeerThrough(node: SeededNode, peer: SeededNode, url: string): void {
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    assert.equal(db.prepare("UPDATE cluster_v2_peer_endpoints SET url = ? WHERE node_id = ?").run(url, peer.nodeId).changes > 0, true);
  } finally { db.close(); }
}

function signedEnvelope(authorization: string | undefined): { senderNodeId: string; recipientNodeId: string; target: string } {
  assert.match(authorization ?? "", /^JointBobV2 /, "peer sockets must carry a signed request, not a bearer token");
  return (JSON.parse(Buffer.from(authorization!.slice("JointBobV2 ".length), "base64url").toString("utf8")) as { envelope: { senderNodeId: string; recipientNodeId: string; target: string } }).envelope;
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

test("embedded terminal runs in the project directory or the ticket workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-terminal-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  process.env.PI_WEB_DATA_DIR = root;
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";

  let appServer: import("node:http").Server | undefined;
  let socket: WebSocket | undefined;
  try {
    const moduleUrl = new URL(`../src/server.ts?terminal=${Date.now()}`, import.meta.url);
    ({ server: appServer } = await import(moduleUrl.href));
    const { getClusterNode } = await import("../src/cluster.js");
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

  } finally {
    socket?.terminate();
    if (appServer?.listening) await new Promise<void>((resolve) => appServer?.close(() => resolve()));
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousUsername === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME;
    else process.env.MASTER_BOB_ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD;
    else process.env.MASTER_BOB_INITIAL_PASSWORD = previousPassword;
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded terminal proxies to the selected twin with a signed socket", { timeout: 150_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-terminal-twin-"));
  const servers: ChildProcess[] = [];
  let proxy: PeerProxy | undefined;
  let socket: WebSocket | undefined;
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [a, b] = environment.nodes;
    for (const node of environment.nodes) servers.push(await startDevNode(environment, node));
    await pairTwinNodes(environment);
    const sessionA = await signIn(environment, a);
    const project = a.projects[0];
    proxy = await peerProxy(b);
    routePeerThrough(a, b, proxy.url);
    const remoteUrl = new URL(`/ws?mode=terminal&projectId=${project.id}&nodeId=${b.nodeId}`, a.url);
    remoteUrl.protocol = "ws:";
    socket = new WebSocket(remoteUrl, { origin: a.url, headers: { Cookie: sessionA.cookie } });
    assert.deepEqual(await nextMessage(socket), { type: "terminalReady", cwd: project.path, nodeId: b.nodeId });
    const output = await outputUntil(socket, ["remote-terminal-ok"], "printf remote-terminal-ok\n");
    assert.match(output, /remote-terminal-ok/);
    const upgrade = proxy.upgrades.at(-1)!;
    const envelope = signedEnvelope(upgrade.authorization);
    assert.deepEqual([envelope.senderNodeId, envelope.recipientNodeId, envelope.target], [a.nodeId, b.nodeId, upgrade.url]);
    const forwardedUrl = new URL(upgrade.url, "http://peer");
    assert.equal(forwardedUrl.searchParams.get("mode"), "terminal");
    assert.equal(forwardedUrl.searchParams.get("nodeSession"), "1");
    assert.equal(forwardedUrl.searchParams.has("nodeId"), false);
    socket.close();

    const terminalFlags = async (): Promise<Record<string, unknown>> => {
      const nodes = await api<{ nodes: Array<{ id: string; terminal: boolean }> }>(a, sessionA, "GET", `/projects/${project.id}/session-nodes`);
      return Object.fromEntries(nodes.body.nodes.map((node) => [node.id, node.terminal]));
    };
    assert.deepEqual(await terminalFlags(), { [a.nodeId]: true, [b.nodeId]: true }, "a twin may open a terminal by default");

    // B switches twins off: A's browser loses B's terminal in the node list and on the socket.
    const sessionB = await signIn(environment, b);
    const settingsB = (await api<Record<string, unknown>>(b, sessionB, "GET", "/settings")).body;
    assert.equal((await api(b, sessionB, "PUT", "/settings", { ...settingsB, remoteTerminal: { twins: false, otherNodes: false } })).status, 200);
    assert.deepEqual(await terminalFlags(), { [a.nodeId]: true, [b.nodeId]: false });
    socket = new WebSocket(remoteUrl, { origin: a.url, headers: { Cookie: sessionA.cookie } });
    const refused = socket;
    const closed = new Promise<{ code: number; reason: string }>((resolve) => refused.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
    assert.deepEqual(await nextMessage(socket), { type: "terminalError", error: `Terminal access from other nodes is disabled on ${b.name}` });
    assert.deepEqual(await closed, { code: 4031, reason: `Terminal access from other nodes is disabled on ${b.name}` });

    // A browser signed in to B directly still gets B's own terminal.
    const localUrl = new URL(`/ws?mode=terminal&projectId=${project.id}&nodeId=${b.nodeId}`, b.url);
    localUrl.protocol = "ws:";
    socket = new WebSocket(localUrl, { origin: b.url, headers: { Cookie: sessionB.cookie } });
    assert.equal((await nextMessage(socket)).type, "terminalReady");
  } finally {
    socket?.terminate();
    await proxy?.close();
    await Promise.all(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
