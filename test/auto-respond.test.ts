import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type WebSocket from "ws";
import { assistantMessageKey, parseAutoRespondDecision, responderPrompt, type AutoRespondConfig } from "../src/conversation-auto-respond.js";
import { addProject } from "../src/store.js";
import { runAutoResponder } from "../src/server/auto-respond-run.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "./dev-nodes.js";
import { openChat, waitFor } from "./queued-prompt-harness.js";

const config: AutoRespondConfig = { harnessId: "kiro", provider: "kiro", modelId: "default", thinkingLevel: "medium", instructions: "Keep going.", stopInstructions: "- Stop when finished.", maxResponses: 2, useTools: true };

test("the responder's decision parses, and anything unclear fails closed", () => {
  assert.deepEqual(parseAutoRespondDecision("DECISION: RESPOND\nREASON: needs a nudge\n---\nUse option B.\nThanks."), { decision: "respond", reason: "needs a nudge", reply: "Use option B.\nThanks." });
  assert.deepEqual(parseAutoRespondDecision("DECISION: STOP\nREASON: the task is finished"), { decision: "stop", reason: "the task is finished" });
  assert.deepEqual(parseAutoRespondDecision("decision: stop\nreason: asks for a password\n---\nignored"), { decision: "stop", reason: "asks for a password" });
  assert.equal(parseAutoRespondDecision("DECISION: RESPOND\nREASON: x\n---\n"), null, "an empty reply is not a decision");
  assert.equal(parseAutoRespondDecision("Sure, I would say go ahead."), null);
  assert.deepEqual(parseAutoRespondDecision("I ran the tests; two fail.\nDECISION: RESPOND\nREASON: tests fail\n---\nFix the failing tests."), { decision: "respond", reason: "tests fail", reply: "Fix the failing tests." }, "a responder that checked first ends with its decision");
  assert.deepEqual(parseAutoRespondDecision("Earlier I thought DECISION: STOP\nREASON: x\nThen:\nDECISION: RESPOND\nREASON: y\n---\ngo"), { decision: "respond", reason: "y", reply: "go" }, "the last decision block wins");
  assert.equal(parseAutoRespondDecision("I looked around and have no opinion."), null);
});

test("the prompt carries the rules, the opening request and the agent's last message, and bounds the transcript", () => {
  const turns = [{ role: "user" as const, text: "Build the thing" }, ...Array.from({ length: 40 }, (_, index) => [
    { role: "assistant" as const, text: `step ${index} ${"x".repeat(3_000)}` },
    { role: "user" as const, text: `go on ${index}` },
  ]).flat(), { role: "assistant" as const, text: "All done, anything else?" }];
  const prompt = responderPrompt(config, turns, 3);
  assert.match(prompt, /Stop when finished/);
  assert.match(prompt, /Keep going/);
  assert.match(prompt, /response 3 of 2/);
  assert.match(prompt, /Build the thing/);
  assert.match(prompt, /<last-message>\nAll done, anything else\?\n<\/last-message>/);
  assert.ok(prompt.length < 70_000);
  assert.ok(!prompt.includes("step 0 "), "the oldest turns are dropped first");
  assert.match(prompt, /may use your tools/, "with tools on, the responder is told it may check the work");
  assert.match(prompt, /Do not change anything/);
  assert.doesNotMatch(responderPrompt({ ...config, useTools: false }, turns, 1), /may use your tools/);
});

test("an assistant message is keyed by what it says and how many user messages preceded it", () => {
  assert.equal(assistantMessageKey(1, "Done."), assistantMessageKey(1, " Done.\n"));
  assert.notEqual(assistantMessageKey(1, "Done."), assistantMessageKey(2, "Done."));
});

const fixtureSource = `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv.includes("--version") || process.argv.includes("whoami")) process.exit(0);
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const rl = readline.createInterface({input:process.stdin});
rl.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return send({jsonrpc:"2.0",id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
  if (request.method === "session/new") return send({jsonrpc:"2.0",id:request.id,result:{sessionId:"native-fixed"}});
  if (request.method === "session/load") return send({jsonrpc:"2.0",id:request.id,result:null});
  if (request.method === "session/prompt") {
    const text = request.params.prompt[0].text;
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"native-fixed",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"agent heard: " + text}}}});
    setTimeout(() => send({jsonrpc:"2.0",id:request.id,result:{stopReason:"end_turn"}}), 80);
  }
});
rl.on("close", () => process.exit(0));
`;

