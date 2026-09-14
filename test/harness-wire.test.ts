import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildHandoffContext } from "../src/handoff-context.js";
import { kiroAgentProfile } from "../src/harnesses/kiro/resources.js";
import { readKiroSession } from "../src/harnesses/kiro/storage.js";
import { listDiscoveredHarnesses } from "../src/harnesses/registry.js";
import { conversationScopeId, getScopeSecretAccounts, saveSecretAccount, setScopeSecretAccounts } from "../src/secrets.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { addProject } from "../src/store.js";

const fixtureSource = `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv.includes("--version") || process.argv.includes("whoami")) process.exit(0);
if (JSON.stringify(process.argv.slice(2)) === JSON.stringify(["chat", "--list-models", "--format", "json"])) {
  process.stdout.write(JSON.stringify({models:[{model_id:"fixture-model-current",model_name:"Fixture Current"},{model_id:"fixture-model-alternative",model_name:"Fixture Alternative"}],default_model:"fixture-model-current"}));
  process.exit(0);
}
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const notify = update => send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"fixture-native",update}});
const metadata = () => send({jsonrpc:"2.0",method:"_kiro.dev/metadata",params:{sessionId:"fixture-native",contextUsagePercentage:42.5}});
const models = {currentModelId:"fixture-model-current",availableModels:[{modelId:"fixture-model-current",name:"Fixture Current"},{modelId:"fixture-model-alternative",name:"Fixture Alternative",description:"Alternative fixture model"}]};
const rl = readline.createInterface({input:process.stdin});
let permissionPromptId;
rl.on("line", line => {
  const request = JSON.parse(line);
  if (request.id === "permission-probe") {
    const outcome = request.result?.outcome?.outcome === "selected" ? "selected" : "cancelled";
    notify({sessionUpdate:"agent_message_chunk",content:{type:"text",text:outcome}});
    send({jsonrpc:"2.0",id:permissionPromptId,result:{stopReason:"end_turn"}});
    permissionPromptId = undefined;
    return;
  }
  if (request.method === "initialize") return send({jsonrpc:"2.0",id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
  if (request.method === "session/new") {
    notify({sessionUpdate:"available_commands_update",availableCommands:[]});
    metadata();
    return send({jsonrpc:"2.0",id:request.id,result:{sessionId:"fixture-native",models}});
  }
  if (request.method === "session/load") {
    notify({sessionUpdate:"user_message_chunk",content:{type:"text",text:"old user"}});
    notify({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"old assistant"}});
    metadata();
    return send({jsonrpc:"2.0",id:request.id,result:{models}});
  }
  if (request.method === "_kiro.dev/commands/execute") {
    const expectedArgs = request.params.command.args.value === "fail" ? {value:"fail"} : {value:"focus"};
    if (request.params.sessionId !== "fixture-native" || request.params.command.command !== "compact" || JSON.stringify(request.params.command.args) !== JSON.stringify(expectedArgs)) {
      return send({jsonrpc:"2.0",id:request.id,error:{code:-32602,message:"invalid compact payload"}});
    }
    send({jsonrpc:"2.0",method:"_kiro.dev/compaction/status",params:{status:{type:"started"}}});
    if (request.params.command.args.value === "fail") {
      send({jsonrpc:"2.0",method:"_kiro.dev/compaction/status",params:{status:{type:"failed",error:"fixture compaction failed"}}});
    } else {
      send({jsonrpc:"2.0",method:"_kiro.dev/compaction/status",params:{status:{type:"completed"}}});
    }
    return send({jsonrpc:"2.0",id:request.id,result:{success:true}});
  }
  if (request.method === "session/prompt") {
    const text = request.params.prompt[0].text;
    if (text === "permission-probe") {
      permissionPromptId = request.id;
      return send({jsonrpc:"2.0",id:"permission-probe",method:"session/request_permission",params:{sessionId:"fixture-native",toolCall:{toolCallId:"disabled-shell",title:"Execute shell",kind:"execute"},options:[{optionId:"once",kind:"allow_once",name:"Allow once"}]}});
    }
    if (text !== "empty") {
      const handoffValid = !text.startsWith("Context handoff:") || (text.includes("prior history") && text.includes("\\n---\\n") && text.endsWith("actual question"));
      notify({sessionUpdate:"agent_message_chunk",content:{type:"text",text:handoffValid ? (process.env.WIRE_SECRET ? "attached" : "removed") : "missing-handoff"}});
      notify({sessionUpdate:"tool_call",toolCallId:"tool-1",title:"Read fixture",rawInput:{path:"fixture"},_meta:{kiro:{toolName:"read"}}});
      notify({sessionUpdate:"tool_call_update",toolCallId:"tool-1",status:"completed",content:[{type:"content",content:{type:"text",text:"tool result"}}]});
    }
    return send({jsonrpc:"2.0",id:request.id,result:{stopReason:"end_turn"}});
  }
});
rl.on("close", () => process.exit(0));
`;

