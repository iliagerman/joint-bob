import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type WebSocket from "ws";
import { getClusterNode } from "../src/cluster.js";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { getHarnessRuntime } from "../src/harnesses.js";
import { kiroSessionFilePath } from "../src/harnesses/kiro/storage.js";
import type { HarnessEvent, HarnessSession } from "../src/harnesses/runtime.js";
import { cancelQueuedPrompt, enqueuePrompt, listQueuedPrompts } from "../src/prompt-queue.js";
import { addProject } from "../src/store.js";
import { attachHarnessClient, detachHarnessClient, disposeHarnessSession, harnessSessionKey, harnessSessions, openHarnessSession, refreshHarnessTranscripts } from "../src/server/harness-sessions.js";
import { drainHarnessPromptQueue, harnessChatConnections, type HarnessChatConnection } from "../src/server/harness-chat.js";
import { claimConversationLocally } from "../src/server/sessions-helpers.js";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  return { promise: new Promise<void>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
}

function fakeSocket(events: Array<Record<string, unknown>>): WebSocket {
  return { OPEN: 1, readyState: 1, send: (value: string) => events.push(JSON.parse(value) as Record<string, unknown>) } as unknown as WebSocket;
}

function fakeHarnessSession(id: string, file: string, preflight: Promise<void>, onEntered: () => void): HarnessSession {
  const listeners = new Set<(event: HarnessEvent) => void>();
  return {
    id, file, messages: [],
    status: () => ({ isStreaming: false, isCompacting: false, availableThinkingLevels: ["medium"], thinkingLevel: "medium" }),
    isBusy: () => false,
    settings: () => ({ provider: "kiro", modelId: "default", reasoning: "medium" }),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    preflight: () => { onEntered(); return preflight; },
    prompt: async ({ onStarted }) => { onStarted?.(); for (const event of [{ type: "agent_start" }, { type: "textDelta", text: "streamed" }, { type: "agent_end" }]) for (const listener of listeners) listener(event); },
    configure: async () => {}, tools: () => [], setTools: async () => {}, compact: async () => {}, rename: async () => {}, reload: async () => {}, setSafeguards: async () => {}, cancel: async () => {}, stopForUpdate: async () => {}, dispose: () => { listeners.clear(); },
  } as HarnessSession;
}

async function setup(context: test.TestContext, preflight: Promise<void>, onEntered: () => void) {
  const id = crypto.randomUUID();
  const project = await addProject(`preflight-${id}`, path.join(process.env.HOME!, `project-${id}`), { writeInstructions: false });
  const local = await getClusterNode();
  await ensureConversationRecord(project.id, "kiro", id, local.id);
  await claimConversationLocally("kiro", id, local.id);
  const file = `kiro:${kiroSessionFilePath(id)}`;
  const runtime = await getHarnessRuntime("kiro");
  context.mock.method(runtime, "open", async () => fakeHarnessSession(id, file, preflight, onEntered));
  context.mock.method(runtime, "readiness", async () => []);
  const shared = await openHarnessSession("kiro", { projectId: project.id, cwd: project.path, sessionId: id, conversationId: id, accountIds: [] });
  const events: Array<Record<string, unknown>> = [];
  const socket = fakeSocket(events);
  const connection: HarnessChatConnection = { socket, project, taskId: null, cwd: project.path, engine: "kiro", shared, handoffContext: null, accountIds: [], readOnly: false, conversationId: id };
  harnessChatConnections.add(connection);
  attachHarnessClient(shared, socket);
  const queued = enqueuePrompt(`${project.id}:${id}`, "hello", "hello", { messageText: "hello", promptSuffix: "", displaySuffix: "", attachmentPaths: [], settings: { harnessId: "kiro", provider: "kiro", modelId: "default", reasoning: "medium" } });
  return { project, id, file, shared, socket, connection, queued, events };
}

function cleanup(fixture: Awaited<ReturnType<typeof setup>>): void {
  harnessChatConnections.delete(fixture.connection);
  fixture.connection.shared.clients.delete(fixture.socket);
  const queued = listQueuedPrompts(`${fixture.project.id}:${fixture.id}`)[0];
  if (queued) cancelQueuedPrompt(`${fixture.project.id}:${fixture.id}`, queued.id, queued.revision);
  const current = harnessSessions.get(harnessSessionKey(fixture.project.id, "kiro", fixture.id));
  if (current && current.turnInFlight === 0) disposeHarnessSession(current);
}

