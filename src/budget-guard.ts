import { asNode } from "./account-context.js";
import { describeBudget, evaluateBudgets, firstExceeded, BudgetExceededError, type BudgetProject, type BudgetStatus, type SpendReader } from "./budgets.js";
import { getSharingCluster } from "./cluster-sharing-policy.js";
import { clusterV2Database } from "./cluster-v2-store.js";
import { listHarnessSessions } from "./harnesses.js";
import type { HarnessOpenOptions, HarnessRuntime, HarnessSession } from "./harnesses/runtime.js";
import { listProjects } from "./store.js";
import { recordTurnFailure } from "./turn-failures.js";
import type { ProjectRecord } from "./types.js";
import { usageTotals } from "./usage-ledger.js";
import { withFreshUsage } from "./usage-ingest.js";

/** A check within this share of a limit reads the ledger fresh rather than trusting a minute-old copy. */
const FRESH_RATIO = 0.7;

/**
 * A long window over a whole cluster is a scan of the ledger on the server's one thread, and
 * every turn start asks. A recent answer is reused unless the check is close to a limit.
 */
const SPEND_REUSE_MS = 15_000;
const recentSpend = new Map<string, { at: number; usd: number }>();
function spendReader(fresh: boolean): SpendReader {
  return (subject, from, to) => {
    const key = JSON.stringify([subject.projectIds, subject.conversationId ?? "", from ?? "", to ?? ""]);
    const recent = recentSpend.get(key);
    if (!fresh && recent && Date.now() - recent.at < SPEND_REUSE_MS) return recent.usd;
    const usd = usageTotals({ projectIds: subject.projectIds, ...(subject.conversationId ? { conversationId: subject.conversationId } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }).apiCostUsd ?? 0;
    if (recentSpend.size >= 500) recentSpend.clear();
    recentSpend.set(key, { at: Date.now(), usd });
    return usd;
  };
}
export const ledgerSpend: SpendReader = spendReader(false);

const asBudgetProject = (project: ProjectRecord): BudgetProject => ({ id: project.id, type: project.type, clusterIds: project.clusterIds ?? [] });

export interface BudgetCheck { statuses: BudgetStatus[]; project?: ProjectRecord; message?: string; exceeded?: BudgetStatus }

/** Every budget that applies to the conversation, read as the node: a person's own view never narrows a cluster total. */
export async function checkBudgets(projectId: string, conversationId: string | undefined, now = new Date()): Promise<BudgetCheck> {
  const projects = await asNode(() => listProjects());
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) return { statuses: [] };
  const db = await clusterV2Database();
  const evaluate = (spend: SpendReader) => evaluateBudgets({ db, project: asBudgetProject(project), projects: projects.map(asBudgetProject), conversationId, spend, now });
  let statuses = evaluate(ledgerSpend);
  if (statuses.some((status) => status.ratio >= FRESH_RATIO)) {
    await withFreshUsage(() => asNode(() => listHarnessSessions(project))).catch((error) => console.warn("Could not refresh usage before a budget check", error));
    statuses = evaluate(spendReader(true));
  }
  const exceeded = firstExceeded(statuses);
  if (!exceeded) return { statuses, project };
  const names = { project: project.name, workspace: exceeded.rule.subjectId, cluster: (id: string) => { try { return getSharingCluster(db, id).name; } catch { return undefined; } } };
  return { statuses, project, exceeded, message: describeBudget(exceeded, names) };
}

/** Refuses the turn when a budget is used up. A broken check lets the turn through: a bug here must not stop all work. */
export async function assertWithinBudget(projectId: string, conversationId: string | undefined): Promise<void> {
  let check: BudgetCheck;
  try { check = await checkBudgets(projectId, conversationId); }
  catch (error) { console.warn("Budget check failed; allowing the turn", error); return; }
  if (check.exceeded && check.message) throw new BudgetExceededError(check.message, check.exceeded);
}

/**
 * Puts the check in front of every model run a session starts: a chat turn, a goal turn,
 * compaction, a ticket run or an internal review all reach the harness through these two calls.
 */
export function guardSession(session: HarnessSession, options: Pick<HarnessOpenOptions, "projectId" | "conversationId" | "sessionId">, assertBudget = assertWithinBudget): HarnessSession {
  const conversationId = options.conversationId ?? options.sessionId;
  const prompt = session.prompt.bind(session), compact = session.compact.bind(session);
  session.prompt = async (input) => {
    const earlier = input.beforeStart;
    return prompt({ ...input, beforeStart: async () => { await earlier?.(); await assertBudget(options.projectId, conversationId); } });
  };
  session.compact = async (instructions, beforeStart) => compact(instructions, async () => { await beforeStart?.(); await assertBudget(options.projectId, conversationId); });
  return session;
}

const guarded = new WeakSet<HarnessRuntime>();
export function guardRuntime(runtime: HarnessRuntime): HarnessRuntime {
  if (guarded.has(runtime) || typeof runtime.open !== "function") return runtime;
  guarded.add(runtime);
  const open = runtime.open.bind(runtime);
  runtime.open = async (options) => guardSession(await open(options), options);
  return runtime;
}

/** Turns already running when a budget runs out; one stop per turn. */
const stopped = new Set<string>();

/** Called from the minute tick: stops a running turn whose budget is used up. */
export async function enforceRunningBudgets(): Promise<void> {
  const { listHarnessSessionsRunning } = await import("./server/harness-sessions.js");
  const running = listHarnessSessionsRunning();
  const live = new Set(running.map((shared) => `${shared.engine}:${shared.session.id}:${shared.turnStartedAt ?? ""}`));
  for (const key of stopped) if (!live.has(key)) stopped.delete(key);
  await Promise.all(running.map(async (shared) => {
    const key = `${shared.engine}:${shared.session.id}:${shared.turnStartedAt ?? ""}`;
    if (stopped.has(key) || shared.watchdogStopping) return;
    try {
      const check = await checkBudgets(shared.projectId, shared.conversationId);
      if (!check.exceeded || !check.message) return;
      stopped.add(key);
      recordTurnFailure(shared.engine, shared.session.id, `Stopped: ${check.message}`);
      await shared.session.cancel();
      console.warn(`Stopped ${shared.engine} conversation ${shared.session.id}: budget used up`);
    } catch (error) { console.warn(`Budget check for ${shared.engine} conversation ${shared.session.id} failed`, error); }
  }));
}
