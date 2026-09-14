import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type WebSocket from "ws";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { openChat, waitFor } from "./queued-prompt-harness.js";

const fixtureSource = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
if (process.argv.includes("--version") || process.argv.includes("whoami")) process.exit(0);
const release = process.env.KIRO_FIXTURE_RELEASE;
const compactRelease = process.env.KIRO_FIXTURE_COMPACT_RELEASE;
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const notify = update => send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"native-fixed",update}});
const rl = readline.createInterface({input:process.stdin});
rl.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return send({jsonrpc:"2.0",id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
  const models = {currentModelId:"auto",availableModels:[{modelId:"auto",name:"Auto"}]};
  if (request.method === "session/new") return send({jsonrpc:"2.0",id:request.id,result:{sessionId:"native-fixed",models}});
  if (request.method === "session/load") return send({jsonrpc:"2.0",id:request.id,result:{models}});
  if (request.method === "session/prompt") {
    notify({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"held"}});
    const deadline = Date.now() + 10000;
    const poll = () => fs.existsSync(release) || Date.now() >= deadline
      ? send({jsonrpc:"2.0",id:request.id,result:{stopReason:"end_turn"}})
      : setTimeout(poll, 25);
    poll();
  }
  if (request.method === "_kiro.dev/commands/execute") {
    send({jsonrpc:"2.0",id:request.id,result:{success:true}});
    send({jsonrpc:"2.0",method:"_kiro.dev/compaction/status",params:{status:{type:"started"}}});
    const poll = () => fs.existsSync(compactRelease)
      ? send({jsonrpc:"2.0",method:"_kiro.dev/compaction/status",params:{status:{type:"completed"}}})
      : setTimeout(poll, 25);
    poll();
  }
});
`;

function configure(dataDir: string, executable: string, configPath: string, sessionPath: string, release: string): void {
  const db = new DatabaseSync(path.join(dataDir, "node.db"));
  const save = db.prepare("INSERT INTO node_settings (key, value, is_secret, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
  const now = new Date().toISOString();
  save.run("kiro.executable", executable, now); save.run("kiro.configPath", configPath, now); save.run("kiro.sessionPath", sessionPath, now);
  db.close();
  process.env.KIRO_FIXTURE_RELEASE = release;
  process.env.KIRO_FIXTURE_COMPACT_RELEASE = `${release}.compact`;
}

async function deleteSession(url: string, cookie: string, csrf: string, projectId: string, sessionId: string): Promise<Response> {
  return fetch(`${url}/api/projects/${projectId}/sessions?engine=kiro&sessionId=${sessionId}`, { method: "DELETE", headers: { Cookie: cookie, "x-csrf-token": csrf } });
}

async function waitUntilIdle(node: Parameters<typeof api>[0], auth: Parameters<typeof api>[1], projectId: string, sessionId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const listed = await api<{ sessions: Array<{ id: string; running: boolean }> }>(node, auth, "GET", `/projects/${projectId}/sessions`);
    if (!listed.body.sessions.find((candidate) => candidate.id === sessionId)?.running) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Kiro conversation stayed running after compaction completed");
}

test("Kiro running observation blocks deletion and clears after completion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-observation-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let socket: WebSocket | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1); const node = environment.nodes[0];
    const executable = path.join(environment.home, "bin", "kiro-fixture"); const configPath = path.join(environment.home, ".kiro"); const sessionPath = path.join(configPath, "sessions"); const release = path.join(root, "release");
    await Promise.all([mkdir(path.dirname(executable), { recursive: true }), mkdir(sessionPath, { recursive: true })]); await writeFile(executable, fixtureSource); await chmod(executable, 0o700); configure(node.dataDir, executable, configPath, sessionPath, release);
    server = await startDevNode(environment, node); const auth = await signIn(environment, node); const project = projectNamed(node, "Joint Bob");
    const chat = openChat(node.url, auth.cookie, project.id, "kiro:new"); socket = chat.socket;
    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "ready"));
    chat.socket.send(JSON.stringify({ type: "prompt", message: "hold", requestId: randomUUID() }));
    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "agent_start"));
    await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "sessionFile"));
    const startIndex = chat.messages.findIndex((message) => message.type === "agent_start");
    const fileIndex = chat.messages.findIndex((message) => message.type === "sessionFile");
    assert.ok(chat.messages.slice(startIndex + 1, fileIndex).some((message) => message.type === "sessionsChanged"), "Kiro start must refresh the list before transcript writes so its Running badge appears immediately");
    const file = String(chat.messages[fileIndex].sessionFile); const sessionId = path.basename(file, ".jsonl");
    const listed = await api<{ sessions: Array<{ id: string; harnessId: string; running: boolean; agentLabel: string; executionNodeId?: string }> }>(node, auth, "GET", `/projects/${project.id}/sessions`);
    const row = listed.body.sessions.find((candidate) => candidate.id === sessionId)!;
    assert.deepEqual({ harnessId: row.harnessId, running: row.running, agentLabel: row.agentLabel, owner: row.executionNodeId }, { harnessId: "kiro", running: true, agentLabel: "Kiro", owner: node.nodeId });
    const running = await api<{ projects: Array<{ sessions: Array<{ id: string; harnessId: string }> }> }>(node, auth, "GET", "/running");
    assert.equal(running.body.projects.flatMap((group) => group.sessions).find((candidate) => candidate.id === sessionId)?.harnessId, "kiro");
    assert.equal((await deleteSession(node.url, auth.cookie, auth.csrfToken, project.id, sessionId)).status, 409);
    await writeFile(release, "release"); await waitFor(chat.messages, () => chat.messages.some((message) => message.type === "promptCompleted"));

    const compactStart = chat.messages.length;
    chat.socket.send(JSON.stringify({ type: "compact" }));
    await waitFor(chat.messages, () => chat.messages.slice(compactStart).some((message) => message.type === "status" && (message.status as { isCompacting?: boolean }).isCompacting));
    const compactStatus = chat.messages.findIndex((message, index) => index >= compactStart && message.type === "status" && (message.status as { isCompacting?: boolean }).isCompacting);
    assert.ok(chat.messages.slice(compactStatus + 1).some((message) => message.type === "sessionsChanged"), "Kiro compaction status must refresh the Running badge");
    const compacting = await api<{ sessions: Array<{ id: string; running: boolean }> }>(node, auth, "GET", `/projects/${project.id}/sessions`);
    assert.equal(compacting.body.sessions.find((candidate) => candidate.id === sessionId)?.running, true);
    await writeFile(`${release}.compact`, "release");
    await waitFor(chat.messages, () => chat.messages.slice(compactStart).filter((message) => message.type === "status" && (message.status as { isCompacting?: boolean }).isCompacting === false).length >= 2);
    await waitUntilIdle(node, auth, project.id, sessionId);
  } finally { socket?.close(); if (server) await stopDevNode(server); delete process.env.KIRO_FIXTURE_RELEASE; delete process.env.KIRO_FIXTURE_COMPACT_RELEASE; await rm(root, { recursive: true, force: true }); }
});
