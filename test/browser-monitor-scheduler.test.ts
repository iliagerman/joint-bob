import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { clearTimeout, setTimeout } from "node:timers";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BrowserMonitorCheckError, BrowserMonitorScheduler } from "../src/browser-monitor-scheduler.js";
import type { MonitorCheckResult, MonitorInput } from "../src/browser-monitor-types.js";
import { BrowserMonitorStore } from "../src/browser-monitors.js";

const owner = () => randomUUID();
const input = (name: string): MonitorInput => ({
  projectId: "project", name, checkerId: "fixture", checkerVersion: 1,
  origin: "https://example.test", accountId: "account", targetIds: ["target"], intervalSeconds: 10,
  binding: { nodeId: randomUUID(), sessionId: randomUUID(), profileId: randomUUID(), pageId: randomUUID(), engine: "pi", conversationId: "conversation" },
  readAcknowledged: true,
});
const result = (externalId = "item"): MonitorCheckResult => ({
  accountId: "account", checkpoint: { cursor: externalId }, complete: true, detail: "",
  items: [{ externalId, targetId: "target", targetLabel: "Target", senderId: "sender", direction: "incoming", kind: "message.received", text: externalId, occurredAt: null, identity: "stable" }],
});
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { await waitImmediate(); await waitImmediate(); };
const fixture = () => { const store = new BrowserMonitorStore(new DatabaseSync(":memory:")); return { store, ownerNodeId: owner() }; };
const enabled = (store: BrowserMonitorStore, ownerNodeId: string, name: string, now = 0) => { const monitor = store.create(input(name), ownerNodeId, now); return store.setEnabled(monitor.id, monitor.generation, true, now); };

await test("dispatch follows persisted ten-second due timestamps", async t => {
  const { store, ownerNodeId } = fixture(); const calls: number[] = []; let clockNow = 1000; t.mock.method(Date, "now", () => clockNow);
  const scheduler = new BrowserMonitorScheduler(store, { ownerNodeId, canRun: () => true, check: async () => { calls.push(calls.length); return result(String(calls.length)); }, onEvents: () => {}, onError: error => { throw error; } });
  try {
    enabled(store, ownerNodeId, "clock", 1000); scheduler.dispatch(1000); await flush();
    clockNow = 10999; scheduler.dispatch(10999); await flush(); assert.equal(calls.length, 1);
    clockNow = 11000; scheduler.dispatch(11000); await flush(); assert.equal(calls.length, 2);
  } finally { scheduler.stop(); await flush(); store.close(); }
});

await test("coalesces overdue ticks, bounds concurrency, and orders oldest first", async () => {
  const { store, ownerNodeId } = fixture(); const held = new Map<string, ReturnType<typeof deferred<MonitorCheckResult>>>(); const calls: string[] = [];
  const monitors = [enabled(store, ownerNodeId, "third", 30), enabled(store, ownerNodeId, "first", 10), enabled(store, ownerNodeId, "second", 20)];
  const scheduler = new BrowserMonitorScheduler(store, { ownerNodeId, concurrency: 2, canRun: () => true, check: monitor => { calls.push(monitor.name); const gate = deferred<MonitorCheckResult>(); held.set(monitor.id, gate); return gate.promise; }, onEvents: () => {}, onError: error => { throw error; } });
  try {
    scheduler.dispatch(30); scheduler.dispatch(30); await flush(); assert.deepEqual(calls, ["first", "second"]); assert.equal(scheduler.activeCount, 2);
    held.get(monitors[1].id)!.resolve(result("first")); await flush(); scheduler.dispatch(30); await flush(); assert.deepEqual(calls, ["first", "second", "third"]);
  } finally { for (const gate of held.values()) gate.resolve(result(randomUUID())); await flush(); scheduler.stop(); store.close(); }
});

await test("readiness and cancellation", async () => {
  const { store, ownerNodeId } = fixture(); let ready = false; let calls = 0; const gate = deferred<MonitorCheckResult>(); let signal!: AbortSignal;
  const monitor = enabled(store, ownerNodeId, "ready", 0);
  const scheduler = new BrowserMonitorScheduler(store, { ownerNodeId, canRun: () => ready, check: (_monitor, _run, currentSignal) => { calls++; signal = currentSignal; return gate.promise; }, onEvents: () => {}, onError: error => { throw error; } });
  try {
    scheduler.dispatch(0); await flush(); assert.equal(calls, 0); ready = true; scheduler.dispatch(0); await flush(); assert.equal(calls, 1);
    store.rebind(monitor.id, monitor.generation, { ...monitor.binding, pageId: randomUUID() }, 1); scheduler.dispatch(1); assert.equal(signal.aborted, true);
    gate.resolve(result("stale")); await flush(); assert.equal(store.events(monitor.id).length, 0);
  } finally { scheduler.stop(); await flush(); store.close(); }
});

