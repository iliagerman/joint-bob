import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test, { after, afterEach, before } from "node:test";
import { getClusterMachineToken, getClusterNode } from "../src/cluster.js";
import { getOrCreateClusterIdentity } from "../src/cluster-identity.js";
import { signClusterRequest } from "../src/cluster-protocol.js";
import { selectiveSharingActive } from "../src/cluster-v2-mode.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { server } from "../src/server.js";
import { prepareLocalUpdate } from "../src/update-preparation-client.js";
import { prepareForUpdate } from "../src/server/realtime.js";
import { harnessSessionKey, harnessSessions, type SharedHarnessSession } from "../src/server/harness-sessions.js";
import { flags } from "../src/server/state.js";
import { nativePiSessionFixture } from "./native-pi-session-fixture.js";
import { completeUpdateRecovery, listPendingUpdateRecoveries, saveUpdateRecoveries } from "../src/update-recovery.js";

let url: string;
let port: number;
let token: string;
before(async () => {
  token = await getClusterMachineToken();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
  url = `http://127.0.0.1:${port}`;
});
afterEach(async () => {
  for (const record of await listPendingUpdateRecoveries()) await completeUpdateRecovery(record.id);
  harnessSessions.clear();
  flags.updatePreparing = false;
  flags.updatePreparation = null;
  server.emit("close");
});
after(async () => { server.close(); await once(server, "close"); });

function activeSession(sessionPath: string, abort: () => Promise<void>): SharedHarnessSession {
  return nativePiSessionFixture({
    id: "session", projectId: "project", cwd: "/tmp/project", file: sessionPath,
    busy: true, steering: ["queued steering"], abort,
  }).shared;
}

function setActiveSession(shared: SharedHarnessSession): void {
  harnessSessions.set(harnessSessionKey(shared.projectId, shared.engine, shared.session.id), shared);
}

async function machinePost(endpoint: string): Promise<Response> {
  return fetch(`${url}/api${endpoint}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}",
  });
}

async function signedSelfPrepare(): Promise<Response> {
  const target = "/api/cluster/v2/update/prepare";
  const body = Buffer.from("{}");
  const node = await getClusterNode();
  const database = await clusterV2Database();
  getOrCreateClusterIdentity(database, node.id);
  const authorization = signClusterRequest(database, node.id, node.id, "POST", target, body);
  return fetch(`${url}${target}`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body });
}

for (const legacyStatus of [401, 404]) {
  test(`first upgrade falls back from v2 ${legacyStatus} to authenticated legacy preparation`, async () => {
    let legacyRequests = 0;
    const fixture = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/cluster/v2/update/prepare") {
        response.statusCode = legacyStatus;
        response.end(JSON.stringify({ error: "unsupported" }));
        return;
      }
      if (request.url === "/api/update/prepare" && request.method === "POST") {
        legacyRequests++;
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        response.end(JSON.stringify({ ready: true, recoveryCount: 2 }));
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const address = fixture.address();
    assert.ok(address && typeof address !== "string");
    try {
      assert.equal(await prepareLocalUpdate(address.port), 2);
      assert.equal(legacyRequests, 1);
    } finally {
      fixture.close();
      await once(fixture, "close");
    }
  });
}

test("v2 preparation errors other than an absent legacy route stay fail-closed", async () => {
  let legacyRequests = 0;
  const fixture = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/cluster/v2/update/prepare") {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    legacyRequests++;
    response.end(JSON.stringify({ ready: true, recoveryCount: 0 }));
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  try {
    await assert.rejects(prepareLocalUpdate(address.port), /failed \(403\)/i);
    assert.equal(legacyRequests, 0);
  } finally {
    fixture.close();
    await once(fixture, "close");
  }
});

test("update preparation reports unhealthy while it fences writes", async () => {
  const prepared = await signedSelfPrepare();
  assert.equal(prepared.status, 200);
  assert.deepEqual(await prepared.json(), { ready: true, recoveryCount: 0 });
  const health = await fetch(`${url}/api/health`);
  assert.equal(health.status, 503, "an updating node is not writable or healthy");
  assert.equal((await health.json()).status, "updating");
  assert.equal(health.headers.get("retry-after"), "5");
  assert.equal((await machinePost("/cluster/update/install")).status, 503);
});

test("signed local preparation client succeeds idempotently while fenced", async () => {
  assert.equal(await prepareLocalUpdate(port), 0);
  assert.equal(await prepareLocalUpdate(port), 0);
  assert.equal(await selectiveSharingActive(), false, "self-update preparation must not activate selective sharing");
  assert.equal((await fetch(`${url}/api/health`)).status, 503);
});

test("failed recovery capture removes the write fence and allows a fresh preparation", async () => {
  setActiveSession(activeSession("", async () => {}));
  await assert.rejects(prepareForUpdate(), /no durable session identity/);
  assert.equal(flags.updatePreparing, false, "failure before stopping work must not strand the server");
  assert.equal(flags.updatePreparation, null, "a rejected preparation must not be cached forever");
  const response = await machinePost("/cluster/update/install");
  assert.equal(response.status, 403, "legacy installation is forbidden without being hidden by the fence");
  harnessSessions.clear();
  assert.equal(await prepareForUpdate(), 0);
});

test("an abandoned prepared update restarts through the service manager with recovery intact", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const exit = context.mock.method(process, "exit", () => undefined as never);
  const warnings = context.mock.method(console, "error", () => {});
  setActiveSession(activeSession("/tmp/session.jsonl", async () => {}));
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
  const response = await signedSelfPrepare();
  assert.equal(response.status, 409, "outstanding recovery must block another update, not be replaced");
  assert.equal(flags.updatePreparing, false);
  assert.deepEqual((await listPendingUpdateRecoveries()).map((record) => record.id), ["awaiting-recovery"]);
});

test("a stuck agent abort triggers the bounded service restart", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const exit = context.mock.method(process, "exit", () => undefined as never);
  context.mock.method(console, "error", () => {});
  let enteredAbort!: () => void;
  const abortStarted = new Promise<void>((resolve) => { enteredAbort = resolve; });
  let finishAbort!: () => void;
  const abortFinished = new Promise<void>((resolve) => { finishAbort = resolve; });
  setActiveSession(activeSession("/tmp/session.jsonl", () => { enteredAbort(); return abortFinished; }));
  const preparation = prepareForUpdate();
  context.mock.timers.tick(500);
  await abortStarted;
  const refused = assert.rejects(preparation, /Pi did not stop within 60 seconds/);
  context.mock.timers.tick(60_000);
  await refused;
  context.mock.timers.tick(119_999);
  assert.equal(exit.mock.callCount(), 0);
  context.mock.timers.tick(1);
  assert.deepEqual(exit.mock.calls.map((call) => call.arguments), [[1]], "service manager must recover a node whose agent will not stop");
  assert.equal(flags.updatePreparing, true);
  assert.equal((await listPendingUpdateRecoveries()).length, 1);
  finishAbort();
});
