import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected session cookie");
  return value.split(";", 1)[0];
}

test("project text file content is versioned and conflict-safe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-file-editor-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  process.env.PI_WEB_DATA_DIR = root;
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  let appServer: import("node:http").Server | undefined;
  try {
    ({ server: appServer } = await import(new URL(`../src/server.ts?file-editor=${Date.now()}`, import.meta.url).href));
    const settings = await import("../src/settings.ts");
    const cluster = await import("../src/cluster.ts");
    const ownership = await import("../src/conversation-ownership.ts");
    const sessionId = "file-editor-session";
    const sessionRoot = path.join(root, "pi-sessions");
    const currentSettings = settings.getSettings();
    settings.updateSettings({ ...currentSettings, pi: { ...currentSettings.pi, sessionPath: sessionRoot } });
    await mkdir(sessionRoot, { recursive: true });
    await new Promise<void>((resolve) => appServer?.listen(0, "127.0.0.1", resolve));
    const address = appServer.address();
    if (!address || typeof address === "string") throw new Error("App server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
    const auth = await login.json() as { csrfToken: string };
    const headers = { "Content-Type": "application/json", Cookie: cookie(login), "X-CSRF-Token": auth.csrfToken };
    await fetch(`${baseUrl}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) });
    const projectPath = path.join(root, "project");
    const created = await fetch(`${baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Files", path: projectPath }) });
    const project = (await created.json() as { project: { id: string } }).project;
    await mkdir(projectPath, { recursive: true });
    await writeFile(path.join(sessionRoot, `${sessionId}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: projectPath })}\n`);
    await writeFile(path.join(projectPath, "notes.txt"), "before\n");
    const contentUrl = `${baseUrl}/api/projects/${project.id}/file-content?path=notes.txt`;
    const opened = await fetch(contentUrl, { headers });
    const openedBody = await opened.json() as { content: string; version: string };
    assert.equal(opened.status, 200);
    assert.equal(openedBody.content, "before\n");
    assert.match(openedBody.version, /^[0-9a-f]{64}$/);
    const missingSession = await fetch(contentUrl, { method: "PUT", headers, body: JSON.stringify({ content: "after\n", version: openedBody.version }) });
    assert.equal(missingSession.status, 400);
    const saved = await fetch(contentUrl, { method: "PUT", headers, body: JSON.stringify({ content: "after\n", version: openedBody.version, sessionId }) });
    const savedBody = await saved.json() as { version: string };
    assert.equal(saved.status, 200);
    assert.match(savedBody.version, /^[0-9a-f]{64}$/);
    assert.equal(await readFile(path.join(projectPath, "notes.txt"), "utf8"), "after\n");
    assert.equal((await ownership.getConversationOwnership("pi", sessionId))?.ownerNodeId, (await cluster.getClusterNode()).id);
    await writeFile(path.join(projectPath, "notes.txt"), "external\n");
    const stale = await fetch(contentUrl, { method: "PUT", headers, body: JSON.stringify({ content: "lost\n", version: savedBody.version, sessionId }) });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { error: string }).error, "File changed since it was opened");
    assert.equal(await readFile(path.join(projectPath, "notes.txt"), "utf8"), "external\n");
    const fresh = await fetch(contentUrl, { headers });
    const freshBody = await fresh.json() as { content: string; version: string };
    const foreignNodeId = "22222222-2222-4222-8222-222222222222";
    await ownership.takeConversationOwnership("pi", sessionId, foreignNodeId);
    const rejected = await fetch(contentUrl, { method: "PUT", headers, body: JSON.stringify({ content: "foreign\n", version: freshBody.version, sessionId }) });
    assert.equal(rejected.status, 409);
    assert.match((await rejected.json() as { error: string }).error, /Conversation is owned by .*; transfer it before continuing/);
    assert.equal(await readFile(path.join(projectPath, "notes.txt"), "utf8"), "external\n");
    await writeFile(path.join(projectPath, "binary.bin"), Buffer.from([0x61, 0x00, 0x62]));
    const binary = await fetch(`${baseUrl}/api/projects/${project.id}/file-content?path=binary.bin`, { headers });
    assert.equal(binary.status, 415);
    assert.equal((await binary.json() as { error: string }).error, "File is not valid UTF-8 text");
    const traversal = await fetch(`${baseUrl}/api/projects/${project.id}/file-content?path=../notes.txt`, { headers });
    assert.equal(traversal.status, 403);
    assert.equal((await traversal.json() as { error: string }).error, "File is outside the project directory");
  } finally {
    if (appServer?.listening) await new Promise<void>((resolve) => appServer?.close(() => resolve()));
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousUsername === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME; else process.env.MASTER_BOB_ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD; else process.env.MASTER_BOB_INITIAL_PASSWORD = previousPassword;
    await rm(root, { recursive: true, force: true });
  }
});
