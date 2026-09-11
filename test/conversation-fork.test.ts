import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";
import WebSocket from "ws";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { sessionSafeguardsEnabled, sessionToolSelection } from "../src/pi-service.js";
import { openPiRuntimeDatabase, publishPiRuntime } from "../src/pi-runtime.js";
import type { SessionSummary } from "../src/types.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

let root: string, environment: DevEnvironment, node: SeededNode, server: ChildProcess, auth: SignedIn;
const sockets: WebSocket[] = [];
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-fork-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  const executable = path.join(root, "claude-fixture.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const args = process.argv.slice(2), id = args[args.indexOf('--resume') + 1];
const transcript = path.join(${JSON.stringify(path.join(environment.home, ".claude/projects"))}, process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), id + '.jsonl');
const history = await readFile(transcript, 'utf8');
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
await appendFile(${JSON.stringify(path.join(root, "claude-calls.jsonl"))}, JSON.stringify({ args, id, history, prompt }) + '\\n');
await appendFile(transcript, JSON.stringify({ type: 'user', sessionId: id, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } }) + '\\n');
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: id, tools: ['Read', 'Bash'] }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'fixture reply' }] } }));
console.log(JSON.stringify({ type: 'result', is_error: false, session_id: id }));
`, { mode: 0o755 });
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  db.prepare("UPDATE node_settings SET value = ? WHERE key = 'claude.executable'").run(executable);
  db.close();
  server = await startDevNode(environment, node);
  auth = await signIn(environment, node);
}, { timeout: 120_000 });
after(async () => {
  for (const socket of sockets) socket.terminate();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});
const file = (session: SessionSummary) => session.path.replace(/^claude:/, "");
async function list(projectId = node.projects[0].id) {
  return (await api<{ sessions: SessionSummary[] }>(node, auth, "GET", `/projects/${projectId}/sessions`)).body.sessions;
}
async function fork(source: SessionSummary, projectId = node.projects[0].id) {
  const response = await fetch(`${node.url}/api/projects/${projectId}/sessions/fork`, {
    method: "POST", headers: { Cookie: auth.cookie, "x-csrf-token": auth.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ engine: source.harnessId, sessionId: source.id }),
  });
  const text = await response.text();
  return { status: response.status, body: (text.startsWith("{") ? JSON.parse(text) : { error: `Fork endpoint returned ${response.status}` }) as { session: SessionSummary; error?: string } };
}
async function connect(source: SessionSummary) {
  const url = new URL("/ws", node.url);
  url.protocol = "ws:";
  url.searchParams.set("projectId", node.projects[0].id);
  url.searchParams.set("sessionId", source.id);
  url.searchParams.set("sessionPath", source.path);
  const socket = new WebSocket(url, { origin: node.url, headers: { Cookie: auth.cookie } });
  sockets.push(socket);
  const messages: any[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  const wait = async (predicate: (message: any) => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!messages.some(predicate)) {
      assert.ok(Date.now() < deadline, `Waiting for socket event: ${JSON.stringify(messages.filter((message) => !["ready", "messages"].includes(message.type)).slice(-5))}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return messages.find(predicate);
  };
  const ready = await wait((message) => message.type === "ready");
  return { socket, messages, ready, wait };
}

