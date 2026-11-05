import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { bobRow, compareRows, describeSchedule, isSimpleSchedule, rowMatchesFilter, scheduleRow, webhookRow, type AutomationRow, type RowContext } from "../src/control-center/automations.js";
import { REPORT_ITEM_ACTIONS, describeFacts, reportActions, reportItemSchema, type ReportFacts, type ReportItem } from "../src/control-center/bob-reports.js";
import {
  bobScheduleInputSchema, claimDueBobSchedules, createBobSchedule, deleteBobSchedule, ensureBobScheduleSchema, getBobSchedule, listBobSchedules, nextBobWake, nextReportRun,
  recordBobScheduleRun, updateBobSchedule,
} from "../src/control-center/bob-schedules.js";
import type { CronTask } from "../src/cron.js";
import { handleBobAutomation, parseIntent } from "../src/server/control-center-automation-chat.js";
import type { Webhook } from "../src/webhooks.js";

const context: RowContext = { projectName: (id) => ({ p1: "Joint Bob", p2: "Contigos" })[id] ?? id, nodeName: (id) => (id === "n1" ? "Homeserver" : null), accountId: "ilia" };

function task(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: "t1", assistantId: null, tags: { managedTagIds: [], manualTags: [] }, projectId: "p1", name: "Nightly release check", prompt: "Run the release gate,\n  report only", ownerNodeId: "n1", engine: "claude",
    model: null, sessionId: null, enabled: true, pauseOnFailure: false, markForReview: false, hideFromHistory: false, creatorAccountId: "ilia", nextRun: 0, lastRun: null,
    schedule: { frequency: "daily", hour: 2, minute: 0, weekday: 1, timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6] },
    ...overrides,
  } as CronTask;
}

function hook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: "h1", name: "GitHub issues", tags: { managedTagIds: [], manualTags: [] }, target: { kind: "project", projectId: "p2" }, secretAccountIds: [], model: null, reasoning: null, titleTemplate: "",
    context: "Triage the issue", enabled: true, attachments: false, markForReview: false, hideFromHistory: false, preserveFiles: false, reply: null, senders: null,
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", lastReceivedAt: null, receivedCount: 0, creatorAccountId: "ilia", ...overrides,
  };
}

test("a schedule reads the way the table shows it", () => {
  const base = { hour: 8, minute: 5, weekday: 1, timezone: "UTC" } as const;
  assert.equal(describeSchedule({ ...base, frequency: "daily" }), "Daily 08:05");
  assert.equal(describeSchedule({ ...base, frequency: "daily", days: [0, 1, 2, 3, 4, 5, 6] }), "Daily 08:05");
  assert.equal(describeSchedule({ ...base, frequency: "daily", days: [5, 1] }), "Daily 08:05 · Mon, Fri");
  assert.equal(describeSchedule({ ...base, frequency: "weekly" }), "Mon 08:05");
  assert.equal(describeSchedule({ ...base, frequency: "hourly", intervalHours: 1 }), "Every hour at :05");
  assert.equal(describeSchedule({ ...base, frequency: "hourly", intervalHours: 3 }), "Every 3 hours at :05");
  assert.equal(describeSchedule({ ...base, frequency: "minutely", intervalMinutes: 15 }), "Every 15 minutes");
  assert.equal(describeSchedule({ ...base, frequency: "minutely", intervalMinutes: 1 }), "Every minute");
});

test("only schedules the compact editor can rewrite without loss are editable there", () => {
  const base = { hour: 8, minute: 0, weekday: 1, timezone: "UTC" } as const;
  assert.equal(isSimpleSchedule({ ...base, frequency: "daily", days: [0, 1, 2, 3, 4, 5, 6] }), true);
  assert.equal(isSimpleSchedule({ ...base, frequency: "weekly" }), true);
  assert.equal(isSimpleSchedule({ ...base, frequency: "hourly", intervalHours: 1, startHour: 8 }), true);
  assert.equal(isSimpleSchedule({ ...base, frequency: "hourly", intervalHours: 1 }), false, "a legacy hourly interval has no start hour");
  assert.equal(isSimpleSchedule({ ...base, frequency: "hourly", intervalHours: 2, startHour: 8 }), false);
  assert.equal(isSimpleSchedule({ ...base, frequency: "minutely", intervalMinutes: 5 }), false);
  assert.equal(isSimpleSchedule({ ...base, frequency: "daily", days: [1, 2] }), false);
  assert.equal(isSimpleSchedule({ ...base, frequency: "daily", quietStart: "22:00", quietEnd: "06:00" }), false);
});

