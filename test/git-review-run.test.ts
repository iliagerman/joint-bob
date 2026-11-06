import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test, { type TestContext } from "node:test";
import ts from "typescript";
import type { HarnessEvent } from "../src/harnesses/runtime.js";
import type * as Review from "../src/server/git-review-run.js";

// Exercise the production runner without starting an authenticated model process.
const compiled = ts.transpileModule(readFileSync(new URL("../src/server/git-review-run.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function review(t: TestContext, extra: Partial<Review.RunGitReviewInput> = {}) {
  const toolSets: string[][] = [];
  const configuredTools: Array<string[] | undefined> = [];
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const listeners = new Set<(event: HarnessEvent) => void>();
  const emit = (event: HarnessEvent) => { for (const listener of [...listeners]) listener(event); };
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<void>();
  response.promise.catch(() => undefined);
  const cancellations: Array<string | undefined> = [];
  let busy = false;
  let disposed = false;
  const session = {
    settings: () => ({ provider: "claude", modelId: "fixture", reasoning: "default" }),
    status: () => ({ model: { provider: "claude", id: "fixture" }, thinkingLevel: "default" }),
    subscribe(listener: (event: HarnessEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    configure: async (settings: { enabledTools?: string[] }) => { configuredTools.push(settings.enabledTools); }, preflight: async () => {}, setTools: async (tools: string[]) => { toolSets.push(tools); },
    async prompt() {
      busy = true;
      emit({ type: "agent_start" });
      started.resolve();
      try { await response.promise; }
      finally { busy = false; emit({ type: "agent_end" }); }
    },
    async cancel(reason?: string) {
      cancellations.push(reason);
      // A harness may replace the supplied reason with its own cancellation error.
      response.reject(new Error("Joint Bob stopped Claude"));
    },
    isBusy: () => busy,
    dispose() { assert.equal(busy, false, "Stop the native turn before disposing it"); disposed = true; listeners.clear(); },
  };
  const dependencies: Record<string, unknown> = {
    "../internal-sessions.js": { internalSessionId: () => "review-fixture" },
    "../harnesses.js": {
      getHarness: () => ({ runtime: true }),
      getHarnessRuntime: async () => ({ open: async () => session, validateSettings: async () => {} }),
    },
    "../conversation-records.js": {}, "../secrets.js": {}, "../store.js": { getProject: async () => ({ type: "workspace" }) },
    "../account-context.js": { actingAccount: () => undefined, asNode: (work: () => unknown) => work() },
    "../provider-profiles/context.js": { automationProfileContext: () => undefined },
    "../provider-profiles/pool-execution.js": {},
    "./harness-chat.js": { resolveSubscriptionPool: async () => undefined },
    "../read-only-tools.js": { readOnlyChatTools: (harnessId: string) => [`read-only-${harnessId}`] },
  };
  const background = ts.transpileModule(readFileSync(new URL("../src/server/background-turn.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const preparation = {};
  vm.runInThisContext(`(function(require, exports) { ${background}\n})`)((name: string) => dependencies[name], preparation);
  dependencies["./background-turn.js"] = preparation;
  // Node's mock Timeout.refresh() is a no-op, so reschedule through its clock.
  const schedule = (callback: () => void, delay: number) => {
    const timer = {
      native: setTimeout(callback, delay),
      unref() { timer.native.unref(); return timer; },
      refresh() { clearTimeout(timer.native); timer.native = setTimeout(callback, delay); return timer; },
    };
    return timer;
  };
  const clear = (timer: ReturnType<typeof schedule> | undefined) => clearTimeout(timer?.native);
  const exports = {} as typeof Review;
  vm.runInThisContext(`(function(require, exports, setTimeout, clearTimeout) { ${compiled}\n})`)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports, schedule, clear);
  const partials: string[] = [];
  const result = exports.runGitReview({
    projectId: "fixture", cwd: "/fixture", harnessId: "claude", provider: "claude", modelId: "fixture", thinkingLevel: "default",
    selection: { scope: "worktree" }, diff: "+run();", question: "Explain the change", onText: (text) => partials.push(text), ...extra,
  });
  result.catch(() => undefined);
  t.after(async () => { response.reject(new Error("Fixture cleanup")); await result.catch(() => undefined); });
  await Promise.race([started.promise, result]);
  return { emit, result, partials, cancellations, toolSets, configuredTools, disposed: () => disposed, finish: response.resolve, fail: response.reject };
}

for (const event of [
  { type: "textDelta", text: "Still writing. " },
  { type: "thinkingDelta", text: "Checking the explanation. " },
  { type: "toolStart", toolCallId: "read", toolName: "Read" },
  { type: "toolUpdate", toolCallId: "read", text: "Reading source" },
  { type: "toolEnd", toolCallId: "read", text: "Source read" },
]) {
  test(`${event.type} progress keeps a review alive beyond five minutes`, async (t) => {
    const run = await review(t);
    for (let step = 0; step < 3; step++) {
      t.mock.timers.tick(4 * 60_000);
      run.emit(event);
    }
    run.emit({ type: "textDelta", text: "The app now runs." });
    run.finish();
    const result = await run.result;
    assert.equal(result.answer, event.type === "textDelta" ? "Still writing. ".repeat(3) + "The app now runs." : "The app now runs.");
    assert.deepEqual(run.cancellations, []);
    assert.equal(run.disposed(), true);
    t.mock.timers.tick(10 * 60_000);
    assert.deepEqual(run.cancellations, [], "No watchdog may fire after a successful turn");
  });
}

test("a silent review reports its stall timeout instead of the harness cancellation error", async (t) => {
  const run = await review(t);
  t.mock.timers.tick(5 * 60_000);
  await assert.rejects(run.result, { status: 504, message: /timed out.*without.*progress/i });
  assert.equal(run.cancellations.length, 1);
  assert.match(run.cancellations[0]!, /timed out/i);
  assert.equal(run.disposed(), true);
});

test("a review that stops making progress times out from its last output, not its start", async (t) => {
  const run = await review(t);
  t.mock.timers.tick(4 * 60_000);
  run.emit({ type: "textDelta", text: "Partial draft" });
  assert.deepEqual(run.partials, ["Partial draft"]);
  t.mock.timers.tick(4 * 60_000);
  assert.deepEqual(run.cancellations, []);
  t.mock.timers.tick(60_000);
  await assert.rejects(run.result, { status: 504, message: /timed out/i });
  assert.equal(run.cancellations.length, 1);
});

test("status notifications and empty deltas cannot keep a stalled review alive", async (t) => {
  const run = await review(t);
  t.mock.timers.tick(4 * 60_000);
  for (const event of [
    { type: "status", status: { isStreaming: true } },
    { type: "contextUsage", usage: { tokens: 10 } },
    { type: "textDelta", text: "" },
    { type: "thinkingDelta", text: "" },
    { type: "toolUpdate", text: "" },
  ]) run.emit(event);
  t.mock.timers.tick(60_000);
  await assert.rejects(run.result, { status: 504, message: /timed out/i });
});

test("a native prompt failure stays visible and leaves no running watchdog", async (t) => {
  const run = await review(t);
  run.fail(new Error("Provider unavailable"));
  await assert.rejects(run.result, { status: 502, message: "Provider unavailable" });
  t.mock.timers.tick(10 * 60_000);
  assert.deepEqual(run.cancellations, []);
  assert.equal(run.disposed(), true);
});

test("an error event is preserved even when the prompt resolves", async (t) => {
  const run = await review(t);
  run.emit({ type: "error", error: "Quota exceeded" });
  run.finish();
  await assert.rejects(run.result, { status: 502, message: "Quota exceeded" });
  t.mock.timers.tick(10 * 60_000);
  assert.deepEqual(run.cancellations, []);
});

test("a turn ending without an answer still fails", async (t) => {
  const run = await review(t);
  run.finish();
  await assert.rejects(run.result, { status: 502, message: "Review produced no explanation" });
});

test("a review is text-only by default", async (t) => {
  assert.deepEqual((await review(t)).toolSets, [[]]);
});

test("readOnlyTools gives a review the read-only tools instead, through its settings", async (t) => {
  const run = await review(t, { readOnlyTools: true });
  assert.deepEqual(run.configuredTools, [["read-only-claude"]]);
  // A fresh Claude session refuses setTools with names before it has reported its tools, so none is called.
  assert.deepEqual(run.toolSets, []);
});

test("useTools and readOnlyTools cannot be combined", async (t) => {
  await assert.rejects(review(t, { useTools: true, readOnlyTools: true }), /exclusive/);
});
