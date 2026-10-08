import { z } from "zod";
import { deleteReplicatedUser, getHomeUserForReplication, upsertReplicatedUser } from "./auth.js";
import { getClusterNode } from "./cluster.js";
import { listSharingClusterMembers } from "./cluster-sharing-policy.js";
import { signClusterMessage, verifyClusterMessage, pinnedClusterPublicKey } from "./cluster-identity.js";
import { clusterV2Database } from "./cluster-v2-store.js";
const userReplicationPayloadSchema = z.object({
  username: z.string().min(1).max(80),
  passwordHash: z.string().regex(/^[0-9a-f]+$/i),
  passwordSalt: z.string().regex(/^[0-9a-f]+$/i),
  homeNodeId: z.string().uuid(),
  mfaSecretEncrypted: z.string().nullable(),
  mfaLastUsedStep: z.number().int().min(0),
  mfaRecoveryCodes: z.array(z.string()),
  updatedAt: z.string()
}).strict();
const signedUserReplicationSchema = z.object({
  body: userReplicationPayloadSchema,
  signerNodeId: z.string().uuid(),
  signature: z.string()
}).strict();
function ensureUserReplicationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cluster_v2_user_replication (
      home_node_id TEXT NOT NULL,
      username TEXT NOT NULL,
      last_received_at TEXT NOT NULL,
      PRIMARY KEY (home_node_id, username)
    );
    CREATE TABLE IF NOT EXISTS cluster_v2_user_replication_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cluster_id TEXT NOT NULL,
      peer_node_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cluster_v2_user_replication_outbox_peer
      ON cluster_v2_user_replication_outbox(cluster_id, peer_node_id);
  `);
}
async function prepareUserReplicationPayload() {
  const node = await getClusterNode();
  const db = await clusterV2Database();
  const user = getHomeUserForReplication();
  if (!user) return null;
  const body = {
    username: user.username,
    passwordHash: user.passwordHash.toString("hex"),
    passwordSalt: user.passwordSalt.toString("hex"),
    homeNodeId: node.id,
    mfaSecretEncrypted: user.mfaSecretEncrypted,
    mfaLastUsedStep: user.mfaLastUsedStep,
    mfaRecoveryCodes: user.mfaRecoveryCodes,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const signature = signClusterMessage(db, node.id, "user-replication", JSON.stringify(body));
  return { body, signerNodeId: node.id, signature };
}
async function applyUserReplication(input) {
  const signed = signedUserReplicationSchema.parse(input);
  const db = await clusterV2Database();
  const publicKey = pinnedClusterPublicKey(db, signed.signerNodeId);
  if (!publicKey) throw new Error("Unknown sender node");
  if (!verifyClusterMessage(publicKey, "user-replication", JSON.stringify(signed.body), signed.signature)) {
    throw new Error("Invalid user replication signature");
  }
  if (signed.body.homeNodeId !== signed.signerNodeId) {
    throw new Error("User replication must be signed by the home node");
  }
  upsertReplicatedUser({
    username: signed.body.username,
    passwordHash: Buffer.from(signed.body.passwordHash, "hex"),
    passwordSalt: Buffer.from(signed.body.passwordSalt, "hex"),
    homeNodeId: signed.body.homeNodeId,
    mfaSecretEncrypted: signed.body.mfaSecretEncrypted,
    mfaLastUsedStep: signed.body.mfaLastUsedStep,
    mfaRecoveryCodes: signed.body.mfaRecoveryCodes
  });
  ensureUserReplicationSchema(db);
  db.prepare(`
    INSERT INTO cluster_v2_user_replication (home_node_id, username, last_received_at)
    VALUES (?, ?, ?)
    ON CONFLICT(home_node_id, username) DO UPDATE SET last_received_at = excluded.last_received_at
  `).run(signed.body.homeNodeId, signed.body.username, (/* @__PURE__ */ new Date()).toISOString());
}
async function queueUserReplicationToClusterPeers() {
  const node = await getClusterNode();
  const db = await clusterV2Database();
  ensureUserReplicationSchema(db);
  const payload = await prepareUserReplicationPayload();
  if (!payload) return;
  const clusterIds = db.prepare("SELECT DISTINCT cluster_id FROM sharing_memberships WHERE node_id = ?").all(node.id).map((row) => row.cluster_id);
  for (const clusterId of clusterIds) {
    const members = listSharingClusterMembers(db, clusterId);
    for (const member of members) {
      if (member.nodeId === node.id) continue;
      db.prepare(`
        INSERT INTO cluster_v2_user_replication_outbox (cluster_id, peer_node_id, payload, created_at)
        VALUES (?, ?, ?, ?)
      `).run(clusterId, member.nodeId, JSON.stringify(payload), (/* @__PURE__ */ new Date()).toISOString());
    }
  }
}
async function getPendingUserReplications(peerId) {
  const db = await clusterV2Database();
  ensureUserReplicationSchema(db);
  const rows = db.prepare(`
    SELECT id, payload FROM cluster_v2_user_replication_outbox
    WHERE peer_node_id = ? ORDER BY id LIMIT 10
  `).all(peerId);
  return rows.map((row) => ({
    id: row.id,
    payload: signedUserReplicationSchema.parse(JSON.parse(row.payload))
  }));
}
async function acknowledgeUserReplication(ids) {
  if (!ids.length) return;
  const db = await clusterV2Database();
  ensureUserReplicationSchema(db);
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`DELETE FROM cluster_v2_user_replication_outbox WHERE id IN (${placeholders})`).run(...ids);
}
async function removeReplicatedUsersFromNode(homeNodeId) {
  const db = await clusterV2Database();
  ensureUserReplicationSchema(db);
  const users = db.prepare("SELECT username FROM cluster_v2_user_replication WHERE home_node_id = ?").all(homeNodeId);
  for (const user of users) {
    deleteReplicatedUser(homeNodeId, user.username);
  }
  db.prepare("DELETE FROM cluster_v2_user_replication WHERE home_node_id = ?").run(homeNodeId);
}
export {
  acknowledgeUserReplication,
  applyUserReplication,
  ensureUserReplicationSchema,
  getPendingUserReplications,
  prepareUserReplicationPayload,
  queueUserReplicationToClusterPeers,
  removeReplicatedUsersFromNode
};
