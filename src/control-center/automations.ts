import type { CronInput, CronTask } from "../cron.js";
import type { Webhook, WebhookDelivery } from "../webhooks.js";
import type { BobSchedule } from "./bob-schedules.js";

/** What the Automations table lists: scheduled tasks and webhooks of the projects, and the schedules Bob owns. */
export type AutomationKind = "schedule" | "webhook" | "bob";

export interface AutomationLast {
  state: "ok" | "failed" | "running" | "never" | "paused" | "skipped" | "refused";
  /** When it last ran or was last called. */
  at: string | null;
  /** The error, or what was skipped and why. */
  detail: string | null;
}

export interface AutomationRow {
  kind: AutomationKind;
  id: string;
  name: string;
  /** A second line under the name: what a task asks for, what a webhook tells the agent. */
  detail: string;
  enabled: boolean;
  /** Null for Bob's own schedules, which cover several or all projects. */
  projectId: string | null;
  projectName: string;
  /** The projects it covers; empty for a Bob schedule that covers all of them. */
  projectIds: string[];
  /** The machine that stores and runs it. */
  nodeId: string | null;
  nodeName: string | null;
  when: string;
  last: AutomationLast;
  /** Only the person who made a task or webhook may change it; anyone who sees its project may delete it. */
  editable: boolean;
  /** What the compact editor starts from. */
  edit: AutomationEdit;
}

export type AutomationEdit =
  | {
    kind: "schedule"; prompt: string; frequency: "once" | "hourly" | "daily" | "weekly" | "monthly"; time: string; weekday: number; timezone: string;
    /** The day it runs (once), repeats on (monthly) or starts on, and the last day it may run. */
    date: string | null; until: string | null;
    /** False for a schedule the compact editor cannot express (every few minutes, quiet hours). */ simple: boolean;
  }
  | { kind: "webhook"; context: string }
  | { kind: "bob"; report: "morning" | "evening"; time: string; timezone: string };

export const ALL_PROJECTS = "All projects";
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (value: number): string => String(value).padStart(2, "0");
export const clock = (hour: number, minute: number): string => `${pad(hour)}:${pad(minute)}`;

function daysText(days: number[] | undefined): string {
  if (!days || days.length === 7) return "";
  return ` · ${[...days].sort((a, b) => a - b).map((day) => DAY_NAMES[day]).join(", ")}`;
}

const ordinal = (day: number): string => `${day}${day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th"}`;

/** "Once 2026-11-12 14:30", "Daily 08:00 · from 2026-11-12 · until 2026-12-31", "Monthly on the 15th 09:00", "Mon 08:00". */
export function describeSchedule(schedule: CronInput["schedule"]): string {
  if (schedule.frequency === "once") return `Once ${schedule.startDate} ${clock(schedule.hour, schedule.minute)}`;
  const from = schedule.startDate && schedule.frequency !== "monthly" ? ` · from ${schedule.startDate}` : "";
  const until = schedule.endDate ? ` · until ${schedule.endDate}` : "";
  return `${repeatText(schedule)}${from}${until}`;
}

function repeatText(schedule: CronInput["schedule"]): string {
  switch (schedule.frequency) {
    case "once": return "Once";
    case "monthly": return `Monthly on the ${ordinal(Number(schedule.startDate!.slice(8)))} ${clock(schedule.hour, schedule.minute)}`;
    case "minutely": return `${schedule.intervalMinutes === 1 ? "Every minute" : `Every ${schedule.intervalMinutes} minutes`}${daysText(schedule.days)}`;
    case "hourly": {
      const every = schedule.intervalHours ?? 1;
      return `${every === 1 ? "Every hour" : `Every ${every} hours`} at :${pad(schedule.minute)}${daysText(schedule.days)}`;
    }
    case "daily": return `Daily ${clock(schedule.hour, schedule.minute)}${daysText(schedule.days)}`;
    case "weekly": return `${DAY_NAMES[schedule.weekday]} ${clock(schedule.hour, schedule.minute)}`;
  }
}

/** Whether the compact editor can show and rewrite this schedule without losing something. */
export function isSimpleSchedule(schedule: CronInput["schedule"]): boolean {
  if (schedule.quietStart || schedule.frequency === "minutely") return false;
  if (schedule.frequency === "hourly") return (schedule.intervalHours ?? 1) === 1 && schedule.startHour !== undefined;
  return !schedule.days || schedule.days.length === 7 || schedule.frequency === "weekly";
}

function lastOfTask(task: CronTask): AutomationLast {
  const run = task.lastRun;
  if (!run) return { state: task.enabled ? "never" : "paused", at: null, detail: null };
  const at = new Date(run.finishedAt ?? run.dueAt).toISOString();
  if (run.status === "waiting" || run.status === "running") return { state: "running", at, detail: null };
  if (!task.enabled) return { state: "paused", at, detail: run.status === "failed" ? run.error : null };
  return { state: run.status === "failed" ? "failed" : "ok", at, detail: run.error };
}

