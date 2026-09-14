import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import type WebSocket from "ws";
import type { HarnessSession } from "../src/harnesses/runtime.js";
import { configure, environment, gatedClaude, openChat, startServer, stopServer, temporaryRoot, waitFor, type Fixture } from "./queued-prompt-harness.js";

type TestPiSession = HarnessSession & { handle: { session: any } };

let root: string;
let previous: NodeJS.ProcessEnv;
let server: Server;
let baseUrl: string;
let fixture: Fixture;
const sockets: WebSocket[] = [];

before(async () => {
  root = await temporaryRoot("joint-bob-queued-engines-");
  previous = { ...process.env };
  Object.assign(process.env, environment(root), { PI_CODING_AGENT_DIR: path.join(root, "pi"), JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log"), JOINT_BOB_TEST_ENGINE_HOLD_DIR: path.join(root, "hold") });
  await mkdir(path.join(root, "pi"));
  await mkdir(path.join(root, "hold"));
  await writeFile(path.join(root, "pi", "models.json"), JSON.stringify({ providers: { zai: {
    baseUrl: "http://127.0.0.1:1", apiKey: "test-key", api: "openai-completions",
    models: [{ id: "queue-reasoner", name: "Queue reasoner", reasoning: true, input: ["text", "image"], contextWindow: 32000, maxTokens: 1024 }],
  } } }));
  const settings = await import("../src/settings.js");
  settings.updateSettings({ pi: { executable: "", configPath: path.join(root, "pi"), sessionPath: path.join(root, "pi", "sessions") }, claude: { executable: "", configPath: path.join(root, "claude"), sessionPath: path.join(root, "claude", "projects") }, syncthing: { endpoint: "" } });
  const defaults = settings.getSettings();
  settings.updateSettings({ ...defaults, conversationDefaults: { ...defaults.conversationDefaults, pi: { provider: "zai", modelId: "queue-reasoner", thinkingLevel: "medium" } } });
  const started = await startServer();
  server = started.server;
  baseUrl = started.baseUrl;
  fixture = await configure(baseUrl, root, await gatedClaude(root));
});

after(async () => {
  for (const socket of sockets) socket.terminate();
  await stopServer(server);
  process.env = previous;
  await rm(root, { recursive: true, force: true });
});

test("Pi app queue dispatches Claude and Pi overrides FIFO, then inherits active settings", async () => {
  const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "new");
  sockets.push(opened.socket);
  await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "ready"));
  opened.socket.send(JSON.stringify({ type: "prompt", message: "first" }));
  await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "promptStarted"));
  const selections = [
    { message: "claude next", queueSettings: { provider: "claude", modelId: "haiku", reasoning: "high" } },
    { message: "pi next", queueSettings: { provider: "zai", modelId: "queue-reasoner", reasoning: "low" } },
    { message: "inherit last", queueSettings: null },
  ];
  for (const selection of selections) opened.socket.send(JSON.stringify({ type: "prompt", ...selection }));
  await waitFor(opened.messages, () => opened.messages.filter((frame) => frame.type === "userMessage" && frame.queued).length === 4);
  await writeFile(path.join(root, "hold", "pi.release"), "");
  await writeFile(path.join(root, "hold", "claude.release"), "");
  await waitFor(opened.messages, () => opened.messages.filter((frame) => frame.type === "agent_end").length === 4);
  assert.deepEqual((await readFile(path.join(root, "engine.log"), "utf8")).trim().split("\n").map((line) => line.split(":")[0]), ["pi", "claude", "pi", "pi"]);
  const statuses = opened.messages.filter((frame) => frame.type === "status").map((frame) => frame.status as { model: { id: string }; thinkingLevel: string });
  assert.equal(statuses.at(-1)!.model.id, "queue-reasoner");
  assert.equal(statuses.at(-1)!.thinkingLevel, "low");
  assert.deepEqual(opened.messages.filter((frame) => frame.type === "error"), []);
});

