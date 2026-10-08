import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-directory.js";
let databasePromise;
async function database() {
  if (!databasePromise) databasePromise = (async () => {
    const directory = resolveDataDirectory();
    await mkdir(directory, { recursive: true, mode: 448 });
    const db = new DatabaseSync(path.join(directory, "node.db"));
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS by_the_way_leases (
        project_id TEXT NOT NULL,
        engine TEXT NOT NULL,
        session_id TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, engine, session_id)
      );`);
    return db;
  })();
  return databasePromise;
}
async function createByTheWayLease(projectId, engine, sessionId, token = randomUUID()) {
  (await database()).prepare("INSERT INTO by_the_way_leases (project_id, engine, session_id, token, created_at) VALUES (?, ?, ?, ?, ?)").run(projectId, engine, sessionId, token, (/* @__PURE__ */ new Date()).toISOString());
  return { projectId, engine, sessionId, token };
}
async function getByTheWayLease(projectId, engine, sessionId, token) {
  const row = (await database()).prepare("SELECT * FROM by_the_way_leases WHERE project_id = ? AND engine = ? AND session_id = ? AND token = ?").get(projectId, engine, sessionId, token);
  return row ? { projectId: String(row.project_id), engine: row.engine, sessionId: String(row.session_id), token: String(row.token) } : void 0;
}
async function getByTheWayLeaseByToken(projectId, token) {
  const row = (await database()).prepare("SELECT * FROM by_the_way_leases WHERE project_id = ? AND token = ?").get(projectId, token);
  return row ? { projectId: String(row.project_id), engine: row.engine, sessionId: String(row.session_id), token: String(row.token) } : void 0;
}
async function listByTheWayLeases() {
  const rows = (await database()).prepare("SELECT * FROM by_the_way_leases").all();
  return rows.map((row) => ({ projectId: String(row.project_id), engine: row.engine, sessionId: String(row.session_id), token: String(row.token) }));
}
async function listByTheWaySessionIds(projectId) {
  const rows = (await database()).prepare("SELECT session_id FROM by_the_way_leases WHERE project_id = ?").all(projectId);
  return new Set(rows.map((row) => row.session_id));
}
async function deleteByTheWayLease(lease) {
  (await database()).prepare("DELETE FROM by_the_way_leases WHERE project_id = ? AND engine = ? AND session_id = ? AND token = ?").run(lease.projectId, lease.engine, lease.sessionId, lease.token);
}
export {
  createByTheWayLease,
  deleteByTheWayLease,
  getByTheWayLease,
  getByTheWayLeaseByToken,
  listByTheWayLeases,
  listByTheWaySessionIds
};
