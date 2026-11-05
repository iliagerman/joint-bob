import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { nextCronRun } from "../cron.js";

/** The reports Bob writes on his own schedule. */
export const REPORT_KINDS = ["morning", "evening"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_DEFAULTS: Record<ReportKind, { name: string; time: string }> = {
  morning: { name: "Morning report", time: "08:00" },
  evening: { name: "Evening report", time: "19:00" },
};

const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const timezoneSchema = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Unknown timezone");

export const bobScheduleInputSchema = z.object({
  report: z.enum(REPORT_KINDS),
  name: z.string().trim().min(1).max(120).optional(),
  /** Defaults to the report's usual time: 08:00 for the morning, 19:00 for the evening. */
  time: clockSchema.optional(),
  timezone: timezoneSchema,
  /** Empty means every project the person can see. */
  projectIds: z.array(z.string().min(1).max(240)).max(100).default([]),
  enabled: z.boolean().default(true),
}).strict();
export type BobScheduleInput = z.input<typeof bobScheduleInputSchema>;

export const bobScheduleChangeSchema = bobScheduleInputSchema.omit({ report: true }).partial().strict();
export type BobScheduleChange = z.infer<typeof bobScheduleChangeSchema>;

export interface BobSchedule {
  id: string;
  accountId: string;
  report: ReportKind;
  name: string;
  hour: number;
  minute: number;
  timezone: string;
  projectIds: string[];
  enabled: boolean;
  /** When it is due next; only enabled schedules are watched. */
  nextRun: number;
  lastRun: number | null;
  lastStatus: "ok" | "failed" | "skipped" | null;
  lastNote: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleRow {
  id: string; account_id: string; report: ReportKind; name: string; hour: number; minute: number; timezone: string; project_ids: string;
  enabled: number; next_run: number; last_run: number | null; last_status: BobSchedule["lastStatus"]; last_note: string | null; created_at: string; updated_at: string;
}

export function ensureBobScheduleSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS control_center_bob_schedules (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, report TEXT NOT NULL, name TEXT NOT NULL, hour INTEGER NOT NULL, minute INTEGER NOT NULL,
    timezone TEXT NOT NULL, project_ids TEXT NOT NULL, enabled INTEGER NOT NULL, next_run INTEGER NOT NULL,
    last_run INTEGER, last_status TEXT, last_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS control_center_bob_schedules_account ON control_center_bob_schedules(account_id);
    CREATE INDEX IF NOT EXISTS control_center_bob_schedules_due ON control_center_bob_schedules(enabled, next_run);`);
}

function schedule(row: ScheduleRow): BobSchedule {
  return {
    id: row.id, accountId: row.account_id, report: row.report, name: row.name, hour: row.hour, minute: row.minute, timezone: row.timezone,
    projectIds: JSON.parse(row.project_ids) as string[], enabled: row.enabled === 1, nextRun: row.next_run,
    lastRun: row.last_run, lastStatus: row.last_status, lastNote: row.last_note, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** The next time after `after` that the wall clock in `timezone` shows hour:minute. */
export function nextReportRun(hour: number, minute: number, timezone: string, after: number): number {
  return nextCronRun({ frequency: "daily", hour, minute, weekday: 0, timezone }, after);
}

const splitClock = (time: string): { hour: number; minute: number } => ({ hour: Number(time.slice(0, 2)), minute: Number(time.slice(3)) });

export function createBobSchedule(db: DatabaseSync, accountId: string, input: BobScheduleInput, now = Date.now()): BobSchedule {
  const data = bobScheduleInputSchema.parse(input);
  const { hour, minute } = splitClock(data.time ?? REPORT_DEFAULTS[data.report].time);
  const stamp = new Date(now).toISOString();
  const id = randomUUID();
  db.prepare("INSERT INTO control_center_bob_schedules (id, account_id, report, name, hour, minute, timezone, project_ids, enabled, next_run, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, accountId, data.report, data.name ?? REPORT_DEFAULTS[data.report].name, hour, minute, data.timezone, JSON.stringify([...new Set(data.projectIds)]), data.enabled ? 1 : 0, nextReportRun(hour, minute, data.timezone, now), stamp, stamp);
  return getBobSchedule(db, accountId, id)!;
}

export function getBobSchedule(db: DatabaseSync, accountId: string, id: string): BobSchedule | undefined {
  const row = db.prepare("SELECT * FROM control_center_bob_schedules WHERE account_id = ? AND id = ?").get(accountId, id) as ScheduleRow | undefined;
  return row ? schedule(row) : undefined;
}

export function listBobSchedules(db: DatabaseSync, accountId: string): BobSchedule[] {
  return (db.prepare("SELECT * FROM control_center_bob_schedules WHERE account_id = ? ORDER BY report DESC, hour, minute, name").all(accountId) as unknown as ScheduleRow[]).map(schedule);
}

/** Changes what the person edited. A new time, zone or turning it back on works out the next due time again. */
export function updateBobSchedule(db: DatabaseSync, accountId: string, id: string, change: BobScheduleChange, now = Date.now()): BobSchedule | undefined {
  const old = getBobSchedule(db, accountId, id);
  if (!old) return undefined;
  const data = bobScheduleChangeSchema.parse(change);
  const clockChange = data.time ? splitClock(data.time) : { hour: old.hour, minute: old.minute };
  const next = { ...old, ...clockChange, name: data.name ?? old.name, timezone: data.timezone ?? old.timezone, projectIds: data.projectIds ? [...new Set(data.projectIds)] : old.projectIds, enabled: data.enabled ?? old.enabled };
  const reschedule = next.hour !== old.hour || next.minute !== old.minute || next.timezone !== old.timezone || (next.enabled && !old.enabled);
  db.prepare("UPDATE control_center_bob_schedules SET name = ?, hour = ?, minute = ?, timezone = ?, project_ids = ?, enabled = ?, next_run = ?, updated_at = ? WHERE account_id = ? AND id = ?")
    .run(next.name, next.hour, next.minute, next.timezone, JSON.stringify(next.projectIds), next.enabled ? 1 : 0, reschedule ? nextReportRun(next.hour, next.minute, next.timezone, now) : old.nextRun, new Date(now).toISOString(), accountId, id);
  return getBobSchedule(db, accountId, id);
}

export function deleteBobSchedule(db: DatabaseSync, accountId: string, id: string): boolean {
  return Number(db.prepare("DELETE FROM control_center_bob_schedules WHERE account_id = ? AND id = ?").run(accountId, id).changes) > 0;
}

/** When the first enabled schedule is due, or null when nothing is scheduled. This is the only thing the timer waits for. */
export function nextBobWake(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT MIN(next_run) AS next FROM control_center_bob_schedules WHERE enabled = 1").get() as { next: number | null };
  return row.next;
}

export interface DueSchedule { schedule: BobSchedule; /** The time it was meant to run. */ dueAt: number }

/** Takes every schedule that is due and moves it to its next time, so a restart or a slow run cannot run it twice. */
export function claimDueBobSchedules(db: DatabaseSync, now: number): DueSchedule[] {
  const due = (db.prepare("SELECT * FROM control_center_bob_schedules WHERE enabled = 1 AND next_run <= ? ORDER BY next_run").all(now) as unknown as ScheduleRow[]).map(schedule);
  for (const item of due) {
    db.prepare("UPDATE control_center_bob_schedules SET next_run = ? WHERE id = ?").run(nextReportRun(item.hour, item.minute, item.timezone, now), item.id);
  }
  return due.map((item) => ({ schedule: item, dueAt: item.nextRun }));
}

export function recordBobScheduleRun(db: DatabaseSync, id: string, result: { at: number; status: "ok" | "failed" | "skipped"; note: string | null }): void {
  db.prepare("UPDATE control_center_bob_schedules SET last_run = ?, last_status = ?, last_note = ? WHERE id = ?").run(result.at, result.status, result.note, id);
}
