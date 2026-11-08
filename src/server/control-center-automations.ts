import { z } from "zod";
import { actingAccountFromSession, runAsAccount } from "../account-context.js";
import type { AuthSession } from "../auth.js";
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { bobRow, compareRows, rowMatchesFilter, scheduleRow, webhookRow, type AutomationKind, type AutomationRow, type RowContext } from "../control-center/automations.js";
import { bobScheduleChangeSchema, bobScheduleInputSchema, createBobSchedule, deleteBobSchedule, ensureBobScheduleSchema, listBobSchedules, updateBobSchedule, type BobSchedule } from "../control-center/bob-schedules.js";
import { bobDatabase } from "../control-center/bob-store.js";
import { calendarDateSchema, type CronInput, type CronTask } from "../cron.js";
import { Feature, hasFeature } from "../features.js";
import { getProject } from "../store.js";
import { webhookDeliveries, webhookInputSchema, type Webhook } from "../webhooks.js";
import { listProjectCronTasks } from "./cron-list.js";
import { iconHarnessId } from "./label-icon.js";
import { projectsWithSharedNames } from "./projects.js";
import { listRuntimePeers } from "./runtime-peers.js";
import { runCronCommand } from "./routes/cron.js";
import { runWebhookCommand, webhookOwners } from "./routes/webhooks.js";
import { rearmReportTimer } from "./control-center-report-timer.js";

/** A refusal the person can act on: nothing there, or not theirs to change. */
export class AutomationError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}

interface Entry { row: AutomationRow; task?: CronTask; webhook?: Webhook; bob?: BobSchedule }
export interface Collected { entries: Entry[]; projects: Array<{ id: string; name: string }>; errors: string[] }

const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/** Every scheduled task, webhook and Bob schedule the person can see, with the same fields the table shows. */
export async function collectAutomations(session: AuthSession): Promise<Collected> {
  return runAsAccount(actingAccountFromSession(session), async () => {
    const db = await bobDatabase();
    ensureBobScheduleSchema(db);
    const [projects, local, peers] = await Promise.all([projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false }), getClusterNode(), listRuntimePeers()]);
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));
    const nodeNames = new Map([[local.id, local.name], ...peers.map((peer) => [peer.id, peer.name] as const)]);
    const context: RowContext = { projectName: (id) => projectNames.get(id) ?? id, nodeName: (id) => nodeNames.get(id) ?? null, accountId: session.accountId };
    const errors: string[] = [];
    const entries: Entry[] = [];
    const seen = new Set<string>();

    const lists = await Promise.all(projects.map((project) => listProjectCronTasks(project.id).catch((error: unknown) => { errors.push(`${project.name}: ${failure(error)}`); return { tasks: [] as CronTask[], errors: [] }; })));
    for (const list of lists) {
      for (const problem of list.errors) errors.push(`${nodeNames.get(problem.nodeId) ?? "A machine"}: ${"error" in problem ? problem.error : "could not be read"}`);
      for (const task of list.tasks) {
        if (seen.has(`schedule:${task.id}`) || !projectNames.has(task.projectId)) continue;
        seen.add(`schedule:${task.id}`);
        entries.push({ row: scheduleRow(task, context), task });
      }
    }

    // A person who signed in from another machine does not manage webhooks, so they are not listed to them either.
    if (hasFeature({ isRemoteLogin: session.isRemoteLogin }, Feature.SETTINGS)) {
      const database = await clusterV2Database();
      const owners = await webhookOwners();
      await Promise.all(owners.map(async (owner) => {
        try {
          const { webhooks } = await runWebhookCommand(owner.id, { action: "list" }) as { webhooks: Webhook[] };
          for (const hook of webhooks) {
            if (seen.has(`webhook:${hook.id}`) || !projectNames.has(hook.target.projectId)) continue;
            seen.add(`webhook:${hook.id}`);
            entries.push({ row: webhookRow(hook, { ...context, nodeId: owner.id, delivery: owner.local ? webhookDeliveries(database, hook.id)[0] : undefined }), webhook: hook });
          }
        } catch (error) { errors.push(`${owner.name}: ${failure(error)}`); }
      }));
    }

    for (const schedule of listBobSchedules(db, session.accountId)) entries.push({ row: bobRow(schedule, { projectName: context.projectName, nodeId: local.id, nodeName: local.name }), bob: schedule });
    entries.sort((a, b) => compareRows(a.row, b.row));
    return { entries, projects: projects.map((project) => ({ id: project.id, name: project.name })), errors };
  });
}

