import type { DatabaseSync } from "node:sqlite";
import { adminAccountId } from "./ownership.js";

/**
 * Which local people joined each cluster. The node is a member while at least one is. A
 * cluster with no rows was joined before people joined clusters themselves: it is the
 * admin's.
 */
export function ensureClusterAccountSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_local_members (cluster_id TEXT NOT NULL, account_id TEXT NOT NULL, joined_at TEXT NOT NULL, PRIMARY KEY (cluster_id, account_id));
    CREATE INDEX IF NOT EXISTS cluster_local_members_account ON cluster_local_members(account_id);`);
}

export function clusterLocalMembers(db: DatabaseSync, clusterId: string): string[] {
  ensureClusterAccountSchema(db);
  const rows = (db.prepare("SELECT account_id FROM cluster_local_members WHERE cluster_id = ? ORDER BY joined_at").all(clusterId) as unknown as Array<{ account_id: string }>).map((row) => row.account_id);
  if (rows.length) return rows;
  const admin = adminAccountId(db);
  return admin ? [admin] : [];
}

export function accountInCluster(db: DatabaseSync, accountId: string, clusterId: string): boolean {
  return clusterLocalMembers(db, clusterId).includes(accountId);
}

/** Records that `accountId` joined. The first explicit join of a cluster the node was
    already in keeps the admin's implicit membership. */
export function addClusterLocalMember(db: DatabaseSync, clusterId: string, accountId: string, now = new Date().toISOString()): void {
  ensureClusterAccountSchema(db);
  const existing = db.prepare("SELECT COUNT(*) AS count FROM cluster_local_members WHERE cluster_id = ?").get(clusterId) as { count: number };
  const nodeAlreadyMember = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sharing_memberships'").get()
    && db.prepare("SELECT 1 FROM sharing_memberships m JOIN cluster_node n ON n.id = m.node_id WHERE m.cluster_id = ?").get(clusterId);
  const insert = db.prepare("INSERT OR IGNORE INTO cluster_local_members (cluster_id, account_id, joined_at) VALUES (?, ?, ?)");
  if (!existing.count && nodeAlreadyMember) { const admin = adminAccountId(db); if (admin && admin !== accountId) insert.run(clusterId, admin, now); }
  insert.run(clusterId, accountId, now);
}

/** Returns how many local people are still in the cluster after `accountId` leaves. */
export function removeClusterLocalMember(db: DatabaseSync, clusterId: string, accountId: string): number {
  ensureClusterAccountSchema(db);
  const members = clusterLocalMembers(db, clusterId);
  if (!db.prepare("SELECT 1 FROM cluster_local_members WHERE cluster_id = ?").get(clusterId) && members.includes(accountId)) return 0;
  db.prepare("DELETE FROM cluster_local_members WHERE cluster_id = ? AND account_id = ?").run(clusterId, accountId);
  return (db.prepare("SELECT COUNT(*) AS count FROM cluster_local_members WHERE cluster_id = ?").get(clusterId) as { count: number }).count;
}

export function forgetCluster(db: DatabaseSync, clusterId: string): void {
  ensureClusterAccountSchema(db);
  db.prepare("DELETE FROM cluster_local_members WHERE cluster_id = ?").run(clusterId);
}

export function accountClusterIds(db: DatabaseSync, accountId: string, nodeClusterIds: string[]): string[] {
  return nodeClusterIds.filter((clusterId) => accountInCluster(db, accountId, clusterId));
}
