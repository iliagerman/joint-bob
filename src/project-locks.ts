import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getClusterNode } from "./cluster.js";
import { enqueueReplicationEvent, ensureReplicationSchema } from "./replication.js";
import { canonicalProjectId } from "./store.js";
import type { ProjectLock } from "./types.js";

interface LockRow {
  project_id: string;
  node_id: string | null;
  node_name: string | null;
  locked_at: string | null;
}

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
let databasePromise: Promise<DatabaseSync> | undefined;

/** A cleared lock keeps its row with a null node_id, so a stale peer upsert cannot resurrect it. */
export function ensureProjectLockSchema(db: DatabaseSync): void {
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

async function lockDatabase(): Promise<DatabaseSync> {
  databasePromise ??= (async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA journal_mode = WAL;");
    ensureProjectLockSchema(db);
    ensureReplicationSchema(db);
    return db;
  })();
  return databasePromise;
}

export async function projectLocks(): Promise<Record<string, ProjectLock>> {
  const db = await lockDatabase();
  const rows = db.prepare("SELECT project_id, node_id, node_name, locked_at FROM project_locks WHERE node_id IS NOT NULL").all() as unknown as LockRow[];
  return Object.fromEntries(rows.map((row) => [row.project_id, { nodeId: row.node_id!, nodeName: row.node_name!, lockedAt: row.locked_at! }]));
}

export async function getProjectLock(projectId: string): Promise<ProjectLock | undefined> {
  const canonicalId = await canonicalProjectId(projectId);
  if (!canonicalId) return undefined;
  return (await projectLocks())[canonicalId];
}

/** Locks the project to this node, or clears the lock. Any node may clear: the lock guards
    against accidental parallel edits, not against a determined peer. */
export async function setProjectLock(projectId: string, locked: boolean): Promise<ProjectLock | undefined> {
  const canonicalId = await canonicalProjectId(projectId);
  if (!canonicalId) throw new Error("Project not found");
  const [node, db] = await Promise.all([getClusterNode(), lockDatabase()]);
  const updatedAt = new Date().toISOString();
  const lock = locked ? { nodeId: node.id, nodeName: node.name, lockedAt: updatedAt } : undefined;
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
      payload: { projectId: canonicalId, lock: lock ?? null, updatedAt, originNodeId: node.id },
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return lock;
}