// Replies "continue N" until the agent's last message says STOPNOW, then stops.
const responderSource = `let calls = 0;
export default async function responder(input) {
  calls += 1;
  if (input.prompt.includes("<last-message>\\nagent heard: STOPNOW")) return "DECISION: STOP\\nREASON: the agent said it is finished";
  return "DECISION: RESPOND\\nREASON: keep it moving\\n---\\ncontinue " + calls;
}
`;

function configureKiro(dataDir: string, executable: string, configPath: string, sessionPath: string): void {
  const db = new DatabaseSync(path.join(dataDir, "node.db"));
  const save = db.prepare("INSERT INTO node_settings (key, value, is_secret, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
  const now = new Date().toISOString();
  save.run("kiro.executable", executable, now);
  save.run("kiro.configPath", configPath, now);
  save.run("kiro.sessionPath", sessionPath, now);
  db.close();
}

type Frame = Record<string, unknown>;
const autoStates = (messages: Frame[]) => messages.filter((message) => message.type === "autoRespond").map((message) => message.state as { status: string; stopKind: string | null; responses: number } | null);

test("auto respond answers for the user until a limit or a stop instruction ends it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-respond-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  const sockets: WebSocket[] = [];
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const executable = path.join(environment.home, "bin", "kiro-fixture");
    const configPath = path.join(environment.home, ".kiro");
    const sessionPath = path.join(configPath, "sessions");
    const responder = path.join(root, "responder.mjs");
    await Promise.all([mkdir(path.dirname(executable), { recursive: true }), mkdir(sessionPath, { recursive: true })]);
    await writeFile(executable, fixtureSource);
    await chmod(executable, 0o700);
    await writeFile(responder, responderSource);
    configureKiro(node.dataDir, executable, configPath, sessionPath);
    server = await startDevNode(environment, node, { JOINT_BOB_AUTO_RESPONDER: responder });
    const auth = await signIn(environment, node);
    const project = projectNamed(node, "Joint Bob");
    const chat = openChat(node.url, auth.cookie, project.id, "kiro:new");
    sockets.push(chat.socket);
    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "ready"));
    assert.equal(chat.messages.find((message) => message.type === "ready")!.autoRespond, null);

    const conversationId = String(chat.messages.find((message) => message.type === "ready")!.conversationId);
    // The conversation list carries the responder's state, so the sidebar can show its badge.
    const listedState = async () => {
      const response = await fetch(`${node.url}/api/projects/${project.id}/sessions`, { headers: { Cookie: auth.cookie } });
      const listing = (await response.json()) as { sessions: Array<{ conversationId?: string; id: string; autoRespond?: { status: string; responses: number; maxResponses: number | null; stopReason: string | null } }> };
      return listing.sessions.find((session) => session.conversationId === conversationId || session.id === conversationId)?.autoRespond ?? null;
    };
    assert.equal(await listedState(), null, "a conversation with auto respond off carries no badge");
    chat.socket.send(JSON.stringify({ type: "prompt", message: "start the work" }));
    await waitFor(chat.messages, () => chat.messages.filter((message) => message.type === "agent_end").length === 1);

    // Turning it on while the agent is waiting answers at once, twice, then the limit ends it.
    chat.socket.send(JSON.stringify({ type: "autoRespond", autoRespond: { enabled: true, config } }));
    await waitFor(chat.messages, () => autoStates(chat.messages).some((state) => state?.stopKind === "limit"));
    const replies = chat.messages.filter((message) => message.type === "userMessage" && (message.auto as unknown));
    assert.deepEqual(replies.map((message) => message.text), ["continue 1", "continue 2"]);
    assert.equal(chat.messages.filter((message) => message.type === "agent_end").length, 3);
    assert.equal(chat.messages.some((message) => message.type === "textDelta" && message.text === "agent heard: continue 2"), true);
    assert.deepEqual(await listedState(), { status: "stopped", responses: 2, maxResponses: 2, stopReason: "Reached the limit of 2 responses" });

    // The badge outlives the live socket: a reopened conversation still marks what the responder wrote.
    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "sessionFile"));
    const file = chat.messages.find((message) => message.type === "sessionFile")!;
    const reopened = openChat(node.url, auth.cookie, project.id, String(file.sessionFile));
    sockets.push(reopened.socket);
    await waitFor(reopened.messages, () => reopened.messages.some((message) => message.type === "ready"));
    const history = reopened.messages.find((message) => message.type === "ready")!.messages as Array<{ role: string; text: string; auto?: { modelId: string } }>;
    assert.deepEqual(history.filter((message) => message.auto).map((message) => message.text), ["continue 1", "continue 2"]);
    assert.equal(history.find((message) => message.text === "start the work")?.auto, undefined, "a person's message carries no badge");
    reopened.socket.close();

    // A person's message runs as usual, and Resume starts a fresh count that ends on the stop instruction.
    chat.socket.send(JSON.stringify({ type: "autoRespond", autoRespond: { enabled: true, config: { ...config, maxResponses: null } } }));
    await waitFor(chat.messages, () => chat.messages.filter((message) => message.type === "userMessage" && message.auto).length === 3);
    chat.socket.send(JSON.stringify({ type: "prompt", message: "STOPNOW" }));
    await waitFor(chat.messages, () => autoStates(chat.messages).some((state) => state?.stopKind === "stop-instruction"));
    const answered = chat.messages.filter((message) => message.type === "userMessage" && message.auto).length;

    // Off means off: nothing more is written for the user, and the badge goes.
    chat.socket.send(JSON.stringify({ type: "autoRespond", autoRespond: { enabled: false } }));
    await waitFor(chat.messages, () => autoStates(chat.messages).at(-1)?.status === "off");
    assert.equal(await listedState(), null);
    chat.socket.send(JSON.stringify({ type: "prompt", message: "one more" }));
    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "textDelta" && message.text === "agent heard: one more"));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(chat.messages.filter((message) => message.type === "userMessage" && message.auto).length, answered);
  } finally {
    for (const socket of sockets) socket.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

async function prepareKiroNode(root: string, responder: string): Promise<{ environment: DevEnvironment; node: SeededNode }> {
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const executable = path.join(environment.home, "bin", "kiro-fixture");
  const configPath = path.join(environment.home, ".kiro");
  const sessionPath = path.join(configPath, "sessions");
  await Promise.all([mkdir(path.dirname(executable), { recursive: true }), mkdir(sessionPath, { recursive: true })]);
  await writeFile(executable, fixtureSource);
  await chmod(executable, 0o700);
  await writeFile(responder, responderSource);
  configureKiro(node.dataDir, executable, configPath, sessionPath);
  return { environment, node };
}

test("an active auto respond resumes on its own after the node restarts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-respond-restart-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  const sockets: WebSocket[] = [];
  try {
    const responder = path.join(root, "responder.mjs");
    const { environment, node } = await prepareKiroNode(root, responder);
    server = await startDevNode(environment, node, { JOINT_BOB_AUTO_RESPONDER: responder });
    const auth = await signIn(environment, node);
    const project = projectNamed(node, "Joint Bob");
    const chat = openChat(node.url, auth.cookie, project.id, "kiro:new");
    sockets.push(chat.socket);
    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "ready"));
    chat.socket.send(JSON.stringify({ type: "prompt", message: "start the work" }));
    await waitFor(chat.messages, () => chat.messages.filter((message) => message.type === "agent_end").length === 1);
    chat.socket.send(JSON.stringify({ type: "autoRespond", autoRespond: { enabled: true, config: { ...config, maxResponses: 5 } } }));
    // Stop once the agent has answered the second reply and the responder is between turns.
    await waitFor(chat.messages, () => autoStates(chat.messages).some((state) => state?.responses === 2) && chat.messages.filter((message) => message.type === "agent_end").length >= 3);
    const before = autoStates(chat.messages).at(-1)!.responses;
    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "sessionFile"));
    const file = chat.messages.find((message) => message.type === "sessionFile")!;
    chat.socket.close();
    await stopDevNode(server);

    server = await startDevNode(environment, node, { JOINT_BOB_AUTO_RESPONDER: responder });
    const restarted = await signIn(environment, node);
    const reopened = openChat(node.url, restarted.cookie, project.id, String(file.sessionFile));
    sockets.push(reopened.socket);
    await waitFor(reopened.messages, () => reopened.messages.some((message) => message.type === "ready"));
    const ready = reopened.messages.find((message) => message.type === "ready")!;
    const restored = ready.autoRespond as { status: string; responses: number } | null;
    assert.equal(restored?.status, "active", "the responder is still on after the restart");
    assert.ok(restored.responses >= before, "the count survives the restart");
    await waitFor(reopened.messages, () => autoStates(reopened.messages).some((state) => state?.stopKind === "limit"));
    assert.equal(autoStates(reopened.messages).at(-1)?.responses, 5, "the responder keeps answering after the restart until its limit");
  } finally {
    for (const socket of sockets) socket.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("a responder cancelled before its turn starts never prompts its harness", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-respond-cancel-"));
  const previousSettings = getSettings();
  try {
    const configPath = path.join(root, "kiro");
    const sessionPath = path.join(configPath, "sessions");
    const executable = path.join(root, "kiro-fixture");
    const wire = path.join(root, "wire.jsonl");
    await mkdir(sessionPath, { recursive: true });
    await writeFile(executable, fixtureSource.replace("const request = JSON.parse(line);", `const request = JSON.parse(line); require("node:fs").appendFileSync(${JSON.stringify(wire)}, request.method + "\\n");`));
    await chmod(executable, 0o700);
    updateSettings({ runtimes: { ...previousSettings.runtimes, kiro: { ...previousSettings.runtimes.kiro, executable, configPath, sessionPath } }, syncthing: { endpoint: "" } });
    const project = await addProject("Auto respond cancel", root);
    // Stop pressed while the responder is still opening: a harness with no turn running
    // cannot be cancelled, so the run itself must not start the turn.
    const controller = new AbortController();
    controller.abort("user-stop");
    await assert.rejects(runAutoResponder({ projectId: project.id, conversationId: "cancelled-early", cwd: root, config, prompt: "Decide.", signal: controller.signal }), /cancelled/);
    const methods = (await readFile(wire, "utf8").catch(() => "")).trim().split("\n");
    assert.equal(methods.includes("session/prompt"), false, `the responder never prompted (${methods.join(", ")})`);
  } finally {
    updateSettings({ runtimes: previousSettings.runtimes, syncthing: { endpoint: "" } });
    await rm(root, { recursive: true, force: true });
  }
});

