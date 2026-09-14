import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { monitorCheckResultSchema, type MonitorCheckResult, type MonitorInput, type MonitorItem } from "../src/browser-monitor-types.js";
import { BrowserMonitorStore } from "../src/browser-monitors.js";
import { resolveDataDirectory } from "../src/data-directory.js";

const binding = () => ({ nodeId: randomUUID(), sessionId: randomUUID(), profileId: randomUUID(), pageId: randomUUID(), engine: "pi" as const, conversationId: "conversation" });
function input(overrides: Partial<MonitorInput> = {}): MonitorInput { return { projectId: "project", name: "Inbox", checkerId: "fixture", checkerVersion: 1, origin: "https://example.com", accountId: "account", targetIds: [], intervalSeconds: 10, binding: binding(), readAcknowledged: true, ...overrides }; }
function item(externalId: string, targetId: string, occurredAt: number | null, overrides: Partial<MonitorItem> = {}): MonitorItem { return { externalId, targetId, targetLabel: targetId, senderId: `sender-${externalId}`, direction: "incoming", kind: "message.received", text: externalId, occurredAt, identity: "stable", ...overrides }; }
function coverage(partitions: Array<{ targetId: string; cursor: string | null; complete: boolean; continuation?: string | null; detail?: string }>, discoveryComplete = false) { return { discoveryComplete, partitions: partitions.map(p => ({ continuation: null, detail: "", ...p })) }; }
function result(partitions: Parameters<typeof coverage>[0], items: MonitorItem[] = [], discoveryComplete = false, checkpoint = Object.fromEntries(partitions.filter(p => p.complete && p.cursor !== null).map(p => [p.targetId, p.cursor]))): MonitorCheckResult { const c = coverage(partitions, discoveryComplete); return monitorCheckResultSchema.parse({ accountId: "account", items, checkpoint, complete: discoveryComplete && partitions.every(p => p.complete), detail: "", coverage: c }); }
function memory() { const db = new DatabaseSync(":memory:"); return { db, store: new BrowserMonitorStore(db) }; }
function enabled(store: BrowserMonitorStore, now = 100, overrides: Partial<MonitorInput> = {}) { let monitor = store.create(input(overrides), randomUUID(), 1); monitor = store.setEnabled(monitor.id, monitor.generation, true, now); return monitor; }
function run(store: BrowserMonitorStore, id: string, owner: string, now: number) { store.requestCheck(id, store.get(id).generation, now); return store.claim(id, owner, now)!; }

test("coverage schema enforces partition consistency and retains legacy results", () => {
  assert.equal(monitorCheckResultSchema.parse({ accountId: "account", items: [], checkpoint: {}, complete: false, detail: "legacy" }).detail, "legacy");
  assert.equal(result([{ targetId: "A", cursor: "a", complete: true }, { targetId: "B", cursor: null, complete: false, continuation: "next" }]).coverage?.partitions.length, 2);
  const base = { accountId: "account", items: [], checkpoint: {}, complete: false, detail: "" };
  assert.throws(() => monitorCheckResultSchema.parse({ ...base, coverage: coverage([{ targetId: "A", cursor: null, complete: false }, { targetId: "A", cursor: null, complete: false }]) }));
  assert.throws(() => monitorCheckResultSchema.parse({ ...base, items: [item("x", "B", 1)], coverage: coverage([{ targetId: "A", cursor: null, complete: false }]) }));
  assert.throws(() => monitorCheckResultSchema.parse({ ...base, complete: true, coverage: coverage([{ targetId: "A", cursor: null, complete: false }], true) }));
  assert.throws(() => monitorCheckResultSchema.parse({ ...base, checkpoint: { A: "a" }, coverage: coverage([{ targetId: "A", cursor: "a", complete: false }]) }));
  assert.throws(() => monitorCheckResultSchema.parse({ ...base, checkpoint: { B: "b" }, coverage: coverage([{ targetId: "A", cursor: null, complete: false }]) }));
  assert.throws(() => monitorCheckResultSchema.parse({ ...base, complete: true, coverage: coverage([{ targetId: "A", cursor: null, complete: true, continuation: "next" }], true) }));
  assert.throws(() => monitorCheckResultSchema.parse({ ...base, coverage: coverage(Array.from({ length: 201 }, (_, i) => ({ targetId: `t${i}`, cursor: null, complete: false }))) }));
  assert.throws(() => monitorCheckResultSchema.parse({ ...base, coverage: coverage(Array.from({ length: 40 }, (_, i) => ({ targetId: `large-${i}`, cursor: null, complete: false, detail: "x".repeat(2000) }))) }));
});

