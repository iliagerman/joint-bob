import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

interface StartedNode { baseUrl: string; child: ChildProcess; homeDir: string; output: () => string; }

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
    env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", PORT: "0", HOME: homeDir, PI_WEB_DATA_DIR: path.join(root, "data"), MASTER_BOB_ADMIN_USERNAME: "admin", MASTER_BOB_INITIAL_PASSWORD: "initial-password", PI_MOBILE_WEB_SYNCTHING_URL: syncthingUrl, PI_MOBILE_WEB_SYNCTHING_API_KEY: "test-key", JOINT_BOB_MERGE_AGENT: "off" },
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

async function jsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`${response.status} ${text}`); }
}

interface TaskFixture { project: { id: string; path: string }; task: { id: string; worktreePath: string }; headers: Record<string, string>; node: StartedNode; }

async function seededTicket(root: string, syncUrl: string, fileName: string, fileBody: string): Promise<TaskFixture> {
  const node = await startNode(root, syncUrl);
  const headers = await session(node);
  const homePath = path.join(node.homeDir, "JointBob");
  await fetch(`${node.baseUrl}/api/settings`, { method: "PUT", headers, body: JSON.stringify({ pi: { executable: "", configPath: "", sessionPath: "" }, claude: { executable: "", configPath: "", sessionPath: "" }, syncthing: { endpoint: "" }, projects: { homePath } }) });
  const created = await fetch(`${node.baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Mergeable", type: "work", synced: true }) });
  assert.equal(created.status, 201, node.output());
  const project = (await jsonBody(created) as { project: { id: string; path: string } }).project;
  await mkdir(project.path, { recursive: true });
  await writeFile(path.join(project.path, fileName), fileBody);
  const createdTask = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks`, { method: "POST", headers, body: JSON.stringify({ title: "Change file", description: "" }) });
  if (createdTask.status !== 201) console.log("TASK CREATE BODY:", await createdTask.text(), "\nSERVER:\n", node.output());
  assert.equal(createdTask.status, 201, node.output());
  const task = (await jsonBody(createdTask) as { task: { id: string; worktreePath: string } }).task;
  return { project, task, headers, node };
}

