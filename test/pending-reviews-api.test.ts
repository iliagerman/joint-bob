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
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pending-reviews-"));
  const previous = {
    dataDir: process.env.PI_WEB_DATA_DIR,
    username: process.env.MASTER_BOB_ADMIN_USERNAME,
    password: process.env.MASTER_BOB_INITIAL_PASSWORD,
  };
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  const { createApp } = await import(`../src/app.js?pendingReviews=${Date.now()}-${Math.random()}`);
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
    body: JSON.stringify({ name: "Review inbox", path: projectPath, synced: false }),
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
  return { projectId: project.id, projectPath, sessionFile: path.join(sessionDir, "inbox-session.jsonl") };
}

test("the pending reviews endpoint groups conversations needing review across projects", async () => {
  const node = await startTestNode();
  try {
    const { cookie, headers } = await authenticate(node);
    const fixture = await createFixture(node, headers);
    const opening = { type: "user", cwd: fixture.projectPath, message: { role: "user", content: [{ type: "text", text: "start" }] } };
    await writeFile(fixture.sessionFile, `${JSON.stringify(opening)}\n`);
    const pending = async () => {
      const response = await fetch(`${node.baseUrl}/api/reviews/pending`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      const body = await response.json() as { projects: Array<{ projectId: string; projectName: string; sessions: Array<{ path: string; title: string; updatedAt: string; agentLabel: string }> }> };
      return body.projects;
    };
    assert.deepEqual(await pending(), []);

    const finished = { type: "assistant", cwd: fixture.projectPath, message: { role: "assistant", content: [{ type: "text", text: "done" }] } };
    await writeFile(fixture.sessionFile, `${JSON.stringify(opening)}\n${JSON.stringify(finished)}\n`);
    const later = new Date(Date.now() + 1000);
    await utimes(fixture.sessionFile, later, later);

    const groups = await pending();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].projectId, fixture.projectId);
    assert.equal(groups[0].projectName, "Review inbox");
    assert.equal(groups[0].sessions.length, 1);
    assert.ok(groups[0].sessions[0].updatedAt, "Pending entries must carry a review watermark");

    const marked = await fetch(`${node.baseUrl}/api/projects/${fixture.projectId}/sessions/reviewed-all`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ sessions: groups[0].sessions.map((entry) => ({ sessionPath: entry.path, updatedAt: entry.updatedAt })) }),
    });
    assert.equal(marked.status, 204);
    assert.deepEqual(await pending(), []);
  } finally {
    await new Promise<void>((resolve) => node.server.close(() => resolve()));
    node.restoreEnvironment();
    await rm(node.root, { recursive: true, force: true });
  }
});
