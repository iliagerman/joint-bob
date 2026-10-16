import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/server/harness-chat.ts", import.meta.url), "utf8");
// Execute the production attach and dispatch functions, replacing only their I/O boundaries.
const compiled = ts.transpileModule(source + "\nexport { dispatch };", { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function fixture() {
  const metadataRead = gate(), metadataRelease = gate(), preflightEntered = gate(), preflightRelease = gate(), startEntered = gate(), startRelease = gate(), started = gate(), finish = gate();
  let holdMetadata = false, holdPreflight = false, holdStart = false, metadataHeld = false;
  let historyReads = 0, executions = 0, claims = 0;
  let scheduled = false, backgroundBusy = false;
  const priorMessages: any[] = [], segments: any[] = [];
  const messages: any[] = [];
  const queued: any = { id: "durable-note", revision: 1, dispatchState: "pending", displayText: "Saved quick note", promptText: "Saved quick note", messageText: "Saved quick note", images: [], attachmentPaths: [], createdAt: "2026-01-01T00:00:00.000Z" };
  let queue = [queued];
  const shared: any = {
    clients: new Set(), liveEvents: [], turnInFlight: 0, scheduledTurn: false,
    session: {
      id: "conversation", messages, status: () => ({}), settings: () => ({}), isBusy: () => shared.turnInFlight > 0,
      preflight: async () => { preflightEntered.release(); if (holdPreflight) await preflightRelease.promise; },
      prompt: async ({ beforeStart, onStarted }: any) => {
        executions++;
        startEntered.release();
        if (holdStart) await startRelease.promise;
        await beforeStart();
        messages.push({ id: "user-1", role: "user", text: queued.promptText, timestamp: queued.createdAt });
        shared.turnStartedAt = queued.createdAt;
        shared.liveEvents = [{ type: "agent_start" }];
        onStarted();
        started.release();
        await finish.promise;
        shared.liveEvents = [];
        shared.turnStartedAt = undefined;
      },
    },
  };
  const frames: any[] = [];
  const listeners = new Map<string, () => void>();
  const socket = { on: (type: string, listener: () => void) => listeners.set(type, listener), readyState: 1, frames };
  const options: any = { socket, project: { id: "project" }, engine: "pi", sessionId: "conversation", conversationId: "conversation", cwd: "/synthetic", taskId: null, accountIds: [], readOnly: false, ownership: {}, handoffContext: null, autoStartPrompt: null };
  const mocks: Record<string, any> = {
    resourceOwner: () => undefined, flags: {}, getProjectLock: async () => null,
    queuedSettingsSchema: { parse: (value: any) => value }, socketMessageSchema: { parse: (value: any) => value },
    getConversationRecord: async () => ({ conversationId: "conversation", ...(scheduled ? { cronTaskId: "schedule" } : {}) }),
    getClusterNode: async () => ({ id: "local" }),
    findHarnessSession: () => shared, openHarnessSession: async () => shared,
    attachHarnessClient: (s: any, client: any) => s.clients.add(client),
    detachHarnessClient: (s: any, client: any) => s.clients.delete(client),
    measureOperation: (_: string, action: () => any) => action(),
    readQueueSettings: () => null,
    conversationTranscriptPayload: async (_p: any, _e: any, _s: any, _l: any, history: any[]) => { historyReads++; return { messages: structuredClone([...priorMessages, ...history]), segments }; },
    historyBeforeLiveTurn: (history: any[]) => shared.liveEvents.length && shared.turnStartedAt ? history.filter(m => m.role === "user") : history,
    buildHandoffContext: () => "prior segment context",
    scheduledReportMessages: (history: any[], idle: boolean) => idle ? history : [],
    attachMessageAuthors: (_p: any, _c: any, history: any[]) => history,
    attachAutoReplies: async (_p: any, _c: any, history: any[]) => history,
    listTurnFailures: () => [], withTurnFailures: (history: any[]) => history,
    harnessSessionBusy: () => shared.turnInFlight > 0 || backgroundBusy,
    getConversationGoal: async () => {
      if (holdMetadata && !metadataHeld) { metadataHeld = true; metadataRead.release(); await metadataRelease.promise; }
      return undefined;
    },
    getAutoRespond: async () => undefined,
    activeRoutingConfig: () => null, routingConfigDatabase: () => ({}),
    getSettings: () => ({ conversationCommands: [], digestAttachments: false }),
    listConversationSegments: async () => [],
    send: (client: any, frame: any) => { if (client.readyState === 1) client.frames.push(structuredClone(frame)); },
    listQueuedPrompts: () => queue,
    isScheduledPromptText: () => false,
    conversationBelongsToDoneTask: async () => false,
    requireLocalConversationOwner: async () => {}, markHarnessInput: () => {},
    catchUpGitHead: async () => {}, genericSecretEnvironment: () => ({}),
    queuedAttachments: async () => ({ text: queued.promptText, images: [] }),
    beginQueuedPrompt: () => { queued.dispatchState = "starting"; return true; },
    claimQueuedPrompt: () => { claims++; queue = []; return true; },
    saveDifficulty: () => {}, authoredPromptText: (_p: any, _c: any, text: string) => text,
    sendHarnessStatus: () => {},
    DEFAULT_AUTO_RESPOND_INSTRUCTIONS: "", DEFAULT_AUTO_RESPOND_STOP_INSTRUCTIONS: "",
  };
  const exports: any = {};
  vm.runInThisContext(`(function(require, exports) { ${compiled}\n})`)((name: string) => name.startsWith("node:") || name === "ws" ? require(name) : new Proxy(mocks, { get(target, key: string) { if (key in target) return target[key]; throw new Error(`Unexpected boundary ${name}:${key}`); } }), exports);
  const connection = { ...options, shared };
  return { shared, queued, frames, exports, options, connection, metadataRead, metadataRelease, preflightEntered, preflightRelease, startEntered, startRelease, started, finish,
    holdMetadata: () => { holdMetadata = true; }, holdPreflight: () => { holdPreflight = true; }, holdStart: () => { holdStart = true; }, historyReads: () => historyReads,
    executions: () => executions, claims: () => claims,
    addPriorSegment: () => { priorMessages.push({ role: "assistant", text: "prior reply" }); segments.push({ sessionId: "prior" }, { sessionId: "conversation" }); },
    scheduledReport: () => { scheduled = true; backgroundBusy = true; messages.push({ role: "assistant", text: "terminal report" }); },
    finishBackground: () => { backgroundBusy = false; },
    closeSocket: () => { socket.readyState = 3; listeners.get("close")?.(); },
  };
}
function visiblePromptCount(frames: any[]): number {
  // Same identity rules as socket.js: ready replaces history, queue snapshots retain IDs,
  // promptStarted clears the queued mark without removing the user bubble.
  let history = 0;
  const queued = new Set<string>();
  for (const frame of frames) {
    if (frame.type === "ready") { history = frame.messages.filter((m: any) => m.role === "user").length; queued.clear(); }
    if (frame.type === "queuedPrompts") {
      const ids = new Set<string>(frame.prompts.map((p: any) => p.id));
      for (const id of queued) if (!ids.has(id)) queued.delete(id);
      for (const id of ids) queued.add(id);
    }
    if (frame.type === "promptStarted" && queued.delete(frame.queueId)) history++;
  }
  return history + queued.size;
}

test("attach rebuilds empty history when a durable quick note starts during metadata reads", async () => {
  const f = fixture();
  f.holdMetadata();
  const attach = f.exports.attachHarnessChat(f.options);
  await f.metadataRead.promise;
  assert.equal(f.historyReads(), 1);
  assert.equal(f.shared.session.messages.length, 0, "attach captured the empty pre-start history");
  const dispatch = f.exports.dispatch(f.connection, f.queued);
  await f.started.promise;
  assert.equal(f.shared.session.messages.length, 1, "runtime persisted user before onStarted");
  f.metadataRelease.release();
  try {
    await attach;
    const ready = f.frames.find(frame => frame.type === "ready");
    assert.equal(ready.messages.filter((m: any) => m.role === "user").length, 1, "ready must not lose the user whose durable queue entry was claimed during attach");
    assert.equal(visiblePromptCount(f.frames), 1, "ready plus queue/replay must contain exactly one user");
  } finally { f.finish.release(); await dispatch; }
});

for (const phase of ["preflight", "starting"] as const) test(`attach keeps durable prompt during ${phase} until onStarted`, async () => {
  const f = fixture();
  if (phase === "preflight") f.holdPreflight();
  else f.holdStart();
  const dispatch = f.exports.dispatch(f.connection, f.queued);
  await (phase === "preflight" ? f.preflightEntered.promise : f.startEntered.promise);
  assert.equal(f.queued.dispatchState, phase === "preflight" ? "pending" : "starting");
  try {
    await f.exports.attachHarnessChat(f.options);
    assert.equal(visiblePromptCount(f.frames), 1, "starting but unclaimed durable prompt must survive reconnect");
    f.exports.refreshHarnessPromptQueue(f.connection);
    assert.equal(visiblePromptCount(f.frames), 1, "repeated queue snapshots preserve the existing bubble by queue ID");
    f.preflightRelease.release();
    f.startRelease.release();
    await f.started.promise;
    assert.equal(visiblePromptCount(f.frames), 1, "onStarted must retain exactly one prompt");
  } finally { f.preflightRelease.release(); f.startRelease.release(); f.finish.release(); await dispatch; }
});

test("visible starting prompt remains fenced against mutation and duplicate dispatch", async () => {
  const f = fixture();
  f.holdStart();
  const dispatch = f.exports.dispatch(f.connection, f.queued);
  await f.startEntered.promise;
  try {
    await f.exports.attachHarnessChat(f.options);
    assert.equal(visiblePromptCount(f.frames), 1);
    for (const type of ["editQueuedPrompt", "cancelQueuedPrompt", "forceStartQueuedPrompt", "swapQueuedPrompts", "mergeQueuedPrompts"]) {
      await assert.rejects(f.exports.handleHarnessChatMessage(f.connection, Buffer.from(JSON.stringify({
        type, queueId: f.queued.id, queueRevision: 1, message: "changed", queueItems: [{ id: f.queued.id, revision: 1 }],
      }))), /Queued prompt.*(changed|incomplete)/, `${type} must not mutate an in-flight start`);
    }
    await assert.rejects(f.exports.dispatch(f.connection, f.queued), /start is uncertain/);
    assert.equal(f.claims(), 0, "no false claim while runtime start is held");
    assert.equal(f.executions(), 1);
    assert.equal(f.queued.promptText, "Saved quick note");
    f.startRelease.release();
    await f.started.promise;
    assert.equal(f.claims(), 1);
    assert.equal(f.executions(), 1);
    assert.equal(visiblePromptCount(f.frames), 1);
  } finally { f.startRelease.release(); f.finish.release(); await dispatch; }
});

test("already attached client keeps one prompt through starting and claim", async () => {
  const f = fixture();
  await f.exports.attachHarnessChat(f.options);
  assert.equal(visiblePromptCount(f.frames), 1);
  f.holdStart();
  const dispatch = f.exports.dispatch(f.connection, f.queued);
  await f.startEntered.promise;
  try {
    f.exports.refreshHarnessPromptQueue(f.connection);
    assert.equal(visiblePromptCount(f.frames), 1);
    f.startRelease.release();
    await f.started.promise;
    assert.equal(visiblePromptCount(f.frames), 1);
    assert.equal(f.frames.filter(frame => frame.type === "promptStarted").length, 1);
  } finally { f.startRelease.release(); f.finish.release(); await dispatch; }
});

test("attach rebuilds when the turn completes before ready", async () => {
  const f = fixture();
  f.holdMetadata();
  const attach = f.exports.attachHarnessChat(f.options);
  await f.metadataRead.promise;
  const dispatch = f.exports.dispatch(f.connection, f.queued);
  await f.started.promise;
  f.finish.release();
  await dispatch;
  f.metadataRelease.release();
  await attach;
  assert.equal(visiblePromptCount(f.frames), 1);
  assert.equal(f.frames.find(frame => frame.type === "ready").messages.length, 1);
});

test("discarded empty-segment snapshot cannot retain stale handoff context", async () => {
  const f = fixture();
  f.addPriorSegment();
  f.holdMetadata();
  const attach = f.exports.attachHarnessChat(f.options);
  await f.metadataRead.promise;
  const dispatch = f.exports.dispatch(f.connection, f.queued);
  await f.started.promise;
  f.metadataRelease.release();
  try {
    await attach;
    const attached = [...f.exports.harnessChatConnections].find((c: any) => c.socket === f.options.socket) as any;
    assert.equal(attached.handoffContext, null, "a discarded empty snapshot must not prepend prior context to the next user turn");
    assert.equal(visiblePromptCount(f.frames), 1);
  } finally { f.finish.release(); await dispatch; }
});

test("background work finishing during attach reveals the terminal scheduled report", async () => {
  const f = fixture();
  f.scheduledReport();
  f.holdMetadata();
  const attach = f.exports.attachHarnessChat(f.options);
  await f.metadataRead.promise;
  f.finishBackground();
  f.metadataRelease.release();
  await attach;
  assert.deepEqual(f.frames.find(frame => frame.type === "ready").messages, [{ role: "assistant", text: "terminal report" }]);
  assert.equal(f.historyReads(), 2, "busy transition must rebuild scheduled projection without turn or input changes");
});

test("disconnect during metadata reads cleans up without retrying a changed snapshot", async () => {
  const f = fixture();
  f.holdMetadata();
  const attach = f.exports.attachHarnessChat(f.options);
  await f.metadataRead.promise;
  f.closeSocket();
  f.shared.session.messages.push({ role: "user", text: "arrived after disconnect" });
  f.metadataRelease.release();
  await attach;
  assert.equal(f.historyReads(), 1, "closed clients must not restart snapshot work");
  assert.equal(f.shared.clients.size, 0, "closed socket must leave the shared session");
  assert.equal(f.exports.harnessChatConnections.size, 0, "closed connection must leave the broadcast set");
  assert.equal(f.frames.some(frame => frame.type === "ready"), false);
});

test("assistant deltas during metadata reads do not restart or block attach", async () => {
  const f = fixture();
  const dispatch = f.exports.dispatch(f.connection, f.queued);
  await f.started.promise;
  f.holdMetadata();
  const attach = f.exports.attachHarnessChat(f.options);
  await f.metadataRead.promise;
  f.shared.liveEvents.push({ type: "textDelta", text: "still running" });
  f.shared.session.messages.push({ id: "assistant-1", role: "assistant", text: "still running" });
  f.metadataRelease.release();
  try {
    await attach;
    assert.equal(f.historyReads(), 1, "assistant stream alone must not invalidate history");
    assert.equal(visiblePromptCount(f.frames), 1);
    assert.ok(f.frames.some(frame => frame.type === "textDelta" && frame.text === "still running"));
  } finally { f.finish.release(); await dispatch; }
});
