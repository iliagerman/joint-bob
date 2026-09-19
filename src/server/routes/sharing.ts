import type { NextFunction, Request, Response } from "express";
import { z, ZodError } from "zod";
import { getClusterNode } from "../../cluster.js";
import { ensureResourceSharingSchema, getResourcePolicyState, ResourceSharingError, updateResourceSharing } from "../../cluster-sharing.js";
import { listResourceShares, resourceOwner } from "../../cluster-sharing-policy.js";
import { ClusterV2HttpError, selectiveSharingActive } from "../../cluster-v2-mode.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { canonicalProjectId, getProject } from "../../store.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/);
const updateSchema = z.object({
  expectedGeneration: z.number().int().safe().nonnegative(),
  shares: z.array(z.object({ clusterId: uuid, projectId: z.null() }).strict()),
}).strict();
const emptySchema = z.object({}).strict();

function localOnly(response: Response): void {
  if (!response.locals.authSession) throw new ClusterV2HttpError(401, "Unauthorized");
}
async function requireActive(response: Response): Promise<void> {
  localOnly(response);
  if (!await selectiveSharingActive()) throw new ClusterV2HttpError(409, "Selective sharing is not active");
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

app.get("/api/sharing/project/:resourceId", route(async (request, response) => {
  const context = await policyProject(request, response);
  if (context) response.json(view(context.db, context.local.id, context.id));
}));

app.put("/api/sharing/project/:resourceId", route(async (request, response) => {
  const payload = updateSchema.parse(request.body);
  const context = await policyProject(request, response);
  if (!context) return;
  if (resourceOwner(context.db, "project", context.id) !== context.local.id) throw new ClusterV2HttpError(403, "Only the original owner may change sharing");
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
    for (const row of rows) {
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
