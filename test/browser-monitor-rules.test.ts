import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { browserMonitorRuleCandidates, browserMonitorRuleInputSchema, browserMonitorRuleRevision, type BrowserMonitorRuleInput, type BrowserMonitorRuleRecord } from "../src/browser-monitor-rules.js";
import type { MonitorEvent, MonitorInput } from "../src/browser-monitor-types.js";
import { BrowserMonitorStore } from "../src/browser-monitors.js";
import { resolveDataDirectory } from "../src/data-directory.js";

const ids = () => ({ nodeId: randomUUID(), sessionId: randomUUID(), profileId: randomUUID(), pageId: randomUUID() });
function monitorInput(overrides: Partial<MonitorInput> = {}): MonitorInput { return { projectId: "project", name: "Inbox", checkerId: "fixture", checkerVersion: 1, origin: "https://example.com", accountId: "account", targetIds: [], intervalSeconds: 10, binding: { ...ids(), engine: "pi", conversationId: "conversation" }, readAcknowledged: true, ...overrides }; }
function rule(overrides: Partial<BrowserMonitorRuleInput> = {}): BrowserMonitorRuleInput { return { name: "Rule", priority: 0, targetIds: [], senderIds: [], excludedTargetIds: [], excludedSenderIds: [], textContains: null, caseSensitive: false, aiCondition: null, action: { type: "notify" }, cooldownSeconds: 60, maxRepliesPerHour: 1, ...overrides }; }
function event(overrides: Partial<MonitorEvent> = {}): MonitorEvent { return { id: "event", monitorId: "monitor", externalId: "external", targetId: "Target", targetLabel: "Inbox", senderId: "Sender", direction: "incoming", kind: "message.received", text: "Hello World", occurredAt: 100, identity: "stable", observedAt: 100, processed: false, ...overrides }; }
function record(id: string, overrides: Partial<BrowserMonitorRuleRecord> = {}): BrowserMonitorRuleRecord { return { id, monitorId: "monitor", version: 1, input: rule(), enabled: true, activatedAt: 1, createdAt: 1, updatedAt: 1, ...overrides }; }
function store() { const db = new DatabaseSync(":memory:"); return { db, store: new BrowserMonitorStore(db) }; }

test("rule schema is strict, bounded, and supports only declared actions", () => {
  for (const action of [{ type: "ignore" }, { type: "notify" }, { type: "reply", mode: "approval", content: { type: "fixed", text: " answer " } }, { type: "reply", mode: "automatic", content: { type: "ai", instructions: " answer ", provider: "p", modelId: "m" } }]) assert.equal(browserMonitorRuleInputSchema.parse(rule({ action } as Partial<BrowserMonitorRuleInput>)).name, "Rule");
  assert.equal(browserMonitorRuleInputSchema.parse(rule({ textContains: "  x  " })).textContains, "  x  ");
  const invalid = [rule({ targetIds: ["x", "x"] }), rule({ senderIds: Array.from({ length: 201 }, (_, i) => String(i)) }), { ...rule(), regex: "x" }, rule({ aiCondition: { question: "why", provider: "p", modelId: "m" }, action: { type: "ignore" } }), rule({ action: { type: "reply", mode: "automatic", content: { type: "ai", instructions: "x", provider: "", modelId: "m" } } }), rule({ cooldownSeconds: 59 }), rule({ maxRepliesPerHour: 61 })];
  for (const value of invalid) assert.throws(() => browserMonitorRuleInputSchema.parse(value));
  for (const field of ["targetIds", "senderIds", "excludedTargetIds", "excludedSenderIds"] as const) {
    assert.throws(() => browserMonitorRuleInputSchema.parse(rule({ [field]: [""] })));
    assert.equal(browserMonitorRuleInputSchema.parse(rule({ [field]: ["x".repeat(320)] }))[field][0].length, 320);
    assert.throws(() => browserMonitorRuleInputSchema.parse(rule({ [field]: ["x".repeat(321)] })));
  }
});

