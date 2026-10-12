// Spend budgets end to end on a real node: a used-up budget refuses a chat turn and keeps the
// prompt queued, raising it lets the turn run, a running turn is stopped when its budget runs
// out, and a scheduled run is refused without disabling its task.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type WebSocket from "ws";
import type { CronTask } from "../src/cron.js";
import { ensureUsageSchema } from "../src/usage-ledger.js";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
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
    if (text === "silent") return send({jsonrpc:"2.0",id:request.id,result:{stopReason:"end_turn"}});
    const response = text.startsWith("Joint Bob goal:") ? "Progress update"
      : text.startsWith("Continue the active Joint Bob goal") ? "Finished and tested.\\nBOB_GOAL_COMPLETE"
      : text;
    notify({sessionUpdate:"agent_message_chunk",content:{type:"text",text:response}});
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


async function kiroNode(root: string, spentUsd: number) {
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const executable = path.join(environment.home, "bin", "kiro-fixture");
  const configPath = path.join(environment.home, ".kiro");
  const sessionPath = path.join(configPath, "sessions");
  await Promise.all([mkdir(path.dirname(executable), { recursive: true }), mkdir(sessionPath, { recursive: true })]);
  await writeFile(executable, fixtureSource);
  await chmod(executable, 0o700);
  configureKiro(node.dataDir, executable, configPath, sessionPath);
  const project = projectNamed(node, "Joint Bob");
  const db = new DatabaseSync(path.join(node.dataDir, "node.db")); ensureUsageSchema(db);
  const occurredAt = new Date().toISOString();
  const payload = { id: "earlier", projectId: project.id, conversationId: "earlier-chat", sessionId: "earlier", engine: "pi", provider: "test", modelId: "fixture", occurredAt, requestId: null, input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, reasoning: 0, apiCostUsd: spentUsd, pricing: null, usageStatus: "reported", difficultyLevel: null, difficultyConfidence: null, difficultyStatus: "unknown", turnId: null, toolCalls: 0, toolErrors: 0 };
  db.prepare("INSERT INTO model_usage_events(id,project_id,conversation_id,session_id,engine,occurred_at,payload,origin_node_id) VALUES(?,?,?,?,?,?,?,?)").run("earlier", project.id, "earlier-chat", "earlier", "pi", occurredAt, JSON.stringify(payload), node.nodeId);
  db.close();
  return { environment, node, project };
}
const limit = (environment: DevEnvironment, node: SeededNode, session: SignedIn, projectId: string, usd: number | null) =>
  api(node, session, "PUT", `/budgets/limits?kind=project&subjectId=${encodeURIComponent(projectId)}`, { limits: usd === null ? [] : [{ period: "day", usd }], utcOffsetMinutes: 0 });
const text = (messages: Array<Record<string, unknown>>, value: string) => messages.some((message) => message.type === "textDelta" && message.text === value);

