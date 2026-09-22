import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { acceptSharingManagerTransfer, addSharingMember, commitSharingManagerTransfer, createSharingCluster, ensureClusterSharingPolicySchema, getSharingCluster, listSharingClusterMembers, prepareSharingManagerTransfer, removeSharingMember } from "./cluster-sharing-policy.js";
import { clusterPublicKeyFingerprint, ensureClusterIdentitySchema, getOrCreateClusterIdentity, pinClusterPublicKey, pinnedClusterPublicKey, signClusterMessage, verifyClusterMessage } from "./cluster-identity.js";
import { ensurePeerEndpointSchema, recordMembershipEndpoints } from "./cluster-peer-endpoints.js";
import { reconcileOwnedResourceTopology } from "./cluster-sharing.js";
import { assertRoutingClassifierForJoin } from "./routing-policy.js";

const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/);
const name = z.string().trim().min(1).max(80);
const positive = z.number().int().safe().positive();
const signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
const invitationSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const key = z.string().max(4096).superRefine((value, context) => { try { clusterPublicKeyFingerprint(value); } catch { context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid Ed25519 public key" }); } });
const origin = z.string().transform((value, context) => {
  try { const parsed = new URL(value); const loopback = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname); if ((parsed.protocol !== "https:" && !loopback) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error(); return parsed.origin; }
  catch { context.addIssue({ code: z.ZodIssueCode.custom, message: "URL must be an HTTPS or loopback HTTP origin" }); return z.NEVER; }
});
const nodeSchema = z.object({ nodeId: uuid, name, url: origin, publicKey: key }).strict();
const entrySchema = nodeSchema.extend({ joinSequence: positive, invitedByNodeId: uuid.nullable() }).strict();
const departureSchema = z.object({ nodeId: uuid, joinSequence: positive }).strict();
const bodySchema = z.object({ clusterId: uuid, name, originalNodeId: uuid, managerNodeId: uuid.nullable(), managerEpoch: positive, revision: positive, nextJoinSequence: positive, closed: z.boolean(), members: z.array(entrySchema).max(5), departures: z.array(departureSchema) }).strict().superRefine((body, context) => {
  const memberIds = new Set<string>(), ranks = new Set<number>(), departed = new Set<string>(); let previous = 0;
  for (const member of body.members) { if (memberIds.has(member.nodeId) || ranks.has(member.joinSequence) || member.joinSequence <= previous) context.addIssue({ code: z.ZodIssueCode.custom, message: "Members must have distinct identities and sorted ranks" }); memberIds.add(member.nodeId); ranks.add(member.joinSequence); previous = member.joinSequence; }
  previous = 0; for (const item of body.departures) { const pair = `${item.nodeId}:${item.joinSequence}`; if (departed.has(pair) || ranks.has(item.joinSequence) || item.joinSequence <= previous) context.addIssue({ code: z.ZodIssueCode.custom, message: "Departures must be distinct, sorted, and not active" }); departed.add(pair); ranks.add(item.joinSequence); previous = item.joinSequence; }
  if ([...ranks].some((rank) => rank >= body.nextJoinSequence)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Next join sequence must exceed every admission" });
  if (body.closed !== (body.members.length === 0 && body.managerNodeId === null)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Closed state is inconsistent" });
  if (!body.closed && body.managerNodeId === null) context.addIssue({ code: z.ZodIssueCode.custom, message: "Active cluster requires a manager" });
  if (body.managerNodeId && !memberIds.has(body.managerNodeId)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Manager must be a current member" });
});
const snapshotSchema = z.object({ body: bodySchema, signerNodeId: uuid, signature }).strict();
const invitationBodySchema = z.object({ invitationId: uuid, clusterId: uuid, manager: nodeSchema, managerEpoch: positive, expiresAt: positive }).strict();
const invitationSchema = z.object({ body: invitationBodySchema, signature, secret: invitationSecret }).strict();
const requestUnsignedSchema = z.object({ invitationId: uuid, clusterId: uuid, requestId: uuid, member: nodeSchema, classifierIds: z.array(z.string().trim().min(1).max(80)).max(50) }).strict();
const requestSchema = requestUnsignedSchema.extend({ signature }).strict();
const managerTransferOfferBodySchema = z.object({ transferId: uuid, fromNodeId: uuid, toNodeId: uuid, expectedEpoch: positive, base: snapshotSchema }).strict();
export const managerTransferOfferSchema = z.object({ body: managerTransferOfferBodySchema, signature }).strict();
export const managerTransferAcceptanceSchema = z.object({ offer: managerTransferOfferSchema, snapshot: snapshotSchema, signature }).strict();
export const managerTransferCertificateSchema = z.object({ acceptance: managerTransferAcceptanceSchema, signature }).strict();

export type MembershipNode = z.infer<typeof nodeSchema>;
export type MembershipEntry = z.infer<typeof entrySchema>;
export type MembershipSnapshotBody = z.infer<typeof bodySchema>;
export type SignedMembershipSnapshot = z.infer<typeof snapshotSchema>;
export type MembershipInvitation = z.infer<typeof invitationSchema>;
export type MembershipJoinRequest = z.infer<typeof requestSchema>;
export type ManagerTransferOffer = z.infer<typeof managerTransferOfferSchema>;
export type ManagerTransferAcceptance = z.infer<typeof managerTransferAcceptanceSchema>;
export type ManagerTransferCertificate = z.infer<typeof managerTransferCertificateSchema>;
interface NodeRow { node_id:string; name:string; url:string; public_key:string; invited_by_node_id:string|null }
interface JoinRow { invitation_id:string; request_id:string; manager_id:string; manager_key:string; manager_epoch:number; request:string }
interface InvitationRow { cluster_id:string; body:string; signature:string; secret_hash:string; invited_by_node_id:string; request_id:string|null; member_id:string|null; request:string|null; redemption:string|null }

export function ensureMembershipSchema(db: DatabaseSync): void {
  ensureClusterIdentitySchema(db); ensureClusterSharingPolicySchema(db); ensurePeerEndpointSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_membership_snapshots(cluster_id TEXT PRIMARY KEY,snapshot TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cluster_v2_membership_nodes(cluster_id TEXT,node_id TEXT,name TEXT,url TEXT,public_key TEXT,invited_by_node_id TEXT,PRIMARY KEY(cluster_id,node_id));
CREATE TABLE IF NOT EXISTS cluster_v2_membership_departures(cluster_id TEXT,node_id TEXT,join_sequence INTEGER,PRIMARY KEY(cluster_id,node_id,join_sequence));
CREATE TABLE IF NOT EXISTS cluster_v2_membership_invitations(invitation_id TEXT PRIMARY KEY,cluster_id TEXT,body TEXT,signature TEXT,secret_hash TEXT,invited_by_node_id TEXT,request_id TEXT,member_id TEXT,request TEXT,redemption TEXT);
CREATE TABLE IF NOT EXISTS cluster_v2_membership_joins(cluster_id TEXT PRIMARY KEY,invitation_id TEXT,request_id TEXT,manager_id TEXT,manager_key TEXT,manager_epoch INTEGER,request TEXT);
CREATE TABLE IF NOT EXISTS cluster_v2_membership_deliveries(cluster_id TEXT,peer_id TEXT,url TEXT,revision INTEGER,snapshot TEXT,PRIMARY KEY(cluster_id,peer_id,revision));
CREATE TABLE IF NOT EXISTS cluster_v2_manager_wire(cluster_id TEXT NOT NULL,transfer_id TEXT NOT NULL,expected_epoch INTEGER NOT NULL,offer TEXT NOT NULL,acceptance TEXT,certificate TEXT,PRIMARY KEY(cluster_id,transfer_id),UNIQUE(cluster_id,expected_epoch));
CREATE TABLE IF NOT EXISTS cluster_v2_manager_deliveries(cluster_id TEXT NOT NULL,peer_id TEXT NOT NULL,url TEXT NOT NULL,transfer_id TEXT NOT NULL,certificate TEXT NOT NULL,PRIMARY KEY(cluster_id,peer_id,transfer_id));`);
}
function transaction<T>(db:DatabaseSync, action:()=>T):T { db.exec("SAVEPOINT membership_wire"); try { const result=action(); db.exec("RELEASE membership_wire"); return result; } catch(error) { db.exec("ROLLBACK TO membership_wire; RELEASE membership_wire"); throw error; } }
function descriptor(db:DatabaseSync, local:{nodeId:string;name:string;url:string}):MembershipNode { const parsed={ nodeId:uuid.parse(local.nodeId), name:name.parse(local.name), url:origin.parse(local.url), publicKey:getOrCreateClusterIdentity(db, local.nodeId).publicKey }; return nodeSchema.parse(parsed); }
function storedSnapshot(db:DatabaseSync, clusterId:string):SignedMembershipSnapshot|undefined { const row=db.prepare("SELECT snapshot FROM cluster_v2_membership_snapshots WHERE cluster_id=?").get(clusterId) as {snapshot:string}|undefined; return row ? snapshotSchema.parse(JSON.parse(row.snapshot)) : undefined; }
function nodeRows(db:DatabaseSync, clusterId:string):NodeRow[] { return db.prepare("SELECT node_id,name,url,public_key,invited_by_node_id FROM cluster_v2_membership_nodes WHERE cluster_id=?").all(clusterId) as unknown as NodeRow[]; }
function makeSnapshot(db:DatabaseSync, clusterId:string, signer:string, revision:number):SignedMembershipSnapshot {
  const state=getSharingCluster(db,clusterId), metadata=new Map(nodeRows(db,clusterId).map(row=>[row.node_id,row]));
  const members=listSharingClusterMembers(db,clusterId).map(member=>{ const row=metadata.get(member.nodeId); if(!row) throw new Error("Missing membership metadata"); return { nodeId:row.node_id,name:row.name,url:row.url,publicKey:row.public_key,joinSequence:member.joinSequence,invitedByNodeId:row.invited_by_node_id }; });
  const departures=db.prepare("SELECT node_id,join_sequence FROM cluster_v2_membership_departures WHERE cluster_id=? ORDER BY join_sequence").all(clusterId) as unknown as Array<{node_id:string;join_sequence:number}>;
  const next=(db.prepare("SELECT next_join_sequence FROM sharing_clusters WHERE id=?").get(clusterId) as {next_join_sequence:number}).next_join_sequence;
  const body=bodySchema.parse({clusterId,name:state.name,originalNodeId:state.originalNodeId,managerNodeId:state.managerNodeId,managerEpoch:state.managerEpoch,revision,nextJoinSequence:next,closed:state.closed,members,departures:departures.map(row=>({nodeId:row.node_id,joinSequence:row.join_sequence}))});
  return {body,signerNodeId:signer,signature:signClusterMessage(db,signer,"membership-snapshot",JSON.stringify(body))};
}
function publish(
  db: DatabaseSync, clusterId: string, signer: string, recipients: NodeRow[] = [],
): SignedMembershipSnapshot {
  const revision = (storedSnapshot(db, clusterId)?.body.revision ?? 0) + 1;
  const snapshot = makeSnapshot(db, clusterId, signer, revision);
  const text = JSON.stringify(snapshot);
  db.prepare(`INSERT INTO cluster_v2_membership_snapshots VALUES(?,?)
    ON CONFLICT(cluster_id) DO UPDATE SET snapshot=excluded.snapshot`).run(clusterId, text);
  recordMembershipEndpoints(db, snapshot);
  reconcileOwnedResourceTopology(db, signer, clusterId);
  for (const peer of recipients) {
    if (peer.node_id !== signer) db.prepare(
      "INSERT OR REPLACE INTO cluster_v2_membership_deliveries VALUES(?,?,?,?,?)",
    ).run(clusterId, peer.node_id, peer.url, revision, text);
  }
  return snapshot;
}

export function createMembershipCluster(db:DatabaseSync, local:{nodeId:string;name:string;url:string}, cluster:{id:string;name:string}):SignedMembershipSnapshot { ensureMembershipSchema(db); return transaction(db,()=>{ const member=descriptor(db,local), parsed={id:uuid.parse(cluster.id),name:name.parse(cluster.name)}; createSharingCluster(db,parsed,member.nodeId); pinClusterPublicKey(db,member.nodeId,member.publicKey); db.prepare("INSERT INTO cluster_v2_membership_nodes VALUES(?,?,?,?,?,NULL)").run(parsed.id,member.nodeId,member.name,member.url,member.publicKey); return publish(db,parsed.id,member.nodeId); }); }
export function createMembershipInvitation(db:DatabaseSync, localNodeId:string, actorNodeId:string, clusterId:string, expectedEpoch:number, now=Date.now()):MembershipInvitation { ensureMembershipSchema(db); return transaction(db,()=>{ uuid.parse(localNodeId); uuid.parse(actorNodeId); const state=getSharingCluster(db,uuid.parse(clusterId)); if(state.managerNodeId!==localNodeId||state.managerEpoch!==positive.parse(expectedEpoch)) throw new Error("Cluster manager authority changed"); if(!listSharingClusterMembers(db,clusterId).some(x=>x.nodeId===actorNodeId)) throw new Error("Actor is not a member"); if(db.prepare("SELECT 1 FROM sharing_manager_transfers WHERE cluster_id=? AND expected_epoch=? AND status<>'committed'").get(clusterId,expectedEpoch)) throw new Error("Cluster has a pending transfer"); const row=nodeRows(db,clusterId).find(x=>x.node_id===localNodeId)!; const secret=randomBytes(32).toString("base64url"); const body=invitationBodySchema.parse({invitationId:randomUUID(),clusterId,manager:{nodeId:row.node_id,name:row.name,url:row.url,publicKey:row.public_key},managerEpoch:expectedEpoch,expiresAt:now+900000}); const result={body,signature:signClusterMessage(db,localNodeId,"membership-invitation",JSON.stringify(body)),secret}; db.prepare("INSERT INTO cluster_v2_membership_invitations VALUES(?,?,?,?,?,?,NULL,NULL,NULL,NULL)").run(body.invitationId,clusterId,JSON.stringify(body),result.signature,createHash("sha256").update(secret).digest("hex"),actorNodeId); return invitationSchema.parse(result); }); }
export function prepareMembershipJoin(db:DatabaseSync, local:{nodeId:string;name:string;url:string}, input:MembershipInvitation, expectedFingerprint:string, requestId:string, now=Date.now(), classifierIds:readonly string[]=[]):MembershipJoinRequest { ensureMembershipSchema(db); const invitation=invitationSchema.parse(input); if(clusterPublicKeyFingerprint(invitation.body.manager.publicKey)!==expectedFingerprint||!verifyClusterMessage(invitation.body.manager.publicKey,"membership-invitation",JSON.stringify(invitation.body),invitation.signature)) throw new Error("Invitation signature or fingerprint is invalid"); if(now>invitation.body.expiresAt) throw new Error("Invitation expired"); if(local.nodeId===invitation.body.manager.nodeId) throw new Error("A node cannot join itself"); return transaction(db,()=>{ const member=descriptor(db,local), unsigned=requestUnsignedSchema.parse({invitationId:invitation.body.invitationId,clusterId:invitation.body.clusterId,requestId:uuid.parse(requestId),member,classifierIds:[...new Set(classifierIds)].sort()}), request=requestSchema.parse({...unsigned,signature:signClusterMessage(db,member.nodeId,"membership-join",JSON.stringify(unsigned))}), exact=JSON.stringify(request); const existing=db.prepare("SELECT request FROM cluster_v2_membership_joins WHERE cluster_id=?").get(unsigned.clusterId) as {request:string}|undefined; if(existing) { if(existing.request!==exact) throw new Error("Pending join conflict"); return requestSchema.parse(JSON.parse(existing.request)); } if(db.prepare("SELECT 1 FROM sharing_memberships WHERE cluster_id=? AND node_id=?").get(unsigned.clusterId,member.nodeId)) throw new Error("Already an active member"); pinClusterPublicKey(db,invitation.body.manager.nodeId,invitation.body.manager.publicKey); db.prepare("INSERT INTO cluster_v2_membership_joins VALUES(?,?,?,?,?,?,?)").run(unsigned.clusterId,unsigned.invitationId,unsigned.requestId,invitation.body.manager.nodeId,invitation.body.manager.publicKey,invitation.body.managerEpoch,exact); return request; }); }

export function redeemMembershipInvitation(
  db: DatabaseSync, localNodeId: string, input: MembershipJoinRequest, secretValue: string, now = Date.now(),
): SignedMembershipSnapshot {
  ensureMembershipSchema(db);
  const request = requestSchema.parse(input), exact = JSON.stringify(request);
  return transaction(db, () => {
    const invitation = db.prepare(`SELECT cluster_id,body,signature,secret_hash,invited_by_node_id,
      request_id,member_id,request,redemption FROM cluster_v2_membership_invitations WHERE invitation_id=?`)
      .get(request.invitationId) as InvitationRow | undefined;
    if (!invitation) throw new Error("Unknown invitation");
    const parsedSecret = invitationSecret.safeParse(secretValue);
    if (!parsedSecret.success) throw new Error("Invalid invitation secret");
    const supplied = createHash("sha256").update(parsedSecret.data).digest();
    const expected = Buffer.from(invitation.secret_hash, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("Invalid invitation secret");
    const body = invitationBodySchema.parse(JSON.parse(invitation.body));
    if (body.clusterId !== request.clusterId) throw new Error("Invitation cluster mismatch");
    const unsigned = requestUnsignedSchema.parse({ invitationId: request.invitationId, clusterId: request.clusterId, requestId: request.requestId, member: request.member, classifierIds: request.classifierIds });
    if (!verifyClusterMessage(request.member.publicKey, "membership-join", JSON.stringify(unsigned), request.signature)) throw new Error("Invalid join proof");
    if (invitation.redemption) {
      if (invitation.request === exact && invitation.request_id === request.requestId && invitation.member_id === request.member.nodeId) return snapshotSchema.parse(JSON.parse(invitation.redemption));
      throw new Error("Invitation already used");
    }
    if (now > body.expiresAt) throw new Error("Invitation expired");
    const state = getSharingCluster(db, body.clusterId);
    if (state.managerNodeId !== localNodeId || body.manager.nodeId !== localNodeId || state.managerEpoch !== body.managerEpoch) throw new Error("Cluster manager authority changed");
    if (db.prepare("SELECT 1 FROM sharing_manager_transfers WHERE cluster_id=? AND expected_epoch=? AND status<>'committed'").get(body.clusterId, state.managerEpoch)) throw new Error("Cluster has a pending transfer");
    assertRoutingClassifierForJoin(db, body.clusterId, request.classifierIds);
    const existing = nodeRows(db, body.clusterId).find((row) => row.node_id === request.member.nodeId);
    if (existing && JSON.stringify({ nodeId: existing.node_id, name: existing.name, url: existing.url, publicKey: existing.public_key }) !== JSON.stringify(request.member)) throw new Error("Member descriptor conflict");
    pinClusterPublicKey(db, request.member.nodeId, request.member.publicKey);
    addSharingMember(db, body.clusterId, localNodeId, request.member.nodeId, body.managerEpoch);
    if (!existing) db.prepare("INSERT INTO cluster_v2_membership_nodes VALUES(?,?,?,?,?,?)").run(body.clusterId, request.member.nodeId, request.member.name, request.member.url, request.member.publicKey, invitation.invited_by_node_id);
    const snapshot = publish(db, body.clusterId, localNodeId, nodeRows(db, body.clusterId));
    db.prepare("UPDATE cluster_v2_membership_invitations SET request_id=?,member_id=?,request=?,redemption=? WHERE invitation_id=?").run(request.requestId, request.member.nodeId, exact, JSON.stringify(snapshot), request.invitationId);
    return snapshot;
  });
}

export function removeMembershipMember(db:DatabaseSync, localNodeId:string, actorNodeId:string, clusterId:string, targetNodeId:string, expectedEpoch:number):SignedMembershipSnapshot { ensureMembershipSchema(db); return transaction(db,()=>{ const state=getSharingCluster(db,clusterId); if(state.managerNodeId!==localNodeId||state.managerEpoch!==expectedEpoch) throw new Error("Cluster manager authority changed"); const old=nodeRows(db,clusterId), target=listSharingClusterMembers(db,clusterId).find(x=>x.nodeId===targetNodeId); if(!target) throw new Error("Target is not a member"); db.prepare("INSERT OR IGNORE INTO cluster_v2_membership_departures VALUES(?,?,?)").run(clusterId,targetNodeId,target.joinSequence); removeSharingMember(db,clusterId,actorNodeId,targetNodeId); db.prepare("DELETE FROM cluster_v2_membership_nodes WHERE cluster_id=? AND node_id=?").run(clusterId,targetNodeId); return publish(db,clusterId,localNodeId,[...old,...nodeRows(db,clusterId)]); }); }

function verifyEvolution(previous:SignedMembershipSnapshot, incoming:SignedMembershipSnapshot):void { const old=previous.body, next=incoming.body; if(next.managerEpoch!==old.managerEpoch||next.originalNodeId!==old.originalNodeId||(!next.closed&&next.managerNodeId!==old.managerNodeId)) throw new Error("Manager activation certificate required"); if(next.nextJoinSequence<old.nextJoinSequence) throw new Error("Join sequence cannot decrease"); const tombstones=new Set(next.departures.map(x=>`${x.nodeId}:${x.joinSequence}`)); for(const departed of old.departures) if(!tombstones.has(`${departed.nodeId}:${departed.joinSequence}`)) throw new Error("Missing departure tombstone"); for(const member of old.members) { const current=next.members.find(x=>x.nodeId===member.nodeId); if(current&&current.joinSequence===member.joinSequence) { if(current.publicKey!==member.publicKey) throw new Error("Member key cannot change"); continue; } if(!tombstones.has(`${member.nodeId}:${member.joinSequence}`)) throw new Error("Missing departure tombstone"); if(current&&current.joinSequence<old.nextJoinSequence) throw new Error("Admission rank cannot change"); } for(const member of next.members) if(!old.members.some(x=>x.nodeId===member.nodeId&&x.joinSequence===member.joinSequence)&&member.joinSequence<old.nextJoinSequence) throw new Error("Manager cannot manufacture an old rank"); }
interface PreferenceRow { node_id: string; join_sequence: number; auto_share_projects: number }

function purgeDepartedAdmissionShares(db: DatabaseSync, body: MembershipSnapshotBody): void {
  const nextAdmissions = new Set(body.members.map((member) => `${member.nodeId}:${member.joinSequence}`));
  const previous = db.prepare("SELECT node_id,join_sequence FROM sharing_memberships WHERE cluster_id=?")
    .all(body.clusterId) as unknown as Array<{ node_id: string; join_sequence: number }>;
  for (const admission of previous) {
    if (nextAdmissions.has(`${admission.node_id}:${admission.join_sequence}`)) continue;
    db.prepare(`DELETE FROM sharing_resource_shares WHERE cluster_id=? AND EXISTS
      (SELECT 1 FROM sharing_resource_owners o WHERE o.kind=sharing_resource_shares.kind
       AND o.resource_id=sharing_resource_shares.resource_id AND o.owner_node_id=?)`).run(body.clusterId, admission.node_id);
  }
}

function clearInvalidSecretScopes(db: DatabaseSync): void {
  db.prepare(`DELETE FROM sharing_resource_shares AS s WHERE s.kind = 'secret' AND s.project_id <> ''
    AND NOT EXISTS (SELECT 1 FROM sharing_resource_shares p JOIN sharing_resource_owners po ON po.kind='project' AND po.resource_id=p.resource_id JOIN sharing_memberships pm ON pm.cluster_id=p.cluster_id AND pm.node_id=po.owner_node_id WHERE p.kind='project' AND p.resource_id=s.project_id AND p.cluster_id=s.cluster_id)`).run();
}

function install(db: DatabaseSync, localNodeId: string, snapshot: SignedMembershipSnapshot): void {
  const body = snapshot.body;
  const preferences = new Map((db.prepare("SELECT node_id,join_sequence,auto_share_projects FROM sharing_memberships WHERE cluster_id=?")
    .all(body.clusterId) as unknown as PreferenceRow[]).map((row) => [`${row.node_id}:${row.join_sequence}`, row.auto_share_projects]));
  purgeDepartedAdmissionShares(db, body);
  db.prepare("DELETE FROM sharing_memberships WHERE cluster_id=?").run(body.clusterId);
  db.prepare("DELETE FROM cluster_v2_membership_nodes WHERE cluster_id=?").run(body.clusterId);
  db.prepare(`INSERT INTO sharing_clusters VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,
    original_node_id=excluded.original_node_id,manager_node_id=excluded.manager_node_id,manager_epoch=excluded.manager_epoch,
    next_join_sequence=excluded.next_join_sequence,closed=excluded.closed`).run(body.clusterId, body.name, body.originalNodeId, body.managerNodeId, body.managerEpoch, body.nextJoinSequence, body.closed ? 1 : 0);
  for (const member of body.members) {
    pinClusterPublicKey(db, member.nodeId, member.publicKey);
    const preference = member.nodeId === localNodeId ? preferences.get(`${member.nodeId}:${member.joinSequence}`) ?? 0 : 0;
    db.prepare("INSERT INTO sharing_memberships VALUES(?,?,?,?)").run(body.clusterId, member.nodeId, preference, member.joinSequence);
    db.prepare("INSERT INTO cluster_v2_membership_nodes VALUES(?,?,?,?,?,?)").run(body.clusterId, member.nodeId, member.name, member.url, member.publicKey, member.invitedByNodeId);
  }
  clearInvalidSecretScopes(db);
  for (const departure of body.departures) db.prepare("INSERT OR IGNORE INTO cluster_v2_membership_departures VALUES(?,?,?)").run(body.clusterId, departure.nodeId, departure.joinSequence);
  db.prepare("INSERT INTO cluster_v2_membership_snapshots VALUES(?,?) ON CONFLICT(cluster_id) DO UPDATE SET snapshot=excluded.snapshot").run(body.clusterId, JSON.stringify(snapshot));
  recordMembershipEndpoints(db, snapshot);
  reconcileOwnedResourceTopology(db, localNodeId, body.clusterId);
  if (body.members.some((member) => member.nodeId === localNodeId)) db.prepare("DELETE FROM cluster_v2_membership_joins WHERE cluster_id=?").run(body.clusterId);
}

function pendingJoin(db: DatabaseSync, clusterId: string): JoinRow | undefined {
  return db.prepare(`SELECT invitation_id,request_id,manager_id,manager_key,manager_epoch,request
    FROM cluster_v2_membership_joins WHERE cluster_id=?`).get(clusterId) as JoinRow | undefined;
}

function requireLocalAdmissionConsent(
  pending: JoinRow | undefined,
  snapshot: SignedMembershipSnapshot,
  own: MembershipEntry,
  localNodeId: string,
  localPublicKey: string,
  verificationKey: string,
): void {
  if (!pending) throw new Error("Local admission requires an accepted pending invitation");
  if (pending.manager_id !== snapshot.signerNodeId || pending.manager_id !== snapshot.body.managerNodeId
    || pending.manager_epoch !== snapshot.body.managerEpoch || pending.manager_key !== verificationKey) {
    throw new Error("Manager activation certificate required");
  }
  const request = requestSchema.parse(JSON.parse(pending.request));
  const matches = request.clusterId === snapshot.body.clusterId
    && request.invitationId === pending.invitation_id && request.requestId === pending.request_id
    && request.member.nodeId === localNodeId && request.member.publicKey === localPublicKey
    && own.publicKey === localPublicKey;
  if (!matches) throw new Error("Local admission requires an accepted pending invitation");
}

export function applyMembershipSnapshot(db: DatabaseSync, localNodeId: string, input: SignedMembershipSnapshot): void {
  ensureMembershipSchema(db);
  const snapshot = snapshotSchema.parse(input), canonical = JSON.stringify(snapshot);
  transaction(db, () => {
    const identity = getOrCreateClusterIdentity(db, localNodeId);
    const previous = storedSnapshot(db, snapshot.body.clusterId);
    let verificationKey: string;
    let pending: JoinRow | undefined;
    if (previous) {
      if (previous.body.closed) {
        if (JSON.stringify(previous) === canonical) return;
        throw new Error("Closed cluster cannot reopen");
      }
      if (snapshot.signerNodeId !== previous.body.managerNodeId) throw new Error("Manager activation certificate required");
      verificationKey = pinnedClusterPublicKey(db, snapshot.signerNodeId)!;
      if (snapshot.body.revision < previous.body.revision) throw new Error("Stale membership snapshot");
      if (snapshot.body.revision === previous.body.revision) {
        if (JSON.stringify(previous) === canonical) return;
        throw new Error("Conflicting membership snapshot revision");
      }
      verifyEvolution(previous, snapshot);
    } else {
      pending = pendingJoin(db, snapshot.body.clusterId);
      if (!pending) throw new Error("Snapshot requires an accepted pending invitation");
      if (pending.manager_id !== snapshot.signerNodeId || pending.manager_id !== snapshot.body.managerNodeId
        || pending.manager_epoch !== snapshot.body.managerEpoch) throw new Error("Manager activation certificate required");
      verificationKey = pending.manager_key;
    }
    if (!verifyClusterMessage(verificationKey, "membership-snapshot", JSON.stringify(snapshot.body), snapshot.signature)) {
      throw new Error("Invalid membership snapshot signature");
    }
    const own = snapshot.body.members.find((member) => member.nodeId === localNodeId);
    const oldOwn = previous?.body.members.find((member) => member.nodeId === localNodeId);
    if (!previous && !own) throw new Error("Snapshot does not include accepted local identity");
    if (own && (!oldOwn || oldOwn.joinSequence !== own.joinSequence)) {
      requireLocalAdmissionConsent(pending ?? pendingJoin(db, snapshot.body.clusterId), snapshot, own,
        localNodeId, identity.publicKey, verificationKey);
    } else if (own && own.publicKey !== identity.publicKey) {
      throw new Error("Local identity key mismatch");
    }
    install(db, localNodeId, snapshot);
  });
}
interface ManagerWireRow { offer:string; acceptance:string|null; certificate:string|null }
function managerWireRow(db:DatabaseSync,clusterId:string,transferId:string):ManagerWireRow|undefined {
  return db.prepare("SELECT offer,acceptance,certificate FROM cluster_v2_manager_wire WHERE cluster_id=? AND transfer_id=?").get(clusterId,transferId) as ManagerWireRow|undefined;
}
function requireSnapshotSignature(db:DatabaseSync,snapshot:SignedMembershipSnapshot,nodeId:string):void {
  const publicKey=pinnedClusterPublicKey(db,nodeId);
  if(!publicKey||snapshot.signerNodeId!==nodeId||!verifyClusterMessage(publicKey,"membership-snapshot",JSON.stringify(snapshot.body),snapshot.signature)) throw new Error("Invalid membership snapshot signature");
}
function verifyOffer(db:DatabaseSync,offer:ManagerTransferOffer):void {
  const body=offer.body, publicKey=pinnedClusterPublicKey(db,body.fromNodeId);
  if(!publicKey||!verifyClusterMessage(publicKey,"membership-manager-offer",JSON.stringify(body),offer.signature)) throw new Error("Invalid manager transfer offer signature");
  requireSnapshotSignature(db,body.base,body.fromNodeId);
  if(body.base.body.managerNodeId!==body.fromNodeId||body.base.body.managerEpoch!==body.expectedEpoch) throw new Error("Manager transfer offer does not match base authority");
  if(body.fromNodeId===body.toNodeId||!body.base.body.members.some(member=>member.nodeId===body.toNodeId)) throw new Error("Successor must be a distinct current member");
}
function nextManagerSnapshotBody(offer:ManagerTransferOffer):MembershipSnapshotBody {
  const base=offer.body.base.body;
  if(base.managerEpoch===Number.MAX_SAFE_INTEGER||base.revision===Number.MAX_SAFE_INTEGER) throw new Error("Manager transfer sequence exhausted");
  return bodySchema.parse({...base,managerNodeId:offer.body.toNodeId,managerEpoch:base.managerEpoch+1,revision:base.revision+1});
}
function verifyAcceptance(db:DatabaseSync,acceptance:ManagerTransferAcceptance):void {
  verifyOffer(db,acceptance.offer); const successor=acceptance.offer.body.toNodeId;
  requireSnapshotSignature(db,acceptance.snapshot,successor);
  if(JSON.stringify(acceptance.snapshot.body)!==JSON.stringify(nextManagerSnapshotBody(acceptance.offer))) throw new Error("Manager transfer snapshot is not exactly derived from base");
  const publicKey=pinnedClusterPublicKey(db,successor);
  if(!publicKey||!verifyClusterMessage(publicKey,"membership-manager-accept",JSON.stringify({offer:acceptance.offer,snapshot:acceptance.snapshot}),acceptance.signature)) throw new Error("Invalid manager transfer acceptance signature");
}
function verifyCertificate(db:DatabaseSync,certificate:ManagerTransferCertificate):void {
  verifyAcceptance(db,certificate.acceptance); const manager=certificate.acceptance.offer.body.fromNodeId, publicKey=pinnedClusterPublicKey(db,manager);
  if(!publicKey||!verifyClusterMessage(publicKey,"membership-manager-commit",JSON.stringify(certificate.acceptance),certificate.signature)) throw new Error("Invalid manager transfer certificate signature");
}
function requireExactBase(db:DatabaseSync,offer:ManagerTransferOffer):void {
  const current=storedSnapshot(db,offer.body.base.body.clusterId), state=getSharingCluster(db,offer.body.base.body.clusterId);
  if(!current||JSON.stringify(current)!==JSON.stringify(offer.body.base)||state.managerNodeId!==offer.body.fromNodeId||state.managerEpoch!==offer.body.expectedEpoch) throw new Error("Cluster manager authority changed from frozen base");
}

export function prepareMembershipManagerTransfer(db:DatabaseSync,localNodeId:string,clusterId:string,successorNodeId:string,expectedEpoch:number,transferId:string):ManagerTransferOffer {
  ensureMembershipSchema(db); uuid.parse(localNodeId); uuid.parse(clusterId); uuid.parse(successorNodeId); uuid.parse(transferId); positive.parse(expectedEpoch); getOrCreateClusterIdentity(db,localNodeId);
  return transaction(db,()=>{ const existing=managerWireRow(db,clusterId,transferId);
    if(existing){const offer=managerTransferOfferSchema.parse(JSON.parse(existing.offer)); if(offer.body.fromNodeId!==localNodeId||offer.body.toNodeId!==successorNodeId||offer.body.expectedEpoch!==expectedEpoch) throw new Error("Transfer ID reuse with different fields"); return offer;}
    const state=getSharingCluster(db,clusterId), base=storedSnapshot(db,clusterId);
    if(!base||state.closed||state.managerNodeId!==localNodeId||state.managerEpoch!==expectedEpoch||base.body.managerNodeId!==localNodeId||base.body.managerEpoch!==expectedEpoch) throw new Error("Cluster manager authority changed");
    prepareSharingManagerTransfer(db,clusterId,localNodeId,successorNodeId,expectedEpoch,transferId);
    const body=managerTransferOfferBodySchema.parse({transferId,fromNodeId:localNodeId,toNodeId:successorNodeId,expectedEpoch,base});
    const offer=managerTransferOfferSchema.parse({body,signature:signClusterMessage(db,localNodeId,"membership-manager-offer",JSON.stringify(body))});
    db.prepare("INSERT INTO cluster_v2_manager_wire(cluster_id,transfer_id,expected_epoch,offer) VALUES(?,?,?,?)").run(clusterId,transferId,expectedEpoch,JSON.stringify(offer)); return offer;
  });
}
export function receiveMembershipManagerOffer(
  db: DatabaseSync,
  localNodeId: string,
  input: ManagerTransferOffer,
): ManagerTransferOffer {
  ensureMembershipSchema(db);
  const offer = managerTransferOfferSchema.parse(input);
  const clusterId = offer.body.base.body.clusterId;
  return transaction(db, () => {
    verifyOffer(db, offer);
    if (localNodeId !== offer.body.toNodeId) throw new Error("Only the named successor can receive the transfer");
    if (!listSharingClusterMembers(db, clusterId).some((member) => member.nodeId === localNodeId)) {
      throw new Error("Local admission requires existing membership");
    }
    const existing = managerWireRow(db, clusterId, offer.body.transferId);
    if (existing) {
      if (existing.offer !== JSON.stringify(offer)) throw new Error("Conflicting manager transfer offer");
      return managerTransferOfferSchema.parse(JSON.parse(existing.offer));
    }
    applyMembershipSnapshot(db, localNodeId, offer.body.base);
    requireExactBase(db, offer);
    prepareSharingManagerTransfer(db, clusterId, offer.body.fromNodeId, localNodeId,
      offer.body.expectedEpoch, offer.body.transferId);
    db.prepare(`INSERT INTO cluster_v2_manager_wire
      (cluster_id,transfer_id,expected_epoch,offer) VALUES(?,?,?,?)`)
      .run(clusterId, offer.body.transferId, offer.body.expectedEpoch, JSON.stringify(offer));
    return offer;
  });
}

export function getMembershipManagerTransfer(
  db: DatabaseSync,
  clusterId: string,
  transferId: string,
): { offer: ManagerTransferOffer; acceptance: ManagerTransferAcceptance | null; certificate: ManagerTransferCertificate | null } {
  ensureMembershipSchema(db);
  const row = managerWireRow(db, uuid.parse(clusterId), uuid.parse(transferId));
  if (!row) throw new Error("Unknown manager transfer");
  return {
    offer: managerTransferOfferSchema.parse(JSON.parse(row.offer)),
    acceptance: row.acceptance ? managerTransferAcceptanceSchema.parse(JSON.parse(row.acceptance)) : null,
    certificate: row.certificate ? managerTransferCertificateSchema.parse(JSON.parse(row.certificate)) : null,
  };
}

export function acceptMembershipManagerTransfer(db:DatabaseSync,localNodeId:string,input:ManagerTransferOffer):ManagerTransferAcceptance {
  ensureMembershipSchema(db); uuid.parse(localNodeId); const offer=managerTransferOfferSchema.parse(input), clusterId=offer.body.base.body.clusterId;
  return transaction(db,()=>{ verifyOffer(db,offer); if(localNodeId!==offer.body.toNodeId) throw new Error("Only the named successor can accept the transfer");
    const existing=managerWireRow(db,clusterId,offer.body.transferId); if(existing&&existing.offer!==JSON.stringify(offer)) throw new Error("Conflicting manager transfer offer");
    if(existing?.acceptance){const saved=managerTransferAcceptanceSchema.parse(JSON.parse(existing.acceptance)); const state=getSharingCluster(db,clusterId); if(state.managerEpoch>offer.body.expectedEpoch) throw new Error("Stale manager transfer"); return saved;}
    const state=getSharingCluster(db,clusterId); if(state.managerEpoch!==offer.body.expectedEpoch||state.managerNodeId!==offer.body.fromNodeId) throw new Error("Stale manager transfer");
    applyMembershipSnapshot(db,localNodeId,offer.body.base); requireExactBase(db,offer);
    if(!existing) db.prepare("INSERT INTO cluster_v2_manager_wire(cluster_id,transfer_id,expected_epoch,offer) VALUES(?,?,?,?)").run(clusterId,offer.body.transferId,offer.body.expectedEpoch,JSON.stringify(offer));
    prepareSharingManagerTransfer(db,clusterId,offer.body.fromNodeId,localNodeId,offer.body.expectedEpoch,offer.body.transferId);
    const body=nextManagerSnapshotBody(offer), snapshot=snapshotSchema.parse({body,signerNodeId:localNodeId,signature:signClusterMessage(db,localNodeId,"membership-snapshot",JSON.stringify(body))});
    const unsigned={offer,snapshot}, acceptance=managerTransferAcceptanceSchema.parse({...unsigned,signature:signClusterMessage(db,localNodeId,"membership-manager-accept",JSON.stringify(unsigned))});
    db.prepare("UPDATE cluster_v2_manager_wire SET acceptance=? WHERE cluster_id=? AND transfer_id=?").run(JSON.stringify(acceptance),clusterId,offer.body.transferId); return acceptance;
  });
}
function enqueueManagerTransfer(
  db: DatabaseSync,
  offer: ManagerTransferOffer,
  certificate: string,
  senderNodeId: string,
): void {
  for (const peer of offer.body.base.body.members) {
    if (peer.nodeId === senderNodeId) continue;
    db.prepare(`INSERT INTO cluster_v2_manager_deliveries
      (cluster_id,peer_id,url,transfer_id,certificate) VALUES(?,?,?,?,?)`)
      .run(offer.body.base.body.clusterId, peer.nodeId, peer.url, offer.body.transferId, certificate);
  }
}

export function commitMembershipManagerTransfer(
  db: DatabaseSync,
  localNodeId: string,
  input: ManagerTransferAcceptance,
): ManagerTransferCertificate {
  ensureMembershipSchema(db);
  uuid.parse(localNodeId);
  const acceptance = managerTransferAcceptanceSchema.parse(input);
  const offer = acceptance.offer;
  const clusterId = offer.body.base.body.clusterId;
  return transaction(db, () => {
    if (localNodeId !== offer.body.fromNodeId) throw new Error("Only the current manager can commit the transfer");
    const row = managerWireRow(db, clusterId, offer.body.transferId);
    if (!row || row.offer !== JSON.stringify(offer)) throw new Error("Exact persisted manager transfer offer required");
    if (row.certificate) {
      const saved = managerTransferCertificateSchema.parse(JSON.parse(row.certificate));
      if (row.acceptance !== JSON.stringify(acceptance)
        || JSON.stringify(saved.acceptance) !== JSON.stringify(acceptance)) {
        throw new Error("Conflicting manager transfer certificate");
      }
      return saved;
    }
    verifyAcceptance(db, acceptance);
    requireExactBase(db, offer);
    acceptSharingManagerTransfer(db, clusterId, offer.body.toNodeId, offer.body.transferId);
    commitSharingManagerTransfer(db, clusterId, localNodeId, offer.body.transferId);
    install(db, localNodeId, acceptance.snapshot);
    const certificate = managerTransferCertificateSchema.parse({
      acceptance,
      signature: signClusterMessage(db, localNodeId, "membership-manager-commit", JSON.stringify(acceptance)),
    });
    const exact = JSON.stringify(certificate);
    db.prepare("UPDATE cluster_v2_manager_wire SET acceptance=?,certificate=? WHERE cluster_id=? AND transfer_id=?")
      .run(JSON.stringify(acceptance), exact, clusterId, offer.body.transferId);
    enqueueManagerTransfer(db, offer, exact, localNodeId);
    return certificate;
  });
}

export function applyMembershipManagerTransfer(
  db: DatabaseSync,
  localNodeId: string,
  input: ManagerTransferCertificate,
): void {
  ensureMembershipSchema(db);
  uuid.parse(localNodeId);
  const certificate = managerTransferCertificateSchema.parse(input);
  const acceptance = certificate.acceptance;
  const offer = acceptance.offer;
  const clusterId = offer.body.base.body.clusterId;
  const exact = JSON.stringify(certificate);
  transaction(db, () => {
    verifyOffer(db, offer);
    const state = getSharingCluster(db, clusterId);
    const activatedEpoch = offer.body.expectedEpoch + 1;
    if (state.managerEpoch > activatedEpoch) throw new Error("Stale manager transfer certificate");
    const row = managerWireRow(db, clusterId, offer.body.transferId);
    if (row?.certificate) {
      if (row.certificate !== exact) throw new Error("Conflicting manager transfer certificate");
      if (state.managerEpoch === activatedEpoch) return;
      throw new Error("Cluster manager authority changed");
    }
    if (row && row.offer !== JSON.stringify(offer)) throw new Error("Conflicting manager transfer offer");
    const current = storedSnapshot(db, clusterId)!;
    if (state.managerEpoch !== offer.body.expectedEpoch
      || state.managerNodeId !== offer.body.fromNodeId
      || current.body.revision > offer.body.base.body.revision) {
      throw new Error("Cluster manager authority changed");
    }
    applyMembershipSnapshot(db, localNodeId, offer.body.base);
    requireExactBase(db, offer);
    verifyCertificate(db, certificate);
    if (localNodeId === offer.body.toNodeId
      && (!row?.acceptance || row.acceptance !== JSON.stringify(acceptance))) {
      throw new Error("Successor certificate requires exact local acceptance");
    }
    if (!row) {
      db.prepare(`INSERT INTO cluster_v2_manager_wire
        (cluster_id,transfer_id,expected_epoch,offer,acceptance) VALUES(?,?,?,?,?)`)
        .run(clusterId, offer.body.transferId, offer.body.expectedEpoch,
          JSON.stringify(offer), JSON.stringify(acceptance));
    }
    prepareSharingManagerTransfer(db, clusterId, offer.body.fromNodeId,
      offer.body.toNodeId, offer.body.expectedEpoch, offer.body.transferId);
    acceptSharingManagerTransfer(db, clusterId, offer.body.toNodeId, offer.body.transferId);
    commitSharingManagerTransfer(db, clusterId, offer.body.fromNodeId, offer.body.transferId);
    install(db, localNodeId, acceptance.snapshot);
    db.prepare("UPDATE cluster_v2_manager_wire SET acceptance=?,certificate=? WHERE cluster_id=? AND transfer_id=?")
      .run(JSON.stringify(acceptance), exact, clusterId, offer.body.transferId);
    if (localNodeId === offer.body.toNodeId) enqueueManagerTransfer(db, offer, exact, localNodeId);
  });
}
export function listManagerTransferDeliveries(db:DatabaseSync):Array<{clusterId:string;peerId:string;url:string;transferId:string;certificate:ManagerTransferCertificate}> { ensureMembershipSchema(db); const rows=db.prepare("SELECT cluster_id,peer_id,url,transfer_id,certificate FROM cluster_v2_manager_deliveries ORDER BY cluster_id,peer_id,transfer_id").all() as unknown as Array<{cluster_id:string;peer_id:string;url:string;transfer_id:string;certificate:string}>; return rows.map(row=>({clusterId:row.cluster_id,peerId:row.peer_id,url:row.url,transferId:row.transfer_id,certificate:managerTransferCertificateSchema.parse(JSON.parse(row.certificate))})); }
export function acknowledgeManagerTransferDelivery(db:DatabaseSync,clusterId:string,peerId:string,transferId:string):void { ensureMembershipSchema(db); db.prepare("DELETE FROM cluster_v2_manager_deliveries WHERE cluster_id=? AND peer_id=? AND transfer_id=?").run(uuid.parse(clusterId),uuid.parse(peerId),uuid.parse(transferId)); }

export function getMembershipSnapshot(db:DatabaseSync, clusterId:string):SignedMembershipSnapshot { ensureMembershipSchema(db); const result=storedSnapshot(db,uuid.parse(clusterId)); if(!result) throw new Error(`Unknown membership snapshot: ${clusterId}`); return result; }
export function listMembershipDeliveries(db:DatabaseSync):Array<{clusterId:string;peerId:string;url:string;revision:number;snapshot:SignedMembershipSnapshot}> { ensureMembershipSchema(db); const rows=db.prepare("SELECT cluster_id,peer_id,url,revision,snapshot FROM cluster_v2_membership_deliveries ORDER BY cluster_id,peer_id,revision").all() as unknown as Array<{cluster_id:string;peer_id:string;url:string;revision:number;snapshot:string}>; return rows.map(x=>({clusterId:x.cluster_id,peerId:x.peer_id,url:x.url,revision:x.revision,snapshot:snapshotSchema.parse(JSON.parse(x.snapshot))})); }
export function acknowledgeMembershipDelivery(db:DatabaseSync, clusterId:string, peerId:string, revision:number):void { ensureMembershipSchema(db); db.prepare("DELETE FROM cluster_v2_membership_deliveries WHERE cluster_id=? AND peer_id=? AND revision=?").run(uuid.parse(clusterId),uuid.parse(peerId),positive.parse(revision)); }
