import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import WebSocket from "ws";
import { claudeProjectDir } from "../src/harnesses/claude/paths.js";
import { resolveDataDirectory } from "../src/data-directory.js";
import { supervisorRequest } from "../scripts/supervisor-client.mjs";
import { acknowledgeSystemPrompt, beginQueuedPrompt, claimQueuedPrompt, enqueueSystemPrompt, listPendingSystemQueues, listQueuedPrompts, systemPromptState } from "../src/prompt-queue.js";
import { api, projectNamed, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { backgroundFixture, closeBackgroundFixture, startSyntheticTask } from "./background-tasks-fixture.js";

async function waitFor<T>(read: () => T | Promise<T>, ready: (value: T) => boolean, label: string, attempts = 200): Promise<T> {
  let value!: T;
  for (let attempt = 0; attempt < attempts; attempt++) {
    value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
}

async function openSeededPi(f: Awaited<ReturnType<typeof backgroundFixture>>): Promise<{
  socket: WebSocket; messages: Record<string, unknown>[]; projectId: string; conversationId: string; transcriptPath: string;
}> {
  const session = await signIn(f.environment, f.node);
  const project = projectNamed(f.node, "Internal Assistant");
  const listed = await api<{ sessions: Array<{ id: string; path: string; harnessId: string }> }>(f.node, session, "GET", `/projects/${project.id}/sessions`);
  const target = listed.body.sessions.find((value) => value.harnessId === "pi")!;
  const messages: Record<string, unknown>[] = [];
  const url = new URL("/ws", f.node.url.replace(/^http/, "ws"));
  url.searchParams.set("projectId", project.id); url.searchParams.set("sessionPath", target.path);
  const socket = new WebSocket(url, { headers: { Cookie: session.cookie, Origin: f.node.url } });
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
  socket.once("error", () => {});
  const ready = await waitFor(() => messages.find((frame) => frame.type === "ready"), Boolean, "conversation socket readiness");
  const records = new DatabaseSync(path.join(f.node.dataDir, "node.db"), { readOnly: true });
  const record = records.prepare("SELECT conversation_id FROM conversation_records WHERE project_id=? AND session_id=?").get(project.id, target.id) as { conversation_id: string | null } | undefined;
  records.close();
  return { socket, messages, projectId: project.id, conversationId: record?.conversation_id ?? String(ready!.conversationId ?? target.id), transcriptPath: target.path };
}

async function taskCompleted(dataDir: string, id: string): Promise<boolean> {
  const row = await supervisorRequest<{ status: string }>(dataDir, { action: "task", id });
  return row.status === "completed";
}

function seedNode(): void {
  const directory = resolveDataDirectory();
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, "node.db"));
  db.exec("CREATE TABLE IF NOT EXISTS cluster_node (singleton INTEGER PRIMARY KEY, id TEXT NOT NULL); DELETE FROM cluster_node");
  db.prepare("INSERT INTO cluster_node VALUES (1, ?)").run(randomUUID());
  db.close();
}

test("system queue observation does not create or migrate chat state", () => {
  seedNode();
  const file = path.join(resolveDataDirectory(), "node.db");
  const tables = (): string[] => {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name); }
    finally { db.close(); }
  };
  const before = tables();
  assert.equal(before.includes("queued_prompts"), false);
  assert.deepEqual(listPendingSystemQueues(), []);
  assert.deepEqual(tables(), before);
});

test("system completion enqueue is idempotent through queued and consumed states", () => {
  seedNode();
  const id = randomUUID();
  const key = `${randomUUID()}:${randomUUID()}`;
  assert.equal(enqueueSystemPrompt(key, id, "completion"), "queued");
  assert.equal(enqueueSystemPrompt(key, id, "different retry text"), "queued");
  assert.equal(listQueuedPrompts(key).length, 1);
  assert.deepEqual(listPendingSystemQueues(), [{ queueKey: key, id }]);
  assert.equal(systemPromptState(key, id), "pending");
  assert.equal(claimQueuedPrompt(id), true);
  assert.equal(enqueueSystemPrompt(key, id, "late retry"), "consumed");
  assert.equal(systemPromptState(key, id), "consumed");
  assert.equal(listQueuedPrompts(key).length, 0);
});

