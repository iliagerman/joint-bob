import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { resolveDataDirectory } from "./data-directory.js";

const timezoneSchema = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Unknown timezone");
export const cronInputSchema = z.object({
  projectId: z.string().min(1).max(240), name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(100000), ownerNodeId: z.string().uuid(),
  engine: z.enum(["pi", "claude"]), sessionId: z.string().min(1).max(240).nullable(), enabled: z.boolean(),
  schedule: z.object({ frequency: z.enum(["hourly", "daily", "weekly"]), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59), weekday: z.number().int().min(0).max(6), timezone: timezoneSchema }).strict(),
}).strict();
export type CronInput = z.infer<typeof cronInputSchema>;
export const cronRunSchema = z.object({ id: z.string().uuid(), taskId: z.string().uuid(), dueAt: z.number().int(), status: z.enum(["waiting", "running", "succeeded", "failed"]), error: z.string().nullable(), sessionId: z.string().nullable(), finishedAt: z.number().int().nullable() }).strict();
export type CronRun = z.infer<typeof cronRunSchema>;
export interface CronTask extends CronInput { id: string; nextRun: number; lastRun: CronRun | null }

export function nextCronRun(schedule: CronInput["schedule"], after: number): number {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: schedule.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
  const parts = (time: number) => Object.fromEntries(formatter.formatToParts(time).map(part => [part.type, part.value]));
  const start = parts(after);
  const date = (p: Record<string, string>) => `${p.year}-${p.month}-${p.day}`;
  const todayPassed = Number(start.hour) * 60 + Number(start.minute) >= schedule.hour * 60 + schedule.minute;
  for (let time = Math.floor(after / 60000) * 60000 + 60000; time <= after + 16 * 86400000; time += 60000) {
    const p = parts(time);
    if (Number(p.minute) !== schedule.minute) continue;
    if (schedule.frequency === "hourly") return time;
    // A daily/weekly wall-clock occurrence runs once, even when DST repeats it.
    if (Number(p.hour) !== schedule.hour || todayPassed && date(p) === date(start)) continue;
    if (schedule.frequency === "daily" || ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) === schedule.weekday) return time;
  }
  throw new Error("No schedule occurrence within sixteen days");
}