test("synthetic Kiro ACP covers new, resume, frontend events, empty turns, and credential refresh", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-wire-"));
  const previousSettings = getSettings();
  let session: Awaited<ReturnType<NonNullable<ReturnType<typeof listDiscoveredHarnesses>[number]["runtime"]>["open"]>> | undefined;
  try {
    const executable = path.join(root, "kiro-fixture");
    const configPath = path.join(root, "kiro");
    const sessionPath = path.join(configPath, "sessions");
    await Promise.all([writeFile(executable, fixtureSource), mkdir(sessionPath, { recursive: true })]);
    await chmod(executable, 0o700);
    updateSettings({ runtimes: { ...previousSettings.runtimes, kiro: { ...previousSettings.runtimes.kiro, executable, configPath, sessionPath } }, syncthing: { endpoint: "" } });
    const project = await addProject("Wire fixture", root);
    const account = await saveSecretAccount({ label: "fixture", provider: "custom", variables: [{ name: "WIRE_SECRET", kind: "value", value: "test-only-value" }] });
    const adapter = listDiscoveredHarnesses().find(({ id }) => id === "kiro")!;
    const runtime = await adapter.runtime!();

    session = await runtime.open({ projectId: project.id, cwd: root, sessionId: "permission_restricted" });
    await session.setTools(["read"]);
    const restrictedEvents: unknown[] = [];
    session.subscribe((event) => { if (event.type === "textDelta") restrictedEvents.push(event); });
    await session.prompt({ text: "permission-probe" });
    assert.deepEqual(restrictedEvents, [{ type: "textDelta", text: "cancelled" }]);
    const restrictedProfile = JSON.parse(await readFile(path.join(configPath, "agents", "joint-bob-permission_restricted.json"), "utf8")) as { tools: string[] };
    assert.deepEqual(restrictedProfile.tools, ["read"]);
    const restrictedAlias = session.file!.replace(/^kiro:/, "");
    assert.deepEqual((await readKiroSession(restrictedAlias)).enabledTools, ["read"]);
    const actualModel = session.status().model;
    const actualReasoning = session.status().thinkingLevel;
    await session.setTools([]);
    assert.deepEqual(session.status().model, actualModel);
    assert.equal(session.status().thinkingLevel, actualReasoning);
    session.dispose();

    session = await runtime.open({ projectId: project.id, cwd: root, sessionId: "permission_restricted", sessionPath: `kiro:${restrictedAlias}` });
    assert.deepEqual(session.settings().enabledTools, []);
    assert.deepEqual(session.tools().filter(({ active }) => active).map(({ name }) => name), []);
    session.dispose();

    session = await runtime.open({ projectId: project.id, cwd: root, sessionId: "permission_default" });
    const defaultEvents: unknown[] = [];
    session.subscribe((event) => { if (event.type === "textDelta") defaultEvents.push(event); });
    await session.prompt({ text: "permission-probe" });
    assert.deepEqual(defaultEvents, [{ type: "textDelta", text: "selected" }]);
    session.dispose();

    session = await runtime.open({ projectId: project.id, cwd: root, sessionId: "wire_session", accountIds: [account.id] });
    const events: unknown[] = [];
    session.subscribe((event) => { if (["textDelta", "toolStart", "toolEnd", "sessionFile"].includes(String(event.type))) events.push(event); });
    let fencedStarts = 0;
    const messagesBeforeFence = session.messages.length;
    await assert.rejects(session.prompt({
      text: "late-fenced",
      beforeStart: async () => { throw new Error("late execution fence"); },
      onStarted: () => { fencedStarts += 1; },
    }), /late execution fence/);
    assert.equal(fencedStarts, 0);
    assert.equal(session.messages.length, messagesBeforeFence);
    let starts = 0;
    const handoffPrompt = `${buildHandoffContext([{ id: "old", role: "user", text: "prior history" }])}actual question`;
    await session.prompt({ text: handoffPrompt, onStarted: () => { starts += 1; } });
    assert.deepEqual(events.slice(0, 4), [
      { type: "sessionFile", sessionId: "wire_session", sessionFile: session.file },
      { type: "textDelta", text: "attached" },
      { type: "toolStart", toolCallId: "tool-1", toolName: "read", title: "Read fixture", args: { path: "fixture" } },
      { type: "toolEnd", toolCallId: "tool-1", toolName: "read", title: "Read fixture", text: "tool result", isError: false },
    ]);
    assert.equal(starts, 1);
    assert.equal(session.messages.at(-2)?.text, "actual question");
    assert.equal((await readKiroSession(session.file!.replace(/^kiro:/, ""))).messages.at(-2)?.text, "actual question");
    assert.deepEqual((await runtime.models()).map(({ id }) => id), ["fixture-model-current", "fixture-model-alternative"]);
    assert.deepEqual(session.status().model, { provider: "kiro", id: "fixture-model-current", label: "Fixture Current" });
    assert.deepEqual(session.status().contextUsage, { percent: 42.5 });
    assert.equal(session.status().contextUsage?.usedTokens, undefined);
    assert.equal(session.status().contextUsage?.contextWindow, undefined);
    await assert.rejects(session.compact("focus", async () => { throw new Error("compaction fence"); }), /compaction fence/);
    assert.equal(session.isBusy(), false);
    await session.compact("focus");
    assert.equal(session.status().isCompacting, false);
    await assert.rejects(session.compact("fail"), /fixture compaction failed/);
    assert.equal(session.status().isCompacting, false);
    const file = session.file!;
    session.dispose();
    await setScopeSecretAccounts("conversation", conversationScopeId("kiro", "wire_session"), []);
    session = await runtime.open({ projectId: project.id, cwd: root, sessionId: "wire_session", sessionPath: file, accountIds: [account.id] });
    const resumedEvents: unknown[] = [];
    session.subscribe((event) => { if (event.type === "textDelta") resumedEvents.push(event); });
    await session.prompt({ text: "again" });
    assert.deepEqual(resumedEvents, [{ type: "textDelta", text: "removed" }]);
    assert.deepEqual((await getScopeSecretAccounts("conversation", conversationScopeId("kiro", "wire_session"))).accountIds, []);
    let emptyStarts = 0;
    await session.prompt({ text: "empty", onStarted: () => { emptyStarts += 1; } });
    assert.equal(emptyStarts, 1);
    assert.equal(session.messages.some((message) => message.text === "old assistant"), false);
  } finally {
    if (session?.status().isStreaming) await session.stopForUpdate();
    session?.dispose();
    updateSettings({ runtimes: previousSettings.runtimes, syncthing: { endpoint: "" } });
    await rm(root, { recursive: true, force: true });
  }
});