export async function listAutomations(session: AuthSession): Promise<{ rows: AutomationRow[]; projects: Collected["projects"]; errors: string[]; timezone: string }> {
  const { entries, projects, errors } = await collectAutomations(session);
  return { rows: entries.map((entry) => entry.row), projects, errors, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

async function find(session: AuthSession, kind: AutomationKind, id: string): Promise<{ entry: Entry; collected: Collected }> {
  const collected = await collectAutomations(session);
  const entry = collected.entries.find((candidate) => candidate.row.kind === kind && candidate.row.id === id);
  if (!entry) throw new AutomationError(404, "That automation is no longer there");
  return { entry, collected };
}

function mustBeEditable(entry: Entry): void {
  if (!entry.row.editable) throw new AutomationError(403, `Only the person who made "${entry.row.name}" can change it`);
}

/** Entries matching a project filter, for the chat's list. */
export function entriesMatching(collected: Collected, filter: readonly string[]): Entry[] {
  return collected.entries.filter((entry) => rowMatchesFilter(entry.row, filter));
}

function cronInputOf(task: CronTask): CronInput {
  const { id: _id, nextRun: _nextRun, lastRun: _lastRun, ...input } = task;
  return input;
}

function webhookInputOf(hook: Webhook, changes: { name?: string; context?: string; enabled?: boolean } = {}) {
  return webhookInputSchema.parse({
    providerProfileId: hook.providerProfileId ?? null, tags: hook.tags, name: hook.name, target: hook.target, context: hook.context, enabled: hook.enabled,
    attachments: hook.attachments, preserveFiles: hook.preserveFiles, markForReview: hook.markForReview, hideFromHistory: hook.hideFromHistory,
    senders: hook.senders, model: hook.model, reasoning: hook.reasoning, secretAccountIds: hook.secretAccountIds, titleTemplate: hook.titleTemplate, ...changes,
  });
}

/** Turns a scheduled task, a webhook or a Bob report on or off through the same commands the other screens use. */
export async function setAutomationEnabled(session: AuthSession, kind: AutomationKind, id: string, enabled: boolean): Promise<AutomationRow> {
  const { entry } = await find(session, kind, id);
  mustBeEditable(entry);
  await runAsAccount(actingAccountFromSession(session), async () => {
    if (entry.task) await runCronCommand(entry.task.ownerNodeId, { action: "update", id: entry.task.id, input: { ...cronInputOf(entry.task), enabled } });
    else if (entry.webhook) await runWebhookCommand(entry.row.nodeId!, { action: "update", id, input: webhookInputOf(entry.webhook, { enabled }) });
    else {
      updateBobSchedule(await bobDatabase(), session.accountId, id, { enabled });
      rearmReportTimer();
    }
  });
  return { ...entry.row, enabled };
}

/** Deletes one automation. Whoever sees a task's or webhook's project may delete it; a Bob schedule is its owner's. */
export async function deleteAutomation(session: AuthSession, kind: AutomationKind, id: string): Promise<AutomationRow> {
  const { entry } = await find(session, kind, id);
  await runAsAccount(actingAccountFromSession(session), async () => {
    if (entry.task) await runCronCommand(entry.task.ownerNodeId, { action: "delete", id, projectId: entry.task.projectId });
    else if (entry.webhook) await runWebhookCommand(entry.row.nodeId!, { action: "delete", id });
    else {
      deleteBobSchedule(await bobDatabase(), session.accountId, id);
      rearmReportTimer();
    }
  });
  return entry.row;
}

// ── Compact forms ──────────────────────────────────────────────────────────────────────────────────────

const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const timezoneSchema = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Unknown timezone");

const compactSchedule = z.object({
  frequency: z.enum(["once", "hourly", "daily", "weekly", "monthly"]),
  time: clockSchema,
  weekday: z.number().int().min(0).max(6).default(1),
  /** The day a one-time task runs, the first day of a monthly one (whose date it repeats on), or the first day of any other. */
  date: calendarDateSchema.nullable().optional(),
  /** The last day a repeating task may run. */
  until: calendarDateSchema.nullable().optional(),
  timezone: timezoneSchema,
}).strict();
export type CompactSchedule = z.infer<typeof compactSchedule>;

export const scheduledTaskInputSchema = z.object({
  projectId: z.string().min(1).max(240),
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(100_000),
  schedule: compactSchedule,
  enabled: z.boolean().default(true),
}).strict();
export type ScheduledTaskInput = z.input<typeof scheduledTaskInputSchema>;

export const scheduledTaskChangeSchema = z.object({
  name: z.string().trim().min(1).max(120), prompt: z.string().trim().min(1).max(100_000), schedule: compactSchedule, enabled: z.boolean(),
}).partial().strict();
export type ScheduledTaskChange = z.infer<typeof scheduledTaskChangeSchema>;

export const webhookInputCompactSchema = z.object({
  projectId: z.string().min(1).max(240),
  name: z.string().trim().min(1).max(120),
  context: z.string().trim().max(10_000).default(""),
  enabled: z.boolean().default(true),
}).strict();
export type WebhookCompactInput = z.input<typeof webhookInputCompactSchema>;

export const webhookChangeSchema = z.object({ name: z.string().trim().min(1).max(120), context: z.string().trim().max(10_000), enabled: z.boolean() }).partial().strict();

export const reportInputSchema = bobScheduleInputSchema;
export const reportChangeSchema = bobScheduleChangeSchema;

function cronSchedule(compact: CompactSchedule): CronInput["schedule"] {
  const hour = Number(compact.time.slice(0, 2));
  const minute = Number(compact.time.slice(3));
  const every = [0, 1, 2, 3, 4, 5, 6];
  const days = { ...compact.date ? { startDate: compact.date } : {}, ...compact.until && compact.frequency !== "once" ? { endDate: compact.until } : {} };
  const base = { hour, minute, weekday: compact.weekday, timezone: compact.timezone, ...days };
  if (compact.frequency === "once" || compact.frequency === "monthly" || compact.frequency === "weekly") return { frequency: compact.frequency, ...base };
  if (compact.frequency === "hourly") return { frequency: "hourly", intervalHours: 1, startHour: hour, days: every, ...base };
  return { frequency: "daily", days: every, ...base };
}

async function mustSeeProject(session: AuthSession, projectId: string): Promise<string> {
  const projects = await runAsAccount(actingAccountFromSession(session), () => projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false }));
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new AutomationError(404, "That project is not available to you");
  return project.name;
}