test("partial acquisition persists independent progress and immutable review eligibility", () => {
  const x = memory(); try {
    const m = enabled(x.store, 100); const r = x.store.claim(m.id, m.ownerNodeId, 100)!;
    const events = x.store.complete(r.id, result([{ targetId: "A", cursor: "a1", complete: true }, { targetId: "B", cursor: null, complete: false, continuation: "b-next" }], [item("a-old", "A", 90), item("a-new", "A", 101), item("b-unknown", "B", null)]), 102);
    assert.deepEqual(events.map(e => [e.externalId, e.reviewRequired]), [["a-new", false], ["b-unknown", true]]);
    assert.deepEqual(x.store.get(m.id).checkpoint, { A: "a1" }); assert.equal(x.store.get(m.id).baseline, false); assert.equal(x.store.get(m.id).health, "partial");
    assert.deepEqual(x.store.partitions(m.id).map(p => [p.targetId, p.baseline, p.cursor, p.continuation, p.complete]), [["A", true, "a1", null, true], ["B", false, null, "b-next", false]]);
    const r2 = run(x.store, m.id, m.ownerNodeId, 103); assert.equal(x.store.complete(r2.id, result([{ targetId: "B", cursor: "b1", complete: true }], [item("b-unknown", "B", 103)], true), 104).length, 0);
    assert.equal(x.store.events(m.id).find(e => e.externalId === "b-unknown")?.reviewRequired, true); assert.deepEqual(x.store.get(m.id).checkpoint, { A: "a1", B: "b1" }); assert.equal(x.store.get(m.id).baseline, true);
  } finally { x.store.close(); }
});

test("selected targets become ready after complete coverage is persisted across scans", () => {
  const x = memory(); try {
    const m = enabled(x.store, 100, { targetIds: ["A", "B"] }); let r = x.store.claim(m.id, m.ownerNodeId, 100)!;
    x.store.complete(r.id, result([{ targetId: "A", cursor: "a1", complete: true }], [], true), 100);
    assert.equal(x.store.get(m.id).baseline, false); assert.equal(x.store.get(m.id).health, "partial");
    r = run(x.store, m.id, m.ownerNodeId, 101); x.store.complete(r.id, result([{ targetId: "B", cursor: "b1", complete: true }], [], true), 101);
    assert.equal(x.store.get(m.id).baseline, true); assert.equal(x.store.get(m.id).health, "ready"); assert.deepEqual(x.store.get(m.id).checkpoint, { A: "a1", B: "b1" });
    assert.deepEqual(x.store.partitions(m.id).map(p => [p.targetId, p.cursor, p.complete]), [["A", "a1", true], ["B", "b1", true]]);
  } finally { x.store.close(); }
});

test("partial selected coverage preserves its cursor and blocks later readiness", () => {
  const x = memory(); try {
    const m = enabled(x.store, 100, { targetIds: ["A", "B"] }); let r = x.store.claim(m.id, m.ownerNodeId, 100)!;
    x.store.complete(r.id, result([{ targetId: "A", cursor: "a1", complete: true }]), 101);
    r = run(x.store, m.id, m.ownerNodeId, 102); x.store.complete(r.id, result([{ targetId: "A", cursor: "bogus", complete: false, continuation: "a-next" }]), 103);
    assert.deepEqual(x.store.get(m.id).checkpoint, { A: "a1" }); assert.equal(x.store.get(m.id).baseline, false);
    assert.deepEqual(x.store.partitions(m.id).map(p => [p.targetId, p.baseline, p.cursor, p.continuation, p.complete]), [["A", true, "a1", "a-next", false]]);
    r = run(x.store, m.id, m.ownerNodeId, 104); x.store.complete(r.id, result([{ targetId: "B", cursor: "b1", complete: true }], [], true), 105);
    assert.equal(x.store.get(m.id).health, "partial"); assert.deepEqual(x.store.get(m.id).checkpoint, { A: "a1", B: "b1" });
  } finally { x.store.close(); }
});

test("external identity deduplicates across targets while equal messages with different identities remain distinct", () => {
  const x = memory(); try {
    const m = enabled(x.store, 100); let r = x.store.claim(m.id, m.ownerNodeId, 100)!;
    assert.deepEqual(x.store.complete(r.id, result([{ targetId: "A", cursor: "a", complete: true }], [item("shared", "A", 101, { text: "same" })], true), 101).map(e => e.externalId), ["shared"]);
    r = run(x.store, m.id, m.ownerNodeId, 102);
    const arrivals = [item("shared", "B", 102, { text: "same" }), item("one", "B", 102, { text: "same", senderId: "sender" }), item("two", "B", 102, { text: "same", senderId: "sender" })];
    assert.deepEqual(x.store.complete(r.id, result([{ targetId: "B", cursor: "b", complete: true }], arrivals, true), 103).map(e => e.externalId), ["one", "two"]);
    assert.equal(x.store.events(m.id).length, 3); assert.deepEqual(x.store.pendingEvents(m.id).map(e => e.externalId).sort(), ["one", "shared", "two"]);
  } finally { x.store.close(); }
});