test("a scheduled task becomes a row with its last result, and is the creator's to change", () => {
  const never = scheduleRow(task(), context);
  assert.deepEqual([never.kind, never.name, never.projectName, never.nodeName, never.when, never.last.state, never.editable], ["schedule", "Nightly release check", "Joint Bob", "Homeserver", "Daily 02:00", "never", true]);
  assert.equal(never.detail, "Run the release gate, report only", "the second line is one line");
  assert.deepEqual(never.edit, { kind: "schedule", prompt: "Run the release gate,\n  report only", frequency: "daily", time: "02:00", weekday: 1, timezone: "UTC", simple: true });

  const run = { id: "r", taskId: "t1", dueAt: Date.UTC(2026, 10, 5, 2), sessionId: "s", tags: [] };
  assert.deepEqual(scheduleRow(task({ lastRun: { ...run, status: "succeeded", error: null, finishedAt: Date.UTC(2026, 10, 5, 2, 3) } }), context).last, { state: "ok", at: "2026-11-05T02:03:00.000Z", detail: null });
  assert.deepEqual(scheduleRow(task({ lastRun: { ...run, status: "failed", error: "Budget reached: daily", finishedAt: Date.UTC(2026, 10, 5, 2, 3) } }), context).last, { state: "failed", at: "2026-11-05T02:03:00.000Z", detail: "Budget reached: daily" });
  assert.equal(scheduleRow(task({ lastRun: { ...run, status: "running", error: null, finishedAt: null } }), context).last.state, "running");
  assert.equal(scheduleRow(task({ enabled: false }), context).last.state, "paused");
  assert.equal(scheduleRow(task({ enabled: false, lastRun: { ...run, status: "succeeded", error: null, finishedAt: 1 } }), context).last.state, "paused", "a paused task reads as paused, whatever it did last");

  assert.equal(scheduleRow(task({ creatorAccountId: "someone-else" }), context).editable, false);
  assert.equal(scheduleRow(task({ creatorAccountId: null }), context).editable, true, "a task from before accounts belongs to whoever sees it");
  const minutely = scheduleRow(task({ schedule: { frequency: "minutely", intervalMinutes: 5, hour: 0, minute: 0, weekday: 1, timezone: "UTC" } }), context);
  assert.equal((minutely.edit as { simple: boolean }).simple, false);
});

test("a webhook becomes a row: where its calls go, who may call, and how the last call went", () => {
  const row = (overrides: Partial<Webhook> = {}, delivery?: { at: string; status: "delivered" | "failed" | "refused"; detail: string; sender: null }) => webhookRow(hook(overrides), { ...context, nodeId: "n1", delivery });
  const fresh = row();
  assert.deepEqual([fresh.kind, fresh.projectName, fresh.when, fresh.last.state, fresh.nodeName], ["webhook", "Contigos", "Starts a conversation · anyone with the address", "never", "Homeserver"]);
  assert.equal(row({ target: { kind: "conversation", projectId: "p2", sessionId: "s", engine: "claude" } }).when.startsWith("Adds to a conversation"), true);
  assert.equal(row({ target: { kind: "assistant", projectId: "p2", assistantId: "a" } }).when.startsWith("Goes to a personal assistant"), true);
  assert.match(row({ senders: { fields: ["message.from.id"], allowed: [{ value: "1", label: "" }, { value: "2", label: "" }] } }).when, /2 allowed senders$/);
  assert.equal(row({ lastReceivedAt: "2026-11-05T10:00:00Z" }).last.state, "ok");
  assert.deepEqual(row({ lastReceivedAt: "2026-11-05T10:00:00Z" }, { at: "2026-11-05T10:00:00Z", status: "failed", detail: "No agent", sender: null }).last, { state: "failed", at: "2026-11-05T10:00:00Z", detail: "No agent" });
  assert.equal(row({}, { at: "2026-11-05T10:00:00Z", status: "refused", detail: "Refused sender", sender: null }).last.state, "refused");
  assert.equal(row({ enabled: false, lastReceivedAt: "2026-11-05T10:00:00Z" }).last.state, "paused");
  assert.equal(row({ creatorAccountId: "someone-else" }).editable, false);
  assert.deepEqual(fresh.edit, { kind: "webhook", context: "Triage the issue" });
});

