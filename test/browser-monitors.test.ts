import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { monitorCheckResultSchema, monitorInputSchema, type MonitorInput } from "../src/browser-monitor-types.js";
import { BrowserMonitorStore } from "../src/browser-monitors.js";
import { resolveDataDirectory } from "../src/data-directory.js";

const ids = () => ({ nodeId: randomUUID(), sessionId: randomUUID(), profileId: randomUUID(), pageId: randomUUID() });
function input(overrides: Partial<MonitorInput> = {}): MonitorInput {
  return { projectId: "project", name: "Inbox", checkerId: "fixture", checkerVersion: 1,
    origin: "https://example.com", accountId: "account", targetIds: [], intervalSeconds: 10,
    binding: { ...ids(), engine: "pi", conversationId: "conversation" }, readAcknowledged: true, ...overrides };
}
const item = (externalId: string, direction: "incoming" | "outgoing" = "incoming", kind: "message.received" | "page.changed" | "message.edited" = "message.received") =>
  ({ externalId, targetId: "inbox", targetLabel: "Inbox", senderId: "sender", direction, kind, text: externalId, occurredAt: 1, identity: "stable" as const });
function store() { const db = new DatabaseSync(":memory:"); return { db, store: new BrowserMonitorStore(db) }; }

test("schemas enforce monitor and result boundaries", () => {
  assert.equal(monitorInputSchema.parse(input()).intervalSeconds, 10);
  for (const intervalSeconds of [9, 10.5, Infinity]) assert.throws(() => monitorInputSchema.parse(input({ intervalSeconds })));
  for (const origin of ["https://u:p@example.com", "https://example.com/", "https://example.com/path"]) assert.throws(() => monitorInputSchema.parse(input({ origin })));
  assert.throws(() => monitorInputSchema.parse({ ...input(), extra: true }));
  assert.throws(() => monitorInputSchema.parse(input({ binding: { ...input().binding, nodeId: "bad" } })));
  assert.throws(() => monitorCheckResultSchema.parse({ accountId: "a", items: Array(501).fill(item("x")), checkpoint: {}, complete: true, detail: "" }));
  assert.throws(() => monitorCheckResultSchema.parse({ accountId: "a", items: [], checkpoint: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [String(i), "x"])), complete: true, detail: "" }));
});

test("target bounds and overdue idle recovery", () => {
  const target320 = "x".repeat(320);
  assert.equal(monitorInputSchema.parse(input({ targetIds: [target320] })).targetIds[0], target320);
  assert.throws(() => monitorInputSchema.parse(input({ targetIds: ["x".repeat(321)] })));
  assert.equal(monitorInputSchema.parse(input({ targetIds: Array.from({ length: 200 }, (_, i) => `target-${i}`) })).targetIds.length, 200);
  assert.throws(() => monitorInputSchema.parse(input({ targetIds: Array.from({ length: 201 }, (_, i) => `target-${i}`) })));

  const x = store(); try {
    const owner = randomUUID();
    let overdue = x.store.create(input(), owner, 1); overdue = x.store.setEnabled(overdue.id, overdue.generation, true, 2);
    const disabled = x.store.create(input({ name: "Disabled" }), owner, 3);
    let otherOwner = x.store.create(input({ name: "Other owner" }), randomUUID(), 4);
    otherOwner = x.store.setEnabled(otherOwner.id, otherOwner.generation, true, 5);
    x.store.claim(otherOwner.id, otherOwner.ownerNodeId, 5);
    const disabledBefore = x.store.get(disabled.id); const otherBefore = x.store.get(otherOwner.id); const otherHistory = x.store.history(otherOwner.id);

    x.store.recover(owner, 10);
    const recovered = x.store.get(overdue.id);
    assert.equal(recovered.nextDueAt, 10); assert.equal(recovered.health, "ready");
    assert.equal(recovered.detail, "Check recovered after restart"); assert.equal(recovered.generation, overdue.generation);
    assert.deepEqual(x.store.get(disabled.id), disabledBefore); assert.deepEqual(x.store.get(otherOwner.id), otherBefore);
    assert.deepEqual(x.store.history(otherOwner.id), otherHistory);
  } finally { x.store.close(); }
});

