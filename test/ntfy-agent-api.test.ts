import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import test, { after, before, beforeEach } from "node:test";
import { ntfyAgentEnvironment } from "../src/ntfy-agent.js";
import { addNtfyService, deleteNtfyService, listNtfyServices, setDefaultNtfyService } from "../src/ntfy.js";
import { settingsDatabase } from "../src/settings-store.js";
import { deletePushSubscription, ntfySubscription, savePushSubscription } from "../src/push.js";

let bridge: Server;
let bridgeUrl: string;

before(async () => {
  bridge = createServer((await import("../src/app.js")).createApp());
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const address = bridge.address(); if (!address || typeof address === "string") throw new Error("bridge address missing");
  bridgeUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => new Promise<void>((resolve) => bridge.close(() => resolve())));
beforeEach(() => { for (const service of listNtfyServices()) deleteNtfyService(service.id); });

function token(project = randomUUID(), conversation = randomUUID()): string {
  return ntfyAgentEnvironment(project, "pi", conversation).JOINT_BOB_NTFY_TOKEN!;
}
async function post(bearer: string | undefined, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${bridgeUrl}/api/ntfy/agent`, { method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function fixture(status = 200, location?: string) {
  const received: Array<{ authorization?: string; body: any; path?: string }> = [];
  const server = createServer((request, response) => { let raw = ""; request.setEncoding("utf8"); request.on("data", part => raw += part); request.on("end", () => { received.push({ authorization: request.headers.authorization, body: JSON.parse(raw), path: request.url }); response.statusCode = status; if (location) response.setHeader("location", location); response.end("upstream-fixture-secret"); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address missing");
  return { server, received, url: `http://127.0.0.1:${address.port}` };
}

 test("agent HTTP authentication is dedicated, expiring, and stores only hashes", async () => {
  assert.equal((await post(undefined, { operation: "status" })).status, 401);
  assert.equal((await post("bad", { operation: "status" })).status, 401);
  assert.equal((await post("a".repeat(64), { operation: "status" })).status, 401);
  const capability = token();
  assert.equal((await post(capability, { operation: "status" })).status, 200);
  const row = settingsDatabase().prepare("SELECT token_hash FROM ntfy_agent_tokens WHERE token_hash=?").get(createHash("sha256").update(capability).digest("hex"));
  assert.ok(row); assert.equal(JSON.stringify(row).includes(capability), false);
  settingsDatabase().prepare("UPDATE ntfy_agent_tokens SET expires_at=0 WHERE token_hash=?").run(createHash("sha256").update(capability).digest("hex"));
  assert.equal((await post(capability, { operation: "status" })).status, 401);
  const fresh = token();
  for (const [method, path, body] of [["GET", "/api/ntfy/services"], ["GET", "/api/settings"], ["POST", "/api/browser/agent", {}], ["POST", "/api/ntfy/services", {}]] as const) {
    const response = await fetch(`${bridgeUrl}${path}`, { method, headers: { authorization: `Bearer ${fresh}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test("agent endpoint independently rejects injected fields and malformed sends", async () => {
  const capability = token();
  const invalid = [
    { operation: "send", topic: "x", message: "ok", projectId: "other" },
    { operation: "send", topic: "x", message: "ok", url: "http://example.test" },
    { operation: "send", topic: "x", message: "ok", token: "secret" },
    { operation: "send", topic: "bad/topic", message: "ok" },
    { operation: "send", topic: "x", message: "" },
    { operation: "send", topic: "x", message: "x".repeat(4097) },
  ];
  for (const body of invalid) assert.equal((await post(capability, body)).status, 400, JSON.stringify(body));
});

test("sole service publishes exact UTF-8 payload, rotates credentials, and disappears immediately", async () => {
  const upstream = await fixture();
  const service = addNtfyService("Saved", `${upstream.url}/prefix`, "first-secret");
  const capability = token();
  try {
    assert.deepEqual((await post(capability, { operation: "status" })).body, { services: [{ id: service.id, name: "Saved" }], defaultTopic: null, hasConversationTarget: false });
    assert.deepEqual((await post(capability, { operation: "send", topic: "X", message: "héllo", title: "Ready" })).body, { ok: true, topic: "X" });
    assert.deepEqual(upstream.received[0], { authorization: "Bearer first-secret", body: { topic: "X", message: "héllo", title: "Ready" }, path: "/prefix" });
    const { save } = await import("../src/settings-store.js");
    save(settingsDatabase(), "ntfy.services", JSON.stringify([{ id: service.id, name: "Saved", url: `${upstream.url}/prefix`, token: "rotated" }]), true);
    await post(capability, { operation: "send", topic: "X", message: "again" });
    assert.equal(upstream.received[1].authorization, "Bearer rotated");
    save(settingsDatabase(), "ntfy.services", JSON.stringify([{ id: service.id, name: "Saved", url: `${upstream.url}/prefix`, token: "" }]), true);
    await post(capability, { operation: "send", topic: "X", message: "clear" });
    assert.equal(upstream.received[2].authorization, undefined);
    deleteNtfyService(service.id);
    assert.equal((await post(capability, { operation: "send", topic: "X", message: "gone" })).status, 409);
    assert.equal(upstream.received.length, 3);
  } finally { deleteNtfyService(service.id); await new Promise<void>(resolve => upstream.server.close(() => resolve())); }
});

test("the default service resolves multiple services and explicit selection overrides it", async () => {
  const one = await fixture(), two = await fixture();
  const first = addNtfyService("One", one.url, "one-token"), second = addNtfyService("Two", two.url, "two-token");
  const capability = token();
  try {
    assert.equal((await post(capability, { operation: "send", topic: "x", message: "default" })).status, 200);
    assert.equal(one.received[0].authorization, "Bearer one-token");
    assert.equal((await post(capability, { operation: "send", serviceId: randomUUID(), topic: "x", message: "unknown" })).status, 404);
    assert.equal(setDefaultNtfyService(second.id), true);
    assert.equal((await post(capability, { operation: "send", topic: "x", message: "new default" })).status, 200);
    assert.equal((await post(capability, { operation: "send", serviceId: first.id, topic: "x", message: "selected" })).status, 200);
    assert.equal(two.received[0].authorization, "Bearer two-token");
    assert.equal(one.received[1].authorization, "Bearer one-token");
  } finally { deleteNtfyService(first.id); deleteNtfyService(second.id); await Promise.all([one, two].map(value => new Promise<void>(resolve => value.server.close(() => resolve())))); }
});

test("conversation destinations are scoped, aliased, live-overridden, and topic-safe", async () => {
  const upstream = await fixture(), other = await fixture();
  const project = randomUUID(), conversation = randomUUID();
  const endpoints: string[] = [];
  const subscribe = async (url: string, topic: string, snapshot: string, targetProject = project, targetConversation = conversation) => {
    const value = ntfySubscription(url, topic, snapshot, targetProject, targetConversation); endpoints.push(value.endpoint);
    await savePushSubscription(value, "synthetic-user", targetProject, targetConversation, "Title");
  };
  try {
    await subscribe(other.url, "wrong-conversation", "other", project, randomUUID());
    await subscribe(other.url, "wrong-project", "other", randomUUID(), conversation);
    await subscribe(upstream.url, "default-topic", "snapshot");
    const capability = token(project, conversation);
    assert.deepEqual((await post(capability, { operation: "status" })).body, { services: [], defaultTopic: "default-topic", hasConversationTarget: true });
    await post(capability, { operation: "send", message: "default" });
    await post(capability, { operation: "send", topic: "override", message: "explicit" });
    assert.deepEqual(upstream.received.map(value => [value.authorization, value.body.topic]), [["Bearer snapshot", "default-topic"], ["Bearer snapshot", "override"]]);
    const local = addNtfyService("Local", upstream.url, "live");
    await post(capability, { operation: "send", message: "live" }); assert.equal(upstream.received[2].authorization, "Bearer live");
    settingsDatabase().exec("CREATE TABLE IF NOT EXISTS project_aliases(alias_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,created_at TEXT NOT NULL)");
    const alias = randomUUID(); settingsDatabase().exec("PRAGMA foreign_keys=OFF"); settingsDatabase().prepare("INSERT INTO project_aliases VALUES(?,?,?)").run(alias, project, new Date().toISOString());
    await post(token(alias, conversation), { operation: "send", message: "alias" }); assert.equal(upstream.received[3].authorization, "Bearer live");
    await subscribe(other.url, "other-topic", "other");
    assert.equal((await post(capability, { operation: "send", topic: "x", message: "ambiguous-server" })).status, 409);
    assert.equal((await post(capability, { operation: "send", serviceId: local.id, message: "selected-default" })).status, 200);
    deleteNtfyService(local.id);
  } finally {
    await Promise.all(endpoints.map(endpoint => deletePushSubscription(endpoint)));
    await Promise.all([upstream, other].map(value => new Promise<void>(resolve => value.server.close(() => resolve()))));
  }
});

test("same-server topic ambiguity and malformed persisted topics never publish", async () => {
  const upstream = await fixture(); const project = randomUUID(), conversation = randomUUID(); const endpoints: string[] = [];
  try {
    for (const configuredTopic of ["one", "two"]) { const subscription = ntfySubscription(upstream.url, configuredTopic, "snapshot", project, conversation); endpoints.push(subscription.endpoint); await savePushSubscription(subscription, "user", project, conversation, "Title"); }
    const capability = token(project, conversation);
    assert.equal((await post(capability, { operation: "send", message: "ambiguous" })).status, 409);
    assert.equal((await post(capability, { operation: "send", topic: "explicit", message: "ok" })).status, 200);
    await Promise.all(endpoints.splice(0).map(endpoint => deletePushSubscription(endpoint)));
    const malformed = ntfySubscription(upstream.url, "bad%2Ftopic", "snapshot", project, conversation); endpoints.push(malformed.endpoint); await savePushSubscription(malformed, "user", project, conversation, "Title");
    assert.equal((await post(capability, { operation: "send", message: "unsafe" })).status, 400); assert.equal(upstream.received.length, 1);
  } finally { await Promise.all(endpoints.map(endpoint => deletePushSubscription(endpoint))); await new Promise<void>(resolve => upstream.server.close(() => resolve())); }
});

test("redirects, upstream failures, closed ports, and invalid persisted URLs fail safely", async () => {
  const destination = await fixture(), redirect = await fixture(302, destination.url);
  const service = addNtfyService("Unsafe", redirect.url, "credential"); const capability = token();
  try {
    let result = await post(capability, { operation: "send", topic: "x", message: "once" });
    assert.equal(result.status, 502); assert.equal(destination.received.length, 0); assert.doesNotMatch(JSON.stringify(result.body), /credential|upstream-fixture-secret/);
    deleteNtfyService(service.id); await new Promise<void>(resolve => redirect.server.close(() => resolve()));
    const failed = await fixture(500); const bad = addNtfyService("Bad", failed.url, "credential");
    result = await post(capability, { operation: "send", topic: "x", message: "once" });
    assert.equal(result.status, 502); assert.doesNotMatch(JSON.stringify(result.body), /credential|upstream-fixture-secret/); assert.equal(failed.received.length, 1);
    deleteNtfyService(bad.id); await new Promise<void>(resolve => failed.server.close(() => resolve()));
    for (const url of ["ftp://example.test", "https://user:secret@example.test", "not a URL"]) {
      const invalid = addNtfyService("Invalid", url, "credential"); result = await post(capability, { operation: "send", topic: "x", message: "no" });
      assert.equal(result.status, 400); assert.doesNotMatch(JSON.stringify(result.body), /secret|example/); deleteNtfyService(invalid.id);
    }
  } finally { deleteNtfyService(service.id); await new Promise<void>(resolve => destination.server.close(() => resolve())); }
});
