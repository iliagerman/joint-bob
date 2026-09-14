import assert from "node:assert/strict";
import test from "node:test";
import { getHarness, getHarnessRuntime } from "../src/harnesses.js";
import type { HarnessRuntime } from "../src/harnesses/runtime.js";

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

test("harness runtime factory coalesces initialization and evicts rejection", async () => {
  const adapter = getHarness("kiro");
  const original = adapter.runtime;
  const first = gate<HarnessRuntime>();
  const second = gate<HarnessRuntime>();
  let calls = 0;
  adapter.runtime = () => {
    calls += 1;
    return calls === 1 ? first.promise : second.promise;
  };
  try {
    const failedLeft = getHarnessRuntime("kiro");
    const failedRight = getHarnessRuntime("kiro");
    assert.equal(calls, 1);
    first.reject(new Error("cold start failed"));
    await assert.rejects(failedLeft, /cold start failed/);
    await assert.rejects(failedRight, /cold start failed/);

    const runtime = {} as HarnessRuntime;
    const retryLeft = getHarnessRuntime("kiro");
    const retryRight = getHarnessRuntime("kiro");
    assert.equal(calls, 2);
    second.resolve(runtime);
    assert.equal(await retryLeft, runtime);
    assert.equal(await retryRight, runtime);
    assert.equal(calls, 2);
  } finally {
    adapter.runtime = original;
  }
});
