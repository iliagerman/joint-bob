import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import test, { after, before, beforeEach } from "node:test";
import { authenticate, createAdministrator, type AuthSession } from "../src/auth.js";
import { ntfyAgentEnvironment } from "../src/ntfy-agent.js";
import { addNtfyService, deleteNtfyService, getNtfyService, listNtfyServices } from "../src/ntfy.js";

const ADMIN = "tk_admin_secret";
let bridge: Server, bridgeUrl: string, session: AuthSession;

/** Mimics ntfy v2.11: PUT /v1/users adds a user, POST is unrouted, admin endpoints need the admin token. */
function fakeNtfy() {
  const users = new Map<string, { role: string; grants: Map<string, string> }>([
    ["*", { role: "anonymous", grants: new Map([["joint-bob*", "read-write"]]) }],
    ["phone", { role: "user", grants: new Map([["home-*", "read-only"]]) }],
  ]);
  const messages = [
    { id: "aaaaaaaaaaa1", time: 100, event: "open", topic: "alerts" },
    { id: "aaaaaaaaaaa2", time: 101, event: "message", topic: "alerts", message: "first", title: "One", tags: ["warning"], priority: 4 },
    { id: "aaaaaaaaaaa3", time: 102, event: "message", topic: "alerts", message: "second" },
  ];
  const requests: Array<{ method: string; path: string; body: any; authorization?: string }> = [];
  const server = createServer((request, response) => {
    let raw = ""; request.setEncoding("utf8"); request.on("data", (part) => raw += part);
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const url = new URL(request.url!, "http://ntfy");
      requests.push({ method: request.method!, path: `${url.pathname}${url.search}`, body, authorization: request.headers.authorization });
      const reply = (status: number, value: unknown) => { response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(typeof value === "string" ? value : JSON.stringify(value)); };
      const admin = request.headers.authorization === `Bearer ${ADMIN}`;
      if (url.pathname.endsWith("/json")) {
        if (!admin) return reply(403, { code: 40301, http: 403, error: "forbidden" });
        return reply(200, messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
      }
      if (url.pathname === "/v1/users" && request.method === "POST") return reply(404, { code: 40401, http: 404, error: "page not found" });
      if (!url.pathname.startsWith("/v1/users")) return reply(404, { code: 40401, http: 404, error: "page not found" });
      if (!admin) return reply(401, { code: 40101, http: 401, error: `unauthorized ${request.headers.authorization ?? ""}` });
      if (url.pathname === "/v1/users" && request.method === "GET") return reply(200, [...users].map(([username, user]) => ({ username, role: user.role, grants: [...user.grants].map(([topic, permission]) => ({ topic, permission })) })));
      if (url.pathname === "/v1/users" && request.method === "PUT") { users.set(body.username, { role: "user", grants: new Map() }); return reply(200, { success: true }); }
      if (url.pathname === "/v1/users" && request.method === "DELETE") { users.delete(body.username); return reply(200, { success: true }); }
      if (url.pathname === "/v1/users/access" && request.method === "PUT") { users.get(body.username)!.grants.set(body.topic, body.permission); return reply(200, { success: true }); }
      if (url.pathname === "/v1/users/access" && request.method === "DELETE") { users.get(body.username)!.grants.delete(body.topic); return reply(200, { success: true }); }
      reply(404, { error: "page not found" });
    });
  });
  return { server, users, requests };
}

let ntfy: ReturnType<typeof fakeNtfy>, ntfyUrl: string;

before(async () => {
  bridge = createServer((await import("../src/app.js")).createApp());
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const address = bridge.address(); if (!address || typeof address === "string") throw new Error("bridge address missing");
  bridgeUrl = `http://127.0.0.1:${address.port}`;
  createAdministrator("ntfy-admin-test", "synthetic-password-1234", false);
  session = authenticate("ntfy-admin-test", "synthetic-password-1234") as AuthSession;
});
after(async () => new Promise<void>((resolve) => bridge.close(() => resolve())));
beforeEach(async () => {
  for (const service of listNtfyServices()) deleteNtfyService(service.id);
  ntfy = fakeNtfy();
  await new Promise<void>((resolve) => ntfy.server.listen(0, "127.0.0.1", resolve));
  const address = ntfy.server.address(); if (!address || typeof address === "string") throw new Error("ntfy address missing");
  ntfyUrl = `http://127.0.0.1:${address.port}`;
});

async function closeNtfy() { await new Promise<void>((resolve) => ntfy.server.close(() => resolve())); }

