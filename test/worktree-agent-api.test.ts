import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = new URL("../bin/joint-bob-worktree.mjs", import.meta.url).pathname;
let bridge: Server;
let bridgeUrl: string;
let root: string;
let projectId: string;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "jb-worktree-agent-"));
  process.env.JOINT_BOB_WORKTREE_ROOT = path.join(root, "worktrees");
  const projectPath = path.join(root, "project");
  await mkdir(path.join(projectPath, "src"), { recursive: true });
  await mkdir(path.join(projectPath, "node_modules", "dep"), { recursive: true });
  await writeFile(path.join(projectPath, "src", "index.ts"), "export const value = 1;\n");
  await writeFile(path.join(projectPath, ".env"), "API_KEY=local\n");
  const { addProject } = await import("../src/store.js");
  projectId = (await addProject("Worktree agent fixture", projectPath, { writeInstructions: false })).id;
  bridge = createServer((await import("../src/app.js")).createApp());
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const address = bridge.address(); if (!address || typeof address === "string") throw new Error("bridge address missing");
  bridgeUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

async function capability(conversation = randomUUID(), project = projectId) {
  const { worktreeAgentEnvironment } = await import("../src/worktree-agent.js");
  const environment = worktreeAgentEnvironment(project, "claude", conversation, conversation);
  return { token: environment.JOINT_BOB_WORKTREE_TOKEN!, environment: { ...environment, JOINT_BOB_WORKTREE_URL: `${bridgeUrl}/api/worktrees/agent` } };
}

