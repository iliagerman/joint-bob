import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { getOrCreateClusterIdentity, pinClusterPublicKey } from "../src/cluster-identity.js";
import { signClusterRequest } from "../src/cluster-protocol.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { authenticate, createAdministrator, sessionCookieName } from "../src/auth.js";
import { getClusterMachineToken, getClusterNode } from "../src/cluster.js";
import { app, server } from "../src/server.js";

const senderId = randomUUID();
const senderDirectory = mkdtempSync(path.join(process.env.HOME!, "cluster-v2-http-"));
const senderDatabase = new DatabaseSync(path.join(senderDirectory, "sender.db"));
let origin: string;
let recipientId: string;
let probeInvocations = 0;
let sessionCookie: string;
let csrfToken: string;

app.all("/api/cluster/v2/test-auth-probe", (request, response) => {
  probeInvocations += 1;
  response.json({
    machineNodeId: response.locals.machineNodeId,
    machineProtocol: response.locals.machineProtocol,
    body: request.body,
  });
});

before(async () => {
  createAdministrator("cluster-http-test", "synthetic-password-for-tests", false);
  const session = authenticate("cluster-http-test", "synthetic-password-for-tests");
  sessionCookie = `${sessionCookieName}=${session.id}`;
  csrfToken = session.csrfToken;
  const senderIdentity = getOrCreateClusterIdentity(senderDatabase, senderId);
  recipientId = (await getClusterNode()).id;
  pinClusterPublicKey(await clusterV2Database(), senderId, senderIdentity.publicKey);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  senderDatabase.close();
  rmSync(senderDirectory, { recursive: true, force: true });
});

async function send(target: string, method: string, body: Buffer, authorization?: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${origin}${target}`, {
    method,
    headers: { ...(body.length ? { "content-type": "application/json" } : {}), ...headers, ...(authorization ? { authorization } : {}) },
    body: body.length ? body : undefined,
  });
}

test("production middleware verifies exact v2 request bytes, target, identity, and replay", async () => {
  const target = "/api/cluster/v2/test-auth-probe?mode=exact";
  const body = Buffer.from('{ "actorNodeId": "forged", "value": 1 }');
  const authorization = signClusterRequest(senderDatabase, senderId, recipientId, "POST", target, body);
  const valid = await send(target, "POST", body, authorization);
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { machineNodeId: senderId, machineProtocol: 2, body: { actorNodeId: "forged", value: 1 } });

  const changedBytes = await send(target, "POST", Buffer.from('{"actorNodeId":"forged","value":1}'), signClusterRequest(senderDatabase, senderId, recipientId, "POST", target, body));
  assert.equal(changedBytes.status, 401);
  const changedQuery = await send(`${target}2`, "POST", body, signClusterRequest(senderDatabase, senderId, recipientId, "POST", target, body));
  assert.equal(changedQuery.status, 401);
  assert.equal((await send(target, "POST", body)).status, 401);

  const getTarget = "/api/cluster/v2/test-auth-probe?empty=1";
  const replayHeader = signClusterRequest(senderDatabase, senderId, recipientId, "GET", getTarget, Buffer.alloc(0));
  assert.equal((await send(getTarget, "GET", Buffer.alloc(0), replayHeader)).status, 200);
  assert.equal((await send(getTarget, "GET", Buffer.alloc(0), replayHeader)).status, 401);
  assert.equal(probeInvocations, 2);
});

test("v2 authentication cannot be bypassed by Express route casing", async () => {
  const canonicalTarget = "/api/cluster/v2/test-auth-probe";
  const mixedCaseTarget = "/api/CLUSTER/V2/test-auth-probe";
  const body = Buffer.from('{ "value": 1 }');
  const sessionHeaders = { cookie: sessionCookie, "x-csrf-token": csrfToken };
  const initialInvocations = probeInvocations;

  assert.equal((await send(canonicalTarget, "POST", body, undefined, sessionHeaders)).status, 401);
  assert.equal((await send(mixedCaseTarget, "POST", body, undefined, sessionHeaders)).status, 401);
  assert.equal(probeInvocations, initialInvocations);

  const legacyBearer = `Bearer ${await getClusterMachineToken()}`;
  assert.equal((await send(mixedCaseTarget, "POST", body, legacyBearer)).status, 401);
  assert.equal(probeInvocations, initialInvocations);

  const mixedCaseAuthorization = signClusterRequest(senderDatabase, senderId, recipientId, "POST", mixedCaseTarget, body);
  const valid = await send(mixedCaseTarget, "POST", body, mixedCaseAuthorization);
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { machineNodeId: senderId, machineProtocol: 2, body: { value: 1 } });

  const wrongCaseAuthorization = signClusterRequest(senderDatabase, senderId, recipientId, "POST", canonicalTarget, body);
  assert.equal((await send(mixedCaseTarget, "POST", body, wrongCaseAuthorization)).status, 401);
  assert.equal(probeInvocations, initialInvocations + 1);
});

test("v2 root query parser failures do not expose request body", async () => {
  for (const target of ["/api/cluster/v2?mode=root", "/api/CLUSTER/V2?mode=root"]) {
    const sentinel = `SYNTHETIC_ROOT_SECRET_${target.includes("CLUSTER") ? "MIXED" : "CANONICAL"}`;
    const malformed = Buffer.from(`{"secret":"${sentinel}"`);
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...values: unknown[]) => { errors.push(values); };
    try {
      const response = await send(target, "POST", malformed);
      const responseText = await response.text();
      assert.equal(response.status, 400);
      assert.deepEqual(JSON.parse(responseText), { error: "Malformed cluster JSON" });
      assert.equal(responseText.includes(sentinel), false);
    } finally { console.error = original; }
    assert.equal(JSON.stringify(errors).includes(sentinel), false);
  }
});

test("v2 rejects ignored, encoded, and malformed bodies generically", async () => {
  const target = "/api/cluster/v2/test-auth-probe";
  const emptySignature = signClusterRequest(senderDatabase, senderId, recipientId, "POST", target, Buffer.alloc(0));
  assert.equal((await send(target, "POST", Buffer.from("secret"), emptySignature, { "content-type": "text/plain" })).status, 415);
  assert.equal((await send(target, "POST", Buffer.from("compressed"), emptySignature, { "content-encoding": "gzip" })).status, 415);
  const sentinel = "SENSITIVE_SENTINEL";
  const malformed = Buffer.from(`{"secret":"${sentinel}"`);
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => { errors.push(values); };
  try {
    const response = await send(target, "POST", malformed, signClusterRequest(senderDatabase, senderId, recipientId, "POST", target, malformed));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Malformed cluster JSON" });
  } finally { console.error = original; }
  assert.equal(JSON.stringify(errors).includes(sentinel), false);
});