for (const failFirst of [false, true]) test(`update recovery starts every conversation independently and releases queues after ${failFirst ? "failure" : "success"}`, async (context) => {
  const { harnessSessions } = await import("../src/server/harness-sessions.js");
  const { saveUpdateRecoveries, listPendingUpdateRecoveries } = await import("../src/update-recovery.js");
  const { recoverPendingUpdateRuns } = await import("../src/server/task-runs.js");
  const release = Promise.withResolvers<void>();
  const opened: ReturnType<typeof openChat>[] = [];
  for (let index = 0; index < 2; index += 1) {
    const chat = openChat(baseUrl, fixture.cookie, fixture.projectId, "new");
    opened.push(chat);
    sockets.push(chat.socket);
    await waitFor(chat.messages, () => chat.messages.some((frame) => frame.type === "ready"));
  }
  const shared = opened.map((chat) => [...harnessSessions.values()].find((candidate) => candidate.session.id === chat.messages.find((frame) => frame.type === "ready")!.sessionId)!);
  const calls: string[][] = [[], []];
  shared.forEach((session, index) => context.mock.method(session.session, "prompt", async (input) => {
    calls[index].push(input.text);
    await release.promise;
    if (failFirst && index === 0 && calls[index].length === 1) throw new Error("Fixture recovery failed");
    input.onStarted?.();
  }));
  await saveUpdateRecoveries(shared.map((session) => ({
    id: randomUUID(), kind: "chat", engine: "pi", projectId: fixture.projectId, cwd: session.cwd,
    sessionId: session.session.id, sessionPath: session.session.file!, taskId: null, phase: null,
    queuedPrompts: ["saved follow-up"], model: null, effort: null, createdAt: new Date().toISOString(),
  })));
  const recovering = recoverPendingUpdateRuns();
  try {
    await waitFor(opened[0].messages, () => calls.every((prompts) => prompts.length === 1), 1_500);
    const response = await fetch(`${baseUrl}/api/projects/${fixture.projectId}/sessions`, { headers: { Cookie: fixture.cookie } });
    const { sessions } = await response.json() as { sessions: Array<{ id: string; running: boolean }> };
    for (const session of shared) assert.equal(sessions.find((row) => row.id === session.session.id)?.running, true, "recovery is running even between SDK streaming events");
    opened[0].socket.send(JSON.stringify({ type: "prompt", message: "arrived during recovery" }));
    await waitFor(opened[0].messages, () => opened[0].messages.some((frame) => frame.type === "userMessage" && frame.queued));
    assert.equal(opened[0].messages.some((frame) => frame.type === "promptStarted"), false, "incoming prompt must not race recovery");
    release.resolve();
    await recovering;
    await waitFor(opened[0].messages, () => opened[0].messages.some((frame) => frame.type === "promptCompleted"), 1_500);
    assert.equal(calls[0].includes("saved follow-up"), !failFirst);
    assert.equal(calls[1][1], "saved follow-up", "another conversation's failure must not cancel recovery");
    assert.deepEqual(await listPendingUpdateRecoveries(), []);
  } finally { release.resolve(); await recovering; }
});

test("stopping a Pi turn starts the next queued message", async (context) => {
  const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "new");
  sockets.push(opened.socket);
  await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "ready"));
  const sessionId = String(opened.messages.find((frame) => frame.type === "ready")!.sessionId);
  const { harnessSessions } = await import("../src/server/harness-sessions.js");
  const shared = [...harnessSessions.values()].find((candidate) => candidate.session.id === sessionId)!;
  const session = shared.session;
  let releaseFirst!: () => void;
  const firstTurn = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let promptCount = 0;
  context.mock.method(session, "prompt", async (input) => {
    promptCount += 1;
    input.onStarted?.();
    if (promptCount === 1) {
      await firstTurn;
      throw new Error("Pi turn aborted");
    }
  });
  context.mock.method(session, "cancel", async () => { releaseFirst(); });
  const engineLog = process.env.JOINT_BOB_TEST_ENGINE_LOG;
  delete process.env.JOINT_BOB_TEST_ENGINE_LOG;
  try {
    opened.socket.send(JSON.stringify({ type: "prompt", message: "stop this" }));
    await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "promptStarted"));
    opened.socket.send(JSON.stringify({ type: "prompt", message: "run next" }));
    await waitFor(opened.messages, () => opened.messages.filter((frame) => frame.type === "userMessage" && frame.queued).length === 2);
    opened.socket.send(JSON.stringify({ type: "abort" }));
    await waitFor(opened.messages, () => opened.messages.filter((frame) => frame.type === "promptStarted").length === 2, 1_500);
    assert.equal(promptCount, 2);
  } finally { releaseFirst(); process.env.JOINT_BOB_TEST_ENGINE_LOG = engineLog; }
});

