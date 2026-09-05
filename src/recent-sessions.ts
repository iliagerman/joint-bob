import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { enqueueReplicationEvent, ensureReplicationSchema, resolveProjectAlias, type ReplicationEvent } from "./replication.js";
import type { RecentSession } from "./preferences.js";
import { isHarnessId, type HarnessId } from "./types.js";

export interface SyncedRecentSession extends RecentSession { engine: HarnessId; sessionId: string; }

interface RecentPayload {
  username: string;
  projectId: string;
  engine: HarnessId;
  sessionId: string;
  recent: SyncedRecentSession | null;
  updatedAt: string;
  originNodeId: string;
}
interface RecentRow {
  project_id: string; engine: HarnessId; session_id: string; session_path: string; title: string;
  opened_at: string; activity_updated_at: string | null; updated_at: string; origin_node_id: string;
}

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
let database: DatabaseSync | undefined;

export function ensureUserRecentSessionSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS user_recent_sessions (
    username TEXT NOT NULL COLLATE NOCASE, project_id TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL,
    session_path TEXT NOT NULL, title TEXT NOT NULL, opened_at TEXT NOT NULL, activity_updated_at TEXT,
    updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL,
    PRIMARY KEY (username, project_id, engine, session_id)
  );
  CREATE TABLE IF NOT EXISTS user_recent_session_tombstones (
    username TEXT NOT NULL COLLATE NOCASE, project_id TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL,
    PRIMARY KEY (username, project_id, engine, session_id)
  );
  CREATE TABLE IF NOT EXISTS user_recent_session_migrations (username TEXT PRIMARY KEY COLLATE NOCASE, migrated_at TEXT NOT NULL);`);
}

function recentDatabase(): DatabaseSync {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(path.join(dataDir, "node.db"));
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensureUserRecentSessionSchema(database);
  ensureReplicationSchema(database);
  return database;
}

function entityKey(username: string, target: Pick<SyncedRecentSession, "projectId" | "engine" | "sessionId">): string {
  return `${username}:${target.projectId}:${target.engine}:${target.sessionId}`;
}
function fromRow(row: RecentRow): SyncedRecentSession {
  return { projectId: row.project_id, engine: row.engine, sessionId: row.session_id, sessionPath: row.session_path, title: row.title, openedAt: row.opened_at, updatedAt: row.activity_updated_at };
}
export function listUserRecentSessions(username: string): SyncedRecentSession[] {
  const rows = recentDatabase().prepare(`SELECT project_id, engine, session_id, session_path, title, opened_at, activity_updated_at, updated_at, origin_node_id
    FROM user_recent_sessions WHERE username = ? ORDER BY opened_at DESC, updated_at DESC, origin_node_id DESC LIMIT 20`).all(username) as unknown as RecentRow[];
  return rows.map(fromRow);
}

function currentStamp(db: DatabaseSync, username: string, target: Pick<SyncedRecentSession, "projectId" | "engine" | "sessionId">): { updated_at: string; origin_node_id: string } | undefined {
  return db.prepare(`SELECT updated_at, origin_node_id FROM user_recent_sessions WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ?
    UNION ALL SELECT updated_at, origin_node_id FROM user_recent_session_tombstones WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ?
    ORDER BY updated_at DESC, origin_node_id DESC LIMIT 1`).get(username, target.projectId, target.engine, target.sessionId, username, target.projectId, target.engine, target.sessionId) as { updated_at: string; origin_node_id: string } | undefined;
}
function validRecent(recent: SyncedRecentSession): boolean {
  return typeof recent.projectId === "string" && recent.projectId.length > 0 && recent.projectId.length <= 120
    && isHarnessId(recent.engine) && typeof recent.sessionId === "string" && recent.sessionId.length > 0 && recent.sessionId.length <= 240
    && typeof recent.sessionPath === "string" && recent.sessionPath.length > 0 && recent.sessionPath.length <= 2000
    && typeof recent.title === "string" && recent.title.length <= 300
    && typeof recent.openedAt === "string" && Number.isFinite(Date.parse(recent.openedAt))
    && (recent.updatedAt === null || (typeof recent.updatedAt === "string" && Number.isFinite(Date.parse(recent.updatedAt))));
}
type Stamp = { updated_at: string; origin_node_id: string };
function newerStamp(left: Stamp, right: Stamp): boolean {
  return `${left.updated_at}\n${left.origin_node_id}` > `${right.updated_at}\n${right.origin_node_id}`;
}
function rowFor(db: DatabaseSync, table: "user_recent_sessions" | "user_recent_session_tombstones", username: string, target: Pick<SyncedRecentSession, "projectId" | "engine" | "sessionId">): RecentRow | Stamp | undefined {
  return db.prepare(`SELECT * FROM ${table} WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ?`)
    .get(username, target.projectId, target.engine, target.sessionId) as RecentRow | Stamp | undefined;
}
function maxActivity(left: string | null, right: string | null): string | null {
  if (!left || (right && right > left)) return right;
  return left;
}
function applyDelete(db: DatabaseSync, payload: RecentPayload, target: Pick<SyncedRecentSession, "projectId" | "engine" | "sessionId">): boolean {
  const current = currentStamp(db, payload.username, target);
  const incoming = { updated_at: payload.updatedAt, origin_node_id: payload.originNodeId };
  if (current && !newerStamp(incoming, current)) return false;
  db.prepare("DELETE FROM user_recent_sessions WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ?").run(payload.username, target.projectId, target.engine, target.sessionId);
  db.prepare(`INSERT INTO user_recent_session_tombstones (username, project_id, engine, session_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(username, project_id, engine, session_id) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id`)
    .run(payload.username, target.projectId, target.engine, target.sessionId, payload.updatedAt, payload.originNodeId);
  return true;
}
function applyUpsert(db: DatabaseSync, payload: RecentPayload, target: Pick<SyncedRecentSession, "projectId" | "engine" | "sessionId">): boolean {
  const incoming = { updated_at: payload.updatedAt, origin_node_id: payload.originNodeId };
  const tombstone = rowFor(db, "user_recent_session_tombstones", payload.username, target) as Stamp | undefined;
  if (tombstone && !newerStamp(incoming, tombstone)) return false;
  const active = rowFor(db, "user_recent_sessions", payload.username, target) as RecentRow | undefined;
  const recent = { ...payload.recent!, projectId: target.projectId };
  const openedLater = !active || recent.openedAt > active.opened_at
    || (recent.openedAt === active.opened_at && newerStamp(incoming, active));
  const merged = {
    sessionPath: openedLater ? recent.sessionPath : active.session_path,
    title: openedLater ? recent.title : active.title,
    openedAt: openedLater ? recent.openedAt : active.opened_at,
    activityUpdatedAt: active ? maxActivity(active.activity_updated_at, recent.updatedAt) : recent.updatedAt,
    stamp: active && newerStamp({ updated_at: active.updated_at, origin_node_id: active.origin_node_id }, incoming)
      ? { updated_at: active.updated_at, origin_node_id: active.origin_node_id } : incoming,
  };
  const changed = !active || merged.sessionPath !== active.session_path || merged.title !== active.title
    || merged.openedAt !== active.opened_at || merged.activityUpdatedAt !== active.activity_updated_at
    || merged.stamp.updated_at !== active.updated_at || merged.stamp.origin_node_id !== active.origin_node_id || Boolean(tombstone);
  if (!changed) return false;
  db.prepare(`INSERT INTO user_recent_sessions (username, project_id, engine, session_id, session_path, title, opened_at, activity_updated_at, updated_at, origin_node_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(username, project_id, engine, session_id) DO UPDATE SET session_path=excluded.session_path, title=excluded.title, opened_at=excluded.opened_at, activity_updated_at=excluded.activity_updated_at, updated_at=excluded.updated_at, origin_node_id=excluded.origin_node_id`)
    .run(payload.username, target.projectId, target.engine, target.sessionId, merged.sessionPath, merged.title, merged.openedAt, merged.activityUpdatedAt, merged.stamp.updated_at, merged.stamp.origin_node_id);
  if (tombstone) db.prepare("DELETE FROM user_recent_session_tombstones WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ?").run(payload.username, target.projectId, target.engine, target.sessionId);
  return true;
}
function apply(db: DatabaseSync, payload: RecentPayload): boolean {
  const target = { projectId: resolveProjectAlias(db, payload.projectId), engine: payload.engine, sessionId: payload.sessionId };
  return payload.recent === null ? applyDelete(db, payload, target) : applyUpsert(db, payload, target);
}
function nextUpdatedAt(db: DatabaseSync, username: string, target: Pick<SyncedRecentSession, "projectId" | "engine" | "sessionId">): string {
  const current = currentStamp(db, username, target);
  return new Date(Math.max(Date.now(), current ? Date.parse(current.updated_at) + 1 : 0)).toISOString();
}
function publish(db: DatabaseSync, operation: "upsert" | "delete", payload: RecentPayload): void {
  enqueueReplicationEvent(db, { originNodeId: payload.originNodeId, entityType: "user.recent", entityKey: entityKey(payload.username, payload), operation, payload });
}
export function setUserRecentSession(username: string, recent: SyncedRecentSession, originNodeId: string): SyncedRecentSession[] {
  if (!validRecent(recent)) throw new Error("Invalid recent session");
  const db = recentDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const canonical = { ...recent, projectId: resolveProjectAlias(db, recent.projectId) };
    const payload: RecentPayload = { username, projectId: canonical.projectId, engine: canonical.engine, sessionId: canonical.sessionId, recent: canonical, updatedAt: nextUpdatedAt(db, username, canonical), originNodeId };
    apply(db, payload); publish(db, "upsert", payload); db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return listUserRecentSessions(username);
}
export function removeUserRecentSession(username: string, target: Pick<SyncedRecentSession, "projectId" | "engine" | "sessionId">, originNodeId: string): SyncedRecentSession[] {
  if (!target.projectId || !isHarnessId(target.engine) || !target.sessionId) throw new Error("Invalid recent session");
  const db = recentDatabase(); db.exec("BEGIN IMMEDIATE");
  try {
    const canonical = { ...target, projectId: resolveProjectAlias(db, target.projectId) };
    const payload: RecentPayload = { username, ...canonical, recent: null, updatedAt: nextUpdatedAt(db, username, canonical), originNodeId };
    apply(db, payload); publish(db, "delete", payload); db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return listUserRecentSessions(username);
}
export function migrateLegacyRecentSessions(username: string, recents: SyncedRecentSession[], originNodeId: string): void {
  const db = recentDatabase(); db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT 1 FROM user_recent_session_migrations WHERE username = ?").get(username)) { db.exec("COMMIT"); return; }
    const unique = new Map<string, SyncedRecentSession>();
    for (const recent of recents) {
      if (!validRecent(recent)) continue;
      const key = entityKey(username, recent);
      const current = unique.get(key);
      if (!current || recent.openedAt > current.openedAt) unique.set(key, recent);
    }
    for (const recent of unique.values()) {
      const canonical = { ...recent, projectId: resolveProjectAlias(db, recent.projectId) };
      const payload: RecentPayload = { username, projectId: canonical.projectId, engine: canonical.engine, sessionId: canonical.sessionId, recent: canonical, updatedAt: canonical.openedAt, originNodeId };
      if (apply(db, payload)) publish(db, "upsert", payload);
    }
    db.prepare("INSERT INTO user_recent_session_migrations (username, migrated_at) VALUES (?, ?)").run(username, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
function recentPayload(event: ReplicationEvent): RecentPayload {
  const value = event.payload as Partial<RecentPayload>;
  const recent = value?.recent;
  const valid = event.entityType === "user.recent" && ["upsert", "delete"].includes(event.operation)
    && value && typeof value === "object" && !Array.isArray(value)
    && typeof value.username === "string" && value.username.length > 0 && value.username.length <= 80
    && typeof value.projectId === "string" && value.projectId.length > 0 && value.projectId.length <= 120
    && isHarnessId(value.engine) && typeof value.sessionId === "string" && value.sessionId.length > 0 && value.sessionId.length <= 240
    && typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))
    && typeof value.originNodeId === "string" && value.originNodeId === event.originNodeId
    && ((event.operation === "upsert" && recent !== null && recent !== undefined && validRecent(recent as SyncedRecentSession)) || (event.operation === "delete" && recent === null))
    && event.entityKey === `${value.username}:${value.projectId}:${value.engine}:${value.sessionId}`;
  if (!valid) throw new Error("Malformed recent session replication payload");
  const stable = recent as SyncedRecentSession | null;
  if (stable && (stable.projectId !== value.projectId || stable.engine !== value.engine || stable.sessionId !== value.sessionId)) throw new Error("Malformed recent session replication payload");
  return value as RecentPayload;
}
export function applyUserRecentSessionEvent(db: DatabaseSync, event: ReplicationEvent): void {
  ensureUserRecentSessionSchema(db); apply(db, recentPayload(event));
}
