import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "joint-bob-fork-")));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  const executable = path.join(root, "claude-fixture.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { access, appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const args = process.argv.slice(2), id = args[args.indexOf('--resume') + 1];
const transcript = path.join(${JSON.stringify(path.join(environment.home, ".claude/projects"))}, process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), id + '.jsonl');
const history = await readFile(transcript, 'utf8');
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
await appendFile(${JSON.stringify(path.join(root, "claude-calls.jsonl"))}, JSON.stringify({ args, id, history, prompt }) + '\\n');
await appendFile(transcript, JSON.stringify({ type: 'user', sessionId: id, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } }) + '\\n');
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: id, tools: ['Read', 'Bash'] }));
if (prompt.includes('hold original')) {
  await appendFile(transcript, JSON.stringify({ type: 'assistant', uuid: 'live-call', sessionId: id, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'pending-tool', name: 'Bash', input: {} }] } }) + '\\n' + '{"type":"user"');
  await appendFile(${JSON.stringify(path.join(root, "claude-held"))}, 'ready');
  for (;;) { try { await access(${JSON.stringify(path.join(root, "claude-release"))}); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
  await appendFile(transcript, ',"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"pending-tool","content":"done"}]}}\\n');
}
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

test("fork snapshots a running external Pi source without taking its runtime", async () => {
  const source = (await list()).find((session) => session.harnessId === "pi")!;
  const db = openPiRuntimeDatabase(node.dataDir);
  const runtime = { sessionId: source.id, transcriptPath: source.path, runId: randomUUID() };
  const count = (await list()).length;
  try {
    publishPiRuntime(db, runtime, true);
    const busy = await fork(source);
    assert.equal(busy.status, 201, JSON.stringify(busy.body));
    assert.equal((await list()).length, count + 1);
    assert.equal((await list()).find((session) => session.id === source.id)!.running, true);
    assert.equal((await list()).find((session) => session.id === busy.body.session.id)!.running, false);
    const snapshot = await readFile(file(busy.body.session), "utf8");
    SessionManager.open(source.path).appendMessage({ role: "user", content: "source continues independently", timestamp: Date.now() });
    assert.equal(await readFile(file(busy.body.session), "utf8"), snapshot);
  } finally { publishPiRuntime(db, runtime, false); db.close(); }
  assert.equal((await fork(source, node.projects[1].id)).status, 404);
});

test("active Claude forks before an unfinished tool and partial JSONL write, then keeps running", async () => {
  const source = (await list()).find((session) => session.harnessId === "claude" && !session.readOnly && !session.title.startsWith("[F]"))!;
  const opened = await connect(source);
  opened.socket.send(JSON.stringify({ type: "prompt", message: "hold original" }));
  const deadline = Date.now() + 10_000;
  while (!(await stat(path.join(root, "claude-held")).catch(() => null))) {
    assert.ok(Date.now() < deadline, `Claude fixture reached its live tool call: ${JSON.stringify(opened.messages.filter((message) => !["ready", "messages"].includes(message.type)))}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try {
    const before = await readFile(file(source), "utf8");
    const result = await fork(source);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const copied = await readFile(file(result.body.session), "utf8");
    assert.ok(copied.includes("hold original"), "completed user entry is retained");
    assert.ok(!copied.includes("pending-tool"), "unfinished tool use is not resumable history");
    assert.equal(await readFile(file(source), "utf8"), before);
    assert.equal(opened.messages.some((message) => message.type === "agent_end"), false);
    const copyChat = await connect(result.body.session);
    copyChat.socket.send(JSON.stringify({ type: "prompt", message: "independent fork turn" }));
    await copyChat.wait((message) => message.type === "agent_end");
    assert.equal(opened.messages.some((message) => message.type === "agent_end"), false, "fork resumes while source stays active");
    const resumed = await readFile(file(result.body.session), "utf8");
    await writeFile(path.join(root, "claude-release"), "");
    await opened.wait((message) => message.type === "agent_end");
    assert.ok((await readFile(file(source), "utf8")).includes('"content":"done"'));
    assert.equal(await readFile(file(result.body.session), "utf8"), resumed);
  } finally {
    await writeFile(path.join(root, "claude-release"), "");
    await opened.wait((message) => message.type === "agent_end");
  }
});

for (const engine of ["pi", "claude"] as const) for (const ending of ["unfinished call", "orphan result"] as const) {
  test(`${engine} snapshot keeps completed tool pairs but omits ${ending} and queued work`, async () => {
    const source = (await list()).find((session) => session.harnessId === engine && !session.readOnly && !session.title.startsWith("[F]"))!;
    const before = await readFile(file(source), "utf8");
    const records = engine === "pi" ? [
      { role: "assistant", content: [{ type: "toolCall", id: "complete", name: "read", arguments: {} }] },
      { role: "toolResult", toolCallId: "complete", content: [{ type: "text", text: "completed result" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "unfinished", name: "read", arguments: {} }] },
    ] : [
      { role: "assistant", content: [{ type: "tool_use", id: "complete", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "complete", content: "completed result" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "unfinished", name: "Read", input: {} }] },
    ];
    if (ending === "orphan result") records[2] = engine === "pi"
      ? { role: "toolResult", toolCallId: "unfinished", content: [{ type: "text", text: "orphan result" }] }
      : { role: "user", content: [{ type: "tool_result", tool_use_id: "unfinished", content: "orphan result" }] };
    try {
      if (engine === "pi") {
        const manager = SessionManager.open(file(source));
        for (const message of records) manager.appendMessage({ ...message, timestamp: Date.now() } as Parameters<SessionManager["appendMessage"]>[0]);
      } else {
        await appendFile(file(source), JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "pending prompt" }) + "\n");
        await appendFile(file(source), records.map((message) => JSON.stringify({ type: message.role, uuid: randomUUID(), sessionId: source.id, message })).join("\n") + "\n");
      }
      await appendFile(file(source), '{"type":');
      const result = await fork(source);
      assert.equal(result.status, 201, JSON.stringify(result.body));
      const copied = await readFile(file(result.body.session), "utf8");
      assert.ok(copied.includes("completed result"));
      assert.ok(!copied.includes("unfinished"));
      assert.ok(!copied.includes("pending prompt"));
      if (engine === "pi") assert.equal(SessionManager.open(file(result.body.session)).buildSessionContext().messages.at(-1)!.role, "toolResult");
    } finally { await writeFile(file(source), before); }
  });
}

for (const engine of ["pi", "claude"] as const) {
  test(`${engine} fork retains a complete final JSON record without a newline`, async () => {
    const source = (await list()).find((session) => session.harnessId === engine && !session.readOnly && !session.title.startsWith("[F]"))!;
    const before = await readFile(file(source), "utf8");
    try {
      if (engine === "pi") {
        SessionManager.open(file(source)).appendMessage({ role: "user", content: "complete final record", timestamp: Date.now() });
        await writeFile(file(source), (await readFile(file(source), "utf8")).trimEnd());
      } else await appendFile(file(source), JSON.stringify({ type: "user", message: { role: "user", content: "complete final record" } }));
      const result = await fork(source);
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.ok((await readFile(file(result.body.session), "utf8")).includes("complete final record"));
    } finally { await writeFile(file(source), before); }
  });
}

for (const compacted of [false, true]) {
  test(`Claude fork selects replacement history before balancing tools${compacted ? " across compaction" : ""}`, async () => {
    const source = (await list()).find((session) => session.harnessId === "claude" && !session.readOnly && !session.title.startsWith("[F]"))!;
    const before = await readFile(file(source), "utf8");
    const records = [
      { type: "user", uuid: "root", parentUuid: null, message: { role: "user", content: "original prompt" } },
      { type: "assistant", uuid: "abandoned", parentUuid: "root", message: { role: "assistant", content: [{ type: "tool_use", id: "abandoned-call", name: "Read", input: {} }] } },
      ...(compacted ? [{ type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: null, logicalParentUuid: "abandoned", compactMetadata: { trigger: "auto", preTokens: 1000 } },
        { type: "user", uuid: "summary", parentUuid: "boundary", isCompactSummary: true, message: { role: "user", content: "compacted context" } }] : []),
      { type: "user", uuid: "replacement", parentUuid: compacted ? "summary" : "root", message: { role: "user", content: "replacement prompt" } },
      { type: "assistant", uuid: "call", parentUuid: "replacement", message: { role: "assistant", content: [{ type: "tool_use", id: "good-call", name: "Read", input: {} }] } },
      { type: "user", uuid: "result", parentUuid: "call", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "good-call", content: "good result" }] } },
      { type: "assistant", uuid: "reply", parentUuid: "result", message: { role: "assistant", content: "completed replacement reply" } },
      { type: "custom-title", customTitle: "Branch fixture" },
    ].map((record) => ({ ...record, sessionId: source.id, cwd: node.projects[0].path }));
    const snapshot = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    const sidecar = path.join(path.dirname(file(source)), source.id, "subagents", "agent-branch.jsonl");
    try {
      await writeFile(file(source), snapshot);
      await mkdir(path.dirname(sidecar), { recursive: true });
      await writeFile(sidecar, snapshot);
      const result = await fork(source);
      assert.equal(result.status, 201, JSON.stringify(result.body));
      const copy = result.body.session;
      for (const copiedPath of [file(copy), path.join(path.dirname(file(copy)), copy.id, "subagents", "agent-branch.jsonl")]) {
        const copied = (await readFile(copiedPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        assert.deepEqual(copied.filter((entry) => entry.uuid).map((entry) => entry.uuid),
          [...(compacted ? ["boundary", "summary"] : ["root"]), "replacement", "call", "result", "reply"]);
        assert.equal(copied.find((entry) => entry.uuid === "reply").message.content, "completed replacement reply");
      }
      assert.equal(await readFile(file(source), "utf8"), snapshot);
      assert.equal(await readFile(sidecar, "utf8"), snapshot);
    } finally {
      await writeFile(file(source), before);
      await rm(sidecar);
    }
  });
}

test("cold Pi v1 fork migrates only its snapshot and retains history and settings", async () => {
  const source = (await list()).find((session) => session.harnessId === "pi" && !session.readOnly && !session.title.startsWith("[F]"))!;
  const before = await readFile(file(source), "utf8");
  const timestamp = new Date().toISOString();
  const records = [
    { type: "session", version: 1, id: source.id, cwd: node.projects[0].path, timestamp },
    { type: "model_change", provider: "anthropic", modelId: "claude-sonnet-4-5", timestamp },
    { type: "thinking_level_change", thinkingLevel: "high", timestamp },
    { type: "message", timestamp, message: { role: "user", content: "legacy prompt", timestamp: Date.now() } },
    { type: "message", timestamp, message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", content: [{ type: "text", text: "legacy reply" }], timestamp: Date.now() } },
  ];
  const snapshot = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  try {
    await writeFile(file(source), snapshot);
    const result = await fork(source);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const manager = SessionManager.open(file(result.body.session));
    const context = manager.buildSessionContext();
    assert.deepEqual(context.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(context.messages[0].content, "legacy prompt");
    assert.deepEqual(context.model, { provider: "anthropic", modelId: "claude-sonnet-4-5" });
    assert.equal(context.thinkingLevel, "high");
    const branch = manager.getBranch();
    assert.deepEqual(branch.map((entry) => entry.type), ["model_change", "thinking_level_change", "message", "message", "session_info"]);
    for (const [index, entry] of branch.entries()) {
      assert.equal(typeof entry.id, "string");
      assert.equal(entry.parentId, index ? branch[index - 1].id : null);
    }
    assert.equal(await readFile(file(source), "utf8"), snapshot, "SDK migration must never open or rewrite source");
  } finally { await writeFile(file(source), before); }
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
  await appendFile(source.path, '{"type":"message"\n');
  try {
    const result = await fork(source);
    assert.equal(result.status, 409);
  } finally { await writeFile(source.path, before); }
});