test("stopping a Claude turn starts the next queued message", async () => {
  const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "claude:new");
  sockets.push(opened.socket);
  await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "ready"));
  const engineLog = process.env.JOINT_BOB_TEST_ENGINE_LOG;
  const nextGate = `${process.env.JOINT_BOB_FAKE_GATE}.run after stop`;
  delete process.env.JOINT_BOB_TEST_ENGINE_LOG;
  try {
    opened.socket.send(JSON.stringify({ type: "prompt", message: "stop claude" }));
    await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "promptStarted"));
    opened.socket.send(JSON.stringify({ type: "prompt", message: "run after stop" }));
    await waitFor(opened.messages, () => opened.messages.filter((frame) => frame.type === "userMessage" && frame.queued).length === 2);
    opened.socket.send(JSON.stringify({ type: "abort" }));
    await waitFor(opened.messages, () => opened.messages.filter((frame) => frame.type === "promptStarted").length === 2, 3_000);
    await writeFile(nextGate, "");
    await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "promptCompleted"));
  } finally { await writeFile(nextGate, ""); process.env.JOINT_BOB_TEST_ENGINE_LOG = engineLog; }
});

test("queue transfer fence includes an enqueue awaiting attachment persistence", async (context) => {
  const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "new");
  sockets.push(opened.socket);
  await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "ready"));
  const sessionId = String(opened.messages.find((frame) => frame.type === "ready")!.sessionId);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const persisting = new Promise<void>((resolve) => { entered = resolve; });
  const original = fs.writeFile;
  const mocked = context.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).includes(".joint-bob-attachments")) { entered(); await gate; }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    opened.socket.send(JSON.stringify({ type: "prompt", message: "pending write", images: [{ name: "held.png", mimeType: "image/png", data: "aGVsbG8=" }] }));
    await persisting;
    const { harnessPromptQueueIsDraining } = await import("../src/server/harness-chat.js");
    assert.equal(harnessPromptQueueIsDraining(`${fixture.projectId}:${sessionId}`), true, "transfer must reject an enqueue that can still commit after its snapshot");
  } finally { release(); mocked.mock.restore(); syncBuiltinESMExports(); }
  await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "promptStarted"));
});

