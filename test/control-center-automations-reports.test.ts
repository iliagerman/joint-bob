import assert from "node:assert/strict";
import test from "node:test";
import type { AuthSession } from "../src/auth.js";
import type { ReportFacts } from "../src/control-center/bob-reports.js";
import { claimDueBobSchedules, createBobSchedule, ensureBobScheduleSchema, getBobSchedule } from "../src/control-center/bob-schedules.js";
import { bobDatabase, listBobMessages, writeBobSettings } from "../src/control-center/bob-store.js";
import { dispatchDueReports, type ReportDeps } from "../src/server/control-center-reports.js";
import { rearmReportTimer, startReportTimer, stopReportTimer } from "../src/server/control-center-report-timer.js";

const MINUTE = 60_000;

const session = (accountId: string): AuthSession => ({ id: `s-${accountId}`, userId: `u-${accountId}`, username: accountId, accountId, email: null, role: "admin", csrfToken: "", mustChangePassword: false, isRemoteLogin: false, homeNodeId: null });

function facts(over: Partial<ReportFacts> = {}): ReportFacts {
  return {
    report: "evening", since: "2026-11-05T06:00:00.000Z", until: "2026-11-05T19:00:00.000Z", projects: ["Joint Bob"], running: [],
    finished: [{ projectId: "p1", project: "Joint Bob", title: "Mobile menu", summary: "Fixed", conversationId: "c1", at: null }], waiting: [], failed: [], succeededRuns: 0, cost: [], ...over,
  };
}

function deps(over: Partial<ReportDeps> = {}): ReportDeps {
  return { gather: async (_who, schedule) => facts({ report: schedule.report }), write: async () => "Written by the agent.", ready: () => true, session: (accountId) => session(accountId), ...over };
}

async function fresh() {
  const db = await bobDatabase();
  ensureBobScheduleSchema(db);
  db.exec("DELETE FROM control_center_bob_schedules; DELETE FROM control_center_bob_messages; DELETE FROM control_center_bob_settings");
  return db;
}

test("a due report is written, posted in Bob's chat as a report with buttons, and the next one is set for its next time", async () => {
  const db = await fresh();
  const created = createBobSchedule(db, "ilia", { report: "evening", timezone: "UTC", projectIds: ["p1"] }, Date.UTC(2026, 10, 5, 6));
  await dispatchDueReports(created.nextRun + 2000, deps());
  const [message] = listBobMessages(db, "ilia");
  assert.deepEqual([message.role, message.importance, message.text, message.via], ["bob", "report", "Written by the agent.", "Evening report · scheduled 19:00 · written by Bob's agent"]);
  assert.deepEqual([message.projectId, message.projectName], ["p1", "Joint Bob"], "a report about one project carries its label");
  assert.deepEqual(message.actions.map((action) => [action.id, action.label]), [["automations.item-1", "Summary: Mobile menu"]]);
  const after = getBobSchedule(db, "ilia", created.id)!;
  assert.deepEqual([after.lastStatus, after.lastNote, after.lastRun], ["ok", null, created.nextRun + 2000]);
  assert.equal(after.nextRun, Date.UTC(2026, 10, 6, 19), "tomorrow at its time");
  await dispatchDueReports(created.nextRun + 3000, deps());
  assert.equal(listBobMessages(db, "ilia").length, 1, "the same report is never written twice");
});

