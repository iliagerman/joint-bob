import assert from "node:assert/strict";
import test from "node:test";
import claude from "../src/harnesses/claude.harness.js";
import { createSubscriptionDetectionCollector, detectHarnessSubscription, type SubscriptionDetectionExec } from "../src/subscription-detection.js";

const execute = (stdout: string, stderr = "") => async () => ({ stdout, stderr });

test("Claude subscription detection invokes a bounded synthetic command and strips extras", async () => {
  let invocation: any;
  const fake: SubscriptionDetectionExec = async (file, args, options) => {
    invocation = { file, args, options };
    return { stdout: JSON.stringify({ loggedIn: true, subscriptionType: "Max", authMethod: "oauth", email: "secret@example.test", organization: "Private Org", token: "sk-secret" }) };
  };
  const result = await detectHarnessSubscription(claude, fake);
  assert.deepEqual(invocation.args, ["auth", "status", "--json"]);
  assert.equal(invocation.options.timeout, 5_000); assert.equal(invocation.options.maxBuffer, 64 * 1024);
  assert.equal(typeof invocation.options.env.CLAUDE_CONFIG_DIR, "string");
  assert.equal(result.status, "detected"); assert.equal(result.planName, "Max"); assert.equal(result.authMethod, "oauth");
  const serialized = JSON.stringify(result);
  for (const secret of ["secret@example.test", "Private Org", "sk-secret"]) assert.equal(serialized.includes(secret), false);
});

test("failed stderr, malformed JSON, signout, and API-only status are safe", async () => {
  const failed: SubscriptionDetectionExec = async () => { throw Object.assign(new Error("token-secret"), { stderr: "email@example.test" }); };
  for (const result of [
    await detectHarnessSubscription(claude, failed),
    await detectHarnessSubscription(claude, execute("not json", "private stderr")),
    await detectHarnessSubscription(claude, execute(JSON.stringify({ loggedIn: false, subscriptionType: "Max", email: "hidden" }))),
    await detectHarnessSubscription(claude, execute(JSON.stringify({ loggedIn: true, authMethod: "api_key", token: "hidden" }))),
  ]) {
    assert.equal(result.status, "unavailable");
    assert.equal(/secret|example|stderr|hidden/.test(JSON.stringify(result)), false);
    assert.equal(result.price, null);
  }
});

test("unsupported harness makes zero subprocess calls", async () => {
  let calls = 0;
  const result = await detectHarnessSubscription({ id: "pi", label: "Pi" }, async () => { calls++; return { stdout: "{}" }; });
  assert.equal(result.status, "unsupported"); assert.equal(calls, 0);
});

test("subscription collector shares concurrent work and caches it", async () => {
  let calls = 0; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const collect = createSubscriptionDetectionCollector(async () => { calls++; await gate; return { stdout: JSON.stringify({ loggedIn: true, subscriptionType: "Pro" }) }; }, 60_000);
  const first = collect(); const second = collect();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, "only Claude is supported and concurrent collections share it");
  release();
  assert.equal(await first, await second);
  await collect(); assert.equal(calls, 1);
});
