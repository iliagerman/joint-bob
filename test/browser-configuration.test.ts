import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { applyBrowserConfiguration, readBrowserConfiguration } from "../src/browser-configuration.js";

test("browser executor choice persists and stale peer snapshots cannot replace it", () => {
  const node = randomUUID(), chosen = randomUUID();
  const first = { executorNodeId: chosen, originNodeId: node, updatedAt: "2026-01-01T00:00:00.000Z" };
  assert.equal(readBrowserConfiguration().executorNodeId, null);
  applyBrowserConfiguration(first);
  assert.deepEqual(readBrowserConfiguration(), first);
  applyBrowserConfiguration({ ...first, executorNodeId: null, updatedAt: "2025-12-01T00:00:00.000Z" });
  assert.deepEqual(readBrowserConfiguration(), first);
  const cleared = { ...first, executorNodeId: null, updatedAt: "2026-01-02T00:00:00.000Z" };
  applyBrowserConfiguration(cleared);
  assert.deepEqual(readBrowserConfiguration(), cleared);
});

test("browser configuration rejects malformed identities and timestamps", () => {
  assert.throws(() => applyBrowserConfiguration({ executorNodeId: "bad", originNodeId: randomUUID(), updatedAt: "today" }));
  assert.throws(() => applyBrowserConfiguration({ executorNodeId: null, originNodeId: "", updatedAt: new Date().toISOString() }));
});
