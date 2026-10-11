/**
 * Sign-in records for the nodes a user may sign in to.
 *
 * A home node sends every peer one signed snapshot: the local accounts allowed to sign in
 * there. The request signature proves the sender, so the sender is the home node of every
 * account in it. A snapshot replaces the previous one, which is how a removed account, a
 * block or a left cluster takes the copies away again. MFA secrets are encrypted with the
 * home node's key and never travel; a peer only learns that a second factor is required.
 */
import { adminAccountId } from "./ownership.js";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { deleteReplicatedUser, listReplicatedUsers, localAccountsForReplication, upsertReplicatedUser } from "./auth.js";
import { isNodeBlocked } from "./node-blocks.js";
import { accountClusterIds } from "./cluster-accounts.js";
import { isTrustedTwin, listSharingClusterMembers, listSharingMemberships } from "./cluster-sharing-policy.js";
import { accountIdFor } from "./accounts.js";
import { pinnedClusterPublicKey, verifyClusterMessage } from "./cluster-identity.js";
import { clusterV2Database } from "./cluster-v2-store.js";
import { getClusterNode } from "./cluster.js";

const hex = z.string().regex(/^[0-9a-f]+$/i).max(256);
const accountSchema = z.object({
  accountId: z.string().regex(/^[0-9a-f]{32}$/),
  username: z.string().min(1).max(80),
  email: z.string().max(254).nullable(),
  passwordHash: hex,
  passwordSalt: hex,
  mfaRequired: z.boolean(),
  updatedAt: z.string().max(40),
  clusterIds: z.array(z.string().uuid()).max(200),
}).strict();

export const accountSnapshotSchema = z.object({
  version: z.literal(2),
  accounts: z.array(accountSchema).max(1000),
}).strict();

export type AccountSnapshot = z.infer<typeof accountSnapshotSchema>;