test("rows follow the project filter, and Bob's reports for every project always show", () => {
  const rows = [
    scheduleRow(task(), context),
    webhookRow(hook(), { ...context, nodeId: "n1", delivery: undefined }),
    bobRow({ id: "b1", accountId: "ilia", report: "morning", name: "Morning report", hour: 8, minute: 0, timezone: "UTC", projectIds: [], enabled: true, nextRun: 0, lastRun: null, lastStatus: null, lastNote: null, createdAt: "", updatedAt: "" }, { ...context, nodeId: "n1", nodeName: "Homeserver" }),
    bobRow({ id: "b2", accountId: "ilia", report: "evening", name: "Evening report", hour: 19, minute: 0, timezone: "UTC", projectIds: ["p2"], enabled: true, nextRun: 0, lastRun: null, lastStatus: null, lastNote: null, createdAt: "", updatedAt: "" }, { ...context, nodeId: "n1", nodeName: "Homeserver" }),
  ];
  const names = (filter: string[]) => rows.filter((row) => rowMatchesFilter(row, filter)).map((row) => row.name);
  assert.deepEqual(names([]), ["Nightly release check", "GitHub issues", "Morning report", "Evening report"]);
  assert.deepEqual(names(["p1"]), ["Nightly release check", "Morning report"]);
  assert.deepEqual(names(["p2"]), ["GitHub issues", "Morning report", "Evening report"]);
  assert.deepEqual(names(["p1", "p2"]), ["Nightly release check", "GitHub issues", "Morning report", "Evening report"]);
  assert.deepEqual([...rows].sort(compareRows).map((row: AutomationRow) => row.name), ["Evening report", "Morning report", "Nightly release check", "GitHub issues"]);
  assert.equal(rows[2].projectName, "All projects");
  assert.equal(rows[3].projectName, "Contigos");
});

function schedules(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureBobScheduleSchema(db);
  ensureBobScheduleSchema(db);
  return db;
}

test("Bob's morning and evening reports default to 08:00 and 19:00 and are the person's own", () => {
  const db = schedules();
  const now = Date.UTC(2026, 10, 5, 6, 30);
  const morning = createBobSchedule(db, "ilia", { report: "morning", timezone: "UTC" }, now);
  const evening = createBobSchedule(db, "ilia", { report: "evening", timezone: "UTC", projectIds: ["p1", "p1", "p2"], name: "End of day" }, now);
  assert.deepEqual([morning.name, morning.hour, morning.minute, morning.enabled, morning.projectIds], ["Morning report", 8, 0, true, []]);
  assert.deepEqual([evening.name, evening.hour, evening.minute, evening.projectIds], ["End of day", 19, 0, ["p1", "p2"]]);
  assert.equal(morning.nextRun, Date.UTC(2026, 10, 5, 8), "later today");
  assert.equal(createBobSchedule(db, "ilia", { report: "morning", timezone: "UTC", time: "06:00" }, now).nextRun, Date.UTC(2026, 10, 6, 6), "a time that has passed is tomorrow");
  createBobSchedule(db, "someone-else", { report: "morning", timezone: "UTC" }, now);
  assert.deepEqual(listBobSchedules(db, "ilia").map((item) => item.name), ["Morning report", "Morning report", "End of day"]);
  assert.equal(getBobSchedule(db, "someone-else", morning.id), undefined, "one person's schedule is not another's");
  assert.equal(updateBobSchedule(db, "someone-else", morning.id, { enabled: false }), undefined);
  assert.equal(deleteBobSchedule(db, "someone-else", morning.id), false);
  assert.equal(deleteBobSchedule(db, "ilia", morning.id), true);
  assert.equal(getBobSchedule(db, "ilia", morning.id), undefined);
});

