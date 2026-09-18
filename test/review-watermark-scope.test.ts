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
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-review-scope-"));
  const previous = {
    dataDir: process.env.PI_WEB_DATA_DIR,
    username: process.env.MASTER_BOB_ADMIN_USERNAME,
    password: process.env.MASTER_BOB_INITIAL_PASSWORD,
  };
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  const { createApp } = await import(`../src/app.js?reviewScope=${Date.now()}-${Math.random()}`);
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

async function createFixture(node: TestNode, headers: Record<string, string>): Promise<{ projectId: string; projectPath: string; sessionDir: string }> {
  const projectPath = path.join(node.root, "project");
  await mkdir(projectPath);
  const projectResponse = await fetch(`${node.baseUrl}/api/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Review scope", path: projectPath, synced: false }),
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
  return { projectId: project.id, projectPath, sessionDir };
}

function claudeRecord(cwd: string, role: "user" | "assistant", text: string): string {
  return JSON.stringify({ type: role, cwd, message: { role, content: [{ type: "text", text }] } });
}

test("a conversation kept visible by a recent can still be marked reviewed beyond the listing cap", async () => {
  const node = await startTestNode();
  try {
    const { cookie, headers } = await authenticate(node);
    const fixture = await createFixture(node, headers);
    const targetFile = path.join(fixture.sessionDir, "out-of-cap.jsonl");
    const targetPath = `claude:${targetFile}`;
    await writeFile(targetFile, `${claudeRecord(fixture.projectPath, "user", "start")}\n`);
    const listSessions = async () => {
      const response = await fetch(`${node.baseUrl}/api/projects/${fixture.projectId}/sessions`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      return (await response.json() as { sessions: Array<{ path: string; reviewState: string; updatedAt: string }> }).sessions;
    };
    // The first listing initializes the account's review baseline for the conversation.
    const baselineDeadline = Date.now() + 5_000;
    let baselineSessions: Awaited<ReturnType<typeof listSessions>> = [];
    do {
      baselineSessions = await listSessions();
      if (baselineSessions.some((session) => session.path === targetPath)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < baselineDeadline);
    assert.ok(baselineSessions.some((session) => session.path === targetPath), `Timed out waiting for the target conversation; last: ${JSON.stringify(baselineSessions)}`);

    // Open it so the account's recents keep it listed, then let it finish unnoticed.
    const opened = new Date();
    const recents = await fetch(`${node.baseUrl}/api/recents`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        projectId: fixture.projectId, engine: "claude", sessionId: "out-of-cap",
        sessionPath: targetPath, title: "Out of cap", openedAt: opened.toISOString(), updatedAt: opened.toISOString(),
      }),
    });
    assert.equal(recents.status, 200);

    const pending = async () => {
      const response = await fetch(`${node.baseUrl}/api/reviews/pending`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      const body = await response.json() as { projects: Array<{ projectId: string; sessions: Array<{ path: string; updatedAt: string }> }> };
      return body.projects.find((group) => group.projectId === fixture.projectId)?.sessions ?? [];
    };

    const finishedActivity = new Date(Date.now() + 1000);
    await writeFile(targetFile, `${claudeRecord(fixture.projectPath, "user", "start")}\n${claudeRecord(fixture.projectPath, "assistant", "done")}\n`);
    await utimes(targetFile, finishedActivity, finishedActivity);
    const deadline = Date.now() + 5_000;
    let entries: Awaited<ReturnType<typeof pending>> = [];
    do {
      entries = await pending();
      if (entries.some((entry) => entry.path === targetPath)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    const target = entries.find((entry) => entry.path === targetPath);
    assert.ok(target, `Timed out waiting for the target in pending reviews; last entries: ${JSON.stringify(entries)}`);

    // Busier conversations push the finished one past the 50-row listing cap.
    for (let index = 0; index < 55; index++) {
      const filler = path.join(fixture.sessionDir, `filler-${String(index).padStart(3, "0")}.jsonl`);
      const at = new Date(finishedActivity.getTime() + 10_000 + index * 1000);
      await writeFile(filler, `${claudeRecord(fixture.projectPath, "user", `filler ${index}`)}\n`);
      await utimes(filler, at, at);
    }
    const afterFillers = await pending();
    assert.ok(afterFillers.some((entry) => entry.path === targetPath), "Recents must keep the out-of-cap conversation in the review inbox");

    const marked = await fetch(`${node.baseUrl}/api/projects/${fixture.projectId}/sessions/reviewed`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ sessionPath: targetPath, updatedAt: target.updatedAt }),
    });
    assert.equal(marked.status, 204);

    const cleared = await pending();
    assert.ok(!cleared.some((entry) => entry.path === targetPath), `Target stayed pending after review: ${JSON.stringify(cleared)}`);
  } finally {
    await new Promise<void>((resolve) => node.server.close(() => resolve()));
    node.restoreEnvironment();
    await rm(node.root, { recursive: true, force: true });
  }
});