test("omitted and selected partitions prevent false readiness and scope failures roll back", () => {
  const x = memory(); try {
    const m = enabled(x.store, 10, { targetIds: ["A", "B"] }); let r = x.store.claim(m.id, m.ownerNodeId, 10)!;
    x.store.complete(r.id, result([{ targetId: "A", cursor: "a", complete: true }], [], false), 11);
    r = run(x.store, m.id, m.ownerNodeId, 12); x.store.complete(r.id, result([{ targetId: "B", cursor: null, complete: false, continuation: "next" }]), 13);
    r = run(x.store, m.id, m.ownerNodeId, 14); x.store.complete(r.id, result([{ targetId: "A", cursor: "a2", complete: true }], [], true), 15);
    assert.equal(x.store.get(m.id).health, "partial"); assert.equal(x.store.partitions(m.id).find(p => p.targetId === "B")?.continuation, "next");
    r = run(x.store, m.id, m.ownerNodeId, 16); const before = x.store.get(m.id);
    assert.throws(() => x.store.complete(r.id, result([{ targetId: "C", cursor: "c", complete: true }], [item("bad", "C", 16)], true), 17), /outside scope/);
    assert.deepEqual(x.store.get(m.id), before); assert.equal(x.store.history(m.id)[0].status, "running");
  } finally { x.store.close(); }
});

test("activation survives pause and rebind while uncertain and future observations stay safe", () => {
  const x = memory(); try {
    let m = enabled(x.store, 100); let r = x.store.claim(m.id, m.ownerNodeId, 100)!;
    const unsafe = [item("between", "A", 50), item("unknown", "A", null), item("finger", "A", 101, { identity: "fingerprint" }), item("page", "A", 101, { kind: "page.changed" })];
    assert.deepEqual(x.store.complete(r.id, result([{ targetId: "A", cursor: "a", complete: true }], unsafe, true), 102).map(e => [e.externalId, e.reviewRequired]), [["unknown", true], ["finger", true], ["page", true]]);
    m = x.store.setEnabled(m.id, m.generation, false, 103); m = x.store.rebind(m.id, m.generation, binding(), 104); m = x.store.setEnabled(m.id, m.generation, true, 200); r = x.store.claim(m.id, m.ownerNodeId, 200)!;
    assert.deepEqual(x.store.complete(r.id, result([{ targetId: "A", cursor: "b", complete: true }], [item("paused-arrival", "A", 150)], true), 201).map(e => e.externalId), ["paused-arrival"]);
    assert.equal(x.store.pendingEvents(m.id).some(e => e.externalId === "paused-arrival"), true);
    r = run(x.store, m.id, m.ownerNodeId, 202); assert.throws(() => x.store.complete(r.id, result([{ targetId: "A", cursor: "c", complete: true }], [item("future", "A", 204)], true), 203));
    assert.equal(x.store.events(m.id).some(e => e.externalId === "future"), false); assert.equal(x.store.history(m.id)[0].status, "running");
  } finally { x.store.close(); }
});