test("the next time is the wall clock of the schedule's own timezone", () => {
  assert.equal(nextReportRun(8, 0, "UTC", Date.UTC(2026, 10, 5, 7, 59)), Date.UTC(2026, 10, 5, 8));
  assert.equal(nextReportRun(8, 0, "UTC", Date.UTC(2026, 10, 5, 8, 0)), Date.UTC(2026, 10, 6, 8), "at its time it is already tomorrow's");
  assert.equal(nextReportRun(19, 0, "Asia/Jerusalem", Date.UTC(2026, 10, 5, 10, 0)), Date.UTC(2026, 10, 5, 17), "19:00 in Jerusalem in November is 17:00 UTC");
  assert.equal(nextReportRun(19, 0, "America/New_York", Date.UTC(2026, 10, 5, 10, 0)), Date.UTC(2026, 10, 5, 24), "19:00 in New York in November is midnight UTC");
});

test("a changed time, zone or turning it back on works out the next time again; a rename does not", () => {
  const db = schedules();
  const now = Date.UTC(2026, 10, 5, 6, 30);
  const item = createBobSchedule(db, "ilia", { report: "morning", timezone: "UTC" }, now);
  assert.equal(updateBobSchedule(db, "ilia", item.id, { name: "Daybreak" }, now + 1000)!.nextRun, item.nextRun);
  assert.equal(updateBobSchedule(db, "ilia", item.id, { time: "07:15" }, now)!.nextRun, Date.UTC(2026, 10, 5, 7, 15));
  assert.equal(updateBobSchedule(db, "ilia", item.id, { timezone: "Asia/Jerusalem" }, now)!.nextRun, Date.UTC(2026, 10, 6, 5, 15), "07:15 in Jerusalem is 05:15 UTC, which has passed today: the next is tomorrow's");
  const off = updateBobSchedule(db, "ilia", item.id, { enabled: false }, now)!;
  assert.equal(off.enabled, false);
  const later = Date.UTC(2026, 10, 9, 12);
  assert.equal(updateBobSchedule(db, "ilia", item.id, { enabled: true }, later)!.nextRun, nextReportRun(7, 15, "Asia/Jerusalem", later), "turning it on does not run what was missed while it was off");
  assert.deepEqual(updateBobSchedule(db, "ilia", item.id, { projectIds: ["p1", "p1"] }, later)!.projectIds, ["p1"]);
  assert.throws(() => updateBobSchedule(db, "ilia", item.id, { time: "7am" }, later));
  assert.throws(() => updateBobSchedule(db, "ilia", item.id, { report: "evening" } as never, later), "the kind of a report cannot change");
});

test("the timer waits for the earliest enabled schedule and a due schedule is taken exactly once", () => {
  const db = schedules();
  const now = Date.UTC(2026, 10, 5, 6, 30);
  assert.equal(nextBobWake(db), null, "nothing scheduled, nothing to wait for");
  const morning = createBobSchedule(db, "ilia", { report: "morning", timezone: "UTC" }, now);
  const evening = createBobSchedule(db, "bob-too", { report: "evening", timezone: "UTC" }, now);
  const paused = createBobSchedule(db, "ilia", { report: "morning", timezone: "UTC", time: "07:00", enabled: false }, now);
  assert.equal(nextBobWake(db), morning.nextRun, "a paused schedule is not waited for");
  assert.deepEqual(claimDueBobSchedules(db, morning.nextRun - 1), []);
  const due = claimDueBobSchedules(db, morning.nextRun + 5000);
  assert.deepEqual(due.map((item) => [item.schedule.id, item.dueAt]), [[morning.id, morning.nextRun]]);
  assert.deepEqual(claimDueBobSchedules(db, morning.nextRun + 5000), [], "taking it moved it on: a restart or a slow run cannot run it twice");
  assert.equal(getBobSchedule(db, "ilia", morning.id)!.nextRun, Date.UTC(2026, 10, 6, 8));
  assert.equal(nextBobWake(db), evening.nextRun);
  assert.equal(getBobSchedule(db, "ilia", paused.id)!.nextRun, paused.nextRun, "a paused one is never taken");
  // Both people's due schedules are taken together.
  assert.deepEqual(claimDueBobSchedules(db, Date.UTC(2026, 10, 7, 23)).map((item) => item.schedule.id).sort(), [evening.id, morning.id].sort());
  recordBobScheduleRun(db, morning.id, { at: now, status: "skipped", note: "Bob was paused" });
  const recorded = getBobSchedule(db, "ilia", morning.id)!;
  assert.deepEqual([recorded.lastRun, recorded.lastStatus, recorded.lastNote], [now, "skipped", "Bob was paused"]);
});