async function post(bearer: string | undefined, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${bridgeUrl}/api/worktrees/agent`, { method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function cliRun(environment: NodeJS.ProcessEnv, ...args: string[]): Promise<any> {
  const { stdout } = await run(process.execPath, [cli, ...args], { env: { ...process.env, ...environment } });
  return JSON.parse(stdout);
}

test("the worktree bridge accepts only its own unexpired capability token", async () => {
  assert.equal((await post(undefined, { operation: "list" })).status, 401);
  assert.equal((await post("a".repeat(64), { operation: "list" })).status, 401);
  const { token } = await capability();
  assert.equal((await post(token, { operation: "list" })).status, 200);
  const { settingsDatabase } = await import("../src/settings-store.js");
  const digest = createHash("sha256").update(token).digest("hex");
  assert.ok(settingsDatabase().prepare("SELECT 1 FROM worktree_agent_tokens WHERE token_hash=?").get(digest));
  settingsDatabase().prepare("UPDATE worktree_agent_tokens SET expires_at=0 WHERE token_hash=?").run(digest);
  assert.equal((await post(token, { operation: "list" })).status, 401);
  const fresh = await capability();
  for (const [method, route] of [["GET", `/api/projects/${projectId}/worktrees`], ["POST", "/api/ntfy/agent"]] as const) {
    const response = await fetch(`${bridgeUrl}${route}`, { method, headers: { authorization: `Bearer ${fresh.token}`, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(response.status, 401, `${method} ${route}`);
  }
  for (const body of [{ operation: "create", name: "x", projectId: "other" }, { operation: "start", worktreeId: randomUUID() }, { operation: "pr" }, { operation: "merge", worktreeId: randomUUID() }]) {
    assert.equal((await post(fresh.token, body)).status, 400, JSON.stringify(body));
  }
});

test("an agent creates a worktree with .env and dependency links, and only its creator may delete it", async () => {
  const creator = await capability();
  const created = await cliRun(creator.environment, "create", "--name", "Fix crash in parser");
  const worktree = created.worktree;
  assert.equal(worktree.name, "Fix crash in parser");
  assert.equal(await readFile(path.join(worktree.path, ".env"), "utf8"), "API_KEY=local\n");
  assert.ok((await lstat(path.join(worktree.path, "node_modules"))).isSymbolicLink());
  assert.equal((await post(creator.token, { operation: "create", name: "fix crash in parser" })).status, 409, "names stay unique so a rerun finds the same issue's worktree");

  const listed = await cliRun(creator.environment, "list");
  const entry = listed.worktrees.find((candidate: { id: string }) => candidate.id === worktree.id);
  assert.deepEqual([entry.createdByThisConversation, entry.current, entry.pullRequest], [true, false, null]);

  const other = await capability();
  assert.equal((await post(other.token, { operation: "list" })).body.worktrees.find((candidate: { id: string }) => candidate.id === worktree.id).createdByThisConversation, false);
  const refused = await post(other.token, { operation: "delete", worktreeId: worktree.id });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /ask the user/);
  const noWorktree = await post(other.token, { operation: "pr", title: "Fix" });
  assert.equal(noWorktree.status, 400);
  assert.match(noWorktree.body.error, /--worktree/);
  assert.equal((await post(other.token, { operation: "start", worktreeId: randomUUID(), prompt: "Fix it" })).status, 404);

  assert.deepEqual(await cliRun(creator.environment, "delete", "--worktree", worktree.id), { deleted: worktree.id });
  assert.equal((await post(creator.token, { operation: "list" })).body.worktrees.some((candidate: { id: string }) => candidate.id === worktree.id), false);
});

test("a worktree cannot be deleted while a conversation started in it is still running", async () => {
  const { markWorktreeConversation } = await import("../src/project-worktrees.js");
  const { holdEndedRun, releaseEndedRun } = await import("../src/conversation-runtime.js");
  const creator = await capability();
  const { worktree } = (await post(creator.token, { operation: "create", name: `Running ${randomUUID().slice(0, 8)}` })).body;
  const child = randomUUID();
  await markWorktreeConversation(projectId, worktree.id, "claude", child);
  holdEndedRun("claude", child, false);
  try {
    const refused = await post(creator.token, { operation: "delete", worktreeId: worktree.id });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, new RegExp(`${child} is still running`));
  } finally { releaseEndedRun("claude", child); }
  assert.deepEqual((await post(creator.token, { operation: "delete", worktreeId: worktree.id })).body, { deleted: worktree.id });
});

test("a token for a project this node does not have is refused", async () => {
  const { token } = await capability(randomUUID(), "missing_project");
  assert.equal((await post(token, { operation: "list" })).status, 404);
});

test("start opens a new conversation inside the worktree with the caller's secret accounts and returns once its turn begins", async (context) => {
  const { WebSocketServer } = await import("ws");
  const { once } = await import("node:events");
  const { server } = await import("../src/server/state.js");
  const { saveSecretAccount, setScopeSecretAccounts, getScopeSecretAccounts } = await import("../src/secrets.js");
  const { worktreeAgentRequest } = await import("../src/server/worktree-agent.js");
  const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(endpoint, "listening");
  context.mock.method(server, "address", () => endpoint.address());
  const parent = randomUUID();
  const identity = { projectId, engine: "claude" as const, conversationId: parent, sessionId: parent };
  const account = await saveSecretAccount({ label: "Error log reader", provider: "custom", variables: [{ name: "LOG_TOKEN", kind: "value", value: "fixture" }] });
  await setScopeSecretAccounts("conversation", `claude:${parent}`, [account.id]);
  const { worktree } = await worktreeAgentRequest(identity, { operation: "create", name: `Issue ${parent.slice(0, 8)}` }) as { worktree: { id: string } };
  const connections: URL[] = [];
  const prompts: unknown[] = [];
  endpoint.on("connection", (socket, request) => {
    connections.push(new URL(request.url!, "ws://127.0.0.1"));
    socket.send(JSON.stringify({ type: "ready", status: { model: { provider: "anthropic", id: "claude" }, thinkingLevel: "default" } }));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      prompts.push(message);
      const queueId = randomUUID();
      socket.send(JSON.stringify({ type: "userMessage", queued: true, requestId: message.requestId, queueId }));
      // The turn starts and keeps running: start must not wait for it to complete.
      socket.send(JSON.stringify({ type: "promptStarted", queueId }));
    });
  });
  try {
    const started = await worktreeAgentRequest(identity, { operation: "start", worktreeId: worktree.id, prompt: "Fix the parser crash; finish with pr.", title: "Parser crash" }) as { conversationId: string; secretAccounts: number };
    assert.equal(started.secretAccounts, 1);
    assert.deepEqual((await getScopeSecretAccounts("conversation", `claude:${started.conversationId}`)).accountIds, [account.id]);
    assert.equal(connections.length, 1);
    assert.deepEqual(Object.fromEntries(["projectId", "sessionId", "sessionPath", "worktreeId"].map((key) => [key, connections[0].searchParams.get(key)])), {
      projectId, sessionId: started.conversationId, sessionPath: `draft:claude:${started.conversationId}`, worktreeId: worktree.id,
    });
    assert.deepEqual(prompts.map((prompt: any) => [prompt.type, prompt.message]), [["prompt", "Fix the parser crash; finish with pr."]]);
  } finally {
    for (const socket of endpoint.clients) socket.terminate();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
});
