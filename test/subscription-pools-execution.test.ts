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
  }, async () => { restores += 1; });
  assert.equal(result, "b");
  assert.deepEqual(attempted, ["a", "c", "b"]);
  assert.equal(restores, 2);
});

test("generic failures and any failure after output or tool start never retry", async () => {
  for (const failure of [new Error("provider connection reset"), new PoolAttemptFailure("quota", true, "quota after output")]) {
    const attempted: string[] = [];
    await assert.rejects(runPoolAttempts(candidates, "claude", async (candidate) => {
      attempted.push(candidate.id);
      throw failure;
    }, async () => assert.fail("must not restore without a retry")));
    assert.deepEqual(attempted, ["a"]);
  }
});

test("credential failures can advance, while exhausted attempts leave the final failure intact", async () => {
  const attempted: string[] = [];
  let restores = 0;
  await assert.rejects(runPoolAttempts(candidates, "claude", async (candidate) => {
    attempted.push(candidate.id);
    throw new PoolAttemptFailure("unavailable", false, `source unavailable: ${candidate.id}`);
  }, async () => { restores += 1; }), /source unavailable: b/);
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
  }, async () => { transcript.splice(0, transcript.length, ...checkpoint); });
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

test("provider error classification recognizes quota and auth responses only before output", async () => {
  const { classifyPoolAttemptFailure } = await import("../src/provider-profiles/pool-execution.js");
  assert.equal(classifyPoolAttemptFailure(Object.assign(new Error("429 rate limit exceeded"), { status: 429 }), false)?.reason, "quota");
  assert.equal(classifyPoolAttemptFailure(Object.assign(new Error("unauthorized"), { status: 401 }), false)?.reason, "auth");
  assert.equal(classifyPoolAttemptFailure(new Error("model not found"), false), undefined);
  assert.equal(classifyPoolAttemptFailure(new Error("429 rate limit exceeded"), true)?.started, true);
});
