import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { getClusterNode } from "../../cluster.js";
import { getSharingCluster, listSharingClusterMembers, listSharingMemberships } from "../../cluster-sharing-policy.js";
import { actingAccount } from "../../account-context.js";
import { accountInCluster } from "../../cluster-accounts.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { getProject } from "../../store.js";
import { deleteSubscriptionPlan, listSubscriptionPlans, saveSubscriptionPlan, subscriptionPlanInputSchema } from "../../subscription-usage.js";
import { usageBreakdown, usageCalendarBreakdown, usageConversationPage, usageConversationSummaries, usageConversations, usageInventoryCoverage, usageLedgerRevision, usageObservedSince, usageSkillBreakdown, usageTurnTiming, usageTotals } from "../../usage-ledger.js";
import { resourceInventory } from "../../resource-inventory.js";
import { suggestNewSkills, suggestRemovals } from "../../usage-skill-suggestions.js";
import { readSkillContents } from "../../skill-contents.js";
import { calendarBounds } from "../../usage-calendar.js";
import { suggestRepeatableFlows, suggestSkillImprovements } from "../../usage-analysis.js";
import { selectAnalysisConversations } from "../../usage-analysis-scope.js";
import { usageDatabase } from "../../usage-ledger.js";
import { createUsageDraft, draftApproval, draftInput, getUsageDraft, installUsageDraft } from "../../usage-drafts.js";
import { actorOwns } from "../../ownership.js";
import { collectSubscriptionDetections } from "../../subscription-detection.js";
import { usageEventSchema, type UsageFilters } from "../../usage-types.js";
import { sendError } from "../http-auth.js";
import { projectsWithSharedNames } from "../projects.js";
import { app } from "../state.js";
import { requestUsageRefresh, usageRefreshStatus } from "../usage.js";

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
  clusters: z.string().min(1).max(2000).transform((value) => [...new Set(value.split(","))])
    .pipe(z.array(z.union([z.literal("local"), z.string().uuid()])).max(50)).optional(),
  page: z.coerce.number().int().positive().max(1_000_000).default(1),
  pageSize: z.coerce.number().int().positive().max(50).default(20),
  utcOffset: z.coerce.number().int().min(-840).max(840).default(0),
  timeZone: z.string().min(1).max(100).optional(), bucket: z.enum(["day", "hour"]).optional(),
  refresh: z.enum(["true", "false"]).default("true"),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, { message: "from must not be after to" });
type UsageQuery = z.infer<typeof querySchema>;

/**
 * The dashboard's parts. Each one is its own scan of the ledger, so a viewer asks for what it
 * shows first and fills in the rest instead of waiting on all of them in one response.
 */
const SECTIONS = ["summary", "projects", "conversations", "classifications", "difficulties", "models", "days"] as const;
type UsageSection = (typeof SECTIONS)[number];
const sectionsSchema = z.string().min(1).max(200).transform((value) => [...new Set(value.split(","))]).pipe(z.array(z.enum(SECTIONS)).min(1));
/** Lets other requests run: every section holds the server's one thread while its query runs. */
const breathe = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Usage belongs to the node it was recorded on. "local" is this node, including rows saved
 * before origins were stored; a cluster is its other members, as in the conversation filter.
 */
async function originNodeIds(clusters: string[]): Promise<string[]> {
  const local = await getClusterNode();
  const db = await clusterV2Database();
  const joined = new Set(listSharingMemberships(db, local.id).map((membership) => membership.clusterId));
  const nodes = new Set<string>();
  for (const value of clusters) {
    if (value === "local") { nodes.add(local.id); nodes.add(""); continue; }
    const account = actingAccount();
    if (!joined.has(value) || account && (account.isRemoteLogin || !accountInCluster(db, account.accountId, value))) throw Object.assign(new Error("Cluster not found"), { statusCode: 404 });
    for (const member of listSharingClusterMembers(db, value)) if (member.nodeId !== local.id) nodes.add(member.nodeId);
  }
  return [...nodes];
}

async function validatedQuery(raw: unknown): Promise<UsageQuery> {
  const query = querySchema.parse(raw);
  if (!query.projectId) return query;
  const project = await getProject(query.projectId);
  if (!project) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  return { ...query, projectId: project.id };
}