test("a schedule is checked where it enters", () => {
  for (const bad of [{ report: "weekly", timezone: "UTC" }, { report: "morning", timezone: "Mars/Base" }, { report: "morning", timezone: "UTC", time: "24:00" }, { report: "morning", timezone: "UTC", extra: true }, { report: "morning", timezone: "UTC", projectIds: [""] }]) {
    assert.equal(bobScheduleInputSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(bobScheduleInputSchema.safeParse({ report: "evening", timezone: "UTC", time: "19:30" }).success, true);
});

function item(title: string, extra: Partial<ReportItem> = {}): ReportItem {
  return { projectId: "p1", project: "Joint Bob", title, summary: null, conversationId: `c-${title}`, at: "2026-11-05T01:00:00Z", ...extra };
}
const facts = (extra: Partial<ReportFacts> = {}): ReportFacts => ({
  report: "morning", since: "2026-11-04T18:00:00.000Z", until: "2026-11-05T08:00:00.000Z", projects: ["Joint Bob", "Contigos"],
  running: [], finished: [], waiting: [], failed: [], succeededRuns: 0, cost: [], ...extra,
});

test("the facts a report is written from read as plain text, the person's items first", () => {
  assert.match(describeFacts(facts()), /Nothing ran, nothing failed and nothing is waiting for you\.$/);
  const text = describeFacts(facts({
    running: [item("Slice 7 map", { project: "Contigos", summary: "Running\nthe UI tests" })],
    finished: [item("Mobile menu", { summary: "Fixed and tested" })], waiting: [item("Review counter")],
    failed: [{ kind: "schedule", id: "t1", name: "Slow query report", projectId: "p2", project: "Contigos", at: null, error: "Budget reached: daily", nodeId: "n1" }, { kind: "webhook", id: "h1", name: "Stripe test events", projectId: "p2", project: "Contigos", at: null, error: null, nodeId: "n1" }],
    succeededRuns: 3, cost: [{ project: "Joint Bob", usd: 12.5 }, { project: "Contigos", usd: 0.4 }],
  }));
  assert.ok(text.indexOf("Waiting for you (2):") < text.indexOf("Failed runs (2):") && text.indexOf("Failed runs (2):") < text.indexOf("Still running (1):"));
  assert.match(text, /- \[Joint Bob\] Mobile menu — Fixed and tested/);
  assert.match(text, /- \[Contigos\] Slice 7 map — Running the UI tests/, "a summary is one line");
  assert.match(text, /- \[Contigos\] Slow query report \(scheduled task\): Budget reached: daily/);
  assert.match(text, /- \[Contigos\] Stripe test events \(webhook\)\n/);
  assert.match(text, /Scheduled runs that went fine: 3\./);
  assert.match(text, /Cost since then \(\$13\):\n- Joint Bob: \$13\n- Contigos: \$0\.40/);
  assert.doesNotMatch(text, /Nothing ran/);
  const many = describeFacts(facts({ waiting: Array.from({ length: 15 }, (_, index) => item(`Conversation ${index}`)) }));
  assert.match(many, /Waiting for you \(15\):/);
  assert.match(many, /- and 3 more/);
});

test("a report offers a button for what needs the person, from a fixed pool of one-shot ids", () => {
  assert.deepEqual(reportActions(facts()), []);
  const actions = reportActions(facts({
    finished: [item("Mobile menu"), item("A"), item("B"), item("C")], waiting: [item("D")],
    failed: [
      { kind: "schedule", id: "t1", name: "Slow query report", projectId: "p2", project: "Contigos", at: null, error: null, nodeId: "n1" },
      { kind: "webhook", id: "h1", name: "A webhook cannot be run again", projectId: "p2", project: "Contigos", at: null, error: null, nodeId: "n1" },
      { kind: "schedule", id: "t2", name: "A task with a very long name that does not fit a button", projectId: "p2", project: "Contigos", at: null, error: null, nodeId: "n1" },
    ],
  }));
  assert.deepEqual(actions.map((action) => action.id), REPORT_ITEM_ACTIONS.slice(0, 5), "each button has its own id: pressing one is not mistaken for another");
  assert.deepEqual(actions.map((action) => action.label), ["Summary: Mobile menu", "Summary: A", "Summary: B", "Run again: Slow query report", "Run again: A task with a very long nam…"]);
  assert.deepEqual(reportItemSchema.parse(actions[0].data), { type: "summary", projectId: "p1", project: "Joint Bob", conversationId: "c-Mobile menu", title: "Mobile menu" });
  assert.deepEqual(reportItemSchema.parse(actions[3].data), { type: "rerun", taskId: "t1", nodeId: "n1", projectId: "p2", project: "Contigos", name: "Slow query report" });
  assert.equal(reportItemSchema.safeParse({ type: "rerun", taskId: "t1" }).success, false);
});

test("what Bob's agent answers is an intent only when it fits one of the six shapes", () => {
  assert.deepEqual(parseIntent('{"intent":"none"}'), { intent: "none" });
  assert.deepEqual(parseIntent('Sure.\n```json\n{"intent":"pause","targets":["schedule:abc","bob:def"]}\n```'), { intent: "pause", targets: ["schedule:abc", "bob:def"] });
  assert.deepEqual(parseIntent('{"intent":"list","projectId":null}'), { intent: "list", projectId: null });
  assert.deepEqual(parseIntent('{"intent":"create","create":{"kind":"report","report":"evening","time":"19:00"}}'), { intent: "create", create: { kind: "report", report: "evening", time: "19:00" } });
  assert.equal(parseIntent('{"intent":"create","create":{"kind":"schedule","projectId":"p1","name":"n","prompt":"p","frequency":"daily","time":"07:00"}}')?.intent, "create");
  assert.deepEqual(parseIntent('{"intent":"change","target":"schedule:abc","time":"03:30"}'), { intent: "change", target: "schedule:abc", time: "03:30" });
  for (const bad of [
    "", "I think you want to pause something", "{not json}", '{"intent":"delete"}', '{"intent":"delete","targets":[]}', '{"intent":"fire","targets":["a:b"]}',
    '{"intent":"pause","targets":[7]}', '{"intent":"create","create":{"kind":"schedule","projectId":"p1","name":"n","prompt":"p","frequency":"yearly","time":"07:00"}}',
    '{"intent":"create","create":{"kind":"report","report":"evening","time":"7pm"}}', '{"intent":"create","create":{"kind":"database"}}', '{"intent":"create"}',
    '{"intent":"change","time":"03:30"}', '{"intent":"change","target":"schedule:abc","time":"3am"}',
    `{"intent":"delete","targets":[${Array.from({ length: 11 }, (_, index) => `"schedule:${index}"`).join(",")}]}`,
  ]) assert.equal(parseIntent(bad), null, bad);
});

test("Bob leaves a message alone unless it may be about automations", async () => {
  const turn = (message: string) => ({ session: {} as never, message, recentChat: [], project: null, options: [], settings: {} as never });
  const never = { interpret: async () => { throw new Error("the agent must not be asked"); }, now: () => new Date() };
  // A confident task starts work in a project, even when it names a schedule.
  assert.equal(await handleBobAutomation(turn("fix the schedule parser"), { kind: "task", size: "long", projectId: "p1", confidence: 0.97 }, never), null);
  // A question or chat with no word about automations costs nothing extra.
  assert.equal(await handleBobAutomation(turn("what is running in dak?"), { kind: "question", size: "short", projectId: null, confidence: 0.95 }, never), null);
  assert.equal(await handleBobAutomation(turn("thanks"), null, never), null);
});