test("Pi queue resumes after update recovery finishes", async (context) => {
  const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "new");
  sockets.push(opened.socket);
  await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "ready"));
  const sessionId = String(opened.messages.find((frame) => frame.type === "ready")!.sessionId);
  const { harnessSessions } = await import("../src/server/harness-sessions.js");
  const shared = [...harnessSessions.values()].find((candidate) => candidate.session.id === sessionId)!;
  const sessionPath = shared.session.file!;
  let release!: () => void;
  let started!: () => void;
  let promptCount = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const recoveryStarted = new Promise<void>((resolve) => { started = resolve; });
  context.mock.method(shared.session, "prompt", async (input) => {
    promptCount += 1;
    if (promptCount === 1) {
      started();
      await gate;
      return;
    }
    input.onStarted?.();
  });
  const { saveUpdateRecoveries } = await import("../src/update-recovery.js");
  const { recoverPendingUpdateRuns } = await import("../src/server/task-runs.js");
  await saveUpdateRecoveries([{
    id: randomUUID(), kind: "chat", engine: "pi", projectId: fixture.projectId,
    cwd: path.join(root, "project"), sessionId, sessionPath, taskId: null, phase: null,
    queuedPrompts: [], model: null, effort: null, createdAt: new Date().toISOString(),
  }]);
  const priorInvalidations = opened.messages.filter((frame) => frame.type === "sessionsChanged").length;
  const recovery = recoverPendingUpdateRuns();
  try {
    await recoveryStarted;
    await waitFor(opened.messages, () => opened.messages.filter((frame) => frame.type === "sessionsChanged").length > priorInvalidations);
    const sessionsResponse = await fetch(`${baseUrl}/api/projects/${fixture.projectId}/sessions`, { headers: { Cookie: fixture.cookie } });
    const sessionsBody = await sessionsResponse.json() as { sessions: Array<{ id: string; running: boolean }> };
    assert.equal(sessionsBody.sessions.find((session) => session.id === sessionId)?.running, true, "update recovery must appear in the running list");
    opened.socket.send(JSON.stringify({ type: "prompt", message: "after recovery" }));
    await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "userMessage" && frame.queued));
  } finally {
    release();
    await recovery;
  }
  await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "promptStarted"), 1_500);
});

test("successful Pi extension commands without agent_start are consumed once", async (context) => {
  const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "new");
  sockets.push(opened.socket);
  await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "ready"));
  const sessionId = String(opened.messages.find((frame) => frame.type === "ready")!.sessionId);
  const { harnessSessions } = await import("../src/server/harness-sessions.js");
  const shared = [...harnessSessions.values()].find((candidate) => candidate.session.id === sessionId && candidate.engine === "pi")!;
  const native = (shared.session as TestPiSession).handle.session;
  let calls = 0;
  context.mock.method(native, "prompt", async () => { if (++calls > 1) throw new Error("extension repeated"); });
  const log = process.env.JOINT_BOB_TEST_ENGINE_LOG;
  delete process.env.JOINT_BOB_TEST_ENGINE_LOG;
  try {
    opened.socket.send(JSON.stringify({ type: "prompt", message: "/extension-command" }));
    await waitFor(opened.messages, () => opened.messages.some((frame) => ["promptStarted", "error"].includes(String(frame.type))));
    const { listQueuedPrompts } = await import("../src/prompt-queue.js");
    assert.deepEqual(listQueuedPrompts(`${fixture.projectId}:${sessionId}`), [], "completed extension must not remain starting or repeat");
    assert.equal(calls, 1);
    assert.deepEqual(opened.messages.filter((frame) => frame.type === "error"), []);
  } finally { process.env.JOINT_BOB_TEST_ENGINE_LOG = log; }
});

for (const operation of ["compact", "reload"] as const) {
  test(`Pi queue resumes after ${operation} completes`, async (context) => {
    const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "new");
    sockets.push(opened.socket);
    await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "ready"));
    const sessionId = String(opened.messages.find((frame) => frame.type === "ready")!.sessionId);
    const { harnessSessions } = await import("../src/server/harness-sessions.js");
    const shared = [...harnessSessions.values()].find((candidate) => candidate.session.id === sessionId && candidate.engine === "pi")!;
    const native = (shared.session as TestPiSession).handle.session;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let busy = false;
    if (operation === "compact") context.mock.getter(native, "isCompacting", () => busy);
    context.mock.method(native, operation, async () => {
      busy = true; entered();
      try { await gate; } finally { busy = false; }
    });
    const { handleHarnessChatMessage, harnessChatConnections, harnessPromptQueueIsDraining } = await import("../src/server/harness-chat.js");
    const connection = [...harnessChatConnections].find((candidate) => candidate.shared === shared)!;
    const completion = operation === "compact"
      ? handleHarnessChatMessage(connection, Buffer.from(JSON.stringify({ type: "compact" })))
      : (await import("../src/server/realtime.js")).reloadSharedSkills();
    try {
      await started;
      opened.socket.send(JSON.stringify({ type: "prompt", message: `queued during ${operation}` }));
      await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "userMessage" && frame.queued));
      await waitFor(opened.messages, () => !harnessPromptQueueIsDraining(`${fixture.projectId}:${sessionId}`));
      assert.equal(opened.messages.some((frame) => frame.type === "promptStarted"), false, "busy session must retain queue");
    } finally { release(); await completion; }
    await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "promptStarted"), 1500);
    assert.deepEqual(opened.messages.filter((frame) => frame.type === "error"), []);
  });
}

