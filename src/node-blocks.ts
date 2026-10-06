import type { DatabaseSync } from "node:sqlite";

/**
 * A node's admin can refuse another node outright. A block works both ways: this node
 * neither accepts nor sends anything to the blocked node, and it tells every cluster
 * member, so hubs stop relaying between the pair and the blocked node stops sending.
 * Cluster membership administration still flows (it carries no user data), so the
 * cluster stays consistent for everyone else.
 */
export function ensureNodeBlockSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS node_blocks (node_id TEXT PRIMARY KEY, node_name TEXT NOT NULL, blocked_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS node_block_notices (blocker_node_id TEXT NOT NULL, blocked_node_id TEXT NOT NULL, blocked INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (blocker_node_id, blocked_node_id));
    CREATE TABLE IF NOT EXISTS node_block_deliveries (peer_id TEXT NOT NULL, blocked_node_id TEXT NOT NULL, blocked INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (peer_id, blocked_node_id));`);
}

export interface NodeBlock { nodeId: string; nodeName: string; blockedAt: string }

export function listNodeBlocks(db: DatabaseSync): NodeBlock[] {
  ensureNodeBlockSchema(db);
  return (db.prepare("SELECT node_id, node_name, blocked_at FROM node_blocks ORDER BY blocked_at").all() as unknown as Array<{ node_id: string; node_name: string; blocked_at: string }>)
    .map((row) => ({ nodeId: row.node_id, nodeName: row.node_name, blockedAt: row.blocked_at }));
}

/** True when this node blocks `nodeId`, or has been told `nodeId` blocks it. */
export function isNodeBlocked(db: DatabaseSync, local: string, nodeId: string): boolean {
  return nodesBlockedBetween(db, local, nodeId);
}

/** True when either node blocks the other, as far as this node knows. */
export function nodesBlockedBetween(db: DatabaseSync, local: string, left: string, right?: string): boolean {
  ensureNodeBlockSchema(db);
  const [a, b] = right === undefined ? [local, left] : [left, right];
  if (a === b) return false;
  const blocksHere = (other: string) => db.prepare("SELECT 1 FROM node_blocks WHERE node_id = ?").get(other) !== undefined;
  if (a === local && blocksHere(b)) return true;
  if (b === local && blocksHere(a)) return true;
  return db.prepare("SELECT 1 FROM node_block_notices WHERE blocked = 1 AND ((blocker_node_id = ? AND blocked_node_id = ?) OR (blocker_node_id = ? AND blocked_node_id = ?))").get(a, b, b, a) !== undefined;
}

/** Records the block and queues a notice for every peer that should hear about it. */
export function setNodeBlock(db: DatabaseSync, nodeId: string, nodeName: string, blocked: boolean, peers: string[], now = new Date().toISOString()): void {
  ensureNodeBlockSchema(db);
  if (blocked) db.prepare("INSERT INTO node_blocks (node_id, node_name, blocked_at) VALUES (?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET node_name = excluded.node_name").run(nodeId, nodeName, now);
  else db.prepare("DELETE FROM node_blocks WHERE node_id = ?").run(nodeId);
  const queue = db.prepare("INSERT INTO node_block_deliveries (peer_id, blocked_node_id, blocked, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(peer_id, blocked_node_id) DO UPDATE SET blocked = excluded.blocked, updated_at = excluded.updated_at");
  for (const peer of new Set([...peers, nodeId])) queue.run(peer, nodeId, blocked ? 1 : 0, now);
}

export function pendingBlockNotices(db: DatabaseSync): Array<{ peerId: string; blockedNodeId: string; blocked: boolean; updatedAt: string }> {
  ensureNodeBlockSchema(db);
  return (db.prepare("SELECT peer_id, blocked_node_id, blocked, updated_at FROM node_block_deliveries ORDER BY updated_at").all() as unknown as Array<{ peer_id: string; blocked_node_id: string; blocked: number; updated_at: string }>)
    .map((row) => ({ peerId: row.peer_id, blockedNodeId: row.blocked_node_id, blocked: row.blocked === 1, updatedAt: row.updated_at }));
}

export function recordBlockNoticeDelivered(db: DatabaseSync, peerId: string, blockedNodeId: string, updatedAt: string): void {
  db.prepare("DELETE FROM node_block_deliveries WHERE peer_id = ? AND blocked_node_id = ? AND updated_at = ?").run(peerId, blockedNodeId, updatedAt);
}

/** Applies a notice from `blocker`. Older notices never undo newer ones. */
export function applyBlockNotice(db: DatabaseSync, blocker: string, blockedNodeId: string, blocked: boolean, updatedAt: string): boolean {
  ensureNodeBlockSchema(db);
  const current = db.prepare("SELECT updated_at FROM node_block_notices WHERE blocker_node_id = ? AND blocked_node_id = ?").get(blocker, blockedNodeId) as { updated_at: string } | undefined;
  if (current && current.updated_at >= updatedAt) return false;
  db.prepare("INSERT INTO node_block_notices (blocker_node_id, blocked_node_id, blocked, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(blocker_node_id, blocked_node_id) DO UPDATE SET blocked = excluded.blocked, updated_at = excluded.updated_at")
    .run(blocker, blockedNodeId, blocked ? 1 : 0, updatedAt);
  return true;
}

/** Signed routes a blocked node may still use: membership administration and block notices. */
const ADMINISTRATION_PATHS = [
  "/api/cluster/v2/membership/",
  "/api/cluster/v2/manager-transfer/",
  "/api/cluster/v2/succession",
  "/api/cluster/v2/blocks/notice",
];

export function isAdministrationPath(pathname: string): boolean {
  const path = pathname.split("?", 1)[0].toLowerCase();
  return ADMINISTRATION_PATHS.some((prefix) => prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix);
}
