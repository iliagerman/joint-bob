import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import WebSocket from "ws";
import { supervisorRequest } from "../scripts/supervisor-client.mjs";
import { api, projectNamed, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { backgroundFixture, closeBackgroundFixture, startSyntheticTask } from "./background-tasks-fixture.js";

async function waitFor<T>(read: () => T | Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  let value!: T;
  while (Date.now() < deadline) {
    value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
}

async function openSeededPi(f: Awaited<ReturnType<typeof backgroundFixture>>, sessionPath?: string): Promise<{
  socket: WebSocket; messages: Record<string, unknown>[]; projectId: string; conversationId: string; sessionPath: string;
}> {
  const session = await signIn(f.environment, f.node);
  const project = projectNamed(f.node, "Internal Assistant");
  const listed = await api<{ sessions: Array<{ id: string; path: string; harnessId: string }> }>(f.node, session, "GET", `/projects/${project.id}/sessions`);
  const target = sessionPath
    ? listed.body.sessions.find((candidate) => candidate.path === sessionPath)
    : listed.body.sessions.find((candidate) => candidate.harnessId === "pi");
  assert.ok(target, "seeded Pi conversation must exist");
  const messages: Record<string, unknown>[] = [];
  const url = new URL("/ws", f.node.url.replace(/^http/, "ws"));
  url.searchParams.set("projectId", project.id);
  url.searchParams.set("sessionPath", target.path);
  const socket = new WebSocket(url, { headers: { Cookie: session.cookie, Origin: f.node.url } });
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
  const ready = await waitFor(() => messages.find((frame) => frame.type === "ready"), Boolean, "conversation socket readiness");
  const db = new DatabaseSync(path.join(f.node.dataDir, "node.db"), { readOnly: true });
  const record = db.prepare("SELECT conversation_id FROM conversation_records WHERE project_id=? AND session_id=?").get(project.id, target.id) as { conversation_id: string | null } | undefined;
  db.close();
  return { socket, messages, projectId: project.id, conversationId: record?.conversation_id ?? String(ready!.conversationId ?? target.id), sessionPath: target.path };
}

function queueRow(dataDir: string, id: string): { dispatchState: string; systemEventId: string } | undefined {
  const db = new DatabaseSync(path.join(dataDir, "node.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT prompt FROM queued_prompts WHERE id=?").get(id) as { prompt: string } | undefined;
    if (!row) return undefined;
    const prompt = JSON.parse(row.prompt) as { dispatchState: string; systemEventId: string };
    return { dispatchState: prompt.dispatchState, systemEventId: prompt.systemEventId };
  } finally { db.close(); }
}

function queueRowForTask(dataDir: string, taskId: string): { id: string; dispatchState: string; systemEventId: string } | undefined {
  const db = new DatabaseSync(path.join(dataDir, "node.db"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT id,prompt FROM queued_prompts WHERE json_extract(prompt,'$.systemEventId') IS NOT NULL").all() as Array<{ id: string; prompt: string }>;
    const row = rows.find((candidate) => String((JSON.parse(candidate.prompt) as { promptText: string }).promptText).includes(taskId));
    if (!row) return undefined;
    const prompt = JSON.parse(row.prompt) as { dispatchState: string; systemEventId: string };
    return { id: row.id, dispatchState: prompt.dispatchState, systemEventId: prompt.systemEventId };
  } finally { db.close(); }
}

function outboxState(dataDir: string, id: string): string | undefined {
  const db = new DatabaseSync(path.join(dataDir, "node.db"), { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_completion_outbox'").get()) return undefined;
    return (db.prepare("SELECT delivery_state FROM background_completion_outbox WHERE task_id=?").get(id) as { delivery_state: string } | undefined)?.delivery_state;
  } finally { db.close(); }
}

async function chainPiTranscript(file: string): Promise<void> {
  const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
  let parentId: string | null = null;
  const chained = lines.map((line) => {
    const record = JSON.parse(line) as { type?: string; id?: string; parentId?: string | null };
    if (record.type === "message" && record.id) { record.parentId = parentId; parentId = record.id; }
    return JSON.stringify(record);
  });
  await writeFile(file, `${chained.join("\n")}\n`);
}

async function fileLines(file: string): Promise<string[]> {
  try { return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function failureEntries(file: string): Promise<Array<{ sessionId: string; text: string }>> {
  try { return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { sessionId: string; text: string }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

test("background completion turns stay internal live and after restart", async () => {
  const envFor = (root: string) => ({ JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log"), JOINT_BOB_TEST_ENGINE_HOLD_DIR: root });
  const f = await backgroundFixture(envFor);
  let setup: Awaited<ReturnType<typeof openSeededPi>> | undefined;
  let reopened: Awaited<ReturnType<typeof openSeededPi>> | undefined;
  try {
    setup = await openSeededPi(f);
    setup.socket.send(JSON.stringify({ type: "prompt", message: "visible trigger", requestId: randomUUID() }));
    await waitFor(() => fileLines(path.join(f.root, "engine.log")), (lines) => lines.length === 1, "held ordinary prompt start");

    const taskId = randomUUID();
    await startSyntheticTask(f, setup.projectId, setup.conversationId, taskId);
    await waitFor(() => queueRowForTask(f.node.dataDir, taskId), (row) => row?.dispatchState === "pending", "pending internal queue row");
    assert.equal(setup.messages.some((frame) => frame.type === "queuedPrompts" && JSON.stringify(frame).includes(taskId)), false);

    await writeFile(path.join(f.root, "pi.release"), "go");
    await waitFor(async () => await readFile(setup!.sessionPath, "utf8"), (text) => text.includes(taskId) && text.includes("stubbed response"), "native internal transcript turn");
    await waitFor(() => queueRowForTask(f.node.dataDir, taskId), (row) => row === undefined, "consumed internal queue row");

    setup.socket.send(JSON.stringify({ type: "prompt", message: "visible follow-up", requestId: randomUUID() }));
    await waitFor(() => setup!.messages.filter((frame) => frame.type === "promptCompleted").length, (count) => count === 2, "visible follow-up completion");

    assert.equal(setup.messages.filter((frame) => frame.type === "textDelta" && frame.text === "stubbed response").length, 2);
    const leakingFrames = setup.messages.filter((frame) => frame.type !== "backgroundTasksChanged" && JSON.stringify(frame).includes(taskId));
    assert.deepEqual(leakingFrames, [], "internal task marker must never reach client frames");
    await chainPiTranscript(setup.sessionPath);
    const nativeBefore = await readFile(setup.sessionPath, "utf8");
    assert.match(nativeBefore, /visible trigger/);
    assert.match(nativeBefore, /visible follow-up/);
    assert.match(nativeBefore, new RegExp(taskId));

    setup.socket.close();
    await new Promise<void>((resolve) => setup!.socket.once("close", resolve));
    await stopDevNode(f.server);
    f.server = await startDevNode(f.environment, f.node, envFor(f.root));
    reopened = await openSeededPi(f, setup.sessionPath);
    const ready = reopened.messages.find((frame) => frame.type === "ready") as { messages?: Array<{ role: string; text: string }> };
    const visible = ready.messages ?? [];
    assert.deepEqual(visible.filter((message) => /visible (trigger|follow-up)|stubbed response/.test(message.text)).map(({ role, text }) => ({ role, text })), [
      { role: "user", text: "visible trigger" },
      { role: "assistant", text: "stubbed response" },
      { role: "user", text: "visible follow-up" },
      { role: "assistant", text: "stubbed response" },
    ]);
    assert.equal(JSON.stringify(visible).includes(taskId), false);
    assert.ok((await readFile(setup.sessionPath, "utf8")).startsWith(nativeBefore), "filtering must not delete or rewrite native transcript records");
    assert.equal((await readFile(path.join(f.root, "engine.log"), "utf8")).trim().split("\n").length, 3);
  } finally {
    await writeFile(path.join(f.root, "pi.release"), "go").catch(() => {});
    setup?.socket.terminate(); reopened?.socket.terminate();
    await closeBackgroundFixture(f);
  }
});

function failureEnv(mode: "throw" | "hang") {
  const bootstrap = path.resolve("test/background-start-failure-bootstrap.ts");
  return (root: string) => ({
    JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log"),
    JOINT_BOB_TEST_FAILURE_LOG: path.join(root, "failure.log"),
    JOINT_BOB_TEST_FAILURE_MODE: mode,
    NODE_OPTIONS: `--import tsx --import ${bootstrap}`,
  });
}

function attempts(failures: Array<{ text: string }>, taskId: string): number {
  return failures.filter((entry) => entry.text.includes(taskId)).length;
}

test("a failed automatic start is retired, surfaced, and never blocks later completions", async () => {
  const f = await backgroundFixture(failureEnv("throw"));
  let setup: Awaited<ReturnType<typeof openSeededPi>> | undefined;
  try {
    setup = await openSeededPi(f);
    const failureLog = path.join(f.root, "failure.log");
    const first = randomUUID();
    await startSyntheticTask(f, setup.projectId, setup.conversationId, first);
    await waitFor(
      async () => ({ failures: await failureEntries(failureLog), row: queueRowForTask(f.node.dataDir, first) }),
      (value) => attempts(value.failures, first) === 1 && value.row === undefined,
      "retired failed internal start",
    );

    const notice = await waitFor(() => setup!.messages.find((frame) => frame.type === "error"), Boolean, "visible failure notice");
    assert.match(String(notice!.error), /Synthetic uncertain start/);
    assert.equal(JSON.stringify(notice).includes(first), false, "internal task marker must never reach client frames");
    assert.equal(setup.messages.some((frame) => frame.type === "promptFailed"), false, "internal prompts never appear as queue items");

    const second = randomUUID();
    await startSyntheticTask(f, setup.projectId, setup.conversationId, second);
    const failures = await waitFor(() => failureEntries(failureLog), (entries) => attempts(entries, second) === 1, "later completion delivered");
    assert.equal(attempts(failures, first), 1, "a failed automatic start is never replayed");
  } finally {
    setup?.socket.terminate();
    await closeBackgroundFixture(f);
  }
});

test("an automatic start interrupted by shutdown is never replayed and does not block later completions", async () => {
  const f = await backgroundFixture(failureEnv("hang"));
  let setup: Awaited<ReturnType<typeof openSeededPi>> | undefined;
  try {
    setup = await openSeededPi(f);
    const failureLog = path.join(f.root, "failure.log");
    const first = randomUUID();
    await startSyntheticTask(f, setup.projectId, setup.conversationId, first);
    await waitFor(
      async () => ({ failures: await failureEntries(failureLog), row: queueRowForTask(f.node.dataDir, first) }),
      (value) => attempts(value.failures, first) === 1 && value.row?.dispatchState === "starting",
      "interrupted internal start",
    );

    setup.socket.close();
    await new Promise<void>((resolve) => setup!.socket.once("close", resolve));
    await stopDevNode(f.server);
    f.server = await startDevNode(f.environment, f.node, failureEnv("throw")(f.root));

    const second = randomUUID();
    await startSyntheticTask(f, setup.projectId, setup.conversationId, second);
    const failures = await waitFor(() => failureEntries(failureLog), (entries) => attempts(entries, second) === 1, "later completion delivered after restart");
    assert.equal(attempts(failures, first), 1, "restart must not replay the interrupted start");
    assert.equal(queueRowForTask(f.node.dataDir, first), undefined, "the interrupted start is retired");
  } finally {
    setup?.socket.terminate();
    await closeBackgroundFixture(f);
  }
});
