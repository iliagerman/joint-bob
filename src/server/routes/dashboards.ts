import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { getClusterNode } from "../../cluster.js";
import { NotFoundError } from "../../not-found.js";
import { dashboardEntitySchema, type DashboardEntity } from "../../dashboards/contract.js";
import { resolveEntity } from "../../dashboards/entity.js";
import { composeFrame, FRAME_CONTENT_SECURITY_POLICY } from "../../dashboards/frame.js";
import {
  checkDraft, discardDraft, draftBaseDigest, draftExists, draftState, promoteDraft, readCreatorMessages, readDraftFiles, readLiveDefinition, readPayload, readSharedPayload, readRunLog, removeDashboardFiles,
  writeReceivedDefinition,
} from "../../dashboards/files.js";
import { forgetDraftRefresh, lastDraftRefresh, runningState, startCreatorTurn, startRefresh, stopJob } from "../../dashboards/service.js";
import {
  activateDashboard, approveDashboard, createDashboard, dashboardSharing, deleteDashboard, getDashboard, hasOwnSavedDashboard, hostProjectFor, listDashboards,
  recordSavedDefinition, setDashboardSharing, type DashboardRecord,
} from "../../dashboards/store.js";
import { whilePeerOptional } from "../../peer-presence.js";
import {
  announceDashboardChanges, dashboardFilesFor, dashboardManifestFor, dashboardShareTargets, isTwinOwner, refreshSharedDashboards, submitDashboardEdit, syncDashboardsFromOwner,
} from "../dashboard-sharing.js";
import { app } from "../state.js";

/** Saved changes are announced to peers; the request never waits on an offline one. */
async function dashboardsChanged(): Promise<void> {
  void announceDashboardChanges().catch((error: unknown) => console.warn("Dashboard change notice failed", error));
}

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

/** The page and the data it may see: code that is not approved here is shown with no data at all. */
function framePage(record: DashboardRecord, draft: boolean): { html: string; payload: unknown } {
  if (draft) {
    const page = readDraftFiles(record.id).find((file) => file.path === "index.html");
    if (!page) throw new NotFoundError("The draft has no index.html yet");
    return { html: page.content.toString("utf8"), payload: readPayload(record.id, "draft") };
  }
  const live = readLiveDefinition(record.id);
  if (!live) throw new NotFoundError("Dashboard has not been saved yet");
  const localPayload = readPayload(record.id, "live");
  const sharedPayload = record.origin === "received" ? readSharedPayload(record.id) : undefined;
  return { html: live.html, payload: live.digest === record.approvedDigest ? (sharedPayload ?? localPayload) : undefined };
}

