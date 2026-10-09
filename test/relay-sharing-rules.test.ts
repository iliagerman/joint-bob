// RELAY-PLAN.md §4.10 rules 4 and 5: a relay channel carries signed machine requests only
// from the machine it proved, and nothing arriving through a relay is treated as local.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Request, Response } from "express";
import { getClusterNode } from "../src/cluster.js";
import { getOrCreateClusterIdentity, pinClusterPublicKey } from "../src/cluster-identity.js";
import { signClusterRequest } from "../src/cluster-protocol.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { RelayStream } from "../src/relay/stream.js";
import { requireHttpAuth } from "../src/server/http-auth.js";
import { ntfyAgentEnvironment } from "../src/ntfy-agent.js";

const root = await mkdtemp(path.join(os.tmpdir(), "relay-rules-"));
test.after(() => rm(root, { recursive: true, force: true }));

interface Outcome { status: number | undefined; passed: boolean; locals: Record<string, unknown> }

async function machine(): Promise<{ id: string; db: DatabaseSync }> {
  const id = randomUUID();
  const db = new DatabaseSync(path.join(root, `${id}.db`));
  const local = await clusterV2Database();
  pinClusterPublicKey(local, id, getOrCreateClusterIdentity(db, id).publicKey);
  return { id, db };
}

async function signedRequest(sender: { id: string; db: DatabaseSync }, socket: unknown, extraHeaders: Record<string, string> = {}): Promise<Outcome> {
  const local = await getClusterNode();
  getOrCreateClusterIdentity(await clusterV2Database(), local.id);
  const target = "/api/cluster/v2/runtime/projects/presence?projectId=x";
  const headers: Record<string, string> = { authorization: signClusterRequest(sender.db, sender.id, local.id, "GET", target, Buffer.alloc(0)), ...extraHeaders };
  const request = {
    method: "GET", path: target.slice(4).split("?")[0], originalUrl: target, socket,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  const outcome: Outcome = { status: undefined, passed: false, locals: {} };
  const response = {
    locals: outcome.locals,
    status(code: number) { outcome.status = code; return this; },
    json() { return this; },
  } as unknown as Response;
  await requireHttpAuth(request, response, () => { outcome.passed = true; });
  return outcome;
}

function peerChannel(nodeId: string): RelayStream {
  const stream = new RelayStream("peer", undefined);
  stream.relayPeer = { nodeId, publicKey: "unused" };
  return stream;
}

test("a signed request is accepted on a channel proven by the same machine", async () => {
  const sender = await machine();
  const outcome = await signedRequest(sender, peerChannel(sender.id));
  assert.equal(outcome.passed, true, JSON.stringify(outcome));
  assert.equal(outcome.locals.machineNodeId, sender.id);
});

test("a request signed by one machine but carried on another machine's channel is refused", async () => {
  const sender = await machine();
  const carrier = await machine();
  const outcome = await signedRequest(sender, peerChannel(carrier.id));
  assert.equal(outcome.passed, false);
  assert.equal(outcome.status, 401);
});

test("machine requests are refused on the phone gateway", async () => {
  const sender = await machine();
  const gateway = new RelayStream("gateway", undefined);
  gateway.remoteAddress = "127.0.0.1";
  const outcome = await signedRequest(sender, gateway);
  assert.equal(outcome.passed, false);
  assert.equal(outcome.status, 401);
});

test("local agent capability tokens work locally but are ignored on relay connections", async () => {
  const token = ntfyAgentEnvironment(randomUUID(), "claude", randomUUID()).JOINT_BOB_NTFY_TOKEN!;
  const attempt = async (socket: unknown): Promise<{ passed: boolean; status: number | undefined }> => {
    const request = {
      method: "POST", path: "/ntfy/agent", originalUrl: "/api/ntfy/agent", socket,
      header: (name: string) => ({ authorization: `Bearer ${token}` } as Record<string, string>)[name.toLowerCase()],
    } as unknown as Request;
    let status: number | undefined;
    let passed = false;
    const response = { locals: {}, status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
    await requireHttpAuth(request, response, () => { passed = true; });
    return { passed, status };
  };
  assert.deepEqual(await attempt({ remoteAddress: "127.0.0.1" }), { passed: true, status: undefined }, "the token is valid for a local agent");
  assert.deepEqual(await attempt(new RelayStream("gateway", undefined)), { passed: false, status: 401 }, "the same token is refused through the phone gateway");
  assert.deepEqual(await attempt(peerChannel(randomUUID())), { passed: false, status: 401 }, "and through a machine channel");
});

/** Sends one raw HTTP request into the real app over a relay stream and returns the status code. */
async function throughChannel(kind: "peer" | "gateway", method: string, target: string, headers = ""): Promise<number> {
  return (await rawThroughChannel(kind, method, target, headers)).status;
}

async function rawThroughChannel(kind: "peer" | "gateway", method: string, target: string, headers = ""): Promise<{ status: number; body: string }> {
  const { server } = await import("../src/server/state.js");
  await import("../src/server/routes/core.js");
  const stream = new RelayStream(kind, undefined);
  if (kind === "gateway") stream.remoteAddress = "198.51.100.7";
  const chunks: Buffer[] = [];
  const closed = new Promise<void>((resolve) => {
    stream.attach({ sendData: (_channel, payload) => { chunks.push(Buffer.from(payload)); }, sendWindow: () => undefined, sendClose: () => resolve(), forget: () => undefined }, 1);
  });
  server.emit("connection", stream);
  stream.receiveData(Buffer.from(`${method} ${target} HTTP/1.1\r\nHost: machine.example\r\nConnection: close\r\nContent-Length: 0\r\n${headers}\r\n`));
  await closed;
  const text = Buffer.concat(chunks).toString("latin1");
  return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]), body: text.slice(text.indexOf("\r\n\r\n") + 4) };
}