for (const stage of ["turn", "preflight"] as const) {
  test(`update fence stops an existing drain after awaiting ${stage}`, async (context) => {
    const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "new");
    sockets.push(opened.socket);
    await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "ready"));
    const sessionId = String(opened.messages.find((frame) => frame.type === "ready")!.sessionId);
    const { flags } = await import("../src/server/state.js");
    const { harnessSessions } = await import("../src/server/harness-sessions.js");
    const shared = [...harnessSessions.values()].find((candidate) => candidate.session.id === sessionId && candidate.engine === "pi")!;
    const native = (shared.session as TestPiSession).handle.session;
    const { harnessPromptQueueIsDraining } = await import("../src/server/harness-chat.js");
    const { listQueuedPrompts, clearQueuedPrompts } = await import("../src/prompt-queue.js");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const prompt = context.mock.method(native, "prompt", async () => { if (stage === "turn") { entered(); await gate; } });
    if (stage === "preflight") {
      const runtime = native.modelRuntime;
      const auth = runtime.getAuth.bind(runtime);
      context.mock.method(runtime, "getAuth", async (model: Parameters<typeof auth>[0]) => { entered(); await gate; return auth(model); });
    }
    const log = process.env.JOINT_BOB_TEST_ENGINE_LOG;
    delete process.env.JOINT_BOB_TEST_ENGINE_LOG;
    try {
      opened.socket.send(JSON.stringify({ type: "prompt", message: "first" }));
      await started;
      if (stage === "turn") opened.socket.send(JSON.stringify({ type: "prompt", message: "must remain queued" }));
      await waitFor(opened.messages, () => opened.messages.filter((frame) => frame.type === "userMessage" && frame.queued).length === (stage === "turn" ? 2 : 1));
      flags.updatePreparing = true;
      release();
      await waitFor(opened.messages, () => !harnessPromptQueueIsDraining(`${fixture.projectId}:${sessionId}`));
      assert.equal(prompt.mock.callCount(), stage === "turn" ? 1 : 0, "no new turn may start behind the update fence");
      assert.equal(listQueuedPrompts(`${fixture.projectId}:${sessionId}`).length, 1, "undispatched prompt stays durable for restart");
    } finally {
      release(); flags.updatePreparing = false; process.env.JOINT_BOB_TEST_ENGINE_LOG = log;
      clearQueuedPrompts(`${fixture.projectId}:${sessionId}`);
    }
  });
}