async function dashboard(query: UsageQuery, suppliedProjects?: Awaited<ReturnType<typeof projectsWithSharedNames>>, sections: readonly UsageSection[] = SECTIONS) {
  const projects = suppliedProjects ?? await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false });
  const ids = projects.map((project) => project.id);
  if (query.projectId && !ids.includes(query.projectId)) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  // Dates are the viewer's calendar days: utcOffset is minutes east of UTC, as the browser reports it.
  const midnight = (day: string, addDays = 0) => new Date(Date.parse(`${day}T00:00:00.000Z`) + addDays * 86_400_000 - query.utcOffset * 60_000).toISOString();
  const { page: _page, pageSize: _pageSize, refresh: _refresh, clusters, utcOffset, timeZone, bucket: _bucket, ...filterQuery } = query;
  const bounds = timeZone ? calendarBounds(query.from, query.to, timeZone) : { from: query.from ? midnight(query.from) : undefined, to: query.to ? midnight(query.to, 1) : undefined }; 
  const filters: UsageFilters = {
    projectIds: ids, ...filterQuery,
    ...(clusters ? { originNodeIds: await originNodeIds(clusters) } : {}),
    ...(utcOffset ? { dayOffsetMinutes: utcOffset } : {}),
    ...bounds,
  };
  const wanted = new Set(sections);
  const breakdowns: Partial<Record<Exclude<UsageSection, "summary">, Array<{ key: string; totals: ReturnType<typeof usageTotals> }>>> = {};
  const result: Record<string, unknown> = { breakdowns, projects: projects.map(({ id, name }) => ({ id, name })) };
  if (wanted.has("conversations")) {
    let conversationPage = usageConversationPage(filters, query.page, query.pageSize);
    const totalPages = Math.max(1, Math.ceil(conversationPage.total / query.pageSize));
    const page = Math.min(query.page, totalPages);
    if (page !== query.page) conversationPage = usageConversationPage(filters, page, query.pageSize);
    const visibleConversationIds = [...new Set([...conversationPage.rows.map((row) => row.key), ...(query.conversationId ? [query.conversationId] : [])])];
    breakdowns.conversations = conversationPage.rows;
    result.conversations = usageConversations(filters.projectId ? [filters.projectId] : ids, visibleConversationIds);
    result.conversationPagination = { page, pageSize: query.pageSize, total: conversationPage.total, totalPages: conversationPage.total ? totalPages : 0 };
    await breathe();
  }
  if (wanted.has("summary")) { result.summary = usageTotals(filters); await breathe(); }
  for (const [section, dimension] of [["projects", "project"], ["classifications", "classification"], ["difficulties", "difficulty"], ["models", "model"]] as const) {
    if (!wanted.has(section)) continue;
    breakdowns[section] = usageBreakdown(filters, dimension);
    await breathe();
  }
  if (wanted.has("days")) breakdowns.days = timeZone ? usageCalendarBreakdown(filters, timeZone) : usageBreakdown(filters, "day");
  return result as { breakdowns: typeof breakdowns; projects: Array<{ id: string; name: string }>; summary?: ReturnType<typeof usageTotals>; conversations?: unknown[]; conversationPagination?: { page: number; pageSize: number; total: number; totalPages: number } };
}

