import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { getClusterNode } from "../../cluster.js";
import { pinnedClusterPublicKey } from "../../cluster-identity.js";
import { applyMembershipSnapshot, createMembershipCluster, createMembershipInvitation, getMembershipSnapshot, removeMembershipMember, updateMembershipDescriptor, type MembershipInvitation, type SignedMembershipSnapshot } from "../../cluster-membership.js";
import { verifyClusterMessage } from "../../cluster-identity.js";
import { getSharingCluster, listSharingClusterMembers, listSharingMemberships, setAutoShareProjects } from "../../cluster-sharing-policy.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { ClusterV2HttpError } from "../../cluster-v2-errors.js";
import { clusterManager, ensureV2HttpSchema, flushV2MembershipOutbox, invitationLink, joinV2Membership, localMembershipDescriptor, mapV2Error, signedPost } from "../cluster-v2.js";
import { app } from "../state.js";

const uuid = z.string().uuid();
const epochSchema = z.object({ expectedEpoch: z.number().int().positive() }).strict();
const invitationRequestSchema = z.object({ clusterId: uuid, expectedEpoch: z.number().int().positive() }).strict();
const removeSchema = z.object({ clusterId: uuid, targetNodeId: uuid, expectedEpoch: z.number().int().positive() }).strict();
const snapshotWrapper = z.object({ snapshot: z.unknown() }).strict();
const descriptorSchema = z.object({ clusterId: uuid, name: z.string(), url: z.string() }).strict();

function localOnly(response: Response): void {
  if (!response.locals.authSession) throw new ClusterV2HttpError(401, "Unauthorized");
}
function machineOnly(response: Response): string {
  if (response.locals.machineProtocol !== 2 || typeof response.locals.machineNodeId !== "string") throw new ClusterV2HttpError(401, "Unauthorized");
  return response.locals.machineNodeId as string;
}
function handler(action: (request: Request, response: Response) => Promise<void>): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => { void action(request, response).catch((error) => mapV2Error(error, response, next)); };
}

app.get("/api/clusters", handler(async (_request, response) => {
  localOnly(response);
  const local = await getClusterNode();
  const db = await clusterV2Database();
  ensureV2HttpSchema(db);
  const deliveries = db.prepare("SELECT cluster_id,count(*) count FROM cluster_v2_membership_deliveries GROUP BY cluster_id").all() as unknown as Array<{ cluster_id: string; count: number }>;
  const pending = new Map(deliveries.map((row) => [row.cluster_id, row.count]));
  const clusters = listSharingMemberships(db, local.id).map((membership) => {
    const snapshot = getMembershipSnapshot(db, membership.clusterId);
    const descriptors = new Map(snapshot.body.members.map((member) => [member.nodeId, member]));
    const members = listSharingClusterMembers(db, membership.clusterId).map((member) => {
      const descriptor = descriptors.get(member.nodeId);
      if (!descriptor) throw new Error(`Missing verified member descriptor for ${member.nodeId}`);
      return { ...member, name: descriptor.name, url: descriptor.url };
    });
    return { ...getSharingCluster(db, membership.clusterId), members,
      autoShareProjects: membership.autoShareProjects, pendingDeliveries: pending.get(membership.clusterId) ?? 0 };
  });
  response.json({ clusters });
}));

app.post("/api/clusters", handler(async (request, response) => {
  localOnly(response);
  const payload = z.object({ name: z.string().trim().min(1).max(80) }).strict().parse(request.body);
  const local = await localMembershipDescriptor();
  const db = await clusterV2Database(); ensureV2HttpSchema(db);
  db.exec("SAVEPOINT cluster_v2_create");
  try {
    const snapshot = createMembershipCluster(db, local, { id: randomUUID(), name: payload.name });
    db.exec("RELEASE cluster_v2_create"); response.status(201).json({ snapshot });
  } catch (error) { db.exec("ROLLBACK TO cluster_v2_create; RELEASE cluster_v2_create"); throw error; }
}));