test("rule lifecycle is paused, version-fenced, isolated, and deletion is explicit", () => {
  const x = store(); try {
    const monitor = x.store.create(monitorInput(), randomUUID(), 1); const other = x.store.create(monitorInput({ name: "Other" }), randomUUID(), 1);
    const created = x.store.createRule(monitor.id, rule(), 2); assert.equal(created.version, 1); assert.equal(created.enabled, false); assert.equal(created.activatedAt, null);
    assert.throws(() => x.store.getRule(other.id, created.id), /not found/);
    const changed = x.store.updateRule(monitor.id, created.id, 1, rule({ name: "Changed" }), 3); assert.equal(changed.version, 2); assert.equal(changed.enabled, false); assert.equal(changed.activatedAt, null); assert.equal(changed.monitorId, monitor.id); assert.equal(changed.id, created.id);
    assert.throws(() => x.store.updateRule(monitor.id, created.id, 1, rule(), 4), /changed/); assert.deepEqual(x.store.getRule(monitor.id, created.id), changed);
    const enabled = x.store.setRuleEnabled(monitor.id, created.id, 2, true, 4); assert.equal(enabled.version, 3); assert.equal(enabled.activatedAt, 4); assert.throws(() => x.store.deleteRule(monitor.id, created.id, 3), /Pause/);
    const disabled = x.store.setRuleEnabled(monitor.id, created.id, 3, false, 5); assert.equal(disabled.version, 4); x.store.deleteRule(monitor.id, created.id, 4); assert.equal(x.store.listRules(monitor.id).length, 0);
  } finally { x.store.close(); }
});

test("rules survive monitor pause and rebind, cascade with monitor, and stop at 200", () => {
  const x = store(); try {
    let monitor = x.store.create(monitorInput(), randomUUID(), 1); const firstRule = x.store.createRule(monitor.id, rule(), 2);
    monitor = x.store.setEnabled(monitor.id, monitor.generation, true, 3); monitor = x.store.setEnabled(monitor.id, monitor.generation, false, 4); monitor = x.store.rebind(monitor.id, monitor.generation, { ...monitor.binding, pageId: randomUUID() }, 5); assert.equal(x.store.listRules(monitor.id).length, 1);
    for (let i = 1; i < 200; i++) x.store.createRule(monitor.id, rule({ name: `Rule ${i}` }), i + 10);
    assert.throws(() => x.store.createRule(monitor.id, rule({ name: "Extra" })), /too many/); assert.equal(x.store.listRules(monitor.id).length, 200);
    x.store.delete(monitor.id, monitor.generation); assert.throws(() => x.store.getRule(monitor.id, firstRule.id), /not found/); assert.equal((x.db.prepare("SELECT COUNT(*) AS count FROM browser_monitor_rules").get() as { count: number }).count, 0);
  } finally { x.store.close(); }
});