test("create is paused and ownership and project constrain discovery", () => {
  const x = store(); try {
    const monitor = x.store.create(input(), input().binding.nodeId, 1000);
    assert.equal(monitor.enabled, false); assert.equal(monitor.health, "paused"); assert.equal(x.store.claim(monitor.id, monitor.ownerNodeId, 1000), null);
    const unread = x.store.create(input({ readAcknowledged: false }), monitor.ownerNodeId, 1000);
    assert.throws(() => x.store.setEnabled(unread.id, unread.generation, true, 1001), /Acknowledge/);
    assert.deepEqual(x.store.get(unread.id), unread);
    assert.equal(x.store.list("other").length, 0); assert.equal(x.store.list("project").length, 2);
    const enabled = x.store.setEnabled(monitor.id, monitor.generation, true, 1000);
    assert.equal(x.store.claim(enabled.id, randomUUID(), 1000), null);
  } finally { x.store.close(); }
});

test("claims obey cadence and cannot overlap", () => {
  const x = store(); try {
    let monitor = x.store.create(input(), input().binding.nodeId, 1000); monitor = x.store.setEnabled(monitor.id, 1, true, 1000);
    const run = x.store.claim(monitor.id, monitor.ownerNodeId, 1000)!;
    assert.equal(run.dueAt, 1000); assert.equal(x.store.get(monitor.id).nextDueAt, 11000);
    assert.equal(x.store.claim(monitor.id, monitor.ownerNodeId, 50000), null);
    x.store.complete(run.id, { accountId: "account", items: [], checkpoint: {}, complete: true, detail: "" }, 1001);
    assert.equal(x.store.claim(monitor.id, monitor.ownerNodeId, 10999), null);
    const next = x.store.claim(monitor.id, monitor.ownerNodeId, 11000)!; assert.equal(next.dueAt, 11000);
  } finally { x.store.close(); }
});

test("baseline tombstones and subsequent durable deduplication", () => {
  const x = store(); try {
    let m = x.store.create(input(), input().binding.nodeId, 0); m = x.store.setEnabled(m.id, 1, true, 0);
    let r = x.store.claim(m.id, m.ownerNodeId, 0)!;
    assert.deepEqual(x.store.complete(r.id, { accountId: "account", items: [item("old")], checkpoint: { inbox: "1" }, complete: true, detail: "" }, 1), []);
    assert.equal(x.store.pendingEvents(m.id).length, 0);
    x.store.requestCheck(m.id, 2, 2); r = x.store.claim(m.id, m.ownerNodeId, 2)!;
    const fresh = [{ ...item("same-a"), text: "same text" }, { ...item("same-b"), text: "same text" }, item("out", "outgoing"), item("edit", "incoming", "message.edited")];
    assert.equal(fresh[0].text, fresh[1].text);
    assert.equal(x.store.complete(r.id, { accountId: "account", items: fresh, checkpoint: { inbox: "2" }, complete: true, detail: "" }, 3).length, 2);
    assert.equal(x.store.pendingEvents(m.id).length, 2);
    x.store.requestCheck(m.id, 2, 4); r = x.store.claim(m.id, m.ownerNodeId, 4)!;
    assert.equal(x.store.complete(r.id, { accountId: "account", items: fresh, checkpoint: {}, complete: true, detail: "" }, 5).length, 0);
  } finally { x.store.close(); }
});

