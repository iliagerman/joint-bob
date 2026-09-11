import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser } from "playwright-core";
import WebSocket from "ws";
import { browserAgentIdentity, browserAgentInstructions } from "../src/browser-agent.js";
import { BrowserRuntime } from "../src/browser-runtime.js";
import { getClusterNode } from "../src/cluster.js";
import { ensureConversationRecord, getConversationRecord } from "../src/conversation-records.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { addProject } from "../src/store.js";
import { saveSecretAccount, setScopeSecretAccounts } from "../src/secrets.js";
import { createTask, listTasks, updateTask } from "../src/tasks.js";
import { beginTicketMerge } from "../src/ticket-merge-service.js";
import { listPendingUpdateRecoveries, saveUpdateRecoveries } from "../src/update-recovery.js";
import type { ChatConnection } from "../src/server/state.js";

const root = path.join(os.homedir(), "browser-spawn-regressions");
const capture = path.join(root, "spawns.jsonl");
let chat: typeof import("../src/server/chat.js");
let runs: typeof import("../src/server/task-runs.js");
let state: typeof import("../src/server/state.js");

before(async () => {
  await mkdir(root, { recursive: true });
  const executable = path.join(root, "claude-fixture.mjs");
  await writeFile(capture, "");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
const sessionId = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
const systemIndex = args.indexOf('--append-system-prompt-file');
const instructions = systemIndex < 0 ? '' : await readFile(args[systemIndex + 1], 'utf8');
await appendFile(${JSON.stringify(capture)}, JSON.stringify({sessionId, args, prompt, instructions, token:process.env.JOINT_BOB_BROWSER_TOKEN, url:process.env.JOINT_BOB_BROWSER_URL, cli:process.env.JOINT_BOB_BROWSER_CLI, secret:process.env.BRIDGE_FIXTURE}) + '\\n');
console.log(JSON.stringify({type:'system',subtype:'init',session_id:sessionId}));
console.log(JSON.stringify({type:'result',is_error:false}));
`);
  await chmod(executable, 0o755);
  updateSettings({ ...getSettings(), claude: { executable, configPath: path.join(root, "claude"), sessionPath: path.join(root, "claude", "projects") }, pi: { executable: "", configPath: path.join(root, "pi"), sessionPath: path.join(root, "pi", "sessions") }, syncthing: { endpoint: "" } });
  chat = await import("../src/server/chat.js");
  runs = await import("../src/server/task-runs.js");
  state = await import("../src/server/state.js");
});

after(() => {
  chat?.sessionWatcher.close();
  for (const shared of new Set(state?.sharedSessions.values())) {
    if (shared.idleTimer) clearTimeout(shared.idleTimer);
    shared.unsubscribe();
    shared.handle.dispose();
  }
  state?.sharedSessions.clear();
  state?.claudeClients.clear();
});

async function projectFixture() {
  const cwd = path.join(root, randomUUID());
  await mkdir(cwd);
  const project = await addProject("Browser spawn regression", cwd, { writeInstructions: false });
  const account = await saveSecretAccount({ label: "Spawn fixture", provider: "custom", variables: [{ name: "BRIDGE_FIXTURE", kind: "value", value: "attached-secret" }] });
  await setScopeSecretAccounts("project", project.id, [account.id]);
  return project;
}

// Stub only Chrome's transport. Identity, browser reuse/control, switch handling,
// Pi session creation and the bash subprocess all run through production code.
function fakeBrowser(): Browser {
  const browser = new EventEmitter();
  return Object.assign(browser, {
    newContext: async () => {
      const context = new EventEmitter();
      return Object.assign(context, {
        setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
        newPage: async () => {
          const page = Object.assign(new EventEmitter(), { url: () => "about:blank", title: async () => "Existing tab" });
          context.emit("page", page);
          return page;
        },
        close: async () => { context.emit("close"); },
      });
    },
    close: async () => {},
  }) as unknown as Browser;
}

test("live Claude to Pi and Pi to Claude to Pi switches keep the existing human-paused browser", async (t) => {
  t.mock.method(chromium, "launch", async () => fakeBrowser());
  const project = await projectFixture();
  const local = await getClusterNode();
  const originalId = randomUUID();
  const frames: Array<Record<string, unknown>> = [];
  const socket = { OPEN: WebSocket.OPEN, readyState: WebSocket.OPEN, send: (text: string) => frames.push(JSON.parse(text)) } as WebSocket;
  const connection: ChatConnection = { socket, project, taskId: null, cwd: project.path, engine: "claude", shared: null, claude: chat.emptyClaudeState(originalId), handoffContext: null, secretAccountIds: [] };
  const { claimConversationLocally } = await import("../src/server/sessions-helpers.js");
  await claimConversationLocally("claude", originalId, local.id);
  const runtime = new BrowserRuntime({ proxyFor: async () => ({ server: "http://127.0.0.1:1", close: async () => {} }), capability: async () => ({ supported: true, available: true, executable: process.execPath, reason: null }) });
  try {
    const existing = await runtime.create({ projectId: project.id, engine: "claude", conversationId: originalId, appNodeId: local.id });
    await runtime.execute(existing.id, { action: "takeControl" }, { kind: "human", id: "fixture-human" });
    for (const engine of ["pi", "claude", "pi"] as const) {
      await chat.handleChatMessage(connection, Buffer.from(JSON.stringify({ type: "setEngine", engine })));
      assert.equal(connection.engine, engine);
      assert.equal(frames.filter(frame => frame.type === "engineChanged").at(-1)?.conversationId, originalId, "viewer must retain the logical conversation");
      if (engine !== "pi") continue;
      const session = connection.shared!.handle.session;
      assert.notEqual(session.sessionId, originalId, "switch must allocate a fresh segment before testing its token");
      assert.equal((await getConversationRecord(project.id, "pi", session.sessionId))?.conversationId, originalId);
      const bash = session.agent.state.tools.find(tool => tool.name === "bash")!;
      const result = await bash.execute("switch-token", { command: `node -e 'console.log(process.env.JOINT_BOB_BROWSER_TOKEN)'` });
      const token = result.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
      const identity = browserAgentIdentity(token)!;
      assert.deepEqual(identity, { projectId: project.id, engine: "pi", conversationId: originalId }, "live Pi bash must use the logical ID known before segment persistence");
      const agentBrowser = await runtime.create({ ...identity, appNodeId: local.id });
      const viewerBrowser = (await runtime.list({ projectId: project.id, conversationId: originalId }))[0];
      assert.equal(agentBrowser.id, existing.id);
      assert.equal(viewerBrowser.id, existing.id);
      assert.deepEqual(agentBrowser.tabs, existing.tabs);
      assert.equal(agentBrowser.owner, "human");
      await assert.rejects(runtime.execute(agentBrowser.id, { action: "navigate", url: "https://example.com" }, { kind: "agent" }), /agent input paused/);
    }
  } finally { await runtime.close(); }
});

interface CapturedRun { sessionId: string; args: string[]; prompt: string; instructions: string; token: string; url: string; cli: string; secret: string; }
async function captured(): Promise<CapturedRun[]> {
  return (await readFile(capture, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, "Claude fixture did not finish");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function assertBridge(run: CapturedRun, projectId: string, conversationId: string) {
  assert.match(run.token ?? "", /^[a-f0-9]{64}$/, "Claude subprocess must receive a browser token");
  assert.deepEqual(browserAgentIdentity(run.token), { projectId, engine: "claude", conversationId });
  assert.equal(run.url, `http://127.0.0.1:${process.env.PORT || 8790}/api/browser/agent`);
  assert.equal(run.cli, path.resolve("bin/joint-bob-browser.mjs"));
  assert.equal(run.secret, "attached-secret");
  assert.ok(run.instructions.includes(browserAgentInstructions), "browser instructions belong in every spawn's system file");
  assert.ok(!run.prompt.includes(browserAgentInstructions));
  assert.ok(!run.instructions.includes(run.token));
}

for (const resumed of [false, true]) {
  test(`Claude ${resumed ? "resumed" : "new"} task spawn receives browser bridge and scoped secrets`, async () => {
    const project = await projectFixture();
    let task = await createTask(project.id, project.path, "Browser task", "Inspect a page", "planning", "claude", false, false, {});
    const logicalId = randomUUID();
    if (resumed) {
      const { claudeSessionFilePath } = await import("../src/claude-service.js");
      const segment = randomUUID();
      task = await updateTask(project.id, task.id, { sessionPath: `claude:${claudeSessionFilePath(task.worktreePath!, segment)}` });
      await ensureConversationRecord(project.id, "claude", segment, (await getClusterNode()).id, task.id, { conversationId: logicalId, segmentIndex: 1 });
    }
    const count = (await captured()).length;
    await runs.startTaskRun(project, task, "planning");
    await waitUntil(async () => !runs.claudeTaskRuns.has(task.id));
    const run = (await captured())[count];
    assert.ok(run, "task must spawn the Claude executable");
    assert.equal(run.args.includes("--resume"), resumed);
    assertBridge(run, project.id, resumed ? logicalId : run.sessionId);
  });
}

test("Claude merge spawn resolves the existing logical browser identity", async () => {
  const project = await projectFixture();
  await writeFile(path.join(project.path, "conflict.txt"), "baseline\n");
  let task = await createTask(project.id, project.path, "Merge browser work", "", "done", "claude", false, false, {});
  await writeFile(path.join(project.path, "conflict.txt"), "project change\n");
  await writeFile(path.join(task.worktreePath!, "conflict.txt"), "ticket change\n");
  const { claudeSessionFilePath } = await import("../src/claude-service.js");
  const segment = randomUUID(), logicalId = randomUUID();
  task = await updateTask(project.id, task.id, { sessionPath: `claude:${claudeSessionFilePath(task.worktreePath!, segment)}` });
  await ensureConversationRecord(project.id, "claude", segment, (await getClusterNode()).id, task.id, { conversationId: logicalId, segmentIndex: 1 });
  const prepared = await beginTicketMerge(project, task);
  assert.ok(prepared.prepared.conflicts.length > 0, "merge must require an agent");
  const count = (await captured()).length;
  await runs.startMergeRun(project, prepared.task);
  await waitUntil(async () => !runs.claudeTaskRuns.has(task.id) && !runs.mergeReservations.has(task.id) && !(await listTasks(project.id)).find(item => item.id === task.id)?.leaseOwnerNodeId);
  const run = (await captured())[count];
  assert.ok(run.prompt.includes("Merge instructions:"));
  assertBridge(run, project.id, logicalId);
});

test("recovered Claude chat and queued recovery turns retain browser bridge without changing slash input", async () => {
  const project = await projectFixture();
  const { claudeSessionFilePath } = await import("../src/claude-service.js");
  const segment = randomUUID(), logicalId = randomUUID();
  const file = claudeSessionFilePath(project.path, segment);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ type: "user", message: { role: "user", content: "Browser work in progress" } }) + "\n");
  await ensureConversationRecord(project.id, "claude", segment, (await getClusterNode()).id, undefined, { conversationId: logicalId, segmentIndex: 1 });
  await saveUpdateRecoveries([{ id: randomUUID(), kind: "chat", engine: "claude", projectId: project.id, cwd: project.path, sessionId: segment, sessionPath: `claude:${file}`, taskId: null, phase: null, queuedPrompts: ["/compact"], model: null, effort: null, createdAt: new Date().toISOString() }]);
  const count = (await captured()).length;
  await runs.recoverPendingUpdateRuns();
  assert.deepEqual(await listPendingUpdateRecoveries(), []);
  const recovered = (await captured()).slice(count);
  assert.equal(recovered.length, 2);
  assert.equal(recovered[1].prompt, "/compact");
  for (const run of recovered) assertBridge(run, project.id, logicalId);
  assert.notEqual(recovered[0].token, recovered[1].token, "each recovered spawn gets its own token");
});