test("Kiro profile accepts a symlinked skill root and lists credential names and browser instructions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kiro-profile-"));
  const previousSettings = getSettings();
  try {
    const configPath = path.join(root, "kiro");
    const sessionPath = path.join(configPath, "sessions");
    updateSettings({ runtimes: { ...previousSettings.runtimes, kiro: { ...previousSettings.runtimes.kiro, configPath, sessionPath } }, syncthing: { endpoint: "" } });
    const target = path.join(root, "skill-target");
    const linked = path.join(root, ".agents", "skills");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "# Fixture skill\n");
    await mkdir(path.dirname(linked), { recursive: true });
    await symlink(target, linked, "dir");
    const profileName = await kiroAgentProfile({ projectId: "unused", cwd: root, sessionId: "profile_fixture" }, "## Available secret accounts\n- WIRE_SECRET");
    const profile = JSON.parse(await readFile(path.join(getSettings().runtimes.kiro.configPath, "agents", `${profileName}.json`), "utf8")) as { prompt: string; resources: string[] };
    assert.match(profile.prompt, /WIRE_SECRET/);
    assert.match(profile.prompt, /browser/i);
    assert.equal(profile.resources.includes(`skill://${await (await import("node:fs/promises")).realpath(target)}/**/SKILL.md`), true);
  } finally {
    updateSettings({ runtimes: previousSettings.runtimes, syncthing: { endpoint: "" } });
    await rm(root, { recursive: true, force: true });
  }
});
