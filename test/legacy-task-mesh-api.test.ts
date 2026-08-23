import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

interface NodeProcess { baseUrl: string; child: ChildProcess; homeDir: string; output: () => string; }
interface Session { headers: Record<string, string>; }

async function startNode(root: string, name: string): Promise<NodeProcess> {
  const homeDir = path.join(root, `${name}-home`);
  await mkdir(homeDir, { recursive: true });
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: path.resolve("."), env: { ...process.env, PORT: "0", HOME: homeDir, PI_WEB_DATA_DIR: path.join(root, `${name}-data`), MASTER_BOB_ADMIN_USERNAME: "admin", MASTER_BOB_INITIAL_PASSWORD: "initial-password" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${name} exited during startup (${child.exitCode})\n${output}`);
    const match = output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/);
    if (match && (await fetch(`http://127.0.0.1:${match[1]}/api/health`)).ok) return { baseUrl: `http://127.0.0.1:${match[1]}`, child, homeDir, output: () => output };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGTERM");
  throw new Error(`${name} did not become healthy\n${output}`);
}

async function stopNode(node: NodeProcess): Promise<void> {
  if (node.child.exitCode !== null) return;
  node.child.kill("SIGKILL");
  await new Promise<void>((resolve) => node.child.once("exit", () => resolve()));
}

async function login(node: NodeProcess): Promise<Session> {
  const response = await fetch(`${node.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
  const body = await response.json() as { csrfToken: string };
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error(node.output());
  const headers = { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" };
  assert.equal((await fetch(`${node.baseUrl}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) })).status, 204);
  return { headers };
}

async function waitForTask(node: NodeProcess, auth: Session, projectId: string, taskId: string): Promise<{ title: string; status: string }> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(`${node.baseUrl}/api/projects/${projectId}/tasks`, { headers: auth.headers });
    const task = (await response.json() as { tasks: Array<{ id: string; title: string; status: string }> }).tasks.find((candidate) => candidate.id === taskId);
    if (task) return task;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(node.output());
}

test("a legacy task reaches a mapped peer without an edit", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-legacy-task-mesh-"));
  const nodes: NodeProcess[] = [];
  const projectId = "legacy-project";
  const taskId = "legacy-task";
  const projectPath = path.join(root, "a-project");
  try {
    const dataDir = path.join(root, "a-data");
    await mkdir(path.join(dataDir, "tasks"), { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await writeFile(path.join(dataDir, "projects.json"), JSON.stringify({ projects: [{ id: projectId, name: "Legacy project", path: projectPath, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }] }));
    await writeFile(path.join(dataDir, "tasks", `${projectId}.json`), JSON.stringify({ tasks: [{ id: taskId, title: "Legacy title", description: "Legacy description", status: "done", engine: "pi", planMode: false, reviewMode: false, phaseConfig: {}, sessionPath: null, worktreePath: null, worktreeBranch: null, mergedAt: null, currentNodeId: "legacy-current", leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, originNodeId: "legacy-origin", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }] }));
    const [a, b] = await Promise.all([startNode(root, "a"), startNode(root, "b")]);
    nodes.push(a, b);
    const [aAuth, bAuth] = await Promise.all([login(a), login(b)]);
    for (const [node, auth, name] of [[a, aAuth, "A"], [b, bAuth, "B"]] as const) assert.equal((await fetch(`${node.baseUrl}/api/cluster/node`, { method: "PUT", headers: auth.headers, body: JSON.stringify({ name, url: node.baseUrl }) })).status, 200);
    const bToken = (await (await fetch(`${b.baseUrl}/api/cluster/invite`, { headers: bAuth.headers })).json() as { token: string }).token;
    assert.equal((await fetch(`${a.baseUrl}/api/cluster/peers`, { method: "POST", headers: aAuth.headers, body: JSON.stringify({ url: b.baseUrl, token: bToken }) })).status, 201, a.output());
    const aId = (await (await fetch(`${a.baseUrl}/api/cluster/node`, { headers: aAuth.headers })).json() as { node: { id: string } }).node.id;
    assert.equal((await fetch(`${b.baseUrl}/api/cluster/projects/import`, { method: "POST", headers: bAuth.headers, body: JSON.stringify({ peerId: aId }) })).status, 200, b.output());
    const mapped = await fetch(`${b.baseUrl}/api/cluster/projects/map`, { method: "POST", headers: bAuth.headers, body: JSON.stringify({ peerId: aId, projectId, localPath: path.join(b.homeDir, "project") }) });
    assert.equal(mapped.status, 201, b.output());
    assert.equal((await fetch(`${a.baseUrl}/api/cluster/local-inventory`, { headers: aAuth.headers })).status, 200, a.output());
    const replicated = await waitForTask(b, bAuth, projectId, taskId);
    assert.equal(replicated.title, "Legacy title");
    assert.equal(replicated.status, "done");
  } finally {
    await Promise.all(nodes.map(stopNode));
    await rm(root, { recursive: true, force: true });
  }
});