/** Cheap enough to poll: whether a transcript refresh is running, and whether saved usage changed since. */
app.get("/api/usage/status", (_request, response) => response.json({ ...usageRefreshStatus(), revision: usageLedgerRevision() }));
app.get(["/api/usage", "/api/usage/summary"], async (request, response, next) => {
  try {
    const { sections: rawSections, ...rawQuery } = request.query;
    const sections = rawSections === undefined ? SECTIONS : sectionsSchema.parse(rawSections);
    const query = await validatedQuery(rawQuery);
    const projects = await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false });
    const result = await dashboard(query, projects, sections);
    const savedCoverage = usageInventoryCoverage(result.projects.map((project) => project.id));
    // Queue only after every saved-data read. request() marks pending synchronously,
    // while its setImmediate guarantees discovery cannot race this snapshot.
    if (query.refresh === "true") requestUsageRefresh();
    response.json({ ...result, coverage: { scope: "observed transcripts and replicated usage", ...savedCoverage, ...usageRefreshStatus(), revision: usageLedgerRevision() }, subscriptions: listSubscriptionPlans((response.locals.authSession as AuthSession).accountId) });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof RangeError) { sendError(response, 400, error instanceof z.ZodError ? error.errors.map((issue) => issue.message).join(", ") : error.message); return; }
    if ((error as { statusCode?: number }).statusCode === 404) { sendError(response, 404, (error as Error).message); return; }
    next(error);
  }
});
// Comparison needs only daily aggregates, never a full conversation page or all dimensions.
app.get("/api/usage/days", async (request, response, next) => {
  try {
    const query = await validatedQuery(request.query);
    if (!query.from || !query.to || (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000 > 150) { sendError(response, 400, "A date window of at most 151 days is required"); return; }
    const projects = await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false });
    const ids = projects.map(({ id }) => id);
    if (query.projectId && !ids.includes(query.projectId)) { sendError(response, 404, "Project not found"); return; }
    const { page: _page, pageSize: _size, refresh: _refresh, clusters, utcOffset, timeZone, bucket: _bucket, ...rest } = query;
    const bounds = timeZone ? calendarBounds(query.from, query.to, timeZone) : {
      from: new Date(Date.parse(`${query.from}T00:00:00Z`) - utcOffset * 60_000).toISOString(),
      to: new Date(Date.parse(`${query.to}T00:00:00Z`) + 86_400_000 - utcOffset * 60_000).toISOString(),
    };
    const scope: UsageFilters = { ...rest, ...bounds, projectIds: ids,
      ...(clusters ? { originNodeIds: await originNodeIds(clusters) } : {}),
      ...(!timeZone && utcOffset ? { dayOffsetMinutes: utcOffset } : {}),
    };
    if (query.bucket === "hour" && !timeZone) { sendError(response, 400, "Hourly buckets require timeZone"); return; }
    const days = timeZone ? usageCalendarBreakdown(scope, timeZone, query.bucket) : usageBreakdown(scope, "day");
    response.json({ days, coverage: { ...usageInventoryCoverage(ids), ...usageRefreshStatus(), scope: "observed transcripts and replicated usage" } });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof RangeError) { sendError(response, 400, error instanceof z.ZodError ? error.errors.map((issue) => issue.message).join(", ") : error.message); return; }
    if ((error as { statusCode?: number }).statusCode === 404) { sendError(response, 404, (error as Error).message); return; }
    next(error);
  }
});
app.get("/api/usage/skills", async (request, response, next) => {
  try {
    const query = await validatedQuery(request.query);
    const projects = await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false });
    const ids = projects.map(({ id }) => id);
    if (query.projectId && !ids.includes(query.projectId)) { sendError(response, 404, "Project not found"); return; }
    const { page: _page, pageSize: _size, refresh: _refresh, clusters, utcOffset, timeZone, bucket: _bucket, ...rest } = query;
    const bounds = timeZone ? calendarBounds(query.from, query.to, timeZone) : {
      from: query.from ? new Date(Date.parse(`${query.from}T00:00:00Z`) - utcOffset * 60_000).toISOString() : undefined,
      to: query.to ? new Date(Date.parse(`${query.to}T00:00:00Z`) + 86_400_000 - utcOffset * 60_000).toISOString() : undefined,
    };
    const scope: UsageFilters = { ...rest, ...bounds, projectIds: ids, ...(clusters ? { originNodeIds: await originNodeIds(clusters) } : {}) };
    const report = usageSkillBreakdown(scope, timeZone);
    // Names for the ids a skill's detail shows, so the page needs no second lookup.
    const wanted = [...new Set(report.skills.flatMap((skill) => skill.topConversations.map((item) => item.conversationId)))];
    const titles = wanted.length ? usageConversations(scope.projectId ? [scope.projectId] : ids, wanted) as Array<{ conversationId: string; title: string }> : [];
    response.json({ ...report, projectNames: Object.fromEntries(projects.map((item) => [item.id, item.name])),
      conversationTitles: Object.fromEntries(titles.filter((row) => row.title !== row.conversationId).map((row) => [row.conversationId, row.title])),
      coverage: { ...usageInventoryCoverage(ids), ...usageRefreshStatus() } });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof RangeError) { sendError(response, 400, error instanceof z.ZodError ? error.errors.map((issue) => issue.message).join(", ") : error.message); return; }
    if ((error as { statusCode?: number }).statusCode === 404) { sendError(response, 404, (error as Error).message); return; }
    next(error);
  }
});
const skillContentSchema = z.object({ name: z.string().min(1).max(200), origin: z.enum(["shared", "scoped", "user", "project"]).optional(), projectId: z.string().min(1).max(200).optional(), conversationId: z.string().min(1).max(300).optional() }).strict();
/** The text of an installed skill, for reading what an agent is told when it loads one. */
app.get("/api/usage/skills/content", async (request, response, next) => {
  try {
    const query = skillContentSchema.parse(request.query);
    const project = query.projectId ? await getProject(query.projectId) : undefined;
    if (query.projectId && !project) { sendError(response, 404, "Project not found"); return; }
    const inventory = await resourceInventory(project ? { projectPath: project.path, projectId: project.id, conversationId: query.conversationId } : {});
    const bare = (name: string) => name.split(":").at(-1)!;
    const copies = inventory.skills.filter((skill) => skill.name === query.name || bare(skill.name) === bare(query.name));
    const chosen = copies.find((skill) => !query.origin || skill.origin === query.origin);
    if (!chosen) { sendError(response, 404, "That skill is not installed on this node"); return; }
    response.json({ name: chosen.name, description: chosen.description, origin: chosen.origin, harnesses: chosen.harnesses,
      copies: copies.map(({ origin, harnesses }) => ({ origin, harnesses })), ...await readSkillContents(chosen.path) });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => issue.message).join(", ")); return; }
    next(error);
  }
});
const SUGGESTION_CONVERSATIONS = 2000;
/**
 * Skills to drop and kinds of work that could use one, from usage and conversation titles on this
 * node. Heuristic and local: no model, no transcript text. Removal is judged over everything
 * recorded, not the period on screen; new-skill ideas follow the filters.
 */
