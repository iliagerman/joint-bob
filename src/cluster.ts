import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appendAuditEvent, ensureAuditSchema } from "./audit.js";
import { resolveDataDirectory } from "./data-directory.js";

export interface ClusterNode {
  id: string;
  name: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  /** The node whose invitation this node joined under; null for a root node or a legacy pairing. */
  invitedByNodeId: string | null;
}

export interface ClusterPeer extends ClusterNode {
  token: string;
  pairedAt: string;
  lastSeenAt: string | null;
}

export interface ClusterMembershipMember extends ClusterNode {
  token: string;
}

export interface ClusterMemberTombstone {
  id: string;
  removedAt: string;
  originNodeId: string;
}

/** The exact set of projects a node may see. A node with no grant row is unrestricted
    (legacy pairings and pre-selection clusters); a grant row always holds the full,
    invitation-frozen selection. */
export interface ClusterProjectGrant {
  nodeId: string;
  projectIds: string[];
  updatedAt: string;
  originNodeId: string;
}

export interface ClusterMembershipSnapshot {
  members: ClusterMembershipMember[];
  removed?: ClusterMemberTombstone[];
  projectGrants?: ClusterProjectGrant[];
}

export interface MembershipDelivery {
  peerId: string;
  generation: number;
  attempts: number;
}

export interface ClusterInvitation {
  id: string;
  secret: string;
  projectIds: string[];
}

export type ClusterInvitationResult = "accepted" | "expired" | "invalid" | "retry" | "used";

interface ClusterStore {
  node: ClusterNode;
  peers: ClusterPeer[];
}

interface NodeRow {
  id: string;
  name: string;
  url: string;
  created_at: string;
  updated_at: string;
  invited_by_node_id: string | null;
}

interface PeerRow extends NodeRow {
  token: string;
  paired_at: string;
  last_seen_at: string | null;
}

interface TombstoneRow {
  id: string;
  removed_at: string;
  origin_node_id: string;
}

interface ProjectGrantRow {
  node_id: string;
  project_ids: string;
  updated_at: string;
  origin_node_id: string;
}

const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
const legacyStorePath = path.join(dataDir, "cluster.json");
const keyPath = path.join(dataDir, "secret.key");
const clusterInvitationLifetimeMs = 15 * 60 * 1000;
let databasePromise: Promise<DatabaseSync> | undefined;

function encryptionKey(): Buffer {
  const configured = process.env.JOINT_BOB_SECRET_KEY ?? process.env.MASTER_BOB_SECRET_KEY;
  if (configured) {
    const key = Buffer.from(configured, "base64");
    if (key.length !== 32) throw new Error("JOINT_BOB_SECRET_KEY must be a base64-encoded 32-byte key");
    return key;
  }
  try {
    const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error("Joint Bob secret key is invalid");
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const key = randomBytes(32);
    writeFileSync(keyPath, key.toString("base64"), { mode: 0o600 });
    return key;
  }
}

