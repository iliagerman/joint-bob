import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";

interface NodeProcess {
  baseUrl: string;
  dataDir: string;
  child: ChildProcess;
  output: () => string;
}

interface Session {
  headers: Record<string, string>;
}

async function startNode(root: string, name: string, port = 0): Promise<NodeProcess> {
  const dataDir = path.join(root, name);
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PORT: String(port),
      PI_WEB_DATA_DIR: dataDir,
      MASTER_BOB_ADMIN_USERNAME: "admin",
      MASTER_BOB_INITIAL_PASSWORD: "initial-password",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${name} exited during startup (${child.exitCode})\n${output}`);
    const portMatch = output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/);
    if (portMatch) {
      const node = { baseUrl: `http://127.0.0.1:${portMatch[1]}`, dataDir, child, output: () => output };
      try {
        const response = await fetch(`${node.baseUrl}/api/health`);
        if (response.ok) return node;
      } catch {
        // The child has not started accepting requests yet.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGTERM");
  throw new Error(`${name} did not become healthy\n${output}`);
}

async function stopNode(node: NodeProcess): Promise<void> {
  if (node.child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => node.child.once("exit", () => resolve()));
  node.child.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  if (node.child.exitCode === null) node.child.kill("SIGKILL");
}

async function session(node: NodeProcess): Promise<Session> {
  const login = await fetch(`${node.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "initial-password" }),
  });
  assert.equal(login.status, 200, node.output());
  const body = await login.json() as { csrfToken: string };
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error(`Missing cookie\n${node.output()}`);
  const headers = { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" };
  const changed = await fetch(`${node.baseUrl}/api/auth/change-password`, {
    method: "POST",
    headers,
    body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }),
  });
  assert.equal(changed.status, 204, node.output());
  return { headers };
}

async function configure(node: NodeProcess, auth: Session, name: string): Promise<void> {
  const response = await fetch(`${node.baseUrl}/api/cluster/node`, {
    method: "PUT",
    headers: auth.headers,
    body: JSON.stringify({ name, url: node.baseUrl }),
  });
  assert.equal(response.status, 200, node.output());
}

async function invite(node: NodeProcess, auth: Session): Promise<string> {
  const response = await fetch(`${node.baseUrl}/api/cluster/invite`, { headers: auth.headers });
  assert.equal(response.status, 200, node.output());
  return (await response.json() as { token: string }).token;
}

async function pair(source: NodeProcess, auth: Session, target: NodeProcess, token: string): Promise<Response> {
  const response = await fetch(`${source.baseUrl}/api/cluster/peers`, {
    method: "POST",
    headers: auth.headers,
    body: JSON.stringify({ url: target.baseUrl, token }),
  });
  assert.equal(response.status, 201, `${source.output()}\n${target.output()}`);
  return response;
}

async function peers(node: NodeProcess, auth: Session) {
  const response = await fetch(`${node.baseUrl}/api/cluster/peers`, { headers: auth.headers });
  assert.equal(response.status, 200, node.output());
  return (await response.json() as { peers: Array<{ id: string; token?: string; tokenConfigured: boolean; lastSeenAt: string | null; online: boolean }> }).peers;
}

async function waitForMesh(nodes: Array<{ node: NodeProcess; auth: Session }>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const allPeers = await Promise.all(nodes.map(({ node, auth }) => peers(node, auth)));
    if (allPeers.every((list) => list.length === 2)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Mesh did not converge\n${nodes.map(({ node }) => node.output()).join("\n")}`);
}

test("same-URL replacement tombstones the old peer and rotates the local credential", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-cluster-replacement-"));
  const nodes: NodeProcess[] = [];
  try {
    const a = await startNode(root, "a");
    const oldB = await startNode(root, "old-b", 19491);
    nodes.push(a, oldB);
    const [aAuth, oldBAuth] = await Promise.all([session(a), session(oldB)]);
    await Promise.all([configure(a, aAuth, "A"), configure(oldB, oldBAuth, "Old B")]);
    const [oldAToken, oldBToken] = await Promise.all([invite(a, aAuth), invite(oldB, oldBAuth)]);
    const oldBId = (await (await fetch(`${oldB.baseUrl}/api/cluster/node`, { headers: oldBAuth.headers })).json() as { node: { id: string } }).node.id;
    await pair(a, aAuth, oldB, oldBToken);

    await stopNode(oldB);
    const replacementB = await startNode(root, "replacement-b", 19491);
    nodes.push(replacementB);
    const replacementBAuth = await session(replacementB);
    await configure(replacementB, replacementBAuth, "Replacement B");
    const replacementPairing = await pair(replacementB, replacementBAuth, a, oldAToken);
    assert.equal(replacementPairing.status, 201, `${replacementB.output()}\n${a.output()}`);

    const [replacementBId, aId] = await Promise.all([
      (async () => (await (await fetch(`${replacementB.baseUrl}/api/cluster/node`, { headers: replacementBAuth.headers })).json() as { node: { id: string } }).node.id)(),
      (async () => (await (await fetch(`${a.baseUrl}/api/cluster/node`, { headers: aAuth.headers })).json() as { node: { id: string } }).node.id)(),
    ]);
    const [aPeers, replacementPeers] = await Promise.all([peers(a, aAuth), peers(replacementB, replacementBAuth)]);
    assert(aPeers.some((peer) => peer.id === replacementBId));
    assert(!aPeers.some((peer) => peer.id === oldBId));
    assert(replacementPeers.some((peer) => peer.id === aId && peer.tokenConfigured));
    const aInventory = await fetch(`${a.baseUrl}/api/cluster/inventory`, { headers: aAuth.headers });
    assert.equal(aInventory.status, 200, a.output());
    assert((await aInventory.json() as { remote: Array<{ peerId: string; reachable: boolean }> }).remote.some((peer) => peer.peerId === replacementBId && peer.reachable));
    const replacementInventory = await fetch(`${replacementB.baseUrl}/api/cluster/inventory`, { headers: replacementBAuth.headers });
    assert.equal(replacementInventory.status, 200, replacementB.output());
    assert((await replacementInventory.json() as { remote: Array<{ peerId: string; reachable: boolean }> }).remote.some((peer) => peer.peerId === aId && peer.reachable));
    const database = new DatabaseSync(path.join(a.dataDir, "node.db"));
    const tombstone = database.prepare("SELECT id FROM cluster_member_tombstones WHERE id = ?").get(oldBId) as { id: string } | undefined;
    database.close();
    assert.equal(tombstone?.id, oldBId);

    assert.equal((await fetch(`${a.baseUrl}/api/cluster/node`, { headers: { Authorization: `Bearer ${oldAToken}` } })).status, 401, a.output());
    const freshAToken = await invite(a, aAuth);
    assert.notEqual(freshAToken, oldAToken);
    assert.equal((await fetch(`${a.baseUrl}/api/cluster/node`, { headers: { Authorization: `Bearer ${freshAToken}` } })).status, 200, a.output());
  } finally {
    await Promise.all(nodes.map(stopNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("DELETE peer returns conflict while it owns a replicated task", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-cluster-dependent-delete-"));
  const nodes: NodeProcess[] = [];
  try {
    const [a, b] = await Promise.all([startNode(root, "a"), startNode(root, "b")]);
    nodes.push(a, b);
    const [aAuth, bAuth] = await Promise.all([session(a), session(b)]);
    await Promise.all([configure(a, aAuth, "A"), configure(b, bAuth, "B")]);
    const [aToken, bToken] = await Promise.all([invite(a, aAuth), invite(b, bAuth)]);
    await pair(a, aAuth, b, bToken);
    const bId = (await (await fetch(`${b.baseUrl}/api/cluster/node`, { headers: bAuth.headers })).json() as { node: { id: string } }).node.id;
    const task = {
      id: "peer-owned-task",
      title: "Peer-owned task",
      description: "plaintext",
      status: "backlog",
      engine: "pi",
      planMode: false,
      reviewMode: false,
      phaseConfig: {},
      sessionPath: null,
      worktreePath: null,
      worktreeBranch: null,
      mergedAt: null,
      currentNodeId: bId,
      leaseOwnerNodeId: null,
      leaseExpiresAt: null,
      executionState: "idle",
      handoffContext: null,
      originNodeId: bId,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const seeded = await fetch(`${a.baseUrl}/api/cluster/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ events: [{ id: "00000000-0000-4000-8000-000000000099", originNodeId: bId, entityType: "task", entityKey: `project:${task.id}`, operation: "upsert", payload: { projectId: "project", task, originNodeId: bId }, createdAt: task.updatedAt }] }),
    });
    assert.equal(seeded.status, 200, a.output());

    const removed = await fetch(`${a.baseUrl}/api/cluster/peers/${bId}`, { method: "DELETE", headers: aAuth.headers });
    const body = await removed.json() as { error: string };
    assert.equal(removed.status, 409, a.output());
    assert.equal(body.error, `Transfer owned tasks and settle handoffs before removing cluster member ${bId}`);
    assert((await peers(a, aAuth)).some((peer) => peer.id === bId));
  } finally {
    await Promise.all(nodes.map(stopNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("three independent nodes pair into an authenticated mesh", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-cluster-mesh-"));
  const nodes: NodeProcess[] = [];
  try {
    const [a, b, c] = await Promise.all([startNode(root, "a"), startNode(root, "b"), startNode(root, "c")]);
    nodes.push(a, b, c);
    const unauthenticatedInvite = await fetch(`${a.baseUrl}/api/cluster/invite`);
    assert.equal(unauthenticatedInvite.status, 401);

    const [aAuth, bAuth, cAuth] = await Promise.all([session(a), session(b), session(c)]);
    await Promise.all([configure(a, aAuth, "A"), configure(b, bAuth, "B"), configure(c, cAuth, "C")]);
    const [aToken, bToken] = await Promise.all([invite(a, aAuth), invite(b, bAuth)]);
    const machineInvite = await fetch(`${a.baseUrl}/api/cluster/invite`, { headers: { Authorization: `Bearer ${aToken}` } });
    assert.equal(machineInvite.status, 401);
    const settingsWithMachineToken = await fetch(`${a.baseUrl}/api/settings`, { headers: { Authorization: `Bearer ${aToken}` } });
    assert.equal(settingsWithMachineToken.status, 401);

    await pair(a, aAuth, b, bToken);
    const [aAfterPair, bAfterPair] = await Promise.all([peers(a, aAuth), peers(b, bAuth)]);
    assert.equal(aAfterPair.length, 1);
    assert.equal(bAfterPair.length, 1);
    const cToken = await invite(c, cAuth);
    await pair(b, bAuth, c, cToken);
    await waitForMesh([{ node: a, auth: aAuth }, { node: b, auth: bAuth }, { node: c, auth: cAuth }]);

    for (const [node, auth] of [[a, aAuth], [b, bAuth], [c, cAuth]] as const) {
      const nodePeers = await peers(node, auth);
      assert(nodePeers.every((peer) => peer.token === undefined && peer.tokenConfigured));
      const inventory = await fetch(`${node.baseUrl}/api/cluster/inventory`, { headers: auth.headers });
      assert.equal(inventory.status, 200, node.output());
      await new Promise((resolve) => setTimeout(resolve, 20));
      const refreshed = await peers(node, auth);
      assert(refreshed.every((peer) => peer.lastSeenAt && peer.online));
    }
  } finally {
    await Promise.all(nodes.map(stopNode));
    await rm(root, { recursive: true, force: true });
  }
});