test("partial coverage preserves baseline and checkpoint rules", () => {
  const x = store(); try {
    let m = x.store.create(input(), input().binding.nodeId, 0); m = x.store.setEnabled(m.id, 1, true, 0);
    let r = x.store.claim(m.id, m.ownerNodeId, 0)!;
    x.store.complete(r.id, { accountId: "account", items: [item("ignored")], checkpoint: { x: "bad" }, complete: false, detail: "partial" }, 1);
    assert.equal(x.store.get(m.id).baseline, false); assert.deepEqual(x.store.get(m.id).checkpoint, {}); assert.equal(x.store.events(m.id).length, 0);
    x.store.requestCheck(m.id, 2, 2); r = x.store.claim(m.id, m.ownerNodeId, 2)!;
    x.store.complete(r.id, { accountId: "account", items: [], checkpoint: { x: "one" }, complete: true, detail: "" }, 3);
    x.store.requestCheck(m.id, 2, 4); r = x.store.claim(m.id, m.ownerNodeId, 4)!;
    assert.equal(x.store.complete(r.id, { accountId: "account", items: [item("new")], checkpoint: { x: "two" }, complete: false, detail: "partial" }, 5).length, 1);
    assert.deepEqual(x.store.get(m.id).checkpoint, { x: "one" });
    x.store.requestCheck(m.id, 2, 6); r = x.store.claim(m.id, m.ownerNodeId, 6)!;
    assert.equal(x.store.complete(r.id, { accountId: "account", items: [item("new")], checkpoint: { x: "three" }, complete: true, detail: "" }, 7).length, 0);
    assert.equal(x.store.events(m.id).length, 1);
    x.db.prepare("UPDATE browser_monitor_monitors SET checkpoint = ? WHERE id = ?").run(JSON.stringify({ x: "x".repeat(65537) }), m.id);
    assert.throws(() => x.store.get(m.id));
  } finally { x.store.close(); }
});

test("completion rolls back atomically after a SQLite insertion failure", () => {
  const x = store(); try {
    let m = x.store.create(input(), input().binding.nodeId, 0); m = x.store.setEnabled(m.id, 1, true, 0);
    let r = x.store.claim(m.id, m.ownerNodeId, 0)!;
    x.store.complete(r.id, { accountId: "account", items: [], checkpoint: { x: "original" }, complete: true, detail: "baseline" }, 1);
    x.store.requestCheck(m.id, m.generation, 2); r = x.store.claim(m.id, m.ownerNodeId, 2)!;
    const originalHistory = x.store.history(m.id);
    x.db.exec("CREATE TRIGGER browser_monitor_fixture_failure BEFORE INSERT ON browser_monitor_events WHEN NEW.external_id = 'second' BEGIN SELECT RAISE(ABORT, 'fixture insertion failed'); END");
    assert.throws(() => x.store.complete(r.id, { accountId: "account", items: [item("first"), item("second")], checkpoint: { x: "new" }, complete: true, detail: "done" }, 3), /fixture insertion failed/);
    assert.equal(x.store.events(m.id).length, 0); assert.deepEqual(x.store.get(m.id).checkpoint, { x: "original" });
    assert.deepEqual(x.store.history(m.id), originalHistory); assert.equal(x.store.history(m.id)[0].status, "running");
    x.db.exec("DROP TRIGGER browser_monitor_fixture_failure");
    assert.equal(x.store.complete(r.id, { accountId: "account", items: [item("first"), item("second")], checkpoint: { x: "new" }, complete: true, detail: "done" }, 4).length, 2);
    assert.equal(x.store.events(m.id).length, 2); assert.deepEqual(x.store.get(m.id).checkpoint, { x: "new" });
  } finally { x.store.close(); }
});

test("pause and rebind generation fences delayed completion and failure", () => {
  const x = store(); try {
    let m = x.store.create(input(), input().binding.nodeId, 0); m = x.store.setEnabled(m.id, 1, true, 0); const r = x.store.claim(m.id, m.ownerNodeId, 0)!;
    const binding = { ...m.binding, pageId: randomUUID() }; const rebound = x.store.rebind(m.id, m.generation, binding, 1);
    assert.equal(rebound.generation, 3); assert.equal(rebound.binding.pageId, binding.pageId); assert.equal(rebound.health, "paused");
    // Simulate a stale worker record surviving cancellation; generation is the durable fence.
    x.db.prepare("UPDATE browser_monitor_runs SET status = 'running' WHERE id = ?").run(r.id);
    x.db.prepare("UPDATE browser_monitor_monitors SET enabled = 1 WHERE id = ?").run(m.id);
    assert.deepEqual(x.store.complete(r.id, { accountId: "account", items: [item("late")], checkpoint: { x: "late" }, complete: true, detail: "late" }, 2), []);
    x.store.fail(r.id, "error", "late", 2); assert.equal(x.store.get(m.id).health, "paused"); assert.deepEqual(x.store.get(m.id).checkpoint, {});
    assert.throws(() => x.store.update(m.id, 2, { name: "stale" }), /changed/);
  } finally { x.store.close(); }
});