test("a clean ticket merge applies workspace changes to the project", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-merge-clean-"));
  const sync = await fakeSyncthing();
  let fixture: TaskFixture | undefined;
  try {
    fixture = await seededTicket(root, sync.url, "config.ts", "export const value = 1;\n");
    const { project, task, headers, node } = fixture;
    await writeFile(path.join(task.worktreePath, "config.ts"), "export const value = 2;\n");
    await writeFile(path.join(task.worktreePath, "new-file.ts"), "export const added = true;\n");

    const moved = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks/${task.id}`, { method: "PATCH", headers, body: JSON.stringify({ status: "done" }) });
    assert.equal(moved.status, 200);
    let after = (await jsonBody(moved) as { task: { mergeState: string; mergedAt: string | null } }).task;
    if (after.mergeState !== "merged") {
      // The done transition triggers the merge out-of-band; poll for it.
      for (let attempt = 0; attempt < 50 && after.mergeState !== "merged"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const listed = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks`, { headers });
        after = ((await jsonBody(listed) as { tasks: Array<typeof after> }).tasks).find((candidate) => candidate.id === task.id) ?? after;
      }
    }
    assert.equal(after.mergeState, "merged", `mergeState: ${JSON.stringify(after)}`);
    assert.ok(after.mergedAt);

    assert.equal(await readFile(path.join(project.path, "config.ts"), "utf8"), "export const value = 2;\n");
    assert.equal(await readFile(path.join(project.path, "new-file.ts"), "utf8"), "export const added = true;\n");

    // Archive is allowed once merged.
    const archived = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks/${task.id}/archive`, { method: "POST", headers });
    if (archived.status !== 200) throw new Error(`archive: ${await archived.text()}`);
  } finally {
    if (fixture) await stopNode(fixture.node);
    await sync.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a conflicted ticket merge stages markers, accepts resolutions, and blocks archive until merged", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-merge-conflict-"));
  const sync = await fakeSyncthing();
  let fixture: TaskFixture | undefined;
  try {
    fixture = await seededTicket(root, sync.url, "notes.md", "alpha\nbeta\ngamma\n");
    const { project, task, headers, node } = fixture;
    // Diverge both sides on the same region.
    await writeFile(path.join(task.worktreePath, "notes.md"), "alpha\nworkspace beta\ngamma\n");
    await writeFile(path.join(project.path, "notes.md"), "alpha\nproject beta\ngamma\n");
    // A choice conflict: both sides created the same new file with different content.
    await writeFile(path.join(task.worktreePath, "added.txt"), "workspace created\n");
    await writeFile(path.join(project.path, "added.txt"), "project created\n");
    // A mode conflict: identical bytes, executable in the ticket, plain in the project.
    const { chmod } = await import("node:fs/promises");
    await writeFile(path.join(task.worktreePath, "tool.sh"), "#!/bin/sh\n");
    await writeFile(path.join(project.path, "tool.sh"), "#!/bin/sh\n");
    await chmod(path.join(task.worktreePath, "tool.sh"), 0o755);
    await chmod(path.join(project.path, "tool.sh"), 0o644);

    const moved = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks/${task.id}`, { method: "PATCH", headers, body: JSON.stringify({ status: "done" }) });
    assert.equal(moved.status, 200);

    let taskView = null as null | { mergeState: string; conflictCount: number; mergeWarning: string | null };
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const listed = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks`, { headers });
      const found = ((await jsonBody(listed) as { tasks: Array<{ id: string; mergeState: string; conflictCount: number; mergeWarning: string | null; executionState: string }> }).tasks).find((candidate) => candidate.id === task.id) ?? null;
      taskView = found;
      if (found?.mergeState === "conflicts" && found.executionState === "idle") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(taskView?.mergeState, "conflicts", `mergeState: ${JSON.stringify(taskView)}`);
    assert.ok((taskView?.conflictCount ?? 0) >= 1);

    // Archive is blocked while unmerged.
    const blocked = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks/${task.id}/archive`, { method: "POST", headers });
    assert.equal(blocked.status, 409);
    assert.match((await jsonBody(blocked) as { error: string }).error, /Merge the ticket workspace/);

    const conflictsResponse = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks/${task.id}/merge-conflicts`, { headers });
    const { conflicts } = await jsonBody(conflictsResponse) as { conflicts: Array<{ path: string; kind: string }> };
    const textConflict = conflicts.find((entry) => entry.kind === "text" && entry.path === "notes.md");
    const choiceConflict = conflicts.find((entry) => entry.kind === "choice" && entry.path === "added.txt");
    assert.ok(textConflict, `text conflict for notes.md: ${JSON.stringify(conflicts)}`);
    assert.ok(choiceConflict, `choice conflict for added.txt: ${JSON.stringify(conflicts)}`);

    // Resolve the text conflict by writing a marker-free resolution into the staged tree.
    const staged = path.join(task.worktreePath, ".joint-bob-merge", "staged", "notes.md");
    await writeFile(staged, "alpha\nresolved beta\ngamma\n");
    // Finalize with the choice conflict still unresolved must refuse.
    const early = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks/${task.id}/merge`, { method: "POST", headers });
    assert.equal(early.status, 409);

    // Resolve the choice conflict through the API: take the project side.
    const resolved = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks/${task.id}/merge-resolve`, { method: "POST", headers, body: JSON.stringify({ path: "added.txt", side: "project" }) });
    if (resolved.status !== 200) throw new Error(`merge-resolve: ${await resolved.text()}`);
    // Resolve the mode conflict by taking the (executable) ticket side.
    const modeResolved = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks/${task.id}/merge-resolve`, { method: "POST", headers, body: JSON.stringify({ path: "tool.sh", side: "workspace" }) });
    if (modeResolved.status !== 200) throw new Error(`mode merge-resolve: ${await modeResolved.text()}`);

    const merged = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks/${task.id}/merge`, { method: "POST", headers });
    if (merged.status !== 200) throw new Error(`merge: ${await merged.text()}`);
    const mergedTask = (await jsonBody(merged) as { task: { mergeState: string } }).task;
    assert.equal(mergedTask.mergeState, "merged");

    assert.equal(await readFile(path.join(project.path, "notes.md"), "utf8"), "alpha\nresolved beta\ngamma\n");
    assert.equal(await readFile(path.join(project.path, "added.txt"), "utf8"), "project created\n");
    const { stat } = await import("node:fs/promises");
    const toolMode = (await stat(path.join(project.path, "tool.sh"))).mode & 0o7777;
    assert.equal(toolMode, 0o755, `tool.sh must keep the ticket's executable mode, got ${toolMode.toString(8)}`);

    const archived = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks/${task.id}/archive`, { method: "POST", headers });
    if (archived.status !== 200) throw new Error(`archive: ${await archived.text()}`);
  } finally {
    if (fixture) await stopNode(fixture.node);
    await sync.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("discarding a conflicted ticket drops the workspace and unblocks the board", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-merge-discard-"));
  const sync = await fakeSyncthing();
  let fixture: TaskFixture | undefined;
  try {
    fixture = await seededTicket(root, sync.url, "solo.txt", "one\n");
    const { project, task, headers, node } = fixture;
    await writeFile(path.join(task.worktreePath, "solo.txt"), "two\n");
    await writeFile(path.join(project.path, "solo.txt"), "three\n");
    await writeFile(path.join(task.worktreePath, ".joint-bob-baseline", "solo.txt"), "one\n");

    const moved = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks/${task.id}`, { method: "PATCH", headers, body: JSON.stringify({ status: "done" }) });
    assert.equal(moved.status, 200);
    let state = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const listed = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks`, { headers });
      const found = ((await jsonBody(listed) as { tasks: Array<{ id: string; mergeState: string; executionState: string }> }).tasks).find((candidate) => candidate.id === task.id);
      state = found?.mergeState ?? "";
      if (state === "conflicts" && found?.executionState === "idle") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(state, "conflicts");

    const discarded = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks/${task.id}/discard`, { method: "POST", headers });
    if (discarded.status !== 200) throw new Error(`discard: ${await discarded.text()}`);
    const after = (await jsonBody(discarded) as { task: { mergeState: string } }).task;
    assert.equal(after.mergeState, "merged");
    // The project keeps its own version.
    assert.equal(await readFile(path.join(project.path, "solo.txt"), "utf8"), "three\n");
  } finally {
    if (fixture) await stopNode(fixture.node);
    await sync.server.close();
    await rm(root, { recursive: true, force: true });
  }
});
