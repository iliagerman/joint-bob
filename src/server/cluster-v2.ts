import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { clusterPublicKeyFingerprint, pinClusterPublicKey } from "../cluster-identity.js";
import { applyMembershipSnapshot, ensureMembershipSchema, listMembershipDeliveries, acknowledgeMembershipDelivery, prepareMembershipJoin, redeemMembershipInvitation, type MembershipInvitation, type MembershipJoinRequest, type SignedMembershipSnapshot } from "../cluster-membership.js";
import { ClusterProtocolError, signClusterRequest, verifyClusterRequest } from "../cluster-protocol.js";
import { getSharingCluster, listSharingClusterMembers } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { activateSelectiveSharing, assertSelectiveSharingCanActivate, ClusterV2HttpError, selectiveSharingActive } from "../cluster-v2-mode.js";
import { clusterRequestRawBody, isClusterOriginUrl, sendError } from "./http-auth.js";

const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/);
const origin = z.string().transform((value, context) => {
  try {
    const parsed = new URL(value);
    if (!isClusterOriginUrl(value)) throw new Error();
    return parsed.origin;
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid cluster origin" });
    return z.NEVER;
  }
});
const publicKey = z.string().max(4096).superRefine((value, context) => {
  try { clusterPublicKeyFingerprint(value); }
  catch { context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid Ed25519 public key" }); }
});
const nodeSchema = z.object({ nodeId: uuid, name: z.string().trim().min(1).max(80), url: origin, publicKey }).strict();
const joinRequestSchema = z.object({ invitationId: uuid, clusterId: uuid, requestId: uuid, member: nodeSchema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
const redeemSchema = z.object({ request: joinRequestSchema, secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const positive = z.number().int().safe().positive();
const invitationSchema = z.object({
  body: z.object({
    invitationId: uuid,
    clusterId: uuid,
    manager: nodeSchema,
    managerEpoch: positive,
    expiresAt: positive,
  }).strict(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export function ensureV2HttpSchema(db: DatabaseSync): void {
  ensureMembershipSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_join_results(request_id TEXT PRIMARY KEY,invitation_id TEXT NOT NULL,cluster_id TEXT NOT NULL,invitation_hash TEXT NOT NULL,snapshot TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cluster_v2_join_attempts(request_id TEXT PRIMARY KEY,invitation_id TEXT NOT NULL,cluster_id TEXT NOT NULL,invitation_hash TEXT NOT NULL,request TEXT NOT NULL)`);
}

export function invitationHash(invitation: MembershipInvitation): string {
  return createHash("sha256").update(JSON.stringify({ body: invitation.body, signature: invitation.signature })).digest("hex");
}

export async function localMembershipDescriptor(): Promise<{ nodeId: string; name: string; url: string }> {
  const node = await getClusterNode();
  if (!node.url || !isClusterOriginUrl(node.url)) throw new ClusterV2HttpError(409, "Cluster node URL must be an HTTPS or loopback origin");
  return { nodeId: node.id, name: node.name, url: new URL(node.url).origin };
}

export function parseV2InvitationLink(link: string): { invitation: MembershipInvitation; fingerprint: string; secret: string } {
  if (typeof link !== "string" || link.length > 32768) throw new ClusterV2HttpError(400, "Invalid cluster request");
  let url: URL;
  try { url = new URL(link); } catch { throw new ClusterV2HttpError(400, "Invalid cluster request"); }
  const fields = url.hash.slice(1).split(".");
  if (!isClusterOriginUrl(url.origin) || url.pathname !== "/join" || url.search || url.username || url.password || fields.length !== 3 || fields[0] !== "v2") throw new ClusterV2HttpError(400, "Invalid cluster request");
  const encoded = fields[2];
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new ClusterV2HttpError(400, "Invalid cluster request");
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) throw new ClusterV2HttpError(400, "Invalid cluster request");
  let invitation: MembershipInvitation;
  try { invitation = invitationSchema.parse(JSON.parse(decoded.toString("utf8"))); } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) throw new ClusterV2HttpError(400, "Invalid cluster request");
    throw error;
  }
  if (invitation.body.manager.url !== url.origin || clusterPublicKeyFingerprint(invitation.body.manager.publicKey) !== fields[1]) throw new ClusterV2HttpError(401, "Unauthorized");
  return { invitation, fingerprint: fields[1], secret: invitation.secret };
}

export function invitationLink(invitation: MembershipInvitation): string {
  const fingerprint = clusterPublicKeyFingerprint(invitation.body.manager.publicKey);
  return `${invitation.body.manager.url}/join#v2.${fingerprint}.${Buffer.from(JSON.stringify(invitation)).toString("base64url")}`;
}

function memberDescriptor(db: DatabaseSync, clusterId: string, nodeId: string): { url: string } {
  const pending = db.prepare(`SELECT n.url FROM cluster_v2_membership_joins j
    JOIN cluster_v2_membership_nodes n ON n.cluster_id=j.cluster_id AND n.node_id=j.manager_id
    WHERE j.cluster_id=? AND j.manager_id=?`).get(clusterId, nodeId) as { url: string } | undefined;
  if (pending) return pending;
  const row = db.prepare("SELECT url FROM cluster_v2_membership_nodes WHERE cluster_id=? AND node_id=?").get(clusterId, nodeId) as { url: string } | undefined;
  if (!row || !listSharingClusterMembers(db, clusterId).some((member) => member.nodeId === nodeId)) throw new ClusterV2HttpError(403, "Forbidden");
  return row;
}

export async function signedPost<T>(db: DatabaseSync, senderNodeId: string, recipientNodeId: string, clusterId: string, target: string, payload: unknown): Promise<T> {
  const body = Buffer.from(JSON.stringify(payload));
  const peer = memberDescriptor(db, clusterId, recipientNodeId);
  let response: globalThis.Response;
  try {
    response = await fetch(new URL(target, peer.url), { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Authorization: signClusterRequest(db, senderNodeId, recipientNodeId, "POST", target, body) }, body, signal: AbortSignal.timeout(10_000) });
  } catch { throw new ClusterV2HttpError(503, "Cluster peer is unavailable"); }
  if (!response.ok) throw new ClusterV2HttpError(response.status >= 400 && response.status < 500 ? response.status : 503, `Cluster peer request failed (${response.status})`);
  try { return await response.json() as T; } catch { throw new ClusterV2HttpError(503, "Cluster peer returned an invalid response"); }
}

interface JoinOperationResult { snapshot: SignedMembershipSnapshot; created: boolean }
const pendingJoinOperations = new Map<string, { hash: string; promise: Promise<JoinOperationResult> }>();

export async function joinV2Membership(link: string, requestId: string): Promise<JoinOperationResult> {
  const parsed = parseV2InvitationLink(link), hash = invitationHash(parsed.invitation);
  const active = pendingJoinOperations.get(requestId);
  if (active) {
    if (active.hash !== hash) throw new ClusterV2HttpError(409, "Request ID reuse conflict");
    return active.promise;
  }
  const promise = executeJoinV2Membership(parsed, hash, requestId);
  pendingJoinOperations.set(requestId, { hash, promise });
  try { return await promise; }
  finally { pendingJoinOperations.delete(requestId); }
}

async function executeJoinV2Membership(parsed: ReturnType<typeof parseV2InvitationLink>, hash: string, requestId: string): Promise<JoinOperationResult> {
  const db = await clusterV2Database(); ensureV2HttpSchema(db);
  const completed = db.prepare("SELECT invitation_id,invitation_hash,snapshot FROM cluster_v2_join_results WHERE request_id=?").get(requestId) as { invitation_id: string; invitation_hash: string; snapshot: string } | undefined;
  if (completed) {
    if (completed.invitation_id !== parsed.invitation.body.invitationId || completed.invitation_hash !== hash) throw new ClusterV2HttpError(409, "Request ID reuse conflict");
    return { snapshot: JSON.parse(completed.snapshot) as SignedMembershipSnapshot, created: false };
  }
  const prior = db.prepare("SELECT invitation_id,cluster_id,invitation_hash,request FROM cluster_v2_join_attempts WHERE request_id=?").get(requestId) as { invitation_id: string; cluster_id: string; invitation_hash: string; request: string } | undefined;
  if (prior && (prior.invitation_id !== parsed.invitation.body.invitationId || prior.cluster_id !== parsed.invitation.body.clusterId || prior.invitation_hash !== hash)) throw new ClusterV2HttpError(409, "Request ID reuse conflict");
  let joinRequest: MembershipJoinRequest;
  if (prior) joinRequest = joinRequestSchema.parse(JSON.parse(prior.request));
  else {
    await assertSelectiveSharingCanActivate();
    const local = await localMembershipDescriptor();
    db.exec("SAVEPOINT cluster_v2_prepare_join");
    try {
      joinRequest = prepareMembershipJoin(db, local, parsed.invitation, parsed.fingerprint, requestId);
      db.prepare("INSERT OR IGNORE INTO cluster_v2_membership_nodes VALUES(?,?,?,?,?,NULL)").run(joinRequest.clusterId, parsed.invitation.body.manager.nodeId, parsed.invitation.body.manager.name, parsed.invitation.body.manager.url, parsed.invitation.body.manager.publicKey);
      db.prepare("INSERT INTO cluster_v2_join_attempts VALUES(?,?,?,?,?)").run(requestId, joinRequest.invitationId, joinRequest.clusterId, hash, JSON.stringify(joinRequest));
      activateSelectiveSharing(db); db.exec("RELEASE cluster_v2_prepare_join");
    } catch (error) { db.exec("ROLLBACK TO cluster_v2_prepare_join; RELEASE cluster_v2_prepare_join"); throw error; }
  }
  const result = await signedPost<{ snapshot: SignedMembershipSnapshot }>(db, joinRequest.member.nodeId, parsed.invitation.body.manager.nodeId, joinRequest.clusterId, "/api/cluster/v2/membership/redeem", { request: joinRequest, secret: parsed.secret });
  db.exec("SAVEPOINT cluster_v2_finish_join");
  try {
    applyMembershipSnapshot(db, joinRequest.member.nodeId, result.snapshot);
    db.prepare("INSERT INTO cluster_v2_join_results VALUES(?,?,?,?,?)").run(requestId, joinRequest.invitationId, joinRequest.clusterId, hash, JSON.stringify(result.snapshot));
    db.prepare("DELETE FROM cluster_v2_join_attempts WHERE request_id=?").run(requestId);
    db.exec("RELEASE cluster_v2_finish_join");
    return { snapshot: result.snapshot, created: true };
  } catch (error) { db.exec("ROLLBACK TO cluster_v2_finish_join; RELEASE cluster_v2_finish_join"); throw error; }
}

export function mapV2Error(error: unknown, response: Response, next: NextFunction): void {
  if (error instanceof z.ZodError) { sendError(response, 400, "Invalid cluster request"); return; }
  if (error instanceof ClusterProtocolError) { sendError(response, 401, "Unauthorized"); return; }
  if (error instanceof ClusterV2HttpError) { sendError(response, error.statusCode, error.message); return; }
  if (!(error instanceof Error)) { next(error); return; }
  const message = error.message;
  if (/expired|already used/i.test(message)) { sendError(response, 410, message); return; }
  if (/invalid .*?(secret|proof|fingerprint|signature)/i.test(message)) { sendError(response, 401, "Unauthorized"); return; }
  if (/Unknown manager transfer/i.test(message)) { sendError(response, 404, "Unknown manager transfer"); return; }
  if (/Unknown (cluster|membership snapshot)/i.test(message)) { sendError(response, 404, "Unknown cluster"); return; }
  if (/older|not a member|permission|Only (the named successor|the current manager|an older)/i.test(message)) { sendError(response, 403, "Forbidden"); return; }
  if (/authority|pending|conflict|limit|at most|transfer|Already active|active member|requires migration/i.test(message)) { sendError(response, 409, message); return; }
  next(error);
}

export async function redeemV2Membership(request: Request, response: Response, next: NextFunction): Promise<void> {
  try {
    if (!await selectiveSharingActive()) throw new ClusterV2HttpError(409, "Selective sharing is not active");
    const payload = redeemSchema.parse(request.body);
    const raw = clusterRequestRawBody(request);
    const local = await getClusterNode();
    const db = await clusterV2Database();
    ensureV2HttpSchema(db);
    db.exec("SAVEPOINT cluster_v2_bootstrap");
    try {
      pinClusterPublicKey(db, payload.request.member.nodeId, payload.request.member.publicKey);
      const sender = verifyClusterRequest(db, local.id, request.method, request.originalUrl, raw, request.header("authorization"));
      if (sender !== payload.request.member.nodeId) throw new ClusterProtocolError("Invalid cluster request");
      const snapshot = redeemMembershipInvitation(db, local.id, payload.request as MembershipJoinRequest, payload.secret);
      db.exec("RELEASE cluster_v2_bootstrap");
      response.status(201).json({ snapshot });
    } catch (error) { db.exec("ROLLBACK TO cluster_v2_bootstrap; RELEASE cluster_v2_bootstrap"); throw error; }
  } catch (error) { mapV2Error(error, response, next); }
}

let flushing = false;
export async function flushV2MembershipOutbox(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const db = await clusterV2Database();
    const local = await getClusterNode();
    const deliveries = listMembershipDeliveries(db);
    const latest = new Map<string, (typeof deliveries)[number]>();
    for (const delivery of deliveries) latest.set(`${delivery.clusterId}:${delivery.peerId}`, delivery);
    for (const delivery of latest.values()) {
      const pendingCertificate = db.prepare(`SELECT 1 FROM cluster_v2_manager_deliveries
        WHERE cluster_id=? AND peer_id=? LIMIT 1`).get(delivery.clusterId, delivery.peerId);
      if (pendingCertificate) continue;
      try {
        const target = "/api/cluster/v2/membership/snapshot";
        const body = Buffer.from(JSON.stringify({ snapshot: delivery.snapshot }));
        const response = await fetch(new URL(target, delivery.url), {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), body,
          headers: { "Content-Type": "application/json", Authorization: signClusterRequest(db, local.id, delivery.peerId, "POST", target, body) },
        });
        if (!response.ok) throw new ClusterV2HttpError(response.status, "Membership delivery rejected");
        for (const pending of deliveries) {
          if (pending.clusterId === delivery.clusterId && pending.peerId === delivery.peerId && pending.revision <= delivery.revision) {
            acknowledgeMembershipDelivery(db, pending.clusterId, pending.peerId, pending.revision);
          }
        }
      } catch (error) {
        const status = error instanceof ClusterV2HttpError ? error.statusCode : 500;
        console.warn(`V2 membership delivery to ${delivery.peerId} failed (${status})`);
      }
    }
  } finally { flushing = false; }
}

export function clusterManager(db: DatabaseSync, clusterId: string): string {
  const manager = getSharingCluster(db, clusterId).managerNodeId;
  if (!manager) throw new ClusterV2HttpError(409, "Cluster is closed");
  return manager;
}
