import type { DatabaseSync } from "node:sqlite";

export function ensureSelectiveSharingModeSchema(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS cluster_v2_mode(singleton INTEGER PRIMARY KEY CHECK(singleton=1),active INTEGER NOT NULL CHECK(active=1))");
}

export function selectiveSharingActiveInDatabase(db: DatabaseSync): boolean {
  ensureSelectiveSharingModeSchema(db);
  return Boolean(db.prepare("SELECT 1 FROM cluster_v2_mode WHERE singleton=1").get());
}