app.post("/api/clusters/:clusterId/invitations", handler(async (request, response) => {
  localOnly(response);
  const clusterId = uuid.parse(request.params.clusterId), { expectedEpoch } = epochSchema.parse(request.body);
  const local = await getClusterNode(), db = await clusterV2Database(), manager = clusterManager(db, clusterId);
  let invitation: MembershipInvitation;
  if (manager === local.id) invitation = createMembershipInvitation(db, local.id, local.id, clusterId, expectedEpoch);
  else {
    const result = await signedPost<{ invitation: MembershipInvitation }>(db, local.id, manager, clusterId, "/api/cluster/v2/membership/invitations", { clusterId, expectedEpoch });
    invitation = result.invitation;
    const state = getSharingCluster(db, clusterId), key = pinnedClusterPublicKey(db, manager);
    if (!key || invitation.body.clusterId !== clusterId || invitation.body.manager.nodeId !== manager || invitation.body.managerEpoch !== expectedEpoch || state.managerEpoch !== expectedEpoch || invitation.body.manager.publicKey !== key || !verifyClusterMessage(key, "membership-invitation", JSON.stringify(invitation.body), invitation.signature)) throw new ClusterV2HttpError(503, "Cluster peer returned an invalid response");
  }
  response.status(201).json({ link: invitationLink(invitation) });
}));

app.post("/api/clusters/join", handler(async (request, response) => {
  localOnly(response);
  const payload = z.object({ link: z.string().max(32768), requestId: uuid }).strict().parse(request.body);
  const result = await joinV2Membership(payload.link, payload.requestId);
  response.status(result.created ? 201 : 200).json({ snapshot: result.snapshot });
}));

app.patch("/api/clusters/:clusterId/membership", handler(async (request, response) => {
  localOnly(response); const payload = z.object({ autoShareProjects: z.boolean() }).strict().parse(request.body);
  const local = await getClusterNode(), db = await clusterV2Database(); setAutoShareProjects(db, uuid.parse(request.params.clusterId), local.id, payload.autoShareProjects); response.json({ ok: true });
}));

async function remove(request: Request, response: Response, targetNodeId: string): Promise<void> {
  localOnly(response); const clusterId = uuid.parse(request.params.clusterId), { expectedEpoch } = epochSchema.parse(request.body);
  const local = await getClusterNode(), db = await clusterV2Database(), manager = clusterManager(db, clusterId);
  const snapshot = manager === local.id ? removeMembershipMember(db, local.id, local.id, clusterId, targetNodeId, expectedEpoch)
    : (await signedPost<{ snapshot: SignedMembershipSnapshot }>(db, local.id, manager, clusterId, "/api/cluster/v2/membership/remove", { clusterId, targetNodeId, expectedEpoch })).snapshot;
  if (manager !== local.id) applyMembershipSnapshot(db, local.id, snapshot);
  response.json({ snapshot });
}
app.post("/api/clusters/:clusterId/leave", handler(async (request, response) => {
  const local = await getClusterNode();
  await remove(request, response, local.id);
}));
app.delete("/api/clusters/:clusterId/members/:nodeId", handler((request, response) => remove(request, response, uuid.parse(request.params.nodeId))));

app.post("/api/cluster/v2/membership/invitations", handler(async (request, response) => {
  const actor = machineOnly(response), payload = invitationRequestSchema.parse(request.body), local = await getClusterNode(), db = await clusterV2Database();
  response.status(201).json({ invitation: createMembershipInvitation(db, local.id, actor, payload.clusterId, payload.expectedEpoch) });
}));
app.post("/api/cluster/v2/membership/remove", handler(async (request, response) => {
  const actor = machineOnly(response), payload = removeSchema.parse(request.body), local = await getClusterNode(), db = await clusterV2Database();
  response.json({ snapshot: removeMembershipMember(db, local.id, actor, payload.clusterId, payload.targetNodeId, payload.expectedEpoch) });
}));
/** A member reports its new name and URL to the manager, which republishes the membership. */
app.post("/api/cluster/v2/membership/descriptor", handler(async (request, response) => {
  const sender = machineOnly(response), payload = descriptorSchema.parse(request.body), local = await getClusterNode(), db = await clusterV2Database();
  updateMembershipDescriptor(db, local.id, payload.clusterId, { nodeId: sender, name: payload.name, url: payload.url });
  await flushV2MembershipOutbox();
  response.json({ ok: true });
}));

app.post("/api/cluster/v2/membership/snapshot", handler(async (request, response) => {
  const sender = machineOnly(response), payload = snapshotWrapper.parse(request.body) as { snapshot: SignedMembershipSnapshot };
  if (payload.snapshot?.signerNodeId !== sender) throw new ClusterV2HttpError(401, "Unauthorized");
  const local = await getClusterNode(), db = await clusterV2Database(); applyMembershipSnapshot(db, local.id, payload.snapshot); response.json({ ok: true });
}));
