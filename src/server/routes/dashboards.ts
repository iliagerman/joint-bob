import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { getClusterNode } from "../../cluster.js";
import { NotFoundError } from "../../not-found.js";
import { dashboardEntitySchema, type DashboardEntity } from "../../dashboards/contract.js";
import { resolveEntity } from "../../dashboards/entity.js";
import { composeFrame, FRAME_CONTENT_SECURITY_POLICY } from "../../dashboards/frame.js";
import {
  checkDraft, discardDraft, draftExists, promoteDraft, readCreatorMessages, readDraftFiles, readLiveDefinition, readPayload, removeDashboardFiles,
} from "../../dashboards/files.js";
import { forgetDraftRefresh, lastDraftRefresh, runningState, startCreatorTurn, startRefresh, stopJob } from "../../dashboards/service.js";
import {
  activateDashboard, approveDashboard, createDashboard, deleteDashboard, getDashboard, hostProjectFor, listDashboards, recordSavedDefinition, type DashboardRecord,
} from "../../dashboards/store.js";
import { app } from "../state.js";

/** Sharing announces saved changes to other nodes; until then a change stays on this node. */
async function dashboardsChanged(): Promise<void> {}

export class DashboardError extends Error {
  readonly expose = true;
  constructor(readonly status: number, message: string) { super(message); }
}

type Handler = (request: Request, response: Response, auth: AuthSession) => Promise<unknown>;

/** JSON routes: the result is the response body; errors go to the shared API error handler. */
export function dashboardRoute(handler: Handler) {
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response, response.locals.authSession as AuthSession)
      .then((body) => { if (!response.headersSent) response.json(body); })
      .catch(next);
  };
}

/** A dashboard the person may see, with its entity checked on this node. */
export async function visibleDashboard(id: string, auth: AuthSession): Promise<{ record: DashboardRecord; context: Awaited<ReturnType<typeof resolveEntity>> }> {
  const found = getDashboard(id);
  if (!found) throw new NotFoundError("Dashboard not found");
  const context = await resolveEntity(found.entity, found.hostProjectId, auth);
  // Read again: a job may have finished or the record changed while the entity was checked.
  const record = getDashboard(id);
  if (!record) throw new NotFoundError("Dashboard not found");
  return { record, context };
}

function frameHtml(id: string, draft: boolean): string {
  if (draft) {
    const page = readDraftFiles(id).find((file) => file.path === "index.html");
    if (!page) throw new NotFoundError("The draft has no index.html yet");
    return page.content.toString("utf8");
  }
  const live = readLiveDefinition(id);
  if (!live) throw new NotFoundError("Dashboard has not been saved yet");
  return live.html;
}

app.get("/api/dashboards/:id/frame", dashboardRoute(async (request, response, auth) => {
  await visibleDashboard(String(request.params.id), auth);
  const draft = request.query.draft === "1";
  const html = composeFrame({
    html: frameHtml(String(request.params.id), draft),
    payload: readPayload(String(request.params.id), draft ? "draft" : "live"),
    theme: request.query.theme === "light" ? "light" : "dark",
  });
  response.setHeader("Content-Security-Policy", FRAME_CONTENT_SECURITY_POLICY);
  response.type("html").send(html);
}));

// ---- listing, creating and the creator ------------------------------------------------------

const projectIdField = { projectId: z.string().min(1).max(300).optional() };
const createSchema = z.object({ entity: dashboardEntitySchema, hostProjectId: z.string().min(1).max(300).optional(), ...projectIdField }).strict();
const messageSchema = z.object({ text: z.string().trim().min(1).max(20_000), ...projectIdField }).strict();
const refreshSchema = z.object({ target: z.enum(["live", "draft"]), ...projectIdField }).strict();
const emptySchema = z.object(projectIdField).strict();
const approveSchema = z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/), ...projectIdField }).strict();
const listSchema = z.object({ kind: z.enum(["conversation", "project", "workspace"]), id: z.string().min(1).max(300), projectId: z.string().min(1).max(300) }).strict();

function dashboardView(record: DashboardRecord) {
  const hasDraft = draftExists(record.id);
  const check = hasDraft ? checkDraft(record.id) : null;
  const saved = record.definitionDigest !== null;
  return {
    id: record.id, title: record.title, entity: record.entity, hostProjectId: record.hostProjectId, origin: record.origin,
    ownerNodeId: record.ownerNodeId, refreshMethod: record.refreshMethod, active: record.active, saved,
    approved: saved && record.approvedDigest === record.definitionDigest, definitionDigest: record.definitionDigest,
    hasDraft, draftCheck: check ? (check.ok ? { ok: true } : { ok: false, error: check.error }) : null,
    lastRefresh: record.lastRefresh, draftRefresh: lastDraftRefresh(record.id), running: runningState(record.id),
  };
}

function entityFromQuery(query: z.infer<typeof listSchema>): DashboardEntity {
  if (query.kind === "conversation") return { kind: "conversation", id: query.id, projectId: query.projectId };
  return { kind: query.kind, id: query.id };
}

/** Records whose entity this person cannot see here are left out, as if they did not exist. */
async function visibleRecords(entity: DashboardEntity, auth: AuthSession): Promise<DashboardRecord[]> {
  const visible: DashboardRecord[] = [];
  for (const record of listDashboards(entity)) {
    try { await resolveEntity(record.entity, record.hostProjectId, auth); visible.push(record); }
    catch (error) { if (!(error instanceof NotFoundError)) throw error; }
  }
  return visible;
}