/** The agent a new scheduled task runs with when nobody chose one: the node's usual helper agent. */
function defaultEngine(): string {
  try { return iconHarnessId(); } catch { throw new AutomationError(409, "No agent is set up on this machine to run scheduled tasks"); }
}

export async function createScheduledTask(session: AuthSession, raw: ScheduledTaskInput): Promise<CronTask> {
  const input = scheduledTaskInputSchema.parse(raw);
  await mustSeeProject(session, input.projectId);
  return runAsAccount(actingAccountFromSession(session), async () => {
    const local = await getClusterNode();
    if (!await getProject(input.projectId)) throw new AutomationError(409, "This project is not on this machine, so a scheduled task cannot be created here");
    const cron: CronInput = {
      assistantId: null, tags: { managedTagIds: [], manualTags: [] }, projectId: input.projectId, name: input.name, prompt: input.prompt, ownerNodeId: local.id,
      engine: defaultEngine(), model: null, sessionId: null, enabled: input.enabled, pauseOnFailure: false, markForReview: false, hideFromHistory: false,
      schedule: cronSchedule(input.schedule),
    };
    const { task } = await runCronCommand(local.id, { action: "create", input: cron }) as { task: CronTask };
    return task;
  });
}

export async function updateScheduledTask(session: AuthSession, id: string, raw: ScheduledTaskChange): Promise<void> {
  const change = scheduledTaskChangeSchema.parse(raw);
  const { entry } = await find(session, "schedule", id);
  mustBeEditable(entry);
  const task = entry.task!;
  if (change.schedule && entry.row.edit.kind === "schedule" && !entry.row.edit.simple) throw new AutomationError(409, "This schedule has options the quick editor cannot show; use More options");
  const input: CronInput = {
    ...cronInputOf(task), name: change.name ?? task.name, prompt: change.prompt ?? task.prompt, enabled: change.enabled ?? task.enabled,
    schedule: change.schedule ? cronSchedule(change.schedule) : task.schedule,
  };
  await runAsAccount(actingAccountFromSession(session), () => runCronCommand(task.ownerNodeId, { action: "update", id, input }));
}

