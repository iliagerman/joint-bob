import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let session: SignedIn;
let ntfy: Server;
let ntfyUrl: string;
const published: Array<{ topic: string; title: string; message: string }> = [];

before(async () => {
  ntfy = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (part) => { raw += part; });
    request.on("end", () => { published.push(JSON.parse(raw)); response.end("{}"); });
  });
  await new Promise<void>((resolve) => ntfy.listen(0, "127.0.0.1", resolve));
  const address = ntfy.address();
  if (!address || typeof address === "string") throw new Error("ntfy fixture address missing");
  ntfyUrl = `http://127.0.0.1:${address.port}`;
  root = await mkdtemp(path.join(os.tmpdir(), "jb-error-reporting-api-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  session = await signIn(environment, node);
}, { timeout: 120_000 });

after(async () => {
  if (server) await stopDevNode(server);
  await new Promise<void>((resolve) => ntfy.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});

function raw(endpoint: string, body: string, signedIn = true): Promise<Response> {
  return fetch(`${node.url}/api${endpoint}`, {
    method: endpoint === "/error-reporting" ? "PUT" : "POST",
    headers: { "Content-Type": "application/json", ...(signedIn ? { Cookie: session.cookie, "x-csrf-token": session.csrfToken } : {}) },
    body,
  });
}

test("a malformed JSON body is the client's mistake: 400, not a reported server error", async () => {
  const response = await raw("/error-reporting", "{not json");
  assert.equal(response.status, 400, await response.text());
});

test("client errors need a signed-in browser and a well-formed report", async () => {
  assert.equal((await raw("/client-errors", JSON.stringify({ kind: "error", message: "x" }), false)).status, 401);
  assert.equal((await raw("/client-errors", JSON.stringify({ kind: "warn", message: "x" }))).status, 400);
  assert.equal((await raw("/client-errors", JSON.stringify({ kind: "error", message: "" }))).status, 400);
  assert.equal((await raw("/client-errors", JSON.stringify({ kind: "error", message: "x".repeat(4_001) }))).status, 400);
  assert.equal((await raw("/client-errors", JSON.stringify({ kind: "error", message: "off" }))).status, 202, "accepted and dropped while reporting is off");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(published.length, 0);
});

test("Settings saves error reporting and the node forwards client errors to the chosen topic", async () => {
  const added = await api<{ service: { id: string } }>(node, session, "POST", "/ntfy/services", { name: "Errors", url: ntfyUrl });
  assert.equal(added.status, 201);
  const serviceId = added.body.service.id;
  const rejected = await api<{ error: string }>(node, session, "PUT", "/error-reporting", { enabled: true, sameDestination: true, client: { enabled: true, serviceId, topic: "" }, backend: { enabled: true, serviceId: null, topic: "" } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /Client errors need a topic/);

  const settings = { enabled: true, sameDestination: true, client: { enabled: true, serviceId, topic: "joint-bob-errors" }, backend: { enabled: true, serviceId: null, topic: "" } };
  assert.equal((await api(node, session, "PUT", "/error-reporting", settings)).status, 200);
  assert.deepEqual((await api(node, session, "GET", "/error-reporting")).body, settings);

  const accepted = await raw("/client-errors", JSON.stringify({ kind: "unhandled", message: "TypeError: Load failed {\"method\":\"GET\",\"path\":\"/api/reviews/pending\",\"status\":0}\napi@http://localhost/app/api.js:17:20", page: "/#chat" }));
  assert.equal(accepted.status, 202);
  const deadline = Date.now() + 5_000;
  while (!published.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(published.length, 1);
  assert.equal(published[0].topic, "joint-bob-errors");
  assert.equal(published[0].title, "Joint Bob UI error");
  assert.match(published[0].message, /^TypeError: Load failed .*\/api\/reviews\/pending/);
  assert.ok(published[0].message.includes(`Source: /#chat · ${environment.username}`), published[0].message);
  assert.match(published[0].message, /api@http:\/\/localhost\/app\/api\.js:17:20/, "the browser stack travels with the report");
});
