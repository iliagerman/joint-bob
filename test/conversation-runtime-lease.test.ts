import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Runtime leases are the cross-node running signal: newer ownership epochs beat
 * older ones, a full snapshot ends its owner's absent sessions, and every entry
 * expires so a crashed execution node stops advertising runs.
 */

function lease(overrides: Partial<import("../src/conversation-runtime.js").RuntimeLeaseInput> = {}) {
  const now = new Date("2026-09-01T12:00:00.000Z");
  return {
    engine: "pi" as const, sessionId: "session-a", ownerNodeId: "node-b",
    ownershipEpoch: 1, runId: "run-1",
    updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 15_000).toISOString(),
    ...overrides,
  };
}

async function withRuntime<T>(run: (runtime: typeof import("../src/conversation-runtime.js"), db: import("node:sqlite").DatabaseSync) => Promise<T>): Promise<T> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-runtime-lease-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const runtime = await import(`../src/conversation-runtime.ts?lease=${Date.now()}-${Math.random()}`) as typeof import("../src/conversation-runtime.js");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    return await run(runtime, db);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("a lease marks a conversation running and a later snapshot without it ends the run", async () => {
  await withRuntime((runtime, db) => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const changed = runtime.applyRuntimeLeaseSnapshot(db, "node-b", "2026-09-01T12:00:00.000Z", [lease()], now);
    assert.deepEqual(changed, ["pi\nsession-a"]);
    assert.equal(runtime.conversationLeaseRunning("pi", "session-a", new Date(now.getTime() + 5_000)), true);

    const ended = runtime.applyRuntimeLeaseSnapshot(db, "node-b", "2026-09-01T12:00:06.000Z", [], new Date(now.getTime() + 6_000));
    assert.deepEqual(ended, ["pi\nsession-a"]);
    assert.equal(runtime.conversationLeaseRunning("pi", "session-a", new Date(now.getTime() + 7_000)), false);
    return Promise.resolve();
  });
});

test("an expired lease never reports running", async () => {
  await withRuntime((runtime, db) => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    runtime.applyRuntimeLeaseSnapshot(db, "node-b", "2026-09-01T12:00:00.000Z", [lease()], now);
    assert.equal(runtime.conversationLeaseRunning("pi", "session-a", new Date(now.getTime() + 16_000)), false);
    return Promise.resolve();
  });
});

test("stale heartbeats from an older ownership epoch or older update are rejected", async () => {
  await withRuntime((runtime, db) => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    runtime.applyRuntimeLeaseSnapshot(db, "node-b", "2026-09-01T12:00:05.000Z", [lease({ ownershipEpoch: 3, updatedAt: "2026-09-01T12:00:05.000Z" })], now);

    // An old-owner heartbeat after a transfer cannot resurrect the run.
    runtime.applyRuntimeLeaseSnapshot(db, "node-a", "2026-09-01T12:00:09.000Z", [lease({ ownerNodeId: "node-a", ownershipEpoch: 2, updatedAt: "2026-09-01T12:00:09.000Z" })], now);
    const afterStaleEpoch = runtime.conversationLeaseRunning("pi", "session-a", now);
    assert.equal(afterStaleEpoch, true, "epoch-2 heartbeat must not override the epoch-3 lease");

    // Same epoch, older timestamp: a delayed duplicate, not a new heartbeat.
    runtime.applyRuntimeLeaseSnapshot(db, "node-b", "2026-09-01T12:00:01.000Z", [lease({ ownershipEpoch: 3, updatedAt: "2026-09-01T12:00:01.000Z" })], now);
    const row = db.prepare("SELECT updated_at FROM conversation_runtime_leases WHERE engine = 'pi' AND session_id = 'session-a'").get() as { updated_at: string };
    assert.equal(row.updated_at, "2026-09-01T12:00:05.000Z");

    // A newer epoch from the new owner takes over.
    runtime.applyRuntimeLeaseSnapshot(db, "node-c", "2026-09-01T12:00:10.000Z", [lease({ ownerNodeId: "node-c", ownershipEpoch: 4, updatedAt: "2026-09-01T12:00:10.000Z" })], now);
    const owner = db.prepare("SELECT owner_node_id FROM conversation_runtime_leases WHERE engine = 'pi' AND session_id = 'session-a'").get() as { owner_node_id: string };
    assert.equal(owner.owner_node_id, "node-c");
    return Promise.resolve();
  });
});

