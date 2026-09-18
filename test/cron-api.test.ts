import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChildProcess } from "node:child_process";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import type { CronTask } from "../src/cron.js";

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Cron state did not settle"); await new Promise(resolve => setTimeout(resolve, 100)); }
}
/** The nodes under test write node.db while the test reads and writes it too. */
function openNodeDb(directory: string): DatabaseSync {
  const db = new DatabaseSync(path.join(directory, "node.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}
function makeDue(directory: string, id: string): void {
  const db = openNodeDb(directory);
  try {
    db.prepare("UPDATE cron_tasks SET next_run = ? WHERE id = ?").run(Date.now(), id);
  } finally { db.close(); }
}

test("scheduler restart pauses uncertain dispatch, skips offline occurrences, and never overlaps an active run", { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cron-restart-"));
  const children: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    const log = path.join(root, "engine.log");
    const env = { JOINT_BOB_TEST_ENGINE_LOG: log, JOINT_BOB_TEST_ENGINE_HOLD_DIR: root };
    children.push(await startDevNode(environment, node, env));
    let auth = await signIn(environment, node);
    // Tests manually make tasks due; keep the natural hourly tick outside the test duration.
    const input = { projectId: node.projects[0].id, name: "Interrupted report", prompt: "Report", engine: "claude", sessionId: null, ownerNodeId: node.nodeId, enabled: true, schedule: { frequency: "hourly", hour: 9, minute: (new Date().getUTCMinutes() + 30) % 60, weekday: 1, timezone: "UTC" } };
    const created = await api<{ task: CronTask }>(node, auth, "POST", "/cron", { nodeId: node.nodeId, command: { action: "create", input } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const readTask = async (id: string) => (await api<{ tasks: CronTask[] }>(node, auth, "GET", `/projects/${input.projectId}/cron`)).body.tasks.find(task => task.id === id)!;
    makeDue(node.dataDir, created.body.task.id);
    await until(async () => (await readTask(created.body.task.id)).lastRun?.status === "running");
    makeDue(node.dataDir, created.body.task.id);
    await until(async () => (await readTask(created.body.task.id)).nextRun > Date.now());
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [`claude:${node.nodeId}`], "an active task must not start a duplicate turn");
    const offline = await api<{ task: CronTask }>(node, auth, "POST", "/cron", { nodeId: node.nodeId, command: { action: "create", input } });
    assert.equal(offline.status, 200);
    await stopDevNode(children.pop()!);
    makeDue(node.dataDir, offline.body.task.id);
    children.push(await startDevNode(environment, node, env));
    auth = await signIn(environment, node);
    await until(async () => (await readTask(created.body.task.id)).lastRun?.status === "failed");
    const interrupted = await readTask(created.body.task.id);
    assert.equal(interrupted.enabled, false);
    assert.match(interrupted.lastRun!.error!, /outcome uncertain/);
    const edited = await api<{ task: CronTask }>(node, auth, "POST", "/cron", { nodeId: node.nodeId, command: { action: "update", id: interrupted.id, input: { ...input, name: "Recovered report", enabled: false } } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.task.name, "Recovered report", "a recovered paused task must remain editable");
    await until(async () => (await readTask(offline.body.task.id)).nextRun > Date.now());
    assert.equal((await readTask(offline.body.task.id)).lastRun, null, "restart must skip even a just-missed offline occurrence");
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [`claude:${node.nodeId}`], "restart must not replay the uncertain turn");
    const resumed = await api<{ task: CronTask }>(node, auth, "POST", "/cron", { nodeId: node.nodeId, command: { action: "run", id: interrupted.id } });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.task.enabled, true, "running a recovered paused task must resume its schedule");
    assert.ok(resumed.body.task.nextRun <= Date.now(), "running a recovered task should make it immediately due");
  } finally { await Promise.all(children.map(stopDevNode)); await rm(root, { recursive: true, force: true }); }
});

test("different schedules run concurrently in isolated conversations that join project history", { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cron-parallel-"));
  let child: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    const log = path.join(root, "engine.log");
    child = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: log, JOINT_BOB_TEST_ENGINE_HOLD_DIR: root });
    const auth = await signIn(environment, node);
    const base = { projectId: node.projects[0].id, prompt: "Parallel report", engine: "claude", sessionId: null, ownerNodeId: node.nodeId, enabled: true, schedule: { frequency: "hourly", hour: 9, minute: (new Date().getUTCMinutes() + 30) % 60, weekday: 1, timezone: "UTC" } };
    const tasks: CronTask[] = [];
    for (const name of ["Parallel A", "Parallel B"]) {
      const created = await api<{ task: CronTask }>(node, auth, "POST", "/cron", { nodeId: node.nodeId, command: { action: "create", input: { ...base, name } } });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      tasks.push(created.body.task);
    }
    for (const task of tasks) makeDue(node.dataDir, task.id);
    const readTasks = async () => (await api<{ tasks: CronTask[] }>(node, auth, "GET", `/projects/${base.projectId}/cron`)).body.tasks;
    await until(async () => {
      const listed = await readTasks();
      return tasks.every(task => listed.find(candidate => candidate.id === task.id)?.lastRun?.status === "running");
    });
    await until(async () => {
      try {
        return (await readFile(log, "utf8")).trim().split("\n").length >= 2;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
    assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2, "both isolated agents must start before either finishes");
    await writeFile(path.join(root, "claude.release"), "");
    await until(async () => {
      const listed = await readTasks();
      return tasks.every(task => listed.find(candidate => candidate.id === task.id)?.lastRun?.status === "succeeded");
    });
    const sessions = await api<{ sessions: Array<{ cronTaskId?: string }> }>(node, auth, "GET", `/projects/${base.projectId}/sessions`);
    for (const task of tasks) assert.ok(sessions.body.sessions.some(session => session.cronTaskId === task.id), `${task.name} result missing from project history`);
  } finally {
    if (child) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("cron API routes to execution owner, persists, runs fresh project conversations and appends through transferred ownership", { timeout: 180000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cron-cluster-"));
  const children: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [a, b] = environment.nodes;
    const log = path.join(root, "engine.log");
    for (const node of [a, b]) children.push(await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: log }));
    const auth = await signIn(environment, a);
    const projectId = a.projects[0].id;
    const input = { projectId, name: "Scheduled report", prompt: "Give a report", engine: "claude", sessionId: null, ownerNodeId: b.nodeId, enabled: true, schedule: { frequency: "hourly", hour: 9, minute: (new Date().getUTCMinutes() + 30) % 60, weekday: 1, timezone: "UTC" } };
    const authBInitial = await signIn(environment, b);
    const listSessions = async (node: typeof a, session: typeof auth) => (await api<{ sessions: Array<{ id: string; harnessId: string; cronTaskId?: string }> }>(node, session, "GET", `/projects/${projectId}/sessions`)).body.sessions;
    const unscheduled = (await listSessions(b, authBInitial)).filter(session => session.harnessId === "pi").slice(0, 2);
    assert.equal(unscheduled.length, 2);
    assert.ok(unscheduled.every(session => session.cronTaskId === undefined));
    const pausedInput = { ...input, engine: "pi", sessionId: unscheduled[0].id, enabled: false };
    const pausedCreated = await api<{ task: CronTask }>(a, auth, "POST", "/cron", { nodeId: b.nodeId, command: { action: "create", input: pausedInput } });
    assert.equal(pausedCreated.status, 200, JSON.stringify(pausedCreated.body));
    assert.equal(pausedCreated.body.task.lastRun, null);
    assert.equal((await listSessions(b, authBInitial)).find(session => session.id === unscheduled[0].id)!.cronTaskId, pausedCreated.body.task.id, "paused schedules classify conversations before their first run");
    await until(async () => (await listSessions(a, auth)).find(session => session.id === unscheduled[0].id)?.cronTaskId === pausedCreated.body.task.id);
    const retargeted = await api(a, auth, "POST", "/cron", { nodeId: b.nodeId, command: { action: "update", id: pausedCreated.body.task.id, input: { ...pausedInput, sessionId: unscheduled[1].id } } });
    assert.equal(retargeted.status, 200, JSON.stringify(retargeted.body));
    assert.equal((await listSessions(b, authBInitial)).find(session => session.id === unscheduled[1].id)!.cronTaskId, pausedCreated.body.task.id, "changing target classifies the new conversation");
    await api(a, auth, "POST", "/cron", { nodeId: b.nodeId, command: { action: "delete", id: pausedCreated.body.task.id } });
    const created = await api<{ task: CronTask }>(a, auth, "POST", "/cron", { nodeId: b.nodeId, command: { action: "create", input } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.task.id;
    const dbA = openNodeDb(a.dataDir);
    assert.equal(dbA.prepare("SELECT count(*) AS n FROM cron_tasks").get()!.n, 0, "viewing node must not store a dispatchable copy"); dbA.close();
    const readTask = async () => {
      const task = (await api<{ tasks: CronTask[] }>(a, auth, "GET", `/projects/${projectId}/cron`)).body.tasks.find(task => task.id === id)!;
      if (task?.lastRun?.status === "failed") throw new Error(JSON.stringify(task.lastRun));
      return task;
    };
    makeDue(b.dataDir, id);
    await until(async () => (await readTask()).lastRun?.status === "succeeded");
    const first = (await readTask()).lastRun!.sessionId;
    makeDue(b.dataDir, id);
    await until(async () => { const run = (await readTask()).lastRun; return run?.status === "succeeded" && run.sessionId !== first; });
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [`claude:${b.nodeId}`, `claude:${b.nodeId}`]);
    const sessions = await api<{ sessions: Array<{ id: string; cronTaskId?: string }> }>(b, await signIn(environment, b), "GET", `/projects/${projectId}/sessions`);
    assert.equal(sessions.body.sessions.filter(session => session.cronTaskId === id).length, 2);
    await until(async () => (await api<{ sessions: Array<{ cronTaskId?: string }> }>(a, auth, "GET", `/projects/${projectId}/sessions`)).body.sessions.filter(session => session.cronTaskId === id).length === 2);
    // Seeded transcripts exist on both nodes, so takeover exercises the real
    // ownership fence rather than inventing an unsynchronized draft.
    const existing = (await api<{ sessions: Array<{ id: string; path: string; harnessId: string }> }>(a, auth, "GET", `/projects/${projectId}/sessions`)).body.sessions.find(session => session.harnessId === "claude" && !sessions.body.sessions.some(candidate => candidate.id === session.id && candidate.cronTaskId))!;
    const owned = await api(a, auth, "POST", `/projects/${projectId}/sessions/take-ownership`, { sessionId: existing.id, sessionPath: existing.path, peerId: a.nodeId });
    assert.equal(owned.status, 200, JSON.stringify(owned.body));
    const transcriptPath = existing.path.replace(/^claude:/, "");
    const originalTranscript = await readFile(transcriptPath, "utf8");
    const ownerDb = openNodeDb(a.dataDir);
    const busy = { engine: "claude", sessionId: existing.id, summary: { runId: "cron-busy-child", status: "running", tasks: [] } };
    ownerDb.prepare("INSERT INTO conversation_work VALUES (?, ?, ?, ?)").run("claude", existing.id, busy.summary.runId, JSON.stringify(busy));
    ownerDb.close();
    const conversation = await api<{ task: CronTask }>(a, auth, "POST", "/cron", { nodeId: b.nodeId, command: { action: "create", input: { ...input, sessionId: existing.id } } });
    assert.equal(conversation.status, 200, JSON.stringify(conversation.body));
    makeDue(b.dataDir, conversation.body.task.id);
    const executionDb = openNodeDb(b.dataDir);
    try {
      await until(async () => Boolean(executionDb.prepare("SELECT 1 FROM cron_runs WHERE task_id = ?").get(conversation.body.task.id)));
      await new Promise(resolve => setTimeout(resolve, 1200));
      assert.equal(executionDb.prepare("SELECT status FROM cron_runs WHERE task_id = ?").get(conversation.body.task.id)!.status, "waiting", "busy remote conversation must remain waiting");
      assert.equal(executionDb.prepare("SELECT owner_node_id FROM conversation_ownership WHERE session_id = ?").get(existing.id)!.owner_node_id, a.nodeId, "waiting must not take ownership");
      assert.equal(await readFile(transcriptPath, "utf8"), originalTranscript, "waiting must not append a prompt");
      const releaseDb = openNodeDb(a.dataDir);
      releaseDb.prepare("DELETE FROM conversation_work WHERE engine = ? AND session_id = ? AND run_id = ?").run("claude", existing.id, busy.summary.runId);
      releaseDb.close();
    } finally { executionDb.close(); }
    await until(async () => {
      const run = (await api<{ tasks: CronTask[] }>(a, auth, "GET", `/projects/${projectId}/cron`)).body.tasks.find(task => task.id === conversation.body.task.id)?.lastRun;
      if (run?.status === "failed") throw new Error(JSON.stringify(run));
      return run?.status === "succeeded";
    });
    const appended = await readFile(transcriptPath, "utf8");
    assert.ok(appended.startsWith(originalTranscript), "scheduled continuation preserves original history");
    const additions = appended.slice(originalTranscript.length).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(additions.filter(record => record.type === "user" && record.message.content.includes(input.prompt)).length, 1, "idle transition appends exactly one scheduled prompt");
    const dbB = openNodeDb(b.dataDir);
    assert.equal(dbB.prepare("SELECT owner_node_id FROM conversation_ownership WHERE session_id = ?").get(existing.id)!.owner_node_id, b.nodeId);
    dbB.close();
    const previousRunId = (await api<{ tasks: CronTask[] }>(b, authBInitial, "GET", `/projects/${projectId}/cron`)).body.tasks.find(task => task.id === conversation.body.task.id)!.lastRun!.id;
    const peerDb = openNodeDb(b.dataDir);
    peerDb.prepare("UPDATE cluster_peers SET url = 'http://127.0.0.1:1'").run();
    peerDb.close();
    makeDue(b.dataDir, conversation.body.task.id);
    await until(async () => {
      const run = (await api<{ tasks: CronTask[] }>(b, authBInitial, "GET", `/projects/${projectId}/cron`)).body.tasks.find(task => task.id === conversation.body.task.id)?.lastRun;
      if (run?.status === "failed") throw new Error(JSON.stringify(run));
      return run?.status === "succeeded" && run.id !== previousRunId;
    });
    const restorePeerDb = openNodeDb(b.dataDir);
    restorePeerDb.prepare("UPDATE cluster_peers SET url = ? WHERE id = ?").run(a.url, a.nodeId);
    restorePeerDb.close();
    const paused = await api<{ task: CronTask }>(a, auth, "POST", "/cron", { nodeId: b.nodeId, command: { action: "update", id, input: { ...input, enabled: false } } });
    assert.equal(paused.body.task.enabled, false);
    await stopDevNode(children.pop()!);
    children.push(await startDevNode(environment, b, { JOINT_BOB_TEST_ENGINE_LOG: log }));
    assert.equal((await readTask()).enabled, false);
    assert.equal((await readTask()).lastRun?.status, "succeeded");
    const lockDb = openNodeDb(b.dataDir);
    lockDb.prepare("INSERT OR REPLACE INTO project_locks VALUES (?, ?, ?, ?, ?, ?)").run(created.body.task.projectId, a.nodeId, a.name, new Date().toISOString(), new Date().toISOString(), a.nodeId);
    lockDb.close();
    const authB = await signIn(environment, b);
    assert.equal((await api<{ project: { lock: { nodeId: string } } }>(b, authB, "GET", `/projects/${projectId}`)).body.project.lock.nodeId, a.nodeId, "execution node must see the foreign project lock");
    const locked = await api<{ task: CronTask }>(a, auth, "POST", "/cron", { nodeId: b.nodeId, command: { action: "create", input } });
    assert.equal(locked.status, 200);
    assert.equal(locked.body.task.pauseOnFailure, false, "new schedules retry after failure by default");
    makeDue(b.dataDir, locked.body.task.id);
    let failed: CronTask | undefined;
    await until(async () => {
      failed = (await api<{ tasks: CronTask[] }>(a, auth, "GET", `/projects/${projectId}/cron`)).body.tasks.find(task => task.id === locked.body.task.id);
      return failed?.lastRun?.finishedAt !== null && failed?.lastRun?.finishedAt !== undefined;
    });
    assert.equal(failed!.lastRun!.status, "failed");
    assert.match(failed!.lastRun!.error!, /Project is locked/);
    assert.equal(failed!.enabled, true, "default schedules must retry at the next occurrence");
    const pausing = await api<{ task: CronTask }>(a, auth, "POST", "/cron", { nodeId: b.nodeId, command: { action: "create", input: { ...input, pauseOnFailure: true } } });
    assert.equal(pausing.status, 200);
    makeDue(b.dataDir, pausing.body.task.id);
    let pausedAfterFailure: CronTask | undefined;
    await until(async () => {
      pausedAfterFailure = (await api<{ tasks: CronTask[] }>(a, auth, "GET", `/projects/${projectId}/cron`)).body.tasks.find(task => task.id === pausing.body.task.id);
      return pausedAfterFailure?.lastRun?.finishedAt !== null && pausedAfterFailure?.lastRun?.finishedAt !== undefined;
    });
    assert.equal(pausedAfterFailure!.lastRun!.status, "failed");
    assert.equal(pausedAfterFailure!.enabled, false, "opted-in schedules must pause after failure");
    assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 4, "a locked project must not start an agent");
    await api(b, authB, "PUT", `/projects/${projectId}/lock`, { locked: false });
    await api(a, auth, "POST", "/cron", { nodeId: b.nodeId, command: { action: "delete", id: locked.body.task.id } });
    await api(a, auth, "POST", "/cron", { nodeId: b.nodeId, command: { action: "delete", id: pausing.body.task.id } });
    const moved = await api<{ task: CronTask }>(a, auth, "POST", "/cron", { nodeId: b.nodeId, command: { action: "update", id, input: { ...input, ownerNodeId: a.nodeId, enabled: false } } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.task.id, id);
    assert.equal(moved.body.task.lastRun?.status, "succeeded");
    assert.equal((await readTask()).ownerNodeId, a.nodeId);
    assert.equal((await api(a, auth, "POST", "/cron", { nodeId: a.nodeId, command: { action: "delete", id } })).status, 200);
    assert.equal(await readTask(), undefined);
  } finally { await Promise.all(children.map(stopDevNode)); await rm(root, { recursive: true, force: true }); }
});
