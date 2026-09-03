import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

interface StartedNode { baseUrl: string; child: ChildProcess; homeDir: string; output: () => string; }

async function jsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`${response.status} ${text}`); }
}

async function listen(server: Server): Promise<number> {
  return await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

async function fakeSyncthing(): Promise<{ server: Server; url: string }> {
  const folders: unknown[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/rest/config/folders") { response.end(JSON.stringify(folders)); return; }
      if (request.method === "POST" && request.url === "/rest/config/folders") { folders.push(JSON.parse(body)); response.end("{}"); return; }
      if (request.method === "GET" && request.url === "/rest/system/status") { response.end(JSON.stringify({ myID: "LOCAL" })); return; }
      if (request.method === "GET" && request.url?.startsWith("/rest/db/ignores?folder=")) { response.end(JSON.stringify({ ignore: [] })); return; }
      if (request.method === "POST" && request.url?.startsWith("/rest/db/ignores?folder=")) { response.end("{}"); return; }
      if (request.method === "GET" && request.url?.startsWith("/rest/db/status?folder=")) { response.end(JSON.stringify({ state: "idle", needTotalItems: 0, needBytes: 0 })); return; }
      response.statusCode = 404;
      response.end();
    });
  });
  return { server, url: `http://127.0.0.1:${await listen(server)}` };
}

async function startNode(root: string, syncthingUrl: string): Promise<StartedNode> {
  const homeDir = path.join(root, "home");
  await mkdir(homeDir, { recursive: true });
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."),
    env: { ...process.env, PORT: "0", HOME: homeDir, PI_WEB_DATA_DIR: path.join(root, "data"), MASTER_BOB_ADMIN_USERNAME: "admin", MASTER_BOB_INITIAL_PASSWORD: "initial-password", PI_MOBILE_WEB_SYNCTHING_URL: syncthingUrl, PI_MOBILE_WEB_SYNCTHING_API_KEY: "test-key" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    const match = output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/);
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

test("file resolution with a taskId resolves inside the ticket workspace", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ticket-file-resolution-"));
  const sync = await fakeSyncthing();
  let node: StartedNode | undefined;
  try {
    node = await startNode(root, sync.url);
    const headers = await session(node);
    const homePath = path.join(node.homeDir, "JointBob");
    await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        pi: { executable: "", configPath: "", sessionPath: "" },
        claude: { executable: "", configPath: "", sessionPath: "" },
        syncthing: { endpoint: "" },
        projects: { homePath },
      }),
    });

    const created = await fetch(`${node.baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Ticketed", type: "work", synced: true }) });
    assert.equal(created.status, 201, node.output());
    const project = (await created.json() as { project: { id: string; path: string } }).project;
    await mkdir(path.join(project.path, "backend"), { recursive: true });
    await mkdir(path.join(project.path, "docs"), { recursive: true });
    await writeFile(path.join(project.path, "backend", "test.secrets.yml"), "project version\n");
    await writeFile(path.join(project.path, "docs", "shared.md"), "project shared\n");

    const createdTask = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks`, { method: "POST", headers, body: JSON.stringify({ title: "Edit secrets", description: "" }) });
    assert.equal(createdTask.status, 201, node.output());
    const task = (await createdTask.json() as { task: { id: string; worktreePath: string } }).task;
    const workspaceSecrets = path.join(task.worktreePath, "backend", "test.secrets.yml");
    await writeFile(workspaceSecrets, "workspace version\n");
    await writeFile(path.join(task.worktreePath, "docs", "ticket-only.md"), "only in ticket\n");

    // Exact workspace-absolute path must resolve to workspace content, not the
    // same-named project file and not an ambiguity error.
    const resolved = await fetch(`${node.baseUrl}/api/projects/${project.id}/file-resolution?taskId=${task.id}&path=${encodeURIComponent(workspaceSecrets)}`, { headers });
    assert.equal(resolved.status, 200);
    const body = await jsonBody(resolved) as { path: string; viewUrl: string; downloadUrl: string; contentUrl: string };
    assert.equal(body.path, "backend/test.secrets.yml");
    for (const url of [body.viewUrl, body.downloadUrl, body.contentUrl]) {
      assert.match(url, new RegExp(`[?&]taskId=${task.id}(&|$)`), "returned links must keep the ticket scope");
    }
    const content = await fetch(`${node.baseUrl}${body.contentUrl}`, { headers });
    assert.equal(content.status, 200);
    assert.equal((await jsonBody(content) as { content: string }).content, "workspace version\n");

    // Fuzzy search with a taskId scans the workspace: a ticket-only file resolves,
    // while without a taskId the project has no such file.
    const ticketOnly = await fetch(`${node.baseUrl}/api/projects/${project.id}/file-resolution?taskId=${task.id}&path=ticket-only.md`, { headers });
    assert.equal(ticketOnly.status, 200);
    assert.equal((await jsonBody(ticketOnly) as { path: string }).path, "docs/ticket-only.md");
    const noTaskScope = await fetch(`${node.baseUrl}/api/projects/${project.id}/file-resolution?path=ticket-only.md`, { headers });
    assert.equal(noTaskScope.status, 404, "project root must stay the scope without a taskId");

    // The view link serves the workspace bytes (silent-wrong-file regression).
    const view = await fetch(`${node.baseUrl}${body.viewUrl}`, { headers });
    assert.equal(view.status, 200);
    assert.match(await view.text(), /workspace version/);

    // Unknown taskId is rejected, not silently treated as project scope.
    const badTask = await fetch(`${node.baseUrl}/api/projects/${project.id}/file-resolution?taskId=missing&path=${encodeURIComponent(workspaceSecrets)}`, { headers });
    assert.equal(badTask.status, 404);
  } finally {
    if (node) await stopNode(node);
    await sync.server.close();
    await rm(root, { recursive: true, force: true });
  }
});