export function ensureAccountReplicationSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS account_replication_deliveries (peer_id TEXT PRIMARY KEY, digest TEXT NOT NULL, delivered_at TEXT NOT NULL);
    DROP TABLE IF EXISTS cluster_v2_user_replication_outbox;`);
}

/**
 * The local accounts allowed to sign in on `peer`: on a twin, everyone (it's the same node);
 * elsewhere, each person who joined a cluster the peer is in, with those clusters named.
 */
export function accountSnapshotFor(db: DatabaseSync, local: string, peer: string): AccountSnapshot {
  if (isNodeBlocked(db, local, peer)) return { version: 2, accounts: [] };
  const twin = isTrustedTwin(db, local, peer), admin = adminAccountId(db);
  const shared = listSharingMemberships(db, local).map((membership) => membership.clusterId)
    .filter((clusterId) => listSharingClusterMembers(db, clusterId).some((member) => member.nodeId === peer));
  return {
    version: 2,
    accounts: localAccountsForReplication().filter((account) => account.accountId).map((account) => ({ account, clusterIds: accountClusterIds(db, account.accountId, shared) }))
      // A twin is the admin's own second machine: it holds the admin's sign-in record, and a
      // member's only when that member joined a cluster the twin is in, like any other node.
      .filter(({ account, clusterIds }) => (twin && account.accountId === admin) || clusterIds.length).map(({ account, clusterIds }) => ({
      accountId: account.accountId,
      username: account.username,
      email: account.email,
      passwordHash: account.passwordHash.toString("hex"),
      passwordSalt: account.passwordSalt.toString("hex"),
      mfaRequired: account.mfaEnabled,
      updatedAt: account.updatedAt,
      clusterIds,
    })),
  };
}

export function snapshotDigest(snapshot: AccountSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

/** Peers whose copy is missing or stale. A delivered snapshot is re-sent after six hours,
    which heals a peer that lost its copy. */
export function accountSnapshotsDue(db: DatabaseSync, local: string, peers: string[], now = Date.now()): Array<{ peer: string; snapshot: AccountSnapshot; digest: string }> {
  ensureAccountReplicationSchema(db);
  const due: Array<{ peer: string; snapshot: AccountSnapshot; digest: string }> = [];
  for (const peer of peers) {
    const snapshot = accountSnapshotFor(db, local, peer);
    const digest = snapshotDigest(snapshot);
    const delivered = db.prepare("SELECT digest, delivered_at FROM account_replication_deliveries WHERE peer_id = ?").get(peer) as { digest: string; delivered_at: string } | undefined;
    // `now = 0` asks only whether the current snapshot was delivered at all.
    if (delivered?.digest === digest && (now === 0 || now - Date.parse(delivered.delivered_at) < 6 * 60 * 60_000)) continue;
    due.push({ peer, snapshot, digest });
  }
  return due;
}

export function recordAccountSnapshotDelivered(db: DatabaseSync, peer: string, digest: string, now = new Date().toISOString()): void {
  ensureAccountReplicationSchema(db);
  db.prepare("INSERT INTO account_replication_deliveries (peer_id, digest, delivered_at) VALUES (?, ?, ?) ON CONFLICT(peer_id) DO UPDATE SET digest = excluded.digest, delivered_at = excluded.delivered_at").run(peer, digest, now);
}

/** Applies `sender`'s snapshot: its accounts are created or updated, and its accounts
    missing from the snapshot are removed with their sessions. A rejected account (its
    username or email belongs to someone else here) is skipped, not fatal. */
export function applyAccountSnapshot(db: DatabaseSync, local: string, sender: string, input: unknown): { applied: string[]; rejected: string[] } {
  const snapshot = accountSnapshotSchema.parse(input);
  if (isNodeBlocked(db, local, sender)) { removeReplicatedUsersFromNode(sender); return { applied: [], rejected: snapshot.accounts.map((account) => account.username) }; }
  const applied: string[] = [], rejected: string[] = [];
  // A person may sign in here through clusters both nodes are really in, whatever is stated.
  const twin = isTrustedTwin(db, local, sender);
  const shared = new Set(listSharingMemberships(db, local).map((membership) => membership.clusterId)
    .filter((clusterId) => listSharingClusterMembers(db, clusterId).some((member) => member.nodeId === sender)));
  for (const stated of snapshot.accounts) {
    const account = { ...stated, clusterIds: stated.clusterIds.filter((clusterId) => shared.has(clusterId)) };
    if (!twin && !account.clusterIds.length) continue; // Not kept: their record here is removed below.
    try {
      upsertReplicatedUser({
        username: account.username,
        email: account.email,
        passwordHash: Buffer.from(account.passwordHash, "hex"),
        passwordSalt: Buffer.from(account.passwordSalt, "hex"),
        homeNodeId: sender,
        accountId: account.accountId,
        mfaRequired: account.mfaRequired,
        clusterIds: account.clusterIds,
      });
      applied.push(account.username.toLowerCase());
    } catch (error) {
      rejected.push(account.username);
      console.warn(`Replicated account ${account.username} from ${sender} was rejected: ${error instanceof Error ? error.message : "invalid"}`);
    }
  }
  const keep = new Set(applied);
  for (const user of listReplicatedUsers()) {
    if (user.homeNodeId === sender && !keep.has(user.username.toLowerCase()) && !rejected.some((name) => name.toLowerCase() === user.username.toLowerCase())) deleteReplicatedUser(sender, user.username);
  }
  return { applied, rejected };
}

/** Removes every replicated account whose home is `homeNodeId`. */
export function removeReplicatedUsersFromNode(homeNodeId: string): void {
  for (const user of listReplicatedUsers()) if (user.homeNodeId === homeNodeId) deleteReplicatedUser(homeNodeId, user.username);
}

/** The one home user an older release sends, signed by its home node. Newer nodes send
    accounts instead (applyAccountSnapshot); until every peer has upgraded, this keeps the old
    ones' home users working, as a member of each cluster both nodes share. */
const legacyUserPayloadSchema = z.object({
  username: z.string().min(1).max(80),
  passwordHash: hex,
  passwordSalt: hex,
  homeNodeId: z.string().uuid(),
  mfaSecretEncrypted: z.string().nullable(),
  mfaLastUsedStep: z.number().int().min(0),
  mfaRecoveryCodes: z.array(z.string()),
  updatedAt: z.string(),
}).strict();
const signedLegacyUserSchema = z.object({ body: legacyUserPayloadSchema, signerNodeId: z.string().uuid(), signature: z.string() }).strict();

export async function applyUserReplication(input: unknown): Promise<void> {
  const signed = signedLegacyUserSchema.parse(input);
  const db = await clusterV2Database(), local = await getClusterNode();
  const publicKey = pinnedClusterPublicKey(db, signed.signerNodeId);
  if (!publicKey) throw new Error("Unknown sender node");
  if (!verifyClusterMessage(publicKey, "user-replication", JSON.stringify(signed.body), signed.signature)) throw new Error("Invalid user replication signature");
  if (signed.body.homeNodeId !== signed.signerNodeId) throw new Error("User replication must be signed by the home node");
  const shared = listSharingMemberships(db, local.id).map((membership) => membership.clusterId)
    .filter((clusterId) => listSharingClusterMembers(db, clusterId).some((member) => member.nodeId === signed.signerNodeId));
  upsertReplicatedUser({
    username: signed.body.username,
    email: null,
    passwordHash: Buffer.from(signed.body.passwordHash, "hex"),
    passwordSalt: Buffer.from(signed.body.passwordSalt, "hex"),
    homeNodeId: signed.body.homeNodeId,
    accountId: accountIdFor(signed.body.homeNodeId, signed.body.username),
    mfaRequired: signed.body.mfaSecretEncrypted !== null,
    clusterIds: shared,
  });
}
