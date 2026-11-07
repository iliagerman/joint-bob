import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { actingAccount, runAsAccount } from "../src/account-context.js";
import { automationProfileContext, poolProfileContext, withAutomationProfile, withPoolProfile, withoutAutomationProfile } from "../src/provider-profiles/context.js";
import { runPoolAttempts } from "../src/provider-profiles/pool-execution.js";
import { ConversationOwnershipError } from "../src/conversation-ownership.js";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/server/harness-chat.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;

function fixture(selection: "cluster" | "conversation" | "none", failure?: Error) {
  const used: string[] = [], statuses: boolean[] = [], events: any[] = [], lookups: string[] = [], accounts: Array<string | undefined> = [];
  const queue: any[] = [];
  let restored = 0, queueReads = 0, goalReads = 0;
  const profiles = ["first", "second"].map(id => ({ id, profileId: id, provider: "claude", label: id }));
  const pool = { id: "pool", name: "shared", fallbackModels: {}, members: profiles };
  const session = {
    id: "conversation", isBusy: () => false,
    status: () => ({ contextUsage: { percent: 90 } }),
    settings: () => ({ provider: "claude", modelId: "opus", reasoning: "high" }),
    checkpointPoolAttempt: async () => ({}), restorePoolAttempt: async () => { restored++; },
    compact: async (_instructions?: string, beforeStart?: () => Promise<void>) => {
      await beforeStart?.();
      const member = poolProfileContext()?.profileId ?? automationProfileContext()?.profileId;
      if (selection !== "none" && !member) throw new Error("Selected subscription pool requires pool-aware execution");
      accounts.push(automationProfileContext()?.accountId ?? actingAccount()?.accountId);
      used.push(member ?? "single");
      if (failure) throw failure;
      if (member === "first") throw new Error("rate_limit");
    },
  };
  const shared = { engine: "claude", projectId: "project", conversationId: "conversation", session, turnInFlight: 0, clients: new Set() };
  const connection = { engine: "claude", project: { id: "project", type: "workspace" }, conversationId: "conversation", shared, author: { accountId: "writer" }, socket: {}, readOnly: false };
  const dependencies = {
    flags: {}, onGuardianEvent: () => {},
    actingAccount, runAsAccount, withPoolProfile, withoutAutomationProfile, runPoolAttempts, ConversationOwnershipError,
    ownerAsActor: (accountId: string) => ({ accountId }), resourceOwner: () => "owner",
    runWithAutomationProfile: (input: any, work: () => any) => withAutomationProfile({ accountId: input.creatorAccountId, profileId: input.providerProfileId }, work),
    getClusterNode: async () => ({ id: "node" }), clusterV2Database: async () => ({}), projectClusterIds: () => ["cluster"],
    resolveClusterSubscriptionPools: () => selection === "cluster" ? [{ poolId: "pool", poolOwnerNodeId: "node", clusterId: "cluster", manifest: pool }] : [],
    resolveSubscriptionChoice: (accountId: string) => { lookups.push(accountId); return selection === "conversation" ? { kind: "pool", pool } : undefined; },
    poolCandidates: () => profiles,
    getAutoRespond: async () => undefined, getConversationGoal: async () => { goalReads++; return undefined; },
    findHarnessSession: () => shared, harnessTurnBusy: () => false, harnessSessionBusy: () => false,
    getSettings: () => ({ autoCompactThreshold: 70 }), markHarnessInput: () => {},
    compactHarnessSession: async (_shared: unknown, compact: () => Promise<void>) => compact(),
    sendHarnessStatus: () => { statuses.push(shared.turnInFlight > 0); }, broadcastToProject: () => {},
    listQueuedPrompts: () => { queueReads++; return queue; }, claimQueuedPrompt: () => queue.shift(),
    getProjectLock: async () => undefined, conversationBelongsToDoneTask: async () => false,
    requireLocalConversationOwner: async () => {}, listConversationSegments: async () => [],
    send: (_socket: unknown, event: unknown) => { events.push(event); }, chatErrorMessage: (error: Error) => error.message,
  };
  const exports: any = {};
  vm.runInThisContext(`(function(require, exports) { ${compiled}\nexports.drainLoop = drainLoop;\nexports.controls = controls;\n})`)(
    (name: string) => name.startsWith("node:") || name === "ws" ? require(name) : dependencies, exports);
  exports.harnessChatConnections.add(connection);
  return { exports, connection, shared, profiles, used, statuses, events, lookups, accounts, queue, restored: () => restored, queueReads: () => queueReads, goalReads: () => goalReads };
}

