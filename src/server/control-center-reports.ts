import { actingAccountFromSession, runAsAccount } from "../account-context.js";
import { listLocalUsers, type AuthSession } from "../auth.js";
import { BOB_INSTRUCTIONS } from "../control-center/bob-context.js";
import { REPORT_INSTRUCTIONS, REPORT_WINDOW_HOURS, describeFacts, reportActions, type ReportFacts, type ReportItem } from "../control-center/bob-reports.js";
import { claimDueBobSchedules, ensureBobScheduleSchema, getBobSchedule, recordBobScheduleRun, type BobSchedule } from "../control-center/bob-schedules.js";
import { appendBobMessage, bobDatabase, readBobSettings, type BobMessage, type BobSettings } from "../control-center/bob-store.js";
import { clock, rowMatchesFilter } from "../control-center/automations.js";
import type { HarnessId } from "../types.js";
import { usageTotals } from "../usage-ledger.js";
import { AutomationError, collectAutomations } from "./control-center-automations.js";
import { startReportTimer } from "./control-center-report-timer.js";
import { loadBoard } from "./control-center-board.js";
import { runGitReview } from "./git-review-run.js";
import { iconHarnessId } from "./label-icon.js";
import { projectsWithSharedNames } from "./projects.js";
import { flags } from "./state.js";

/** A report that is more than this late was missed (the server was off or asleep), and is not written afterwards. */
const GRACE_MS = 30 * 60_000;

/** The person a stored schedule belongs to, as a session on this machine. Null when they do not have an account here. */
export function sessionForAccount(accountId: string): AuthSession | null {
  const user = listLocalUsers().find((candidate) => candidate.accountId === accountId && !candidate.disabled);
  return user ? { id: `bob-report:${accountId}`, userId: user.userId, username: user.username, accountId, email: user.email, role: user.role, csrfToken: "", mustChangePassword: false, isRemoteLogin: false, homeNodeId: null } : null;
}

/** What a report is written from: the board, the scheduled and webhook runs, and the cost, for the projects the schedule covers. */
export async function gatherReportFacts(session: AuthSession, schedule: BobSchedule, now: number): Promise<ReportFacts> {
  return runAsAccount(actingAccountFromSession(session), async () => {
    const since = now - REPORT_WINDOW_HOURS[schedule.report] * 3_600_000;
    const [{ cards, projects }, automations] = await Promise.all([loadBoard(session), collectAutomations(session)]);
    const included = schedule.projectIds.length ? projects.filter((project) => schedule.projectIds.includes(project.id)) : projects;
    const ids = new Set(included.map((project) => project.id));
    const item = (card: (typeof cards)[number]): ReportItem => ({ projectId: card.projectId, project: card.projectName, title: card.title, summary: card.summary, conversationId: card.conversationId, at: card.updatedAt });
    const inScope = cards.filter((card) => ids.has(card.projectId));
    const review = inScope.filter((card) => card.column === "review");
    const finishedSince = (card: (typeof cards)[number]) => card.updatedAt !== null && Date.parse(card.updatedAt) >= since;

    const runs = automations.entries.map((entry) => entry.row).filter((row) => row.kind !== "bob" && rowMatchesFilter(row, [...ids]) && row.last.at !== null && Date.parse(row.last.at) >= since);
    return {
      report: schedule.report, since: new Date(since).toISOString(), until: new Date(now).toISOString(), projects: included.map((project) => project.name),
      running: inScope.filter((card) => card.column === "running").map(item),
      finished: review.filter(finishedSince).map(item), waiting: review.filter((card) => !finishedSince(card)).map(item),
      failed: runs.filter((row) => row.last.state === "failed").map((row) => ({ kind: row.kind as "schedule" | "webhook", id: row.id, name: row.name, projectId: row.projectId!, project: row.projectName, at: row.last.at, error: row.last.detail, nodeId: row.nodeId })),
      succeededRuns: runs.filter((row) => row.kind === "schedule" && row.last.state === "ok").length,
      cost: included.flatMap((project) => {
        const usd = usageTotals({ projectIds: [project.id], from: new Date(since).toISOString() }).apiCostUsd;
        return usd ? [{ project: project.name, usd }] : [];
      }),
    };
  });
}

/** Bob's own agent writes the report from the facts. It reads nothing else and changes nothing. */
async function writeWithAgent(facts: ReportFacts, settings: BobSettings, project: { id: string; path: string } | undefined): Promise<string> {
  if (!project) throw new Error("there is no project for Bob's agent to run in");
  const result = await runGitReview({
    projectId: project.id, cwd: project.path, harnessId: (settings.harnessId || iconHarnessId()) as HarnessId, provider: settings.provider, modelId: settings.modelId, thinkingLevel: settings.thinkingLevel,
    selection: { scope: "context", label: "Bob report" }, question: "", diff: describeFacts(facts), instructions: [BOB_INSTRUCTIONS, REPORT_INSTRUCTIONS].join("\n"),
  });
  return result.answer.trim();
}

