import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";
import type WebSocket from "ws";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { openChat, waitFor } from "./queued-prompt-harness.js";

// Drives the full difficulty-routing path against a real server: the Kiro harness
// runs on a synthetic ACP fixture, the TypeSafe classifier against a local fake
// endpoint, and the API key comes from a real project-scoped secret account.
const kiroFixture = `#!/usr/bin/env node
if (process.argv.includes("--version") || process.argv.includes("whoami")) process.exit(0);
if (process.argv.includes("--list-models")) {
  process.stdout.write(JSON.stringify({ models: [{ model_id: "default", model_name: "Fixture default" }, { model_id: "big", model_name: "Fixture big" }] }));
  process.exit(0);
}
const readline = require("node:readline");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const notify = update => send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"native-fixed",update}});
const rl = readline.createInterface({input:process.stdin});
rl.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return send({jsonrpc:"2.0",id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
  if (request.method === "session/new") return send({jsonrpc:"2.0",id:request.id,result:{sessionId:"native-fixed"}});
  if (request.method === "session/load") return send({jsonrpc:"2.0",id:request.id,result:null});
  if (request.method === "session/prompt") {
    notify({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"done"}});
    return send({jsonrpc:"2.0",id:request.id,result:{stopReason:"end_turn"}});
  }
});
rl.on("close", () => process.exit(0));
`;

let answer: { level: number; confidence: number } | { error: true } = { level: 7, confidence: 0.9 };

function scoreResponse(): Record<string, unknown> {
  if ("error" in answer) return {};
  const probabilities: Record<string, number> = {};
  for (let index = 0; index < 10; index += 1) probabilities[String(index)] = index + 1 === answer.level ? 1 : 0;
  return { answers: { complexity: { type: "score", score: answer.level - 1, confidence: answer.confidence, probabilities } }, usage: { input_tokens: 10, output_tokens: 1 } };
}

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
let session: SignedIn;
let classifierEndpoint: Server;
let sockets: WebSocket[] = [];
let projectId = "";
let secretAccountId = "";

function routingEvents(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return messages.filter((message) => message.type === "promptRouted");
}