// Names what it is checking, then thinks until it is cancelled.
const slowResponderSource = `export default async function responder(input) {
  input.onStep("Bash · npm test");
  await new Promise((resolve) => input.signal.addEventListener("abort", resolve, { once: true }));
  throw new Error("Auto respond was cancelled");
}
`;

test("every client sees the responder deciding and what it checks, a reconnect included, and Stop ends it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-respond-deciding-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  const sockets: WebSocket[] = [];
  try {
    const responder = path.join(root, "responder.mjs");
    const { environment, node } = await prepareKiroNode(root, responder);
    await writeFile(responder, slowResponderSource);
    server = await startDevNode(environment, node, { JOINT_BOB_AUTO_RESPONDER: responder });
    const auth = await signIn(environment, node);
    const project = projectNamed(node, "Joint Bob");
    const chat = openChat(node.url, auth.cookie, project.id, "kiro:new");
    sockets.push(chat.socket);
    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "ready"));
    chat.socket.send(JSON.stringify({ type: "prompt", message: "start the work" }));
    await waitFor(chat.messages, () => chat.messages.filter((message) => message.type === "agent_end").length === 1);
    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "sessionFile"));
    chat.socket.send(JSON.stringify({ type: "autoRespond", autoRespond: { enabled: true, config: { ...config, maxResponses: null } } }));
    type Decision = { startedAt: string; step: string | null } | null;
    const decisions = (messages: Frame[]) => messages.filter((message) => message.type === "autoRespond").map((message) => message.decision as Decision);
    await waitFor(chat.messages, () => decisions(chat.messages).some((decision) => decision?.step === "Bash · npm test"));

    // A phone that reconnects mid-decision is told at once, not left with a silent running conversation.
    const file = chat.messages.find((message) => message.type === "sessionFile")!;
    const reopened = openChat(node.url, auth.cookie, project.id, String(file.sessionFile));
    sockets.push(reopened.socket);
    await waitFor(reopened.messages, () => reopened.messages.some((message) => message.type === "ready"));
    const decision = reopened.messages.find((message) => message.type === "ready")!.autoRespondDecision as Decision;
    assert.equal(decision?.step, "Bash · npm test");
    assert.ok(Number.isFinite(Date.parse(decision.startedAt)), "the decision says when it started");

    // Stop from the reconnected client cancels the decision and says so everywhere.
    reopened.socket.send(JSON.stringify({ type: "abort" }));
    for (const client of [chat, reopened]) {
      await waitFor(client.messages, () => autoStates(client.messages).at(-1)?.stopKind === "user-stopped" && decisions(client.messages).at(-1) === null);
    }
  } finally {
    for (const socket of sockets) socket.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
