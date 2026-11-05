import assert from "node:assert/strict";
import test from "node:test";
import { orderPoolCandidates, PoolAttemptFailure, resolvePoolModelSettings, runPoolAttempts } from "../src/provider-profiles/pool-execution.js";

const candidates = [
  { id: "a", provider: "claude" as const },
  { id: "b", provider: "openai-codex" as const },
  { id: "c", provider: "claude" as const },
];

test("pool ordering prefers the current provider and keeps order within each provider", () => {
  assert.deepEqual(orderPoolCandidates(candidates, "openai-codex").map(({ id }) => id), ["b", "a", "c"]);
  assert.deepEqual(orderPoolCandidates(candidates, "claude", true).map(({ id }) => id), ["a", "c"]);
  assert.deepEqual(orderPoolCandidates(candidates).map(({ id }) => id), ["a", "b", "c"]);
});

test("recognized pre-output subscription failures restore state and try each candidate once", async () => {
  const attempted: string[] = [];
  let restores = 0;
  const result = await runPoolAttempts(candidates, "claude", async (candidate) => {
    attempted.push(candidate.id);
    if (candidate.provider !== "claude") return candidate.id;
    throw new PoolAttemptFailure("quota", false, "subscription quota exhausted");
  }, async () => async () => { restores += 1; });
  assert.equal(result, "b");
  assert.deepEqual(attempted, ["a", "c", "b"]);
  assert.equal(restores, 2);
});

test("generic failures and an unusable member after output never retry", async () => {
  for (const failure of [new Error("provider connection reset"), new PoolAttemptFailure("unavailable", true, "unavailable after output"),
    new PoolAttemptFailure("other", false, "unrecognized")]) {
    const attempted: string[] = [];
    await assert.rejects(runPoolAttempts(candidates, "claude", async (candidate) => {
      attempted.push(candidate.id);
      throw failure;
    }, async () => async () => assert.fail("must not restore without a retry")));
    assert.deepEqual(attempted, ["a"]);
  }
});

test("a member that runs out of quota mid-turn hands the turn on, keeping its work, and the next continues it", async () => {
  const transcript = ["prior turn"];
  const attempts: Array<{ id: string; continuing: boolean }> = [];
  let checkpoints = 0;
  const result = await runPoolAttempts(candidates, "claude", async (candidate, continuing) => {
    attempts.push({ id: candidate.id, continuing });
    if (candidate.id === "a") {
      transcript.push("user:prompt", "tool:edited a file");
      throw new PoolAttemptFailure("quota", true, "You've hit your 5-hour limit");
    }
    transcript.push("user:continue", "assistant:done");
    return candidate.id;
  }, async () => {
    checkpoints += 1;
    const saved = [...transcript];
    return async () => { transcript.splice(0, transcript.length, ...saved); };
  });
  assert.equal(result, "c");
  assert.deepEqual(attempts, [{ id: "a", continuing: false }, { id: "c", continuing: true }]);
  assert.deepEqual(transcript, ["prior turn", "user:prompt", "tool:edited a file", "user:continue", "assistant:done"], "the prompt is never replayed");
  assert.equal(checkpoints, 2, "a new checkpoint after the handover, so a later rollback keeps the first member's work");
});

test("after a mid-turn handover, a member that fails before starting rolls back only to the handover", async () => {
  const members = [{ id: "a", provider: "claude" as const }, { id: "b", provider: "claude" as const }, { id: "c", provider: "claude" as const }];
  const transcript: string[] = [];
  const result = await runPoolAttempts(members, "claude", async (candidate, continuing) => {
    if (candidate.id === "a") { transcript.push("a:work"); throw new PoolAttemptFailure("auth", true, "token expired"); }
    if (candidate.id === "b") { transcript.push("b:refused"); throw new PoolAttemptFailure("quota", false, "429"); }
    assert.equal(continuing, true);
    transcript.push("c:continued");
    return candidate.id;
  }, async () => { const saved = [...transcript]; return async () => { transcript.splice(0, transcript.length, ...saved); }; });
  assert.equal(result, "c");
  assert.deepEqual(transcript, ["a:work", "c:continued"]);
});

test("credential failures can advance, while exhausted attempts leave the final failure intact", async () => {
  const attempted: string[] = [];
  let restores = 0;
  await assert.rejects(runPoolAttempts(candidates, "claude", async (candidate) => {
    attempted.push(candidate.id);
    throw new PoolAttemptFailure("unavailable", false, `source unavailable: ${candidate.id}`);
  }, async () => async () => { restores += 1; }), /source unavailable: b/);
  assert.deepEqual(attempted, ["a", "c", "b"]);
  assert.equal(restores, 2, "restore only between attempts, not after the final failure");
});

