import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { waitForAssertion } from "./async-assertion.js";

test("waitForAssertion succeeds after a transient assertion failure", async () => {
  let calls = 0;
  const result = await waitForAssertion(async () => {
    calls++;
    assert.equal(calls, 2);
    return "ready";
  });
  assert.equal(result, "ready");
  assert.equal(calls, 2);
});

test("waitForAssertion stops after a late async rejection beyond its deadline", async () => {
  let calls = 0;
  await assert.rejects(waitForAssertion(async () => {
    calls++;
    await delay(20);
    assert.fail("original assertion");
  }, 5), /original assertion/);
  assert.equal(calls, 1);
  // Observe beyond the 50ms poll interval.
  await delay(75);
  assert.equal(calls, 1, "a late rejection must not schedule another poll");
});
