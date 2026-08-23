import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

interface NodeProcess { baseUrl: string; child: ChildProcess; dataDir: string; homeDir: string; output: () => string; }
interface Session { headers: Record<string, string>; }

async function startNode(root: string, name: string): Promise<NodeProcess> {
  const homeDir = path.join(root, `${name}-home`);
  const dataDir = path.join(root, `${name}-data`);
  await mkdir(homeDir, { recursive: true });
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: path.resolve("."), env: { ...process.env, PORT: "0", HOME: homeDir, PI_WEB_DATA_DIR: dataDir, MASTER_BOB_ADMIN_USERNAME: "admin", MASTER_BOB_INITIAL_PASSWORD: "initial-password" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const port = output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/)?.[1];
    if (child.exitCode !== null) throw new Error(output);
    if (port) {
      const node = { baseUrl: `http://127.0.0.1:${port}`, child, dataDir, homeDir, output: () => output };
      if ((await fetch(`${node.baseUrl}/api/health`)).ok) return node;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(output);
}

async function stopNode(node: NodeProcess): Promise<void> {
  if (node.child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => node.child.once("exit", () => resolve()));
  node.child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (node.child.exitCode === null) node.child.kill("SIGKILL");
}

async function login(node: NodeProcess): Promise<Session> {
  const response = await fetch(`${node.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
  assert.equal(response.status, 200, node.output());
  const body = await response.json() as { csrfToken: string };
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error(node.output());
  const headers = { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" };
  assert.equal((await fetch(`${node.baseUrl}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) })).status, 204, node.output());
  return { headers };
}

async function waitFor<T>(node: NodeProcess, action: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const value = await action();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(node.output());
}

test("authenticated GitHub credential mesh never exposes tokens", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-github-auth-mesh-"));
  const nodes: NodeProcess[] = [];
  try {
    const [a, b] = await Promise.all([startNode(root, "a"), startNode(root, "b")]);
    nodes.push(a, b);
    const [aAuth, bAuth] = await Promise.all([login(a), login(b)]);
    for (const [node, auth, name] of [[a, aAuth, "A"], [b, bAuth, "B"]] as const) {
      assert.equal((await fetch(`${node.baseUrl}/api/cluster/node`, { method: "PUT", headers: auth.headers, body: JSON.stringify({ name, url: node.baseUrl }) })).status, 200, node.output());
    }
    const projects = await Promise.all([[a, aAuth], [b, bAuth]].map(async ([node, auth]) => {
      const response = await fetch(`${node.baseUrl}/api/projects`, { method: "POST", headers: auth.headers, body: JSON.stringify({ name: "shared", path: path.join(node.homeDir, "shared") }) });
      assert.equal(response.status, 201, node.output());
      return (await response.json() as { project: { id: string } }).project;
    }));
    for (const [node, project] of [[a, projects[0]], [b, projects[1]]] as const) {
      const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
      db.prepare("UPDATE projects SET sync_folder_id = 'github-auth-shared' WHERE id = ?").run(project.id);
      db.close();
    }
    const invite = await fetch(`${b.baseUrl}/api/cluster/invite`, { headers: bAuth.headers });
    const token = (await invite.json() as { token: string }).token;
    assert.equal((await fetch(`${a.baseUrl}/api/cluster/peers`, { method: "POST", headers: aAuth.headers, body: JSON.stringify({ url: b.baseUrl, token }) })).status, 201, `${a.output()}\n${b.output()}`);

    const accountToken = "mesh-account-token";
    const account = await fetch(`${a.baseUrl}/api/github-auth/groups`, { method: "POST", headers: aAuth.headers, body: JSON.stringify({ label: "Personal", token: accountToken }) });
    assert.equal(account.status, 201, a.output());
    assert.doesNotMatch(JSON.stringify(await account.json()), /mesh-account-token/);
    await waitFor(b, async () => {
      const response = await fetch(`${b.baseUrl}/api/github-auth`, { headers: bAuth.headers });
      const body = await response.text();
      assert.doesNotMatch(body, /mesh-account-token/);
      return (JSON.parse(body) as { groups: Array<{ id: string }> }).groups.some((group) => group.id === "personal") ? true : undefined;
    });

    const projectToken = "mesh-project-token";
    const saved = await fetch(`${b.baseUrl}/api/projects/${projects[1].id}/github-auth`, { method: "PUT", headers: bAuth.headers, body: JSON.stringify({ group: "sela", token: projectToken }) });
    assert.equal(saved.status, 200, b.output());
    assert.doesNotMatch(JSON.stringify(await saved.json()), /mesh-project-token/);
    await waitFor(a, async () => {
      const response = await fetch(`${a.baseUrl}/api/projects/${projects[0].id}/github-auth`, { headers: aAuth.headers });
      const body = await response.text();
      assert.doesNotMatch(body, /mesh-project-token/);
      const status = JSON.parse(body) as { project?: { group: string; configured: boolean } };
      return status.project?.group === "sela" && status.project.configured ? status : undefined;
    });

    assert.equal((await fetch(`${b.baseUrl}/api/projects/${projects[1].id}/github-auth`, { method: "PUT", headers: bAuth.headers, body: JSON.stringify({ group: null, token: null }) })).status, 200, b.output());
    assert.equal((await fetch(`${a.baseUrl}/api/github-auth/groups/personal`, { method: "DELETE", headers: aAuth.headers })).status, 200, a.output());
    await waitFor(b, async () => (await (await fetch(`${b.baseUrl}/api/github-auth`, { headers: bAuth.headers })).json() as { groups: Array<{ id: string }> }).groups.some((group) => group.id === "personal") ? undefined : true);
    await waitFor(a, async () => {
      const status = await (await fetch(`${a.baseUrl}/api/projects/${projects[0].id}/github-auth`, { headers: aAuth.headers })).json() as { project?: { configured: boolean } };
      return status.project?.configured ? undefined : true;
    });
    assert.equal((await fetch(`${a.baseUrl}/api/cluster/github/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events: [] }) })).status, 401);

    for (const node of nodes) {
      const bytes = (await readFile(path.join(node.dataDir, "node.db"))).toString("utf8");
      assert.doesNotMatch(bytes, /mesh-account-token|mesh-project-token/);
    }
  } finally {
    await Promise.all(nodes.map(stopNode));
    await rm(root, { recursive: true, force: true });
  }
});