export async function createWebhookCompact(session: AuthSession, raw: WebhookCompactInput): Promise<{ webhook: Webhook; secret: string; bases: Array<{ id: string; label: string; base: string }> }> {
  const input = webhookInputCompactSchema.parse(raw);
  await mustSeeProject(session, input.projectId);
  if (!hasFeature({ isRemoteLogin: session.isRemoteLogin }, Feature.SETTINGS)) throw new AutomationError(403, "Webhooks are managed on the machine you sign in at home");
  const body = webhookInputSchema.parse({ name: input.name, target: { kind: "project", projectId: input.projectId }, context: input.context, enabled: input.enabled });
  return await runAsAccount(actingAccountFromSession(session), () => runWebhookCommand(undefined, { action: "create", input: body })) as Awaited<ReturnType<typeof createWebhookCompact>>;
}

export async function updateWebhookCompact(session: AuthSession, id: string, raw: z.infer<typeof webhookChangeSchema>): Promise<void> {
  const change = webhookChangeSchema.parse(raw);
  const { entry } = await find(session, "webhook", id);
  mustBeEditable(entry);
  await runAsAccount(actingAccountFromSession(session), () => runWebhookCommand(entry.row.nodeId!, { action: "update", id, input: webhookInputOf(entry.webhook!, change) }));
}

/** Resolves the projects a report covers: every one must be visible to the person. */
async function reportProjects(session: AuthSession, projectIds: readonly string[]): Promise<void> {
  const visible = new Set((await runAsAccount(actingAccountFromSession(session), () => projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false }))).map((project) => project.id));
  const unknown = projectIds.filter((id) => !visible.has(id));
  if (unknown.length) throw new AutomationError(404, "A project in that report is not available to you");
}

export async function createReport(session: AuthSession, raw: z.input<typeof reportInputSchema>): Promise<BobSchedule> {
  const input = reportInputSchema.parse(raw);
  await reportProjects(session, input.projectIds);
  const schedule = createBobSchedule(await bobDatabase(), session.accountId, input);
  rearmReportTimer();
  return schedule;
}

export async function updateReport(session: AuthSession, id: string, raw: z.input<typeof reportChangeSchema>): Promise<BobSchedule> {
  const change = reportChangeSchema.parse(raw);
  if (change.projectIds) await reportProjects(session, change.projectIds);
  const schedule = updateBobSchedule(await bobDatabase(), session.accountId, id, change);
  if (!schedule) throw new AutomationError(404, "That report is no longer there");
  rearmReportTimer();
  return schedule;
}
