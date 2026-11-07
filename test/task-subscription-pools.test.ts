import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { actingAccount, asNode, runAsAccount } from "../src/account-context.js";
import { automationProfileContext, poolProfileContext, withPoolProfile } from "../src/provider-profiles/context.js";
import { classifyPoolAttemptFailure, resolvePoolModelSettings, runPoolAttempts } from "../src/provider-profiles/pool-execution.js";

const require = createRequire(import.meta.url);
function load(file: string, dependencies: Record<string, any>, extra = ""): any {
  const compiled = ts.transpileModule(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports: any = {};
  vm.runInThisContext(`(function(require, exports) { ${compiled}\n${extra}\n})`)((name: string) => name.startsWith("node:") || name === "ws" ? require(name) : dependencies, exports);
  return exports;
}
const actor = (accountId: string) => ({ accountId, username: accountId, role: "member" as const, isRemoteLogin: false, homeNodeId: null });

function fixture(pooled: boolean, failure?: string) {
  const calls: Array<{ profile: string; account: string | undefined }> = [], errors: string[] = [], completed: string[] = [];
  let resolveSettled!: () => void;
  const settled = new Promise<void>(resolve => { resolveSettled = resolve; });
  const listeners = new Set<(event: any) => void>();
  const project = { id: "project", type: "workspace", path: "/synthetic" };
  const profiles = ["first", "second"].map(id => ({ id, profileId: id, provider: "claude", label: id }));
  const pool = { id: "pool", name: "configured", fallbackModels: {}, members: profiles };
  const selected = () => {
    const profile = poolProfileContext()?.profileId;
    if (pooled && !profile) throw new Error("Selected subscription pool requires pool-aware execution");
    return profile ?? `${actingAccount()?.accountId}-profile`;
  };
  let settings = { provider: "claude", modelId: "opus", reasoning: "high" };
  const session: any = {
    id: "session", file: "claude:/synthetic/session.jsonl", settings: () => settings,
    configure: async (value: typeof settings) => { settings = value; }, preflight: async () => { selected(); },
    subscribe: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    checkpointPoolAttempt: async () => ({}), restorePoolAttempt: async () => {},
    prompt: async (input: any) => {
      await input.beforeStart?.();
      const profile = selected(); calls.push({ profile, account: actingAccount()?.accountId });
      if (failure) throw new Error(failure);
      if (profile === "first") throw new Error("rate_limit");
      input.onStarted?.();
    },
  };
  const shared: any = { engine: "claude", projectId: project.id, conversationId: "session", session, clients: new Set(), turnInFlight: 0 };
  const task: any = { id: "task", title: "Task", description: "Do work", currentNodeId: "node", engine: "claude", status: "in_progress", sessionPath: session.file, attachments: [], phaseConfig: {}, handoffContext: "Prior work", reviewMode: false };
  const runtime = { open: async () => session, validateSettings: async () => {} };
  const dependencies: Record<string, any> = {
    flags: {}, onGuardianEvent: () => {}, actingAccount, asNode, runAsAccount, automationProfileContext, withPoolProfile,
    runPoolAttempts, classifyPoolAttemptFailure, resolvePoolModelSettings,
    getClusterNode: async () => ({ id: "node" }), clusterV2Database: async () => ({}), projectClusterIds: () => [],
    resolveClusterSubscriptionPools: () => [], resolveSubscriptionChoice: () => pooled ? { kind: "pool", pool } : undefined, poolCandidates: () => profiles,
    getProject: async () => project, ownerAsActor: actor, resourceOwner: () => "project-owner",
    getHarness: () => ({ paths: { ownsSession: () => true, sessionId: () => "session" } }), getHarnessRuntime: async () => runtime,
    claimTaskLease: async () => ({ task, leaseToken: "lease" }), claimConversationLocally: async () => {},
    getConversationRecord: async () => ({ conversationId: "session" }), openHarnessSession: async () => shared, harnessSessionBusy: () => false,
    ensureConversationRecord: async () => {}, ensureSessionTitle: async () => {}, updateTaskSessionPath: async () => task,
    broadcastToProject: () => {}, sendHarnessStatus: () => {}, promptTextWithAttachments: (text: string) => text,
    requireLocalConversationOwner: async () => {}, listTasks: async () => [task],
    completeTaskLease: async () => { resolveSettled(); return task; },
    releaseTaskLease: async () => { resolveSettled(); }, updateTask: async () => task,
    ticketMergeConflicts: async () => [], completeTicketMergeRun: async () => ({ problems: [], remaining: 0 }),
    completeUpdateRecovery: async (id: string) => { completed.push(id); }, failUpdateRecovery: async (_id: string, message: string) => { errors.push(message); resolveSettled(); },
    updateContinuationPrompt: "Continue interrupted work", harnessChatConnections: new Set(),
  };
  const chat = load("server/harness-chat.ts", dependencies);
  Object.assign(dependencies, { resolveSubscriptionPool: chat.resolveSubscriptionPool, promptOnSubscriptionPool: chat.promptOnSubscriptionPool, resolveRecoverySubscriptionPool: chat.resolveRecoverySubscriptionPool });
  Object.assign(dependencies, load("server/background-turn.ts", dependencies));
  const exports = load("server/task-runs.ts", dependencies);
  return { exports, dependencies, project, task, shared, calls, errors, completed, settled };
}

for (const pooled of [false, true]) for (const kind of ["planning", "in_progress", "review", "merge", "recovery"] as const) {
  test(`${kind} task runs on the configured ${pooled ? "pool" : "profile"}`, { timeout: 10_000 }, async () => {
    const f = fixture(pooled);
    const run = async () => {
      if (kind === "merge") await f.exports.startMergeRun(f.project, f.task);
      else if (kind === "recovery") {
        f.dependencies.listPendingUpdateRecoveries = async () => [{ id: "recovery", kind: "task", projectId: "project", taskId: "task", engine: "claude", sessionPath: f.task.sessionPath, phase: "in_progress", settings: f.shared.session.settings(), accountId: "original-writer" }];
        await f.exports.recoverPendingUpdateRuns();
      } else await f.exports.startTaskRun(f.project, f.task, kind);
      await f.settled;
    };
    if (kind === "recovery") await run();
    else await runAsAccount(actor("writer"), run);
    const account = kind === "recovery" ? "original-writer" : "writer";
    assert.deepEqual(f.calls, pooled ? [{ profile: "first", account }, { profile: "second", account }] : [{ profile: `${account}-profile`, account }]);
    assert.equal(f.shared.turnInFlight, 0);
    assert.equal(f.exports.harnessTaskRuns.size, 0);
    assert.deepEqual(f.errors, []);
  });
}

test("background task starts use the project owner's configured pool", { timeout: 10_000 }, async () => {
  const f = fixture(true);
  await f.exports.startTaskRun(f.project, f.task);
  await f.settled;
  assert.deepEqual(f.calls.map(call => call.account), ["project-owner", "project-owner"]);
});

test("task preparation failure clears busy state and releases the lease", async () => {
  const f = fixture(true);
  f.dependencies.prepareBackgroundTurn = async () => { throw new Error("No compatible subscription profile is available in this pool"); };
  await assert.rejects(runAsAccount(actor("writer"), () => f.exports.startTaskRun(f.project, f.task)), /No compatible subscription profile/);
  await f.settled;
  assert.deepEqual(f.calls, []);
  assert.equal(f.shared.turnInFlight, 0);
  assert.equal(f.shared.turnAccountId, null);
  assert.equal(f.exports.harnessTaskRuns.size, 0);
});

test("a task pool's generic failure releases the run without trying another account", { timeout: 10_000 }, async t => {
  t.mock.method(console, "warn", () => {});
  const f = fixture(true, "Invalid request");
  await runAsAccount(actor("writer"), () => f.exports.startTaskRun(f.project, f.task));
  await f.settled;
  assert.deepEqual(f.calls, [{ profile: "first", account: "writer" }]);
  assert.equal(f.shared.turnInFlight, 0);
  assert.equal(f.exports.harnessTaskRuns.size, 0);
});