test("a report across all projects is General, and Bob's agent failing posts the facts with the reason", async () => {
  const db = await fresh();
  const created = createBobSchedule(db, "ilia", { report: "morning", timezone: "UTC" }, Date.UTC(2026, 10, 5, 0));
  await dispatchDueReports(created.nextRun + MINUTE, deps({ write: async () => { throw new Error("No agent is available on this node"); } }));
  const [message] = listBobMessages(db, "ilia");
  assert.equal(message.projectId, null);
  assert.match(message.text, /^Morning report for Joint Bob\./);
  assert.match(message.text, /Waiting for you \(1\):\n- \[Joint Bob\] Mobile menu — Fixed/);
  assert.equal(message.via, "Morning report · scheduled 08:00 · facts only, Bob's agent could not write it: No agent is available on this node");
  assert.equal(getBobSchedule(db, "ilia", created.id)!.lastStatus, "ok", "the person still got their report");
  // An agent that writes nothing is no better than one that fails.
  const second = createBobSchedule(db, "second", { report: "morning", timezone: "UTC" }, Date.UTC(2026, 10, 5, 0));
  await dispatchDueReports(second.nextRun + MINUTE, deps({ write: async () => "" }));
  assert.match(listBobMessages(db, "second")[0].via ?? "", /facts only, Bob's agent could not write it: it wrote nothing/);
});

test("while Bob is paused a due report is skipped and not kept for later", async () => {
  const db = await fresh();
  const created = createBobSchedule(db, "ilia", { report: "morning", timezone: "UTC" }, Date.UTC(2026, 10, 5, 0));
  const other = createBobSchedule(db, "other", { report: "morning", timezone: "UTC" }, Date.UTC(2026, 10, 5, 0));
  writeBobSettings(db, "ilia", { monitoring: false });
  await dispatchDueReports(created.nextRun + MINUTE, deps());
  assert.deepEqual(listBobMessages(db, "ilia"), [], "nothing is written for a paused Bob");
  assert.equal(listBobMessages(db, "other").length, 1, "another person's Bob is not paused");
  const skipped = getBobSchedule(db, "ilia", created.id)!;
  assert.deepEqual([skipped.lastStatus, skipped.lastNote], ["skipped", "Bob was paused, so this report was not written"]);
  assert.equal(skipped.nextRun, Date.UTC(2026, 10, 6, 8), "it moved on to tomorrow");
  assert.equal(getBobSchedule(db, "other", other.id)!.lastStatus, "ok");
  // Restored later the same day: nothing comes back that was skipped.
  writeBobSettings(db, "ilia", { monitoring: true });
  await dispatchDueReports(created.nextRun + 5 * 3_600_000, deps());
  assert.deepEqual(listBobMessages(db, "ilia"), []);
});

test("a report whose time passed while the server was off, was starting or has no account here is not written", async () => {
  const db = await fresh();
  const late = createBobSchedule(db, "late", { report: "morning", timezone: "UTC" }, Date.UTC(2026, 10, 5, 0));
  await dispatchDueReports(late.nextRun + 31 * MINUTE, deps());
  assert.deepEqual([getBobSchedule(db, "late", late.id)!.lastStatus, getBobSchedule(db, "late", late.id)!.lastNote], ["skipped", "Missed at 08:00: the server was not running"]);
  const justInTime = createBobSchedule(db, "in-time", { report: "morning", timezone: "UTC" }, Date.UTC(2026, 10, 5, 0));
  await dispatchDueReports(justInTime.nextRun + 29 * MINUTE, deps());
  assert.equal(getBobSchedule(db, "in-time", justInTime.id)!.lastStatus, "ok", "half an hour late is still on time");

  const starting = createBobSchedule(db, "starting", { report: "morning", timezone: "UTC" }, Date.UTC(2026, 10, 5, 0));
  await dispatchDueReports(starting.nextRun + MINUTE, deps({ ready: () => false }));
  assert.equal(getBobSchedule(db, "starting", starting.id)!.lastNote, "The server was still starting");

  const stranger = createBobSchedule(db, "stranger", { report: "morning", timezone: "UTC" }, Date.UTC(2026, 10, 5, 0));
  await dispatchDueReports(stranger.nextRun + MINUTE, deps({ session: () => null }));
  assert.equal(getBobSchedule(db, "stranger", stranger.id)!.lastNote, "This person has no account on this machine");
  for (const account of ["late", "starting", "stranger"]) assert.deepEqual(listBobMessages(db, account), [], account);
});

test("one report failing does not stop the others, and the failure is on the schedule", async () => {
  const db = await fresh();
  const broken = createBobSchedule(db, "broken", { report: "morning", timezone: "UTC" }, Date.UTC(2026, 10, 5, 0));
  const fine = createBobSchedule(db, "fine", { report: "morning", timezone: "UTC" }, Date.UTC(2026, 10, 5, 0));
  await dispatchDueReports(broken.nextRun + MINUTE, deps({ gather: async (who) => { if (who.accountId === "broken") throw new Error("The board could not be read"); return facts(); } }));
  assert.deepEqual([getBobSchedule(db, "broken", broken.id)!.lastStatus, getBobSchedule(db, "broken", broken.id)!.lastNote], ["failed", "The board could not be read"]);
  assert.equal(getBobSchedule(db, "broken", broken.id)!.nextRun, Date.UTC(2026, 10, 6, 8), "it tries again tomorrow, not in a loop");
  assert.equal(listBobMessages(db, "fine").length, 1);
  assert.equal(getBobSchedule(db, "fine", fine.id)!.lastStatus, "ok");
});

test("one timer wakes for the earliest due report, runs it, and does not poll", async () => {
  const db = await fresh();
  stopReportTimer();
  const calls: number[] = [];
  const run = async (now: number): Promise<void> => { calls.push(now); await dispatchDueReports(now, deps()); };

  // Nothing scheduled: nothing to wait for.
  startReportTimer(run);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(calls, []);

  // Saving a schedule points the timer at it; it wakes at that time and only then.
  const created = createBobSchedule(db, "ilia", { report: "morning", timezone: "UTC" });
  db.prepare("UPDATE control_center_bob_schedules SET next_run = ? WHERE id = ?").run(Date.now() + 500, created.id);
  rearmReportTimer();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(calls, [], "not before its time");
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(calls.length, 1);
  assert.equal(listBobMessages(db, "ilia").length, 1);
  // Its next time is the next 08:00, which may be minutes away when the test runs just before 08:00 UTC; it is not now.
  assert.ok(getBobSchedule(db, "ilia", created.id)!.nextRun > Date.now() + 1_000);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(calls.length, 1, "after it ran the timer waits for the next day, it does not tick");

  // A schedule moved earlier takes over from the one the timer was waiting for.
  db.prepare("UPDATE control_center_bob_schedules SET next_run = ? WHERE id = ?").run(Date.now() + 400, created.id);
  rearmReportTimer();
  rearmReportTimer();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(calls.length, 2, "two saves in a row still leave one timer");
  stopReportTimer();
  assert.equal(claimDueBobSchedules(db, Date.now()).length, 0);
});