test("legacy enabled rules migrate paused once without historical activation", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE browser_monitor_monitors (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_node_id TEXT NOT NULL, input TEXT NOT NULL, generation INTEGER NOT NULL, enabled INTEGER NOT NULL, baseline INTEGER NOT NULL, checkpoint TEXT NOT NULL, health TEXT NOT NULL, detail TEXT NOT NULL, next_due_at INTEGER, last_started_at INTEGER, last_finished_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE browser_monitor_rules (id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, version INTEGER NOT NULL, input TEXT NOT NULL, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  const monitorId = randomUUID(); const ruleId = randomUUID();
  db.prepare("INSERT INTO browser_monitor_monitors VALUES (?,?,?, ?,1,0,0,'{}','paused','',NULL,NULL,NULL,1,1)").run(monitorId, "project", randomUUID(), JSON.stringify(monitorInput()));
  db.prepare("INSERT INTO browser_monitor_rules VALUES (?,?,4,?,1,2,3)").run(ruleId, monitorId, JSON.stringify(rule({ name: "Legacy" })));
  let migrated = new BrowserMonitorStore(db); const first = migrated.getRule(monitorId, ruleId);
  assert.equal(first.enabled, false); assert.equal(first.version, 5); assert.equal(first.activatedAt, null); assert.equal(first.input.name, "Legacy");
  migrated = new BrowserMonitorStore(db); const reopened = migrated.getRule(monitorId, ruleId);
  assert.equal(reopened.version, 5); assert.equal(reopened.activatedAt, null); migrated.close();
});

test("disk reopen retains rule versions", () => {
  const directory = path.join(resolveDataDirectory(), randomUUID()); mkdirSync(directory, { recursive: true }); const file = path.join(directory, "node.db");
  let store = new BrowserMonitorStore(new DatabaseSync(file)); const monitor = store.create(monitorInput(), randomUUID(), 1); let saved = store.createRule(monitor.id, rule(), 2); saved = store.setRuleEnabled(monitor.id, saved.id, 1, true, 3); store.close();
  store = new BrowserMonitorStore(new DatabaseSync(file)); try { assert.deepEqual(store.getRule(monitor.id, saved.id), saved); } finally { store.close(); }
});

test("activation permits only newly observed and provider-dated arrivals", () => {
  const active = record("active", { createdAt: 10, activatedAt: 100 });
  assert.deepEqual(browserMonitorRuleCandidates(event({ observedAt: 90, occurredAt: 80 }), [active]), []);
  assert.deepEqual(browserMonitorRuleCandidates(event({ observedAt: 110, occurredAt: 80 }), [active]), []);
  assert.deepEqual(browserMonitorRuleCandidates(event({ observedAt: 110, occurredAt: 101 }), [active]).map(value => value.id), ["active"]);
  assert.deepEqual(browserMonitorRuleCandidates(event({ observedAt: 110, occurredAt: null, reviewRequired: true }), [active]).map(value => value.id), ["active"]);
  assert.deepEqual(browserMonitorRuleCandidates(event({ observedAt: 110 }), [record("legacy", { activatedAt: null })]), []);
});

test("rule revision is ordered, complete, and does not mutate input", () => {
  const rules = [record("b"), record("a", { version: 2, activatedAt: 3 })]; const before = structuredClone(rules);
  const revision = browserMonitorRuleRevision(rules);
  assert.equal(browserMonitorRuleRevision([...rules].reverse()), revision); assert.deepEqual(rules, before);
  assert.notEqual(browserMonitorRuleRevision([...rules, record("c")]), revision);
  assert.notEqual(browserMonitorRuleRevision([rules[0], { ...rules[1], version: 3 }]), revision);
  assert.notEqual(browserMonitorRuleRevision([rules[0], { ...rules[1], activatedAt: 4 }]), revision);
});

test("candidate eligibility and ordering are deterministic without mutation", () => {
  const e = event(); const ai = record("ai", { input: rule({ priority: 100, aiCondition: { question: "Relevant?", provider: "p", modelId: "m" }, action: { type: "reply", mode: "approval", content: { type: "fixed", text: "yes" } } }) });
  const ignore = record("ignore", { input: rule({ priority: -100, targetIds: ["Target"], action: { type: "ignore" } }), createdAt: 2 });
  const specific = record("specific", { input: rule({ priority: 10, senderIds: ["Sender"] }), createdAt: 3 }); const broad = record("broad", { input: rule({ priority: 10 }), createdAt: 2 });
  const rules = [ai, broad, specific, ignore]; const before = structuredClone(rules); assert.deepEqual(browserMonitorRuleCandidates(e, rules).map(r => r.id), ["ignore", "ai", "specific", "broad"]); assert.deepEqual(rules, before); assert.equal(e.processed, false);
  assert.deepEqual(browserMonitorRuleCandidates(e, [record("other", { monitorId: "other" })]), [], "cross-monitor rule must not match");
  for (const changed of [{ direction: "outgoing" as const }, { kind: "message.edited" as const }, { processed: true }]) assert.deepEqual(browserMonitorRuleCandidates(event(changed), rules), []);
  assert.deepEqual(browserMonitorRuleCandidates(event({ observedAt: 0 }), rules), []);
});

test("disabled rules do not match", () => {
  const disabled = record("disabled", { enabled: false });
  assert.deepEqual(browserMonitorRuleCandidates(event(), [disabled]), [], "Disabled rules must not match");
  assert.deepEqual(browserMonitorRuleCandidates(event(), [record("enabled")]).map(candidate => candidate.id), ["enabled"]);
});

test("candidate scope, exclusions, text matching, and stable ties use opaque IDs", () => {
  const candidates = [
    record("excluded-sender", { input: rule({ excludedSenderIds: ["Sender"] }) }),
    record("excluded-target", { input: rule({ excludedTargetIds: ["Target"] }) }),
    record("wrong-target", { input: rule({ targetIds: ["target"] }) }),
    record("wrong-sender", { input: rule({ senderIds: ["sender"] }) }),
    record("fold", { input: rule({ textContains: "hello world" }) }),
    record("case", { input: rule({ textContains: "hello world", caseSensitive: true }) }),
    record("combined", { input: rule({ targetIds: ["Target"], senderIds: ["Sender"] }), createdAt: 3 }),
    record("target", { input: rule({ targetIds: ["Target"] }), createdAt: 2 }),
    record("sender", { input: rule({ senderIds: ["Sender"] }), createdAt: 1 }),
    record("tie-b", { createdAt: 9 }), record("tie-a", { createdAt: 9 }),
  ];
  assert.deepEqual(browserMonitorRuleCandidates(event(), candidates).map(r => r.id), ["combined", "target", "sender", "fold", "tie-a", "tie-b"]);
  assert.deepEqual(browserMonitorRuleCandidates(event({ kind: "page.changed" }), [record("page-notification")]).map(candidate => candidate.id), ["page-notification"]);
});