test("reopen recovery fences interrupted work and two connections claim once", () => {
  const directory = path.join(resolveDataDirectory(), randomUUID()); mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "node.db"); const owner = randomUUID();
  let db = new DatabaseSync(file); db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000"); let first = new BrowserMonitorStore(db);
  let m = first.create(input(), owner, 0); m = first.setEnabled(m.id, 1, true, 0); let run = first.claim(m.id, owner, 0)!;
  first.complete(run.id, { accountId: "account", items: [item("known")], checkpoint: { x: "one" }, complete: true, detail: "" }, 1);
  first.requestCheck(m.id, 2, 2); run = first.claim(m.id, owner, 2)!; first.close();
  db = new DatabaseSync(file); db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000"); first = new BrowserMonitorStore(db);
  const db2 = new DatabaseSync(file); db2.exec("PRAGMA busy_timeout = 5000"); const second = new BrowserMonitorStore(db2);
  try {
    first.recover(owner, 3); const recovered = first.get(m.id); assert.equal(recovered.generation, 3); assert.deepEqual(recovered.checkpoint, { x: "one" });
    assert.deepEqual(first.complete(run.id, { accountId: "account", items: [item("late")], checkpoint: {}, complete: true, detail: "" }, 4), []);
    const claims = [first.claim(m.id, owner, 3), second.claim(m.id, owner, 3)]; assert.equal(claims.filter(Boolean).length, 1);
  } finally { second.close(); first.close(); }
});

test("paused mutations, event processing, and deletion constraints", () => {
  const x = store(); try {
    const paused = x.store.create(input(), input().binding.nodeId, 0);
    assert.throws(() => x.store.requestCheck(paused.id, paused.generation, 1), /paused/); assert.deepEqual(x.store.get(paused.id), paused);
    for (const extra of [{ ownerNodeId: randomUUID() }, { projectId: "other" }, { accountId: "other" }])
      assert.throws(() => x.store.update(paused.id, paused.generation, { name: "changed", ...extra }));

    let m = x.store.create(input({ name: "Events" }), input().binding.nodeId, 0); m = x.store.setEnabled(m.id, m.generation, true, 0);
    assert.throws(() => x.store.delete(m.id, m.generation), /Pause/);
    let r = x.store.claim(m.id, m.ownerNodeId, 0)!;
    x.store.complete(r.id, { accountId: "account", items: [], checkpoint: {}, complete: true, detail: "" }, 1);
    x.store.requestCheck(m.id, m.generation, 2); r = x.store.claim(m.id, m.ownerNodeId, 2)!;
    x.store.complete(r.id, { accountId: "account", items: [item("one"), item("two")], checkpoint: {}, complete: true, detail: "" }, 3);
    const pending = x.store.pendingEvents(m.id); x.store.markProcessed(pending[0].id);
    assert.deepEqual(x.store.pendingEvents(m.id).map(event => event.id), [pending[1].id]);

    x.store.requestCheck(m.id, m.generation, 4); x.store.claim(m.id, m.ownerNodeId, 4);
    x.db.prepare("UPDATE browser_monitor_monitors SET enabled = 0 WHERE id = ?").run(m.id);
    assert.throws(() => x.store.delete(m.id, m.generation), /already checking/);
  } finally { x.store.close(); }
});

test("failure policy, bounded reads, processing, and paused deletion", () => {
  const x = store(); try {
    let m = x.store.create(input(), input().binding.nodeId, 0); m = x.store.setEnabled(m.id, 1, true, 0); let r = x.store.claim(m.id, m.ownerNodeId, 0)!;
    x.store.fail(r.id, "unavailable", "offline", 1); assert.equal(x.store.get(m.id).nextDueAt, 30001);
    x.store.requestCheck(m.id, 2, 2); r = x.store.claim(m.id, m.ownerNodeId, 2)!; x.store.fail(r.id, "needs-login", "login", 3);
    assert.equal(x.store.get(m.id).enabled, false); assert.throws(() => x.store.history(m.id, 201));
    assert.throws(() => x.store.markProcessed(randomUUID()), /not found/); x.store.delete(m.id, 2); assert.throws(() => x.store.get(m.id), /not found/);
  } finally { x.store.close(); }
});