app.get("/api/usage/skills/suggestions", async (request, response, next) => {
  try {
    const query = await validatedQuery(request.query);
    const projects = await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false });
    const ids = projects.map(({ id }) => id);
    if (query.projectId && !ids.includes(query.projectId)) { sendError(response, 404, "Project not found"); return; }
    const { page: _page, pageSize: _size, refresh: _refresh, clusters, utcOffset, timeZone, bucket: _bucket, ...rest } = query;
    const bounds = timeZone ? calendarBounds(query.from, query.to, timeZone) : {
      from: query.from ? new Date(Date.parse(`${query.from}T00:00:00Z`) - utcOffset * 60_000).toISOString() : undefined,
      to: query.to ? new Date(Date.parse(`${query.to}T00:00:00Z`) + 86_400_000 - utcOffset * 60_000).toISOString() : undefined,
    };
    const scope: UsageFilters = { ...rest, ...bounds, projectIds: ids, ...(clusters ? { originNodeIds: await originNodeIds(clusters) } : {}) };
    const project = query.projectId ? await getProject(query.projectId) : undefined;
    const installed = (await resourceInventory(project ? { projectPath: project.path, projectId: project.id } : {})).skills;
    const everything = usageSkillBreakdown({ projectIds: ids, ...(clusters ? { originNodeIds: scope.originNodeIds } : {}) }, timeZone);
    const rows = usageConversationSummaries(scope, SUGGESTION_CONVERSATIONS);
    const titles = new Map((usageConversations(scope.projectId ? [scope.projectId] : ids, rows.map((row) => row.conversationId)) as Array<{ projectId: string; conversationId: string; title: string }>)
      .map((row) => [`${row.projectId}\0${row.conversationId}`, row.title]));
    const names = new Map(projects.map((item) => [item.id, item.name]));
    const creations = suggestNewSkills(rows.flatMap((row) => {
      const title = titles.get(`${row.projectId}\0${row.conversationId}`);
      return title && title !== row.conversationId ? [{ ...row, title }] : [];
    }), installed);
    response.json({
      scope: "usage, turn results and conversation titles saved on this node; no model and no transcript text",
      removals: suggestRemovals({ installed, used: everything.skills, observedSince: usageObservedSince(),
        baselineErrorRate: everything.withSkill.toolCalls ? everything.withSkill.toolErrors / everything.withSkill.toolCalls : null }),
      creations: creations.map((item) => ({ ...item, examples: item.examples.map((example) => ({ ...example, projectName: names.get(example.projectId) ?? example.projectId })),
        draftProjectName: item.draftProjectId ? names.get(item.draftProjectId) ?? item.draftProjectId : null })),
      installedSkills: new Set(installed.map((skill) => skill.name)).size, conversationsConsidered: rows.length, truncated: rows.length >= SUGGESTION_CONVERSATIONS,
      coverage: { ...usageInventoryCoverage(ids), ...usageRefreshStatus() },
    });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof RangeError) { sendError(response, 400, error instanceof z.ZodError ? error.errors.map((issue) => issue.message).join(", ") : error.message); return; }
    if ((error as { statusCode?: number }).statusCode === 404) { sendError(response, 404, (error as Error).message); return; }
    next(error);
  }
});
/** Analysis has its own bounded scope, independent of dashboard filters. */
const analysisSchema = z.object({
  projectId: z.string().min(1).max(200), from: date.optional(), to: date.optional(),
  timeZone: z.string().min(1).max(100).default("UTC"), limit: z.coerce.number().int().min(1).max(100).default(100),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, { message: "from must not be after to" });
app.get("/api/usage/analysis/preview", async (request, response, next) => {
  try {
    const scope = analysisSchema.parse(request.query);
    const visible = await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false });
    if (!visible.some(({ id }) => id === scope.projectId)) { sendError(response, 404, "Project not found"); return; }
    const selection = selectAnalysisConversations(scope);
    response.json({ projectId: scope.projectId, model: null, estimatedModelCostUsd: 0, maxConversations: scope.limit,
      conversations: selection.rows.length, totalConversations: selection.totalConversations, truncated: selection.truncated,
      data: "local saved conversation metadata, turn timing and usage events only; no transcript text or external model", output: "review-only suggestions; no installation or sharing", redaction: "titles are grouping keys and never returned" });
  } catch (error) { if (error instanceof z.ZodError || error instanceof RangeError) { sendError(response, 400, error.message); return; } next(error); }
});
app.post("/api/usage/analysis", async (request, response, next) => {
  try {
    const scope = analysisSchema.parse(request.body), { projectId } = scope;
    const visible = await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false });
    if (!visible.some(({ id }) => id === projectId)) { sendError(response, 404, "Project not found"); return; }
    const db = usageDatabase();
    const { rows, bounds, totalConversations, truncated, selectedWhere, selectedParameters } = selectAnalysisConversations(scope);
    const timings = db.prepare(`SELECT conversation_id conversationId,payload FROM usage_difficulty WHERE ${selectedWhere} ORDER BY occurred_at DESC LIMIT 5001`).all(...selectedParameters) as unknown as Array<{ conversationId: string; payload: string }>;
    const duration = new Map<string, number>();
    if (timings.length <= 5000) for (const row of timings) {
      const turn = JSON.parse(row.payload) as { startedAt?: string; endedAt?: string };
      if (!turn.startedAt || !turn.endedAt) continue;
      const elapsed = Date.parse(turn.endedAt) - Date.parse(turn.startedAt);
      if (Number.isFinite(elapsed) && elapsed >= 0) duration.set(row.conversationId, (duration.get(row.conversationId) ?? 0) + elapsed);
    }
    const candidates = rows.map((row) => ({ ...row, projectId,
      costUsd: usageTotals({ projectIds: [projectId], conversationId: row.conversationId, ...bounds }).apiCostUsd,
      durationMs: duration.get(row.conversationId) ?? null }));
    const events = db.prepare(`SELECT payload FROM model_usage_events WHERE ${selectedWhere} ORDER BY occurred_at DESC LIMIT 5001`).all(...selectedParameters) as unknown as Array<{ payload: string }>;
    const improvements = events.length <= 5000 ? suggestSkillImprovements(events.flatMap(({ payload }) => {
      const event = usageEventSchema.parse(JSON.parse(payload));
      return (event.skillReads ?? []).map((skill) => ({ skillId: `${skill.id}:${skill.version}`, projectId, conversationId: event.conversationId,
        costUsd: event.apiCostUsd, durationMs: duration.get(event.conversationId) ?? null, toolErrors: event.toolErrors }));
    })) : [];
    response.json({ projectId, model: null, actualModelCostUsd: 0, scope: "saved conversation metadata, timing and usage events only",
      coverage: { conversations: rows.length, totalConversations, truncated, timingComplete: timings.length <= 5000, eventsComplete: events.length <= 5000 },
      suggestions: [...suggestRepeatableFlows(candidates), ...improvements] });
  } catch (error) { if (error instanceof z.ZodError || error instanceof RangeError) { sendError(response, 400, error.message); return; } next(error); }
});
app.post("/api/usage/analysis/drafts", async (request, response, next) => {
  try {
    const input = draftInput.parse(request.body);
    const account = actingAccount();
    if (!account || account.isRemoteLogin || !actorOwns("project", input.projectId, account)) { sendError(response, 404, "Project not found"); return; }
    const project = await getProject(input.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const db = usageDatabase();
    const present = db.prepare(`SELECT DISTINCT conversation_id id FROM usage_inventory WHERE project_id=? AND conversation_id IN (${input.evidenceConversationIds.map(() => "?").join(",")})`)
      .all(input.projectId, ...input.evidenceConversationIds) as unknown as Array<{ id: string }>;
    if (new Set(present.map(({ id }) => id)).size !== new Set(input.evidenceConversationIds).size) { sendError(response, 400, "Evidence must belong to the project"); return; }
    response.status(201).json(createUsageDraft(account.accountId, input));
  } catch (error) { if (error instanceof z.ZodError) { sendError(response, 400, error.message); return; } next(error); }
});
app.post("/api/usage/analysis/drafts/:id/install", async (request, response, next) => {
  try {
    const approval = draftApproval.parse(request.body);
    const account = actingAccount();
    if (!account || account.isRemoteLogin) { sendError(response, 404, "Draft not found"); return; }
    const draft = getUsageDraft(account.accountId, request.params.id);
    if (!draft || !actorOwns("project", draft.projectId, account)) { sendError(response, 404, "Draft not found"); return; }
    const project = await getProject(draft.projectId);
    if (!project) { sendError(response, 404, "Draft not found"); return; }
    response.json(await installUsageDraft(account.accountId, draft.id, approval.reviewedSha256, project.path));
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, error.message); return; }
    if (error instanceof Error && /^(Draft changed|Draft was already|Draft destination)/.test(error.message) || (error as NodeJS.ErrnoException).code === "EEXIST") { sendError(response, 409, "Draft destination exists or review changed"); return; }
    next(error);
  }
});
app.get("/api/usage/clusters/:clusterId/report", async (request, response, next) => {
  try {
    const query = await validatedQuery(request.query);
    const db = await clusterV2Database();
    const clusterId = z.string().uuid().parse(request.params.clusterId);
    const account = actingAccount();
    const local = await getClusterNode();
    if (!account || account.isRemoteLogin || !accountInCluster(db, account.accountId, clusterId)
      || !listSharingMemberships(db, local.id).some((entry) => entry.clusterId === clusterId)) { sendError(response, 404, "Cluster not found"); return; }
    const cluster = getSharingCluster(db, clusterId);
    const visible = await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false });
    const explicitlyShared = new Set((db.prepare("SELECT resource_id FROM sharing_resource_shares WHERE kind='project' AND cluster_id=?").all(clusterId) as Array<{ resource_id: string }>).map((row) => row.resource_id));
    const shared = visible.filter((project) => (!query.projectId || query.projectId === project.id) && explicitlyShared.has(project.id));
    if (query.projectId && !shared.length) { sendError(response, 404, "Project not found"); return; }
    const members = listSharingClusterMembers(db, clusterId);
    const { page: _page, pageSize: _size, refresh: _refresh, clusters: _clusters, utcOffset, timeZone, bucket: _bucket, ...rest } = query;
    const bounds = timeZone ? calendarBounds(query.from, query.to, timeZone) : {
      from: query.from ? new Date(Date.parse(`${query.from}T00:00:00Z`) - utcOffset * 60_000).toISOString() : undefined,
      to: query.to ? new Date(Date.parse(`${query.to}T00:00:00Z`) + 86_400_000 - utcOffset * 60_000).toISOString() : undefined,
    };
    const ids = shared.map(({ id }) => id);
    const filters: UsageFilters = { ...rest, ...bounds, projectIds: ids, originNodeIds: [...members.map(({ nodeId }) => nodeId), ""] };
    const activity = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cluster_v2_peer_activity'").get()
      ? db.prepare("SELECT node_id,last_seen_at FROM cluster_v2_peer_activity").all() as unknown as Array<{ node_id: string; last_seen_at: string | null }>
      : [];
    const seen = new Map(activity.map(({ node_id, last_seen_at }) => [node_id, last_seen_at]));
    response.json({ cluster: { id: cluster.id, name: cluster.name }, scope: "explicitly cluster-shared projects visible to this account; observed replicated usage only",
      coverage: { ...usageInventoryCoverage(ids), ...usageRefreshStatus(), missingNodeIds: members.filter(({ nodeId }) => nodeId !== local.id && !seen.get(nodeId)).map(({ nodeId }) => nodeId) },
      projects: shared.map(({ id, name }) => ({ id, name, totals: usageTotals({ ...filters, projectId: id }) })),
      nodes: members.map(({ nodeId }) => ({ nodeId, lastSeenAt: nodeId === local.id ? new Date().toISOString() : seen.get(nodeId) ?? null,
        totals: usageTotals({ ...filters, originNodeIds: nodeId === local.id ? [nodeId, ""] : [nodeId] }) })),
      models: usageBreakdown(filters, "model"), skills: usageSkillBreakdown(filters) });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof RangeError) { sendError(response, 400, error instanceof z.ZodError ? error.errors.map((issue) => issue.message).join(", ") : error.message); return; }
    if ((error as { statusCode?: number }).statusCode === 404) { sendError(response, 404, (error as Error).message); return; }
    next(error);
  }
});
app.get("/api/usage/timing", async (request, response, next) => {
  try {
    const query = await validatedQuery(request.query);
    if (!query.from || !query.to || (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000 > 150) { sendError(response, 400, "A date window of at most 151 days is required"); return; }
    const projects = await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false });
    const ids = projects.map(({ id }) => id);
    if (query.projectId && !ids.includes(query.projectId)) { sendError(response, 404, "Project not found"); return; }
    if (query.provider || query.modelId || query.classification || query.difficulty) { sendError(response, 400, "Timing cannot be filtered by model or classification"); return; }
    const { page: _page, pageSize: _size, refresh: _refresh, clusters, utcOffset, timeZone, bucket: _bucket, ...rest } = query;
    const zone = timeZone || "UTC";
    const bounds = timeZone ? calendarBounds(query.from, query.to, zone) : {
      from: new Date(Date.parse(`${query.from}T00:00:00Z`) - utcOffset * 60_000).toISOString(),
      to: new Date(Date.parse(`${query.to}T00:00:00Z`) + 86_400_000 - utcOffset * 60_000).toISOString(),
    };
    response.json(usageTurnTiming({ ...rest, ...bounds, projectIds: ids, ...(clusters ? { originNodeIds: await originNodeIds(clusters) } : {}) }, zone));
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof RangeError) { sendError(response, 400, error instanceof z.ZodError ? error.errors.map((issue) => issue.message).join(", ") : error.message); return; }
    if ((error as { statusCode?: number }).statusCode === 404) { sendError(response, 404, (error as Error).message); return; }
    next(error);
  }
});
app.post("/api/usage/refresh", (_request, response) => { requestUsageRefresh(true); response.status(202).json({ ...usageRefreshStatus(), accepted: true }); });
app.get("/api/subscription-usage/detected", async (_request, response, next) => { try { response.json({ detections: await collectSubscriptionDetections() }); } catch (error) { next(error); } });
app.get("/api/subscription-usage", (_request, response) => response.json({ plans: listSubscriptionPlans((response.locals.authSession as AuthSession).accountId), automaticQuotaReporting: "unavailable" }));
app.put("/api/subscription-usage", (request, response, next) => {
  try { response.json(saveSubscriptionPlan((response.locals.authSession as AuthSession).accountId, subscriptionPlanInputSchema.parse(request.body))); }
  catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => issue.message).join(", ")); return; }
    if ((error as { statusCode?: number }).statusCode === 409) { sendError(response, 409, "Subscription plan belongs to another account"); return; }
    next(error);
  }
});
app.delete("/api/subscription-usage/:id", (request, response) => { const removed = deleteSubscriptionPlan((response.locals.authSession as AuthSession).accountId, request.params.id); response.status(removed ? 204 : 404).send(); });
