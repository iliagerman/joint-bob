import type { NextFunction, Request, Response } from "express";
import { z, ZodError } from "zod";
import { getClusterNode } from "../../cluster.js";
import { ensureResourceSharingSchema, getResourcePolicyState, listResourcePolicyDeliveries, ResourceSharingError, updateResourceSharing } from "../../cluster-sharing.js";
import { listResourceShares, listSharingClusterMembers, resourceOwner } from "../../cluster-sharing-policy.js";
import { ClusterV2HttpError } from "../../cluster-v2-errors.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { canonicalProjectId, getProject, listProjects, listWorkspaces } from "../../store.js";
import { getWorkspaceSharing, setWorkspaceSharing, workspaceSharingDestinations, workspaceSharingSchema } from "../../workspace-sharing.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";
import { disconnectRevokedRuntimeSockets } from '../runtime-peers.js';
import { clusterSharingView, updateClusterSelection, type SharingScope } from "../../selected-sharing.js";
import { actingAccount } from "../../account-context.js";
import { accountInCluster } from "../../cluster-accounts.js";
import { actorOwns, memberOwnedIds } from "../../ownership.js";
import { mayShareProject } from "../sharing-files.js";
import { announceWorkspaceChanges, registerSharedWorkspaceRoutes } from "../shared-workspaces.js";
import { forwardTwinSelection, receiveTwinSelection } from "../twin-selection.js";
import { flushResourcePolicyDeliveries } from "../resource-policy.js";
import { flushProjectMetadataDeliveries } from "../project-metadata.js";
import { listProjectMetadataDeliveries } from "../../cluster-project-metadata.js";

const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/);
const updateSchema = z.object({
  expectedGeneration: z.number().int().safe().nonnegative(),
  shares: z.array(z.object({ clusterId: uuid, projectId: z.null() }).strict()),
}).strict();
const emptySchema = z.object({}).strict();
registerSharedWorkspaceRoutes();

function localOnly(response: Response): void {
  if (!response.locals.authSession) throw new ClusterV2HttpError(401, "Unauthorized");
}
async function requireActive(response: Response): Promise<void> {
  localOnly(response);
  if (actingAccount()?.isRemoteLogin) throw new ClusterV2HttpError(404, "Not found");
}

/** A person shares only what they own, and only into clusters they joined. */
function personScope(): SharingScope | undefined {
  const account = actingAccount();
  return account ? { accountId: account.accountId } : undefined;
}
function route(action: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    void action(request, response).catch((error) => {
      if (error instanceof ZodError) { sendError(response, 400, error.issues[0].message); return; }
      if (error instanceof ResourceSharingError || error instanceof ClusterV2HttpError) { sendError(response, error.statusCode, error.message); return; }
      if (error instanceof Error && /^(Unknown cluster:|Node .* is not a member|Duplicate resource share selection|Only secrets may|Invalid resource|Cluster ID)/.test(error.message)) {
        sendError(response, 400, error.message); return;
      }
      next(error);
    });
  };
}

async function canonicalProject(resourceId: string, response: Response): Promise<string | undefined> {
  const canonical = await canonicalProjectId(resourceId);
  if (!canonical || !await getProject(canonical)) { sendError(response, 404, "Project not found"); return undefined; }
  return canonical;
}

function view(db: Awaited<ReturnType<typeof clusterV2Database>>, localId: string, resourceId: string) {
  const state = getResourcePolicyState(db, "project", resourceId);
  const pending = db.prepare("SELECT count(*) count FROM cluster_v2_resource_deliveries WHERE kind='project' AND resource_id=?")
    .get(resourceId) as { count: number };
  return {
    ownerNodeId: state.ownerNodeId, generation: state.generation, deleted: state.deleted,
    editable: state.ownerNodeId === localId && !state.deleted,
    shares: listResourceShares(db, "project", resourceId), pendingDeliveries: pending.count,
  };
}

