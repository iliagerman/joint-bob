import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

interface NodeProcess {
  baseUrl: string;
  child: ChildProcess;
  homeDir: string;
  output: () => string;
}

interface Session {
  headers: Record<string, string>;
}

async function startNode(root: string, name: string): Promise<NodeProcess> {
  const homeDir = path.join(root, `${name}-home`);
  await mkdir(homeDir, { recursive: true });
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."),
    env: {
      ...process.env, PORT: "0", HOME: homeDir, PI_WEB_DATA_DIR: path.join(root, `${name}-data`),
      MASTER_BOB_ADMIN_USERNAME: "admin", MASTER_BOB_INITIAL_PASSWORD: "initial-password",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${name} exited during startup (${child.exitCode})\n${output}`);
    const portMatch = output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/);
    if (portMatch) {
      const node = { baseUrl: `http://127.0.0.1:${portMatch[1]}`, child, homeDir, output: () => output };
      try {
        if ((await fetch(`${node.baseUrl}/api/health`)).ok) return node;
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
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (node.child.exitCode === null) node.child.kill("SIGKILL");
}

async function session(node: NodeProcess): Promise<Session> {
  const login = await fetch(`${node.baseUrl}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }),
  });
  assert.equal(login.status, 200, node.output());
  const body = await login.json() as { csrfToken: string };
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error(`Missing cookie\n${node.output()}`);
  const headers = { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" };
  const changed = await fetch(`${node.baseUrl}/api/auth/change-password`, {
    method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }),
  });
  assert.equal(changed.status, 204, node.output());
  return { headers };
}

async function configure(node: NodeProcess, auth: Session, name: string): Promise<void> {
  const response = await fetch(`${node.baseUrl}/api/cluster/node`, {
    method: "PUT", headers: auth.headers, body: JSON.stringify({ name, url: node.baseUrl }),
  });
  assert.equal(response.status, 200, node.output());
}

async function invite(node: NodeProcess, auth: Session): Promise<string> {
  const response = await fetch(`${node.baseUrl}/api/cluster/invite`, { headers: auth.headers });
  assert.equal(response.status, 200, node.output());
  return (await response.json() as { token: string }).token;
}

async function pair(source: NodeProcess, auth: Session, target: NodeProcess, token: string): Promise<void> {
  const response = await fetch(`${source.baseUrl}/api/cluster/peers`, {
    method: "POST", headers: auth.headers, body: JSON.stringify({ url: target.baseUrl, token }),
  });
  assert.equal(response.status, 201, `${source.output()}\n${target.output()}`);
}

async function saveProjectHome(node: NodeProcess, auth: Session, homePath: string): Promise<void> {
  const response = await fetch(`${node.baseUrl}/api/settings`, {
    method: "PUT",
    headers: auth.headers,
    body: JSON.stringify({
      pi: { executable: "", configPath: "", sessionPath: "" },
      claude: { executable: "", configPath: "", sessionPath: "" },
      syncthing: { endpoint: "" },
      projects: { homePath },
    }),
  });
  assert.equal(response.status, 200, node.output());
}

async function waitForName(node: NodeProcess, auth: Session, projectId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${node.baseUrl}/api/projects`, { headers: auth.headers });
    assert.equal(response.status, 200, node.output());
    const projects = (await response.json() as { projects: Array<{ id: string; name: string }> }).projects;
    if (projects.find((project) => project.id === projectId)?.name === "Replicated name") return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Project name did not replicate\n${node.output()}`);
}

test("managed homes auto-map peer projects by type and name", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-auto-map-"));
  const nodes: NodeProcess[] = [];
  try {
    const [source, destination] = await Promise.all([startNode(root, "source"), startNode(root, "destination")]);
    nodes.push(source, destination);
    const [sourceAuth, destinationAuth] = await Promise.all([session(source), session(destination)]);
    await Promise.all([configure(source, sourceAuth, "Source"), configure(destination, destinationAuth, "Destination")]);
    await pair(source, sourceAuth, destination, await invite(destination, destinationAuth));

    const sourceHome = path.join(source.homeDir, "JointBob");
    const destinationHome = path.join(destination.homeDir, "JointBob");
    await Promise.all([saveProjectHome(source, sourceAuth, sourceHome), saveProjectHome(destination, destinationAuth, destinationHome)]);

    const created = await fetch(`${source.baseUrl}/api/projects`, {
      method: "POST",
      headers: sourceAuth.headers,
      body: JSON.stringify({ name: "demo", type: "personal" }),
    });
    assert.equal(created.status, 201, source.output());
    const projectId = (await created.json() as { project: { id: string } }).project.id;

    const discovered = await fetch(`${destination.baseUrl}/api/cluster/projects/discover`, { method: "POST", headers: destinationAuth.headers });
    assert.equal(discovered.status, 200, destination.output());
    const result = await discovered.json() as { imported: string[]; pending: unknown[] };
    assert.deepEqual(result.pending, []);
    assert.deepEqual(result.imported, ["demo"]);

    const projects = (await (await fetch(`${destination.baseUrl}/api/projects`, { headers: destinationAuth.headers })).json() as { projects: Array<{ id: string; path: string }> }).projects;
    assert.equal(projects.find((project) => project.id === projectId)?.path, path.join(destinationHome, "personal", "demo"));

    const destinationId = (await (await fetch(`${destination.baseUrl}/api/cluster/node`, { headers: destinationAuth.headers })).json() as { node: { id: string } }).node.id;
    const sessionNodes = await fetch(`${source.baseUrl}/api/projects/${projectId}/session-nodes`, { headers: sourceAuth.headers });
    assert.equal(sessionNodes.status, 200, source.output());
    assert.equal((await sessionNodes.json() as { nodes: Array<{ id: string; mapped: boolean }> }).nodes.find((node) => node.id === destinationId)?.mapped, true);

    const sourcePort = new URL(source.baseUrl).port;
    const socket = new WebSocket(`ws://127.0.0.1:${sourcePort}/ws?projectId=${projectId}&sessionPath=watch&nodeId=${destinationId}`, {
      origin: source.baseUrl,
      headers: { Cookie: sourceAuth.headers.Cookie },
    });
    const routedMessage = await new Promise<unknown>((resolve, reject) => {
      socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
      socket.once("error", reject);
    });
    assert.deepEqual(routedMessage, { type: "watchReady" });
    socket.close();
  } finally {
    await Promise.all(nodes.map(stopNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("project name override converges across paired process-isolated nodes", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-replication-mesh-"));
  const nodes: NodeProcess[] = [];
  try {
    const [a, b] = await Promise.all([startNode(root, "a"), startNode(root, "b")]);
    nodes.push(a, b);
    const [aAuth, bAuth] = await Promise.all([session(a), session(b)]);
    await Promise.all([configure(a, aAuth, "A"), configure(b, bAuth, "B")]);
    await pair(a, aAuth, b, await invite(b, bAuth));

    const aHome = path.join(a.homeDir, "JointBob");
    const bHome = path.join(b.homeDir, "JointBob");
    await Promise.all([saveProjectHome(a, aAuth, aHome), saveProjectHome(b, bAuth, bHome)]);

    const created = await fetch(`${a.baseUrl}/api/projects`, {
      method: "POST", headers: aAuth.headers, body: JSON.stringify({ name: "shared", type: "personal" }),
    });
    assert.equal(created.status, 201, a.output());
    const project = (await created.json() as { project: { id: string } }).project;
    const aNode = await fetch(`${a.baseUrl}/api/cluster/node`, { headers: aAuth.headers });
    assert.equal(aNode.status, 200, a.output());
    const aId = (await aNode.json() as { node: { id: string } }).node.id;

    const imported = await fetch(`${b.baseUrl}/api/cluster/projects/import`, {
      method: "POST", headers: bAuth.headers, body: JSON.stringify({ peerId: aId }),
    });
    assert.equal(imported.status, 200, b.output());
    const importedBody = await imported.json() as { imported: string[]; pending: unknown[] };
    assert.deepEqual(importedBody.pending, []);
    assert.deepEqual(importedBody.imported, ["shared"]);

    const renamed = await fetch(`${a.baseUrl}/api/projects/${project.id}`, {
      method: "PATCH", headers: aAuth.headers, body: JSON.stringify({ name: "Replicated name" }),
    });
    assert.equal(renamed.status, 200, a.output());
    await waitForName(b, bAuth, project.id);
  } finally {
    await Promise.all(nodes.map(stopNode));
    await rm(root, { recursive: true, force: true });
  }
});
