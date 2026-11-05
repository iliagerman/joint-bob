import type { DatabaseSync } from "node:sqlite";
import { clusterV2Database } from "../cluster-v2-store.js";

/** Which conversations Bob started, and for whom, so the board can say so and that person's Bob checks them. Kept on the node that started them. */
function ensure(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS control_center_bob_started (
    project_id TEXT NOT NULL, session_id TEXT NOT NULL, started_at TEXT NOT NULL, account_id TEXT,
    PRIMARY KEY(project_id, session_id))`);
  // Tables from 2.213 have no account column; their rows keep an unknown starter.
  const columns = db.prepare("PRAGMA table_info(control_center_bob_started)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "account_id")) db.exec("ALTER TABLE control_center_bob_started ADD COLUMN account_id TEXT");
}

async function database(): Promise<DatabaseSync> {
  const db = await clusterV2Database();
  ensure(db);
  return db;
}

export async function recordBobStart(projectId: string, sessionId: string, accountId: string): Promise<void> {
  (await database()).prepare("INSERT OR IGNORE INTO control_center_bob_started (project_id, session_id, started_at, account_id) VALUES (?, ?, ?, ?)")
    .run(projectId, sessionId, new Date().toISOString(), accountId);
}

/** The account Bob started a conversation for; null when Bob did not start it or the start predates the record. */
export async function bobStarter(projectId: string, sessionId: string): Promise<string | null> {
  const row = (await database()).prepare("SELECT account_id AS accountId FROM control_center_bob_started WHERE project_id = ? AND session_id = ?").get(projectId, sessionId) as { accountId: string | null } | undefined;
  return row?.accountId ?? null;
}

/** `projectId:sessionId` for every conversation Bob started. */
export async function bobStartedKeys(): Promise<Set<string>> {
  const rows = (await database()).prepare("SELECT project_id AS projectId, session_id AS sessionId FROM control_center_bob_started").all() as Array<{ projectId: string; sessionId: string }>;
  return new Set(rows.map((row) => `${row.projectId}:${row.sessionId}`));
}
