// End-to-end invitation flow with project selection: a fresh node joins through a
// one-time link, only the selected projects reach it, unselected projects are
// refused at the machine boundary, removal is reserved to the inviting node, and
// accepting a new invitation leaves the old cluster first.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { freePort } from "./dev-nodes.js";

interface NodeProcess {
  key: string;
  baseUrl: string;
  dataDir: string;
  child: ChildProcess;
  output: () => string;
}

interface Session {
  headers: Record<string, string>;
}

const runningNodes: NodeProcess[] = [];

async function startNode(root: string, key: string, port: number): Promise<NodeProcess> {
  const dataDir = path.join(root, key);
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOME: path.join(root, "home", key),
      PI_WEB_DATA_DIR: dataDir,
      MASTER_BOB_ADMIN_USERNAME: "admin",
      MASTER_BOB_INITIAL_PASSWORD: "initial-password",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const node = { key, baseUrl: `http://127.0.0.1:${port}`, dataDir, child, output: () => output };
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${key} exited during startup (${child.exitCode})\n${output}`);
    try {
      if ((await fetch(`${node.baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) })).ok) return node;
    } catch {
      // The child has not started accepting requests yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGTERM");
  throw new Error(`${key} did not become healthy\n${output}`);
}

async function stopNode(node: NodeProcess): Promise<void> {
  if (node.child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => node.child.once("exit", () => resolve()));
  node.child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (node.child.exitCode !== null) return;
  node.child.kill("SIGKILL");
  await exited;
}

async function signIn(node: NodeProcess): Promise<Session> {
  const response = await fetch(`${node.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "initial-password" }),
  });
  assert.equal(response.status, 200, node.output());
  const body = await response.json() as { csrfToken: string };
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
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

async function api<T>(node: NodeProcess, auth: Session, method: string, endpoint: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${node.baseUrl}/api${endpoint}`, {
    method,
    headers: auth.headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as T };
}

async function machineToken(node: NodeProcess, auth: Session): Promise<string> {
  const { body } = await api<{ token: string }>(node, auth, "GET", "/cluster/invite");
  return body.token;
}

async function createProject(node: NodeProcess, auth: Session, name: string): Promise<string> {
  const created = await api<{ project: { id: string } }>(node, auth, "POST", "/projects", { name });
  assert.equal(created.status, 201, `${node.output()}\n${JSON.stringify(created.body)}`);
  return created.body.project.id;
}

async function projectNames(node: NodeProcess, auth: Session): Promise<string[]> {
  const { body } = await api<{ projects: Array<{ name: string }> }>(node, auth, "GET", "/projects?syncStatus=false");
  return body.projects.map((project) => project.name).sort();
}

async function joinCluster(node: NodeProcess, auth: Session, link: string): Promise<number> {
  const response = await fetch(`${node.baseUrl}/api/cluster/join`, {
    method: "POST",
    headers: auth.headers,
    body: JSON.stringify({ name: node.key.toUpperCase(), url: node.baseUrl, link }),
  });
  if (response.status >= 400) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(`join on ${node.key} failed ${response.status}: ${body.error ?? "unknown"}\n${runningNodes.map((entry) => entry.output()).join("\n")}`);
  }
  await response.json().catch(() => undefined);
  return response.status;
}

async function peerCount(node: NodeProcess, auth: Session): Promise<number> {
  const { body } = await api<{ peers: unknown[] }>(node, auth, "GET", "/cluster/peers");
  return body.peers.length;
}

