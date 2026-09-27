import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { signedNodeRequest } from "./signed-node-request.js";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "./dev-nodes.js";

type UpgradeMode = "reject" | "forward" | "stub";
interface PeerProxy {
  url: string;
  mode: UpgradeMode;
  upgrades: Array<{ url: string; authorization?: string }>;
  requests: Array<{ method: string; url: string; body: string }>;
  close(): Promise<void>;
}

/** Stands between node A and its twin B, so the test can see and shape what A sends B. */
async function peerProxy(upstream: SeededNode): Promise<PeerProxy> {
  const target = new URL(upstream.url);
  const stubs = new WebSocketServer({ noServer: true });
  stubs.on("connection", (socket) => socket.send(JSON.stringify({ type: "watchReady" })));
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

function firstMessage(socket: WebSocket, label: string): Promise<{ payload: unknown; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw, isBinary) => resolve({ payload: JSON.parse(raw.toString()), isBinary }));
    socket.once("close", (code, reason) => reject(new Error(`${label} socket closed before a message: ${code} ${reason.toString()}`)));
    socket.once("error", reject);
  });
}

test("execution-node WebSockets close on rejection and route task sessions to their owner", { timeout: 150_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-proxy-error-"));
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
    const wsUrl = (query: string): URL => { const url = new URL(`/ws?${query}`, a.url); url.protocol = "ws:"; return url; };
    const open = (url: URL): WebSocket => new WebSocket(url, { origin: a.url, headers: { Cookie: sessionA.cookie } });

    proxy.mode = "reject";
    socket = open(wsUrl(`projectId=${project.id}&sessionPath=watch&nodeId=${b.nodeId}`));
    const closed = await Promise.race([
      new Promise<{ code: number; reason: string }>((resolve, reject) => {
        socket?.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
        socket?.once("error", reject);
      }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Proxied socket stayed open")), 5_000)),
    ]);
    assert.deepEqual(closed, { code: 1011, reason: "Execution node rejected connection (401)" });

    proxy.mode = "forward";
    socket = open(wsUrl(`projectId=${project.id}&sessionPath=new&nodeId=${b.nodeId}`));
    const forwarded = await firstMessage(socket, "new conversation");
    assert.equal(forwarded.isBinary, false);
    const freshRemoteUrl = new URL(proxy.upgrades.at(-1)!.url, "http://upstream.test");
    assert.equal(freshRemoteUrl.searchParams.get("nodeSession"), "1");
    assert.equal(freshRemoteUrl.searchParams.get("nodeId"), null);
    const ownedId = freshRemoteUrl.searchParams.get("sessionId") ?? "";
    assert.match(ownedId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.deepEqual(signedEnvelope(proxy.upgrades.at(-1)!.authorization), { ...signedEnvelope(proxy.upgrades.at(-1)!.authorization), senderNodeId: a.nodeId, recipientNodeId: b.nodeId, target: proxy.upgrades.at(-1)!.url });
    socket.terminate();

    // The new conversation now belongs to B; A learns that through replication.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const response = await signedNodeRequest(environment, b, a, "GET", `/api/cluster/v2/runtime/sessions/ownership?engine=pi&sessionId=${ownedId}`);
      const ownership = await response.json() as { ownership?: { ownerNodeId: string } | null };
      if (ownership.ownership?.ownerNodeId === b.nodeId) break;
      if (Date.now() > deadline) throw new Error(`A never learned B owns ${ownedId}: ${response.status} ${JSON.stringify(ownership)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // A ticket owned by B: a socket naming its conversation path goes to B, not A.
    const created = { body: { task: createTaskOn(environment, b, project, "Owner task") } };
    const taskSessionPath = `claude:${path.join(root, "owner-worktree", "session.jsonl")}`;
    for (;;) {
      const listed = await api<{ tasks: Array<{ id: string; currentNodeId: string }> }>(a, sessionA, "GET", `/projects/${project.id}/tasks`);
      if (listed.body.tasks.some((task) => task.id === created.body.task.id && task.currentNodeId === b.nodeId)) break;
      if (Date.now() > deadline + 30_000) throw new Error("A never received B's ticket");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const db = new DatabaseSync(path.join(a.dataDir, "node.db"));
    try {
      db.exec("PRAGMA busy_timeout=5000");
      db.prepare("UPDATE tasks SET session_path = ? WHERE id = ?").run(taskSessionPath, created.body.task.id);
    } finally { db.close(); }
    proxy.mode = "stub";
    const taskUrl = wsUrl(`projectId=${project.id}`);
    taskUrl.searchParams.set("sessionPath", taskSessionPath);
    socket = open(taskUrl);
    assert.deepEqual(await firstMessage(socket, "ticket"), { payload: { type: "watchReady" }, isBinary: false });
    const routedTaskUrl = new URL(proxy.upgrades.at(-1)!.url, "http://upstream.test");
    assert.equal(routedTaskUrl.searchParams.get("taskId"), created.body.task.id);
    assert.equal(routedTaskUrl.searchParams.get("sessionPath"), taskSessionPath);
    socket.terminate();

    socket = open(wsUrl(`projectId=${project.id}&sessionPath=draft:pi:${ownedId}&sessionId=${ownedId}`));
    await firstMessage(socket, "owned draft");
    const existingOwnerUrl = new URL(proxy.upgrades.at(-1)!.url, "http://upstream.test");
    assert.equal(existingOwnerUrl.searchParams.get("sessionId"), ownedId);
    assert.equal(existingOwnerUrl.searchParams.get("nodeId"), null);
    socket.terminate();

    const deletion = await fetch(`${a.url}/api/projects/${project.id}/sessions?engine=pi&sessionId=${ownedId}`, {
      method: "DELETE", headers: { Cookie: sessionA.cookie, "X-CSRF-Token": sessionA.csrfToken },
    });
    assert.equal(deletion.status, 204, await deletion.text());
    const deleteRequest = proxy.requests.find((request) => request.method === "DELETE" && request.url === "/api/cluster/v2/runtime/sessions/delete");
    assert.ok(deleteRequest, JSON.stringify(proxy.requests.map((request) => `${request.method} ${request.url}`)));
    assert.deepEqual(JSON.parse(deleteRequest.body), { projectId: project.id, engine: "pi", sessionId: ownedId });
  } finally {
    socket?.terminate();
    await proxy?.close();
    await Promise.all(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