function encryptToken(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${encrypted.toString("base64")}`;
}

function decryptToken(value: string): string {
  const [iv, tag, encrypted] = value.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Stored cluster credential is invalid");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}

function defaultNode(): ClusterNode {
  const now = new Date().toISOString();
  return { id: randomUUID(), name: os.hostname(), url: (process.env.JOINT_BOB_NODE_URL ?? process.env.PI_MOBILE_WEB_NODE_URL)?.trim() ?? "", createdAt: now, updatedAt: now, invitedByNodeId: null };
}

function nodeFromRow(row: NodeRow): ClusterNode {
  return { id: row.id, name: row.name, url: row.url, createdAt: row.created_at, updatedAt: row.updated_at, invitedByNodeId: row.invited_by_node_id ?? null };
}

const PEER_COLUMNS = "id, name, url, token, paired_at, last_seen_at, created_at, updated_at, invited_by_node_id";

function peerFromRow(row: PeerRow): ClusterPeer {
  return { ...nodeFromRow(row), token: decryptToken(row.token), pairedAt: row.paired_at, lastSeenAt: row.last_seen_at };
}

function createMachineCredential(db: DatabaseSync): void {
  db.prepare(`
    INSERT OR IGNORE INTO cluster_machine_credentials (singleton, token, created_at)
    VALUES (1, ?, ?)
  `).run(encryptToken(randomBytes(32).toString("base64url")), new Date().toISOString());
}

function rotateMachineCredential(db: DatabaseSync): void {
  db.prepare("UPDATE cluster_machine_credentials SET token = ?, created_at = ? WHERE singleton = 1")
    .run(encryptToken(randomBytes(32).toString("base64url")), new Date().toISOString());
}

function nextVersionTimestamp(...versions: string[]): string {
  const parsedVersions = versions.map((version) => {
    const timestamp = Date.parse(version);
    if (Number.isNaN(timestamp)) throw new Error("Stored cluster node version is invalid");
    return timestamp;
  });
  return new Date(Math.max(Date.now(), ...parsedVersions.map((timestamp) => timestamp + 1))).toISOString();
}

function rotateLocalMachineCredential(db: DatabaseSync, localNode: ClusterNode, ...versionFloors: string[]): ClusterNode {
  const updatedAt = nextVersionTimestamp(localNode.updatedAt, ...versionFloors);
  rotateMachineCredential(db);
  db.prepare("UPDATE cluster_node SET updated_at = ? WHERE singleton = 1").run(updatedAt);
  return { ...localNode, updatedAt };
}

async function legacyStore(): Promise<ClusterStore | undefined> {
  try {
    return JSON.parse(await fs.readFile(legacyStorePath, "utf8")) as ClusterStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function clusterDatabase(): Promise<DatabaseSync> {
  if (databasePromise) return databasePromise;
  databasePromise = (async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS cluster_node (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cluster_peers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        token TEXT NOT NULL,
        paired_at TEXT NOT NULL,
        last_seen_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cluster_secret_migrations (
        version INTEGER PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS cluster_machine_credentials (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        token TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cluster_membership_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        generation INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cluster_membership_deliveries (
        peer_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        next_attempt_at TEXT NOT NULL,
        delivered_at TEXT,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS cluster_member_tombstones (
        id TEXT PRIMARY KEY,
        removed_at TEXT NOT NULL,
        origin_node_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cluster_invitations (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        consumed_by_node_id TEXT
      );
      CREATE TABLE IF NOT EXISTS cluster_project_grants (
        node_id TEXT PRIMARY KEY,
        project_ids TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        origin_node_id TEXT NOT NULL
      );
    `);
    ensureAuditSchema(db);
    db.prepare("INSERT OR IGNORE INTO cluster_membership_state (singleton, generation) VALUES (1, 1)").run();
    db.prepare(`
      INSERT OR IGNORE INTO cluster_membership_deliveries (peer_id, generation, attempts, next_attempt_at, delivered_at, last_error)
      SELECT id, 1, 0, ?, NULL, NULL FROM cluster_peers
    `).run(new Date().toISOString());
    const peerColumns = db.prepare("PRAGMA table_info(cluster_peers)").all() as unknown as Array<{ name: string }>;
    if (!peerColumns.some((column) => column.name === "last_seen_at")) db.exec("ALTER TABLE cluster_peers ADD COLUMN last_seen_at TEXT");
    if (!peerColumns.some((column) => column.name === "invited_by_node_id")) db.exec("ALTER TABLE cluster_peers ADD COLUMN invited_by_node_id TEXT");
    const nodeColumns = db.prepare("PRAGMA table_info(cluster_node)").all() as unknown as Array<{ name: string }>;
    if (!nodeColumns.some((column) => column.name === "invited_by_node_id")) db.exec("ALTER TABLE cluster_node ADD COLUMN invited_by_node_id TEXT");
    const invitationColumns = db.prepare("PRAGMA table_info(cluster_invitations)").all() as unknown as Array<{ name: string }>;
    if (!invitationColumns.some((column) => column.name === "consumed_by_node_id")) db.exec("ALTER TABLE cluster_invitations ADD COLUMN consumed_by_node_id TEXT");
    if (!invitationColumns.some((column) => column.name === "project_ids")) db.exec("ALTER TABLE cluster_invitations ADD COLUMN project_ids TEXT NOT NULL DEFAULT '[]'");
    const current = db.prepare("SELECT COUNT(*) AS count FROM cluster_node").get() as { count: number };
    if (current.count !== 0) {
      if (!db.prepare("SELECT version FROM cluster_secret_migrations WHERE version = 1").get()) {
        const rows = db.prepare("SELECT id, token FROM cluster_peers").all() as unknown as Array<{ id: string; token: string }>;
        db.exec("BEGIN");
        try {
          const update = db.prepare("UPDATE cluster_peers SET token = ? WHERE id = ?");
          for (const row of rows) update.run(encryptToken(row.token), row.id);
          db.prepare("INSERT INTO cluster_secret_migrations (version) VALUES (1)").run();
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      createMachineCredential(db);
      return db;
    }
    const legacy = await legacyStore();
    const store = legacy ?? { node: defaultNode(), peers: [] };
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO cluster_node (singleton, id, name, url, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)")
        .run(store.node.id, store.node.name, store.node.url, store.node.createdAt, store.node.updatedAt);
      const savePeer = db.prepare(`
        INSERT INTO cluster_peers (id, name, url, token, paired_at, last_seen_at, created_at, updated_at, invited_by_node_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const peer of store.peers) savePeer.run(peer.id, peer.name, peer.url, encryptToken(peer.token), peer.pairedAt, peer.lastSeenAt ?? null, peer.createdAt, peer.updatedAt, peer.invitedByNodeId ?? null);
      db.prepare(`
        INSERT OR IGNORE INTO cluster_membership_deliveries (peer_id, generation, attempts, next_attempt_at, delivered_at, last_error)
        SELECT id, 1, 0, ?, NULL, NULL FROM cluster_peers
      `).run(new Date().toISOString());
      db.prepare("INSERT INTO cluster_secret_migrations (version) VALUES (1)").run();
      createMachineCredential(db);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return db;
  })();
  return databasePromise;
}

export async function getClusterMachineToken(): Promise<string> {
  const row = (await clusterDatabase()).prepare("SELECT token FROM cluster_machine_credentials WHERE singleton = 1").get() as { token: string };
  return decryptToken(row.token);
}

function invitationHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function invitationHashMatches(secret: string, expectedHash: string): boolean {
  return timingSafeEqual(Buffer.from(invitationHash(secret), "hex"), Buffer.from(expectedHash, "hex"));
}

export async function createClusterInvitation(projectIds: string[]): Promise<ClusterInvitation> {
  const db = await clusterDatabase();
  const selection = [...new Set(projectIds)];
  if (!selection.length) throw new Error("A cluster invitation must share at least one project");
  const invitation = { id: randomUUID(), secret: randomBytes(32).toString("base64url"), projectIds: selection };
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM cluster_invitations").run();
    db.prepare("INSERT INTO cluster_invitations (id, secret_hash, created_at, consumed_at, consumed_by_node_id, project_ids) VALUES (?, ?, ?, NULL, NULL, ?)")
      .run(invitation.id, invitationHash(invitation.secret), now, JSON.stringify(selection));
    db.exec("COMMIT");
    return invitation;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** The frozen project selection of a consumed invitation, applied to the joining node's grant. */
export async function clusterInvitationProjects(id: string): Promise<string[]> {
  const row = (await clusterDatabase()).prepare("SELECT project_ids FROM cluster_invitations WHERE id = ?").get(id) as { project_ids: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.project_ids) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export async function clusterInvitationStatus(id: string, secret: string, nodeId: string): Promise<ClusterInvitationResult | "active"> {
  const db = await clusterDatabase();
  const row = db.prepare("SELECT secret_hash, created_at, consumed_at, consumed_by_node_id FROM cluster_invitations WHERE id = ?").get(id) as { secret_hash: string; created_at: string; consumed_at: string | null; consumed_by_node_id: string | null } | undefined;
  if (!row || !invitationHashMatches(secret, row.secret_hash)) return "invalid";
  if (row.consumed_at) return row.consumed_by_node_id === nodeId ? "retry" : "used";
  const createdAt = Date.parse(row.created_at);
  if (Number.isNaN(createdAt)) throw new Error("Stored cluster invitation timestamp is invalid");
  return Date.now() - createdAt > clusterInvitationLifetimeMs ? "expired" : "active";
}

export async function consumeClusterInvitation(id: string, secret: string, nodeId: string): Promise<ClusterInvitationResult> {
  const status = await clusterInvitationStatus(id, secret, nodeId);
  if (status !== "active") return status;
  const result = (await clusterDatabase()).prepare("UPDATE cluster_invitations SET consumed_at = ?, consumed_by_node_id = ? WHERE id = ? AND consumed_at IS NULL")
    .run(new Date().toISOString(), nodeId, id);
  if (result.changes === 1) return "accepted";
  const retryStatus = await clusterInvitationStatus(id, secret, nodeId);
  if (retryStatus === "active") throw new Error("Cluster invitation consumption did not persist");
  return retryStatus;
}

export async function getClusterNode(): Promise<ClusterNode> {
  const row = (await clusterDatabase()).prepare("SELECT id, name, url, created_at, updated_at, invited_by_node_id FROM cluster_node WHERE singleton = 1").get() as unknown as NodeRow;
  return nodeFromRow(row);
}

function queueMembershipChange(db: DatabaseSync): void {
  db.prepare("UPDATE cluster_membership_state SET generation = generation + 1 WHERE singleton = 1").run();
  const generation = (db.prepare("SELECT generation FROM cluster_membership_state WHERE singleton = 1").get() as { generation: number }).generation;
  db.prepare(`
    INSERT INTO cluster_membership_deliveries (peer_id, generation, attempts, next_attempt_at, delivered_at, last_error)
    SELECT id, ?, 0, ?, NULL, NULL FROM cluster_peers WHERE true
    ON CONFLICT(peer_id) DO UPDATE SET
      generation = excluded.generation,
      attempts = 0,
      next_attempt_at = excluded.next_attempt_at,
      delivered_at = NULL,
      last_error = NULL
  `).run(generation, new Date().toISOString());
}

export async function updateClusterNode(name: string, url: string): Promise<ClusterNode> {
  const db = await clusterDatabase();
  const normalizedUrl = url.replace(/\/$/, "");
  const node = nodeFromRow(db.prepare("SELECT id, name, url, created_at, updated_at, invited_by_node_id FROM cluster_node WHERE singleton = 1").get() as unknown as NodeRow);
  if (node.name === name && node.url === normalizedUrl) return node;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE cluster_node SET name = ?, url = ?, updated_at = ? WHERE singleton = 1").run(name, normalizedUrl, nextVersionTimestamp(node.updatedAt));
    queueMembershipChange(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getClusterNode();
}

/** Records whose invitation this node joined under, or clears it on leave. Versioned so
    every member learns the relationship, which is what authorises later removals. */
export async function setClusterInviter(invitedByNodeId: string | null): Promise<ClusterNode> {
  const db = await clusterDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const node = nodeFromRow(db.prepare("SELECT id, name, url, created_at, updated_at, invited_by_node_id FROM cluster_node WHERE singleton = 1").get() as unknown as NodeRow);
    if (node.invitedByNodeId === invitedByNodeId) {
      db.exec("COMMIT");
      return node;
    }
    const updatedAt = nextVersionTimestamp(node.updatedAt);
    db.prepare("UPDATE cluster_node SET invited_by_node_id = ?, updated_at = ? WHERE singleton = 1").run(invitedByNodeId, updatedAt);
    queueMembershipChange(db);
    db.exec("COMMIT");
    return { ...node, invitedByNodeId, updatedAt };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function listClusterPeers(): Promise<ClusterPeer[]> {
  const rows = (await clusterDatabase()).prepare(`
    SELECT ${PEER_COLUMNS} FROM cluster_peers ORDER BY name, id
  `).all() as unknown as PeerRow[];
  return rows.map(peerFromRow);
}

export async function getClusterPeer(peerId: string): Promise<ClusterPeer | undefined> {
  const row = (await clusterDatabase()).prepare(`
    SELECT ${PEER_COLUMNS} FROM cluster_peers WHERE id = ?
  `).get(peerId) as PeerRow | undefined;
  return row ? peerFromRow(row) : undefined;
}

function compareVersion(leftAt: string, leftId: string, rightAt: string, rightId: string): number {
  return leftAt === rightAt ? leftId.localeCompare(rightId) : leftAt.localeCompare(rightAt);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).some((entry) => entry.name === column);
}

function assertPeerCanBeRemoved(db: DatabaseSync, peerId: string): void {
  const ownsTask = tableExists(db, "tasks") && db.prepare("SELECT 1 FROM tasks WHERE current_node_id = ?").get(peerId);
  const committedHandoffIsUnsettled = tableHasColumn(db, "task_handoffs", "acknowledged_at")
    ? "status = 'committed' AND acknowledged_at IS NULL"
    : "status = 'committed'";
  const hasUnsettledHandoff = tableExists(db, "task_handoffs") && db.prepare(`
    SELECT 1 FROM task_handoffs
    WHERE (source_node_id = ? OR destination_node_id = ?)
      AND (status IN ('pending', 'prepared') OR ${committedHandoffIsUnsettled})
  `).get(peerId, peerId);
  if (ownsTask || hasUnsettledHandoff) throw new Error(`Transfer owned tasks and settle handoffs before removing cluster member ${peerId}`);
}

function tombstoneFromRow(row: TombstoneRow): ClusterMemberTombstone {
  return { id: row.id, removedAt: row.removed_at, originNodeId: row.origin_node_id };
}

function sameTombstone(left: ClusterMemberTombstone, right: ClusterMemberTombstone): boolean {
  return left.removedAt === right.removedAt && left.originNodeId === right.originNodeId;
}

export async function saveClusterPeer(peer: ClusterPeer): Promise<ClusterPeer> {
  const db = await clusterDatabase();
  const normalizedPeer = { ...peer, url: peer.url.replace(/\/$/, "") };
  db.exec("BEGIN IMMEDIATE");
  try {
    const localNode = nodeFromRow(db.prepare("SELECT id, name, url, created_at, updated_at, invited_by_node_id FROM cluster_node WHERE singleton = 1").get() as unknown as NodeRow);
    const rows = db.prepare("SELECT id, name, url, token, paired_at, last_seen_at, created_at, updated_at FROM cluster_peers WHERE id = ? OR url = ?").all(normalizedPeer.id, normalizedPeer.url) as unknown as PeerRow[];
    const existing = rows.find((row) => row.id === normalizedPeer.id);
    const displacedRows = rows.filter((row) => row.id !== normalizedPeer.id);
    for (const row of displacedRows) assertPeerCanBeRemoved(db, row.id);
    const tombstoneRow = db.prepare("SELECT id, removed_at, origin_node_id FROM cluster_member_tombstones WHERE id = ?").get(normalizedPeer.id) as TombstoneRow | undefined;
    if (tombstoneRow && compareVersion(normalizedPeer.updatedAt, normalizedPeer.id, tombstoneRow.removed_at, tombstoneRow.origin_node_id) <= 0) {
      throw new Error("Cluster member removal is newer than this pairing");
    }
    if (!existing && rows.length === 0) {
      const count = db.prepare("SELECT COUNT(*) AS count FROM cluster_peers").get() as { count: number };
      if (count.count >= 4) throw new Error("A cluster supports at most five nodes");
    }
    const membershipChanged = !existing || existing.name !== normalizedPeer.name || existing.url !== normalizedPeer.url || decryptToken(existing.token) !== normalizedPeer.token || existing.created_at !== normalizedPeer.createdAt || existing.updated_at !== normalizedPeer.updatedAt || (existing.invited_by_node_id ?? null) !== (normalizedPeer.invitedByNodeId ?? null) || displacedRows.length > 0 || Boolean(tombstoneRow);
    if (displacedRows.length > 0) {
      const rotatedLocalNode = rotateLocalMachineCredential(db, localNode, ...displacedRows.map((row) => row.updated_at));
      for (const row of displacedRows) {
        db.prepare("DELETE FROM cluster_peers WHERE id = ?").run(row.id);
        db.prepare("DELETE FROM cluster_membership_deliveries WHERE peer_id = ?").run(row.id);
        db.prepare(`INSERT INTO cluster_member_tombstones (id, removed_at, origin_node_id) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET removed_at = excluded.removed_at, origin_node_id = excluded.origin_node_id`).run(row.id, rotatedLocalNode.updatedAt, localNode.id);
      }
    }
    db.prepare(`
      INSERT INTO cluster_peers (id, name, url, token, paired_at, last_seen_at, created_at, updated_at, invited_by_node_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        url = excluded.url,
        token = excluded.token,
        paired_at = excluded.paired_at,
        last_seen_at = excluded.last_seen_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        invited_by_node_id = excluded.invited_by_node_id
    `).run(normalizedPeer.id, normalizedPeer.name, normalizedPeer.url, encryptToken(normalizedPeer.token), normalizedPeer.pairedAt, normalizedPeer.lastSeenAt, normalizedPeer.createdAt, normalizedPeer.updatedAt, normalizedPeer.invitedByNodeId ?? null);
    db.prepare("DELETE FROM cluster_member_tombstones WHERE id = ?").run(normalizedPeer.id);
    if (membershipChanged) queueMembershipChange(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return normalizedPeer;
}

function projectGrantFromRow(row: ProjectGrantRow): ClusterProjectGrant {
  let projectIds: string[] = [];
  try {
    const parsed = JSON.parse(row.project_ids) as unknown;
    if (Array.isArray(parsed)) projectIds = parsed.filter((entry): entry is string => typeof entry === "string");
  } catch { /* an unreadable grant degrades to "nothing shared" rather than full access */ }
  return { nodeId: row.node_id, projectIds, updatedAt: row.updated_at, originNodeId: row.origin_node_id };
}

export async function listClusterProjectGrants(): Promise<ClusterProjectGrant[]> {
  const rows = (await clusterDatabase()).prepare("SELECT node_id, project_ids, updated_at, origin_node_id FROM cluster_project_grants ORDER BY node_id").all() as unknown as ProjectGrantRow[];
  return rows.map(projectGrantFromRow);
}

/** A node's frozen project selection, or undefined when the node is unrestricted. */
export async function clusterProjectGrantFor(nodeId: string): Promise<string[] | undefined> {
  const row = (await clusterDatabase()).prepare("SELECT node_id, project_ids, updated_at, origin_node_id FROM cluster_project_grants WHERE node_id = ?").get(nodeId) as ProjectGrantRow | undefined;
  return row ? projectGrantFromRow(row).projectIds : undefined;
}

/** Writes a node's full project selection. Only invitation redemption calls this: project
    access is never edited in place, a new invitation replaces the whole grant. */
export async function saveClusterProjectGrant(nodeId: string, projectIds: string[], originNodeId: string): Promise<void> {
  const db = await clusterDatabase();
  const selection = [...new Set(projectIds)];
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT project_ids, updated_at, origin_node_id FROM cluster_project_grants WHERE node_id = ?").get(nodeId) as ProjectGrantRow | undefined;
    const nextIds = JSON.stringify(selection);
    if (current && current.project_ids === nextIds) {
      db.exec("COMMIT");
      return;
    }
    const updatedAt = nextVersionTimestamp(...(current ? [current.updated_at] : []));
    db.prepare(`INSERT INTO cluster_project_grants (node_id, project_ids, updated_at, origin_node_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET project_ids = excluded.project_ids, updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id`)
      .run(nodeId, nextIds, updatedAt, originNodeId);
    queueMembershipChange(db);
    appendAuditEvent(db, { eventType: "cluster.project.grant.updated", actorType: "node", actorId: originNodeId, entityType: "cluster.project.grant", entityId: nodeId, details: { projectCount: selection.length } });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function getClusterMembership(): Promise<ClusterMembershipSnapshot> {
  const db = await clusterDatabase();
  const [node, token, peers] = await Promise.all([getClusterNode(), getClusterMachineToken(), listClusterPeers()]);
  const tombstones = db.prepare("SELECT id, removed_at, origin_node_id FROM cluster_member_tombstones ORDER BY id").all() as unknown as TombstoneRow[];
  const members = [{ ...node, token }, ...peers.map(({ pairedAt: _pairedAt, lastSeenAt: _lastSeenAt, ...member }) => member)].sort((left, right) => left.id.localeCompare(right.id));
  return { members, removed: tombstones.map(tombstoneFromRow), projectGrants: await listClusterProjectGrants() };
}

export async function mergeClusterMembership(snapshot: ClusterMembershipSnapshot, originNodeId?: string): Promise<void> {
  const db = await clusterDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const localNode = nodeFromRow(db.prepare("SELECT id, name, url, created_at, updated_at, invited_by_node_id FROM cluster_node WHERE singleton = 1").get() as unknown as NodeRow);
    const existingRows = db.prepare(`SELECT ${PEER_COLUMNS} FROM cluster_peers`).all() as unknown as PeerRow[];
    const storedTombstones = (db.prepare("SELECT id, removed_at, origin_node_id FROM cluster_member_tombstones").all() as unknown as TombstoneRow[]).map(tombstoneFromRow);
    const incomingMembers = new Map<string, ClusterMembershipMember>();
    for (const member of snapshot.members) {
      const existing = incomingMembers.get(member.id);
      if (!existing || compareVersion(member.updatedAt, member.id, existing.updatedAt, existing.id) > 0) incomingMembers.set(member.id, member);
    }
    const tombstones = new Map<string, ClusterMemberTombstone>();
    for (const tombstone of [...storedTombstones, ...(snapshot.removed ?? [])]) {
      if (tombstone.id === localNode.id) continue;
      const existing = tombstones.get(tombstone.id);
      if (!existing || compareVersion(tombstone.removedAt, tombstone.originNodeId, existing.removedAt, existing.originNodeId) > 0) tombstones.set(tombstone.id, tombstone);
    }
    const existingById = new Map(existingRows.map((row) => [row.id, peerFromRow(row)]));
    const desiredPeers = new Map<string, ClusterPeer>();
    const desiredTombstones = new Map<string, ClusterMemberTombstone>();
    const now = new Date().toISOString();
    const candidateIds = new Set([...existingById.keys(), ...incomingMembers.keys(), ...tombstones.keys()]);
    candidateIds.delete(localNode.id);
    for (const id of candidateIds) {
      const local = existingById.get(id);
      const incoming = incomingMembers.get(id);
      // The authenticated sender describes itself with the very credential it just proved, so its
      // self-declared token is authoritative even when a stale local copy carries a newer version;
      // otherwise that copy pins an outdated token forever and every machine-routed call to the
      // peer stays 401. Only the token is taken: version state still decides which row wins.
      const live = !local ? incoming : !incoming || compareVersion(local.updatedAt, local.id, incoming.updatedAt, incoming.id) > 0 ? local : incoming;
      const authoritative = id === originNodeId && incoming && live ? { ...live, token: incoming.token } : live;
      const tombstone = tombstones.get(id);
      if (tombstone && (!live || compareVersion(live.updatedAt, live.id, tombstone.removedAt, tombstone.originNodeId) <= 0)) {
        desiredTombstones.set(id, tombstone);
        continue;
      }
      if (!authoritative) continue;
      if (!authoritative.token.trim()) throw new Error("Cluster membership token is required");
      if (local && authoritative === local) {
        desiredPeers.set(id, local);
      } else {
        desiredPeers.set(id, {
          ...authoritative,
          url: authoritative.url.replace(/\/$/, ""),
          pairedAt: local?.pairedAt ?? now,
          lastSeenAt: local?.lastSeenAt ?? null,
        });
      }
    }
    const peersByUrl = new Map<string, ClusterPeer[]>();
    for (const [id, peer] of [...desiredPeers]) {
      const normalizedPeer = { ...peer, url: peer.url.replace(/\/$/, "") };
      desiredPeers.set(id, normalizedPeer);
      const peers = peersByUrl.get(normalizedPeer.url) ?? [];
      peers.push(normalizedPeer);
      peersByUrl.set(normalizedPeer.url, peers);
    }
    const collisionLosers: ClusterPeer[] = [];
    for (const peers of peersByUrl.values()) {
      if (peers.length < 2) continue;
      const winner = peers.reduce((current, candidate) => compareVersion(candidate.updatedAt, candidate.id, current.updatedAt, current.id) > 0 ? candidate : current);
      for (const peer of peers) if (peer.id !== winner.id) {
        desiredPeers.delete(peer.id);
        collisionLosers.push(peer);
      }
    }
    const rowsToDelete = existingRows.filter((row) => !desiredPeers.has(row.id));
    for (const peer of collisionLosers) desiredTombstones.set(peer.id, { id: peer.id, removedAt: peer.updatedAt, originNodeId: localNode.id });
    for (const id of desiredTombstones.keys()) assertPeerCanBeRemoved(db, id);
    const storedTombstoneIds = new Set(storedTombstones.map((tombstone) => tombstone.id));
    const hasNewTombstone = [...desiredTombstones.keys()].some((id) => !storedTombstoneIds.has(id));
    const requiresCredentialRotation = collisionLosers.length > 0 || rowsToDelete.length > 0 || hasNewTombstone;
    const rotatedLocalNode = requiresCredentialRotation
      ? rotateLocalMachineCredential(db, localNode, ...collisionLosers.map((peer) => peer.updatedAt))
      : undefined;
    if (rotatedLocalNode) {
      for (const peer of collisionLosers) desiredTombstones.set(peer.id, { id: peer.id, removedAt: rotatedLocalNode.updatedAt, originNodeId: localNode.id });
    }
    if (desiredPeers.size + 1 > 5) throw new Error("A cluster supports at most five nodes");
    let membershipChanged = false;
    for (const row of rowsToDelete) {
      db.prepare("DELETE FROM cluster_peers WHERE id = ?").run(row.id);
      db.prepare("DELETE FROM cluster_membership_deliveries WHERE peer_id = ?").run(row.id);
      db.prepare("DELETE FROM cluster_project_grants WHERE node_id = ?").run(row.id);
      membershipChanged = true;
    }
    const insert = db.prepare("INSERT INTO cluster_peers (id, name, url, token, paired_at, last_seen_at, created_at, updated_at, invited_by_node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const update = db.prepare("UPDATE cluster_peers SET name = ?, url = ?, token = ?, created_at = ?, updated_at = ?, invited_by_node_id = ? WHERE id = ?");
    for (const peer of desiredPeers.values()) {
      const existing = existingById.get(peer.id);
      if (!existing) {
        insert.run(peer.id, peer.name, peer.url, encryptToken(peer.token), peer.pairedAt, peer.lastSeenAt, peer.createdAt, peer.updatedAt, peer.invitedByNodeId ?? null);
        membershipChanged = true;
        continue;
      }
      if (existing.name === peer.name && existing.url === peer.url && existing.token === peer.token && existing.createdAt === peer.createdAt && existing.updatedAt === peer.updatedAt && (existing.invitedByNodeId ?? null) === (peer.invitedByNodeId ?? null)) continue;
      update.run(peer.name, peer.url, encryptToken(peer.token), peer.createdAt, peer.updatedAt, peer.invitedByNodeId ?? null, peer.id);
      membershipChanged = true;
    }
    const storedById = new Map(storedTombstones.map((tombstone) => [tombstone.id, tombstone]));
    for (const tombstone of storedTombstones) if (!desiredTombstones.has(tombstone.id)) {
      db.prepare("DELETE FROM cluster_member_tombstones WHERE id = ?").run(tombstone.id);
      membershipChanged = true;
    }
    for (const tombstone of desiredTombstones.values()) {
      const existing = storedById.get(tombstone.id);
      if (existing && sameTombstone(existing, tombstone)) continue;
      db.prepare(`INSERT INTO cluster_member_tombstones (id, removed_at, origin_node_id) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET removed_at = excluded.removed_at, origin_node_id = excluded.origin_node_id`).run(tombstone.id, tombstone.removedAt, tombstone.originNodeId);
      db.prepare("DELETE FROM cluster_project_grants WHERE node_id = ?").run(tombstone.id);
      membershipChanged = true;
    }
    // Project grants merge last-write-wins like every other membership fact, so all
    // members agree on who may see which project without a second consensus channel.
    // Trust matches the rest of the membership protocol: any authenticated member's
    // snapshot is accepted, and only a strictly newer version replaces a stored grant —
    // a stale relay with different ids must never overwrite what it lost the race to.
    const grantedIds = new Set([...desiredPeers.keys(), localNode.id]);
    for (const grant of snapshot.projectGrants ?? []) {
      if (!grantedIds.has(grant.nodeId)) continue;
      const current = db.prepare("SELECT project_ids, updated_at, origin_node_id FROM cluster_project_grants WHERE node_id = ?").get(grant.nodeId) as ProjectGrantRow | undefined;
      if (current && compareVersion(grant.updatedAt, grant.originNodeId, current.updated_at, current.origin_node_id) <= 0) continue;
      const nextIds = JSON.stringify([...new Set(grant.projectIds)].sort());
      const updatedAt = nextVersionTimestamp(...(current ? [current.updated_at] : []), grant.updatedAt);
      db.prepare(`INSERT INTO cluster_project_grants (node_id, project_ids, updated_at, origin_node_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET project_ids = excluded.project_ids, updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id`)
        .run(grant.nodeId, nextIds, updatedAt, grant.originNodeId);
      membershipChanged = true;
    }
    if (membershipChanged) {
      appendAuditEvent(db, { eventType: "cluster.membership.merged", actorType: "node", actorId: localNode.id, entityType: "cluster.membership", entityId: localNode.id, details: { memberCount: desiredPeers.size + 1 } });
      queueMembershipChange(db);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function markClusterPeerSeen(peerId: string, seenAt = new Date().toISOString()): Promise<void> {
  (await clusterDatabase()).prepare("UPDATE cluster_peers SET last_seen_at = ? WHERE id = ?").run(seenAt, peerId);
}

export async function removeClusterPeer(peerId: string): Promise<void> {
  const db = await clusterDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const localNode = nodeFromRow(db.prepare("SELECT id, name, url, created_at, updated_at, invited_by_node_id FROM cluster_node WHERE singleton = 1").get() as unknown as NodeRow);
    const peer = db.prepare(`SELECT ${PEER_COLUMNS} FROM cluster_peers WHERE id = ?`).get(peerId) as PeerRow | undefined;
    if (peer) {
      assertPeerCanBeRemoved(db, peerId);
      db.prepare("DELETE FROM cluster_peers WHERE id = ?").run(peerId);
      const rotatedLocalNode = rotateLocalMachineCredential(db, localNode, peer.updated_at);
      db.prepare("DELETE FROM cluster_membership_deliveries WHERE peer_id = ?").run(peerId);
      db.prepare("DELETE FROM cluster_project_grants WHERE node_id = ?").run(peerId);
      db.prepare(`INSERT INTO cluster_member_tombstones (id, removed_at, origin_node_id) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET removed_at = excluded.removed_at, origin_node_id = excluded.origin_node_id`).run(peerId, rotatedLocalNode.updatedAt, localNode.id);
      queueMembershipChange(db);
      appendAuditEvent(db, { eventType: "cluster.member.removed", actorType: "node", actorId: localNode.id, entityType: "cluster.member", entityId: peerId });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Checks the same settlement rules leaveCluster enforces, without changing anything, so
    callers can validate a departure before telling peers about it. */
export async function assertClusterDepartureAllowed(): Promise<void> {
  const db = await clusterDatabase();
  for (const row of db.prepare(`SELECT ${PEER_COLUMNS} FROM cluster_peers`).all() as unknown as PeerRow[]) {
    assertPeerCanBeRemoved(db, row.id);
  }
}

/** Voluntary departure: forgets every peer, drops all project grants, and rotates the
    machine credential so former peers can no longer drive this node's machine routes.
    Callers notify the peers first; this only settles local state. */
export async function leaveCluster(): Promise<void> {
  const db = await clusterDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const localNode = nodeFromRow(db.prepare("SELECT id, name, url, created_at, updated_at, invited_by_node_id FROM cluster_node WHERE singleton = 1").get() as unknown as NodeRow);
    const rows = db.prepare(`SELECT ${PEER_COLUMNS} FROM cluster_peers`).all() as unknown as PeerRow[];
    for (const row of rows) assertPeerCanBeRemoved(db, row.id);
    const rotatedLocalNode = rows.length ? rotateLocalMachineCredential(db, localNode, ...rows.map((row) => row.updated_at)) : localNode;
    // No local tombstones: each former peer tombstones this node when it processes the leave
    // notice. A tombstone written here would outrank the inviter's live membership row and
    // block a later re-join, because the leave timestamp is newer than any member version.
    for (const row of rows) {
      db.prepare("DELETE FROM cluster_peers WHERE id = ?").run(row.id);
      db.prepare("DELETE FROM cluster_membership_deliveries WHERE peer_id = ?").run(row.id);
    }
    db.prepare("DELETE FROM cluster_project_grants").run();
    db.prepare("UPDATE cluster_node SET invited_by_node_id = NULL, updated_at = ? WHERE singleton = 1").run(nextVersionTimestamp(localNode.updatedAt, rotatedLocalNode.updatedAt));
    queueMembershipChange(db);
    if (rows.length) appendAuditEvent(db, { eventType: "cluster.member.left", actorType: "node", actorId: localNode.id, entityType: "cluster.membership", entityId: localNode.id, details: { peers: rows.length } });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function dueMembershipDeliveries(now = new Date()): Promise<MembershipDelivery[]> {
  const rows = (await clusterDatabase()).prepare(`
    SELECT peer_id, generation, attempts FROM cluster_membership_deliveries
    WHERE delivered_at IS NULL AND next_attempt_at <= ? ORDER BY peer_id
  `).all(now.toISOString()) as unknown as Array<{ peer_id: string; generation: number; attempts: number }>;
  return rows.map((row) => ({ peerId: row.peer_id, generation: row.generation, attempts: row.attempts }));
}

export async function recordMembershipDelivered(peerId: string, generation: number): Promise<void> {
  const db = await clusterDatabase();
  db.prepare(`
    UPDATE cluster_membership_deliveries SET delivered_at = COALESCE(delivered_at, ?), last_error = NULL
    WHERE peer_id = ? AND generation = ? AND delivered_at IS NULL
  `).run(new Date().toISOString(), peerId, generation);
}

export async function recordMembershipFailure(peerId: string, generation: number, message: string, now = new Date()): Promise<void> {
  const db = await clusterDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT attempts FROM cluster_membership_deliveries WHERE peer_id = ? AND generation = ? AND delivered_at IS NULL").get(peerId, generation) as { attempts: number } | undefined;
    if (row) {
      const attempts = row.attempts + 1;
      db.prepare(`
        UPDATE cluster_membership_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ?
        WHERE peer_id = ? AND generation = ? AND delivered_at IS NULL
      `).run(attempts, new Date(now.getTime() + Math.min(300, 2 ** Math.min(attempts, 8)) * 1000).toISOString(), message, peerId, generation);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function createClusterPeer(node: ClusterNode, token: string): ClusterPeer {
  const pairedAt = new Date().toISOString();
  return { ...node, url: node.url.replace(/\/$/, ""), token, pairedAt, lastSeenAt: null, updatedAt: pairedAt };
}
