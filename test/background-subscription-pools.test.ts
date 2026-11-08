import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { classifyPoolAttemptFailure, resolvePoolModelSettings, runPoolAttempts } from "../src/provider-profiles/pool-execution.js";
import { automationProfileContext, poolProfileContext, withAutomationProfile, withPoolProfile } from "../src/provider-profiles/context.js";

const require = createRequire(import.meta.url);
function load(file: string, dependencies: Record<string, any>, extra = ""): any {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports: any = {};
  vm.runInThisContext(`(function(require, exports) { ${compiled}\n${extra}\n})`)((name: string) => name.startsWith("node:") ? require(name) : dependencies, exports);
  return exports;
}

const runners = ["review", "chat", "responder", "sync", "guardian"] as const;
for (const runner of runners) for (const source of ["cluster", "conversation", "none", "cross-provider", "exhausted", "generic-failure", "mid-turn"] as const) {
  test(`${runner} uses ${source} subscription selection, preserves tools and survives a failed pool member`, async () => {
    const used: string[] = [], prompts: string[] = [], opened: any[] = [], lookups: any[] = [], tools: string[][] = [];
    const listeners = new Set<(event: any) => void>();
    const emit = (event: any) => { for (const listener of [...listeners]) listener(event); };
    let disposed = false, restored = 0;
    let settings: any = { provider: "claude", modelId: "sonnet", reasoning: "medium" };
    const profiles = ["first", "second"].map(id => ({ id, profileId: id, provider: "claude", label: id }));
    if (source === "cross-provider") profiles[1].provider = "openai-codex";
    const pool = { id: "pool", name: "shared", fallbackModels: { "openai-codex": "gpt-fixture" }, members: profiles };
    const session = {
      id: "internal", file: "/synthetic/side.jsonl", messages: [],
      settings: () => settings, status: () => ({ model: { provider: settings.provider, id: settings.modelId } }),
      tools: () => [{ name: "Read", active: true }, { name: "Bash", active: true }],
      setTools: async (names: string[]) => { settings = { ...settings, enabledTools: names }; },
      configure: async (next: any) => { settings = next; },
      subscribe: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      preflight: async () => {
        if (source !== "none" && !poolProfileContext()) throw new Error("Selected subscription pool requires pool-aware execution");
      },
      checkpointPoolAttempt: async () => ({}), restorePoolAttempt: async () => { restored++; },
      prompt: async (input: any) => {
        await session.preflight();
        await input.beforeStart?.();
        const member = poolProfileContext()?.profileId ?? "single";
        used.push(member);
        prompts.push(input.text);
        tools.push(settings.enabledTools);
        emit({ type: "agent_start" });
        if (member === "first" || source === "exhausted") {
          if (source === "mid-turn") emit({ type: "textDelta", text: "Partial work" });
          const error = source === "generic-failure" ? "Invalid request" : "rate_limit";
          emit({ type: "error", error });
          emit({ type: "agent_end" });
          throw new Error(error);
        }
        emit({ type: "textDelta", text: "Completed answer" });
        emit({ type: "agent_end" });
      },
      isBusy: () => false, cancel: async () => {}, dispose: () => { disposed = true; listeners.clear(); },
    };
    const boundaries = new Proxy({
      runPoolAttempts, classifyPoolAttemptFailure, withPoolProfile, resolvePoolModelSettings,
      getClusterNode: async () => ({ id: "node" }), clusterV2Database: async () => ({}), projectClusterIds: () => ["cluster"],
      resolveClusterSubscriptionPools: () => source !== "conversation" && source !== "none" ? [{ poolId: "pool", poolOwnerNodeId: "node", clusterId: "cluster", manifest: pool }] : [],
      resolveSubscriptionChoice: (account: string, provider: string, scope: any, usage: string) => {
        lookups.push({ account, provider, scope, usage });
        return source === "conversation" ? { kind: "pool", pool } : undefined;
      },
      poolCandidates: () => profiles,
    } as Record<string, any>, { get: (target, key: string) => key in target ? target[key] : key === "flags" ? {} : () => () => {} });
    const poolRunner = load("server/harness-chat.ts", boundaries);
    const dependencies: Record<string, any> = {
      internalSessionId: () => "internal", getHarness: () => ({ runtime: true }),
      getHarnessRuntime: async () => ({ open: async (options: any) => { opened.push(options); return session; }, validateSettings: async () => {} }),
      getProject: async () => ({ id: "project", type: "workspace" }), asNode: (work: () => any) => work(),
      actingAccount: () => source === "cluster" ? undefined : ({ accountId: "owner" }), automationProfileContext, withAutomationProfile,
      validateAutoRespondProfile: () => {},
      withSystemAiProfile: (_harness: string, _provider: string, work: () => unknown) => work(),
      resolveSubscriptionPool: poolRunner.resolveSubscriptionPool, promptOnSubscriptionPool: poolRunner.promptOnSubscriptionPool,
      resolvePoolModelSettings,
      conversationScopeId: () => "side", setScopeSecretAccounts: async () => {},
      readOnlyChatTools: () => ["Read"], chatModelSchema: { parse: (model: any) => model },
    };
    Object.assign(dependencies, load("server/background-turn.ts", dependencies));
    const model = { harnessId: source === "cross-provider" ? "pi" : "claude", provider: "claude", modelId: "sonnet", thinkingLevel: "medium" };
    const common = { projectId: "project", conversationId: "conversation", cwd: "/synthetic" };
    const run = async () => {
    let result;
    if (runner === "review") result = (await load("server/git-review-run.ts", dependencies).runGitReview({ ...common, ...model, selection: { scope: "context" }, diff: "input", question: "Explain" })).answer;
    if (runner === "chat") result = (await load("server/conversation-chat-agent.ts", dependencies).runChatAgent({ ...common, model, readOnly: true, accountIds: [], prompt: "Explain", onText: () => {}, onAgent: () => {}, beforeStart: async () => {} })).answer;
    if (runner === "responder") result = await load("server/auto-respond-run.ts", dependencies).runAutoResponder({ ...common, config: { ...model, useTools: false }, creatorAccountId: "creator", prompt: "Check", signal: new AbortController().signal, onStep: () => {} });
    if (runner === "sync") await load("server/sync-check.ts", dependencies, "exports.runAgentResolver = runAgentResolver;").runAgentResolver({ ...common, settings: model, prompt: "Merge" });
    if (runner === "guardian") result = (await load("guardian/fix.ts", dependencies).runGuardianFix({ kind: "agent", instructions: "Fix" }, { kind: "outgoing", text: "input" }, { ...common, harness: model.harnessId, secrets: [] })).text;
    return result;
    };
    if (source === "exhausted" || source === "generic-failure") {
      await assert.rejects(run(), source === "exhausted" ? /rate_limit/ : /Invalid request/);
    } else {
      const result = await run();
      if (runner !== "sync") assert.equal(result, "Completed answer");
    }
    assert.deepEqual(used, source === "none" ? ["single"] : source === "generic-failure" ? ["first"] : ["first", "second"]);
    assert.equal(restored, ["none", "generic-failure", "mid-turn"].includes(source) ? 0 : 1);
    if (source === "mid-turn") assert.match(prompts[1], /Continue from where it stopped; do not repeat completed side effects/);
    if (source === "cross-provider") assert.equal(settings.modelId, "gpt-fixture");
    if (runner !== "sync") assert.deepEqual(tools, used.map(() => runner === "chat" ? ["Read"] : []), "pool configuration must not re-enable tools");
    if (source === "conversation") {
      assert.equal(lookups[0].account, runner === "responder" ? "creator" : "owner");
      assert.equal(lookups[0].usage, runner === "responder" ? "automation" : "interactive");
      if (["review", "chat", "responder"].includes(runner)) assert.equal(lookups[0].scope.conversationId, "conversation");
    }
    if (runner === "review") {
      assert.equal(opened[0].conversationId, "conversation", "text-only writers retain the source subscription scope");
      assert.equal(opened[0].accountIds, undefined, "subscription scope does not grant source secrets");
    }
    assert.equal(disposed, true);
    assert.equal(poolProfileContext(), undefined);
    assert.equal(listeners.size, 0);
  });
}
