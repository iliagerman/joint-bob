import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { getProject } from "../../store.js";
import { deleteSubscriptionPlan, listSubscriptionPlans, saveSubscriptionPlan, subscriptionPlanInputSchema } from "../../subscription-usage.js";
import { usageBreakdown, usageConversations, usageTotals } from "../../usage-ledger.js";
import type { UsageFilters } from "../../usage-types.js";
import { sendError } from "../http-auth.js";
import { projectsWithSharedNames } from "../projects.js";
import { app } from "../state.js";
import { refreshAllUsage } from "../usage.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === `${value}T00:00:00.000Z`;
}, "Invalid calendar date");
const querySchema = z.object({
  projectId: z.string().min(1).max(200).optional(), conversationId: z.string().min(1).max(300).optional(),
  from: date.optional(), to: date.optional(), engine: z.string().min(1).max(80).optional(),
  modelId: z.string().min(1).max(300).optional(), provider: z.string().min(1).max(200).optional(),
  classification: z.string().min(1).max(80).optional(),
  difficulty: z.string().regex(/^(?:[1-9]|10|not-classified)$/).optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, { message: "from must not be after to" });
type UsageQuery = z.infer<typeof querySchema>;

async function validatedQuery(raw: unknown): Promise<UsageQuery> {
  const query = querySchema.parse(raw);
  if (!query.projectId) return query;
  const project = await getProject(query.projectId);
  if (!project) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  return { ...query, projectId: project.id };
}

async function dashboard(query: UsageQuery) {
  const projects = await projectsWithSharedNames(false);
  const ids = projects.map((project) => project.id);
  if (query.projectId && !ids.includes(query.projectId)) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  const end = query.to ? new Date(`${query.to}T00:00:00.000Z`) : undefined;
  if (end) end.setUTCDate(end.getUTCDate() + 1);
  const filters: UsageFilters = {
    projectIds: ids, ...query,
    from: query.from ? `${query.from}T00:00:00.000Z` : undefined,
    to: end?.toISOString(),
  };
  return {
    summary: usageTotals(filters),
    breakdowns: {
      projects: usageBreakdown(filters, "project"), conversations: usageBreakdown(filters, "conversation"),
      classifications: usageBreakdown(filters, "classification"), difficulties: usageBreakdown(filters, "difficulty"),
      models: usageBreakdown(filters, "model"), days: usageBreakdown(filters, "day"),
    },
    conversations: usageConversations(filters.projectId ? [filters.projectId] : ids),
    projects: projects.map(({ id, name }) => ({ id, name })),
  };
}

app.get(["/api/usage", "/api/usage/summary"], async (request, response, next) => {
  try {
    const query = await validatedQuery(request.query);
    const coverage = await refreshAllUsage();
    response.json({ ...await dashboard(query), coverage: { scope: "observed transcripts and replicated usage", ...coverage }, subscriptions: listSubscriptionPlans((response.locals.authSession as AuthSession).username) });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => issue.message).join(", ")); return; }
    if ((error as { statusCode?: number }).statusCode === 404) { sendError(response, 404, "Project not found"); return; }
    next(error);
  }
});
app.post("/api/usage/refresh", async (_request, response, next) => { try { response.json(await refreshAllUsage(true)); } catch (error) { next(error); } });
app.get("/api/subscription-usage", (_request, response) => response.json({ plans: listSubscriptionPlans((response.locals.authSession as AuthSession).username), automaticQuotaReporting: "unavailable" }));
app.put("/api/subscription-usage", (request, response, next) => {
  try { response.json(saveSubscriptionPlan((response.locals.authSession as AuthSession).username, subscriptionPlanInputSchema.parse(request.body))); }
  catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => issue.message).join(", ")); return; }
    if ((error as { statusCode?: number }).statusCode === 409) { sendError(response, 409, "Subscription plan belongs to another account"); return; }
    next(error);
  }
});
app.delete("/api/subscription-usage/:id", (request, response) => { const removed = deleteSubscriptionPlan((response.locals.authSession as AuthSession).username, request.params.id); response.status(removed ? 204 : 404).send(); });
