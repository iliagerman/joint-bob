import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HarnessId, TaskPhase } from "./types.js";

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
let databasePromise: Promise<DatabaseSync> | undefined;

export type UpdateRecoveryEngine = HarnessId;
export type UpdateRecoveryKind = "chat" | "task";
export interface UpdateRecoveryRecord {
  id: string;
  kind: UpdateRecoveryKind;
  engine: UpdateRecoveryEngine;
  projectId: string;
  cwd: string;
  sessionId: string;
  sessionPath: string;
  taskId: string | null;
  phase: TaskPhase | null;
  queuedPrompts: string[];
  model: string | null;
  effort: string | null;
  createdAt: string;
}

async function recoveryDatabase(): Promise<DatabaseSync> {
  if (databasePromise) return databasePromise;
  databasePromise = (async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db.exec(`CREATE TABLE IF NOT EXISTS update_recoveries (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, engine TEXT NOT NULL, project_id TEXT NOT NULL,
      cwd TEXT NOT NULL, session_id TEXT NOT NULL, session_path TEXT NOT NULL, task_id TEXT,
      phase TEXT, queued_prompts TEXT NOT NULL, model TEXT, effort TEXT, status TEXT NOT NULL,
      last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    return db;
  })();
  return databasePromise;
}

export async function saveUpdateRecoveries(records: UpdateRecoveryRecord[]): Promise<void> {
  const db = await recoveryDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM update_recoveries WHERE status = 'pending'").run();
    const insert = db.prepare("INSERT INTO update_recoveries (id, kind, engine, project_id, cwd, session_id, session_path, task_id, phase, queued_prompts, model, effort, status, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)");
    for (const record of records) insert.run(record.id, record.kind, record.engine, record.projectId, record.cwd, record.sessionId, record.sessionPath, record.taskId, record.phase, JSON.stringify(record.queuedPrompts), record.model, record.effort, record.createdAt, record.createdAt);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

interface RecoveryRow { id: string; kind: UpdateRecoveryKind; engine: UpdateRecoveryEngine; project_id: string; cwd: string; session_id: string; session_path: string; task_id: string | null; phase: TaskPhase | null; queued_prompts: string; model: string | null; effort: string | null; created_at: string; }
export async function listPendingUpdateRecoveries(): Promise<UpdateRecoveryRecord[]> {
  const db = await recoveryDatabase();
  const rows = db.prepare("SELECT * FROM update_recoveries WHERE status = 'pending' ORDER BY created_at, id").all() as unknown as RecoveryRow[];
  return rows.map((row) => ({ id: row.id, kind: row.kind, engine: row.engine, projectId: row.project_id, cwd: row.cwd, sessionId: row.session_id, sessionPath: row.session_path, taskId: row.task_id, phase: row.phase, queuedPrompts: JSON.parse(row.queued_prompts) as string[], model: row.model, effort: row.effort, createdAt: row.created_at }));
}

export async function completeUpdateRecovery(id: string): Promise<void> {
  const db = await recoveryDatabase();
  const result = db.prepare("DELETE FROM update_recoveries WHERE id = ?").run(id);
  if (!result.changes) throw new Error("Update recovery record not found");
}
export async function failUpdateRecovery(id: string, error: string): Promise<void> {
  const db = await recoveryDatabase();
  const result = db.prepare("UPDATE update_recoveries SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(error, new Date().toISOString(), id);
  if (!result.changes) throw new Error("Update recovery record not found");
}
