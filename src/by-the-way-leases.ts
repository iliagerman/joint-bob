import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-directory.js";
import type { ConversationEngine } from "./conversation-ownership.js";

export interface ByTheWayLease {
  projectId: string;
  engine: ConversationEngine;
  sessionId: string;
  token: string;
}

let databasePromise: Promise<DatabaseSync> | undefined;

async function database(): Promise<DatabaseSync> {
  if (!databasePromise) databasePromise = (async () => {
    const directory = resolveDataDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
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

export async function createByTheWayLease(projectId: string, engine: ConversationEngine, sessionId: string, token: string = randomUUID()): Promise<ByTheWayLease> {
  (await database()).prepare("INSERT INTO by_the_way_leases (project_id, engine, session_id, token, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(projectId, engine, sessionId, token, new Date().toISOString());
  return { projectId, engine, sessionId, token };
}

export async function getByTheWayLease(projectId: string, engine: ConversationEngine, sessionId: string, token: string): Promise<ByTheWayLease | undefined> {
  const row = (await database()).prepare("SELECT * FROM by_the_way_leases WHERE project_id = ? AND engine = ? AND session_id = ? AND token = ?")
    .get(projectId, engine, sessionId, token) as Record<string, unknown> | undefined;
  return row ? { projectId: String(row.project_id), engine: row.engine as ConversationEngine, sessionId: String(row.session_id), token: String(row.token) } : undefined;
}

export async function getByTheWayLeaseByToken(projectId: string, token: string): Promise<ByTheWayLease | undefined> {
  const row = (await database()).prepare("SELECT * FROM by_the_way_leases WHERE project_id = ? AND token = ?")
    .get(projectId, token) as Record<string, unknown> | undefined;
  return row ? { projectId: String(row.project_id), engine: row.engine as ConversationEngine, sessionId: String(row.session_id), token: String(row.token) } : undefined;
}

export async function listByTheWayLeases(): Promise<ByTheWayLease[]> {
  const rows = (await database()).prepare("SELECT * FROM by_the_way_leases").all() as Record<string, unknown>[];
  return rows.map((row) => ({ projectId: String(row.project_id), engine: row.engine as ConversationEngine, sessionId: String(row.session_id), token: String(row.token) }));
}

export async function listByTheWaySessionIds(projectId: string): Promise<Set<string>> {
  const rows = (await database()).prepare("SELECT session_id FROM by_the_way_leases WHERE project_id = ?").all(projectId) as Array<{ session_id: string }>;
  return new Set(rows.map((row) => row.session_id));
}

export async function deleteByTheWayLease(lease: ByTheWayLease): Promise<void> {
  (await database()).prepare("DELETE FROM by_the_way_leases WHERE project_id = ? AND engine = ? AND session_id = ? AND token = ?")
    .run(lease.projectId, lease.engine, lease.sessionId, lease.token);
}
