import assert from "node:assert/strict";
import test from "node:test";
import { harnessSessions, harnessSessionKey, reapInactiveHarnessSessions, sendHarnessStatus, type SharedHarnessSession } from "../src/server/harness-sessions.js";
import { CONVERSATION_INACTIVITY_TIMEOUT_MS } from "../src/conversation-watchdog.js";
import { idleSessionTimeoutMs } from "../src/server/state.js";
import type { HarnessSession } from "../src/harnesses/runtime.js";

test("native busy state delays detached session disposal until work completes", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let busy = true;
  let disposed = false;
  const session = {
    id: "session-id",
    file: undefined,
    messages: [],
    isBusy: () => busy,
    status: () => ({ isStreaming: false, isCompacting: false }),
    dispose: () => { disposed = true; },
  } as unknown as HarnessSession;
  const shared = {
    engine: "pi",
    projectId: "project-id",
    cwd: "/tmp",
    session,
    clients: new Set(),
    turnInFlight: 1,
    lastLocalEventAt: 0,
    lastActivityAt: 0,
    liveEvents: [],
    idleTimer: null,
    unsubscribe: () => {},
  } as SharedHarnessSession;
  const key = harnessSessionKey(shared.projectId, shared.engine, session.id);
  harnessSessions.set(key, shared);

  sendHarnessStatus(shared);
  context.mock.timers.tick(idleSessionTimeoutMs);
  assert.equal(disposed, false);

  busy = false;
  shared.turnInFlight = 0;
  sendHarnessStatus(shared);
  context.mock.timers.tick(idleSessionTimeoutMs);
  assert.equal(disposed, true);
  assert.equal(harnessSessions.has(key), false);
});

test("conversation inactivity is five minutes", () => {
  assert.equal(CONVERSATION_INACTIVITY_TIMEOUT_MS, 5 * 60 * 1000);
});

test("inactive harness turns are cancelled once and leave recent turns alone", async () => {
  const now = Date.parse("2026-01-01T01:00:00.000Z");
  const cancelled: string[] = [];
  const makeShared = (id: string, lastActivityAt: number): SharedHarnessSession => {
    const session = {
      id, file: undefined, messages: [], isBusy: () => true,
      status: () => ({ isStreaming: true, isCompacting: false }),
      cancel: async () => { cancelled.push(id); },
    } as unknown as HarnessSession;
    const shared = {
      engine: "pi", projectId: "watchdog-project", cwd: "/tmp", session,
      clients: new Set(), turnInFlight: 1, lastLocalEventAt: lastActivityAt,
      lastActivityAt, liveEvents: [], idleTimer: null, unsubscribe: () => {}, scheduledTurn: false,
    } as SharedHarnessSession;
    harnessSessions.set(harnessSessionKey(shared.projectId, shared.engine, id), shared);
    return shared;
  };
  const stale = makeShared("stale", now - CONVERSATION_INACTIVITY_TIMEOUT_MS - 1);
  makeShared("boundary", now - CONVERSATION_INACTIVITY_TIMEOUT_MS);
  makeShared("recent", now - 1);
  const awaiting = makeShared("native-session", now - CONVERSATION_INACTIVITY_TIMEOUT_MS - 1);
  awaiting.conversationId = "logical-conversation";
  const callers = new Set([JSON.stringify([awaiting.projectId, awaiting.conversationId])]);

  try {
    await reapInactiveHarnessSessions(now, callers);
    await reapInactiveHarnessSessions(now + 1, callers);
    assert.deepEqual(cancelled, ["stale", "boundary"], "awaited shells protect their logical conversation, not other stale turns");
    await reapInactiveHarnessSessions(now + 2, new Set());
    assert.deepEqual(cancelled, ["stale", "boundary", "native-session"], "an expired caller no longer protects a silent turn");
    assert.equal(stale.watchdogStopping, true);
  } finally {
    harnessSessions.clear();
  }
});