async function policyProject(request: Request, response: Response) {
  await requireActive(response);
  const id = await canonicalProject(request.params.resourceId, response);
  if (!id) return undefined;
  const db = await clusterV2Database();
  ensureResourceSharingSchema(db);
  const exists = db.prepare("SELECT 1 FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id=?").get(id);
  if (!exists) { sendError(response, 409, "Project ownership requires adoption"); return undefined; }
  return { id, db, local: await getClusterNode() };
}

app.get("/api/workspace-sharing/destinations", route(async (_request, response) => {
  await requireActive(response);
  response.json(workspaceSharingDestinations(await clusterV2Database(), (await getClusterNode()).id));
}));

async function workspaceContext(request: Request, response: Response) {
  await requireActive(response);
  const workspace = (await listWorkspaces()).find(workspace => workspace.id === request.params.workspaceId && !workspace.source);
  if (!workspace) throw new ClusterV2HttpError(404, "Workspace not found");
  return { db: await clusterV2Database(), local: (await getClusterNode()).id, id: workspace.id };
}
app.get("/api/workspaces/:workspaceId/sharing", route(async (request, response) => {
  const { db, local, id } = await workspaceContext(request, response);
  response.json(getWorkspaceSharing(db, local, id));
}));
app.put("/api/workspaces/:workspaceId/sharing", route(async (request, response) => {
  const { db, local, id } = await workspaceContext(request, response);
  const result = setWorkspaceSharing(db, local, id, workspaceSharingSchema.parse(request.body));
  await disconnectRevokedRuntimeSockets();
  response.json(result);
  void announceWorkspaceChanges().catch((error) => console.warn("Shared workspace notice failed", error));
}));

app.get("/api/clusters/:clusterId/sharing", route(async (request, response) => {
  await requireActive(response);
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  const clusterId = uuid.parse(request.params.clusterId);
  const selection = clusterSharingView(db, local, clusterId, personScope());
  const members = listSharingClusterMembers(db, clusterId);
  // A person sees their own projects here and what they may see of others'; the admin sees
  // everything but other people's.
  const account = actingAccount();
  const visible = new Set((await listProjects()).map((project) => project.id));
  const others = account?.role === "admin" ? memberOwnedIds("project") : new Set<string>();
  const projects = (db.prepare(`SELECT p.id, o.owner_node_id ownerNodeId FROM projects p
    JOIN sharing_resource_owners o ON o.kind='project' AND o.resource_id=p.id`).all() as unknown as Array<{ id: string; ownerNodeId: string }>)
    .filter((project) => !account || (account.role === "admin" ? !others.has(project.id) : visible.has(project.id)));
  const projectAccess = projects.map(project => ({ ...project,
    authorizedNodeIds: members.filter(member => mayShareProject(db, local, member.nodeId, project.id)).map(member => member.nodeId),
  }));
  response.json({ ...selection, projectAccess });
}));

app.put("/api/clusters/:clusterId/sharing", route(async (request, response) => {
  await requireActive(response);
  const selection = z.object({ projectIds: z.array(z.string().min(1).max(300)).max(10000),
    workspaceIds: z.array(z.string().min(1).max(300)).max(10000), confirmOwnedData: z.literal(true) }).strict().parse(request.body);
  const db = await clusterV2Database(), local = (await getClusterNode()).id, clusterId = uuid.parse(request.params.clusterId), scope = personScope();
  updateClusterSelection(db, local, clusterId, selection.projectIds, selection.workspaceIds, scope);
  await disconnectRevokedRuntimeSockets();
  await forwardTwinSelection(db, local, clusterId, selection.projectIds, selection.workspaceIds, scope);
  response.json(clusterSharingView(db, local, clusterId, scope));
  void announceWorkspaceChanges().catch((error) => console.warn("Shared workspace notice failed", error));
}));

