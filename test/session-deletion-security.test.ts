import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

interface TestNode {
  baseUrl: string;
  close(): Promise<void>;
}

async function startTestNode(dataDir: string): Promise<TestNode> {
  process.env.PI_WEB_DATA_DIR = dataDir;
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  const { createApp } = await import(`../src/app.js?session-deletion=${Date.now()}-${Math.random()}`);
  const server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function authenticatedHeaders(baseUrl: string): Promise<Record<string, string>> {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "initial-password" }),
  });
  assert.equal(login.status, 200);
  const body = await login.json() as { csrfToken: string };
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Missing session cookie");
  const changed = await fetch(`${baseUrl}/api/auth/change-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": body.csrfToken },
    body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }),
  });
  assert.equal(changed.status, 204);
  return { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" };
}

async function createProject(baseUrl: string, headers: Record<string, string>, name: string, projectPath: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, path: projectPath }),
  });
  assert.equal(response.status, 201);
  return (await response.json() as { project: { id: string } }).project.id;
}

async function deleteSession(baseUrl: string, headers: Record<string, string>, projectId: string, engine: "pi" | "claude", sessionId: string): Promise<Response> {
  const url = new URL(`/api/projects/${projectId}/sessions`, baseUrl);
  url.searchParams.set("engine", engine);
  url.searchParams.set("sessionId", sessionId);
  return fetch(url, { method: "DELETE", headers });
}

test("session deletion rejects paths not discovered for the selected project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "master-bob-session-delete-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  let node: TestNode | undefined;
  try {
    const [firstProjectPath, secondProjectPath, piSessionsPath, claudeSessionsPath] = ["first-project", "second-project", "pi-sessions", "claude-sessions"].map((name) => path.join(root, name));
    const claudeProjectPath = path.join(claudeSessionsPath, firstProjectPath.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-"));
    await Promise.all([firstProjectPath, secondProjectPath, piSessionsPath, claudeProjectPath].map((directory) => mkdir(directory, { recursive: true })));
    const unrelatedFile = path.join(root, "unrelated.jsonl");
    const sessionDirectory = path.join(root, "session-directory");
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const linkedSessionId = "223e4567-e89b-42d3-a456-426614174000";
    const sessionFile = path.join(claudeProjectPath, `${sessionId}.jsonl`);
    const linkedSession = path.join(claudeProjectPath, `${linkedSessionId}.jsonl`);
    await Promise.all([
      writeFile(unrelatedFile, "do not delete"),
      mkdir(sessionDirectory),
      writeFile(sessionFile, `${JSON.stringify({ type: "user", cwd: firstProjectPath, message: { content: "Hello" } })}\n`),
    ]);
    await symlink(sessionFile, linkedSession);

    node = await startTestNode(path.join(root, "data"));
    const headers = await authenticatedHeaders(node.baseUrl);
    const configured = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        pi: { executable: "", configPath: "", sessionPath: piSessionsPath },
        claude: { executable: "", configPath: "", sessionPath: claudeSessionsPath },
        syncthing: { endpoint: "" },
      }),
    });
    assert.equal(configured.status, 200);
    const firstProjectId = await createProject(node.baseUrl, headers, "First", firstProjectPath);
    const secondProjectId = await createProject(node.baseUrl, headers, "Second", secondProjectPath);
    const listed = await fetch(`${node.baseUrl}/api/projects/${firstProjectId}/sessions`, { headers });
    assert.equal(listed.status, 200);
    const sessions = (await listed.json() as { sessions: Array<{ id: string; path: string; harnessId: "pi" | "claude" }> }).sessions;
    const discovered = sessions.find((session) => session.path === `claude:${sessionFile}`);
    const linked = sessions.find((session) => session.path === `claude:${linkedSession}`);
    assert.ok(discovered);
    assert.ok(linked);

    const legacyPathRequest = new URL(`/api/projects/${firstProjectId}/sessions`, node.baseUrl);
    legacyPathRequest.searchParams.set("sessionPath", unrelatedFile);
    assert.equal((await fetch(legacyPathRequest, { method: "DELETE", headers })).status, 400);
    assert.equal((await deleteSession(node.baseUrl, headers, firstProjectId, "claude", "323e4567-e89b-42d3-a456-426614174000")).status, 404);
    assert.equal((await deleteSession(node.baseUrl, headers, firstProjectId, "claude", linked.id)).status, 400);
    assert.equal((await deleteSession(node.baseUrl, headers, secondProjectId, discovered.harnessId, discovered.id)).status, 404);

    assert.equal((await lstat(unrelatedFile)).isFile(), true);
    assert.equal((await lstat(sessionDirectory)).isDirectory(), true);
    assert.equal((await lstat(linkedSession)).isSymbolicLink(), true);
    assert.equal((await lstat(sessionFile)).isFile(), true);
    assert.equal((await deleteSession(node.baseUrl, headers, firstProjectId, discovered.harnessId, discovered.id)).status, 204);
    await assert.rejects(lstat(sessionFile), { code: "ENOENT" });
  } finally {
    if (node) await node.close();
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousUsername === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME;
    else process.env.MASTER_BOB_ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD;
    else process.env.MASTER_BOB_INITIAL_PASSWORD = previousPassword;
    await rm(root, { recursive: true, force: true });
  }
});
