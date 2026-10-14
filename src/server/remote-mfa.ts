import { z } from "zod";
import { AuthError, listLocalUsers, visitorClusterIds, verifyAccountMfa, type VerifyRemoteMfa } from "../auth.js";
import { getClusterNode } from "../cluster.js";
import { isTrustedTwin, listSharingMemberships, listSharingClusterMembers } from "../cluster-sharing-policy.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { accountSnapshotFor } from "../user-replication.js";
import { replicationPeers, signedPeerPost } from "./replication-v2.js";

export const remoteMfaSchema = z.object({
  accountId: z.string().regex(/^[0-9a-f]{32}$/),
  proof: z.string().regex(/^[0-9a-f]{64}$/),
  code: z.string().trim().min(1).max(64),
}).strict();

/** Only an eligible, signed peer with password proof can ask home to consume a factor. */
export async function receiveRemoteMfa(sender: string, input: unknown): Promise<void> {
  const { accountId, proof, code } = remoteMfaSchema.parse(input);
  const db = await clusterV2Database(), local = await getClusterNode();
  if (!replicationPeers(db, local.id).some(peer => peer.nodeId === sender)
    || !accountSnapshotFor(db, local.id, sender).accounts.some(account => account.accountId === accountId)) {
    throw new AuthError(403, "Sign-in is not available on this node");
  }
  const user = listLocalUsers().find(user => user.accountId === accountId && !user.disabled);
  if (!user) throw new AuthError(403, "Sign-in is not available on this node");
  verifyAccountMfa(user.userId, proof, code);
}

/** Local membership and opt-outs still apply when home cannot answer. */
export async function authorizeRemoteSignIn(homeNodeId: string, accountId: string): Promise<void> {
  const db = await clusterV2Database(), local = await getClusterNode();
  const allowedClusters = new Set(visitorClusterIds(accountId));
  const allowed = isTrustedTwin(db, local.id, homeNodeId) || listSharingMemberships(db, local.id).some(membership =>
    allowedClusters.has(membership.clusterId) && listSharingClusterMembers(db, membership.clusterId).some(member => member.nodeId === homeNodeId));
  if (!allowed || !replicationPeers(db, local.id).some(peer => peer.nodeId === homeNodeId)) throw new AuthError(403, "Sign-in is not available on this node");
}

export const verifyRemoteMfa: VerifyRemoteMfa = async (homeNodeId, accountId, proof, code) => {
  const db = await clusterV2Database(), local = await getClusterNode();
  const peer = replicationPeers(db, local.id).find(peer => peer.nodeId === homeNodeId);
  if (!peer) throw new AuthError(403, "Sign-in is not available on this node");
  try {
    const reply = await signedPeerPost(peer, "/api/cluster/v2/accounts/mfa", { accountId, proof, code });
    if (!reply || typeof reply !== "object" || !("verified" in reply) || reply.verified !== true) throw new Error("Invalid MFA response");
  } catch (error) {
    if (error instanceof ClusterV2HttpError) {
      if (error.statusCode === 429) throw new AuthError(429, "Too many MFA attempts. Try again in 15 minutes");
      if (error.statusCode === 401) throw new AuthError(401, "Invalid or already used code. Use a fresh authenticator code or an unused recovery code");
      if (error.statusCode === 403) throw new AuthError(403, "Sign-in is not available on this node");
    }
    throw new AuthError(503, "Your home node must be online and updated to verify this code. Use an authenticator code if MFA has synced here; recovery codes always need home online");
  }
  // A block or membership change while home answered must not create a session.
  if (!replicationPeers(db, local.id).some(peer => peer.nodeId === homeNodeId)) throw new AuthError(403, "Sign-in is not available on this node");
};
