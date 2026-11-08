import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { classifyPoolAttemptFailure, resolvePoolModelSettings, runPoolAttempts } from "../src/provider-profiles/pool-execution.js";
import { poolProfileContext, withPoolProfile } from "../src/provider-profiles/context.js";

const require = createRequire(import.meta.url);
function load(file: string, mocks: Record<string, any>): any {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports: any = {};
  vm.runInThisContext(`(function(require, exports) { ${compiled}\n})`)((name: string) => name.startsWith("node:") ? require(name) : mocks, exports);
  return exports;
}

test("automations without an explicit profile resolve the creator's inherited pool", async () => {
  const requests: any[] = [];
  const pool = { id: "pool", name: "inherited", fallbackModels: {} };
  const boundaries = new Proxy({
    getClusterNode: async () => ({ id: "node" }), clusterV2Database: async () => ({}),
    projectClusterIds: () => ["cluster"], resolveClusterSubscriptionPools: () => [],
    resolveSubscriptionChoice: (account: string, provider: string, scope: any, usage: string) => {
      requests.push({ account, provider, scope, usage });
      return { kind: "pool", pool };
    },
    poolCandidates: () => [{ id: "member", provider: "claude", label: "member" }],
  } as Record<string, any>, { get: (target, key: string) => key in target ? target[key] : key === "flags" ? {} : () => () => {} });
  const { resolveSubscriptionPool } = load("server/harness-chat.ts", boundaries);
  const request = { engine: "claude", provider: "claude", projectId: "project", workspaceId: "workspace", conversationId: "conversation", accountId: "creator", usage: "automation", fixedProfile: false };
  assert.equal((await resolveSubscriptionPool(request)).id, "pool");
  assert.deepEqual(requests, [{ account: "creator", provider: "claude", scope: { projectId: "project", workspaceId: "workspace", conversationId: "conversation", clusterIds: ["cluster"] }, usage: "automation" }]);
  assert.equal(await resolveSubscriptionPool({ ...request, fixedProfile: true }), undefined);
  assert.equal(requests.length, 1, "an explicit automation profile is not replaced by a personal pool");
});

for (const scope of ["project", "workspace", "cluster", "none"] as const) {
  test(`dashboard inherits ${scope} subscription choice and completes through quota failover`, async () => {
    const profiles = ["first", "second"].map((id) => ({ id, profileId: id, provider: "claude", label: id }));
    const pool = { id: "pool", name: "shared pool", fallbackModels: {}, members: profiles };
    const lookups: any[] = [], used: string[] = [];
    const listeners = new Set<(event: any) => void>();
    const emit = (event: any) => { for (const listener of listeners) listener(event); };
    let disposed = false;
    const settings = { provider: "claude", modelId: "sonnet", reasoning: "medium" };
    const session = {
      settings: () => settings, configure: async () => {},
      subscribe: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      preflight: async () => {
        if (scope !== "none" && !poolProfileContext()) throw new Error("Selected subscription pool requires pool-aware execution");
      },
      checkpointPoolAttempt: async () => ({}), restorePoolAttempt: async () => {},
      prompt: async () => {
        const member = poolProfileContext()?.profileId ?? "single";
        used.push(member);
        emit({ type: "agent_start" });
        if (member === "first") {
          emit({ type: "error", error: "rate_limit" });
          emit({ type: "agent_end" });
          throw Object.assign(new Error("rate_limit"), { status: 429 });
        }
        emit({ type: "textDelta", text: "Dashboard ready" });
        emit({ type: "agent_end" });
      },
      isBusy: () => false, cancel: async () => {}, dispose: () => { disposed = true; },
    };
    const boundaries = new Proxy({
      runPoolAttempts, classifyPoolAttemptFailure, withPoolProfile, resolvePoolModelSettings,
      getClusterNode: async () => ({ id: "node" }), clusterV2Database: async () => ({}),
      projectClusterIds: () => ["cluster"],
      resolveClusterSubscriptionPools: () => scope === "cluster" ? [{ poolId: "pool", poolOwnerNodeId: "node", clusterId: "cluster", manifest: pool }] : [],
      resolveSubscriptionChoice: (_account: string, _provider: string, requestedScope: any) => {
        assert.equal(_account, "owner");
        lookups.push(requestedScope);
        return scope === "none" ? undefined : { kind: "pool", pool };
      },
      poolCandidates: () => profiles,
    } as Record<string, any>, { get: (target, key: string) => key in target ? target[key] : key === "flags" ? {} : () => () => {} });
    const chat = load("server/harness-chat.ts", boundaries);
    const agent = load("dashboards/agent-turn.ts", {
      internalSessionId: () => "internal", getHarness: () => ({ runtime: true }),
      getHarnessRuntime: async () => ({ open: async () => session, validateSettings: async () => {} }),
      actingAccount: () => ({ accountId: "owner" }), automationProfileContext: () => undefined,
      withSystemAiProfile: (_harness: string, _provider: string, work: () => unknown) => work(),
      getProject: async () => ({ id: "project", type: "workspace" }),
      resolveSubscriptionPool: chat.resolveSubscriptionPool, promptOnSubscriptionPool: chat.promptOnSubscriptionPool,
      resolvePoolModelSettings,
    });
    const result = await agent.runDashboardAgentTurn({ projectId: "project", cwd: "/synthetic", settings: { harnessId: "claude", ...settings, thinkingLevel: "medium" }, prompt: "Build dashboard", timeoutMs: 1000 });
    assert.equal(result, "Dashboard ready");
    assert.deepEqual(used, scope === "none" ? ["single"] : ["first", "second"]);
    if (scope === "project" || scope === "workspace") assert.deepEqual(lookups[0], { projectId: "project", workspaceId: "workspace", conversationId: "internal", clusterIds: ["cluster"] });
    assert.equal(disposed, true);
    assert.equal(listeners.size, 0);
  });
}