app.get("/api/dashboards", dashboardRoute(async (request, _response, auth) => {
  const query = listSchema.parse(request.query);
  const entity = entityFromQuery(query);
  const context = await resolveEntity(entity, hostProjectFor(entity, query.projectId), auth);
  const records = await visibleRecords(entity, auth);
  return {
    entity, label: context.label, hostProjectId: context.project.id,
    dashboards: records.map(dashboardView),
    displayedId: records.find((record) => record.active)?.id ?? null,
    ...(context.workspace ? { workspaceProjects: context.workspace.projects.map(({ id, name }) => ({ id, name })) } : {}),
  };
}));

app.post("/api/dashboards", dashboardRoute(async (request, _response, auth) => {
  const input = createSchema.parse(request.body);
  const hostProjectId = hostProjectFor(input.entity, input.hostProjectId);
  await resolveEntity(input.entity, hostProjectId, auth);
  const record = createDashboard({ entity: input.entity, hostProjectId, ownerNodeId: (await getClusterNode()).id, accountId: auth.accountId });
  return { dashboard: dashboardView(record) };
}));

app.get("/api/dashboards/:id", dashboardRoute(async (request, _response, auth) => {
  const { record } = await visibleDashboard(String(request.params.id), auth);
  return { dashboard: dashboardView(record), messages: readCreatorMessages(record.id) };
}));

function ownDashboard(record: DashboardRecord): void {
  if (record.origin !== "own") throw new DashboardError(409, "This dashboard came from another node; make your own copy to change it");
}

function idle(record: DashboardRecord): void {
  if (runningState(record.id)) throw new DashboardError(409, "The dashboard is still working; wait for it to finish");
}

app.post("/api/dashboards/:id/messages", dashboardRoute(async (request, response, auth) => {
  const input = messageSchema.parse(request.body);
  const { record, context } = await visibleDashboard(String(request.params.id), auth);
  ownDashboard(record);
  startCreatorTurn(record, context, input.text);
  response.status(202);
  return { dashboard: dashboardView(record) };
}));

app.post("/api/dashboards/:id/refresh", dashboardRoute(async (request, response, auth) => {
  const input = refreshSchema.parse(request.body);
  const { record, context } = await visibleDashboard(String(request.params.id), auth);
  startRefresh(record, context, input.target);
  response.status(202);
  return { dashboard: dashboardView(record) };
}));

app.post("/api/dashboards/:id/draft/save", dashboardRoute(async (request, _response, auth) => {
  emptySchema.parse(request.body);
  const { record } = await visibleDashboard(String(request.params.id), auth);
  ownDashboard(record);
  idle(record);
  if (!draftExists(record.id)) throw new DashboardError(409, "There is no draft to save");
  let saved: ReturnType<typeof promoteDraft>;
  try { saved = promoteDraft(record.id); }
  catch (error) { throw new DashboardError(409, (error as Error).message); }
  recordSavedDefinition(record.id, { title: saved.manifest.title, refreshMethod: saved.manifest.refresh.method, digest: saved.digest });
  forgetDraftRefresh(record.id);
  await dashboardsChanged();
  return { dashboard: dashboardView(getDashboard(record.id)!) };
}));

app.post("/api/dashboards/:id/draft/discard", dashboardRoute(async (request, _response, auth) => {
  emptySchema.parse(request.body);
  const { record } = await visibleDashboard(String(request.params.id), auth);
  ownDashboard(record);
  idle(record);
  discardDraft(record.id);
  forgetDraftRefresh(record.id);
  // A dashboard that was never saved has nothing left once its draft goes.
  if (!record.definitionDigest) {
    deleteDashboard(record.id);
    removeDashboardFiles(record.id);
    return { dashboard: null };
  }
  return { dashboard: dashboardView(record) };
}));

app.delete("/api/dashboards/:id", dashboardRoute(async (request, _response, auth) => {
  const { record } = await visibleDashboard(String(request.params.id), auth);
  ownDashboard(record);
  stopJob(record.id);
  deleteDashboard(record.id);
  removeDashboardFiles(record.id);
  await dashboardsChanged();
  return { ok: true };
}));

app.post("/api/dashboards/:id/activate", dashboardRoute(async (request, _response, auth) => {
  emptySchema.parse(request.body);
  const { record } = await visibleDashboard(String(request.params.id), auth);
  try { activateDashboard(record.id); }
  catch (error) { throw new DashboardError(409, (error as Error).message); }
  return { dashboard: dashboardView(getDashboard(record.id)!) };
}));

app.post("/api/dashboards/:id/approve", dashboardRoute(async (request, _response, auth) => {
  const input = approveSchema.parse(request.body);
  const { record } = await visibleDashboard(String(request.params.id), auth);
  try { approveDashboard(record.id, input.digest); }
  catch (error) { throw new DashboardError(409, (error as Error).message); }
  return { dashboard: dashboardView(getDashboard(record.id)!) };
}));

/** The files behind the live definition (or the draft), as text, so a person can read a script before approving it. */
app.get("/api/dashboards/:id/definition", dashboardRoute(async (request, _response, auth) => {
  const { record } = await visibleDashboard(String(request.params.id), auth);
  const files = request.query.draft === "1" ? readDraftFiles(record.id) : readLiveDefinition(record.id)?.files;
  if (!files) throw new NotFoundError("Dashboard has not been saved yet");
  return { digest: record.definitionDigest, files: files.map((file) => ({ path: file.path, text: file.content.includes(0) ? "(binary file)" : file.content.toString("utf8") })) };
}));
