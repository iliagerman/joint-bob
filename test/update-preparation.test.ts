import assert from "node:assert/strict";
import { once } from "node:events";
import test, { after, afterEach, before } from "node:test";
import { getClusterMachineToken } from "../src/cluster.js";
import { server } from "../src/server.js";
import { prepareForUpdate } from "../src/server/realtime.js";
import { flags, sharedSessions, type SharedPiSession } from "../src/server/state.js";
import { completeUpdateRecovery, listPendingUpdateRecoveries, saveUpdateRecoveries } from "../src/update-recovery.js";

let url: string;
let token: string;
before(async () => {
  token = await getClusterMachineToken();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  url = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  for (const record of await listPendingUpdateRecoveries()) await completeUpdateRecovery(record.id);
  sharedSessions.clear();
  flags.updatePreparing = false;
  flags.updatePreparation = null;
  server.emit("close");
});
after(async () => { server.close(); await once(server, "close"); });

function activeSession(sessionPath: string, abort: () => Promise<void>): SharedPiSession {
  return {
    projectId: "project", cwd: "/tmp/project", clients: new Set(),
    handle: { session: {
      sessionId: "session", sessionFile: sessionPath, isStreaming: true,
      getSteeringMessages: () => ["queued steering"], getFollowUpMessages: () => [],
      clearQueue: () => {}, abortRetry: () => {}, abortCompaction: () => {},
      abortBranchSummary: () => {}, abortBash: () => {}, abort,
    } },
  } as unknown as SharedPiSession;
}

function machinePost(endpoint: string): Promise<Response> {
  return fetch(`${url}/api${endpoint}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}",
  });
}

test("update preparation reports unhealthy while it fences writes", async () => {
  const prepared = await machinePost("/update/prepare");
  assert.equal(prepared.status, 200);
  assert.deepEqual(await prepared.json(), { ready: true, recoveryCount: 0 });
  const health = await fetch(`${url}/api/health`);
  assert.equal(health.status, 503, "an updating node is not writable or healthy");
  assert.equal((await health.json()).status, "updating");
  assert.equal(health.headers.get("retry-after"), "5");
  assert.equal((await machinePost("/cluster/update/install")).status, 503);
});

test("failed recovery capture removes the write fence and allows a fresh preparation", async () => {
  sharedSessions.set("broken", activeSession("", async () => {}));
  await assert.rejects(prepareForUpdate(), /no durable session identity/);
  assert.equal(flags.updatePreparing, false, "failure before stopping work must not strand the server");
  assert.equal(flags.updatePreparation, null, "a rejected preparation must not be cached forever");
  const response = await machinePost("/cluster/update/install");
  assert.equal(response.status, 409, "the request reaches the development-checkout validation");
  sharedSessions.clear();
  assert.equal(await prepareForUpdate(), 0);
});

test("an abandoned prepared update restarts through the service manager with recovery intact", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const exit = context.mock.method(process, "exit", () => undefined as never);
  const warnings = context.mock.method(console, "error", () => {});
  sharedSessions.set("active", activeSession("/tmp/session.jsonl", async () => {}));
  const preparation = prepareForUpdate();
  context.mock.timers.tick(500);
  assert.equal(await preparation, 1);
  context.mock.timers.tick(179_999);
  assert.equal(exit.mock.callCount(), 0);
  context.mock.timers.tick(1);
  assert.deepEqual(exit.mock.calls.map((call) => call.arguments), [[1]], "native Restart/KeepAlive must be triggered");
  assert.match(String(warnings.mock.calls[0]?.arguments[0]), /update was not activated/i);
  assert.equal(flags.updatePreparing, true, "never allow new work to race partially stopped agents");
  const records = await listPendingUpdateRecoveries();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].queuedPrompts, ["queued steering"]);
});

test("another update cannot replace work still waiting for recovery", async () => {
  await saveUpdateRecoveries([{
    id: "awaiting-recovery", kind: "chat", engine: "pi", projectId: "project", cwd: "/tmp/project",
    sessionId: "session", sessionPath: "/tmp/session.jsonl", taskId: null, phase: null,
    queuedPrompts: ["unfinished work"], model: null, effort: null, createdAt: new Date().toISOString(),
  }]);
  const response = await machinePost("/update/prepare");
  assert.equal(response.status, 409, "outstanding recovery must block another update, not be replaced");
  assert.equal(flags.updatePreparing, false);
  assert.deepEqual((await listPendingUpdateRecoveries()).map((record) => record.id), ["awaiting-recovery"]);
});

test("a stuck agent abort refuses the update without restarting over live tools", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const exit = context.mock.method(process, "exit", () => undefined as never);
  context.mock.method(console, "error", () => {});
  let enteredAbort!: () => void;
  const abortStarted = new Promise<void>((resolve) => { enteredAbort = resolve; });
  let finishAbort!: () => void;
  const abortFinished = new Promise<void>((resolve) => { finishAbort = resolve; });
  sharedSessions.set("active", activeSession("/tmp/session.jsonl", () => { enteredAbort(); return abortFinished; }));
  const preparation = prepareForUpdate();
  context.mock.timers.tick(500);
  await abortStarted;
  const refused = assert.rejects(preparation, /Pi did not stop within 60 seconds/);
  context.mock.timers.tick(60_000);
  await refused;
  context.mock.timers.tick(300_000);
  assert.equal(exit.mock.callCount(), 0, "a non-exiting agent must not be replayed over live tools");
  assert.equal(flags.updatePreparing, true);
  assert.equal((await listPendingUpdateRecoveries()).length, 1);
  finishAbort();
});
