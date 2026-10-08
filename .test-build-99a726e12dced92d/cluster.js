import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-directory.js";
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
const legacyStorePath = path.join(dataDir, "cluster.json");
let databasePromise;
const RETIRED_TABLES = [
  "cluster_peers",
  "cluster_machine_credentials",
  "cluster_membership_state",
  "cluster_membership_deliveries",
  "cluster_member_tombstones",
  "cluster_invitations",
  "cluster_project_grants",
  "cluster_secret_migrations",
  "cluster_v2_mode"
];
function nodeFromRow(row) {
  return { id: row.id, name: row.name, url: row.url, createdAt: row.created_at, updatedAt: row.updated_at };
}
async function legacyNode() {
  try {
    return JSON.parse(await fs.readFile(legacyStorePath, "utf8")).node;
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
}
function newNode() {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return { id: randomUUID(), name: os.hostname(), url: (process.env.JOINT_BOB_NODE_URL ?? process.env.PI_MOBILE_WEB_NODE_URL)?.trim() ?? "", createdAt: now, updatedAt: now };
}
async function clusterDatabase() {
  databasePromise ??= (async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 448 });
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
      db.prepare("INSERT INTO cluster_node (singleton, id, name, url, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)").run(node.id, node.name, node.url, node.createdAt, node.updatedAt);
    }
    return db;
  })();
  return databasePromise;
}
async function getClusterNode() {
  const row = (await clusterDatabase()).prepare("SELECT id, name, url, created_at, updated_at FROM cluster_node WHERE singleton = 1").get();
  return nodeFromRow(row);
}
async function updateClusterNode(name, url) {
  const db = await clusterDatabase();
  const normalizedUrl = url.replace(/\/$/, "");
  const node = await getClusterNode();
  if (node.name === name && node.url === normalizedUrl) return node;
  db.prepare("UPDATE cluster_node SET name = ?, url = ?, updated_at = ? WHERE singleton = 1").run(name, normalizedUrl, (/* @__PURE__ */ new Date()).toISOString());
  return getClusterNode();
}
export {
  getClusterNode,
  updateClusterNode
};