for (const selection of ["cluster", "conversation", "none"] as const) {
  test(`automatic compaction uses ${selection} subscription selection and reaches the queue`, async () => {
    const f = fixture(selection);
    await f.exports.drainLoop(f.connection);
    assert.deepEqual(f.used, selection === "none" ? ["single"] : ["first", "second"]);
    assert.equal(f.restored(), selection === "none" ? 0 : 1);
    if (selection === "conversation") assert.deepEqual(f.lookups, ["writer"]);
    assert.equal(f.shared.turnInFlight, 0);
    assert.equal(f.statuses.at(-1), false);
    assert.ok(f.queueReads() > 0, "compaction must not strand queued messages");
    assert.equal(poolProfileContext(), undefined);
  });
}

test("failed automatic compaction reports its error, publishes idle, and continues draining", async () => {
  const f = fixture("none", new Error("Summarization failed"));
  await f.exports.drainLoop(f.connection);
  assert.equal(f.shared.turnInFlight, 0);
  assert.equal(f.statuses.at(-1), false);
  assert.ok(f.events.some(event => event.type === "error" && /Summarization failed/.test(event.error)));
  assert.ok(f.goalReads() > 0, "draining reaches goal/responder work after reporting the failure");
  await f.exports.drainLoop(f.connection);
  assert.deepEqual(f.used, ["single"], "failure is not automatically retried");
});

for (const identity of ["human", "automation-inherited", "automation-explicit"] as const) {
  test(`auto compaction honors the queued ${identity} identity instead of the draining viewer`, async () => {
    const f = fixture("conversation");
    const pending: any = { id: "interrupted", dispatchState: "starting", systemEventId: "completion", author: { accountId: "queued-writer" } };
    if (identity !== "human") pending.automationProfile = { accountId: "creator", profileId: identity === "automation-explicit" ? "pinned" : null, nodeId: "node" };
    // A starting internal event is retired without replay, after the idle-gap compaction.
    f.queue.push(pending);
    await f.exports.drainLoop(f.connection);
    const account = identity === "human" ? "queued-writer" : "creator";
    assert.deepEqual(f.accounts, identity === "automation-explicit" ? [account] : [account, account]);
    assert.deepEqual(f.used, identity === "automation-explicit" ? ["pinned"] : ["first", "second"]);
  });
}

test("ownership loss during compaction stops draining rather than starting a queued turn", async () => {
  const error = new ConversationOwnershipError({ engine: "claude", sessionId: "conversation", ownerNodeId: "other", epoch: 2, status: "owned", transferToNodeId: null });
  const f = fixture("none", error);
  await assert.rejects(f.exports.drainLoop(f.connection), error);
  assert.equal(f.goalReads(), 0);
  assert.equal(f.shared.turnInFlight, 0);
  assert.equal(f.statuses.at(-1), false);
});

for (const [engine, provider, memberProvider, incompatible] of [
  ["claude", "claude", "claude", "openai-codex"],
  ["pi", "anthropic", "claude", "openai-codex"],
  ["pi", "openai-codex", "openai-codex", "claude"],
]) {
  test(`${engine} compaction preserves ${provider} and skips incompatible pool members`, async () => {
    const f = fixture("conversation");
    f.connection.engine = engine;
    f.shared.engine = engine;
    f.shared.session.settings = () => ({ provider, modelId: "original-model", reasoning: "high" });
    f.profiles[0].provider = incompatible;
    f.profiles[1].provider = memberProvider;
    await f.exports.drainLoop(f.connection);
    assert.deepEqual(f.used, ["second"]);
    assert.equal(f.shared.session.settings().modelId, "original-model");
    assert.equal(f.shared.turnInFlight, 0);
  });
}

test("manual compaction uses the selected subscription pool too", async () => {
  const f = fixture("conversation");
  assert.equal(await f.exports.controls(f.connection, { type: "compact", message: "Keep the implementation plan" }), true);
  assert.deepEqual(f.used, ["first", "second"]);
  assert.equal(f.shared.turnInFlight, 0);
});