await test("typed and ordinary failures are durable and observable", async t => {
  const { store, ownerNodeId } = fixture(); t.mock.method(Date, "now", () => 0); const errors: Error[] = []; const typed = enabled(store, ownerNodeId, "typed", 0); const ordinary = enabled(store, ownerNodeId, "ordinary", 0);
  const scheduler = new BrowserMonitorScheduler(store, { ownerNodeId, concurrency: 2, canRun: () => true, check: async monitor => { if (monitor.id === typed.id) throw new BrowserMonitorCheckError("needs-login", "Sign in"); throw new Error("boom"); }, onEvents: () => {}, onError: error => errors.push(error) });
  try {
    scheduler.dispatch(0); await flush(); assert.equal(store.get(typed.id).health, "needs-login"); assert.equal(store.get(typed.id).enabled, false);
    assert.equal(store.get(ordinary.id).health, "error"); assert.equal(store.get(ordinary.id).nextDueAt, 30000); assert.equal(errors.length, 2);
    const broken = new BrowserMonitorScheduler(store, { ownerNodeId, canRun: () => true, check: async () => result(), onEvents: () => {}, onError: error => errors.push(error) });
    store.close(); broken.dispatch(0); assert.equal(errors.length, 3);
  } finally { scheduler.stop(); }
});

await test("timeout aborts but retains the physical slot until checker settles", async () => {
  const { store, ownerNodeId } = fixture(); const gate = deferred<MonitorCheckResult>(); const aborted = deferred<void>(); const errors: Error[] = []; let calls = 0;
  enabled(store, ownerNodeId, "timeout", 0);
  const scheduler = new BrowserMonitorScheduler(store, { ownerNodeId, checkTimeoutMs: 25, canRun: () => true, check: (_m, _r, signal) => { calls++; signal.addEventListener("abort", () => aborted.resolve(), { once: true }); return gate.promise; }, onEvents: () => {}, onError: error => errors.push(error) });
  try {
    scheduler.dispatch(0); await aborted.promise; assert.equal(scheduler.activeCount, 1); scheduler.dispatch(60000); assert.equal(calls, 1); assert.equal(errors[0]?.message, "Browser monitor check timed out");
    gate.resolve(result("late")); await flush(); assert.equal(scheduler.activeCount, 0); assert.equal(store.events(store.list()[0].id).length, 0);
  } finally { scheduler.stop(); store.close(); }
});

await test("stop is idempotent, suppresses late output, and instances cannot restart", async () => {
  const { store, ownerNodeId } = fixture(); const gate = deferred<MonitorCheckResult>(); const monitor = enabled(store, ownerNodeId, "stop", 0);
  const scheduler = new BrowserMonitorScheduler(store, { ownerNodeId, canRun: () => true, check: () => gate.promise, onEvents: () => {}, onError: () => {} });
  scheduler.start(); assert.throws(() => scheduler.start(), /already started/); scheduler.stop(); scheduler.stop(); assert.throws(() => scheduler.start(), /is stopped/);
  gate.resolve(result("late")); await flush(); scheduler.dispatch(20000); assert.equal(store.events(monitor.id).length, 0); assert.equal(scheduler.activeCount, 0); store.close();
});

await test("restart recovery fences only interrupted runs owned by this node", async () => {
  const { store, ownerNodeId } = fixture(); const otherOwner = owner(); const mine = enabled(store, ownerNodeId, "mine", 0); const other = enabled(store, otherOwner, "other", 0);
  store.claim(mine.id, ownerNodeId, 0); store.claim(other.id, otherOwner, 0); let calls = 0;
  const scheduler = new BrowserMonitorScheduler(store, { ownerNodeId, canRun: () => true, check: async () => { calls++; return result(); }, onEvents: () => {}, onError: error => { throw error; } });
  try { scheduler.start(); await flush(); assert.equal(calls, 1); assert.equal(store.history(mine.id)[0].status, "succeeded"); assert.equal(store.history(other.id)[0].status, "running"); }
  finally { scheduler.stop(); store.recover(otherOwner); store.close(); }
});

