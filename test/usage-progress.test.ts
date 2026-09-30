import assert from "node:assert/strict";
import test from "node:test";
import { createUsageRefreshController, type UsageCoverage } from "../src/server/usage.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const coverage = (refreshedAt: string): UsageCoverage => ({ projects: 1, sessions: 2, missing: 0, refreshedAt });

test("usage refresh request is deferred, reports progress, and coalesces", async () => {
  let calls = 0; let release!: (value: UsageCoverage) => void;
  const work = () => { calls++; return new Promise<UsageCoverage>((resolve) => { release = resolve; }); };
  const controller = createUsageRefreshController(work, 60_000);
  controller.request(); controller.request();
  assert.equal(calls, 0, "request must not scan synchronously before setImmediate");
  assert.deepEqual(controller.status(), { refreshing: true, refreshedAt: null, error: null });
  await tick();
  assert.equal(calls, 1);
  const result = coverage("2025-01-01T00:00:00.000Z"); release(result); await tick();
  assert.deepEqual(controller.status(), { refreshing: false, refreshedAt: result.refreshedAt, error: null });
  assert.equal(await controller.refresh(), result, "fresh result is cached");
  assert.equal(calls, 1);
});

test("usage refresh coalesces direct callers, sanitizes errors, and retries", async () => {
  let calls = 0; let release!: (value: UsageCoverage) => void;
  const controller = createUsageRefreshController(() => {
    calls++;
    if (calls === 1) return Promise.reject(new Error("private path and token"));
    return new Promise<UsageCoverage>((resolve) => { release = resolve; });
  }, 60_000);
  await assert.rejects(controller.refresh(), /private path/);
  assert.equal(controller.status().error, "Usage refresh failed");
  assert.equal(JSON.stringify(controller.status()).includes("private path"), false);
  const first = controller.refresh(); const second = controller.refresh();
  assert.equal(first, second); assert.equal(calls, 2); assert.equal(controller.status().error, null);
  const value = coverage("2025-02-01T00:00:00.000Z"); release(value);
  assert.equal(await first, value);
});