test("generation fences and insertion failures roll back partition completion", () => {
  const x = memory(); try {
    let m = enabled(x.store, 1); const stale = x.store.claim(m.id, m.ownerNodeId, 1)!; m = x.store.rebind(m.id, m.generation, binding(), 2);
    x.db.prepare("UPDATE browser_monitor_runs SET status='running' WHERE id=?").run(stale.id); x.db.prepare("UPDATE browser_monitor_monitors SET enabled=1 WHERE id=?").run(m.id);
    assert.deepEqual(x.store.complete(stale.id, result([{ targetId: "A", cursor: "a", complete: true }], [item("late", "A", 2)], true), 3), []); assert.equal(x.store.partitions(m.id).length, 0);
    x.db.prepare("UPDATE browser_monitor_runs SET status='cancelled' WHERE id=?").run(stale.id); x.db.prepare("UPDATE browser_monitor_monitors SET next_due_at=3 WHERE id=?").run(m.id); m = x.store.get(m.id); const r = x.store.claim(m.id, m.ownerNodeId, 3)!;
    x.db.exec("CREATE TRIGGER partition_failure BEFORE INSERT ON browser_monitor_events WHEN NEW.external_id='second' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    const before = x.store.get(m.id); assert.throws(() => x.store.complete(r.id, result([{ targetId: "A", cursor: "a", complete: true }], [item("first", "A", 3), item("second", "A", 3)], true), 4), /fixture failure/);
    assert.equal(x.store.events(m.id).length, 0); assert.equal(x.store.partitions(m.id).length, 0); assert.equal(x.store.history(m.id)[0].status, "running"); assert.deepEqual(x.store.get(m.id).checkpoint, before.checkpoint);
    x.db.exec("DROP TRIGGER partition_failure"); assert.deepEqual(x.store.complete(r.id, result([{ targetId: "A", cursor: "a", complete: true }], [item("first", "A", 3), item("second", "A", 3)], true), 5).map(e => e.externalId), ["first", "second"]);
    assert.deepEqual(x.store.get(m.id).checkpoint, { A: "a" }); assert.equal(x.store.history(m.id)[0].status, "succeeded"); assert.deepEqual(x.store.partitions(m.id).map(p => [p.targetId, p.cursor, p.complete]), [["A", "a", true]]);
  } finally { x.store.close(); }
});

test("legacy database migration is idempotent, paginated, and cascades", () => {
  const directory = path.join(resolveDataDirectory(), randomUUID()); mkdirSync(directory, { recursive: true }); const file = path.join(directory, "legacy.db");
  let db = new DatabaseSync(file); db.exec("PRAGMA foreign_keys=ON; CREATE TABLE browser_monitor_monitors (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_node_id TEXT NOT NULL, input TEXT NOT NULL, generation INTEGER NOT NULL, enabled INTEGER NOT NULL, baseline INTEGER NOT NULL, checkpoint TEXT NOT NULL, health TEXT NOT NULL, detail TEXT NOT NULL, next_due_at INTEGER, last_started_at INTEGER, last_finished_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE browser_monitor_events (id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, external_id TEXT NOT NULL, item TEXT NOT NULL, observed_at INTEGER NOT NULL, processed INTEGER NOT NULL, UNIQUE(monitor_id,external_id));");
  const owner = randomUUID(), monitorId = randomUUID(); db.prepare("INSERT INTO browser_monitor_monitors VALUES (?,?,?,?,1,1,1,?,'ready','',0,NULL,NULL,1,1)").run(monitorId, "project", owner, JSON.stringify(input()), JSON.stringify({ legacy: "cursor" })); db.prepare("INSERT INTO browser_monitor_events VALUES (?,?,?,?,?,?)").run(randomUUID(), monitorId, "legacy", JSON.stringify(item("legacy", "legacy", 1)), 1, 0); db.close();
  let store = new BrowserMonitorStore(new DatabaseSync(file)); store.close(); store = new BrowserMonitorStore(new DatabaseSync(file)); try {
    assert.equal(store.events(monitorId)[0].reviewRequired, true); assert.deepEqual(store.get(monitorId).checkpoint, { legacy: "cursor" });
    let claimed = store.claim(monitorId, owner, 0)!; store.complete(claimed.id, result([{ targetId: "legacy", cursor: "bogus", complete: false, continuation: "next" }]), 1);
    assert.deepEqual(store.get(monitorId).checkpoint, { legacy: "cursor" }); assert.deepEqual(store.partitions(monitorId).map(p => [p.targetId, p.baseline, p.cursor, p.complete]), [["legacy", true, "cursor", false]]);
    store.requestCheck(monitorId, store.get(monitorId).generation, 2); claimed = store.claim(monitorId, owner, 2)!; store.complete(claimed.id, result([{ targetId: "A", cursor: "a", complete: true }, { targetId: "B", cursor: "b", complete: true }], [], true), 3);
    assert.deepEqual(store.partitions(monitorId, 1).map(p => p.targetId), ["A"]); assert.deepEqual(store.partitions(monitorId, 100, "A").map(p => p.targetId), ["B", "legacy"]);
    let m = store.get(monitorId); m = store.setEnabled(m.id, m.generation, false, 4); store.delete(m.id, m.generation);
    db = new DatabaseSync(file); assert.equal((db.prepare("SELECT COUNT(*) count FROM browser_monitor_partitions").get() as { count: number }).count, 0); assert.equal((db.prepare("SELECT COUNT(*) count FROM browser_monitor_activation").get() as { count: number }).count, 0); db.close();
  } finally { store.close(); }
});

test("checkpoint size failure rolls back partition and run", () => {
  const x = memory(); try {
    const m = enabled(x.store, 1); const nearLimit = Object.fromEntries(Array.from({ length: 499 }, (_, i) => [`seed-${i}`, "x".repeat(110)])); x.db.prepare("UPDATE browser_monitor_monitors SET checkpoint=? WHERE id=?").run(JSON.stringify(nearLimit), m.id);
    const r = x.store.claim(m.id, m.ownerNodeId, 1)!; assert.throws(() => x.store.complete(r.id, result([{ targetId: "A", cursor: "y".repeat(8192), complete: true }], [], true), 2), /Checkpoint is too large/);
    assert.equal(x.store.partitions(m.id).length, 0); assert.equal(x.store.history(m.id)[0].status, "running");
  } finally { x.store.close(); }
});