test("invitations share only the selected projects and gate the machine boundary", { timeout: 240_000, signal: AbortSignal.timeout(240_000).signal }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-invite-projects-"));
  const nodes: NodeProcess[] = [];
  try {
    const [portA, portB, portC] = await Promise.all([freePort(), freePort(), freePort()]);
    const [a, b, c] = await Promise.all([startNode(root, "a", portA), startNode(root, "b", portB), startNode(root, "c", portC)]);
    nodes.push(a, b, c);
    runningNodes.push(a, b, c);
    const [aAuth, bAuth, cAuth] = await Promise.all([signIn(a), signIn(b), signIn(c)]);
    for (const [node, auth] of [[a, aAuth], [b, bAuth], [c, cAuth]] as const) {
      const configured = await api(node, auth, "PUT", "/cluster/node", { name: node.key.toUpperCase(), url: node.baseUrl });
      assert.equal(configured.status, 200, node.output());
    }

    const alpha = await createProject(a, aAuth, "Alpha");
    const beta = await createProject(a, aAuth, "Beta");

    // An invitation that shares only Alpha.
    const invited = await api<{ link: string; projectIds: string[] }>(a, aAuth, "POST", "/cluster/invitations", { projectIds: [alpha] });
    assert.equal(invited.status, 201, a.output());
    assert.deepEqual(invited.body.projectIds, [alpha]);

    // Unknown or duplicate selections are refused server-side.
    assert.equal((await api(a, aAuth, "POST", "/cluster/invitations", { projectIds: ["not-a-project"] })).status, 400);
    assert.equal((await api(a, aAuth, "POST", "/cluster/invitations", { projectIds: [alpha, alpha] })).status, 400);
    assert.equal((await api(a, aAuth, "POST", "/cluster/invitations", { projectIds: [] })).status, 400);

    assert.equal(await joinCluster(b, bAuth, invited.body.link), 201, b.output());
    assert.deepEqual(await projectNames(b, bAuth), ["Alpha"], "only the invited project arrived on the joining node");

    // A's own inventory, asked with B's machine identity, hides Beta.
    const bToken = await machineToken(b, bAuth);
    const inventoryForB = await fetch(`${a.baseUrl}/api/cluster/local-inventory`, { headers: { Authorization: `Bearer ${bToken}` } });
    assert.equal(inventoryForB.status, 200, a.output());
    const inventory = await inventoryForB.json() as { projects: Array<{ project: { id: string } }> };
    assert.deepEqual(inventory.projects.map((entry) => entry.project.id), [alpha]);

    // Machine routes that name the unshared project are refused for B.
    const taskRouted = await fetch(`${a.baseUrl}/api/cluster/tasks/update`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${bToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: beta, taskId: "task-x", update: {} }),
    });
    assert.equal(taskRouted.status, 403, "unshared project task route must be refused");
    const aNodeId = ((await api<{ node: { id: string } }>(a, aAuth, "GET", "/cluster/node")).body.node.id);
    const mapRouted = await fetch(`${a.baseUrl}/api/cluster/projects/map`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ peerId: aNodeId, projectId: beta, localPath: path.join(root, "home", "b", "beta") }),
    });
    assert.equal(mapRouted.status, 403, "mapping an unshared project must be refused");

    // C joins through B, so only B (C's inviter) may remove it.
    const bInvited = await api<{ link: string }>(b, bAuth, "POST", "/cluster/invitations", { projectIds: [alpha] });
    assert.equal(bInvited.status, 201, b.output());
    assert.equal(await joinCluster(c, cAuth, bInvited.body.link), 201, c.output());
    assert.deepEqual(await projectNames(c, cAuth), ["Alpha"]);

    const cNodeId = ((await api<{ node: { id: string } }>(c, cAuth, "GET", "/cluster/node")).body.node.id);
    // A learns about C through B's membership deliveries; wait for the mesh to converge.
    const knowsC = async (): Promise<boolean> => (await api<{ peers: Array<{ id: string }> }>(a, aAuth, "GET", "/cluster/peers")).body.peers.some((peer) => peer.id === cNodeId);
    const meshDeadline = Date.now() + 30_000;
    while (Date.now() < meshDeadline && !(await knowsC())) await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(await knowsC(), `A never learned about C\n${a.output()}`);
    const removedByStranger = await api(a, aAuth, "DELETE", `/cluster/peers/${cNodeId}`);
    assert.equal(removedByStranger.status, 403, "a node that did not create C's invitation cannot remove it");

    const removedByInviter = await api(b, bAuth, "DELETE", `/cluster/peers/${cNodeId}`);
    assert.equal(removedByInviter.status, 204, b.output());
    const cPeerDeadline = Date.now() + 20_000;
    while (Date.now() < cPeerDeadline && await peerCount(c, cAuth) > 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(await peerCount(c, cAuth), 0, "the dropped node cleared its own cluster state");

    // Accepting a new invitation leaves the current cluster first and replaces the
    // project selection: B now sees Beta instead of Alpha from A.
    const reinvited = await api<{ link: string }>(a, aAuth, "POST", "/cluster/invitations", { projectIds: [beta] });
    assert.equal(reinvited.status, 201, a.output());
    assert.equal(await joinCluster(b, bAuth, reinvited.body.link), 201, b.output());
    assert.equal(await peerCount(b, bAuth), 1, "rejoining replaced the membership instead of growing it");
    assert.ok((await projectNames(b, bAuth)).includes("Beta"), "the new invitation's project arrived");

    const bTokenAfterRejoin = await machineToken(b, bAuth);
    const inventoryAfterRejoin = await fetch(`${a.baseUrl}/api/cluster/local-inventory`, { headers: { Authorization: `Bearer ${bTokenAfterRejoin}` } });
    const filtered = await inventoryAfterRejoin.json() as { projects: Array<{ project: { id: string } }> };
    assert.deepEqual(filtered.projects.map((entry) => entry.project.id), [beta], "A now hides Alpha from B");

    // A broken preflight never tears down the current cluster.
    assert.equal(await peerCount(b, bAuth), 1);
    const invitationUrl = new URL(reinvited.body.link);
    const badLink = `${invitationUrl.origin}/join#00000000-0000-4000-8000-000000000000.${"A".repeat(43)}`;
    const failedJoin = await fetch(`${b.baseUrl}/api/cluster/join`, {
      method: "POST",
      headers: bAuth.headers,
      body: JSON.stringify({ name: "B", url: b.baseUrl, link: badLink }),
    });
    assert.equal(failedJoin.status, 401, `bad link should be refused, got ${failedJoin.status}\n${b.output()}`);
    assert.equal(await peerCount(b, bAuth), 1, "a refused join keeps the current cluster");
  } finally {
    await Promise.all(nodes.map((node) => stopNode(node)));
    await rm(root, { recursive: true, force: true });
  }
});