test("restoring a failed attempt keeps exactly one user message and the successful reply", async () => {
  const transcript = ["prior turn"];
  const checkpoint = [...transcript];
  await runPoolAttempts(candidates, "claude", async (candidate) => {
    transcript.push(`user:${candidate.id}`);
    if (candidate.provider === "claude") throw new PoolAttemptFailure("quota", false, "quota before output");
    transcript.push("assistant:success");
    return undefined;
  }, async () => async () => { transcript.splice(0, transcript.length, ...checkpoint); });
  assert.deepEqual(transcript, ["prior turn", "user:b", "assistant:success"]);
});

test("cross-provider Pi attempts use the classifier mapping or pool fallback, never the old model", () => {
  const initial = { provider: "anthropic", modelId: "claude-sonnet", reasoning: "high" };
  assert.deepEqual(resolvePoolModelSettings("pi", "openai-codex", initial,
    { provider: "openai-codex", modelId: "gpt-mapped", reasoning: "medium" }, "gpt-fallback"),
  { provider: "openai-codex", modelId: "gpt-mapped", reasoning: "medium" });
  assert.deepEqual(resolvePoolModelSettings("pi", "openai-codex", initial, undefined, "gpt-fallback"),
    { provider: "openai-codex", modelId: "gpt-fallback", reasoning: "off" });
  assert.deepEqual(resolvePoolModelSettings("pi", "claude", initial), initial);
  assert.throws(() => resolvePoolModelSettings("pi", "openai-codex", initial), /Configure a fallback model/);
  assert.throws(() => resolvePoolModelSettings("claude", "openai-codex", { provider: "claude", modelId: "claude-sonnet", reasoning: "default" }, undefined, "gpt-fallback"), /cannot switch providers/);
});

test("Pi pool members keep the requested model and remain excluded from Claude-only attempts", async () => {
  const piCandidates = [{ id: "missing", provider: "pi" as const }, { id: "configured", provider: "pi" as const }, ...candidates];
  const initial = { provider: "zai", modelId: "glm-5.2", reasoning: "high" };
  assert.deepEqual(resolvePoolModelSettings("pi", "pi", initial), initial);
  assert.deepEqual(resolvePoolModelSettings("pi", "pi", { ...initial, provider: "openai" }), { ...initial, provider: "openai" });
  assert.throws(() => resolvePoolModelSettings("claude", "pi", initial), /cannot switch providers/);
  assert.deepEqual(orderPoolCandidates(piCandidates, "claude", true).map(({ id }) => id), ["a", "c"]);
  const tried: string[] = [];
  const result = await runPoolAttempts(piCandidates, "pi", async (candidate) => {
    tried.push(candidate.id);
    if (candidate.id === "missing") throw new PoolAttemptFailure("unavailable", false, "Requested provider not configured");
    return candidate.id;
  }, async () => async () => {});
  assert.equal(result, "configured");
  assert.deepEqual(tried, ["missing", "configured"]);
});

test("provider error classification recognizes quota and auth responses only before output", async () => {
  const { classifyPoolAttemptFailure } = await import("../src/provider-profiles/pool-execution.js");
  assert.equal(classifyPoolAttemptFailure(Object.assign(new Error("429 rate limit exceeded"), { status: 429 }), false)?.reason, "quota");
  assert.equal(classifyPoolAttemptFailure(Object.assign(new Error("unauthorized"), { status: 401 }), false)?.reason, "auth");
  assert.equal(classifyPoolAttemptFailure(new Error("model not found"), false), undefined);
  assert.equal(classifyPoolAttemptFailure(new Error("429 rate limit exceeded"), true)?.started, true);
  // Claude's own wording, with and without the code and status the stream carries.
  assert.equal(classifyPoolAttemptFailure(new Error("You've hit your 5-hour limit · resets 3:10am (Asia/Jerusalem)"), true)?.reason, "quota");
  assert.equal(classifyPoolAttemptFailure(Object.assign(new Error("Credit balance is too low"), { code: "billing_error" }), false)?.reason, "quota");
  assert.equal(classifyPoolAttemptFailure(Object.assign(new Error("Invalid API key"), { code: "authentication_failed" }), false)?.reason, "auth");
});
