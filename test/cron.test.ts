import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const input = () => ({ name: "Report", prompt: "Report progress", projectId: "project", ownerNodeId: randomUUID(), engine: "claude" as const, sessionId: null, enabled: true, schedule: { frequency: "daily" as const, hour: 9, minute: 15, weekday: 1, timezone: "America/New_York" } });

test("easy schedules use timezone, skip DST gaps and do not repeat a daily fall-back time", async () => {
  const { nextCronRun } = await import("../src/cron.js");
  const schedule = input().schedule;
  assert.equal(nextCronRun(schedule, Date.parse("2026-03-07T15:00:00Z")), Date.parse("2026-03-08T13:15:00Z"));
  assert.equal(nextCronRun({ ...schedule, hour: 2, minute: 30 }, Date.parse("2026-03-08T06:59:00Z")), Date.parse("2026-03-09T06:30:00Z"));
  assert.equal(nextCronRun({ ...schedule, hour: 1, minute: 30 }, Date.parse("2026-11-01T05:30:00Z")), Date.parse("2026-11-02T06:30:00Z"));
  assert.equal(nextCronRun({ ...schedule, frequency: "weekly", timezone: "UTC" }, Date.parse("2026-03-03T10:00:00Z")), Date.parse("2026-03-09T09:15:00Z"));
  assert.equal(nextCronRun({ ...schedule, frequency: "hourly", timezone: "Asia/Kathmandu" }, Date.parse("2026-03-03T10:00:00Z")), Date.parse("2026-03-03T10:30:00Z"));
});

test("weekly schedules skip a DST gap even when the next valid week is more than nine days away", async () => {
  const { nextCronRun } = await import("../src/cron.js");
  const schedule = { ...input().schedule, frequency: "weekly" as const, weekday: 0, hour: 2, minute: 30 };
  assert.equal(nextCronRun(schedule, Date.parse("2026-03-02T12:00:00Z")), Date.parse("2026-03-15T06:30:00Z"));
});

test("cron validates schedule and required user input", async () => {
  const { cronInputSchema } = await import("../src/cron.js");
  for (const invalid of [{ name: " " }, { prompt: "" }, { ownerNodeId: "bad" }, { schedule: { ...input().schedule, timezone: "Mars" } }, { schedule: { ...input().schedule, hour: 24 } }]) {
    assert.equal(cronInputSchema.safeParse({ ...input(), ...invalid }).success, false);
  }
  assert.equal(cronInputSchema.safeParse(input()).success, true);
});

test("SQLite claims are owner-only, unique, non-overlapping and survive reopen; offline runs skip", async () => {
  const { CronStore } = await import("../src/cron.js");
  const db = new DatabaseSync(":memory:");
  try {
    const store = new CronStore(db);
    const data = input();
    const now = Date.parse("2026-03-03T13:00:00Z");
    const task = store.create(data, now);
    assert.equal(store.claim(task.id, randomUUID(), task.nextRun), null);
    const run = store.claim(task.id, data.ownerNodeId, task.nextRun);
    assert.ok(run, "owner should claim due task");
    assert.equal(store.claim(task.id, data.ownerNodeId, task.nextRun), null);
    const reopened = new CronStore(db);
    assert.equal(reopened.list("project")[0].lastRun?.id, run.id);
    assert.equal(reopened.claim(task.id, data.ownerNodeId, task.nextRun + 86400000), null);
    reopened.finish(run.id, "succeeded", null);
    assert.equal(reopened.list("project")[0].lastRun?.status, "succeeded");
    const missed = store.create(data, now);
    assert.equal(store.claim(missed.id, data.ownerNodeId, missed.nextRun + 3600000), null);
    assert.ok(store.get(missed.id)!.nextRun > missed.nextRun + 3600000);
    store.update(task.id, { ...data, enabled: false }, now);
    assert.equal(store.claim(task.id, data.ownerNodeId, now + 86400000), null);
    store.delete(task.id);
    assert.equal(store.get(task.id), null);
  } finally { db.close(); }
});

