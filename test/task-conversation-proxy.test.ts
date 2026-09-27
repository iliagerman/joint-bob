import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "./dev-nodes.js";

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

/** Creates a ticket the way a node does, owned by that node (task creation through the API needs Syncthing). */
function createTaskOn(environment: DevEnvironment, node: SeededNode, project: SeededNode["projects"][number], title: string): { id: string } {
  const script = `import { createTask } from "./src/tasks.ts"; process.stdout.write(JSON.stringify(await createTask(${JSON.stringify(project.id)}, ${JSON.stringify(project.path)}, ${JSON.stringify(title)}, "", "backlog", "pi", false, false, {}))); process.exit(0);`;
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir }, encoding: "utf8" })) as { id: string };
}

function signedEnvelope(authorization: string | undefined): { senderNodeId: string; recipientNodeId: string; target: string } {
  assert.match(authorization ?? "", /^JointBobV2 /, "peer sockets must carry a signed request, not a bearer token");
  return (JSON.parse(Buffer.from(authorization!.slice("JointBobV2 ".length), "base64url").toString("utf8")) as { envelope: { senderNodeId: string; recipientNodeId: string; target: string } }).envelope;
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
    socket.once("close", (code, reason) => reject(new Error(`Socket closed before a message: ${code} ${reason.toString()}`)));
    socket.once("error", reject);
  });
}

test("task conversation proxy preserves the session ID across node-specific paths", { timeout: 150_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-task-conversation-proxy-"));
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
    const task = createTaskOn(environment, b, project, "Remote conversation");
    const deadline = Date.now() + 30_000;
    for (;;) {
      const listed = await api<{ tasks: Array<{ id: string; currentNodeId: string }> }>(a, sessionA, "GET", `/projects/${project.id}/tasks`);
      if (listed.body.tasks.some((candidate) => candidate.id === task.id && candidate.currentNodeId === b.nodeId)) break;
      if (Date.now() > deadline) throw new Error("A never received B's ticket");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const conversationId = randomUUID();
    // The owner recorded the conversation under its own home; this node knows it by another path.
    const remotePath = `claude:/home/remote/.claude/projects/task/${conversationId}.jsonl`;
    const db = new DatabaseSync(path.join(a.dataDir, "node.db"));
    try {
      db.exec("PRAGMA busy_timeout=5000");
      db.prepare("UPDATE tasks SET session_path = ? WHERE id = ?").run(remotePath, task.id);
    } finally { db.close(); }
    proxy = await peerProxy(b);
    proxy.mode = "stub";
    routePeerThrough(a, b, proxy.url);
    const localPath = `claude:/Users/local/.claude/projects/task/${conversationId}.jsonl`;
    const url = new URL("/ws", a.url.replace(/^http/, "ws"));
    for (const [key, value] of Object.entries({ projectId: project.id, taskId: task.id, sessionPath: localPath, sessionId: conversationId })) url.searchParams.set(key, value);
    socket = new WebSocket(url, { origin: a.url, headers: { Cookie: sessionA.cookie } });
    assert.deepEqual(await nextMessage(socket), { type: "ready" });
    const upgrade = proxy.upgrades.at(-1)!;
    const forwarded = new URL(upgrade.url, "http://peer");
    assert.equal(forwarded.searchParams.get("sessionPath"), localPath);
    assert.equal(forwarded.searchParams.get("sessionId"), conversationId);
    assert.equal(forwarded.searchParams.get("taskId"), task.id);
    const envelope = signedEnvelope(upgrade.authorization);
    assert.deepEqual([envelope.senderNodeId, envelope.recipientNodeId, envelope.target], [a.nodeId, b.nodeId, upgrade.url]);
  } finally {
    socket?.terminate();
    await proxy?.close();
    await Promise.all(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