app.get("/api/dashboards/:id/frame", dashboardRoute(async (request, response, auth) => {
  const { record } = await visibleDashboard(String(request.params.id), auth);
  const page = framePage(record, request.query.draft === "1");
  const html = composeFrame({ ...page, theme: request.query.theme === "light" ? "light" : "dark" });
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
  const draft = draftState(record.id);
  const saved = record.definitionDigest !== null;
  return {
    draftHasPage: draft.hasPage, draftVersion: draft.version,
    id: record.id, title: record.title, entity: record.entity, hostProjectId: record.hostProjectId, origin: record.origin,
    ownerNodeId: record.ownerNodeId, canEdit: record.canEdit, refreshMethod: record.refreshMethod, active: record.active, saved,
    approved: saved && record.approvedDigest === record.definitionDigest, definitionDigest: record.definitionDigest,
    hasDraft, draftCheck: check ? (check.ok ? { ok: true } : { ok: false, error: check.error }) : null,
    lastRefresh: record.lastRefresh, publishedAt: record.origin === "received" ? readSharedPayload(record.id)?.generatedAt ?? null : null,
    draftRefresh: lastDraftRefresh(record.id), running: runningState(record.id),
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

/**
 * The dashboard an entity shows here: the active one; otherwise, on a twin with none of its own,
 * the dashboard its twin made, waiting for approval before it runs.
 */
async function displayedDashboard(entity: DashboardEntity, records: DashboardRecord[]): Promise<string | null> {
  const active = records.find((record) => record.active);
  if (active) return active.id;
  if (hasOwnSavedDashboard(entity)) return null;
  for (const record of records) if (record.origin === "received" && await isTwinOwner(record.ownerNodeId)) return record.id;
  return null;
}

app.get("/api/dashboards", dashboardRoute(async (request, _response, auth) => {
  const query = listSchema.parse(request.query);
  const entity = entityFromQuery(query);
  const context = await resolveEntity(entity, hostProjectFor(entity, query.projectId), auth);
  await whilePeerOptional(refreshSharedDashboards);
  const records = await visibleRecords(entity, auth);
  return {
    entity, label: context.label, hostProjectId: context.project.id,
    dashboards: records.map(dashboardView),
    displayedId: await displayedDashboard(entity, records),
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
  // The end of the last run's output: why a refresh failed, not only that it did.
  return { dashboard: dashboardView(record), messages: readCreatorMessages(record.id), runLog: readRunLog(record.id).slice(-4000) };
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
  if (record.origin !== "own" && !record.canEdit) throw new DashboardError(403, "This dashboard is read-only here");
  startCreatorTurn(record, context, input.text);
  response.status(202);
  return { dashboard: dashboardView(record) };
}));

app.post("/api/dashboards/:id/refresh", dashboardRoute(async (request, response, auth) => {
  const input = refreshSchema.parse(request.body);
  const { record, context } = await visibleDashboard(String(request.params.id), auth);
  startRefresh(record, context, input.target, dashboardsChanged);
  response.status(202);
  return { dashboard: dashboardView(record) };
}));

app.post("/api/dashboards/:id/draft/save", dashboardRoute(async (request, _response, auth) => {
  emptySchema.parse(request.body);
  const { record } = await visibleDashboard(String(request.params.id), auth);
  if (record.origin === "received") {
    if (!record.canEdit) throw new DashboardError(403, "This dashboard is read-only here");
    idle(record);
    if (!draftExists(record.id)) throw new DashboardError(409, "There is no draft to save");
    const baseDigest = draftBaseDigest(record.id);
    if (!baseDigest) throw new DashboardError(409, "This draft has no base version; discard it and start again");
    const savedEdit = await submitDashboardEdit(record.ownerNodeId, record.id, baseDigest, readDraftFiles(record.id));
    discardDraft(record.id);
    await syncDashboardsFromOwner(record.ownerNodeId, true);
    return { dashboard: dashboardView(getDashboard(record.id) ?? record), accepted: savedEdit.accepted };
  }
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
  if (readLiveDefinition(record.id)?.digest !== input.digest) throw new DashboardError(409, "The dashboard changed since you looked at it");
  try { approveDashboard(record.id, input.digest); }
  catch (error) { throw new DashboardError(409, (error as Error).message); }
  // A twin with nothing of its own uses its twin's dashboard as soon as it is approved.
  const approved = getDashboard(record.id)!;
  if (approved.origin === "received" && !hasOwnSavedDashboard(approved.entity) && !listDashboards(approved.entity).some((other) => other.active) && await isTwinOwner(approved.ownerNodeId)) {
    activateDashboard(approved.id);
  }
  return { dashboard: dashboardView(getDashboard(record.id)!) };
}));

/** The files behind the live definition (or the draft), as text, so a person can read a script before approving it. */
app.get("/api/dashboards/:id/definition", dashboardRoute(async (request, _response, auth) => {
  const { record } = await visibleDashboard(String(request.params.id), auth);
  const live = request.query.draft === "1" ? undefined : readLiveDefinition(record.id);
  const files = request.query.draft === "1" ? readDraftFiles(record.id) : live?.files;
  if (!files) throw new NotFoundError("Dashboard has not been saved yet");
  // The digest of the files shown, so an approval covers exactly what the person read.
  return { digest: live?.digest ?? null, files: files.map((file) => ({ path: file.path, text: file.content.includes(0) ? "(binary file)" : file.content.toString("utf8") })) };
}));

// ---- sharing ---------------------------------------------------------------------------------

const sharingSchema = z.object({
  nodeIds: z.array(z.string().min(1).max(100)).max(100).default([]), clusterIds: z.array(z.string().uuid()).max(100).default([]),
  editNodeIds: z.array(z.string().min(1).max(100)).max(100).default([]), editClusterIds: z.array(z.string().uuid()).max(100).default([]),
  allProjectNodes: z.boolean().default(false), workspaceIds: z.array(z.string().min(1).max(300)).max(100).default([]), ...projectIdField,
}).strict();

app.get("/api/dashboards/:id/sharing", dashboardRoute(async (request, _response, auth) => {
  const { record } = await visibleDashboard(String(request.params.id), auth);
  ownDashboard(record);
  return { ...dashboardSharing(record.id), targets: await dashboardShareTargets(record.hostProjectId) };
}));

app.put("/api/dashboards/:id/sharing", dashboardRoute(async (request, _response, auth) => {
  const input = sharingSchema.parse(request.body);
  const { record } = await visibleDashboard(String(request.params.id), auth);
  ownDashboard(record);
  if (auth.isRemoteLogin) throw new DashboardError(403, "Change dashboard sharing on the node that owns it");
  const targets = await dashboardShareTargets(record.hostProjectId);
  if (input.nodeIds.some((id) => !targets.nodes.some((node) => node.nodeId === id)) || input.clusterIds.some((id) => !targets.clusters.some((cluster) => cluster.id === id)) ||
    input.workspaceIds.some((id) => !targets.workspaces.some((workspace) => workspace.id === id)) ||
    input.editNodeIds.some((id) => !input.nodeIds.includes(id)) || input.editClusterIds.some((id) => !input.clusterIds.includes(id))) {
    throw new DashboardError(403, "Sharing target is not available");
  }
  setDashboardSharing(record.id, { nodeIds: input.nodeIds, clusterIds: input.clusterIds, editNodeIds: input.editNodeIds, editClusterIds: input.editClusterIds, allProjectNodes: input.allProjectNodes, workspaceIds: input.workspaceIds });
  await dashboardsChanged();
  return dashboardSharing(record.id);
}));

/** A received dashboard is changed through this node's own copy; the received one keeps following its owner. */
app.post("/api/dashboards/:id/copy", dashboardRoute(async (request, _response, auth) => {
  emptySchema.parse(request.body);
  const { record } = await visibleDashboard(String(request.params.id), auth);
  const live = readLiveDefinition(record.id);
  if (!live) throw new DashboardError(409, "Dashboard has not been saved yet");
  if (live.digest !== record.approvedDigest) throw new DashboardError(409, "Approve this dashboard before you copy it");
  const copy = createDashboard({ entity: record.entity, hostProjectId: record.hostProjectId, ownerNodeId: (await getClusterNode()).id, accountId: auth.accountId });
  const saved = writeReceivedDefinition(copy.id, live.files);
  recordSavedDefinition(copy.id, { title: saved.manifest.title, refreshMethod: saved.manifest.refresh.method, digest: saved.digest });
  return { dashboard: dashboardView(getDashboard(copy.id)!) };
}));

const base64Schema = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).max(6 * 1024 * 1024);
const dashboardEditSchema = z.object({
  id: z.string().uuid(), baseDigest: z.string().regex(/^[0-9a-f]{64}$/),
  files: z.array(z.object({ path: z.string().min(1).max(500), content: base64Schema }).strict()).max(50),
}).strict().superRefine((input, context) => {
  if (input.files.reduce((total, file) => total + file.content.length, 0) > 6 * 1024 * 1024) {
    context.addIssue({ code: "custom", message: "The dashboard definition is too large" });
  }
});

function machineRoute(handler: (request: Request, sender: string) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (response.locals.machineProtocol !== 2) { response.status(403).json({ error: "Forbidden" }); return; }
    handler(request, String(response.locals.machineNodeId)).then((body) => response.json(body)).catch(next);
  };
}

app.post("/api/cluster/v2/dashboards/manifest", machineRoute(async (request, sender) => {
  z.object({}).strict().parse(request.body);
  return dashboardManifestFor(sender);
}));

app.post("/api/cluster/v2/dashboards/files", machineRoute(async (request, sender) => {
  const { id } = z.object({ id: z.string().uuid() }).strict().parse(request.body);
  return dashboardFilesFor(sender, id);
}));

app.post("/api/cluster/v2/dashboards/edit", machineRoute(async (request, sender) => {
  const input = dashboardEditSchema.parse(request.body);
  const record = getDashboard(input.id);
  const offered = (await dashboardManifestFor(sender)).dashboards.find((dashboard) => dashboard.id === input.id);
  if (!record || record.origin !== "own" || !offered?.canEdit) throw new DashboardError(403, "This node cannot edit the dashboard");
  if (record.definitionDigest !== input.baseDigest) throw new DashboardError(409, "The dashboard changed on its owner; your draft is kept");
  const written = writeReceivedDefinition(input.id, input.files.map((file) => ({ path: file.path, content: Buffer.from(file.content, "base64") })));
  recordSavedDefinition(input.id, { title: written.manifest.title, refreshMethod: written.manifest.refresh.method, digest: written.digest });
  await dashboardsChanged();
  return { accepted: true, digest: written.digest };
}));

app.post("/api/cluster/v2/dashboards/changed", machineRoute(async (request, sender) => {
  z.object({}).strict().parse(request.body);
  void syncDashboardsFromOwner(sender, true);
  return { ok: true };
}));
