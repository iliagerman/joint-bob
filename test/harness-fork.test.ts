import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { snapshotKiroFork } from "../src/harnesses/kiro/fork.js";
import { listDiscoveredHarnesses } from "../src/harnesses/registry.js";
import { kiroSessionFilePath, readKiroSession } from "../src/harnesses/kiro/storage.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { addProject } from "../src/store.js";
import type { ProjectRecord } from "../src/types.js";

test("Kiro fork copies context and settings without sharing the native session", async () => {
  const sourceId = "kiro-source";
  const newId = "kiro-fork";
  const source = kiroSessionFilePath(sourceId);
  await mkdir(path.dirname(source), { recursive: true });
  const records = [
    { type: "joint-bob-kiro", version: 1, id: sourceId, cwd: "/tmp/project", nativeSessionId: "native-source", modelId: "default", reasoning: "low", timestamp: "2025-01-01T00:00:00.000Z" },
    { type: "message", role: "user", text: "first", timestamp: "2025-01-01T00:00:01.000Z" },
    { type: "tool", toolName: "fs_read", text: "file body", timestamp: "2025-01-01T00:00:01.500Z" },
    { type: "message", role: "assistant", text: "done", timestamp: "2025-01-01T00:00:02.000Z" },
    { type: "settings", modelId: "model-two", reasoning: "high", enabledTools: ["read"], timestamp: "2025-01-01T00:00:03.000Z" },
    { type: "title", title: "Original", timestamp: "2025-01-01T00:00:04.000Z" },
  ];
  const original = records.map(JSON.stringify).join("\n") + "\n";
  await writeFile(source, original);
  const snapshot = snapshotKiroFork({ project: { id: "project", name: "Project", path: "/tmp/project" } as ProjectRecord, sessionId: sourceId, sessionPath: `kiro:${source}`, newSessionId: newId, title: "[F] Original", timestamp: "2025-02-01T00:00:00.000Z", draft: false });
  assert.equal(snapshot.sessionPath, `kiro:${kiroSessionFilePath(newId)}`);
  assert.equal(snapshot.files.length, 1);
  await writeFile(snapshot.files[0].destination, snapshot.files[0].contents);
  const fork = await readKiroSession(snapshot.files[0].destination);
  assert.equal(fork.id, newId);
  assert.equal(fork.nativeSessionId, null);
  assert.equal(fork.handoffPending, true);
  assert.equal(fork.modelId, "model-two");
  assert.equal(fork.reasoning, "high");
  assert.deepEqual(fork.enabledTools, ["read"]);
  assert.deepEqual(fork.messages.map(({ role, text, toolName }) => ({ role, text, toolName })), [
    { role: "user", text: "first", toolName: undefined },
    { role: "toolResult", text: "file body", toolName: "fs_read" },
    { role: "assistant", text: "done", toolName: undefined },
  ], "a forked transcript keeps the tool bubbles that explain its prose");
  assert.equal(fork.title, "[F] Original");
  assert.equal(await readFile(source, "utf8"), original);
});

test("Kiro fork first turn creates a native session and hands off history only once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kiro-fork-wire-"));
  const previousSettings = getSettings();
  let session: Awaited<ReturnType<NonNullable<ReturnType<typeof listDiscoveredHarnesses>[number]["runtime"]>["open"]>> | undefined;
  try {
    const configPath = path.join(root, "kiro");
    const sessionPath = path.join(configPath, "sessions");
    const executable = path.join(root, "kiro-fixture");
    const logFile = path.join(root, "wire.jsonl");
    const fixture = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const log = value => fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(value) + "\\n");
const models = {currentModelId:"fixture-model",availableModels:[{modelId:"fixture-model",name:"Fixture Model"}]};
const rl = readline.createInterface({input:process.stdin});
rl.on("line", line => {
  const request = JSON.parse(line); log({method:request.method,text:request.params?.prompt?.[0]?.text,sessionId:request.params?.sessionId});
  if (request.method === "initialize") return send({jsonrpc:"2.0",id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
  if (request.method === "session/new") return send({jsonrpc:"2.0",id:request.id,result:{sessionId:"fork-native",models}});
  if (request.method === "session/load") return send({jsonrpc:"2.0",id:request.id,result:{models}});
  if (request.method === "session/prompt") { send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"fork-native",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"answer"}}}}); return send({jsonrpc:"2.0",id:request.id,result:{stopReason:"end_turn"}}); }
});`;
    await Promise.all([mkdir(sessionPath, { recursive: true }), writeFile(executable, fixture)]);
    await chmod(executable, 0o700);
    updateSettings({ runtimes: { ...previousSettings.runtimes, kiro: { ...previousSettings.runtimes.kiro, executable, configPath, sessionPath } }, syncthing: { endpoint: "" } });
    const project = await addProject("Fork fixture", root);
    const sourceId = "fork_source";
    const forkId = "fork_target";
    const source = kiroSessionFilePath(sourceId);
    await mkdir(path.dirname(source), { recursive: true });
    const original = [
      { type: "joint-bob-kiro", version: 1, id: sourceId, cwd: root, nativeSessionId: "source-native", modelId: "default", reasoning: "low", timestamp: "2025-01-01T00:00:00.000Z" },
      { type: "message", role: "user", text: "prior question", timestamp: "2025-01-01T00:00:01.000Z" },
      { type: "message", role: "assistant", text: "prior answer", timestamp: "2025-01-01T00:00:02.000Z" },
    ].map(JSON.stringify).join("\n") + "\n";
    await writeFile(source, original);
    const snapshot = snapshotKiroFork({ project, sessionId: sourceId, sessionPath: `kiro:${source}`, newSessionId: forkId, title: "Fork", timestamp: "2025-02-01T00:00:00.000Z", draft: false });
    await writeFile(snapshot.files[0].destination, snapshot.files[0].contents);
    assert.equal((await readKiroSession(snapshot.files[0].destination)).handoffPending, true);
    const runtime = await listDiscoveredHarnesses().find(({ id }) => id === "kiro")!.runtime!();
    session = await runtime.open({ projectId: project.id, cwd: root, sessionId: forkId, sessionPath: snapshot.sessionPath });
    await session.prompt({ text: "new question" });
    await session.prompt({ text: "second question" });
    const wire = (await readFile(logFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string; text?: string; sessionId?: string });
    const sessionMethods = wire.filter(({ method }) => method === "session/new" || method === "session/load").map(({ method }) => method);
    assert.deepEqual(sessionMethods, ["session/new", "session/load"]);
    const prompts = wire.filter(({ method }) => method === "session/prompt");
    assert.match(prompts[0].text!, /prior question[\s\S]*prior answer[\s\S]*new question/);
    assert.equal(prompts[0].sessionId, "fork-native");
    assert.equal(prompts[1].text, "second question");
    assert.equal(prompts[1].sessionId, "fork-native");
    assert.equal((await readKiroSession(snapshot.files[0].destination)).handoffPending, false);
    assert.equal(await readFile(source, "utf8"), original);
  } finally {
    if (session?.status().isStreaming) await session.stopForUpdate();
    session?.dispose();
    updateSettings({ runtimes: previousSettings.runtimes, syncthing: { endpoint: "" } });
    await rm(root, { recursive: true, force: true });
  }
});
