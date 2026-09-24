import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

interface QuickNote {
  id: string;
  projectId: string;
  title: string;
  status: string;
  error: string | null;
  sessionId: string | null;
  createdAt: string;
}
interface LaunchResponse { note: QuickNote; sessionId: string; nodeId: string; sessionPath: string }

async function until(description: string, check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`${description} did not settle`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function engineLogLines(log: string): Promise<string[]> {
  try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function createNote(node: SeededNode, session: SignedIn, projectId: string, title: string, extra: Record<string, unknown> = {}): Promise<QuickNote> {
  const created = await api<{ note: QuickNote }>(node, session, "POST", "/quick-notes", {
    projectId,
    title,
    content: `${title} body`,
    harnessId: "pi",
    ...extra,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.note;
}

async function noteStatus(node: SeededNode, session: SignedIn, id: string): Promise<QuickNote> {
  const response = await api<{ note: QuickNote }>(node, session, "GET", `/quick-notes/${id}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.note;
}

/** Holds every stubbed engine turn until a release file appears. */
function holdEngineTurns(root: string): { release: () => Promise<void> } {
  return {
    release: async () => { await writeFile(path.join(root, "pi.release"), ""); },
  };
}

test("manual launch runs the saved note over the real /ws wire", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-quick-wire-"));
  let server: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const log = path.join(root, "engine.log");
    server = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: log, JOINT_BOB_TEST_ENGINE_HOLD_DIR: root });
    const session = await signIn(environment, node);
    const project = projectNamed(node, "Internal Assistant");
    const queue = await api<{ queue: { enabled: boolean } }>(node, session, "GET", "/quick-notes/queue");
    assert.equal(queue.body.queue.enabled, false, "launches must work with the queue off");
    // The stub holds every turn until a release file exists; this test wants completion.
    await writeFile(path.join(root, "pi.release"), "");

    const note = await createNote(node, session, project.id, "Manual launch");
    const listed = await api<{ notes: QuickNote[] }>(node, session, "GET", `/projects/${project.id}/quick-notes`);
    assert.ok(listed.body.notes.some((candidate) => candidate.id === note.id));

    const launch = await api<LaunchResponse>(node, session, "POST", `/quick-notes/${note.id}/start`);
    assert.equal(launch.status, 200, JSON.stringify(launch.body));
    assert.match(launch.body.sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(launch.body.sessionId, launch.body.note.sessionId);
    assert.equal(launch.body.nodeId, node.nodeId);
    assert.equal(launch.body.sessionPath, `draft:pi:${launch.body.sessionId}`);
    assert.equal(launch.body.note.status, "started");
    assert.deepEqual((await engineLogLines(log)).length, 1, "the stubbed engine ran exactly one turn");

    await writeFile(path.join(root, "pi.release"), "");
    await until("manual launch completion", async () => (await noteStatus(node, session, note.id)).status === "completed");
    const afterList = await api<{ notes: QuickNote[] }>(node, session, "GET", `/projects/${project.id}/quick-notes`);
    assert.ok(!afterList.body.notes.some((candidate) => candidate.id === note.id), "a started note leaves the backlog");

    const sessions = await api<{ sessions: Array<{ id: string; title: string }> }>(node, session, "GET", `/projects/${project.id}/sessions`);
    const conversation = sessions.body.sessions.find((candidate) => candidate.id === launch.body.sessionId);
    assert.ok(conversation, "the launched conversation joins project history");
    assert.equal(conversation!.title, "Manual launch");

    const duplicate = await api<{ error: string }>(node, session, "POST", `/quick-notes/${note.id}/start`);
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.deepEqual((await engineLogLines(log)).length, 1, "a duplicate start click never runs a second turn");
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("the queue enforces the parallel limit, FIFO order, and refill; schedules gate themselves", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-quick-queue-"));
  let server: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const log = path.join(root, "engine.log");
    server = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: log, JOINT_BOB_TEST_ENGINE_HOLD_DIR: root });
    const session = await signIn(environment, node);
    const project = projectNamed(node, "Internal Assistant");
    const hold = holdEngineTurns(root);

    // Queue disabled: an unscheduled note never auto-starts.
    const parked = await createNote(node, session, project.id, "Parked while disabled");
    await new Promise(resolve => setTimeout(resolve, 2_500));
    assert.equal((await noteStatus(node, session, parked.id)).status, "pending", "an unscheduled note waits while the queue is disabled");
    assert.deepEqual(await engineLogLines(log), [], "nothing ran while the queue was disabled");
    const parkedRemoved = await fetch(`${node.url}/api/quick-notes/${parked.id}`, { method: "DELETE", headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken } });
    assert.equal(parkedRemoved.status, 204);

    // Enable with two slots; FIFO unscheduled notes fill them and no more.
    const enabled = await api<{ queue: { enabled: boolean; maxParallel: number } }>(node, session, "PUT", "/quick-notes/queue", { queue: { enabled: true, maxParallel: 2 } });
    assert.deepEqual(enabled.body.queue, { enabled: true, maxParallel: 2 });

    const future = await createNote(node, session, project.id, "Far future", { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
    const first = await createNote(node, session, project.id, "FIFO one");
    const second = await createNote(node, session, project.id, "FIFO two");
    const third = await createNote(node, session, project.id, "FIFO three");
    await until("two parallel launches", async () => {
      const statuses = await Promise.all([first, second].map((note) => noteStatus(node, session, note.id)));
      return statuses.every((status) => status.status === "started" || status.status === "completed");
    });
    assert.deepEqual((await engineLogLines(log)).length, 2, "maxParallel 2 runs exactly two held turns");
    await new Promise(resolve => setTimeout(resolve, 1_500));
    const heldStates = await Promise.all([first, second, third, future].map((note) => noteStatus(node, session, note.id)));
    assert.deepEqual(
      heldStates.map((status) => `${status.title}:${status.status}`).sort(),
      ["Far future:pending", "FIFO one:started", "FIFO three:pending", "FIFO two:started"].sort(),
      `actual: ${heldStates.map((status) => `${status.title}:${status.status}`).join(", ")}`,
    );

    // Releasing both held turns frees the slots and the oldest pending note refills.
    await hold.release();
    await until("third note refills the freed slot", async () => (await noteStatus(node, session, third.id)).status === "completed");
    assert.equal((await noteStatus(node, session, future.id)).status, "pending", "a future scheduled note never starts early");
    assert.deepEqual((await engineLogLines(log)).length, 3, "three turns ran: two held plus the refill");

    // A due scheduled note starts even with the queue disabled again.
    await api(node, session, "PUT", "/quick-notes/queue", { queue: { enabled: false, maxParallel: 2 } });
    const dueNow = await createNote(node, session, project.id, "Due now", { scheduledAt: new Date(Date.now() - 60_000).toISOString() });
    await until("due scheduled note completed", async () => (await noteStatus(node, session, dueNow.id)).status === "completed");
    assert.deepEqual((await engineLogLines(log)).length, 4, "the due note ran without the queue");
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("a running conversation consumes the queue's slots until it settles", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-quick-slot-"));
  let server: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const log = path.join(root, "engine.log");
    server = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: log, JOINT_BOB_TEST_ENGINE_HOLD_DIR: root });
    const session = await signIn(environment, node);
    const project = projectNamed(node, "Internal Assistant");
    const hold = holdEngineTurns(root);

    // A manual launch bypasses the queue, so its conversation runs while the
    // queue itself stays enabled with a single slot.
    await api(node, session, "PUT", "/quick-notes/queue", { queue: { enabled: true, maxParallel: 1 } });
    const running = await createNote(node, session, project.id, "Occupying turn");
    const occupied = await api<{ sessionId: string }>(node, session, "POST", `/quick-notes/${running.id}/start`);
    assert.equal(occupied.status, 200, JSON.stringify(occupied.body));
    await until("occupying turn running", async () => {
      const runningList = await api<{ projects: Array<{ sessions: Array<{ running: boolean }> }> }>(node, session, "GET", "/running");
      return runningList.body.projects.some((group) => group.sessions.some((entry) => entry.running));
    });

    const waiting = await createNote(node, session, project.id, "Waits for a slot");
    await new Promise(resolve => setTimeout(resolve, 2_500));
    assert.equal((await noteStatus(node, session, waiting.id)).status, "pending", "a normal running conversation must consume the queue's slot");
    assert.deepEqual((await engineLogLines(log)).length, 1);

    await hold.release();
    await until("occupying turn settles", async () => (await noteStatus(node, session, running.id)).status === "completed");
    await until("waiting note takes the freed slot", async () => (await noteStatus(node, session, waiting.id)).status === "completed");
    assert.deepEqual((await engineLogLines(log)).length, 2);
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing ordinary conversation consumes the one-by-one queue slot", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-note-capacity-"));
  let server: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const log = path.join(root, "engine.log");
    server = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: log, JOINT_BOB_TEST_ENGINE_HOLD_DIR: root });
    const session = await signIn(environment, node);
    const project = projectNamed(node, "Internal Assistant");
    socket = new WebSocket(`${node.url.replace("http:", "ws:")}/ws?projectId=${project.id}&sessionPath=new`, { headers: { Cookie: session.cookie, Origin: node.url } });
    let wireError: string | undefined;
    socket.on("close", (_code, reason) => { wireError = reason.toString(); });
    socket.on("message", raw => {
      const event = JSON.parse(raw.toString());
      if (event.type === "error") wireError = event.error;
      if (event.type === "ready") socket!.send(JSON.stringify({ type: "prompt", message: "Ordinary conversation" }));
    });
    await until("ordinary conversation running", async () => {
      assert.equal(wireError, undefined);
      return (await engineLogLines(log)).length === 1;
    });
    const waiting = await createNote(node, session, project.id, "Wait for ordinary conversation");
    await api(node, session, "PUT", "/quick-notes/queue", { queue: { enabled: true, maxParallel: 1 } });
    await new Promise(resolve => setTimeout(resolve, 2_000));
    assert.equal((await engineLogLines(log)).length, 1, "existing conversations must occupy queue capacity");
    assert.equal((await noteStatus(node, session, waiting.id)).status, "pending");
    await writeFile(path.join(root, "pi.release"), "");
    await until("backlog refills after ordinary conversation", async () => (await noteStatus(node, session, waiting.id)).status === "completed");
    assert.equal((await engineLogLines(log)).length, 2);
  } finally {
    socket?.terminate();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("launch failures are visible and never silently drop credentials", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-quick-fail-"));
  let server: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const log = path.join(root, "engine.log");
    server = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: log, JOINT_BOB_TEST_ENGINE_HOLD_DIR: root });
    const session = await signIn(environment, node);
    const project = projectNamed(node, "Internal Assistant");
    await api(node, session, "PUT", "/quick-notes/queue", { queue: { enabled: true, maxParallel: 1 } });

    const missing = "11111111-2222-3333-4444-555555555555";
    const doomed = await createNote(node, session, project.id, "Missing secret", { secretAccountIds: [missing] });
    await until("missing secret fails the note", async () => (await noteStatus(node, session, doomed.id)).status === "failed");
    const failed = await noteStatus(node, session, doomed.id);
    assert.match(failed.error!, new RegExp(missing));
    assert.deepEqual(await engineLogLines(log), [], "no turn ran without its credentials");

    // The failed note stays in the backlog listing with its error attached.
    const listed = await api<{ notes: QuickNote[] }>(node, session, "GET", `/projects/${project.id}/quick-notes`);
    const entry = listed.body.notes.find((candidate) => candidate.id === doomed.id);
    assert.ok(entry, "a failed note stays listed");
    assert.equal(entry!.status, "failed");
    assert.match(entry!.error!, new RegExp(missing));

    // A manual start of the same failed note reports the same failure over HTTP.
    const manual = await api<{ error: string }>(node, session, "POST", `/quick-notes/${doomed.id}/start`);
    assert.equal(manual.status, 400);
    assert.match(manual.body.error!, new RegExp(missing));
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("restart recovery fails uncertain launches and disables the queue without replay", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-quick-restart-"));
  const children: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const log = path.join(root, "engine.log");
    const env = { JOINT_BOB_TEST_ENGINE_LOG: log, JOINT_BOB_TEST_ENGINE_HOLD_DIR: root };
    children.push(await startDevNode(environment, node, env));
    let session = await signIn(environment, node);
    const project = projectNamed(node, "Internal Assistant");
    await api(node, session, "PUT", "/quick-notes/queue", { queue: { enabled: true, maxParallel: 2 } });
    const interrupted = await createNote(node, session, project.id, "Interrupted launch");
    const pending = await createNote(node, session, project.id, "Still pending");

    // Simulate a crash between claim and dispatch: the note is left 'starting'.
    await stopDevNode(children.pop()!);
    const database = new DatabaseSync(path.join(node.dataDir, "node.db"));
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      database.prepare("UPDATE quick_notes SET status = 'starting', session_id = ?, launch_request_id = ? WHERE id = ?")
        .run("99999999-8888-7777-6666-555555555555", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", interrupted.id);
    } finally {
      database.close();
    }

    children.push(await startDevNode(environment, node, env));
    session = await signIn(environment, node);
    await until("uncertain launch recovered", async () => (await noteStatus(node, session, interrupted.id)).status === "failed");
    const recovered = await noteStatus(node, session, interrupted.id);
    assert.match(recovered.error!, /uncertain/i);
    const queue = await api<{ queue: { enabled: boolean } }>(node, session, "GET", "/quick-notes/queue");
    assert.equal(queue.body.queue.enabled, false, "uncertain recovery disables the queue");
    await until("pending note stays parked", async () => (await noteStatus(node, session, pending.id)).status === "pending");
    assert.deepEqual(await engineLogLines(log), [], "recovery never replays the uncertain turn");
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
