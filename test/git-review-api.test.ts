import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface StartedNode { baseUrl: string; child: ChildProcess; homeDir: string; output: () => string; }

async function gitCmd(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

async function jsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try { return JSON.parse(text); } catch { throw new Error(`${response.status} ${text}`); }
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

test("git review endpoints report status, diff, history, and commit for a project repository", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-git-review-api-"));
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

    const created = await fetch(`${node.baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Reviewable", type: "work", synced: true }) });
    assert.equal(created.status, 201, node.output());
    const project = (await created.json() as { project: { id: string; path: string } }).project;

    // Make the project a real git repository with one commit and a pending change.
    await gitCmd(project.path, ["init", "-b", "main"]);
    await writeFile(path.join(project.path, "app.ts"), "export const value = 1;\n");
    await gitCmd(project.path, ["add", "."]);
    await gitCmd(project.path, ["commit", "-m", "initial commit"]);
    await writeFile(path.join(project.path, "app.ts"), "export const value = 2;\n");
    await writeFile(path.join(project.path, "fresh.ts"), "export const fresh = true;\n");

    const statusResponse = await fetch(`${node.baseUrl}/api/projects/${project.id}/git/status`, { headers });
    assert.equal(statusResponse.status, 200, node.output());
    const status = await jsonBody(statusResponse) as { branch: string; unstaged: Array<{ path: string }>; untracked: Array<{ path: string }>; clean: boolean };
    assert.equal(status.branch, "main");
    assert.equal(status.clean, false);
    assert.ok(status.unstaged.some((change) => change.path === "app.ts"), "app.ts is an unstaged change");
    assert.ok(status.untracked.some((change) => change.path === "fresh.ts"), "fresh.ts is untracked");

    const diffResponse = await fetch(`${node.baseUrl}/api/projects/${project.id}/git/diff?path=${encodeURIComponent("app.ts")}`, { headers });
    assert.equal(diffResponse.status, 200);
    const diff = await jsonBody(diffResponse) as { patch: string };
    assert.match(diff.patch, /-export const value = 1;/);
    assert.match(diff.patch, /\+export const value = 2;/);

    const untrackedResponse = await fetch(`${node.baseUrl}/api/projects/${project.id}/git/diff?path=${encodeURIComponent("fresh.ts")}&untracked=1`, { headers });
    assert.equal(untrackedResponse.status, 200);
    assert.match((await jsonBody(untrackedResponse) as { patch: string }).patch, /\+export const fresh = true;/);

    const historyResponse = await fetch(`${node.baseUrl}/api/projects/${project.id}/git/history`, { headers });
    assert.equal(historyResponse.status, 200);
    const history = await jsonBody(historyResponse) as { commits: Array<{ hash: string; subject: string }> };
    assert.equal(history.commits.length, 1);
    assert.equal(history.commits[0].subject, "initial commit");

    const commitResponse = await fetch(`${node.baseUrl}/api/projects/${project.id}/git/commit?revision=${history.commits[0].hash}`, { headers });
    assert.equal(commitResponse.status, 200);
    const commit = await jsonBody(commitResponse) as { subject: string; files: Array<{ path: string }> };
    assert.equal(commit.subject, "initial commit");
    assert.ok(commit.files.some((file) => file.path === "app.ts"));

    // An invalid revision is rejected with a 400, never passed to git as an option.
    const badRevision = await fetch(`${node.baseUrl}/api/projects/${project.id}/git/commit?revision=${encodeURIComponent("--upload-pack=x")}`, { headers });
    assert.equal(badRevision.status, 400);

    // The reviews list starts empty and is well-formed.
    const reviews = await fetch(`${node.baseUrl}/api/projects/${project.id}/git/reviews`, { headers });
    assert.equal(reviews.status, 200);
    assert.deepEqual(await jsonBody(reviews), { threads: [] });
  } finally {
    if (node) await stopNode(node);
    await sync.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("git status on a non-repository project returns 400", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-git-review-nonrepo-"));
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
    const created = await fetch(`${node.baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Plain", type: "work", synced: true }) });
    const project = (await created.json() as { project: { id: string } }).project;
    const statusResponse = await fetch(`${node.baseUrl}/api/projects/${project.id}/git/status`, { headers });
    assert.equal(statusResponse.status, 400, "a project that is not a git repo reports 400, not 500");
  } finally {
    if (node) await stopNode(node);
    await sync.server.close();
    await rm(root, { recursive: true, force: true });
  }
});
