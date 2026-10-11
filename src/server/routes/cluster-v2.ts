import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { getClusterNode } from "../../cluster.js";
import { pinnedClusterPublicKey } from "../../cluster-identity.js";
import { applyMembershipSnapshot, closeMembershipCluster, createMembershipCluster, createMembershipInvitation, getMembershipSnapshot, removeMembershipMember, updateMembershipDescriptor, type MembershipInvitation, type SignedMembershipSnapshot } from "../../cluster-membership.js";
import { verifyClusterMessage } from "../../cluster-identity.js";
import { getSharingCluster, listSharingClusterMembers, listSharingMemberships, setAutoShareProjects } from "../../cluster-sharing-policy.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { ClusterV2HttpError } from "../../cluster-v2-errors.js";
import { clusterManager, ensureV2HttpSchema, flushV2MembershipOutbox, invitationLink, joinV2Membership, localMembershipDescriptor, mapV2Error, parseV2InvitationLink, signedPost } from "../cluster-v2.js";
import { actingAccount, type ActingAccount } from "../../account-context.js";
import { accountInCluster, addClusterLocalMember, clusterLocalMembers, forgetCluster, removeClusterLocalMember } from "../../cluster-accounts.js";
import { unshareOwnedProjects } from "../../selected-sharing.js";
import { sendError } from "../http-auth.js";
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

/** People join clusters themselves; a visitor from another node manages none here. */
function clusterPerson(response: Response): ActingAccount {
  localOnly(response);
  const account = actingAccount();
  if (!account || account.isRemoteLogin) throw new ClusterV2HttpError(404, "Not found");
  return account;
}

// A cluster the acting person didn't join answers like an unknown route, on every route
// that names one. Node-to-node routes carry no person and are checked by signature.
app.param("clusterId", (_request, response, next, clusterId: string) => {
  const account = actingAccount();
  if (!response.locals.authSession || !account) { next(); return; }
  void clusterV2Database().then((db) => {
    if (account.isRemoteLogin || !accountInCluster(db, account.accountId, clusterId)) { sendError(response, 404, "Not found"); return; }
    next();
  }, next);
});
function machineOnly(response: Response): string {
  if (response.locals.machineProtocol !== 2 || typeof response.locals.machineNodeId !== "string") throw new ClusterV2HttpError(401, "Unauthorized");
  return response.locals.machineNodeId as string;
}
function handler(action: (request: Request, response: Response) => Promise<void>): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => { void action(request, response).catch((error) => mapV2Error(error, response, next)); };
}

