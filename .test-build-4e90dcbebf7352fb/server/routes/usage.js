import { z } from "zod";
import { getClusterNode } from "../../cluster.js";
import { listSharingClusterMembers, listSharingMemberships } from "../../cluster-sharing-policy.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { getProject } from "../../store.js";
import { deleteSubscriptionPlan, listSubscriptionPlans, saveSubscriptionPlan, subscriptionPlanInputSchema } from "../../subscription-usage.js";
import { usageBreakdown, usageConversationPage, usageConversations, usageInventoryCoverage, usageTotals } from "../../usage-ledger.js";
import { collectSubscriptionDetections } from "../../subscription-detection.js";
import { sendError } from "../http-auth.js";
import { projectsWithSharedNames } from "../projects.js";
import { app } from "../state.js";
import { requestUsageRefresh, usageRefreshStatus } from "../usage.js";
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === `${value}T00:00:00.000Z`;
}, "Invalid calendar date");
const querySchema = z.object({
  projectId: z.string().min(1).max(200).optional(),
  conversationId: z.string().min(1).max(300).optional(),
  from: date.optional(),
  to: date.optional(),
  engine: z.string().min(1).max(80).optional(),
  modelId: z.string().min(1).max(300).optional(),
  provider: z.string().min(1).max(200).optional(),
  classification: z.string().min(1).max(80).optional(),
  difficulty: z.string().regex(/^(?:[1-9]|10|not-classified)$/).optional(),
  clusters: z.string().min(1).max(2e3).transform((value) => [...new Set(value.split(","))]).pipe(z.array(z.union([z.literal("local"), z.string().uuid()])).max(50)).optional(),
  page: z.coerce.number().int().positive().max(1e6).default(1),
  pageSize: z.coerce.number().int().positive().max(50).default(20),
  utcOffset: z.coerce.number().int().min(-840).max(840).default(0),
  refresh: z.enum(["true", "false"]).default("true")
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, { message: "from must not be after to" });
async function originNodeIds(clusters) {
  const local = await getClusterNode();
  const db = await clusterV2Database();
  const joined = new Set(listSharingMemberships(db, local.id).map((membership) => membership.clusterId));
  const nodes = /* @__PURE__ */ new Set();
  for (const value of clusters) {
    if (value === "local") {
      nodes.add(local.id);
      nodes.add("");
      continue;
    }
    if (!joined.has(value)) throw Object.assign(new Error("Cluster not found"), { statusCode: 404 });
    for (const member of listSharingClusterMembers(db, value)) if (member.nodeId !== local.id) nodes.add(member.nodeId);
  }
  return [...nodes];
}
async function validatedQuery(raw) {
  const query = querySchema.parse(raw);
  if (!query.projectId) return query;
  const project = await getProject(query.projectId);
  if (!project) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  return { ...query, projectId: project.id };
}
async function dashboard(query, suppliedProjects) {
  const projects = suppliedProjects ?? await projectsWithSharedNames(false);
  const ids = projects.map((project) => project.id);
  if (query.projectId && !ids.includes(query.projectId)) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  const midnight = (day, addDays = 0) => new Date(Date.parse(`${day}T00:00:00.000Z`) + addDays * 864e5 - query.utcOffset * 6e4).toISOString();
  const { page: _page, pageSize: _pageSize, refresh: _refresh, clusters, utcOffset, ...filterQuery } = query;
  const filters = {
    projectIds: ids,
    ...filterQuery,
    ...clusters ? { originNodeIds: await originNodeIds(clusters) } : {},
    ...utcOffset ? { dayOffsetMinutes: utcOffset } : {},
    from: query.from ? midnight(query.from) : void 0,
    to: query.to ? midnight(query.to, 1) : void 0
  };
  let conversationPage = usageConversationPage(filters, query.page, query.pageSize);
  const totalPages = Math.max(1, Math.ceil(conversationPage.total / query.pageSize));
  const page = Math.min(query.page, totalPages);
  if (page !== query.page) conversationPage = usageConversationPage(filters, page, query.pageSize);
  const visibleConversationIds = [.../* @__PURE__ */ new Set([...conversationPage.rows.map((row) => row.key), ...query.conversationId ? [query.conversationId] : []])];
  return {
    summary: usageTotals(filters),
    breakdowns: {
      projects: usageBreakdown(filters, "project"),
      conversations: conversationPage.rows,
      classifications: usageBreakdown(filters, "classification"),
      difficulties: usageBreakdown(filters, "difficulty"),
      models: usageBreakdown(filters, "model"),
      days: usageBreakdown(filters, "day")
    },
    conversations: usageConversations(filters.projectId ? [filters.projectId] : ids, visibleConversationIds),
    conversationPagination: { page, pageSize: query.pageSize, total: conversationPage.total, totalPages: conversationPage.total ? totalPages : 0 },
    projects: projects.map(({ id, name }) => ({ id, name }))
  };
}
app.get(["/api/usage", "/api/usage/summary"], async (request, response, next) => {
  try {
    const query = await validatedQuery(request.query);
    const projects = await projectsWithSharedNames(false);
    const result = await dashboard(query, projects);
    const savedCoverage = usageInventoryCoverage(result.projects.map((project) => project.id));
    if (query.refresh === "true") requestUsageRefresh();
    response.json({ ...result, coverage: { scope: "observed transcripts and replicated usage", ...savedCoverage, ...usageRefreshStatus() }, subscriptions: listSubscriptionPlans(response.locals.authSession.username) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
      return;
    }
    if (error.statusCode === 404) {
      sendError(response, 404, error.message);
      return;
    }
    next(error);
  }
});
app.post("/api/usage/refresh", (_request, response) => {
  requestUsageRefresh(true);
  response.status(202).json({ ...usageRefreshStatus(), accepted: true });
});
app.get("/api/subscription-usage/detected", async (_request, response, next) => {
  try {
    response.json({ detections: await collectSubscriptionDetections() });
  } catch (error) {
    next(error);
  }
});
app.get("/api/subscription-usage", (_request, response) => response.json({ plans: listSubscriptionPlans(response.locals.authSession.username), automaticQuotaReporting: "unavailable" }));
app.put("/api/subscription-usage", (request, response, next) => {
  try {
    response.json(saveSubscriptionPlan(response.locals.authSession.username, subscriptionPlanInputSchema.parse(request.body)));
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
      return;
    }
    if (error.statusCode === 409) {
      sendError(response, 409, "Subscription plan belongs to another account");
      return;
    }
    next(error);
  }
});
app.delete("/api/subscription-usage/:id", (request, response) => {
  const removed = deleteSubscriptionPlan(response.locals.authSession.username, request.params.id);
  response.status(removed ? 204 : 404).send();
});
