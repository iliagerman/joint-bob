import assert from "node:assert/strict";
import test from "node:test";
import { harnessSessions, harnessSessionKey, sendHarnessStatus, type SharedHarnessSession } from "../src/server/harness-sessions.js";
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
