import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ntfy-api-"));
  const previous = {
    dataDir: process.env.PI_WEB_DATA_DIR,
    username: process.env.MASTER_BOB_ADMIN_USERNAME,
    password: process.env.MASTER_BOB_INITIAL_PASSWORD,
  };
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  const { createApp } = await import(`../src/app.js?ntfy=${Date.now()}-${Math.random()}`);
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

interface ServiceView { id: string; name: string; url: string; hasToken: boolean }

// The auth module is a process-wide singleton bound to the first data directory,
// so every test in this file shares one node.
let node: TestNode;
let cookie: string;
let headers: Record<string, string>;

test.before(async () => {
  node = await startTestNode();
  ({ cookie, headers } = await authenticate(node));
});

test.after(async () => {
  await new Promise<void>((resolve) => node.server.close(() => resolve()));
  node.restoreEnvironment();
  await rm(node.root, { recursive: true, force: true });
});

test("ntfy services are stored centrally, encrypted at rest, and listed without their tokens", async () => {
  {
    const created = await fetch(`${node.baseUrl}/api/ntfy/services`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Home", url: "https://ntfy.home.example/", token: "tk_super_secret_value" }),
    });
    assert.equal(created.status, 201);
    const { service } = await created.json() as { service: ServiceView };
    assert.equal(service.name, "Home");
    assert.equal(service.url, "https://ntfy.home.example", "trailing slash is stripped");
    assert.equal(service.hasToken, true);
    assert.ok(!JSON.stringify(service).includes("tk_super_secret_value"));

    const tokenless = await fetch(`${node.baseUrl}/api/ntfy/services`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Public", url: "https://ntfy.sh" }),
    });
    assert.equal(tokenless.status, 201);

    const listed = await fetch(`${node.baseUrl}/api/ntfy/services`, { headers });
    assert.equal(listed.status, 200);
    const { services } = await listed.json() as { services: ServiceView[] };
    assert.equal(services.length, 2);
    assert.ok(!JSON.stringify(services).includes("tk_super_secret_value"));
    assert.equal(services.find((entry) => entry.name === "Public")?.hasToken, false);

    const files = await Promise.all(["node.db", "node.db-wal"].map(async (file) => {
      try {
        return await readFile(path.join(node.root, "data", file));
      } catch {
        return Buffer.alloc(0);
      }
    }));
    assert.ok(!Buffer.concat(files).includes("tk_super_secret_value"), "token must be encrypted at rest");

    const invalid = await fetch(`${node.baseUrl}/api/ntfy/services`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Broken", url: "not-a-url" }),
    });
    assert.equal(invalid.status, 400);

    const removed = await fetch(`${node.baseUrl}/api/ntfy/services/${service.id}`, { method: "DELETE", headers });
    assert.equal(removed.status, 204);
    const afterDelete = await fetch(`${node.baseUrl}/api/ntfy/services`, { headers });
    assert.equal(((await afterDelete.json()) as { services: ServiceView[] }).services.length, 1);

    const missing = await fetch(`${node.baseUrl}/api/ntfy/services/${service.id}`, { method: "DELETE", headers });
    assert.equal(missing.status, 404);
  }
});

test("a conversation opts into ntfy publishing with a topic and can opt out again", async () => {
  {
    const projectPath = path.join(node.root, "project");
    await mkdir(projectPath);
    const projectResponse = await fetch(`${node.baseUrl}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ntfy test", path: projectPath, synced: false }),
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
    const record = { type: "user", cwd: projectPath, message: { role: "user", content: [{ type: "text", text: "hello" }] } };
    await writeFile(path.join(sessionDir, "ntfy-session.jsonl"), `${JSON.stringify(record)}\n`);

    const listSessions = async () => {
      const response = await fetch(`${node.baseUrl}/api/projects/${project.id}/sessions`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      return (await response.json() as { sessions: Array<{ path: string; ntfyEnabled?: boolean; reviewNotificationsEnabled?: boolean }> }).sessions;
    };
    const deadline = Date.now() + 5_000;
    let sessions = await listSessions();
    while (!sessions.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      sessions = await listSessions();
    }
    assert.ok(sessions.length, "fixture conversation is listed");
    const sessionPath = sessions[0].path;
    assert.equal(sessions[0].ntfyEnabled, false);

    const created = await fetch(`${node.baseUrl}/api/ntfy/services`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Home", url: "https://ntfy.home.example", token: "tk_topic_secret" }),
    });
    const { service } = await created.json() as { service: ServiceView };

    const withoutTopic = await fetch(`${node.baseUrl}/api/projects/${project.id}/sessions/ntfy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ sessionPath, enabled: true, serviceId: service.id }),
    });
    assert.equal(withoutTopic.status, 400, "enabling requires a topic");

    const enabled = await fetch(`${node.baseUrl}/api/projects/${project.id}/sessions/ntfy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ sessionPath, enabled: true, serviceId: service.id, topic: "my-reviews" }),
    });
    assert.equal(enabled.status, 200);
    assert.deepEqual(await enabled.json(), { enabled: true });

    sessions = await listSessions();
    assert.equal(sessions[0].ntfyEnabled, true);
    assert.equal(sessions[0].reviewNotificationsEnabled, true, "publishing implies the review-notification preference");

    const db = new DatabaseSync(path.join(node.root, "data", "node.db"), { readOnly: true });
    const row = db.prepare("SELECT COUNT(*) AS count FROM push_session_subscriptions WHERE project_id = ? AND session_path = ?").get(project.id, sessions[0].conversationId || sessions[0].id) as { count: number };
    db.close();
    assert.equal(row.count, 1, "the ntfy target is stored as a replicated subscription row");

    const disabled = await fetch(`${node.baseUrl}/api/projects/${project.id}/sessions/ntfy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ sessionPath, enabled: false }),
    });
    assert.equal(disabled.status, 200);
    sessions = await listSessions();
    assert.equal(sessions[0].ntfyEnabled, false);
    const after = new DatabaseSync(path.join(node.root, "data", "node.db"), { readOnly: true });
    const remaining = after.prepare("SELECT COUNT(*) AS count FROM push_session_subscriptions WHERE project_id = ? AND session_path = ?").get(project.id, sessions[0].conversationId || sessions[0].id) as { count: number };
    after.close();
    assert.equal(remaining.count, 0);
  }
});
