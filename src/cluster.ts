import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-directory.js";

/** This node's identity. Cluster membership, twins, and peer endpoints live in the
    signed cluster layer (`cluster-membership.ts`, `cluster-twins.ts`). */
export interface ClusterNode {
  id: string;
  name: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

/** A reachable peer, resolved from signed cluster membership or a twin relationship. */
export interface ClusterPeer extends ClusterNode {
  lastSeenAt: string | null;
}

interface NodeRow {
  id: string;
  name: string;
  url: string;
  created_at: string;
  updated_at: string;
}

const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
const legacyStorePath = path.join(dataDir, "cluster.json");
let databasePromise: Promise<DatabaseSync> | undefined;

// Bearer-token pairing tables from before signed cluster membership. Nothing reads them.
const RETIRED_TABLES = [
  "cluster_peers", "cluster_machine_credentials", "cluster_membership_state", "cluster_membership_deliveries",
  "cluster_member_tombstones", "cluster_invitations", "cluster_project_grants", "cluster_secret_migrations", "cluster_v2_mode",
];

function nodeFromRow(row: NodeRow): ClusterNode {
  return { id: row.id, name: row.name, url: row.url, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** The node identity of an install that predates SQLite, from `cluster.json`. */
async function legacyNode(): Promise<ClusterNode | undefined> {
  try {
    return (JSON.parse(await fs.readFile(legacyStorePath, "utf8")) as { node: ClusterNode }).node;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function newNode(): ClusterNode {
  const now = new Date().toISOString();
  return { id: randomUUID(), name: os.hostname(), url: (process.env.JOINT_BOB_NODE_URL ?? process.env.PI_MOBILE_WEB_NODE_URL)?.trim() ?? "", createdAt: now, updatedAt: now };
}

async function clusterDatabase(): Promise<DatabaseSync> {
  databasePromise ??= (async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    db.exec(`CREATE TABLE IF NOT EXISTS cluster_node (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    DROP TRIGGER IF EXISTS cluster_v2_no_legacy_peer_insert;
    DROP TRIGGER IF EXISTS cluster_v2_no_legacy_peer_update;`);
    for (const table of RETIRED_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
    if (!db.prepare("SELECT 1 FROM cluster_node WHERE singleton = 1").get()) {
      const node = await legacyNode() ?? newNode();
      db.prepare("INSERT INTO cluster_node (singleton, id, name, url, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)")
        .run(node.id, node.name, node.url, node.createdAt, node.updatedAt);
    }
    return db;
  })();
  return databasePromise;
}

export async function getClusterNode(): Promise<ClusterNode> {
  const row = (await clusterDatabase()).prepare("SELECT id, name, url, created_at, updated_at FROM cluster_node WHERE singleton = 1").get() as unknown as NodeRow;
  return nodeFromRow(row);
}

export async function updateClusterNode(name: string, url: string): Promise<ClusterNode> {
  const db = await clusterDatabase();
  const normalizedUrl = url.replace(/\/$/, "");
  const node = await getClusterNode();
  if (node.name === name && node.url === normalizedUrl) return node;
  db.prepare("UPDATE cluster_node SET name = ?, url = ?, updated_at = ? WHERE singleton = 1").run(name, normalizedUrl, new Date().toISOString());
  return getClusterNode();
}