test("update fence cancels Claude dispatch held in transcript localization", async (context) => {
  const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "claude:new");
  sockets.push(opened.socket);
  await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "ready"));
  const sessionId = String(opened.messages.find((frame) => frame.type === "ready")!.sessionId);
  const { harnessChatConnections, harnessPromptQueueIsDraining } = await import("../src/server/harness-chat.js");
  const connection = [...harnessChatConnections].find((candidate) => candidate.shared.session.id === sessionId && candidate.engine === "claude")!;
  const { claudeSessionFilePath } = await import("../src/claude-service.js");
  const localPath = claudeSessionFilePath(connection.cwd, sessionId);
  await mkdir(path.dirname(localPath), { recursive: true });
  await writeFile(localPath, "");
  (connection.shared.session as HarnessSession & { nativeFile: string }).nativeFile = path.join(root, "foreign", `${sessionId}.jsonl`);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const access = fs.access;
  const mocked = context.mock.method(fs, "access", async (...args: Parameters<typeof access>) => {
    if (args[0] === localPath) { entered(); await gate; }
    return access(...args);
  });
  syncBuiltinESMExports();
  const { flags } = await import("../src/server/state.js");
  const { listQueuedPrompts, clearQueuedPrompts } = await import("../src/prompt-queue.js");
  try {
    opened.socket.send(JSON.stringify({ type: "prompt", message: "must not start after preparation" }));
    await started;
    flags.updatePreparing = true; release();
    await waitFor(opened.messages, () => !harnessPromptQueueIsDraining(`${fixture.projectId}:${sessionId}`));
    assert.equal(opened.messages.some((frame) => frame.type === "promptStarted"), false, "localization await must not cross the update fence");
    assert.equal(listQueuedPrompts(`${fixture.projectId}:${sessionId}`)[0].dispatchState, "pending");
  } finally {
    release(); flags.updatePreparing = false; mocked.mock.restore(); syncBuiltinESMExports();
    clearQueuedPrompts(`${fixture.projectId}:${sessionId}`);
  }
});

test("Claude queue resumes after compaction completes", async () => {
  const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "claude:new");
  sockets.push(opened.socket);
  await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "ready"));
  await rm(path.join(root, "hold", "claude.release"), { force: true });
  try {
    opened.socket.send(JSON.stringify({ type: "compact" }));
    await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "status" && (frame.status as { isCompacting: boolean }).isCompacting));
    opened.socket.send(JSON.stringify({ type: "prompt", message: "after compact" }));
    await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "userMessage" && frame.queued));
    assert.equal(opened.messages.some((frame) => frame.type === "promptStarted"), false);
  } finally { await writeFile(path.join(root, "hold", "claude.release"), ""); }
  await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "promptStarted"), 1500);
});

test("Pi queued authenticated override replaces an unauthenticated current model", async (context) => {
  const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "new");
  sockets.push(opened.socket);
  await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "ready"));
  const sessionId = String(opened.messages.find((frame) => frame.type === "ready")!.sessionId);
  const { harnessSessions } = await import("../src/server/harness-sessions.js");
  const shared = [...harnessSessions.values()].find((candidate) => candidate.session.id === sessionId && candidate.engine === "pi")!;
  const session = (shared.session as TestPiSession).handle.session;
  let selected = { ...session.model!, id: "unavailable-current-model" };
  context.mock.getter(session, "model", () => selected);
  context.mock.method(session, "setModel", async (model: typeof selected) => { selected = model; });
  const getAuth = session.modelRuntime.getAuth.bind(session.modelRuntime);
  context.mock.method(session.modelRuntime, "getAuth", async (model: typeof selected) => model.id === "unavailable-current-model" ? undefined : getAuth(model));
  const prompt = context.mock.method(session, "prompt", async () => undefined);
  const log = process.env.JOINT_BOB_TEST_ENGINE_LOG;
  delete process.env.JOINT_BOB_TEST_ENGINE_LOG;
  try {
    opened.socket.send(JSON.stringify({ type: "prompt", message: "use authenticated replacement", queueSettings: { provider: "zai", modelId: "queue-reasoner", reasoning: "low" } }));
    await waitFor(opened.messages, () => opened.messages.some((frame) => ["promptStarted", "error"].includes(String(frame.type))));
    assert.deepEqual(opened.messages.filter((frame) => frame.type === "error"), [], "current model auth must not block override");
    assert.equal(prompt.mock.callCount(), 1);
    assert.equal(selected.id, "queue-reasoner");
  } finally { process.env.JOINT_BOB_TEST_ENGINE_LOG = log; }
});

