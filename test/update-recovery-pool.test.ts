import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { classifyPoolAttemptFailure, resolvePoolModelSettings, runPoolAttempts } from "../src/provider-profiles/pool-execution.js";
import { withPoolProfile } from "../src/provider-profiles/context.js";

const require = createRequire(import.meta.url);

/** Runs a production module with only its I/O boundaries replaced, as harness-attach-race does. */
function load(file: string, mocks: Record<string, any>): any {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports: any = {};
  vm.runInThisContext(`(function(require, exports) { ${compiled}\n})`)((name: string) => name.startsWith("node:") ? require(name)
    : new Proxy(mocks, { get(target, key: string) { if (key in target) return target[key]; throw new Error(`Unexpected boundary ${name}:${key}`); } }), exports);
  return exports;
}

const pool = {
  id: "pool", name: "sela-pool", fallbackModels: {}, sameProviderOnly: true,
  candidates: [
    { profileId: "first", provider: "claude" as const, label: "claude - sela", poolId: "pool" },
    { profileId: "second", provider: "claude" as const, label: "claude - illiag2", poolId: "pool" },
  ],
};

// 2026-11-05: a deploy interrupted a turn; its recovery ran on this machine's own sign-in, hit the
// 5-hour limit and never tried the project's pool, and the reply named no profile.
test("update recovery resumes as the turn's account, on that account's pool, naming each member", async () => {
  const shared: any = { engine: "claude", projectId: "project", conversationId: "conversation", turnInFlight: 0, clients: new Set(),
    session: { id: "session", settings: () => ({ provider: "claude", modelId: "sonnet", reasoning: "medium" }), configure: async () => {},
      preflight: async () => assert.fail("a pool attempt runs preflight as its member"), prompt: async () => assert.fail("a pool turn runs through the pool") } };
  const record = { id: "recovery", kind: "chat", engine: "claude", projectId: "project", cwd: "/synthetic", sessionId: "session", sessionPath: "claude:/synthetic/session.jsonl",
    taskId: null, phase: null, queuedPrompts: ["queued while it ran"], model: "sonnet", effort: "medium", settings: { provider: "claude", modelId: "sonnet", reasoning: "medium" },
    accountId: "member", createdAt: "2026-11-04T23:03:13.944Z" };
  let actor: any;
  const poolLookups: any[] = [], prompts: string[] = [], announced: any[] = [], completed: string[] = [];
  const exports = load("server/task-runs.ts", {
    getClusterNode: async () => ({ id: "local" }), claimConversationLocally: async () => {},
    getConversationRecord: async () => ({ conversationId: "conversation" }), getProject: async () => ({ id: "project", type: "personal" }),
    openHarnessSession: async () => shared, broadcastToProject: () => {}, sendHarnessStatus: () => {},
    harnessChatConnections: new Set(), drainHarnessPromptQueue: async () => {},
    resourceOwner: () => "project-owner", ownerAsActor: (accountId: string) => ({ accountId }),
    runAsAccount: async (account: any, work: () => Promise<void>) => { actor = account; try { await work(); } finally { actor = undefined; } },
    getHarnessRuntime: async () => ({ validateSettings: async () => {} }),
    resolveRecoverySubscriptionPool: async (_shared: unknown, workspaceId: string) => { poolLookups.push({ account: actor?.accountId, workspaceId }); return pool; },
    resolvePoolModelSettings,
    promptOnSubscriptionPool: async (_session: unknown, chosen: typeof pool, _initial: unknown, _settingsFor: unknown, input: { text: string }, announce: (candidate: any) => void) => {
      assert.equal(actor?.accountId, "member", "each prompt runs as the turn's account");
      announce(chosen.candidates[0]);
      prompts.push(input.text);
    },
    announceSharedConnection: (_shared: unknown, view: unknown) => announced.push(view),
    announceRecoveryConnection: async () => assert.fail("a pool turn names its members, not a single profile"),
    listPendingUpdateRecoveries: async () => [record], completeUpdateRecovery: async (id: string) => { completed.push(id); },
    failUpdateRecovery: async (_id: string, error: string) => assert.fail(error),
    requireLocalConversationOwner: async () => {}, flags: {}, updateContinuationPrompt: "A service update interrupted this turn.",
  });

  await exports.recoverPendingUpdateRuns();

  assert.deepEqual(poolLookups, [{ account: "member", workspaceId: "personal" }]);
  assert.deepEqual(prompts, ["A service update interrupted this turn.", "queued while it ran"]);
  assert.deepEqual(announced[0], { pool: { name: "sela-pool" }, profile: { label: "claude - sela" } });
  assert.deepEqual(completed, ["recovery"]);
  assert.equal(shared.turnInFlight, 0);
  assert.equal(shared.turnAccountId, null, "the account is forgotten once the recovery ends");
});

test("a pool member that hits its limit mid-turn hands the turn to the next, which continues it", async () => {
  const listeners = new Set<(event: any) => void>();
  const prompts: Array<{ text: string; profile: string | undefined }> = [];
  let checkpoints = 0, restores = 0;
  const session: any = {
    subscribe: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    configure: async () => {}, preflight: async () => {},
    checkpointPoolAttempt: async () => { checkpoints += 1; return {}; },
    restorePoolAttempt: async () => { restores += 1; },
    prompt: async ({ text }: { text: string }) => {
      const { poolProfileContext } = await import("../src/provider-profiles/context.js");
      prompts.push({ text, profile: poolProfileContext()?.profileId });
      if (prompts.length > 1) return;
      // The turn already did work on the first account before its next request was refused.
      for (const listener of listeners) listener({ type: "toolStart" });
      throw Object.assign(new Error("You've hit your 5-hour limit · resets 3:10am (Asia/Jerusalem)"), { status: 429, code: "rate_limit" });
    },
  };
  const mocks = new Proxy({ runPoolAttempts, classifyPoolAttemptFailure, withPoolProfile, resolvePoolModelSettings } as Record<string, any>, {
    // Module setup registers listeners and reads settings; none of it is under test here.
    get: (target, key: string) => key in target ? target[key] : (key === "flags" ? {} : () => () => {}),
    has: () => true,
  });
  const exports = load("server/harness-chat.ts", mocks);
  const announced: string[] = [];

  const initial = { provider: "claude", modelId: "sonnet", reasoning: "medium" };
  await exports.promptOnSubscriptionPool(session, pool, initial, () => initial, { text: "fix the tests" }, (candidate: { label: string }) => announced.push(candidate.label));

  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[0], { text: "fix the tests", profile: "first" });
  assert.equal(prompts[1].profile, "second");
  assert.match(prompts[1].text, /moved to another account in the pool\. Continue from where it stopped/, "the next member continues; the prompt is not replayed");
  assert.deepEqual(announced, ["claude - sela", "claude - illiag2"]);
  assert.equal(restores, 0, "the first member's work is kept");
  assert.equal(checkpoints, 2);
});
