import type { DatabaseSync } from "node:sqlite";
import { clusterV2Database } from "../cluster-v2-store.js";

/** Which conversations Bob started, so the board and the conversation list can say so. Kept on the node that started them. */
function ensure(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS control_center_bob_started (
    project_id TEXT NOT NULL, session_id TEXT NOT NULL, started_at TEXT NOT NULL,
    PRIMARY KEY(project_id, session_id))`);
}

async function database(): Promise<DatabaseSync> {
  const db = await clusterV2Database();
  ensure(db);
  return db;
}

export async function recordBobStart(projectId: string, sessionId: string): Promise<void> {
  (await database()).prepare("INSERT OR IGNORE INTO control_center_bob_started (project_id, session_id, started_at) VALUES (?, ?, ?)")
    .run(projectId, sessionId, new Date().toISOString());
}

/** `projectId:sessionId` for every conversation Bob started. */
export async function bobStartedKeys(): Promise<Set<string>> {
  const rows = (await database()).prepare("SELECT project_id AS projectId, session_id AS sessionId FROM control_center_bob_started").all() as Array<{ projectId: string; sessionId: string }>;
  return new Set(rows.map((row) => `${row.projectId}:${row.sessionId}`));
}