test("interrupted scheduled runs pause on restart and never replay an uncertain dispatch", async () => {
  const { CronStore } = await import("../src/cron.js");
  const db = new DatabaseSync(":memory:");
  try {
    const store = new CronStore(db), data = input();
    const task = store.create(data);
    const run = store.claim(task.id, data.ownerNodeId, task.nextRun)!;
    store.target(run.id, "conversation");
    store.recover();
    const recovered = store.get(task.id)!;
    assert.equal(recovered.enabled, false);
    assert.equal(recovered.lastRun?.status, "failed");
    assert.match(recovered.lastRun!.error!, /outcome uncertain/);
    assert.equal(recovered.lastRun?.sessionId, "conversation");
    assert.equal(store.claim(task.id, data.ownerNodeId, task.nextRun + 86400000), null);
  } finally { db.close(); }
});

test("startup skips even a just-missed offline occurrence", async () => {
  const { CronStore } = await import("../src/cron.js");
  const db = new DatabaseSync(":memory:");
  try {
    const store = new CronStore(db), data = input();
    const task = store.create(data);
    store.recover(task.nextRun + 1000);
    assert.equal(store.claim(task.id, data.ownerNodeId, task.nextRun + 1000), null);
    assert.ok(store.get(task.id)!.nextRun > task.nextRun + 1000);
  } finally { db.close(); }
});

test("cron provenance survives concurrent discovery records in either replication order without reviving deletions", async () => {
  const { applyConversationRecordEvent, ensureConversationRecordSchema } = await import("../src/conversation-records.js");
  const db = new DatabaseSync(":memory:");
  try {
    ensureConversationRecordSchema(db);
    const projectId = "project", engine = "pi" as const, sessionId = randomUUID(), originNodeId = randomUUID(), cronTaskId = randomUUID();
    const event = (updatedAt: string, scheduled: boolean, deleted = false) => ({
      id: randomUUID(), originNodeId, entityType: "conversation.record", entityKey: `${projectId}:${engine}:${sessionId}`, operation: deleted ? "delete" : "upsert",
      payload: { projectId, engine, sessionId, updatedAt, originNodeId, record: deleted ? null : { projectId, engine, sessionId, updatedAt, createdAt: updatedAt, originNodeId, taskId: null, ...(scheduled ? { cronTaskId } : {}) } }, createdAt: updatedAt,
    });
    const scheduled = event("2026-03-01T00:00:00.000Z", true), discovered = event("2026-03-01T00:00:01.000Z", false);
    for (const events of [[scheduled, discovered], [discovered, scheduled]]) {
      db.exec("DELETE FROM conversation_records");
      for (const change of events) applyConversationRecordEvent(db, change);
      assert.equal(db.prepare("SELECT cron_task_id FROM conversation_records").get()!.cron_task_id, cronTaskId, "concurrent discovery must not erase scheduled provenance");
    }
    applyConversationRecordEvent(db, event("2026-03-01T00:00:02.000Z", false, true));
    applyConversationRecordEvent(db, scheduled);
    assert.equal(db.prepare("SELECT count(*) AS n FROM conversation_records").get()!.n, 0, "late provenance must not resurrect a deleted conversation");
  } finally { db.close(); }
});

test("owner migration keeps task identity and settled history and refuses active history", async () => {
  const { CronStore } = await import("../src/cron.js");
  const a = new DatabaseSync(":memory:"), b = new DatabaseSync(":memory:");
  try {
    const source = new CronStore(a), destination = new CronStore(b), data = input();
    const task = source.create(data);
    const run = source.claim(task.id, data.ownerNodeId, task.nextRun)!;
    const moved = { ...data, ownerNodeId: randomUUID(), enabled: false };
    assert.throws(() => destination.install(task.id, moved, source.history(task.id)), /settled history/);
    source.finish(run.id, "succeeded", null);
    source.update(task.id, { ...data, enabled: false });
    const installed = destination.install(task.id, moved, source.history(task.id));
    assert.equal(installed.id, task.id);
    assert.equal(installed.enabled, false);
    assert.equal(installed.lastRun?.id, run.id);
    assert.equal(installed.lastRun?.status, "succeeded");
    assert.equal(source.claim(task.id, data.ownerNodeId, task.nextRun + 86400000), null);
    assert.equal(destination.claim(task.id, moved.ownerNodeId, task.nextRun + 86400000), null);
  } finally { a.close(); b.close(); }
});
