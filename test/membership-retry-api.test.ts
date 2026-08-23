import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

async function startNode(root: string, name: string, port: number): Promise<NodeProcess> {
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
  const node = { baseUrl: `http://127.0.0.1:${port}`, dataDir, child, output: () => output };
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${name} exited during startup (${child.exitCode})\n${output}`);
    try {
      if ((await fetch(`${node.baseUrl}/api/health`)).ok) return node;
    } catch {
      // The child has not started accepting requests yet.
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
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
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
  return fetch(`${source.baseUrl}/api/cluster/peers`, {
    method: "POST",
    headers: auth.headers,
    body: JSON.stringify({ url: target.baseUrl, token }),
  });
}

async function peerList(node: NodeProcess, auth: Session): Promise<Array<{ id: string; url: string }>> {
  const response = await fetch(`${node.baseUrl}/api/cluster/peers`, { headers: auth.headers });
  assert.equal(response.status, 200, node.output());
  return (await response.json() as { peers: Array<{ id: string; url: string }> }).peers;
}

async function nodeId(node: NodeProcess, auth: Session): Promise<string> {
  const response = await fetch(`${node.baseUrl}/api/cluster/node`, { headers: auth.headers });
  assert.equal(response.status, 200, node.output());
  return (await response.json() as { node: { id: string } }).node.id;
}

async function membershipMember(node: NodeProcess, auth: Session, token: string) {
  const response = await fetch(`${node.baseUrl}/api/cluster/node`, { headers: auth.headers });
  assert.equal(response.status, 200, node.output());
  return { ...(await response.json() as { node: Record<string, string> }).node, token };
}

async function waitForPeerAbsent(nodes: Array<{ node: NodeProcess; auth: Session }>, peerId: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const peers = await Promise.all(nodes.map(({ node, auth }) => peerList(node, auth)));
    if (peers.every((list) => !list.some((peer) => peer.id === peerId))) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Removed peer ${peerId} reappeared\n${nodes.map(({ node }) => node.output()).join("\n")}`);
}

async function waitForMesh(nodes: Array<{ node: NodeProcess; auth: Session }>): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const peers = await Promise.all(nodes.map(({ node, auth }) => peerList(node, auth)));
    if (peers.every((list) => list.length === 2)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Mesh did not converge\n${nodes.map(({ node }) => node.output()).join("\n")}`);
}

async function membershipDeliveryGeneration(dataDir: string, peerId: string): Promise<number> {
  const database = new DatabaseSync(path.join(dataDir, "node.db"));
  const delivery = database.prepare("SELECT generation FROM cluster_membership_deliveries WHERE peer_id = ?").get(peerId) as { generation: number };
  database.close();
  return delivery.generation;
}

async function waitForDelivered(dataDir: string, peerId: string, minimumGeneration = 0): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const database = new DatabaseSync(path.join(dataDir, "node.db"));
    const delivery = database.prepare("SELECT generation, delivered_at FROM cluster_membership_deliveries WHERE peer_id = ?").get(peerId) as { generation: number; delivered_at: string | null };
    database.close();
    if (delivery.generation >= minimumGeneration && delivery.delivered_at) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test("membership retry converges after an offline peer restarts", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-membership-retry-"));
  let a: NodeProcess | undefined;
  let b: NodeProcess | undefined;
  let c: NodeProcess | undefined;
  try {
    [a, b, c] = await Promise.all([
      startNode(root, "a", 19481),
      startNode(root, "b", 19482),
      startNode(root, "c", 19483),
    ]);
    const [aAuth, bAuth, cAuth] = await Promise.all([session(a), session(b), session(c)]);
    await Promise.all([configure(a, aAuth, "A"), configure(b, bAuth, "B"), configure(c, cAuth, "C")]);

    const [aToken, bToken, cToken] = await Promise.all([invite(a, aAuth), invite(b, bAuth), invite(c, cAuth)]);
    assert.equal((await pair(a, aAuth, b, bToken)).status, 201, `${a.output()}\n${b.output()}`);
    await stopNode(a);

    const pairWhileAOffline = await pair(b, bAuth, c, cToken);
    assert.equal(pairWhileAOffline.status, 201, `${b.output()}\n${c.output()}`);

    a = await startNode(root, "a", 19481);
    await waitForMesh([{ node: a, auth: aAuth }, { node: b, auth: bAuth }, { node: c, auth: cAuth }]);

    const aId = await nodeId(a, aAuth);
    assert(await waitForDelivered(b.dataDir, aId), "B did not persist A's membership delivery receipt");
    const bDeliveryGeneration = await membershipDeliveryGeneration(b.dataDir, aId);

    const cId = await nodeId(c, cAuth);
    const staleSnapshot = { members: await Promise.all([
      membershipMember(a, aAuth, aToken),
      membershipMember(b, bAuth, bToken),
      membershipMember(c, cAuth, cToken),
    ]) };
    const removed = await fetch(`${a.baseUrl}/api/cluster/peers/${cId}`, { method: "DELETE", headers: aAuth.headers });
    assert.equal(removed.status, 204, a.output());
    const revoked = await fetch(`${a.baseUrl}/api/cluster/node`, { headers: { Authorization: `Bearer ${aToken}` } });
    assert.equal(revoked.status, 401, a.output());
    await waitForPeerAbsent([{ node: a, auth: aAuth }, { node: b, auth: bAuth }], cId);
    assert.equal((await fetch(`${a.baseUrl}/api/cluster/node`, { headers: { Authorization: `Bearer ${aToken}` } })).status, 401, a.output());
    assert.equal((await fetch(`${b.baseUrl}/api/cluster/node`, { headers: { Authorization: `Bearer ${bToken}` } })).status, 401, b.output());

    const [freshAToken, freshBToken] = await Promise.all([invite(a, aAuth), invite(b, bAuth)]);
    assert.notEqual(freshAToken, aToken);
    assert.notEqual(freshBToken, bToken);
    assert.equal((await fetch(`${a.baseUrl}/api/cluster/node`, { headers: { Authorization: `Bearer ${freshAToken}` } })).status, 200, a.output());
    assert.equal((await fetch(`${b.baseUrl}/api/cluster/node`, { headers: { Authorization: `Bearer ${freshBToken}` } })).status, 200, b.output());
    assert(await waitForDelivered(b.dataDir, aId, bDeliveryGeneration + 1), "B did not authenticate its updated membership delivery to A");

    const staleSync = await fetch(`${a.baseUrl}/api/cluster/membership/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${freshAToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(staleSnapshot),
    });
    assert.equal(staleSync.status, 200, a.output());
    await waitForPeerAbsent([{ node: a, auth: aAuth }, { node: b, auth: bAuth }], cId);

    assert.equal((await pair(b, bAuth, c, cToken)).status, 201, `${b.output()}\n${c.output()}`);
    await waitForMesh([{ node: a, auth: aAuth }, { node: b, auth: bAuth }, { node: c, auth: cAuth }]);
  } finally {
    await Promise.all([a, b, c].filter((node): node is NodeProcess => Boolean(node)).map(stopNode));
    await rm(root, { recursive: true, force: true });
  }
});