export interface RowContext {
  projectName(projectId: string): string;
  nodeName(nodeId: string): string | null;
  /** Who is asking: tasks and webhooks made by someone else are shown but not editable. */
  accountId: string;
}

export function scheduleRow(task: CronTask, context: RowContext): AutomationRow {
  return {
    kind: "schedule", id: task.id, name: task.name, detail: task.prompt.replace(/\s+/g, " ").trim().slice(0, 140), enabled: task.enabled,
    projectId: task.projectId, projectName: context.projectName(task.projectId), projectIds: [task.projectId],
    nodeId: task.ownerNodeId, nodeName: context.nodeName(task.ownerNodeId), when: describeSchedule(task.schedule), last: lastOfTask(task),
    editable: !task.creatorAccountId || task.creatorAccountId === context.accountId,
    edit: {
      kind: "schedule", prompt: task.prompt, frequency: task.schedule.frequency === "minutely" ? "daily" : task.schedule.frequency,
      time: clock(task.schedule.startHour ?? task.schedule.hour, task.schedule.minute), weekday: task.schedule.weekday, timezone: task.schedule.timezone,
      date: task.schedule.startDate ?? null, until: task.schedule.endDate ?? null, simple: isSimpleSchedule(task.schedule),
    },
  };
}

function targetText(hook: Webhook): string {
  if (hook.target.kind === "assistant") return "Goes to a personal assistant";
  return hook.target.kind === "project" ? "Starts a conversation" : "Adds to a conversation";
}

export function webhookRow(hook: Webhook, context: RowContext & { nodeId: string; delivery: WebhookDelivery | undefined }): AutomationRow {
  const senders = hook.senders ? `${hook.senders.allowed.length} allowed sender${hook.senders.allowed.length === 1 ? "" : "s"}` : "anyone with the address";
  const delivery = context.delivery;
  const last: AutomationLast = !hook.enabled ? { state: "paused", at: hook.lastReceivedAt, detail: null }
    : delivery ? { state: delivery.status === "delivered" ? "ok" : delivery.status === "failed" ? "failed" : "refused", at: delivery.at, detail: delivery.status === "delivered" ? null : delivery.detail }
    : { state: hook.lastReceivedAt ? "ok" : "never", at: hook.lastReceivedAt, detail: null };
  return {
    kind: "webhook", id: hook.id, name: hook.name, detail: hook.context.replace(/\s+/g, " ").trim().slice(0, 140), enabled: hook.enabled,
    projectId: hook.target.projectId, projectName: context.projectName(hook.target.projectId), projectIds: [hook.target.projectId],
    nodeId: context.nodeId, nodeName: context.nodeName(context.nodeId), when: `${targetText(hook)} · ${senders}`, last,
    editable: !hook.creatorAccountId || hook.creatorAccountId === context.accountId,
    edit: { kind: "webhook", context: hook.context },
  };
}

export function bobRow(schedule: BobSchedule, context: Pick<RowContext, "projectName"> & { nodeId: string; nodeName: string | null }): AutomationRow {
  const where = schedule.projectIds.length ? schedule.projectIds.map(context.projectName).join(", ") : ALL_PROJECTS;
  const last: AutomationLast = schedule.lastRun === null
    ? { state: schedule.enabled ? "never" : "paused", at: null, detail: null }
    : { state: schedule.lastStatus === "ok" ? "ok" : schedule.lastStatus === "failed" ? "failed" : "skipped", at: new Date(schedule.lastRun).toISOString(), detail: schedule.lastNote };
  return {
    kind: "bob", id: schedule.id, name: schedule.name,
    detail: schedule.report === "morning" ? "What finished overnight, what is still running, what waits for you, failed runs, spend" : "What got done today, what is still running, what waits for you, failed runs, cost by project",
    enabled: schedule.enabled, projectId: null, projectName: where, projectIds: schedule.projectIds, nodeId: context.nodeId, nodeName: context.nodeName,
    when: `Daily ${clock(schedule.hour, schedule.minute)} · Bob's chat`, last: schedule.enabled ? last : { ...last, state: "paused" }, editable: true,
    edit: { kind: "bob", report: schedule.report, time: clock(schedule.hour, schedule.minute), timezone: schedule.timezone },
  };
}

/** A row follows the project filter when it belongs to a chosen project; Bob's schedules also show when they cover all projects. */
export function rowMatchesFilter(row: Pick<AutomationRow, "kind" | "projectIds">, filter: readonly string[]): boolean {
  if (!filter.length) return true;
  if (row.kind === "bob" && !row.projectIds.length) return true;
  return row.projectIds.some((id) => filter.includes(id));
}

/** The kinds sort the way the mock lists them: Bob's schedules first, then tasks, then webhooks; by name inside each. */
export function compareRows(a: Pick<AutomationRow, "kind" | "name">, b: Pick<AutomationRow, "kind" | "name">): number {
  const order: Record<AutomationKind, number> = { bob: 0, schedule: 1, webhook: 2 };
  return order[a.kind] - order[b.kind] || a.name.localeCompare(b.name);
}
