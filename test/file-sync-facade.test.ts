import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type RequestListener } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { projectTicketSyncFolderId } from "../src/task-workspaces.js";
import type { ProjectRecord } from "../src/types.js";
import { projectWorktreeSyncFolderId } from "../src/worktree-filters.js";
import { serverArgs } from "./server-entry.js";

const syncthingKeys = ["JOINT_BOB_SYNCTHING_URL", "JOINT_BOB_SYNCTHING_API_KEY", "PI_MOBILE_WEB_SYNCTHING_URL", "PI_MOBILE_WEB_SYNCTHING_API_KEY"];

async function listen(handler: RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("a handoff readiness check only reads folder status and never rewrites ignore rules", async () => {
  const requests: string[] = [];
  let status: Record<string, unknown> = { state: "idle", needTotalItems: 0, needBytes: 0, errors: 0 };
  const fake = await listen((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url?.startsWith("/rest/db/status?folder=")) { response.end(JSON.stringify(status)); return; }
    if (request.url?.startsWith("/rest/db/ignores?")) { response.end(JSON.stringify({ ignore: [] })); return; }
    response.statusCode = 404;
    response.end();
  });
  const previous = Object.fromEntries(syncthingKeys.map((key) => [key, process.env[key]]));
  for (const key of syncthingKeys) delete process.env[key];
  process.env.JOINT_BOB_SYNCTHING_URL = fake.url;
  process.env.JOINT_BOB_SYNCTHING_API_KEY = "test-key";
  try {
    const { assertProjectFilesReady } = await import("../src/file-sync/facade.js");
    const project: ProjectRecord = { id: "project-1", name: "Demo", path: "/tmp/demo", syncFolderId: "folder-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    await assertProjectFilesReady(project, "project");
    await assertProjectFilesReady(project, "tickets");
    assert.deepEqual(requests, ["GET /rest/db/status?folder=folder-1", `GET /rest/db/status?folder=${projectTicketSyncFolderId(project.id)}`]);

    status = { state: "syncing", needTotalItems: 2, needBytes: 10, errors: 0 };
    await assert.rejects(assertProjectFilesReady(project, "project"), { message: "Syncthing folder is not synchronized on this node" });

    requests.length = 0;
    await assertProjectFilesReady({ ...project, syncFolderId: undefined }, "project");
    assert.deepEqual(requests, [], "a project without a folder has nothing to wait for");
  } finally {
    for (const key of syncthingKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fake.close();
  }
});

interface StartedNode { baseUrl: string; child: ChildProcess; output: () => string }

async function startNode(root: string, syncthingUrl: string): Promise<StartedNode> {
  const homeDir = path.join(root, "home");
  await mkdir(homeDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0", HOME: homeDir, PI_WEB_DATA_DIR: path.join(root, "data"), MASTER_BOB_ADMIN_USERNAME: "admin", MASTER_BOB_INITIAL_PASSWORD: "initial-password" };
  for (const key of syncthingKeys) delete env[key];
  env.JOINT_BOB_SYNCTHING_URL = syncthingUrl;
  env.JOINT_BOB_SYNCTHING_API_KEY = "test-key";
  let output = "";
  const child = spawn(process.execPath, serverArgs(process.env), { cwd: path.resolve("."), env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    const match = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match && (await fetch(`http://127.0.0.1:${match[1]}/api/health`)).ok) return { baseUrl: `http://127.0.0.1:${match[1]}`, child, output: () => output };
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

test("a project rescan covers its ticket and worktree folders when Syncthing has them", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-facade-rescan-"));
  const folders: Array<{ id: string; label: string; path: string; type: string; devices: Array<{ deviceID: string }> }> = [];
  const scans: string[] = [];
  const fake = await listen((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const url = request.url ?? "";
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && url === "/rest/config/folders") { response.end(JSON.stringify(folders)); return; }
      if (request.method === "POST" && url === "/rest/config/folders") { folders.push(JSON.parse(body)); response.end("{}"); return; }
      if (request.method === "GET" && url === "/rest/system/status") { response.end(JSON.stringify({ myID: "LOCAL" })); return; }
      if (url.startsWith("/rest/db/ignores?")) { response.end(request.method === "GET" ? JSON.stringify({ ignore: [] }) : "{}"); return; }
      if (request.method === "GET" && url.startsWith("/rest/db/status?")) { response.end(JSON.stringify({ state: "idle", needTotalItems: 0, needBytes: 0, errors: 0 })); return; }
      if (request.method === "POST" && url.startsWith("/rest/db/scan?folder=")) { scans.push(decodeURIComponent(url.slice("/rest/db/scan?folder=".length))); response.end(); return; }
      response.statusCode = 404;
      response.end();
    });
  });
  let node: StartedNode | undefined;
  try {
    node = await startNode(root, fake.url);
    const headers = await session(node);
    const created = await fetch(`${node.baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Shared", type: "personal", synced: true }) });
    assert.equal(created.status, 201, node.output());
    const project = (await created.json() as { project: { id: string; syncFolderId: string } }).project;
    const rescan = (id: string) => fetch(`${node!.baseUrl}/api/projects/${id}/sync/rescan`, { method: "POST", headers });

    // Without peers this node has no ticket or worktree folder, so only the project folder is scanned.
    scans.length = 0;
    let answer = await rescan(project.id);
    assert.equal(answer.status, 200, node.output());
    assert.deepEqual(await answer.json(), { ok: true });
    assert.deepEqual(scans, [project.syncFolderId]);

    const tickets = projectTicketSyncFolderId(project.id), worktrees = projectWorktreeSyncFolderId(project.id);
    for (const id of [tickets, worktrees]) folders.push({ id, label: id, path: path.join(root, id), type: "sendreceive", devices: [] });
    scans.length = 0;
    answer = await rescan(project.id);
    assert.equal(answer.status, 200, node.output());
    assert.deepEqual(scans.sort(), [project.syncFolderId, tickets, worktrees].sort());

    const local = await fetch(`${node.baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Local only", type: "personal", synced: false }) });
    assert.equal(local.status, 201, node.output());
    scans.length = 0;
    answer = await rescan((await local.json() as { project: { id: string } }).project.id);
    assert.equal(answer.status, 409);
    assert.deepEqual(await answer.json(), { error: "Project is not synchronized with Syncthing" });
    assert.deepEqual(scans, []);
  } finally {
    if (node) await stopNode(node);
    await fake.close();
    await rm(root, { recursive: true, force: true });
  }
});
