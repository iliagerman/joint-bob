import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type WebSocket from "ws";
import { projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { openChat, waitFor } from "./queued-prompt-harness.js";

const fixtureSource = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
if (process.argv.includes("--version") || process.argv.includes("whoami")) process.exit(0);
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const notify = update => send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"native-fixed",update}});
const rl = readline.createInterface({input:process.stdin});
let blocker = null;
rl.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return send({jsonrpc:"2.0",id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
  if (request.method === "session/new") return send({jsonrpc:"2.0",id:request.id,result:{sessionId:"native-fixed"}});
  if (request.method === "session/load") return send({jsonrpc:"2.0",id:request.id,result:null});
  if (request.method === "session/prompt") {
    const text = request.params.prompt[0].text;
    notify({sessionUpdate:"agent_message_chunk",content:{type:"text",text}});
    const complete = () => send({jsonrpc:"2.0",id:request.id,result:{stopReason:"end_turn"}});
    if (text !== "blocker") return setTimeout(complete, 100);
    const releasePath = path.join(process.cwd(), ".kiro-blocker-release");
    if (fs.existsSync(releasePath)) return complete();
    const watcher = fs.watch(process.cwd(), () => {
      if (!fs.existsSync(releasePath)) return;
      watcher.close();
      blocker = null;
      complete();
    });
    blocker = {id: request.id, watcher};
    return;
  }
  if (request.method === "session/cancel" && blocker) {
    blocker.watcher.close();
    send({jsonrpc:"2.0",id:blocker.id,result:{stopReason:"cancelled"}});
    blocker = null;
  }
});
rl.on("close", () => process.exit(0));
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

