import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { resolveDataDirectory } from "./data-directory.js";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { isHarnessId } from "./types.js";
const timezoneSchema = z.string().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Unknown timezone");
const reasoningSchema = z.enum(["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const scheduleSchema = z.object({
  frequency: z.enum(["minutely", "hourly", "daily", "weekly"]),
  intervalMinutes: z.number().int().min(1).max(1440).optional(),
  intervalHours: z.number().int().min(1).max(168).optional(),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  weekday: z.number().int().min(0).max(6),
  timezone: timezoneSchema,
  startHour: z.number().int().min(0).max(23).optional(),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  quietStart: clockSchema.optional(),
  quietEnd: clockSchema.optional()
}).strict().superRefine((schedule, context) => {
  if (schedule.frequency === "minutely" && schedule.intervalMinutes === void 0) context.addIssue({ code: "custom", path: ["intervalMinutes"], message: "Minute interval is required" });
  if (schedule.days && new Set(schedule.days).size !== schedule.days.length) context.addIssue({ code: "custom", path: ["days"], message: "Days must be unique" });
  if (schedule.frequency === "weekly" && schedule.days && !schedule.days.includes(schedule.weekday)) context.addIssue({ code: "custom", path: ["days"], message: "Include the weekly run day" });
  if (Boolean(schedule.quietStart) !== Boolean(schedule.quietEnd) || schedule.quietStart && schedule.quietStart === schedule.quietEnd) context.addIssue({ code: "custom", path: ["quietEnd"], message: "Quiet hours need two different times" });
});
const cronModelSchema = z.object({
  provider: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(200),
  reasoning: reasoningSchema.optional()
}).strict();
const cronInputSchema = z.object({
  projectId: z.string().min(1).max(240),
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(1e5),
  ownerNodeId: z.string().uuid(),
  engine: z.string().refine(isHarnessId, "Harness ID is invalid").refine((id) => listDiscoveredHarnesses().some((adapter) => adapter.id === id && adapter.runtime), "Harness is not registered on this node"),
  model: cronModelSchema.nullable().optional(),
  reasoning: reasoningSchema.optional(),
  sessionId: z.string().min(1).max(240).nullable(),
  enabled: z.boolean(),
  pauseOnFailure: z.boolean().default(false),
  markForReview: z.boolean().default(true),
  schedule: scheduleSchema
}).strict().superRefine((input, context) => {
  const adapter = listDiscoveredHarnesses().find((candidate) => candidate.id === input.engine);
  if (!adapter?.configuration) return;
  const reasoning = input.reasoning ?? input.model?.reasoning;
  const reservedProvider = input.model ? listDiscoveredHarnesses().find((candidate) => candidate.id !== input.engine && candidate.configuration?.fixedProvider === input.model.provider) : void 0;
  const fixedProvider = adapter.configuration.fixedProvider;
  const providerMismatch = input.model ? fixedProvider ? input.model.provider !== fixedProvider : Boolean(reservedProvider) : false;
  const thinkingMismatch = reasoning !== void 0 && !adapter.configuration.thinkingLevels.includes(reasoning);
  if (providerMismatch || thinkingMismatch) context.addIssue({ code: z.ZodIssueCode.custom, path: ["model"], message: "Model settings do not belong to the selected harness" });
});
const cronRunSchema = z.object({ id: z.string().uuid(), taskId: z.string().uuid(), dueAt: z.number().int(), status: z.enum(["waiting", "running", "succeeded", "failed"]), error: z.string().nullable(), sessionId: z.string().nullable(), finishedAt: z.number().int().nullable() }).strict();
function nextCronRun(schedule, after) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: schedule.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
  const parts = (time) => Object.fromEntries(formatter.formatToParts(time).map((part) => [part.type, part.value]));
  const start = parts(after);
  const date = (p) => `${p.year}-${p.month}-${p.day}`;
  const todayPassed = Number(start.hour) * 60 + Number(start.minute) >= schedule.hour * 60 + schedule.minute;
  for (let time = Math.floor(after / 6e4) * 6e4 + 6e4; time <= after + 16 * 864e5; time += 6e4) {
    const p = parts(time);
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
    if (schedule.days && !schedule.days.includes(weekday)) continue;
    const wallMinute = Number(p.hour) * 60 + Number(p.minute);
    if (schedule.quietStart && schedule.quietEnd) {
      const startMinute = Number(schedule.quietStart.slice(0, 2)) * 60 + Number(schedule.quietStart.slice(3));
      const endMinute = Number(schedule.quietEnd.slice(0, 2)) * 60 + Number(schedule.quietEnd.slice(3));
      if (startMinute < endMinute ? wallMinute >= startMinute && wallMinute < endMinute : wallMinute >= startMinute || wallMinute < endMinute) continue;
    }
    if (schedule.frequency === "minutely") {
      const day = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 864e5;
      if ((day * 1440 + wallMinute - schedule.hour * 60 - schedule.minute) % schedule.intervalMinutes === 0) return time;
      continue;
    }
    if (Number(p.minute) !== schedule.minute) continue;
    if (schedule.frequency === "hourly") {
      if (schedule.startHour === void 0) {
        if (Math.floor(time / 36e5) % (schedule.intervalHours ?? 1) === 0) return time;
      } else {
        const day = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 864e5;
        if ((day * 24 + Number(p.hour) - schedule.startHour) % (schedule.intervalHours ?? 1) === 0) {
          const previousHour = parts(time - 36e5);
          if (!(date(previousHour) === date(p) && previousHour.hour === p.hour)) return time;
        }
      }
      continue;
    }
    if (Number(p.hour) !== schedule.hour || todayPassed && date(p) === date(start)) continue;
    if (schedule.frequency === "daily" || weekday === schedule.weekday) return time;
  }
  throw new Error("No schedule occurrence within sixteen days");
}
class CronStore {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS cron_tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_node_id TEXT NOT NULL, input TEXT NOT NULL, next_run INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cron_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, session_id TEXT, finished_at INTEGER, UNIQUE(task_id, due_at));
      CREATE UNIQUE INDEX IF NOT EXISTS cron_active_run ON cron_runs(task_id) WHERE status IN ('waiting', 'running');`);
  }
  db;
  get(id) {
    const row = this.db.prepare("SELECT * FROM cron_tasks WHERE id = ?").get(id);
    return row ? { ...cronInputSchema.parse(JSON.parse(row.input)), id: row.id, nextRun: row.next_run, lastRun: this.history(id)[0] ?? null } : null;
  }
  list(projectId) {
    const rows = projectId === void 0 ? this.db.prepare("SELECT id FROM cron_tasks").all() : this.db.prepare("SELECT id FROM cron_tasks WHERE project_id = ?").all(projectId);
    return rows.map((row) => this.get(row.id));
  }
  history(id) {
    return this.db.prepare("SELECT id, task_id AS taskId, due_at AS dueAt, status, error, session_id AS sessionId, finished_at AS finishedAt FROM cron_runs WHERE task_id = ? ORDER BY due_at DESC LIMIT 100").all(id);
  }
  taskForRun(runId, sessionId) {
    const run = this.db.prepare("SELECT task_id FROM cron_runs WHERE id = ? AND session_id = ? AND status IN ('waiting', 'running')").get(runId, sessionId);
    return run ? this.get(run.task_id) : null;
  }
  create(input, now = Date.now(), id = randomUUID()) {
    const data = cronInputSchema.parse(input);
    this.db.prepare("INSERT INTO cron_tasks VALUES (?, ?, ?, ?, ?)").run(id, data.projectId, data.ownerNodeId, JSON.stringify(data), nextCronRun(data.schedule, now));
    return this.get(id);
  }
  install(id, input, runs) {
    if (input.enabled || runs.some((run) => run.taskId !== id || !["failed", "succeeded"].includes(run.status))) throw new Error("Only paused tasks with settled history can move");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.create(input, Date.now(), id);
      for (const run of runs) this.db.prepare("INSERT INTO cron_runs VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, error = excluded.error, session_id = excluded.session_id, finished_at = excluded.finished_at").run(run.id, id, run.dueAt, run.status, run.error, run.sessionId, run.finishedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(id);
  }
  update(id, input, now = Date.now()) {
    const data = cronInputSchema.parse(input);
    const old = this.get(id);
    if (!old) throw new Error("Scheduled task not found");
    if (old.ownerNodeId !== data.ownerNodeId || old.projectId !== data.projectId) throw new Error("Task owner and project cannot be changed in place");
    const next = JSON.stringify(old.schedule) === JSON.stringify(data.schedule) && old.enabled === data.enabled ? old.nextRun : nextCronRun(data.schedule, now);
    this.db.prepare("UPDATE cron_tasks SET input = ?, next_run = ? WHERE id = ?").run(JSON.stringify(data), next, id);
    return this.get(id);
  }
  runNow(id, now = Date.now()) {
    const task = this.get(id);
    if (!task) throw new Error("Scheduled task not found");
    if (this.active(id)) throw new Error("The scheduled task is already running");
    const { id: _id, nextRun: _nextRun, lastRun: _lastRun, ...input } = task;
    this.db.prepare("UPDATE cron_tasks SET input = ?, next_run = ? WHERE id = ?").run(JSON.stringify({ ...input, enabled: true }), now, id);
    return this.get(id);
  }
  delete(id) {
    if (this.active(id)) throw new Error("Wait for the scheduled run to finish before deleting");
    this.db.prepare("DELETE FROM cron_tasks WHERE id = ?").run(id);
  }
  active(id) {
    return Boolean(this.db.prepare("SELECT 1 FROM cron_runs WHERE task_id = ? AND status IN ('waiting', 'running')").get(id));
  }
  claim(id, nodeId, now = Date.now()) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.get(id);
      if (!task || task.ownerNodeId !== nodeId || !task.enabled || task.nextRun > now) return null;
      this.db.prepare("UPDATE cron_tasks SET next_run = ? WHERE id = ?").run(nextCronRun(task.schedule, now), id);
      if (now - task.nextRun >= 6e4 || this.active(id)) return null;
      const run = { id: randomUUID(), taskId: id, dueAt: task.nextRun, status: "waiting", error: null, sessionId: task.sessionId, finishedAt: null };
      this.db.prepare("INSERT INTO cron_runs (id, task_id, due_at, status, session_id) VALUES (?, ?, ?, ?, ?)").run(run.id, id, run.dueAt, run.status, run.sessionId);
      return run;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      if (this.db.isTransaction) this.db.exec("COMMIT");
    }
  }
  target(id, sessionId) {
    this.db.prepare("UPDATE cron_runs SET session_id = ? WHERE id = ?").run(sessionId, id);
  }
  started(id, sessionId) {
    this.db.prepare("UPDATE cron_runs SET status = 'running', session_id = ? WHERE id = ?").run(sessionId, id);
  }
  finish(id, status, error) {
    this.db.prepare("UPDATE cron_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?").run(status, error, Date.now(), id);
  }
  recover(now = Date.now()) {
    for (const task of this.list()) if (this.active(task.id)) {
      const { id, nextRun, lastRun, ...input } = task;
      this.update(id, { ...input, enabled: false });
      this.db.prepare("UPDATE cron_runs SET status = 'failed', error = 'Node restarted during scheduled run; outcome uncertain. Task paused.', finished_at = ? WHERE task_id = ? AND status IN ('waiting', 'running')").run(now, task.id);
    }
    for (const task of this.list()) if (task.nextRun <= now) this.db.prepare("UPDATE cron_tasks SET next_run = ? WHERE id = ?").run(nextCronRun(task.schedule, now), task.id);
  }
}
let store;
function cronStore() {
  if (!store) {
    const directory = resolveDataDirectory();
    mkdirSync(directory, { recursive: true, mode: 448 });
    const db = new DatabaseSync(path.join(directory, "node.db"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    store = new CronStore(db);
  }
  return store;
}
export {
  CronStore,
  cronInputSchema,
  cronRunSchema,
  cronStore,
  nextCronRun
};
