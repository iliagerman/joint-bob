import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { getClusterNode } from "../../cluster.js";
import {
  acceptMembershipManagerTransfer, commitMembershipManagerTransfer, getMembershipManagerTransfer,
  managerTransferAcceptanceSchema, managerTransferOfferSchema, prepareMembershipManagerTransfer,
  receiveMembershipManagerOffer,
} from "../../cluster-membership.js";
import { getSharingCluster, listSharingClusterMembers } from "../../cluster-sharing-policy.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { ClusterV2HttpError, selectiveSharingActive } from "../../cluster-v2-mode.js";
import { ensureManagerHttpSchema, queueManagerStep } from "../cluster-manager.js";
import { mapV2Error } from "../cluster-v2.js";
import { app } from "../state.js";

const uuid = z.string().uuid();
const prepareSchema = z.object({ successorNodeId: uuid, expectedEpoch: z.number().int().positive(), transferId: uuid }).strict();
const emptySchema = z.object({}).strict();
const offerSchema = z.object({ offer: managerTransferOfferSchema }).strict();
const acceptanceSchema = z.object({ acceptance: managerTransferAcceptanceSchema }).strict();
function handler(action: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => void action(request, response).catch((error) => mapV2Error(error, response, next));
}
function localOnly(response: Response): void { if (!response.locals.authSession) throw new ClusterV2HttpError(401, "Unauthorized"); }
function machineOnly(response: Response): string {
  if (response.locals.machineProtocol !== 2 || typeof response.locals.machineNodeId !== "string") throw new ClusterV2HttpError(401, "Unauthorized");
  return response.locals.machineNodeId as string;
}
async function active(): Promise<void> { if (!await selectiveSharingActive()) throw new ClusterV2HttpError(409, "Selective sharing is not active"); }
function savepoint<T>(db: Awaited<ReturnType<typeof clusterV2Database>>, action: () => T): T {
  db.exec("SAVEPOINT manager_http_route");
  try { const result = action(); db.exec("RELEASE manager_http_route"); return result; }
  catch (error) { db.exec("ROLLBACK TO manager_http_route; RELEASE manager_http_route"); throw error; }
}

app.post("/api/clusters/:clusterId/manager-transfer", handler(async (request, response) => {
  localOnly(response); await active();
  const clusterId = uuid.parse(request.params.clusterId), payload = prepareSchema.parse(request.body);
  const local = await getClusterNode(), db = await clusterV2Database(); ensureManagerHttpSchema(db);
  const transfer = savepoint(db, () => {
    const offer = prepareMembershipManagerTransfer(db, local.id, clusterId, payload.successorNodeId, payload.expectedEpoch, payload.transferId);
    const saved = getMembershipManagerTransfer(db, clusterId, payload.transferId);
    if (!saved.certificate) queueManagerStep(db, { step: "offer", payload: offer });
    return saved;
  });
  response.status(202).json({ transfer });
}));

app.get("/api/clusters/:clusterId/manager-transfer/:transferId", handler(async (request, response) => {
  localOnly(response); await active();
  const clusterId = uuid.parse(request.params.clusterId), transferId = uuid.parse(request.params.transferId);
  const local = await getClusterNode(), db = await clusterV2Database(); ensureManagerHttpSchema(db);
  if (!listSharingClusterMembers(db, clusterId).some((member) => member.nodeId === local.id)) throw new ClusterV2HttpError(403, "Forbidden");
  response.json({ transfer: getMembershipManagerTransfer(db, clusterId, transferId) });
}));

app.post("/api/clusters/:clusterId/manager-transfer/:transferId/accept", handler(async (request, response) => {
  localOnly(response); await active(); emptySchema.parse(request.body);
  const clusterId = uuid.parse(request.params.clusterId), transferId = uuid.parse(request.params.transferId);
  const local = await getClusterNode(), db = await clusterV2Database(); ensureManagerHttpSchema(db);
  const transfer = savepoint(db, () => {
    const saved = getMembershipManagerTransfer(db, clusterId, transferId);
    if (saved.offer.body.toNodeId !== local.id) throw new ClusterV2HttpError(403, "Forbidden");
    if (saved.certificate) return saved;
    const acceptance = acceptMembershipManagerTransfer(db, local.id, saved.offer);
    queueManagerStep(db, { step: "acceptance", payload: acceptance });
    return getMembershipManagerTransfer(db, clusterId, transferId);
  });
  response.status(202).json({ transfer });
}));

app.post("/api/cluster/v2/manager-transfer/offer", handler(async (request, response) => {
  await active(); const sender = machineOnly(response), { offer } = offerSchema.parse(request.body);
  const local = await getClusterNode();
  if (sender !== offer.body.fromNodeId || local.id !== offer.body.toNodeId) throw new ClusterV2HttpError(403, "Forbidden");
  const db = await clusterV2Database(); ensureManagerHttpSchema(db); receiveMembershipManagerOffer(db, local.id, offer);
  response.json({ ok: true });
}));

app.post("/api/cluster/v2/manager-transfer/acceptance", handler(async (request, response) => {
  await active(); const sender = machineOnly(response), { acceptance } = acceptanceSchema.parse(request.body);
  const offer = acceptance.offer, local = await getClusterNode();
  if (sender !== offer.body.toNodeId || local.id !== offer.body.fromNodeId) throw new ClusterV2HttpError(403, "Forbidden");
  const db = await clusterV2Database(); ensureManagerHttpSchema(db);
  const certificate = savepoint(db, () => {
    const result = commitMembershipManagerTransfer(db, local.id, acceptance);
    db.prepare("DELETE FROM cluster_v2_manager_steps WHERE cluster_id=? AND transfer_id=? AND step='offer' AND peer_id=?")
      .run(offer.body.base.body.clusterId, offer.body.transferId, offer.body.toNodeId);
    return result;
  });
  response.json({ certificate });
}));
