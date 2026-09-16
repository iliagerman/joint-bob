import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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

async function openSeededPi(f: Awaited<ReturnType<typeof backgroundFixture>>): Promise<{
  socket: WebSocket; messages: Record<string, unknown>[]; projectId: string; conversationId: string;
}> {
  const session = await signIn(f.environment, f.node);
  const project = projectNamed(f.node, "Internal Assistant");
  const listed = await api<{ sessions: Array<{ id: string; path: string; harnessId: string }> }>(f.node, session, "GET", `/projects/${project.id}/sessions`);
  const target = listed.body.sessions.find((candidate) => candidate.harnessId === "pi");
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
  return { socket, messages, projectId: project.id, conversationId: record?.conversation_id ?? String(ready!.conversationId ?? target.id) };
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

async function failureEntries(file: string): Promise<Array<{ sessionId: string; text: string }>> {
  try { return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { sessionId: string; text: string }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

test("automatic completion start uncertainty remains fenced after dispatch failure and restart", async () => {
  const bootstrap = path.resolve("test/background-start-failure-bootstrap.ts");
  const envFor = (root: string) => ({
    JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log"),
    JOINT_BOB_TEST_FAILURE_LOG: path.join(root, "failure.log"),
    NODE_OPTIONS: `--import tsx --import ${bootstrap}`,
  });
  const f = await backgroundFixture(envFor);
  let setup: Awaited<ReturnType<typeof openSeededPi>> | undefined;
  try {
    setup = await openSeededPi(f);
    const first = randomUUID();
    await startSyntheticTask(f, setup.projectId, setup.conversationId, first);

    const observed = await waitFor(
      async () => ({
        failed: setup!.messages.find((frame) => frame.type === "promptFailed"),
        messages: setup!.messages,
        queue: queueRowForTask(f.node.dataDir, first),
        outbox: outboxState(f.node.dataDir, first),
        failures: await failureEntries(path.join(f.root, "failure.log")),
      }),
      (value) => Boolean(value.failed),
      "promptFailed frame from dispatcher catch",
    );
    assert.match(String(observed.failed!.error), /Synthetic uncertain start before acknowledgement/);
    const firstRow = queueRow(f.node.dataDir, String(observed.failed!.queueId));
    assert.deepEqual(firstRow, { dispatchState: "starting", systemEventId: String(observed.failed!.queueId) });
    const failureLog = path.join(f.root, "failure.log");
    let failures = await failureEntries(failureLog);
    assert.equal(failures.filter((entry) => entry.text.includes(first)).length, 1, "first uncertain prompt must be attempted once");

    setup.socket.close();
    await new Promise<void>((resolve) => setup!.socket.once("close", resolve));
    await stopDevNode(f.server);
    f.server = await startDevNode(f.environment, f.node, envFor(f.root));

    const second = randomUUID();
    await startSyntheticTask(f, setup.projectId, setup.conversationId, second);
    await waitFor(async () => (await supervisorRequest<{ status: string }>(f.node.dataDir, { action: "task", id: second })).status, (status) => status === "completed", "second supervisor task completion");
    await waitFor(() => outboxState(f.node.dataDir, second), (state) => state === "queued", "second durable completion enqueue");
    await waitFor(() => queueRowForTask(f.node.dataDir, second), (row) => row?.dispatchState === "pending", "second pending queue row");

    assert.deepEqual(queueRow(f.node.dataDir, String(observed.failed!.queueId)), { dispatchState: "starting", systemEventId: String(observed.failed!.queueId) });
    const secondRow = queueRowForTask(f.node.dataDir, second);
    assert.deepEqual(secondRow && { dispatchState: secondRow.dispatchState, systemEventId: secondRow.systemEventId }, { dispatchState: "pending", systemEventId: secondRow?.id });
    failures = await failureEntries(failureLog);
    assert.equal(failures.filter((entry) => entry.text.includes(first)).length, 1, "restart must not replay the uncertain prompt");
    assert.equal(failures.filter((entry) => entry.text.includes(second)).length, 0, "uncertain predecessor must fence the later prompt");

    const supervisor = new DatabaseSync(path.join(f.node.dataDir, "supervisor.db"), { readOnly: true });
    try {
      const rows = supervisor.prepare("SELECT id,status FROM supervisor_tasks WHERE id IN (?,?) ORDER BY id").all(first, second) as Array<{ id: string; status: string }>;
      assert.deepEqual(rows.map(({ id, status }) => ({ id, status })), [first, second].sort().map((id) => ({ id, status: "completed" })));
      assert.equal((supervisor.prepare("SELECT count(*) AS count FROM supervisor_completions WHERE task_id IN (?,?)").get(first, second) as { count: number }).count, 2);
    } finally { supervisor.close(); }
  } finally {
    setup?.socket.terminate();
    await closeBackgroundFixture(f);
  }
});