await test("event callback receives only durable new events and callback failure does not replay", async t => {
  const { store, ownerNodeId } = fixture(); let clockNow = 0; t.mock.method(Date, "now", () => clockNow); const monitor = enabled(store, ownerNodeId, "events", 0); const errors: Error[] = []; let checks = 0; let notifications = 0;
  const scheduler = new BrowserMonitorScheduler(store, { ownerNodeId, canRun: () => true, check: async () => result(checks++ === 0 ? "baseline" : "new"), onEvents: (_monitor, events) => { notifications += events.length; throw new Error("callback"); }, onError: error => errors.push(error) });
  try {
    scheduler.dispatch(0); await flush(); assert.equal(notifications, 0); clockNow = 10000; scheduler.dispatch(10000); await flush(); assert.equal(notifications, 1); assert.equal(errors[0]?.message, "callback");
    clockNow = 20000; scheduler.dispatch(20000); await flush(); assert.equal(notifications, 1); assert.equal(store.pendingEvents(monitor.id).length, 1);
  } finally { scheduler.stop(); store.close(); }
});

await test("completion time and invalid result settle correctly", async t => {
  const { store, ownerNodeId } = fixture(); let clockNow = 1000; t.mock.method(Date, "now", () => clockNow);
  const monitor = enabled(store, ownerNodeId, "settlement", clockNow); let calls = 0; const errors: Error[] = [];
  const scheduler = new BrowserMonitorScheduler(store, {
    ownerNodeId, canRun: () => true,
    check: async () => calls++ === 0 ? result("baseline") : calls === 2 ? { ...result("invalid"), accountId: "wrong-account" } : result("recovered"),
    onEvents: () => {}, onError: error => errors.push(error),
  });
  try {
    scheduler.dispatch(1000); clockNow = 5000; await flush();
    assert.equal(store.history(monitor.id)[0].finishedAt, 5000); assert.equal(store.get(monitor.id).lastFinishedAt, 5000);
    clockNow = 11000; scheduler.dispatch(11000); clockNow = 20000; await flush();
    assert.equal(store.history(monitor.id)[0].status, "failed"); assert.equal(store.history(monitor.id)[0].finishedAt, 20000);
    assert.equal(store.get(monitor.id).health, "error"); assert.equal(store.get(monitor.id).nextDueAt, 50000); assert.equal(scheduler.activeCount, 0);
    assert.match(errors[0]?.message ?? "", /account/i);
    clockNow = 50000; scheduler.dispatch(50000); await flush(); assert.equal(calls, 3); assert.equal(store.history(monitor.id)[0].status, "succeeded");
  } finally { scheduler.stop(); await flush(); store.close(); }
});

await test("failed recovery prevents scheduler start", async t => {
  const { store, ownerNodeId } = fixture(); let calls = 0; const errors: Error[] = []; const failure = new Error("fixture recovery failed");
  t.mock.method(store, "recover", () => { throw failure; });
  const scheduler = new BrowserMonitorScheduler(store, { ownerNodeId, canRun: () => true, check: async () => { calls++; return result(); }, onEvents: () => {}, onError: error => errors.push(error) });
  try {
    assert.throws(() => scheduler.start(), error => error === failure); await flush(); assert.equal(calls, 0); assert.deepEqual(errors, [failure]);
    assert.throws(() => scheduler.start(), /is stopped/); await flush(); assert.equal(calls, 0);
  } finally { scheduler.stop(); store.close(); }
});

await test("stop before microtask prevents checker invocation", async t => {
  const { store, ownerNodeId } = fixture(); let clockNow = 1000; t.mock.method(Date, "now", () => clockNow); let calls = 0;
  const monitor = enabled(store, ownerNodeId, "stop race", clockNow);
  const scheduler = new BrowserMonitorScheduler(store, { ownerNodeId, canRun: () => true, check: async () => { calls++; return result(); }, onEvents: () => {}, onError: () => {} });
  scheduler.dispatch(clockNow); clockNow = 2000; scheduler.stop(); await flush();
  assert.equal(calls, 0); assert.equal(scheduler.activeCount, 0); assert.equal(store.history(monitor.id)[0].status, "failed"); assert.equal(store.get(monitor.id).nextDueAt, 32000);
  store.close();
});

await test("real timer performs a persistent ten-second check without a viewer", { timeout: 18000 }, async () => {
  const { store, ownerNodeId } = fixture(); enabled(store, ownerNodeId, "timer", Date.now()); let checks = 0; const notified = deferred<void>();
  const scheduler = new BrowserMonitorScheduler(store, { ownerNodeId, canRun: () => true, check: async () => result(checks++ === 0 ? "baseline" : "changed"), onEvents: () => notified.resolve(), onError: error => notified.reject(error) });
  const deadline = deferred<void>(); const deadlineTimer = setTimeout(() => deadline.reject(new Error("Scheduled check did not arrive within 12 seconds")), 12000);
  try { scheduler.start(); await Promise.race([notified.promise, deadline.promise]); assert.equal(checks, 2); }
  finally { clearTimeout(deadlineTimer); scheduler.stop(); await flush(); store.close(); }
});
