import { promises as fs } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
let databasePromise;
async function recoveryDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = (async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 448 });
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db.exec(`CREATE TABLE IF NOT EXISTS update_recoveries (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, engine TEXT NOT NULL, project_id TEXT NOT NULL,
      cwd TEXT NOT NULL, session_id TEXT NOT NULL, session_path TEXT NOT NULL, task_id TEXT,
      phase TEXT, queued_prompts TEXT NOT NULL, model TEXT, effort TEXT, status TEXT NOT NULL,
      last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, settings TEXT
    )`);
    const columns = db.prepare("PRAGMA table_info(update_recoveries)").all();
    if (!columns.some((column) => column.name === "settings")) db.exec("ALTER TABLE update_recoveries ADD COLUMN settings TEXT");
    return db;
  })();
  return databasePromise;
}
async function saveUpdateRecoveries(records) {
  const db = await recoveryDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM update_recoveries WHERE status = 'pending'").run();
    const insert = db.prepare("INSERT INTO update_recoveries (id, kind, engine, project_id, cwd, session_id, session_path, task_id, phase, queued_prompts, model, effort, settings, status, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)");
    for (const record of records) insert.run(record.id, record.kind, record.engine, record.projectId, record.cwd, record.sessionId, record.sessionPath, record.taskId, record.phase, JSON.stringify(record.queuedPrompts), record.model, record.effort, record.settings ? JSON.stringify(record.settings) : null, record.createdAt, record.createdAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
const recoverySettingsSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  reasoning: z.string(),
  enabledTools: z.array(z.string()).optional()
}).strict();
async function listPendingUpdateRecoveries() {
  const db = await recoveryDatabase();
  const rows = db.prepare("SELECT * FROM update_recoveries WHERE status = 'pending' ORDER BY created_at, id").all();
  return rows.map((row) => ({ id: row.id, kind: row.kind, engine: row.engine, projectId: row.project_id, cwd: row.cwd, sessionId: row.session_id, sessionPath: row.session_path, taskId: row.task_id, phase: row.phase, queuedPrompts: JSON.parse(row.queued_prompts), model: row.model, effort: row.effort, ...row.settings ? { settings: recoverySettingsSchema.parse(JSON.parse(row.settings)) } : {}, createdAt: row.created_at }));
}
async function completeUpdateRecovery(id) {
  const db = await recoveryDatabase();
  const result = db.prepare("DELETE FROM update_recoveries WHERE id = ?").run(id);
  if (!result.changes) throw new Error("Update recovery record not found");
}
async function failUpdateRecovery(id, error) {
  const db = await recoveryDatabase();
  const result = db.prepare("UPDATE update_recoveries SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(error, (/* @__PURE__ */ new Date()).toISOString(), id);
  if (!result.changes) throw new Error("Update recovery record not found");
}
export {
  completeUpdateRecovery,
  failUpdateRecovery,
  listPendingUpdateRecoveries,
  saveUpdateRecoveries
};