async function agent(body: unknown, capability = ntfyAgentEnvironment(randomUUID(), "claude", randomUUID()).JOINT_BOB_NTFY_TOKEN!): Promise<{ status: number; body: any }> {
  const response = await fetch(`${bridgeUrl}/api/ntfy/agent`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${capability}` }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function settings(method: string, path: string, body?: unknown, csrf = true): Promise<{ status: number; body: any }> {
  const response = await fetch(`${bridgeUrl}${path}`, { method, headers: { cookie: `mb_session=${session.id}`, ...(csrf ? { "x-csrf-token": session.csrfToken } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : undefined };
}

test("agent manages topics as grants with distinct create, update and delete", async () => {
  addNtfyService("Home", ntfyUrl, ADMIN);
  try {
    const listed = await agent({ operation: "topics" });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.topics, [{ topic: "home-*", grants: [{ username: "phone", permission: "read-only" }] }, { topic: "joint-bob*", grants: [{ username: "*", permission: "read-write" }] }]);

    assert.deepEqual((await agent({ operation: "topic-create", topic: "alerts", username: "phone", permission: "read-only" })).body, { topic: { topic: "alerts", grants: [{ username: "phone", permission: "read-only" }] } });
    assert.equal((await agent({ operation: "topic-create", topic: "alerts", username: "phone", permission: "read-write" })).status, 409);
    assert.equal((await agent({ operation: "topic-update", topic: "alerts", username: "*", permission: "read-only" })).status, 404);
    assert.equal((await agent({ operation: "topic-update", topic: "alerts", username: "phone", permission: "read-write" })).status, 200);
    assert.equal(ntfy.users.get("phone")!.grants.get("alerts"), "read-write");
    await agent({ operation: "topic-create", topic: "alerts", username: "*", permission: "write-only" });

    assert.deepEqual((await agent({ operation: "topic-delete", topic: "alerts" })).body, { topic: "alerts", removed: ["*", "phone"] });
    assert.equal(ntfy.users.get("phone")!.grants.has("alerts"), false);
    assert.equal((await agent({ operation: "topic-delete", topic: "alerts" })).status, 404);
    assert.ok(ntfy.requests.every((request) => request.authorization === `Bearer ${ADMIN}`));
  } finally { await closeNtfy(); }
});

test("agent reads cached messages and manages users on ntfy 2.11", async () => {
  addNtfyService("Home", ntfyUrl, ADMIN);
  try {
    const read = await agent({ operation: "read", topic: "alerts", since: "10m", limit: 1 });
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, { topic: "alerts", messages: [{ id: "aaaaaaaaaaa3", time: 102, expires: null, topic: "alerts", title: null, message: "second", priority: null, tags: [], click: null, attachment: null }] });
    assert.ok(ntfy.requests.some((request) => request.path === "/alerts/json?poll=1&since=10m"));
    assert.equal((await agent({ operation: "read", topic: "alerts" })).body.messages[0].title, "One");
    assert.equal((await agent({ operation: "read" })).status, 400);

    assert.deepEqual((await agent({ operation: "user-create", username: "laptop", password: "pw-123" })).body, { username: "laptop" });
    assert.deepEqual(ntfy.requests.filter((request) => request.path === "/v1/users" && request.method !== "GET").map(({ method, body }) => [method, body]), [["POST", { username: "laptop", password: "pw-123" }], ["PUT", { username: "laptop", password: "pw-123" }]]);
    assert.deepEqual((await agent({ operation: "users" })).body.users.map((user: { username: string }) => user.username), ["*", "phone", "laptop"]);
    assert.equal((await agent({ operation: "user-delete", username: "laptop" })).status, 200);
    assert.equal(ntfy.users.has("laptop"), false);
    for (const body of [{ operation: "user-create", username: "*", password: "x" }, { operation: "user-delete", username: "*" }, { operation: "read", topic: "home-*" }, { operation: "topic-create", topic: "a/b", username: "phone", permission: "read-only" }, { operation: "topic-create", topic: "a", username: "phone", permission: "admin" }, { operation: "topics", url: ntfyUrl }]) {
      assert.equal((await agent(body)).status, 400, JSON.stringify(body));
    }
  } finally { await closeNtfy(); }
});

test("a non-admin token surfaces an admin hint without leaking credentials", async () => {
  addNtfyService("Home", ntfyUrl, "tk_publish_only");
  try {
    for (const body of [{ operation: "topics" }, { operation: "read", topic: "alerts" }]) {
      const result = await agent(body);
      assert.equal(result.status, 403);
      assert.match(result.body.error, /admin token/);
      assert.doesNotMatch(JSON.stringify(result.body), /tk_publish_only/);
    }
  } finally { await closeNtfy(); }
});

test("admin operations never fall back to a conversation's credential snapshot", async () => {
  try {
    const result = await agent({ operation: "topics" });
    assert.equal(result.status, 409);
    assert.equal(ntfy.requests.length, 0);
  } finally { await closeNtfy(); }
});

test("Settings routes replace the token and manage topics, messages and users", async () => {
  const service = addNtfyService("Home", ntfyUrl, "tk_publish_only");
  const base = `/api/ntfy/services/${service.id}`;
  try {
    assert.equal((await settings("GET", `${base}/topics`)).status, 403);
    assert.equal((await settings("PUT", base, { token: ADMIN }, false)).status, 403);
    assert.deepEqual((await settings("PUT", base, { token: ADMIN })).body, { service: { id: service.id, name: "Home", url: ntfyUrl, hasToken: true, isDefault: true } });
    assert.equal(getNtfyService(service.id)!.token, ADMIN);

    assert.equal((await settings("GET", `${base}/topics`)).body.topics.length, 2);
    assert.equal((await settings("PUT", `${base}/topics`, { topic: "alerts", username: "phone", permission: "read-only" })).body.topic.topic, "alerts");
    assert.deepEqual((await settings("DELETE", `${base}/topics`, { topic: "alerts", username: "phone" })).body, { topic: "alerts", removed: ["phone"] });
    assert.equal((await settings("GET", `${base}/messages?topic=alerts&limit=5`)).body.messages.length, 2);
    assert.equal((await settings("GET", `${base}/messages?topic=home-*`)).status, 400);
    assert.deepEqual((await settings("POST", `${base}/users`, { username: "laptop", password: "pw" })).body, { username: "laptop" });
    assert.equal((await settings("GET", `${base}/users`)).body.users.length, 3);
    assert.deepEqual((await settings("DELETE", `${base}/users/laptop`)).body, { username: "laptop" });
    assert.equal((await settings("GET", `/api/ntfy/services/${randomUUID()}/topics`)).status, 404);

    assert.equal((await settings("PUT", base, { name: "Renamed" })).body.service.name, "Renamed");
    assert.equal(getNtfyService(service.id)!.token, ADMIN, "an omitted token keeps the stored one");
    assert.doesNotMatch(JSON.stringify((await settings("GET", "/api/ntfy/services")).body), new RegExp(ADMIN));
  } finally { await closeNtfy(); }
});