test("a snapshot only ends leases its own node owns", async () => {
  await withRuntime((runtime, db) => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    runtime.applyRuntimeLeaseSnapshot(db, "node-b", "2026-09-01T12:00:00.000Z", [lease()], now);
    // Node C's empty snapshot must not clear node B's run.
    runtime.applyRuntimeLeaseSnapshot(db, "node-c", "2026-09-01T12:00:00.000Z", [], now);
    assert.equal(runtime.conversationLeaseRunning("pi", "session-a", now), true);
    return Promise.resolve();
  });
});

test("same-owner snapshots applied out of order cannot delete or resurrect leases", async () => {
  await withRuntime((runtime, db) => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    runtime.applyRuntimeLeaseSnapshot(db, "node-b", "2026-09-01T12:00:00.000Z", [lease()], now);
    // The newer empty snapshot ends the run...
    runtime.applyRuntimeLeaseSnapshot(db, "node-b", "2026-09-01T12:00:06.000Z", [], now);
    assert.equal(runtime.conversationLeaseRunning("pi", "session-a", now), false);
    // ...and a delayed older non-empty snapshot from the same owner cannot resurrect it.
    runtime.applyRuntimeLeaseSnapshot(db, "node-b", "2026-09-01T12:00:03.000Z", [lease({ updatedAt: "2026-09-01T12:00:03.000Z" })], now);
    assert.equal(runtime.conversationLeaseRunning("pi", "session-a", now), false, "an older snapshot must not resurrect a lease");
    // The mirror case: a newer lease must survive a delayed older empty snapshot.
    runtime.applyRuntimeLeaseSnapshot(db, "node-b", "2026-09-01T12:00:09.000Z", [lease({ updatedAt: "2026-09-01T12:00:09.000Z" })], now);
    runtime.applyRuntimeLeaseSnapshot(db, "node-b", "2026-09-01T12:00:07.000Z", [], now);
    assert.equal(runtime.conversationLeaseRunning("pi", "session-a", now), true, "an older empty snapshot must not end a newer lease");
    return Promise.resolve();
  });
});

test("leases with out-of-band TTL or skewed timestamps are rejected", async () => {
  await withRuntime((runtime, db) => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    assert.throws(() => runtime.applyRuntimeLeaseSnapshot(db, "node-b", "2026-09-01T12:00:00.000Z", [lease({ expiresAt: new Date("2026-09-01T13:00:00.000Z").toISOString() })], now), /TTL is out of bounds/);
    assert.throws(() => runtime.applyRuntimeLeaseSnapshot(db, "node-b", "2026-09-01T10:00:00.000Z", [lease({ updatedAt: "2026-09-01T10:00:00.000Z", expiresAt: "2026-09-01T10:00:15.000Z" })], now), /too far from the receiver clock/);
    return Promise.resolve();
  });
});

test("the expiry sweep reports the leases it dropped", async () => {
  await withRuntime((runtime, db) => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    runtime.applyRuntimeLeaseSnapshot(db, "node-b", "2026-09-01T12:00:00.000Z", [lease()], now);
    assert.deepEqual(runtime.sweepExpiredRuntimeLeases(db, now), []);
    assert.deepEqual(runtime.sweepExpiredRuntimeLeases(db, new Date("2026-09-01T12:00:16.000Z")), ["pi\nsession-a"]);
    assert.equal(runtime.conversationLeaseRunning("pi", "session-a", new Date("2026-09-01T12:00:17.000Z")), false);
    return Promise.resolve();
  });
});
