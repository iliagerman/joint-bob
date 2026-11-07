import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { getClusterNode } from "../src/cluster.js";
import { createProviderProfile } from "../src/provider-profiles/store.js";
import { automationProfileContext, runWithAutomationProfile } from "../src/server/automation-profile.js";

const require = createRequire(import.meta.url);
function load(file: string, dependency: Record<string, any>, extra = ""): any {
  const compiled = ts.transpileModule(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports: any = {};
  vm.runInThisContext(`(function(require, exports) { ${compiled}\n${extra}\n})`)((name: string) => name.startsWith("node:") || name === "zod" ? require(name) : dependency, exports);
  return exports;
}

function fixture(resume: boolean) {
  const queued: any[] = [], routes = new Map<string, (...args: any[]) => Promise<void>>();
  const accountId = "assistant-owner", message = "Check my calendar", requestId = randomUUID();
  const executionSettings = { harnessId: "claude", provider: "claude", modelId: "opus", reasoning: "high" };
  const entry = { id: "assistant", accountId, projectId: "project", nodeId: "node", engine: "claude", sessionId: "source", classifierId: "typesafe", executionSettings };
  const session = { accountId, username: "Owner", email: null, homeNodeId: null, userId: "user", role: "admin" };
  const project = { id: "project", path: "/synthetic" };
  let turn: any;
  const dependency: Record<string, any> = {
    app: { get: () => {}, post: (route: string, handler: any) => routes.set(route, handler), put: () => {}, delete: () => {} },
    registerTwinAssistantRoutes: () => {}, announceAssistantChanges: () => {},
    getClusterNode: async () => ({ id: "node" }), getPersonalAssistant: async () => entry, projectVisible: async () => true,
    listLocalUsers: () => [session], getProject: async () => project,
    getPersonalAssistantSourceHistory: async () => [], listPersonalAssistantTurns: async () => [],
    listPersonalAssistantTopics: async () => resume ? [{ engine: "claude", sessionId: "existing" }] : [],
    sharedProjectSessions: async () => resume ? [{ harnessId: "claude", id: "existing", path: "claude:/existing", title: "Existing" }] : [],
    getHarness: () => ({ sessions: { loadMessages: async () => [{ id: "u", role: "user", text: message }, { id: "a", role: "assistant", text: "Calendar checked" }] } }),
    isHarnessId: (engine: string) => ["claude", "pi", "kiro"].includes(engine), genericSecretEnvironment: () => ({}),
    routeAssistantMessage: async () => resume ? { kind: "continue", topicId: "claude:existing" } : { kind: "new" },
    ensureConversationRecord: async () => {}, ensureSessionTitle: async () => {}, addPersonalAssistantTopic: async () => {},
    conversationScopeId: (engine: string, id: string) => `${engine}:${id}`, getScopeSecretAccounts: async () => ({ accountIds: [] }), syncAssistantLoginGrants: async () => {},
    getConversationOwnership: async () => ({ ownerNodeId: "node" }),
    beginPersonalAssistantTurn: async (_account: string, _id: string, id: string, topicId: string, text: string) => { turn = { requestId: id, topicId, message: text, status: "running" }; return { created: true }; },
    getPersonalAssistantTurn: async () => turn,
    queueConversationPrompt: async (options: any) => { queued.push(options); options.onStarted?.(); },
    getConversationRecord: async () => undefined, listConversationSegments: async () => [],
    listHarnessSessions: async () => [{ harnessId: "claude", id: queued[0].sessionId, path: "claude:/result" }],
    finishPersonalAssistantTurn: async (_account: string, _id: string, _request: string, response: string, failed: boolean) => { turn = { ...turn, response, status: failed ? "failed" : "completed" }; },
    sendError: (_response: unknown, code: number, error: string) => { throw new Error(`${code}: ${error}`); },
  };
  const exports = load("server/routes/personal-assistants.ts", dependency);
  return { exports, dependency, routes, entry, session, executionSettings, queued, accountId, message, requestId };
}

for (const resume of [false, true]) {
  test(`interactive assistant ${resume ? "resumes" : "starts"} a topic under its signed-in author and configured model`, async () => {
    const f = fixture(resume);
    let result: any;
    const response = { locals: { authSession: f.session }, status: () => response, json: (body: unknown) => { result = body; } };
    await f.routes.get("/api/personal-assistants/:id/turn")!({ params: { id: "assistant" }, body: { requestId: f.requestId, message: f.message, recentMessages: [] } }, response, (error: unknown) => { throw error; });
    assert.equal(result.turn.status, "completed");
    assert.deepEqual(f.queued[0].author, { accountId: "assistant-owner", username: "Owner", email: null, homeNodeId: null });
    assert.equal(f.queued[0].automationProfile, undefined, "interactive turns resolve the author's own configured profile or pool");
    assert.deepEqual(f.queued[0].queueSettings(), f.executionSettings);
    assert.equal(f.queued[0].sessionId === "existing", resume);
  });
  test(`assistant-to-assistant call ${resume ? "resumes" : "starts"} using the helper owner's subscription`, async () => {
    const f = fixture(resume);
    const result = await f.exports.runPersonalAssistantAutomationTurn(f.accountId, "assistant", f.requestId, f.message, { origin: "assistant", label: "Assistant" });
    assert.equal(result.status, "completed");
    assert.equal(f.queued.length, 1);
    assert.equal(f.queued[0].author.accountId, f.accountId);
    assert.equal(f.queued[0].automationProfile, undefined, "no caller's pinned profile leaks into the helper's conversation");
    assert.deepEqual(f.queued[0].queueSettings(), f.executionSettings);
  });
  for (const origin of ["scheduled", "webhook", "assistant", "chat"] as const) for (const pinned of [false, true]) {
    test(`${origin} assistant ${resume ? "resumes" : "starts"} with ${pinned ? "pinned" : "inherited"} subscription identity intact`, async () => {
      const f = fixture(resume);
      const assignment = { accountId: "automation-creator", profileId: pinned ? "pinned-profile" : null };
      const result = await f.exports.runPersonalAssistantAutomationTurn(f.accountId, "assistant", f.requestId, f.message, { origin, label: origin, automationProfile: assignment });
      assert.equal(result.status, "completed");
      assert.equal(f.queued.length, 1);
      assert.deepEqual(f.queued[0].automationProfile, assignment);
      assert.deepEqual(f.queued[0].queueSettings(), f.executionSettings);
      assert.equal(f.queued[0].author.accountId, f.accountId);
      assert.equal(f.queued[0].until, "completed");
    });
  }
}

for (const source of ["scheduled", "webhook", "telegram-owner", "telegram-group"] as const) for (const pinned of [false, true]) {
  test(`${source} executor carries its ${pinned ? "pinned" : "inherited"} subscription through assistant routing`, async () => {
    const f = fixture(false), completed: string[] = [];
    await getClusterNode();
    const providerProfileId = pinned ? createProviderProfile(f.accountId, { label: "Automation", provider: "claude" }).id : null;
    Object.assign(f.dependency, {
      runWithAutomationProfile, automationProfileContext,
      runPersonalAssistantAutomationTurn: f.exports.runPersonalAssistantAutomationTurn,
      clusterV2Database: async () => ({}), getProjectLock: async () => undefined,
      cronStore: () => ({ target: () => {}, started: () => {}, finish: (_id: string, status: string) => completed.push(status) }),
      scheduledPromptText: (text: string) => text, markCronConversation: async () => {},
      transitionAutomationExecution: () => {}, routingScopeTopicIds: async () => new Set(), addRoutingScopeTopic: async () => {},
      snapshotWebhookResources: () => ({ ownerNodeId: "node", webhookId: "hook" }),
      resolveWebhookResources: async () => ({ files: [], tools: [], skills: [] }), webhookResourceInstructions: () => "",
      persistTaskAttachments: async () => [], automationTitleInstruction: () => "", webhookMessage: () => f.message,
      telegramChatId: () => null, telegramText: () => null,
      bindWebhookConversation: () => {}, setWebhookConversationHistory: () => {}, recordWebhookDelivery: () => {},
    });
    if (source === "scheduled") {
      const cron = load("server/cron.ts", f.dependency, "exports.executeCronRun = executeCronRun;");
      await cron.executeCronRun({ id: "schedule", creatorAccountId: f.accountId, providerProfileId, assistantId: f.entry.id, projectId: "project", ownerNodeId: "node", prompt: f.message }, { id: f.requestId });
      assert.deepEqual(completed, ["succeeded"]);
    } else {
      const webhook = load("server/webhooks.ts", f.dependency, "exports.deliver = deliver;");
      const telegram = source.startsWith("telegram") ? { message: f.message, routing: { scope: source === "telegram-owner" ? null : "telegram:hook:group", message: f.message }, answer: async () => completed.push("answered") } : undefined;
      await webhook.deliver({ id: "hook", creatorAccountId: f.accountId, providerProfileId, target: { kind: "assistant", projectId: "project", assistantId: f.entry.id }, secretAccountIds: [] }, { requestId: f.requestId, body: f.message, telegram });
      if (telegram) assert.deepEqual(completed, ["answered"]);
    }
    assert.equal(f.queued.length, 1);
    assert.deepEqual(f.queued[0].automationProfile, { accountId: f.accountId, profileId: providerProfileId });
    assert.deepEqual(f.queued[0].queueSettings(), f.executionSettings);
  });
}

test("assistant queue failure is surfaced without retrying under a different identity", async () => {
  const f = fixture(false);
  let attempts = 0;
  f.dependency.queueConversationPrompt = async () => { attempts++; throw new Error("Selected profile is signed out"); };
  await assert.rejects(f.exports.runPersonalAssistantAutomationTurn(f.accountId, "assistant", f.requestId, f.message, { origin: "scheduled", label: "Scheduled", automationProfile: { accountId: f.accountId, profileId: "pinned" } }), /Selected profile is signed out/);
  assert.equal(attempts, 1);
});
