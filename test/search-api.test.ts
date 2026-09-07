import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

interface SearchResult {
  kind: "project" | "conversation";
  projectId: string;
  projectName: string;
  title: string;
  sessionId?: string;
  sessionPath?: string;
  harnessId?: string;
}

function cookieFrom(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("Missing session cookie");
  return cookie.split(";", 1)[0];
}

async function startTestNode(): Promise<TestNode> {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-search-"));
  const previous = {
    dataDir: process.env.PI_WEB_DATA_DIR,
    username: process.env.MASTER_BOB_ADMIN_USERNAME,
    password: process.env.MASTER_BOB_INITIAL_PASSWORD,
  };
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  const { createApp } = await import(`../src/app.js?search=${Date.now()}-${Math.random()}`);
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

test("one search reaches every project and every conversation in them", async () => {
  const node = await startTestNode();
  try {
    const login = await fetch(`${node.baseUrl}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "initial-password" }),
    });
    const cookie = cookieFrom(login);
    const { csrfToken } = await login.json() as { csrfToken: string };
    const headers = { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
    assert.equal((await fetch(`${node.baseUrl}/api/auth/change-password`, {
      method: "POST", headers,
      body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }),
    })).status, 204);

    const claudeRoot = path.join(node.root, "claude-sessions");
    assert.equal((await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT", headers,
      body: JSON.stringify({
        pi: { executable: "", configPath: "", sessionPath: "" },
        claude: { executable: "", configPath: "", sessionPath: claudeRoot },
        syncthing: { endpoint: "" },
      }),
    })).status, 200);

    const createProject = async (name: string, directory: string) => {
      const projectPath = path.join(node.root, directory);
      await mkdir(projectPath, { recursive: true });
      const created = await fetch(`${node.baseUrl}/api/projects`, {
        method: "POST", headers, body: JSON.stringify({ name, path: projectPath, synced: false }),
      });
      assert.equal(created.status, 201, `created ${name}`);
      const { project } = await created.json() as { project: { id: string } };
      return { id: project.id, path: projectPath };
    };
    const payments = await createProject("Payments service", "payments");
    const marketing = await createProject("Marketing site", "marketing");

    // One conversation, in the project the query does not name, so a hit proves the
    // search crossed a project boundary rather than reading the open one.
    const sessionDir = claudeProjectDir(marketing.path, claudeRoot);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, "brochure-session.jsonl"),
      `${JSON.stringify({ type: "user", cwd: marketing.path, message: { role: "user", content: [{ type: "text", text: "Rewrite the kangaroo brochure copy" }] } })}\n`);

    const search = async (query: string) => {
      const response = await fetch(`${node.baseUrl}/api/search?q=${encodeURIComponent(query)}`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200, `search ${query}`);
      return (await response.json() as { results: SearchResult[] }).results;
    };

    const projectHits = await search("paym");
    assert.ok(projectHits.some((hit) => hit.kind === "project" && hit.projectId === payments.id),
      `a project matches on part of its name: ${JSON.stringify(projectHits)}`);

    const conversationHits = await search("kangaroo");
    const conversation = conversationHits.find((hit) => hit.kind === "conversation");
    assert.ok(conversation, `a conversation in another project is reachable: ${JSON.stringify(conversationHits)}`);
    assert.equal(conversation.projectId, marketing.id);
    assert.equal(conversation.projectName, "Marketing site", "a hit names the project it lives in");
    assert.ok(conversation.sessionPath?.endsWith("brochure-session.jsonl"));
    assert.equal(conversation.harnessId, "claude");

    assert.deepEqual(await search("zzzznothing"), [], "an unmatched query returns nothing, not everything");

    // An empty query is the opening state of the bar, so it offers somewhere to go.
    const idle = await search("");
    assert.ok(idle.length > 0, "an empty query still offers projects and recent conversations");
    assert.ok(idle.some((hit) => hit.kind === "project"));
  } finally {
    await new Promise<void>((resolve, reject) => node.server.close((error) => error ? reject(error) : resolve()));
    node.restoreEnvironment();
    await rm(node.root, { recursive: true, force: true });
  }
});
