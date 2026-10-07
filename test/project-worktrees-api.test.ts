import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { claudeProjectDir } from "../src/harnesses/claude/paths.ts";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serverArgs } from "./server-entry.js";

interface StartedNode { baseUrl: string; child: ChildProcess; homeDir: string; output: () => string; }

async function listen(server: Server): Promise<number> {
  return await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

async function fakeSyncthing(): Promise<{ server: Server; url: string }> {
  const folders: unknown[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
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
  const child = spawn(process.execPath, serverArgs(process.env), {
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

async function isMissing(filePath: string): Promise<boolean> {
  try { await access(filePath); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

async function seedClaudeConversation(homeDir: string, cwd: string, id: string, prompt: string): Promise<void> {
  const directory = claudeProjectDir(cwd, path.join(homeDir, ".claude", "projects"));
  await mkdir(directory, { recursive: true });
  const now = new Date().toISOString();
  const records = [
    { type: "user", sessionId: id, cwd, timestamp: now, uuid: `${id}-u`, message: { role: "user", content: prompt } },
    { type: "assistant", sessionId: id, cwd, timestamp: now, uuid: `${id}-a`, message: { role: "assistant", content: [{ type: "text", text: "On it." }] } },
  ];
  await writeFile(path.join(directory, `${id}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

type Worktree = { id: string; name: string; color: string; path: string; lastMergedAt: string | null };
type Session = { id: string; title: string; worktree?: { id: string; name: string; color: string } };

test("worktree API creates, tags conversations, renames, merges and deletes worktrees", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-worktree-api-"));
  const sync = await fakeSyncthing();
  let node: StartedNode | undefined;
  try {
    node = await startNode(root, sync.url);
    const headers = await session(node);
    const homePath = path.join(node.homeDir, "JointBob");
    const saved = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ pi: { executable: "", configPath: "", sessionPath: "" }, claude: { executable: "", configPath: "", sessionPath: "" }, syncthing: { endpoint: "" }, projects: { homePath } }),
    });
    assert.equal(saved.status, 200, node.output());
    const created = await fetch(`${node.baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Dak", type: "personal", synced: true }) });
    assert.equal(created.status, 201, node.output());
    const project = (await created.json() as { project: { id: string; path: string } }).project;
    await mkdir(path.join(project.path, "src"), { recursive: true });
    await writeFile(path.join(project.path, "src", "inbox.ts"), "export const inbox = 'mock';\n");
    await mkdir(path.join(project.path, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(project.path, "node_modules", "dep", "index.js"), "module.exports = 1;\n");

    const base = `${node.baseUrl}/api/projects/${project.id}/worktrees`;
    assert.equal((await fetch(base, { method: "POST", headers, body: JSON.stringify({ name: "" }) })).status, 400);
    const made = await fetch(base, { method: "POST", headers, body: JSON.stringify({ name: "Slice 4" }) });
    assert.equal(made.status, 201, node.output());
    const worktree = (await made.json() as { worktree: Worktree }).worktree;
    assert.equal(worktree.path, path.join(homePath, "worktrees", project.id, worktree.id));
    assert.equal(await readFile(path.join(worktree.path, "src", "inbox.ts"), "utf8"), "export const inbox = 'mock';\n");
    // Dependencies are linked to the project's own folder, never copied.
    assert.equal(await realpath(path.join(worktree.path, "node_modules")), await realpath(path.join(project.path, "node_modules")));
    assert.match(await readFile(path.join(homePath, ".gitignore"), "utf8"), /^\/worktrees\/$/m);
    assert.equal((await fetch(base, { method: "POST", headers, body: JSON.stringify({ name: "slice 4" }) })).status, 409);
    const listed = await (await fetch(base, { headers })).json() as { worktrees: Worktree[] };
    assert.deepEqual(listed.worktrees.map((entry) => entry.name), ["Slice 4"]);

    const worktreeConversation = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const projectConversation = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    await seedClaudeConversation(node.homeDir, worktree.path, worktreeConversation, "Replace the inbox mock");
    await seedClaudeConversation(node.homeDir, project.path, projectConversation, "Plain project work");
    await mkdir(path.join(worktree.path, ".joint-bob-worktree", "conversations"), { recursive: true });
    await writeFile(path.join(worktree.path, ".joint-bob-worktree", "conversations", `claude--${worktreeConversation}.json`), "{}\n");
    const sessions = async () => (await (await fetch(`${node!.baseUrl}/api/projects/${project.id}/sessions`, { headers })).json() as { sessions: Session[] }).sessions;
    let listedSessions = await sessions();
    assert.deepEqual(listedSessions.find((entry) => entry.id === worktreeConversation)?.worktree, { id: worktree.id, name: "Slice 4", color: worktree.color }, node.output());
    assert.equal(listedSessions.find((entry) => entry.id === projectConversation)?.worktree, undefined);

    const renamed = await fetch(`${base}/${worktree.id}`, { method: "PATCH", headers, body: JSON.stringify({ name: "Slice 4 inbox", color: "violet" }) });
    assert.equal(renamed.status, 200, node.output());
    listedSessions = await sessions();
    assert.deepEqual(listedSessions.find((entry) => entry.id === worktreeConversation)?.worktree, { id: worktree.id, name: "Slice 4 inbox", color: "violet" });

    await writeFile(path.join(worktree.path, "src", "inbox.ts"), "export const inbox = 'real';\n");
    const merged = await fetch(`${base}/${worktree.id}/merge`, { method: "POST", headers, body: "{}" });
    assert.equal(merged.status, 200, node.output());
    assert.deepEqual(await merged.json(), { merged: true, applied: 1, deleted: 0, conflicts: [] });
    assert.equal(await readFile(path.join(project.path, "src", "inbox.ts"), "utf8"), "export const inbox = 'real';\n");

    await writeFile(path.join(worktree.path, "src", "inbox.ts"), "export const inbox = 'worktree';\n");
    await writeFile(path.join(project.path, "src", "inbox.ts"), "export const inbox = 'project';\n");
    const conflicted = await fetch(`${base}/${worktree.id}/merge`, { method: "POST", headers, body: "{}" });
    assert.equal(conflicted.status, 200);
    assert.deepEqual((await conflicted.json() as { conflicts: Array<{ path: string }> }).conflicts.map((conflict) => conflict.path), ["src/inbox.ts"]);
    assert.equal(await readFile(path.join(project.path, "src", "inbox.ts"), "utf8"), "export const inbox = 'project';\n");

    assert.equal((await fetch(`${base}/not-a-worktree`, { method: "DELETE", headers })).status, 400);
    const removed = await fetch(`${base}/${worktree.id}`, { method: "DELETE", headers });
    assert.equal(removed.status, 204, node.output());
    assert.equal(await isMissing(worktree.path), true);
    assert.deepEqual((await (await fetch(base, { headers })).json() as { worktrees: Worktree[] }).worktrees, []);
  } finally {
    if (node) await stopNode(node);
    sync.server.close();
    await rm(root, { recursive: true, force: true });
  }
});
