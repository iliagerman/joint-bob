import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";

function sessionCookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected a session cookie");
  return value.split(";", 1)[0];
}

test("execution-node WebSockets close on rejection and route task sessions to their owner", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "master-bob-proxy-error-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  process.env.PI_WEB_DATA_DIR = dataDir;
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  let deletePayload: unknown;
  const rejectingServer = createServer(async (request, response) => {
    if (request.method === "DELETE" && request.url === "/api/cluster/sessions/delete") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      deletePayload = JSON.parse(Buffer.concat(chunks).toString());
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const upstreamSockets = new WebSocketServer({ noServer: true });
  const upstreamUrls: string[] = [];
  let rejectUpstream = true;
  rejectingServer.on("upgrade", (request, socket, head) => {
    if (rejectUpstream) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    upstreamUrls.push(request.url ?? "");
    upstreamSockets.handleUpgrade(request, socket, head, (upstream) => {
      upstreamSockets.emit("connection", upstream, request);
    });
  });
  upstreamSockets.on("connection", (upstream) => upstream.send(JSON.stringify({ type: "watchReady" })));
  let appServer: import("node:http").Server | undefined;
  let socket: WebSocket | undefined;
  try {
    await new Promise<void>((resolve) => rejectingServer.listen(0, "127.0.0.1", resolve));
    const rejectingAddress = rejectingServer.address();
    if (!rejectingAddress || typeof rejectingAddress === "string") throw new Error("Rejecting server did not bind");

    const moduleUrl = new URL(`../src/server.ts?proxy-error=${Date.now()}`, import.meta.url);
    ({ server: appServer } = await import(moduleUrl.href));
    const [{ getClusterNode, saveClusterPeer }, { receiveReplicationBatch }] = await Promise.all([
      import("../src/cluster.js"),
      import("../src/replication.js"),
    ]);
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
    await fetch(`${baseUrl}/api/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": auth.csrfToken },
      body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }),
    });
    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": auth.csrfToken },
      body: JSON.stringify({ name: "Proxy error", path: path.join(dataDir, "project") }),
    });
    const project = await projectResponse.json() as { project: { id: string } };
    const local = await getClusterNode();
    const peer = {
      id: randomUUID(),
      name: "Rejecting node",
      url: `http://127.0.0.1:${rejectingAddress.port}`,
      token: "stale-machine-token",
      pairedAt: new Date().toISOString(),
      lastSeenAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveClusterPeer(peer);

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?projectId=${project.project.id}&sessionPath=watch&nodeId=${peer.id}`, {
      origin: baseUrl,
      headers: { Cookie: cookie },
    });
    const closed = await Promise.race([
      new Promise<{ code: number; reason: string }>((resolve, reject) => {
        socket?.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
        socket?.once("error", reject);
      }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Proxied socket stayed open")), 2_000)),
    ]);
    assert.deepEqual(closed, { code: 1011, reason: "Execution node rejected connection (401)" });

    rejectUpstream = false;
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?projectId=${project.project.id}&sessionPath=claude:new&nodeId=${peer.id}`, {
      origin: baseUrl,
      headers: { Cookie: cookie },
    });
    const forwarded = await new Promise<{ payload: unknown; isBinary: boolean }>((resolve, reject) => {
      socket?.once("message", (raw, isBinary) => resolve({ payload: JSON.parse(raw.toString()), isBinary }));
      socket?.once("error", reject);
    });
    assert.deepEqual(forwarded, { payload: { type: "watchReady" }, isBinary: false });
    const freshRemoteUrl = new URL(upstreamUrls.at(-1)!, "http://upstream.test");
    assert.equal(freshRemoteUrl.searchParams.get("nodeSession"), "1");
    assert.equal(freshRemoteUrl.searchParams.get("nodeId"), null);
    assert.match(freshRemoteUrl.searchParams.get("sessionId") ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(local.id, peer.id);

    const ownerWorktreePath = path.join(dataDir, "owner-worktree");
    const taskSessionPath = `claude:${path.join(ownerWorktreePath, "session.jsonl")}`;
    const now = new Date().toISOString();
    const task = {
      id: "owner-task",
      title: "Owner task",
      description: "Runs in an owner-local worktree",
      status: "review",
      engine: "pi",
      planMode: false,
      reviewMode: false,
      phaseConfig: {},
      sessionPath: taskSessionPath,
      worktreePath: ownerWorktreePath,
      worktreeBranch: "pi-ticket/owner-task",
      mergedAt: null,
      currentNodeId: peer.id,
      leaseOwnerNodeId: null,
      leaseExpiresAt: null,
      executionState: "idle",
      handoffContext: null,
      originNodeId: peer.id,
      createdAt: now,
      updatedAt: now,
    } as const;
    await receiveReplicationBatch({ events: [{
      id: randomUUID(),
      originNodeId: peer.id,
      entityType: "task",
      entityKey: `${project.project.id}:${task.id}`,
      operation: "upsert",
      payload: { projectId: project.project.id, task, originNodeId: peer.id },
      createdAt: now,
    }] });

    socket.terminate();
    const taskUrl = new URL(`/ws?projectId=${project.project.id}`, baseUrl);
    taskUrl.protocol = "ws:";
    taskUrl.searchParams.set("sessionPath", taskSessionPath);
    socket = new WebSocket(taskUrl, { origin: baseUrl, headers: { Cookie: cookie } });
    const routedTask = await new Promise<{ payload: unknown; isBinary: boolean }>((resolve, reject) => {
      socket?.once("message", (raw, isBinary) => resolve({ payload: JSON.parse(raw.toString()), isBinary }));
      socket?.once("error", reject);
    });
    assert.deepEqual(routedTask, { payload: { type: "watchReady" }, isBinary: false });

    const { takeConversationOwnership } = await import("../src/conversation-ownership.js");
    const ownedId = randomUUID();
    await takeConversationOwnership("pi", ownedId, peer.id);
    socket.terminate();
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?projectId=${project.project.id}&sessionPath=draft:pi:${ownedId}&sessionId=${ownedId}`, { origin: baseUrl, headers: { Cookie: cookie } });
    await new Promise<void>((resolve, reject) => {
      socket?.once("message", () => resolve());
      socket?.once("error", reject);
    });
    const existingOwnerUrl = new URL(upstreamUrls.at(-1)!, "http://upstream.test");
    assert.equal(existingOwnerUrl.searchParams.get("sessionId"), ownedId);
    assert.equal(existingOwnerUrl.searchParams.get("nodeId"), null);

    socket.terminate();
    const deletion = await fetch(`${baseUrl}/api/projects/${project.project.id}/sessions?engine=pi&sessionId=${ownedId}`, {
      method: "DELETE", headers: { Cookie: cookie, "X-CSRF-Token": auth.csrfToken },
    });
    assert.equal(deletion.status, 204);
    assert.deepEqual(deletePayload, { projectId: project.project.id, engine: "pi", sessionId: ownedId });
  } finally {
    socket?.terminate();
    upstreamSockets.close();
    if (appServer?.listening) await new Promise<void>((resolve) => appServer?.close(() => resolve()));
    if (rejectingServer.listening) await new Promise<void>((resolve) => rejectingServer.close(() => resolve()));
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousUsername === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME;
    else process.env.MASTER_BOB_ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD;
    else process.env.MASTER_BOB_INITIAL_PASSWORD = previousPassword;
    await rm(dataDir, { recursive: true, force: true });
  }
});