export class CronStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS cron_tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_node_id TEXT NOT NULL, input TEXT NOT NULL, next_run INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cron_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, session_id TEXT, finished_at INTEGER, UNIQUE(task_id, due_at));
      CREATE UNIQUE INDEX IF NOT EXISTS cron_active_run ON cron_runs(task_id) WHERE status IN ('waiting', 'running');`);
  }
  get(id: string): CronTask | null {
    const row = this.db.prepare("SELECT * FROM cron_tasks WHERE id = ?").get(id) as { id: string; input: string; next_run: number } | undefined;
    return row ? { ...JSON.parse(row.input), id: row.id, nextRun: row.next_run, lastRun: this.history(id)[0] ?? null } : null;
  }
  list(projectId?: string): CronTask[] {
    const rows = (projectId === undefined ? this.db.prepare("SELECT id FROM cron_tasks").all() : this.db.prepare("SELECT id FROM cron_tasks WHERE project_id = ?").all(projectId)) as { id: string }[];
    return rows.map(row => this.get(row.id)!);
  }
  history(id: string): CronRun[] {
    return this.db.prepare("SELECT id, task_id AS taskId, due_at AS dueAt, status, error, session_id AS sessionId, finished_at AS finishedAt FROM cron_runs WHERE task_id = ? ORDER BY due_at DESC LIMIT 100").all(id) as unknown as CronRun[];
  }
  create(input: CronInput, now = Date.now(), id: string = randomUUID()): CronTask {
    const data = cronInputSchema.parse(input);
    this.db.prepare("INSERT INTO cron_tasks VALUES (?, ?, ?, ?, ?)").run(id, data.projectId, data.ownerNodeId, JSON.stringify(data), nextCronRun(data.schedule, now));
    return this.get(id)!;
  }
  install(id: string, input: CronInput, runs: CronRun[]): CronTask {
    if (input.enabled || runs.some(run => run.taskId !== id || !["failed", "succeeded"].includes(run.status))) throw new Error("Only paused tasks with settled history can move");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.create(input, Date.now(), id);
      for (const run of runs) this.db.prepare("INSERT INTO cron_runs VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, error = excluded.error, session_id = excluded.session_id, finished_at = excluded.finished_at").run(run.id, id, run.dueAt, run.status, run.error, run.sessionId, run.finishedAt);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(id)!;
  }
  update(id: string, input: CronInput, now = Date.now()): CronTask {
    const data = cronInputSchema.parse(input);
    const old = this.get(id);
    if (!old) throw new Error("Scheduled task not found");
    if (old.ownerNodeId !== data.ownerNodeId || old.projectId !== data.projectId) throw new Error("Task owner and project cannot be changed in place");
    const next = JSON.stringify(old.schedule) === JSON.stringify(data.schedule) && old.enabled === data.enabled ? old.nextRun : nextCronRun(data.schedule, now);
    this.db.prepare("UPDATE cron_tasks SET input = ?, next_run = ? WHERE id = ?").run(JSON.stringify(data), next, id);
    return this.get(id)!;
  }
  delete(id: string): void {
    if (this.active(id)) throw new Error("Wait for the scheduled run to finish before deleting");
    this.db.prepare("DELETE FROM cron_tasks WHERE id = ?").run(id);
  }
  active(id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM cron_runs WHERE task_id = ? AND status IN ('waiting', 'running')").get(id));
  }
  claim(id: string, nodeId: string, now = Date.now()): CronRun | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.get(id);
      if (!task || task.ownerNodeId !== nodeId || !task.enabled || task.nextRun > now) return null;
      this.db.prepare("UPDATE cron_tasks SET next_run = ? WHERE id = ?").run(nextCronRun(task.schedule, now), id);
      // A late minute is missed, not replayed after reconnect/restart.
      if (now - task.nextRun >= 60000 || this.active(id)) return null;
      const run: CronRun = { id: randomUUID(), taskId: id, dueAt: task.nextRun, status: "waiting", error: null, sessionId: task.sessionId, finishedAt: null };
      this.db.prepare("INSERT INTO cron_runs (id, task_id, due_at, status, session_id) VALUES (?, ?, ?, ?, ?)").run(run.id, id, run.dueAt, run.status, run.sessionId);
      return run;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally { if (this.db.isTransaction) this.db.exec("COMMIT"); }
  }
  target(id: string, sessionId: string): void {
    this.db.prepare("UPDATE cron_runs SET session_id = ? WHERE id = ?").run(sessionId, id);
  }
  started(id: string, sessionId: string): void {
    this.db.prepare("UPDATE cron_runs SET status = 'running', session_id = ? WHERE id = ?").run(sessionId, id);
  }
  finish(id: string, status: "succeeded" | "failed", error: string | null): void {
    this.db.prepare("UPDATE cron_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?").run(status, error, Date.now(), id);
  }
  recover(now = Date.now()): void {
    // Never replay an uncertain dispatch. Pause it so an external agent still
    // finishing after a node crash cannot overlap a later scheduled run.
    for (const task of this.list()) if (this.active(task.id)) {
      const { id, nextRun, lastRun, ...input } = task;
      this.update(id, { ...input, enabled: false });
      this.db.prepare("UPDATE cron_runs SET status = 'failed', error = 'Node restarted during scheduled run; outcome uncertain. Task paused.', finished_at = ? WHERE task_id = ? AND status IN ('waiting', 'running')").run(now, task.id);
    }
    for (const task of this.list()) if (task.nextRun <= now) this.db.prepare("UPDATE cron_tasks SET next_run = ? WHERE id = ?").run(nextCronRun(task.schedule, now), task.id);
  }
}
let store: CronStore | undefined;
export function cronStore(): CronStore {
  if (!store) {
    const directory = resolveDataDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path.join(directory, "node.db"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    store = new CronStore(db);
  }
  return store;
}
