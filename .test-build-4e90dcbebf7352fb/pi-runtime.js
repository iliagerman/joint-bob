import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-directory.js";
function openPiRuntimeDatabase(dataDirectory) {
  const directory = resolveDataDirectory(dataDirectory);
  mkdirSync(directory, { recursive: true, mode: 448 });
  const db = new DatabaseSync(path.join(directory, "node.db"));
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS pi_runtime_sessions (
      session_id TEXT NOT NULL, run_id TEXT NOT NULL, transcript_path TEXT NOT NULL,
      expires_at TEXT NOT NULL, PRIMARY KEY (session_id, run_id)
    )`);
  db.prepare("DELETE FROM pi_runtime_sessions WHERE expires_at <= ?").run((/* @__PURE__ */ new Date()).toISOString());
  return db;
}
function publishPiRuntime(db, session, running) {
  if (!running) {
    db.prepare("DELETE FROM pi_runtime_sessions WHERE session_id = ? AND run_id = ?").run(session.sessionId, session.runId);
    return;
  }
  db.prepare(`INSERT INTO pi_runtime_sessions (session_id, run_id, transcript_path, expires_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id, run_id) DO UPDATE SET transcript_path = excluded.transcript_path, expires_at = excluded.expires_at`).run(session.sessionId, session.runId, session.transcriptPath, new Date(Date.now() + 3e4).toISOString());
}
let database;
function listRunningPiSessions() {
  database ??= openPiRuntimeDatabase(resolveDataDirectory());
  return database.prepare(`SELECT session_id AS sessionId, run_id AS runId, transcript_path AS transcriptPath
    FROM pi_runtime_sessions WHERE expires_at > ?`).all((/* @__PURE__ */ new Date()).toISOString());
}
export {
  listRunningPiSessions,
  openPiRuntimeDatabase,
  publishPiRuntime
};
