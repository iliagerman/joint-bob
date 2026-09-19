import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type WebSocket from "ws";
import { projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { openChat, waitFor } from "./queued-prompt-harness.js";

// A real Kiro ACP fixture that lets a test hold `whoami` (which the harness runs
// during preflight, before the ACP process is spawned and `this.running` is
// set). Holding preflight recreates the window where the session is not yet
// running a turn, so a force start's cancel() throws "Kiro session is not
// running". The fix must tolerate that instead of surfacing an error and
// leaving the forced prompt stuck.
const fixtureSource = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const gate = process.env.KIRO_PREFLIGHT_GATE;
const entered = process.env.KIRO_PREFLIGHT_ENTERED;
const wait = async (file) => { while (!fs.existsSync(file)) await new Promise((r) => setTimeout(r, 10)); };
if (process.argv.includes("--version")) process.exit(0);
if (process.argv.includes("whoami")) {
  (async () => {
    if (gate && fs.existsSync(gate)) {
      if (entered) fs.writeFileSync(entered, "1");
      await wait(gate + ".release");
    }
    process.exit(0);
  })();
  return;
}
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const notify = update => send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"native-fixed",update}});
const rl = readline.createInterface({input:process.stdin});
rl.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return send({jsonrpc:"2.0",id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
  if (request.method === "session/new") return send({jsonrpc:"2.0",id:request.id,result:{sessionId:"native-fixed"}});
  if (request.method === "session/load") return send({jsonrpc:"2.0",id:request.id,result:null});
  if (request.method === "session/prompt") {
    const text = request.params.prompt[0].text;
    notify({sessionUpdate:"agent_message_chunk",content:{type:"text",text}});
    return setTimeout(() => send({jsonrpc:"2.0",id:request.id,result:{stopReason:"end_turn"}}), 50);
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

test("force starting a Kiro prompt while a turn is in preflight starts it without an error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kiro-force-start-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  const sockets: WebSocket[] = [];
  const gate = path.join(root, "preflight.gate");
  const entered = path.join(root, "preflight.entered");
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
    server = await startDevNode(environment, node, { KIRO_PREFLIGHT_GATE: gate, KIRO_PREFLIGHT_ENTERED: entered });
    const auth = await signIn(environment, node);
    const project = projectNamed(node, "Joint Bob");

    const chat = openChat(node.url, auth.cookie, project.id, "kiro:new");
    sockets.push(chat.socket);
    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "ready" && message.engine === "kiro"));

    // First turn runs and completes normally so the native session exists.
    chat.socket.send(JSON.stringify({ type: "prompt", message: "warmup" }));
    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "textDelta" && message.text === "warmup"));
    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "agent_end"));

    // Arm the preflight gate, then enqueue the turn that will hold in preflight.
    await writeFile(gate, "1");
    chat.socket.send(JSON.stringify({ type: "prompt", message: "held" }));
    // Wait until the held turn is actually inside preflight (whoami), where the
    // Kiro session reports not running.
    await waitFor(chat.messages, () => existsSync(entered));

    // Queue the prompt to force start while "held" is stuck in preflight.
    chat.socket.send(JSON.stringify({ type: "prompt", message: "forced" }));
    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "userMessage" && message.text === "forced" && message.queued));
    const forced = [...chat.messages].reverse().find((message) => message.type === "userMessage" && message.text === "forced")!;
    chat.socket.send(JSON.stringify({ type: "forceStartQueuedPrompt", queueId: forced.queueId, queueRevision: forced.revision }));

    // Release preflight so the held turn can proceed; the forced prompt must
    // still run and no error must surface from the not-running cancel.
    await writeFile(gate + ".release", "1");

    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "textDelta" && message.text === "forced"), 10_000);
    assert.deepEqual(chat.messages.filter((message) => message.type === "error"), []);
  } finally {
    for (const socket of sockets) socket.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