/** Waits for the n-th dispatched user prompt to finish, successful or not. */
async function completed(messages: Array<Record<string, unknown>>, count: number): Promise<void> {
  await waitFor(messages, () => messages.filter((message) => message.type === "promptCompleted" || message.type === "promptFailed").length >= count);
  assert.ok(!messages.some((message) => message.type === "promptFailed"), `prompt failed: ${JSON.stringify(messages.filter((message) => message.type === "error" || message.type === "promptFailed"))}`);
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "routing-dispatch-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  const executable = path.join(environment.home, "bin", "kiro-fixture");
  const configPath = path.join(environment.home, ".kiro");
  const sessionPath = path.join(configPath, "sessions");
  await Promise.all([mkdir(path.dirname(executable), { recursive: true }), mkdir(sessionPath, { recursive: true })]);
  await writeFile(executable, kiroFixture);
  await chmod(executable, 0o700);
  classifierEndpoint = createServer((_request, response) => {
    if ("error" in answer) { response.writeHead(500); response.end("{}"); return; }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(scoreResponse()));
  });
  await new Promise<void>((resolve) => classifierEndpoint.listen(0, "127.0.0.1", resolve));
  const classifierPort = (classifierEndpoint.address() as { port: number }).port;
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  const now = new Date().toISOString();
  const save = db.prepare("INSERT INTO node_settings (key, value, is_secret, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
  save.run("kiro.executable", executable, now);
  save.run("kiro.configPath", configPath, now);
  save.run("kiro.sessionPath", sessionPath, now);
  db.close();
  server = await startDevNode(environment, node, { JOINT_BOB_TYPESAFE_ENDPOINT: `http://127.0.0.1:${classifierPort}/v1/systemone` });
  session = await signIn(environment, node);
  const project = projectNamed(node, "Joint Bob");
  projectId = project.id;
  const account = await api<{ account: { id: string } }>(node, session, "POST", "/secrets/accounts", { label: "routing-test", provider: "custom", variables: [{ name: "TYPESAFE_AI_API_KEY", kind: "value", value: "test-key" }] });
  assert.equal(account.status, 201, JSON.stringify(account.body));
  secretAccountId = account.body.account.id;
  const attached = await api(node, session, "PUT", `/secrets/scopes/project/${projectId}`, { accountIds: [secretAccountId] });
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  const saved = await api(node, session, "PUT", "/cluster/routing", {
    clusterId: "",
    policy: { enabled: true, classifierId: "typesafe", evalCadence: { mode: "every-n", n: 2 }, confidenceThreshold: 0.3, harnesses: { kiro: { levels: { "1": { modelId: "default", thinkingLevel: "low" }, "8": { modelId: "big", thinkingLevel: "high" } } } } },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
}, { timeout: 120_000 });

after(async () => {
  for (const socket of sockets) socket.close();
  if (server) await stopDevNode(server);
  await new Promise<void>((resolve) => classifierEndpoint.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});

test("difficulty routing maps a classified prompt to the policy model and honours cadence and manual picks", { timeout: 120_000 }, async () => {
  const chat = openChat(node.url, session.cookie, projectId, "kiro:new");
  sockets.push(chat.socket);
  await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "ready" && message.engine === "kiro"));

  answer = { level: 7, confidence: 0.9 };
  chat.socket.send(JSON.stringify({ type: "prompt", message: "first prompt", requestId: randomUUID() }));
  await completed(chat.messages, 1);
  let events = routingEvents(chat.messages);
  assert.equal(events.length, 1, "first prompt must be evaluated");
  assert.equal(events[0].level, 7);
  assert.equal(events[0].mapped, true);
  assert.equal(events[0].modelId, "big");
  assert.equal(events[0].thinkingLevel, "high");

  answer = { level: 7, confidence: 0.9 };
  chat.socket.send(JSON.stringify({ type: "prompt", message: "second prompt", requestId: randomUUID() }));
  await completed(chat.messages, 2);
  assert.equal(routingEvents(chat.messages).length, 1, "second prompt is not an evaluation point with n=2");

  answer = { level: 2, confidence: 0.9 };
  chat.socket.send(JSON.stringify({ type: "prompt", message: "third prompt", requestId: randomUUID() }));
  await completed(chat.messages, 3);
  events = routingEvents(chat.messages);
  assert.equal(events.length, 2, "third prompt is the next evaluation point");
  assert.equal(events[1].level, 2);
  assert.equal(events[1].mapped, true, "two mapped levels spread across the 1 to 10 scale");
  assert.equal(events[1].modelId, "default", "difficulty 2 of 10 lands on the easier pair");
  assert.equal(events[1].thinkingLevel, "low");

  answer = { level: 7, confidence: 0.9 };
  chat.socket.send(JSON.stringify({ type: "prompt", message: "manual pick off cadence", requestId: randomUUID(), queueSettings: { harnessId: "kiro", provider: "kiro", modelId: "default", reasoning: "low" } }));
  await completed(chat.messages, 4);
  assert.equal(routingEvents(chat.messages).length, 2, "a manual per-prompt pick must not be routed");

  answer = { level: 7, confidence: 0.9 };
  chat.socket.send(JSON.stringify({ type: "prompt", message: "manual pick on cadence", requestId: randomUUID(), queueSettings: { harnessId: "kiro", provider: "kiro", modelId: "default", reasoning: "low" } }));
  await completed(chat.messages, 5);
  assert.equal(routingEvents(chat.messages).length, 2, "manual wins at an evaluation point and consumes it");
  chat.socket.send(JSON.stringify({ type: "prompt", message: "after manual", requestId: randomUUID() }));
  await completed(chat.messages, 6);
  assert.equal(routingEvents(chat.messages).length, 2, "the next prompt after a consumed point is not due");

  answer = { level: 7, confidence: 0.05 };
  chat.socket.send(JSON.stringify({ type: "prompt", message: "unsure prompt", requestId: randomUUID() }));
  await completed(chat.messages, 7);
  events = routingEvents(chat.messages);
  assert.equal(events.length, 3, "ordinal 7 is due again");
  assert.equal(events[2].skipped, "low confidence", `expected a low-confidence skip, got ${JSON.stringify(events[2])}`);

  const unmapped = await api(node, session, "PUT", "/cluster/routing", {
    clusterId: "",
    policy: { enabled: true, classifierId: "typesafe", evalCadence: { mode: "every-n", n: 1 }, confidenceThreshold: 0.3, harnesses: {} },
  });
  assert.equal(unmapped.status, 200, JSON.stringify(unmapped.body));
  const fresh = openChat(node.url, session.cookie, projectId, "kiro:new");
  sockets.push(fresh.socket);
  await waitFor(fresh.messages, () => fresh.messages.some((message) => message.type === "ready"));
  answer = { level: 5, confidence: 0.9 };
  fresh.socket.send(JSON.stringify({ type: "prompt", message: "nothing mapped", requestId: randomUUID() }));
  await completed(fresh.messages, 1);
  const unmappedEvents = routingEvents(fresh.messages);
  assert.equal(unmappedEvents.length, 1);
  assert.equal(unmappedEvents[0].mapped, false, "a harness with no mapped levels keeps the conversation model");
  const restored = await api(node, session, "PUT", "/cluster/routing", {
    clusterId: "",
    policy: { enabled: true, classifierId: "typesafe", evalCadence: { mode: "every-n", n: 2 }, confidenceThreshold: 0.3, harnesses: { kiro: { levels: { "1": { modelId: "default", thinkingLevel: "low" }, "8": { modelId: "big", thinkingLevel: "high" } } } } },
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
});

test("a missing key or a failing classifier falls back to conversation settings", { timeout: 120_000 }, async () => {
  const chat = openChat(node.url, session.cookie, projectId, "kiro:new");
  sockets.push(chat.socket);
  await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "ready" && message.engine === "kiro"));

  answer = { error: true };
  chat.socket.send(JSON.stringify({ type: "prompt", message: "classifier down", requestId: randomUUID() }));
  await completed(chat.messages, 1);
  let events = routingEvents(chat.messages);
  assert.equal(events.length, 1);
  assert.equal(events[0].skipped, "classifier failed");

  const removed = await api(node, session, "DELETE", `/secrets/accounts/${secretAccountId}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  answer = { level: 7, confidence: 0.9 };
  chat.socket.send(JSON.stringify({ type: "prompt", message: "not due yet", requestId: randomUUID() }));
  await completed(chat.messages, 2);
  assert.equal(routingEvents(chat.messages).length, 1, "ordinal 2 is not an evaluation point");
  chat.socket.send(JSON.stringify({ type: "prompt", message: "no key", requestId: randomUUID() }));
  await completed(chat.messages, 3);
  events = routingEvents(chat.messages);
  assert.equal(events.length, 2);
  assert.equal(events[1].skipped, "classifier key missing");
});

test("bob-auto is the default and an explicit pick pauses classifier control until bob-auto returns", { timeout: 120_000 }, async () => {
  const chat = openChat(node.url, session.cookie, projectId, "kiro:new");
  sockets.push(chat.socket);
  await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "ready" && message.engine === "kiro"));
  const ready = chat.messages.find((message) => message.type === "ready") as { routing?: { active: boolean; mode: string } };
  assert.equal(ready.routing?.active, true, "the ready payload must report active routing");
  assert.equal(ready.routing?.mode, "auto", "new conversations start under Bob auto");

  answer = { level: 7, confidence: 0.9 };
  chat.socket.send(JSON.stringify({ type: "prompt", message: "auto prompt", requestId: randomUUID() }));
  await completed(chat.messages, 1);
  assert.equal(routingEvents(chat.messages).length, 1, "auto mode routes the first prompt");

  chat.socket.send(JSON.stringify({ type: "setModel", provider: "kiro", modelId: "default" }));
  await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "routingMode"));
  const manual = chat.messages.find((message) => message.type === "routingMode") as { mode: string; active: boolean };
  assert.equal(manual.mode, "manual", "an explicit model pick switches the conversation to manual");

  answer = { level: 7, confidence: 0.9 };
  chat.socket.send(JSON.stringify({ type: "prompt", message: "manual prompt", requestId: randomUUID() }));
  await completed(chat.messages, 2);
  assert.equal(routingEvents(chat.messages).length, 1, "manual mode must not route, even at a due ordinal");
  chat.socket.send(JSON.stringify({ type: "prompt", message: "still manual", requestId: randomUUID() }));
  await completed(chat.messages, 3);
  assert.equal(routingEvents(chat.messages).length, 1, "manual mode keeps holding");

  chat.socket.send(JSON.stringify({ type: "setModel", modelId: "bob-auto" }));
  await waitFor(chat.messages, () => chat.messages.filter((message) => message.type === "routingMode").length >= 2);
  const back = chat.messages.filter((message) => message.type === "routingMode").at(-1) as { mode: string };
  assert.equal(back.mode, "auto", "bob-auto returns the conversation to classifier control");

  answer = { level: 7, confidence: 0.9 };
  chat.socket.send(JSON.stringify({ type: "prompt", message: "auto again", requestId: randomUUID() }));
  await completed(chat.messages, 4);
  assert.equal(routingEvents(chat.messages).length, 2, "auto mode resumes routing");
});