app.post("/api/cluster/v2/twins/selection", route(async (request, response) => {
  if (response.locals.machineProtocol !== 2 || typeof response.locals.machineNodeId !== "string") throw new ClusterV2HttpError(401, "Unauthorized");
  const sender = response.locals.machineNodeId, db = await clusterV2Database(), local = (await getClusterNode()).id;
  receiveTwinSelection(db, local, sender, request.body);
  await disconnectRevokedRuntimeSockets();
  await flushResourcePolicyDeliveries(sender);
  await flushProjectMetadataDeliveries(sender);
  if (listResourcePolicyDeliveries(db).some(delivery => delivery.peerId === sender)
    || listProjectMetadataDeliveries(db, local).some(delivery => delivery.peerId === sender)) {
    throw new ResourceSharingError("Sharing saved on owner, but delivery to the requesting twin is still pending", 503);
  }
  response.json({ ok: true });
  void announceWorkspaceChanges().catch((error) => console.warn("Shared workspace notice failed", error));
}));

app.get("/api/sharing/project/:resourceId", route(async (request, response) => {
  const context = await policyProject(request, response);
  if (context) response.json(view(context.db, context.local.id, context.id));
}));

app.put("/api/sharing/project/:resourceId", route(async (request, response) => {
  const payload = updateSchema.parse(request.body);
  const context = await policyProject(request, response);
  if (!context) return;
  if (resourceOwner(context.db, "project", context.id) !== context.local.id) throw new ClusterV2HttpError(403, "Only the original owner may change sharing");
  const account = actingAccount();
  if (account && !actorOwns("project", context.id, account)) throw new ClusterV2HttpError(403, "Only the original owner may change sharing");
  const current = new Set(listResourceShares(context.db, "project", context.id).map((share) => share.clusterId));
  if (account && payload.shares.some((share) => !current.has(share.clusterId) && !accountInCluster(context.db, account.accountId, share.clusterId))) throw new ClusterV2HttpError(403, "Share only into clusters you joined");
  const state = getResourcePolicyState(context.db, "project", context.id);
  if (state.deleted) throw new ClusterV2HttpError(409, "Resource is deleted");
  updateResourceSharing(context.db, context.local.id, "project", context.id, payload.expectedGeneration, payload.shares);
  response.json(view(context.db, context.local.id, context.id));
}));

app.post("/api/clusters/:clusterId/share-all-projects", route(async (request, response) => {
  await requireActive(response);
  emptySchema.parse(request.body);
  const clusterId = uuid.parse(request.params.clusterId);
  const local = await getClusterNode();
  const db = await clusterV2Database();
  ensureResourceSharingSchema(db);
  const membership = db.prepare("SELECT 1 FROM sharing_memberships WHERE cluster_id=? AND node_id=?").get(clusterId, local.id);
  if (!membership) throw new ClusterV2HttpError(409, "Local node is not a cluster member");
  db.exec("SAVEPOINT share_all_projects");
  try {
    const rows = db.prepare(`SELECT p.resource_id id,p.generation FROM cluster_v2_resource_policy p
      JOIN projects project ON project.id=p.resource_id
      WHERE p.kind='project' AND p.owner_node_id=? AND p.deleted=0 ORDER BY p.resource_id`)
      .all(local.id) as unknown as Array<{ id: string; generation: number }>;
    let shared = 0;
    const account = actingAccount();
    for (const row of rows) {
      if (account && !actorOwns("project", row.id, account)) continue;
      const shares = listResourceShares(db, "project", row.id);
      if (shares.some((share) => share.clusterId === clusterId)) continue;
      updateResourceSharing(db, local.id, "project", row.id, row.generation, [...shares, { clusterId, projectId: null }]);
      shared++;
    }
    db.exec("RELEASE share_all_projects");
    response.json({ shared });
  } catch (error) {
    db.exec("ROLLBACK TO share_all_projects; RELEASE share_all_projects");
    throw error;
  }
}));