test("Claude process failure after spawn but before init leaves queue pending", async () => {
  const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "claude:new");
  sockets.push(opened.socket);
  await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "ready"));
  const sessionId = String(opened.messages.find((frame) => frame.type === "ready")!.sessionId);
  const executable = path.join(root, "failing-claude.mjs");
  await writeFile(executable, '#!/usr/bin/env node\nif (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }\nprocess.exit(1);\n');
  await chmod(executable, 0o755);
  const { updateSettings, getSettings } = await import("../src/settings.js");
  const saved = getSettings();
  updateSettings({ ...saved, claude: { ...saved.claude, executable } });
  const log = process.env.JOINT_BOB_TEST_ENGINE_LOG;
  delete process.env.JOINT_BOB_TEST_ENGINE_LOG;
  try {
    opened.socket.send(JSON.stringify({ type: "prompt", message: "keep after startup failure" }));
    await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "error"));
    const { listQueuedPrompts } = await import("../src/prompt-queue.js");
    const pending = listQueuedPrompts(`${fixture.projectId}:${sessionId}`);
    assert.equal(pending.length, 1, "spawn alone must not consume queued prompt");
    assert.equal(pending[0].dispatchState, "pending");
    assert.equal(opened.messages.some((frame) => frame.type === "promptStarted"), false);
  } finally { process.env.JOINT_BOB_TEST_ENGINE_LOG = log; updateSettings(saved); }
});

test("queue cancellation rejects replicated attachment paths outside attachment storage", async () => {
  const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "new");
  sockets.push(opened.socket);
  await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "ready"));
  const sessionId = String(opened.messages.find((frame) => frame.type === "ready")!.sessionId);
  const victim = path.join(root, "must-not-delete.txt");
  await writeFile(victim, "retained");
  const { enqueuePrompt } = await import("../src/prompt-queue.js");
  const queued = enqueuePrompt(`${fixture.projectId}:${sessionId}`, "cancel", "cancel", { messageText: "cancel", promptSuffix: "", displaySuffix: "", attachmentPaths: [victim] });
  opened.socket.send(JSON.stringify({ type: "cancelQueuedPrompt", queueId: queued.id, queueRevision: queued.revision }));
  await waitFor(opened.messages, () => opened.messages.some((frame) => ["error", "queuedPromptCancelled"].includes(String(frame.type))));
  assert.equal(await readFile(victim, "utf8"), "retained", "untrusted replicated path must never be unlinked");
  assert.match(String(opened.messages.find((frame) => frame.type === "error")?.error), /Queued attachment path is invalid/);
});

test("Pi receives native image bytes and a pre-start SDK rejection retains the queued row", async (context) => {
  const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "new");
  sockets.push(opened.socket);
  await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "ready"));
  const sessionId = String(opened.messages.find((frame) => frame.type === "ready")!.sessionId);
  const { harnessSessions } = await import("../src/server/harness-sessions.js");
  const shared = [...harnessSessions.values()].find((candidate) => candidate.session.id === sessionId && candidate.engine === "pi")!;
  const native = (shared.session as TestPiSession).handle.session;
  let delivered: unknown;
  context.mock.method(native, "prompt", async (_text: string, options: unknown) => { delivered = options; throw new Error("SDK rejected before agent_start"); });
  const log = process.env.JOINT_BOB_TEST_ENGINE_LOG;
  delete process.env.JOINT_BOB_TEST_ENGINE_LOG;
  try {
    const data = Buffer.from("native image bytes").toString("base64");
    opened.socket.send(JSON.stringify({ type: "prompt", message: "inspect image", images: [{ name: "image.png", mimeType: "image/png", data }] }));
    await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "error"));
    assert.deepEqual(delivered, { images: [{ type: "image", mimeType: "image/png", data }] });
    assert.match(String(opened.messages.find((frame) => frame.type === "error")!.error), /SDK rejected before agent_start/);
    const { listQueuedPrompts } = await import("../src/prompt-queue.js");
    const pending = listQueuedPrompts(`${fixture.projectId}:${sessionId}`);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].images[0].mimeType, "image/png");
    assert.equal(opened.messages.some((frame) => frame.type === "promptStarted"), false);
  } finally { process.env.JOINT_BOB_TEST_ENGINE_LOG = log; }
});