test("a used-up budget refuses a turn and keeps the prompt queued until the budget is raised", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "budgets-chat-"));
  const sockets: WebSocket[] = [];
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const { environment, node, project } = await kiroNode(root, 6);
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    const chat = openChat(node.url, auth.cookie, project.id, "kiro:new");
    sockets.push(chat.socket);
    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "ready" && message.engine === "kiro"));
    const conversationId = String(chat.messages.find((message) => message.type === "ready")!.conversationId);

    // No limit yet: the turn runs.
    chat.socket.send(JSON.stringify({ type: "prompt", message: "free" }));
    await waitFor(chat.messages, () => text(chat.messages, "free"));
    await waitFor(chat.messages, () => chat.messages.filter((message) => message.type === "agent_end").length === 1);

    // $6 is spent today and the project may spend $5: the next turn is refused with the reason.
    assert.equal((await limit(environment, node, auth, project.id, 5)).status, 200);
    chat.socket.send(JSON.stringify({ type: "prompt", message: "refused" }));
    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "promptFailed" && /Budget reached: the daily limit of \$5\.00 for project .* is used up \(\$6\.00 spent\)/.test(String(message.error))));
    assert.equal(text(chat.messages, "refused"), false, "the model never ran");
    const status = await api<any>(node, auth, "GET", `/budgets/status?projectId=${encodeURIComponent(project.id)}&conversationId=${conversationId}`);
    assert.equal(status.body.blocked, true);

    // Raising the limit lets the queued prompt, and a new one, run in order.
    assert.equal((await limit(environment, node, auth, project.id, 50)).status, 200);
    chat.socket.send(JSON.stringify({ type: "prompt", message: "after" }));
    await waitFor(chat.messages, () => text(chat.messages, "after"));
    assert.equal(text(chat.messages, "refused"), true, "the refused prompt was kept and ran once there was room");
    assert.equal((await api<any>(node, auth, "GET", `/budgets/status?projectId=${encodeURIComponent(project.id)}&conversationId=${conversationId}`)).body.blocked, false);
  } finally {
    for (const socket of sockets) socket.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("a turn that is running when its budget runs out is stopped, and the conversation says why", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "budgets-stop-"));
  const sockets: WebSocket[] = [];
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const { environment, node, project } = await kiroNode(root, 6);
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    assert.equal((await limit(environment, node, auth, project.id, 50)).status, 200);
    const chat = openChat(node.url, auth.cookie, project.id, "kiro:new");
    sockets.push(chat.socket);
    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "ready" && message.engine === "kiro"));
    chat.socket.send(JSON.stringify({ type: "prompt", message: "blocker" }));
    await waitFor(chat.messages, () => text(chat.messages, "blocker"));
    assert.equal(chat.messages.some((message) => message.type === "agent_end"), false, "the turn is still running");

    // The budget is cut below what is already spent; the next minute tick ends the turn.
    assert.equal((await limit(environment, node, auth, project.id, 5)).status, 200);
    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "agent_end"), 100_000);

    const file = await (async () => { await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "sessionFile")); return String(chat.messages.find((message) => message.type === "sessionFile")!.sessionFile); })();
    chat.socket.close();
    const reopened = openChat(node.url, auth.cookie, project.id, file);
    sockets.push(reopened.socket);
    await waitFor(reopened.messages, () => reopened.messages.some((message) => message.type === "ready"));
    const transcript = reopened.messages.find((message) => message.type === "ready")!.messages as Array<{ role: string; text: string }>;
    assert.ok(transcript.some((message) => message.role === "error" && /^Stopped: Budget reached/.test(message.text)), JSON.stringify(transcript.map((message) => message.role)));

    // And nothing new starts until there is room.
    reopened.socket.send(JSON.stringify({ type: "prompt", message: "again" }));
    await waitFor(reopened.messages, () => reopened.messages.some((message) => message.type === "promptFailed" && /Budget reached/.test(String(message.error))));
  } finally {
    for (const socket of sockets) socket.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("a scheduled run that is refused for budget is recorded, and its task stays enabled", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "budgets-cron-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const { environment, node, project } = await kiroNode(root, 6);
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    assert.equal((await limit(environment, node, auth, project.id, 5)).status, 200);
    const input = { projectId: project.id, name: "Nightly", prompt: "report", engine: "kiro", sessionId: null, ownerNodeId: node.nodeId, enabled: true, pauseOnFailure: true, schedule: { frequency: "hourly", hour: 9, minute: (new Date().getUTCMinutes() + 30) % 60, weekday: 1, timezone: "UTC" } };
    const created = await api<{ task: CronTask }>(node, auth, "POST", "/cron", { nodeId: node.nodeId, command: { action: "create", input } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const db = new DatabaseSync(path.join(node.dataDir, "node.db")); db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("UPDATE cron_tasks SET next_run = ? WHERE id = ?").run(Date.now(), created.body.task.id); db.close();
    const read = async () => (await api<{ tasks: CronTask[] }>(node, auth, "GET", `/projects/${project.id}/cron`)).body.tasks.find((task) => task.id === created.body.task.id)!;
    const deadline = Date.now() + 60_000;
    while ((await read()).lastRun?.status !== "failed") { assert.ok(Date.now() < deadline, "the run settles"); await new Promise((resolve) => setTimeout(resolve, 200)); }
    const task = await read();
    assert.match(task.lastRun!.error!, /Budget reached/);
    assert.equal(task.enabled, true, "a used-up budget does not pause the task");
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
