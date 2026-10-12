import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { BudgetError, budgetLimitSchema, listLocalLimits, setLocalLimits, type LocalLimitSubject } from "../../budgets.js";
import { checkBudgets } from "../../budget-guard.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { getProject } from "../../store.js";
import { isNodeAdmin, requireAdmin } from "../admin.js";
import { clusterBudgets, receiveBudgetPolicy, setClusterBudget } from "../budgets.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

const offset = z.number().int().min(-840).max(840);
const policyBody = z.object({ clusterId: z.string().uuid(), revision: z.number().int().positive(), policy: z.unknown() }).strict();
const subjectQuery = z.object({
  kind: z.enum(["workspace", "project", "conversation"]), subjectId: z.string().min(1).max(300), projectId: z.string().min(1).max(200).optional(),
}).strict().refine((value) => value.kind !== "conversation" || Boolean(value.projectId), "A conversation needs its project");
const limitsBody = z.object({ limits: z.array(budgetLimitSchema), utcOffsetMinutes: offset.default(0) }).strict();

function fail(error: unknown, response: Parameters<typeof sendError>[0], next: (error?: unknown) => void): void {
  if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => issue.message).join(", ")); return; }
  if (error instanceof BudgetError) { sendError(response, error.statusCode, error.message); return; }
  next(error);
}

app.post("/api/cluster/v2/budgets/policy", async (request, response, next) => {
  try {
    const sender = response.locals.machineProtocol === 2 && typeof response.locals.machineNodeId === "string" ? response.locals.machineNodeId : undefined;
    if (!sender) { sendError(response, 401, "Unauthorized"); return; }
    const body = policyBody.parse(request.body);
    response.json({ applied: await receiveBudgetPolicy(sender, body.clusterId, body.revision, body.policy) });
  } catch (error) { fail(error, response, next); }
});

app.get("/api/budgets/clusters", async (_request, response, next) => {
  try { response.json({ clusters: await clusterBudgets() }); } catch (error) { next(error); }
});

app.put("/api/budgets/clusters/:clusterId", requireAdmin, async (request, response, next) => {
  try { response.json(await setClusterBudget(z.string().uuid().parse(request.params.clusterId), request.body)); }
  catch (error) { fail(error, response, next); }
});

/** Every budget that applies to a conversation, with what each has spent. */
app.get("/api/budgets/status", async (request, response, next) => {
  try {
    const { projectId, conversationId } = z.object({ projectId: z.string().min(1).max(200), conversationId: z.string().min(1).max(300).optional() }).parse(request.query);
    if (!(await getProject(projectId))) { sendError(response, 404, "Project not found"); return; }
    const check = await checkBudgets(projectId, conversationId);
    response.json({ blocked: Boolean(check.exceeded), message: check.message ?? null, budgets: check.statuses.map((status) => ({
      source: status.rule.source, clusterId: status.rule.clusterId ?? null, kind: status.rule.kind, subjectId: status.rule.subjectId,
      period: status.rule.limit.period, limitUsd: status.rule.limit.usd, spentUsd: status.spentUsd, exceeded: status.exceeded, warning: status.warning, resetsAt: status.resetsAt,
    })) });
  } catch (error) { fail(error, response, next); }
});

/** An item's own limits. They only ever add to a cluster's: the cluster's limits still apply. */
async function ownLimitsAllowed(subject: LocalLimitSubject, session: AuthSession | undefined): Promise<void> {
  if (subject.kind === "workspace") { if (!isNodeAdmin(session)) throw new BudgetError(404, "Not found"); return; }
  const project = await getProject(subject.kind === "project" ? subject.subjectId : subject.projectId!);
  if (!project) throw new BudgetError(404, "Project not found");
  if (project.locallyOwned === false) throw new BudgetError(403, "Only the project's owner can limit it");
}

app.get("/api/budgets/limits", async (request, response, next) => {
  try {
    const subject = subjectQuery.parse(request.query) as LocalLimitSubject;
    await ownLimitsAllowed(subject, response.locals.authSession);
    response.json({ limits: listLocalLimits(await clusterV2Database(), subject) });
  } catch (error) { fail(error, response, next); }
});

app.put("/api/budgets/limits", async (request, response, next) => {
  try {
    const subject = subjectQuery.parse(request.query) as LocalLimitSubject;
    const body = limitsBody.parse(request.body);
    await ownLimitsAllowed(subject, response.locals.authSession);
    setLocalLimits(await clusterV2Database(), subject, body.limits, body.utcOffsetMinutes);
    response.json({ limits: listLocalLimits(await clusterV2Database(), subject) });
  } catch (error) { fail(error, response, next); }
});