app.get("/api/clusters", handler(async (_request, response) => {
  localOnly(response);
  const account = actingAccount();
  if (account?.isRemoteLogin) { response.json({ clusters: [] }); return; }
  const local = await getClusterNode();
  const db = await clusterV2Database();
  ensureV2HttpSchema(db);
  const deliveries = db.prepare("SELECT cluster_id,count(*) count FROM cluster_v2_membership_deliveries GROUP BY cluster_id").all() as unknown as Array<{ cluster_id: string; count: number }>;
  const pending = new Map(deliveries.map((row) => [row.cluster_id, row.count]));
  // Only the clusters this person joined; others on the node joined theirs.
  const mine = listSharingMemberships(db, local.id).filter((membership) => !account || accountInCluster(db, account.accountId, membership.clusterId));
  const clusters = mine.map((membership) => {
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
  const person = clusterPerson(response);
  const payload = z.object({ name: z.string().trim().min(1).max(80) }).strict().parse(request.body);
  const local = await localMembershipDescriptor();
  const db = await clusterV2Database(); ensureV2HttpSchema(db);
  db.exec("SAVEPOINT cluster_v2_create");
  try {
    const id = randomUUID();
    const snapshot = createMembershipCluster(db, local, { id, name: payload.name });
    addClusterLocalMember(db, id, person.accountId);
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
  const person = clusterPerson(response);
  const payload = z.object({ link: z.string().max(32768), requestId: uuid }).strict().parse(request.body);
  const parsed = parseV2InvitationLink(payload.link);
  const clusterId = parsed.invitation.body.clusterId;
  const db = await clusterV2Database(), local = await getClusterNode();
  // The node is already in: a valid invitation lets one more person here join it. A retried
  // or reused request id goes the usual way, which answers it consistently.
  ensureV2HttpSchema(db);
  const seen = db.prepare("SELECT 1 FROM cluster_v2_join_results WHERE request_id=? UNION ALL SELECT 1 FROM cluster_v2_join_attempts WHERE request_id=?").get(payload.requestId, payload.requestId);
  if (!seen && db.prepare("SELECT 1 FROM sharing_memberships WHERE cluster_id=? AND node_id=?").get(clusterId, local.id)) {
    const key = pinnedClusterPublicKey(db, parsed.invitation.body.manager.nodeId);
    if (!key || key !== parsed.invitation.body.manager.publicKey || Date.now() > parsed.invitation.body.expiresAt
      || !verifyClusterMessage(key, "membership-invitation", JSON.stringify(parsed.invitation.body), parsed.invitation.signature)) throw new ClusterV2HttpError(401, "Unauthorized");
    addClusterLocalMember(db, clusterId, person.accountId);
    response.json({ snapshot: getMembershipSnapshot(db, clusterId) });
    return;
  }
  const result = await joinV2Membership(payload.link, payload.requestId);
  addClusterLocalMember(db, result.snapshot.body.clusterId, person.accountId);
  // The new members missed earlier shares; ask them once rather than polling.
  // Loaded lazily: a static import closes a module cycle that deadlocks startup.
  void import("../ntfy-share.js").then(({ syncNtfyServiceShares }) => syncNtfyServiceShares()).catch((error) => console.warn("ntfy service share sync after join failed", error));
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
// A person leaves; the node leaves with the last of its people in the cluster.
app.post("/api/clusters/:clusterId/leave", handler(async (request, response) => {
  const person = clusterPerson(response);
  const clusterId = uuid.parse(request.params.clusterId);
  const local = await getClusterNode(), db = await clusterV2Database();
  if (clusterLocalMembers(db, clusterId).filter((accountId) => accountId !== person.accountId).length) {
    epochSchema.parse(request.body);
    unshareOwnedProjects(db, local.id, clusterId, person.accountId);
    removeClusterLocalMember(db, clusterId, person.accountId);
    response.json({ snapshot: getMembershipSnapshot(db, clusterId) });
    return;
  }
  await remove(request, response, local.id);
  forgetCluster(db, clusterId);
}));
app.delete("/api/clusters/:clusterId/members/:nodeId", handler((request, response) => remove(request, response, uuid.parse(request.params.nodeId))));

app.post("/api/clusters/:clusterId/close", handler(async (request, response) => {
  localOnly(response);
  const clusterId = uuid.parse(request.params.clusterId), { expectedEpoch } = epochSchema.parse(request.body);
  const local = await getClusterNode(), db = await clusterV2Database(), state = getSharingCluster(db, clusterId);
  if (state.originalNodeId !== local.id) throw new ClusterV2HttpError(403, "Only the cluster owner may close it");
  const manager = clusterManager(db, clusterId);
  const snapshot = manager === local.id ? closeMembershipCluster(db, local.id, local.id, clusterId, expectedEpoch)
    : (await signedPost<{ snapshot: SignedMembershipSnapshot }>(db, local.id, manager, clusterId, "/api/cluster/v2/membership/close", { clusterId, expectedEpoch })).snapshot;
  if (manager !== local.id) applyMembershipSnapshot(db, local.id, snapshot);
  response.json({ snapshot });
}));

app.post("/api/cluster/v2/membership/close", handler(async (request, response) => {
  const actor = machineOnly(response), payload = invitationRequestSchema.parse(request.body);
  const local = await getClusterNode(), db = await clusterV2Database();
  response.json({ snapshot: closeMembershipCluster(db, local.id, actor, payload.clusterId, payload.expectedEpoch) });
}));

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