export interface ReportDeps {
  gather(session: AuthSession, schedule: BobSchedule, now: number): Promise<ReportFacts>;
  /** Bob's agent writes the report. It may fail; the facts are posted instead and the note says why. */
  write(facts: ReportFacts, settings: BobSettings, session: AuthSession): Promise<string>;
  /** False while the server is still starting. */
  ready(): boolean;
  /** The person a stored schedule belongs to, as a session on this machine. */
  session(accountId: string): AuthSession | null;
}

export const reportDeps: ReportDeps = {
  gather: gatherReportFacts,
  async write(facts, settings, session) {
    const [project] = await runAsAccount(actingAccountFromSession(session), () => projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false }));
    return writeWithAgent(facts, settings, project);
  },
  ready: () => flags.startupReady,
  session: sessionForAccount,
};

/** For tests that run a whole node: what writes a report, instead of Bob's agent. */
export function setReportWriter(write: ReportDeps["write"]): void { reportDeps.write = write; }

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 160);

/** Writes one report and posts it in Bob's chat, with a button for each thing that needs the person. */
export async function runReport(session: AuthSession, schedule: BobSchedule, how: "scheduled" | "now", now = Date.now(), deps: ReportDeps = reportDeps): Promise<BobMessage> {
  const db = await bobDatabase();
  const facts = await deps.gather(session, schedule, now);
  const settings = readBobSettings(db, schedule.accountId);
  let text: string;
  let by: string;
  try {
    text = await runAsAccount(actingAccountFromSession(session), () => deps.write(facts, settings, session));
    if (!text) throw new Error("it wrote nothing");
    by = "written by Bob's agent";
  } catch (error) {
    text = describeFacts(facts);
    by = `facts only, Bob's agent could not write it: ${reason(error)}`;
  }
  const when = how === "scheduled" ? `scheduled ${clock(schedule.hour, schedule.minute)}` : "sent now";
  // A report about one project is labelled with it; any other is General.
  const single = schedule.projectIds.length === 1 && facts.projects.length === 1;
  return appendBobMessage(db, schedule.accountId, {
    role: "bob", text, via: `${schedule.name} · ${when} · ${by}`, importance: "report",
    projectId: single ? schedule.projectIds[0] : null, projectName: single ? facts.projects[0] : null, actions: reportActions(facts),
  });
}

/** The report a person asked for with the Send now button. It runs even while Bob is paused: they asked for it. */
export async function sendReportNow(session: AuthSession, id: string, now = Date.now(), deps: ReportDeps = reportDeps): Promise<BobMessage> {
  const db = await bobDatabase();
  ensureBobScheduleSchema(db);
  const schedule = getBobSchedule(db, session.accountId, id);
  if (!schedule) throw new AutomationError(404, "That report is no longer there");
  try {
    const message = await runReport(session, schedule, "now", now, deps);
    recordBobScheduleRun(db, id, { at: now, status: "ok", note: "Sent when you asked" });
    return message;
  } catch (error) {
    recordBobScheduleRun(db, id, { at: now, status: "failed", note: reason(error) });
    throw error;
  }
}

/**
 * Runs every report that is due. A report is skipped, and not kept for later, while Bob is paused, when the server was off
 * at its time, or while the server is still starting. The outcome of each, skipped or not, is kept on the schedule.
 */
export async function dispatchDueReports(now: number, deps: ReportDeps = reportDeps): Promise<void> {
  const db = await bobDatabase();
  ensureBobScheduleSchema(db);
  for (const { schedule, dueAt } of claimDueBobSchedules(db, now)) {
    const record = (status: "ok" | "failed" | "skipped", note: string | null) => recordBobScheduleRun(db, schedule.id, { at: now, status, note });
    if (!deps.ready()) { record("skipped", "The server was still starting"); continue; }
    if (!readBobSettings(db, schedule.accountId).monitoring) { record("skipped", "Bob was paused, so this report was not written"); continue; }
    if (now - dueAt > GRACE_MS) { record("skipped", `Missed at ${clock(schedule.hour, schedule.minute)}: the server was not running`); continue; }
    const session = deps.session(schedule.accountId);
    if (!session) { record("skipped", "This person has no account on this machine"); continue; }
    try {
      await runReport(session, schedule, "scheduled", now, deps);
      record("ok", null);
    } catch (error) {
      record("failed", reason(error));
    }
  }
}

/** Starts Bob's report timer. Called once, when the server loads. */
export function startBobReports(): void {
  startReportTimer((now) => dispatchDueReports(now));
}
