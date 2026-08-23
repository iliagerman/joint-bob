import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeProjectDir } from "../src/session-paths.js";

interface TestNode {
  root: string;
  baseUrl: string;
  server: Server;
  restoreEnvironment: () => void;
}

function cookieFrom(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("Missing session cookie");
  return cookie.split(";", 1)[0];
}

async function startTestNode(): Promise<TestNode> {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-review-api-"));
  const previous = {
    dataDir: process.env.PI_WEB_DATA_DIR,
    username: process.env.MASTER_BOB_ADMIN_USERNAME,
    password: process.env.MASTER_BOB_INITIAL_PASSWORD,
  };
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  const { createApp } = await import(`../src/app.js?reviews=${Date.now()}-${Math.random()}`);
  const server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return {
    root,
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    restoreEnvironment: () => {
      if (previous.dataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous.dataDir;
      if (previous.username === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME; else process.env.MASTER_BOB_ADMIN_USERNAME = previous.username;
      if (previous.password === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD; else process.env.MASTER_BOB_INITIAL_PASSWORD = previous.password;
    },
  };
}

async function authenticate(node: TestNode): Promise<{ cookie: string; headers: Record<string, string> }> {
  const login = await fetch(`${node.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "initial-password" }),
  });
  const cookie = cookieFrom(login);
  const { csrfToken } = await login.json() as { csrfToken: string };
  const headers = { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
  const changed = await fetch(`${node.baseUrl}/api/auth/change-password`, {
    method: "POST",
    headers,
    body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }),
  });
  assert.equal(changed.status, 204);
  return { cookie, headers };
}

async function createFixture(node: TestNode, headers: Record<string, string>): Promise<{ projectId: string; projectPath: string; sessionFile: string }> {
  const projectPath = path.join(node.root, "project");
  await mkdir(projectPath);
  const projectResponse = await fetch(`${node.baseUrl}/api/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Status test", path: projectPath, synced: false }),
  });
  assert.equal(projectResponse.status, 201);
  const { project } = await projectResponse.json() as { project: { id: string } };
  const claudeRoot = path.join(node.root, "claude-sessions");
  const settings = await fetch(`${node.baseUrl}/api/settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      pi: { executable: "", configPath: "", sessionPath: "" },
      claude: { executable: "", configPath: "", sessionPath: claudeRoot },
      syncthing: { endpoint: "" },
    }),
  });
  assert.equal(settings.status, 200);
  const sessionDir = claudeProjectDir(projectPath, claudeRoot);
  await mkdir(sessionDir, { recursive: true });
  return { projectId: project.id, projectPath, sessionFile: path.join(sessionDir, "status-session.jsonl") };
}

test("session API persists automatic review transitions for the signed-in account", async () => {
  const node = await startTestNode();
  try {
    const { cookie, headers } = await authenticate(node);
    const fixture = await createFixture(node, headers);
    const firstRecord = { type: "user", cwd: fixture.projectPath, message: { role: "user", content: [{ type: "text", text: "check status" }] } };
    await writeFile(fixture.sessionFile, `${JSON.stringify(firstRecord)}\n`);
    const list = async () => {
      const response = await fetch(`${node.baseUrl}/api/projects/${fixture.projectId}/sessions`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      return (await response.json() as { sessions: Array<{ path: string; reviewState: string }> }).sessions[0];
    };
    assert.equal((await list()).reviewState, "reviewed");

    const assistant = { type: "assistant", cwd: fixture.projectPath, message: { role: "assistant", content: [{ type: "text", text: "finished" }] } };
    await writeFile(fixture.sessionFile, `${JSON.stringify(firstRecord)}\n${JSON.stringify(assistant)}\n`);
    const future = new Date(Date.now() + 1000);
    await utimes(fixture.sessionFile, future, future);
    const finished = await list();
    assert.equal(finished.reviewState, "needs_review");

    const reviewed = await fetch(`${node.baseUrl}/api/projects/${fixture.projectId}/sessions/reviewed`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ sessionPath: finished.path }),
    });
    assert.equal(reviewed.status, 204);
    assert.equal((await list()).reviewState, "reviewed");
  } finally {
    await new Promise<void>((resolve) => node.server.close(() => resolve()));
    node.restoreEnvironment();
    await rm(node.root, { recursive: true, force: true });
  }
});
