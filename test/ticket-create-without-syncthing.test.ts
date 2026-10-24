import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serverArgs } from "./server-entry.js";

interface StartedNode { baseUrl: string; child: ChildProcess; homeDir: string; output: () => string; }

// No Syncthing at all: no URL, no key, and a fresh HOME without a Syncthing config to discover.
async function startNode(root: string): Promise<StartedNode> {
  const homeDir = path.join(root, "home");
  await mkdir(homeDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0", HOME: homeDir, PI_WEB_DATA_DIR: path.join(root, "data"), MASTER_BOB_ADMIN_USERNAME: "admin", MASTER_BOB_INITIAL_PASSWORD: "initial-password" };
  for (const key of ["JOINT_BOB_SYNCTHING_URL", "JOINT_BOB_SYNCTHING_API_KEY", "PI_MOBILE_WEB_SYNCTHING_URL", "PI_MOBILE_WEB_SYNCTHING_API_KEY"]) delete env[key];
  let output = "";
  const child = spawn(process.execPath, serverArgs(process.env), { cwd: path.resolve("."), env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    const match = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match && (await fetch(`http://127.0.0.1:${match[1]}/api/health`)).ok) return { baseUrl: `http://127.0.0.1:${match[1]}`, child, homeDir, output: () => output };
    if (child.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(output);
}

async function stopNode(node: StartedNode): Promise<void> {
  if (node.child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => node.child.once("exit", () => resolve()));
  node.child.kill("SIGTERM");
  await exited;
}

async function session(node: StartedNode): Promise<Record<string, string>> {
  const login = await fetch(`${node.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
  const body = await login.json() as { csrfToken: string };
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error(node.output());
  const headers = { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" };
  await fetch(`${node.baseUrl}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) });
  return headers;
}

test("synced projects and tickets are created on a node without Syncthing", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-no-syncthing-"));
  let node: StartedNode | undefined;
  try {
    node = await startNode(root);
    const headers = await session(node);
    const homePath = path.join(node.homeDir, "JointBob");
    const saved = await fetch(`${node.baseUrl}/api/settings`, { method: "PUT", headers, body: JSON.stringify({ projects: { homePath } }) });
    assert.equal(saved.status, 200, node.output());

    const created = await fetch(`${node.baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Unsynced node", type: "personal", synced: true }) });
    assert.equal(created.status, 201, node.output());
    const project = (await created.json() as { project: { id: string; path: string; syncFolderId?: string } }).project;
    assert.ok(project.syncFolderId, "the project keeps its share identity for when Syncthing appears");
    await access(project.path);

    const listed = await fetch(`${node.baseUrl}/api/projects`, { headers });
    assert.equal(listed.status, 200, node.output());
    const listedProject = (await listed.json() as { projects: Array<{ id: string; syncStatus: { state: string; message?: string } }> }).projects.find((candidate) => candidate.id === project.id);
    assert.ok(listedProject, "the new project is listed");
    assert.deepEqual(listedProject.syncStatus, { state: "unavailable", remainingFiles: 0, remainingBytes: 0, message: "Syncthing is not configured on this node" });

    const ticket = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks`, { method: "POST", headers, body: JSON.stringify({ title: "Works offline", description: "" }) });
    assert.equal(ticket.status, 201, node.output());
    const task = (await ticket.json() as { task: { id: string; worktreePath: string | null } }).task;
    assert.equal(task.worktreePath, path.join(homePath, "tickets", project.id, task.id));
    await access(task.worktreePath);
    const tasks = await (await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks`, { headers })).json() as { tasks: Array<{ id: string }> };
    assert.ok(tasks.tasks.some((candidate) => candidate.id === task.id));
    assert.match(node.output(), /Syncthing folder for Unsynced node was not created: Syncthing is not configured on this node/);
  } finally {
    if (node) await stopNode(node);
    await rm(root, { recursive: true, force: true });
  }
});