test("a machine channel reaches only machine routes, never this machine's UI or sign-in", async () => {
  assert.equal(await throughChannel("peer", "GET", "/api/auth/status"), 404);
  assert.equal(await throughChannel("peer", "GET", "/"), 404);
  assert.equal(await throughChannel("peer", "POST", "/api/auth/login"), 404);
  assert.equal(await throughChannel("peer", "GET", "/api/health"), 200);
  assert.equal(await throughChannel("peer", "GET", "/api/cluster/v2/runtime/projects/presence"), 401, "machine routes still need a valid signature");
});

test("the phone gateway serves the UI but not machine routes, in any letter case", async () => {
  assert.equal(await throughChannel("gateway", "GET", "/api/auth/status"), 200);
  assert.equal(await throughChannel("gateway", "POST", "/api/cluster/v2/membership/redeem"), 404);
  assert.equal(await throughChannel("gateway", "POST", "/API/Cluster/V2/membership/redeem"), 404);
  assert.equal(await throughChannel("gateway", "POST", "/api/auth/setup"), 404);
  assert.equal(await throughChannel("gateway", "POST", "/api/ntfy/agent"), 404);
});

test("through the phone gateway only the __Host- session cookie counts, so a sibling name cannot plant one", async () => {
  const { authenticate, createAdministrator, authenticationStatus, gatewaySessionCookieName, sessionCookieName } = await import("../src/auth.js");
  if (authenticationStatus().setupRequired) createAdministrator("relay-admin", "relay-admin-password-1", false);
  const session = authenticate("relay-admin", "relay-admin-password-1") as { id: string };
  const status = async (cookie: string): Promise<boolean> => (JSON.parse((await rawThroughChannel("gateway", "GET", "/api/auth/status", `Cookie: ${cookie}\r\n`)).body) as { authenticated: boolean }).authenticated;
  assert.equal(await status(`${sessionCookieName}=${session.id}`), false, "a plain session cookie, which a sibling could plant, is ignored on the gateway");
  assert.equal(await status(`${gatewaySessionCookieName}=${session.id}`), true);
  assert.match(gatewaySessionCookieName, /^__Host-/);
});

test("the owner can close phone sign-in to other users: they get a wrong-password answer, and open phone sessions stop", async () => {
  const { authenticate, createAdministrator, authenticationStatus, gatewaySessionCookieName, upsertReplicatedUser } = await import("../src/auth.js");
  const { setPhonePolicyDatabase } = await import("../src/relay/phone-policy.js");
  const { setOtherUsersPhoneSignIn } = await import("../src/relay/store.js");
  if (authenticationStatus().setupRequired) createAdministrator("relay-admin", "relay-admin-password-1", false);
  const db = await clusterV2Database();
  const admin = db.prepare("SELECT password_hash, password_salt FROM users WHERE username='relay-admin'").get() as { password_hash: Uint8Array; password_salt: Uint8Array };
  // Another user whose home is a different machine, with the same password for the test.
  upsertReplicatedUser({ username: "visiting-user", passwordHash: Buffer.from(admin.password_hash), passwordSalt: Buffer.from(admin.password_salt), homeNodeId: randomUUID() });
  setPhonePolicyDatabase(db);
  try {
    const visitor = authenticate("visiting-user", "relay-admin-password-1") as { id: string };
    const phoneRequest = async (): Promise<number> => (await rawThroughChannel("gateway", "GET", "/api/auth/sessions", `Cookie: ${gatewaySessionCookieName}=${visitor.id}\r\n`)).status;
    const status = async (): Promise<boolean> => (JSON.parse((await rawThroughChannel("gateway", "GET", "/api/auth/status", `Cookie: ${gatewaySessionCookieName}=${visitor.id}\r\n`)).body) as { authenticated: boolean }).authenticated;
    assert.equal(await phoneRequest(), 200, "allowed while the owner allows it");
    assert.equal(await status(), true);
    setOtherUsersPhoneSignIn(db, false);
    assert.equal(await phoneRequest(), 403, "an open phone session of another user stops");
    assert.equal(await status(), false, "and reads as signed out");
    assert.throws(() => authenticate("visiting-user", "relay-admin-password-1", { homeUsersOnly: true }), /Invalid username or password/, "a new sign-in looks like a wrong password");
    assert.doesNotThrow(() => authenticate("relay-admin", "relay-admin-password-1", { homeUsersOnly: true }), "the machine's own users are unaffected");
  } finally {
    setOtherUsersPhoneSignIn(db, true);
    setPhonePolicyDatabase(undefined);
  }
});