test("websocket chat routes Kiro prompts through the generic harness runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-chat-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let releasePath: string | undefined;
  const sockets: WebSocket[] = [];
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const executable = path.join(environment.home, "bin", "kiro-fixture");
    const configPath = path.join(environment.home, ".kiro");
    const sessionPath = path.join(configPath, "sessions");
    await Promise.all([mkdir(path.dirname(executable), { recursive: true }), mkdir(sessionPath, { recursive: true })]);
    await writeFile(executable, fixtureSource);
    await chmod(executable, 0o700);
    configureKiro(node.dataDir, executable, configPath, sessionPath);
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    const project = projectNamed(node, "Joint Bob");
    releasePath = path.join(project.path, ".kiro-blocker-release");
    const first = openChat(node.url, auth.cookie, project.id, "kiro:new");
    sockets.push(first.socket);
    await waitFor(first.messages, () => first.messages.some((message) => message.type === "ready" && message.engine === "kiro"));
    const requestId = randomUUID();
    first.socket.send(JSON.stringify({ type: "prompt", message: "hello", requestId }));
    await waitFor(first.messages, () => first.messages.some((message) => message.type === "userMessage" && message.requestId === requestId));
    const acknowledgement = first.messages.find((message) => message.type === "userMessage" && message.requestId === requestId)!;
    assert.equal(typeof acknowledgement.queueId, "string");
    assert.equal(acknowledgement.revision, 1);
    assert.equal(acknowledgement.editableText, "hello");
    assert.equal(acknowledgement.settings, null);
    assert.deepEqual(acknowledgement.attachments, []);
    assert.ok(first.messages.some((message) => message.type === "queueUpdate" && typeof message.pending === "number"));
    await waitFor(first.messages, () => first.messages.some((message) => message.type === "promptCompleted" && message.queueId === acknowledgement.queueId));
    await waitFor(first.messages, () => first.messages.some((message) => message.type === "queuedPrompts" && Array.isArray(message.prompts) && message.prompts.length === 0));

    const deltaCount = first.messages.filter((message) => message.type === "textDelta").length;
    first.socket.send(JSON.stringify({ type: "prompt", message: "   " }));
    await waitFor(first.messages, () => first.messages.some((message) => message.type === "error" && /empty/i.test(String(message.error))));
    assert.equal(first.messages.filter((message) => message.type === "textDelta").length, deltaCount);

    first.socket.send(JSON.stringify({ type: "prompt", message: "blocker" }));
    await waitFor(first.messages, () => first.messages.some((message) => message.type === "textDelta" && message.text === "blocker"));
    first.socket.send(JSON.stringify({ type: "prompt", message: "editable" }));
    first.socket.send(JSON.stringify({ type: "prompt", message: "cancelled" }));
    await waitFor(first.messages, () => first.messages.some((message) => message.type === "queuedPrompts" && (message.prompts as Array<{ editableText: string }>).some((prompt) => prompt.editableText === "editable") && (message.prompts as Array<{ editableText: string }>).some((prompt) => prompt.editableText === "cancelled")));
    const queue = [...first.messages].reverse().find((message) => message.type === "queuedPrompts" && (message.prompts as Array<{ editableText: string }>).some((prompt) => prompt.editableText === "editable"))!;
    const prompts = queue.prompts as Array<{ id: string; revision: number; editableText: string }>;
    const editable = prompts.find((prompt) => prompt.editableText === "editable")!;
    const cancelled = prompts.find((prompt) => prompt.editableText === "cancelled")!;
    first.socket.send(JSON.stringify({ type: "editQueuedPrompt", queueId: editable.id, queueRevision: editable.revision, message: "" }));
    await waitFor(first.messages, () => first.messages.some((message) => message.type === "error" && /empty/i.test(String(message.error))));
    first.socket.send(JSON.stringify({ type: "editQueuedPrompt", queueId: editable.id, queueRevision: editable.revision, message: "revised" }));
    await waitFor(first.messages, () => first.messages.some((message) => message.type === "queuedPromptEdited" && message.queueId === editable.id));
    const edited = first.messages.find((message) => message.type === "queuedPromptEdited" && message.queueId === editable.id)!;
    assert.deepEqual(edited, { type: "queuedPromptEdited", queueId: editable.id, text: "revised", editableText: "revised", settings: null, revision: editable.revision + 1 });
    const editedAcknowledgements = first.messages.filter((message) => message.type === "queuedPromptEdited").length;
    first.socket.send(JSON.stringify({ type: "editQueuedPrompt", queueId: editable.id, queueRevision: editable.revision, message: "stale" }));
    await waitFor(first.messages, () => first.messages.some((message) => message.type === "error" && /changed/i.test(String(message.error))));
    assert.equal(first.messages.filter((message) => message.type === "queuedPromptEdited").length, editedAcknowledgements);
    first.socket.send(JSON.stringify({ type: "cancelQueuedPrompt", queueId: cancelled.id, queueRevision: cancelled.revision }));
    await waitFor(first.messages, () => first.messages.some((message) => message.type === "queuedPromptCancelled" && message.queueId === cancelled.id));
    first.socket.send(JSON.stringify({ type: "forceStartQueuedPrompt", queueId: editable.id, queueRevision: editable.revision + 1 }));
    await waitFor(first.messages, () => first.messages.some((message) => message.type === "textDelta" && message.text === "revised"));
    await writeFile(releasePath, "release");
    await waitFor(first.messages, () => first.messages.filter((message) => message.type === "agent_end").length === 3);
    assert.ok(first.messages.some((message) => message.type === "textDelta" && message.text === "hello"));
    assert.ok(first.messages.some((message) => message.type === "textDelta" && message.text === "revised"));
    assert.ok(!first.messages.some((message) => message.type === "textDelta" && message.text === "cancelled"));
    const ready = first.messages.find((message) => message.type === "ready")!;
    await waitFor(first.messages, () => first.messages.some((message) => message.type === "sessionFile"));
    const file = first.messages.find((message) => message.type === "sessionFile")!;
    assert.match(String(file.sessionFile), /^kiro:/);
    first.socket.close();
    const resumed = openChat(node.url, auth.cookie, project.id, String(file.sessionFile));
    sockets.push(resumed.socket);
    await waitFor(resumed.messages, () => resumed.messages.some((message) => message.type === "ready"));
    const resumedReady = resumed.messages.find((message) => message.type === "ready")!;
    assert.equal(resumedReady.sessionId, ready.sessionId);
    const transcript = resumedReady.messages as Array<{ role: string; text: string }>;
    assert.ok(transcript.some((message) => message.role === "user" && message.text === "hello"));
    assert.ok(transcript.some((message) => message.role === "assistant" && message.text === "hello"));
    assert.ok(transcript.some((message) => message.role === "user" && message.text === "revised"));
    assert.ok(transcript.some((message) => message.role === "assistant" && message.text === "revised"));
    const unknown = openChat(node.url, auth.cookie, project.id, "future:new");
    sockets.push(unknown.socket);
    const close = await new Promise<{ code: number }>((resolve) => unknown.socket.once("close", (code) => resolve({ code })));
    assert.equal(close.code, 1008);
  } finally {
    if (releasePath) await writeFile(releasePath, "release");
    for (const socket of sockets) socket.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