test("preflight pins a shared session against transcript refresh", async (context) => {
  const gate = deferred();
  let enteredResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const fixture = await setup(context, gate.promise, enteredResolve);
  try {
    const drain = drainHarnessPromptQueue(fixture.connection);
    await entered;
    refreshHarnessTranscripts(fixture.project.id, [fixture.file.replace(/^kiro:/, "")]);
    gate.resolve();
    await drain;
    assert.equal(harnessSessions.get(harnessSessionKey(fixture.project.id, "kiro", fixture.id)), fixture.shared);
    assert.ok(fixture.events.some((event) => event.type === "textDelta" && event.text === "streamed"), "textDelta was not delivered");
    assert.equal(fixture.shared.turnInFlight, 0);
    assert.ok(fixture.events.some((event) => event.type === "promptCompleted"));
  } finally { gate.resolve(); cleanup(fixture); }
});

test("queued prompt rebinds after idle transcript invalidation", async (context) => {
  const fixture = await setup(context, Promise.resolve(), () => {});
  const old = fixture.shared;
  try {
    refreshHarnessTranscripts(fixture.project.id, [fixture.file.replace(/^kiro:/, "")]);
    assert.ok(fixture.events.some((event) => event.type === "sessionFileChanged"));
    assert.equal(harnessSessions.has(harnessSessionKey(fixture.project.id, "kiro", fixture.id)), false);

    await drainHarnessPromptQueue(fixture.connection);
    assert.equal(fixture.events.filter((event) => event.type === "textDelta" && event.text === "streamed").length, 1, "textDelta was not delivered exactly once");
    assert.notEqual(fixture.connection.shared, old);
    assert.equal(harnessSessions.get(harnessSessionKey(fixture.project.id, "kiro", fixture.id)), fixture.connection.shared);
    assert.equal(fixture.events.filter((event) => event.type === "promptStarted").length, 1);
    assert.equal(fixture.events.filter((event) => event.type === "promptCompleted").length, 1);
    assert.equal(listQueuedPrompts(`${fixture.project.id}:${fixture.id}`).length, 0);
    assert.equal(old.clients.has(fixture.socket), false);

    detachHarnessClient(old, fixture.socket);
    disposeHarnessSession(old);
    assert.equal(old.idleTimer, null);
    assert.equal(harnessSessions.get(harnessSessionKey(fixture.project.id, "kiro", fixture.id)), fixture.connection.shared);
  } finally { cleanup(fixture); }
});

test("closed client is not attached when queued prompt rebinds", async (context) => {
  const fixture = await setup(context, Promise.resolve(), () => {});
  try {
    refreshHarnessTranscripts(fixture.project.id, [fixture.file.replace(/^kiro:/, "")]);
    const drain = drainHarnessPromptQueue(fixture.connection);
    Object.defineProperty(fixture.socket, "readyState", { value: 3 });
    await drain;

    assert.equal(listQueuedPrompts(`${fixture.project.id}:${fixture.id}`).length, 0);
    assert.equal(fixture.connection.shared.clients.size, 0);
    assert.notEqual(fixture.connection.shared.idleTimer, null);
  } finally { cleanup(fixture); }
});

test("rejected preflight releases its pin without starting the queued prompt", async (context) => {
  const gate = deferred();
  let enteredResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const fixture = await setup(context, gate.promise, enteredResolve);
  try {
    const drain = drainHarnessPromptQueue(fixture.connection);
    await entered;
    gate.reject(new Error("preflight rejected"));
    await assert.rejects(drain, /preflight rejected/);
    assert.equal(fixture.shared.turnInFlight, 0);
    assert.equal(listQueuedPrompts(`${fixture.project.id}:${fixture.id}`)[0]?.dispatchState, "pending");
    assert.equal(fixture.events.some((event) => event.type === "promptStarted" || event.type === "promptFailed"), false);
  } finally { gate.resolve(); cleanup(fixture); }
});