/** Opens the app's WebSocket through a phone gateway channel and reports the close frame the server sends, if any. */
async function gatewaySocket(target: string, cookie: string): Promise<{ closeReason: () => string | undefined }> {
  const { server } = await import("../src/server/state.js");
  await import("../src/server/routes/core.js");
  await import("../src/server/chat-socket.js");
  const stream = new RelayStream("gateway", undefined);
  stream.remoteAddress = "198.51.100.7";
  let received = Buffer.alloc(0);
  stream.attach({ sendData: (_channel, payload) => { received = Buffer.concat([received, payload]); }, sendWindow: () => undefined, sendClose: () => undefined, forget: () => undefined }, 1);
  server.emit("connection", stream);
  stream.receiveData(Buffer.from([
    `GET ${target} HTTP/1.1`, "Host: machine.example", "Origin: http://machine.example", "Connection: Upgrade", "Upgrade: websocket",
    "Sec-WebSocket-Version: 13", `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
    `Cookie: ${cookie}`, "", "",
  ].join("\r\n")));
  const deadline = Date.now() + 5_000;
  while (!received.includes("\r\n\r\n")) {
    if (Date.now() > deadline) throw new Error("The WebSocket upgrade got no answer");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(received.toString("latin1"), /^HTTP\/1\.1 101 /, "the socket opens through the gateway");
  return {
    closeReason: () => {
      // Server frames are unmasked: opcode, length, payload. A close frame carries a 2-byte code, then the reason.
      let offset = received.indexOf("\r\n\r\n") + 4;
      while (offset + 2 <= received.length) {
        const opcode = received[offset] & 0x0f;
        let length = received[offset + 1] & 0x7f;
        let start = offset + 2;
        if (length === 126) { length = received.readUInt16BE(start); start += 2; } else if (length === 127) { length = Number(received.readBigUInt64BE(start)); start += 8; }
        if (start + length > received.length) return undefined;
        if (opcode === 0x8) return received.subarray(start + 2, start + length).toString("utf8");
        offset = start + length;
      }
      return undefined;
    },
  };
}

test("turning off other users' phone sign-in closes their open phone sockets at once, and only theirs", async () => {
  const { authenticate, createAdministrator, authenticationStatus, gatewaySessionCookieName, upsertReplicatedUser } = await import("../src/auth.js");
  const { setPhonePolicyDatabase, setOtherUsersMayUsePhone } = await import("../src/relay/phone-policy.js");
  const { addProject } = await import("../src/store.js");
  if (authenticationStatus().setupRequired) createAdministrator("relay-admin", "relay-admin-password-1", false);
  const db = await clusterV2Database();
  const admin = db.prepare("SELECT password_hash, password_salt FROM users WHERE username='relay-admin'").get() as { password_hash: Uint8Array; password_salt: Uint8Array };
  upsertReplicatedUser({ username: "phone-visitor", passwordHash: Buffer.from(admin.password_hash), passwordSalt: Buffer.from(admin.password_salt), homeNodeId: randomUUID() });
  const project = await addProject("relay-socket", path.join(root, "relay-socket"));
  setPhonePolicyDatabase(db);
  try {
    const visitor = authenticate("phone-visitor", "relay-admin-password-1") as { id: string };
    const owner = authenticate("relay-admin", "relay-admin-password-1") as { id: string };
    const visiting = await gatewaySocket(`/ws?projectId=${project.id}`, `${gatewaySessionCookieName}=${visitor.id}`);
    const local = await gatewaySocket(`/ws?projectId=${project.id}`, `${gatewaySessionCookieName}=${owner.id}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(visiting.closeReason(), undefined, "the socket stays open while the owner allows it");
    setOtherUsersMayUsePhone(db, false);
    const deadline = Date.now() + 5_000;
    while (visiting.closeReason() === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(visiting.closeReason(), "Phone sign-in for other users is off");
    assert.equal(local.closeReason(), undefined, "the machine's own users keep their phone sockets");
  } finally {
    setOtherUsersMayUsePhone(db, true);
    setPhonePolicyDatabase(undefined);
  }
});
