import { promises as fs } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getClusterNode } from "./cluster.js";
import { enqueueReplicationEvent, ensureReplicationSchema } from "./replication.js";
import { canonicalProjectId } from "./store.js";
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
let databasePromise;
function ensureProjectLockSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_locks (
      project_id TEXT PRIMARY KEY,
      node_id TEXT,
      node_name TEXT,
      locked_at TEXT,
      updated_at TEXT NOT NULL,
      origin_node_id TEXT NOT NULL
    );
  `);
}
async function lockDatabase() {
  databasePromise ??= (async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 448 });
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    ensureProjectLockSchema(db);
    ensureReplicationSchema(db);
    return db;
  })();
  return databasePromise;
}
async function projectLocks() {
  const db = await lockDatabase();
  const rows = db.prepare("SELECT project_id, node_id, node_name, locked_at FROM project_locks WHERE node_id IS NOT NULL").all();
  return Object.fromEntries(rows.map((row) => [row.project_id, { nodeId: row.node_id, nodeName: row.node_name, lockedAt: row.locked_at }]));
}
async function getProjectLock(projectId) {
  const canonicalId = await canonicalProjectId(projectId);
  if (!canonicalId) return void 0;
  return (await projectLocks())[canonicalId];
}
async function setProjectLock(projectId, locked) {
  const canonicalId = await canonicalProjectId(projectId);
  if (!canonicalId) throw new Error("Project not found");
  const [node, db] = await Promise.all([getClusterNode(), lockDatabase()]);
  const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  const lock = locked ? { nodeId: node.id, nodeName: node.name, lockedAt: updatedAt } : void 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO project_locks (project_id, node_id, node_name, locked_at, updated_at, origin_node_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        node_id = excluded.node_id,
        node_name = excluded.node_name,
        locked_at = excluded.locked_at,
        updated_at = excluded.updated_at,
        origin_node_id = excluded.origin_node_id
    `).run(canonicalId, lock?.nodeId ?? null, lock?.nodeName ?? null, lock?.lockedAt ?? null, updatedAt, node.id);
    enqueueReplicationEvent(db, {
      originNodeId: node.id,
      entityType: "project.lock",
      entityKey: canonicalId,
      operation: locked ? "upsert" : "delete",
      payload: { projectId: canonicalId, lock: lock ?? null, updatedAt, originNodeId: node.id }
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return lock;
}
export {
  ensureProjectLockSchema,
  getProjectLock,
  projectLocks,
  setProjectLock
};