for (const engine of ["pi", "claude"] as const) {
  test(`${engine} fork copies resumable history and settings into independent identities`, async () => {
    const source = (await list()).find((session) => session.harnessId === engine && !session.title.startsWith("[F]"))!;
    const sourcePath = file(source);
    if (engine === "pi") {
      const manager = SessionManager.open(sourcePath);
      manager.appendModelChange("anthropic", "claude-sonnet-4-5");
      manager.appendThinkingLevelChange("high");
      manager.appendCustomEntry("joint-bob:safeguards", { enabled: false });
      manager.appendCustomEntry("joint-bob:tools", { enabledTools: ["read"] });
      manager.appendCustomMessageEntry("context", "keep hidden context", false);
    } else {
      const records = (await readFile(sourcePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      for (const [index, record] of records.entries()) {
        record.sessionId = source.id;
        record.parentUuid = index ? records[index - 1].uuid ?? null : null;
      }
      records.push({ type: "system", subtype: "compact_boundary", sessionId: source.id, cwd: node.projects[0].path, compactMetadata: { trigger: "manual", preTokens: 1000 } });
      await writeFile(sourcePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
      const sidecar = path.join(path.dirname(sourcePath), source.id, "subagents");
      await mkdir(sidecar, { recursive: true });
      await writeFile(path.join(sidecar, "agent-worker.jsonl"), JSON.stringify({ type: "assistant", sessionId: source.id, cwd: node.projects[0].path, message: { role: "assistant", content: "worker context" } }) + "\n");
      const live = await connect(source);
      live.socket.send(JSON.stringify({ type: "prompt", message: "Initialize source tools" }));
      await live.wait((message) => message.type === "agent_end");
      live.socket.send(JSON.stringify({ type: "setTools", toolNames: ["Read"] }));
      await live.wait((message) => message.type === "tools" && message.tools?.some((tool: any) => tool.name === "Bash" && !tool.active));
      live.socket.send(JSON.stringify({ type: "setModel", modelId: "sonnet" }));
      await live.wait((message) => message.type === "status" && message.status?.model?.id === "sonnet");
      live.socket.send(JSON.stringify({ type: "setEffort", effort: "high" }));
      await live.wait((message) => message.type === "status" && message.status?.thinkingLevel === "high");
    }
    await api(node, auth, "PUT", `/projects/${node.projects[0].id}/sessions/title`, { engine, sessionId: source.id, title: "Source name" });
    await api(node, auth, "PUT", `/projects/${node.projects[0].id}/sessions/color`, { engine, sessionId: source.id, color: "blue" });
    const classified = await api(node, auth, "PUT", `/projects/${node.projects[0].id}/sessions/classification`, { engine, sessionId: source.id, classification: "Investigation" });
    assert.equal(classified.status, 200);
    const account = await api<{ account: { id: string } }>(node, auth, "POST", "/secrets/accounts", { label: `Fork ${engine}`, provider: "custom", variables: [{ name: "FORK_TEST", kind: "value", value: "test-only" }] });
    assert.equal(account.status, 201);
    await api(node, auth, "PUT", `/secrets/scopes/conversation/${engine}:${source.id}`, { accountIds: [account.body.account.id] });
    const before = await readFile(sourcePath, "utf8");
    const result = await fork(source);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const copy = result.body.session;
    assert.notEqual(copy.id, source.id);
    assert.notEqual(copy.path, source.path);
    assert.equal(copy.title, "[F] Source name");
    assert.equal(copy.color, "blue");
    assert.equal(copy.classification, "Investigation");
    assert.equal(copy.taskId, undefined);
    assert.equal(copy.parentSessionPath, undefined);
    assert.equal(copy.executionNodeId, node.nodeId);
    assert.notEqual((await stat(file(copy))).ino, (await stat(sourcePath)).ino);
    const secrets = await api<{ accountIds: string[] }>(node, auth, "GET", `/secrets/scopes/conversation/${engine}:${copy.id}`);
    assert.deepEqual(secrets.body.accountIds, [account.body.account.id]);
    if (engine === "pi") {
      const original = SessionManager.open(sourcePath);
      const cloned = SessionManager.open(file(copy));
      assert.deepEqual(cloned.buildSessionContext(), original.buildSessionContext());
      assert.equal(sessionSafeguardsEnabled(cloned), false);
      assert.deepEqual(sessionToolSelection(cloned), ["read"]);
      cloned.appendMessage({ role: "user", content: "fork-only turn", timestamp: Date.now() });
    } else {
      const records = (await readFile(file(copy), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(records.filter((record) => record.sessionId).every((record) => record.sessionId === copy.id));
      assert.ok(records.some((record) => record.subtype === "compact_boundary"));
      const sidecar = path.join(path.dirname(file(copy)), copy.id, "subagents", "agent-worker.jsonl");
      assert.equal(JSON.parse(await readFile(sidecar, "utf8")).sessionId, copy.id);
      const opened = await connect(copy);
      assert.equal(opened.ready.status.model.id, "sonnet");
      assert.equal(opened.ready.status.thinkingLevel, "high");
      assert.ok(opened.ready.messages.length > 0);
      assert.deepEqual(opened.ready.status.activeTools, ["Read"], "fork restores source tool restriction");
      opened.socket.send(JSON.stringify({ type: "prompt", message: "fork-only turn" }));
      await opened.wait((message) => message.type === "agent_end");
      const calls = (await readFile(path.join(root, "claude-calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const call = calls.at(-1);
      assert.equal(call.id, copy.id, "provider resumes the fork identity");
      assert.ok(call.history.includes("Initialize source tools"), "provider receives copied history");
      assert.ok(call.args.includes("--tools") && call.args.includes("Read"));
    }
    assert.equal(await readFile(sourcePath, "utf8"), before, "fork writes must not change source");
    await api(node, auth, "PUT", `/secrets/scopes/conversation/${engine}:${copy.id}`, { accountIds: [] });
    assert.deepEqual((await api<{ accountIds: string[] }>(node, auth, "GET", `/secrets/scopes/conversation/${engine}:${source.id}`)).body.accountIds, [account.body.account.id]);
    assert.ok((await list()).some((session) => session.id === copy.id));
  });
}

test("fork rejects running sources and wrong-project identities without creating records", async () => {
  const source = (await list()).find((session) => session.harnessId === "pi")!;
  const db = openPiRuntimeDatabase(node.dataDir);
  const runtime = { sessionId: source.id, transcriptPath: source.path, runId: randomUUID() };
  const count = (await list()).length;
  try {
    publishPiRuntime(db, runtime, true);
    const busy = await fork(source);
    assert.equal(busy.status, 409);
    assert.match(busy.body.error!, /finish|busy|running/i);
    assert.equal((await list()).length, count);
  } finally { publishPiRuntime(db, runtime, false); db.close(); }
  assert.equal((await fork(source, node.projects[1].id)).status, 404);
});

test("fork copies every switched segment and preserves an empty active draft", async () => {
  const source = (await list()).find((session) => session.harnessId === "pi" && !session.title.startsWith("[F]"))!;
  const draftId = randomUUID();
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  try {
    const now = new Date().toISOString();
    const save = db.prepare("INSERT OR REPLACE INTO conversation_records (project_id, engine, session_id, created_at, updated_at, origin_node_id, task_id, conversation_id, segment_index) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)");
    save.run(node.projects[0].id, "pi", source.id, now, now, node.nodeId, source.id, 0);
    save.run(node.projects[0].id, "claude", draftId, now, now, node.nodeId, source.id, 1);
  } finally { db.close(); }
  const switched = (await list()).find((session) => session.id === draftId)!;
  const result = await fork(switched);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const copy = result.body.session;
  assert.equal(copy.draft, true);
  assert.equal(copy.segments?.length, 2);
  assert.notEqual(copy.conversationId, source.id);
  assert.notEqual(copy.segments![0].path, source.path);
  assert.notEqual(copy.segments![1].sessionId, draftId);
  const opened = await connect(copy);
  assert.ok(opened.ready.messages.length > 0, "draft fork must retain previous harness history");
  assert.equal(opened.ready.segments.length, 2);
});

test("malformed transcripts fail without publishing a partial fork", async () => {
  const source = (await list()).find((session) => session.harnessId === "pi" && !session.segments)!;
  const before = await readFile(source.path, "utf8");
  await appendFile(source.path, '{"type":"message"');
  try {
    const result = await fork(source);
    assert.equal(result.status, 409);
  } finally { await writeFile(source.path, before); }
});