test("uncertain automatic starts do not starve pending completion queues", () => {
  seedNode();
  const key = `${randomUUID()}:uncertain`;
  for (let index = 0; index < 100; index++) {
    const id = randomUUID();
    enqueueSystemPrompt(key, id, `uncertain-${index}`);
    const prompt = listQueuedPrompts(key).find((value) => value.id === id)!;
    assert.equal(beginQueuedPrompt(id, prompt.revision), true);
    assert.equal(enqueueSystemPrompt(key, id, "retry"), "queued");
    assert.equal(systemPromptState(key, id), "starting");
  }
  const pending = randomUUID();
  enqueueSystemPrompt(key, pending, "pending");
  assert.deepEqual(listPendingSystemQueues(1), [{ queueKey: key, id: pending }]);
});

test("headless completion runs once and remains fenced across app restart", async () => {
  const f = await backgroundFixture((root) => ({ JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") }));
  try {
    const session = await signIn(f.environment, f.node);
    const project = projectNamed(f.node, "Internal Assistant");
    const listed = await api<{ sessions: Array<{ id: string; path: string; harnessId: string }> }>(f.node, session, "GET", `/projects/${project.id}/sessions`);
    const target = listed.body.sessions.find((value) => value.harnessId === "pi")!;
    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const url = new URL("/ws", f.node.url.replace(/^http/, "ws"));
      url.searchParams.set("projectId", project.id); url.searchParams.set("sessionPath", target.path);
      const socket = new WebSocket(url, { headers: { Cookie: session.cookie, Origin: f.node.url } });
      const timeout = setTimeout(() => reject(new Error("conversation socket did not become ready")), 15_000);
      socket.on("message", (raw) => { const frame = JSON.parse(String(raw)) as Record<string, unknown>; if (frame.type === "ready") { clearTimeout(timeout); socket.close(); resolve(frame); } });
      socket.once("error", reject);
    });
    const records = new DatabaseSync(path.join(f.node.dataDir, "node.db"), { readOnly: true });
    const record = records.prepare("SELECT conversation_id FROM conversation_records WHERE project_id=? AND session_id=?").get(project.id, target.id) as { conversation_id: string | null } | undefined;
    records.close();
    const conversationId = record?.conversation_id ?? String(ready.conversationId ?? target.id);
    const taskId = randomUUID();
    await startSyntheticTask(f, project.id, conversationId, taskId);
    const logFile = path.join(f.root, "engine.log");
    let log = "";
    for (let attempt = 0; attempt < 200; attempt++) {
      try { log = await readFile(logFile, "utf8"); } catch { /* not created yet */ }
      if (log.trim().split("\n").filter(Boolean).length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const diagnosticDb = new DatabaseSync(path.join(f.node.dataDir, "node.db"), { readOnly: true });
    const diagnostic = diagnosticDb.prepare("SELECT delivery_state,target_node_id,error FROM background_completion_outbox WHERE task_id=?").get(taskId);
    diagnosticDb.close();
    assert.equal(log.trim().split("\n").filter(Boolean).length, 1, `headless wake must run exactly once: ${JSON.stringify(diagnostic)}`);
    let transcript = "";
    for (let attempt = 0; attempt < 200; attempt++) {
      transcript = await readFile(target.path, "utf8");
      if (transcript.includes(taskId) && transcript.includes("stubbed response")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(transcript.split(taskId).length - 1, 1);
    assert.match(transcript, /stubbed response/);
    assert.doesNotMatch(transcript, /safe-output/);
    await stopDevNode(f.server);
    f.server = await startDevNode(f.environment, f.node, { JOINT_BOB_TEST_ENGINE_LOG: logFile });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal((await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean).length, 1, "restart must not redeliver consumed completion");
  } finally { await closeBackgroundFixture(f); }
});

test("completion during app downtime wakes once after restart", async () => {
  const f = await backgroundFixture((root) => ({ JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") }));
  let setup: Awaited<ReturnType<typeof openSeededPi>> | undefined;
  try {
    setup = await openSeededPi(f);
    setup.socket.close();
    await stopDevNode(f.server);
    const first = randomUUID();
    await startSyntheticTask(f, setup.projectId, setup.conversationId, first);
    await waitFor(() => taskCompleted(f.node.dataDir, first), Boolean, "supervisor task completion");
    await assert.rejects(readFile(path.join(f.root, "engine.log")), /ENOENT/, "a stopped app cannot dispatch a completion");

    const env = { JOINT_BOB_TEST_ENGINE_LOG: path.join(f.root, "engine.log") };
    f.server = await startDevNode(f.environment, f.node, env);
    await waitFor(async () => { try { return await readFile(setup!.transcriptPath, "utf8"); } catch { return ""; } }, (text) => text.includes(first), "restarted app completion transcript");
    await waitFor(async () => { try { return (await readFile(env.JOINT_BOB_TEST_ENGINE_LOG, "utf8")).trim().split("\n").filter(Boolean).length; } catch { return 0; } }, (count) => count === 1, "first completion engine run");
    await waitFor(() => {
      const db = new DatabaseSync(path.join(f.node.dataDir, "node.db"), { readOnly: true });
      try { return (db.prepare("SELECT delivery_state FROM background_completion_outbox WHERE task_id=?").get(first) as { delivery_state?: string } | undefined)?.delivery_state; }
      finally { db.close(); }
    }, (state) => state === "queued", "queued completion delivery state");

    await stopDevNode(f.server);
    f.server = await startDevNode(f.environment, f.node, env);
    const sentinel = randomUUID();
    await startSyntheticTask(f, setup.projectId, setup.conversationId, sentinel);
    await waitFor(async () => { try { return await readFile(setup!.transcriptPath, "utf8"); } catch { return ""; } }, (text) => text.includes(sentinel), "post-restart scheduler sentinel");
    const transcript = await readFile(setup.transcriptPath, "utf8");
    assert.equal(transcript.split(first).length - 1, 1, "restart must not redeliver the first completion");
    assert.equal((await readFile(env.JOINT_BOB_TEST_ENGINE_LOG, "utf8")).trim().split("\n").filter(Boolean).length, 2);
  } finally {
    setup?.socket.terminate();
    await closeBackgroundFixture(f);
  }
});

test("connected long follow-up does not block another conversation completion", async () => {
  const f = await backgroundFixture((root) => ({
    JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log"),
    JOINT_BOB_TEST_ENGINE_HOLD_DIR: root,
  }));
  let pi: Awaited<ReturnType<typeof openSeededPi>> | undefined;
  let claudeSocket: WebSocket | undefined;
  try {
    await writeFile(path.join(f.root, "claude.release"), "release");
    pi = await openSeededPi(f);
    const session = await signIn(f.environment, f.node);
    const project = projectNamed(f.node, "Internal Assistant");
    const listed = await api<{ sessions: Array<{ id: string; path: string; harnessId: string }> }>(f.node, session, "GET", `/projects/${project.id}/sessions`);
    const claude = listed.body.sessions.find((value) => value.harnessId === "claude")!;
    const claudeMessages: Record<string, unknown>[] = [];
    const url = new URL("/ws", f.node.url.replace(/^http/, "ws"));
    url.searchParams.set("projectId", project.id); url.searchParams.set("sessionPath", claude.path);
    claudeSocket = new WebSocket(url, { headers: { Cookie: session.cookie, Origin: f.node.url } });
    claudeSocket.on("message", (raw) => claudeMessages.push(JSON.parse(String(raw)) as Record<string, unknown>));
    const ready = await waitFor(() => claudeMessages.find((frame) => frame.type === "ready"), Boolean, "Claude conversation readiness");
    const claudeConversationId = String(ready!.conversationId);
    claudeSocket.close();
    await new Promise<void>((resolve) => claudeSocket!.once("close", resolve));

    const firstTask = randomUUID();
    await startSyntheticTask(f, pi.projectId, pi.conversationId, firstTask);
    const logFile = path.join(f.root, "engine.log");
    await waitFor(async () => { try { return await readFile(logFile, "utf8"); } catch { return ""; } }, (text) => text.includes("pi:"), "held Pi completion follow-up");

    const secondTask = randomUUID();
    const started = Date.now();
    await startSyntheticTask(f, project.id, claudeConversationId, secondTask);
    const claudeTranscript = path.join(claudeProjectDir(project.path, path.join(f.environment.home, ".claude/projects")), `${String(ready!.sessionId)}.jsonl`);
    await waitFor(async () => { try { return await readFile(claudeTranscript, "utf8"); } catch { return ""; } }, (text) => text.includes(secondTask), "independent Claude completion", 240);
    const log = await readFile(logFile, "utf8");
    assert.match(log, /claude:/, "Claude follow-up must start while Pi remains held");
    assert.ok(Date.now() - started <= 6_000, "Claude completion must not wait for the ten-second Pi hold deadline");
    const db = new DatabaseSync(path.join(f.node.dataDir, "node.db"), { readOnly: true });
    const delivery = db.prepare("SELECT delivery_state FROM background_completion_outbox WHERE task_id=?").get(firstTask) as { delivery_state?: string } | undefined;
    db.close();
    assert.equal(delivery?.delivery_state, "queued", "durable queue insertion must ACK before the Pi model turn finishes");

    await writeFile(path.join(f.root, "pi.release"), "release");
    await waitFor(() => readFile(pi!.transcriptPath, "utf8"), (text) => text.includes(firstTask), "released Pi completion transcript");
  } finally {
    claudeSocket?.terminate();
    pi?.socket.terminate();
    await writeFile(path.join(f.root, "pi.release"), "release").catch(() => {});
    await closeBackgroundFixture(f);
  }
});

test("completion waits for busy conversation", async () => {
  const f = await backgroundFixture((root) => ({
    JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log"),
    JOINT_BOB_TEST_ENGINE_HOLD_DIR: root,
  }));
  let setup: Awaited<ReturnType<typeof openSeededPi>> | undefined;
  try {
    setup = await openSeededPi(f);
    setup.socket.send(JSON.stringify({ type: "prompt", message: "held human turn", requestId: randomUUID() }));
    await waitFor(() => setup!.messages.some((frame) => frame.type === "promptStarted"), Boolean, "held human prompt start");
    const logFile = path.join(f.root, "engine.log");
    await waitFor(async () => { try { return (await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean).length; } catch { return 0; } }, (count) => count === 1, "held human engine run");

    const taskId = randomUUID();
    await startSyntheticTask(f, setup.projectId, setup.conversationId, taskId);
    await waitFor(() => taskCompleted(f.node.dataDir, taskId), Boolean, "background task completion");
    await waitFor(() => {
      const db = new DatabaseSync(path.join(f.node.dataDir, "node.db"), { readOnly: true });
      try { return Boolean(db.prepare("SELECT 1 FROM queued_prompts WHERE queue_key=? AND json_extract(prompt,'$.systemEventId') IS NOT NULL").get(`${setup!.projectId}:${setup!.conversationId}`)); }
      finally { db.close(); }
    }, Boolean, "system completion in logical prompt queue");
    assert.equal((await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean).length, 1, "completion must not overlap the human turn");

    await writeFile(path.join(f.root, "pi.release"), "release");
    const transcript = await waitFor(() => readFile(setup!.transcriptPath, "utf8"), (text) => text.includes("held human turn") && text.includes(taskId), "ordered human and completion transcript");
    assert.ok(transcript.indexOf("held human turn") < transcript.indexOf(taskId));
    assert.equal(transcript.split(taskId).length - 1, 1);
    assert.equal((await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean).length, 2);
  } finally {
    setup?.socket.terminate();
    await writeFile(path.join(f.root, "pi.release"), "release").catch(() => {});
    await closeBackgroundFixture(f);
  }
});

test("a completion id cannot be reused for another conversation", () => {
  seedNode();
  const id = randomUUID();
  enqueueSystemPrompt(`${randomUUID()}:one`, id, "completion");
  assert.throws(() => enqueueSystemPrompt(`${randomUUID()}:two`, id, "completion"), /different queue/);
});

test("acknowledged completion prompts stay consumed before or after enqueue", () => {
  seedNode();
  for (const enqueueFirst of [false, true]) {
    const id = randomUUID();
    const key = `${randomUUID()}:${randomUUID()}`;
    if (enqueueFirst) assert.equal(enqueueSystemPrompt(key, id, "completion"), "queued");
    assert.equal(acknowledgeSystemPrompt(key, id), true);
    assert.equal(systemPromptState(key, id), "consumed");
    assert.equal(enqueueSystemPrompt(key, id, "late completion"), "consumed");
    assert.equal(listQueuedPrompts(key).length, 0);
  }
});

test("acknowledgement cannot erase an uncertain completion start", () => {
  seedNode();
  const id = randomUUID();
  const key = `${randomUUID()}:${randomUUID()}`;
  enqueueSystemPrompt(key, id, "completion");
  const prompt = listQueuedPrompts(key)[0];
  assert.equal(beginQueuedPrompt(id, prompt.revision), true);
  assert.equal(acknowledgeSystemPrompt(key, id), false);
  assert.equal(systemPromptState(key, id), "starting");
});