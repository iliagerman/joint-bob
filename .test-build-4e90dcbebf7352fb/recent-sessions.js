import { mkdirSync } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { enqueueReplicationEvent, ensureReplicationSchema, resolveProjectAlias } from "./replication.js";
import { portableSessionPath } from "./session-paths.js";
import { isHarnessId } from "./types.js";
const dataDir = resolveDataDirectory();
let database;
function ensureUserRecentSessionSchema(db) {
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
function recentDatabase() {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 448 });
  database = new DatabaseSync(path.join(dataDir, "node.db"));
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensureUserRecentSessionSchema(database);
  ensureReplicationSchema(database);
  return database;
}
function entityKey(username, target) {
  return `${username}:${target.projectId}:${target.engine}:${target.sessionId}`;
}
function portableStoredPath(sessionPath) {
  try {
    return portableSessionPath(sessionPath);
  } catch {
    return sessionPath;
  }
}
function fromRow(row) {
  return { projectId: row.project_id, engine: row.engine, sessionId: row.session_id, sessionPath: portableStoredPath(row.session_path), title: row.title, openedAt: row.opened_at, updatedAt: row.activity_updated_at };
}
function listUserRecentSessions(username) {
  const db = recentDatabase();
  const rows = db.prepare(`SELECT project_id, engine, session_id, session_path, title, opened_at, activity_updated_at, updated_at, origin_node_id
    FROM user_recent_sessions WHERE username = ? ORDER BY opened_at DESC, updated_at DESC, origin_node_id DESC LIMIT 20`).all(username);
  const repair = db.prepare("UPDATE user_recent_sessions SET session_path = ? WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ?");
  for (const row of rows) {
    const portable = portableStoredPath(row.session_path);
    if (portable !== row.session_path) {
      repair.run(portable, username, row.project_id, row.engine, row.session_id);
      row.session_path = portable;
    }
  }
  return rows.map(fromRow);
}
function currentStamp(db, username, target) {
  return db.prepare(`SELECT updated_at, origin_node_id FROM user_recent_sessions WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ?
    UNION ALL SELECT updated_at, origin_node_id FROM user_recent_session_tombstones WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ?
    ORDER BY updated_at DESC, origin_node_id DESC LIMIT 1`).get(username, target.projectId, target.engine, target.sessionId, username, target.projectId, target.engine, target.sessionId);
}
function validRecent(recent) {
  return typeof recent.projectId === "string" && recent.projectId.length > 0 && recent.projectId.length <= 120 && isHarnessId(recent.engine) && typeof recent.sessionId === "string" && recent.sessionId.length > 0 && recent.sessionId.length <= 240 && typeof recent.sessionPath === "string" && recent.sessionPath.length > 0 && recent.sessionPath.length <= 2e3 && typeof recent.title === "string" && recent.title.length <= 300 && typeof recent.openedAt === "string" && Number.isFinite(Date.parse(recent.openedAt)) && (recent.updatedAt === null || typeof recent.updatedAt === "string" && Number.isFinite(Date.parse(recent.updatedAt)));
}
function newerStamp(left, right) {
  return `${left.updated_at}
${left.origin_node_id}` > `${right.updated_at}
${right.origin_node_id}`;
}
function rowFor(db, table, username, target) {
  return db.prepare(`SELECT * FROM ${table} WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ?`).get(username, target.projectId, target.engine, target.sessionId);
}
function maxActivity(left, right) {
  if (!left || right && right > left) return right;
  return left;
}
function applyDelete(db, payload, target) {
  const current = currentStamp(db, payload.username, target);
  const incoming = { updated_at: payload.updatedAt, origin_node_id: payload.originNodeId };
  if (current && !newerStamp(incoming, current)) return false;
  db.prepare("DELETE FROM user_recent_sessions WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ?").run(payload.username, target.projectId, target.engine, target.sessionId);
  db.prepare(`INSERT INTO user_recent_session_tombstones (username, project_id, engine, session_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(username, project_id, engine, session_id) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id`).run(payload.username, target.projectId, target.engine, target.sessionId, payload.updatedAt, payload.originNodeId);
  return true;
}
function applyUpsert(db, payload, target, local = false) {
  const incoming = { updated_at: payload.updatedAt, origin_node_id: payload.originNodeId };
  const tombstone = rowFor(db, "user_recent_session_tombstones", payload.username, target);
  if (tombstone && !newerStamp(incoming, tombstone)) return false;
  const active = rowFor(db, "user_recent_sessions", payload.username, target);
  const recent = { ...payload.recent, projectId: target.projectId, sessionPath: portableStoredPath(payload.recent.sessionPath) };
  const openedLater = !active || recent.openedAt > active.opened_at || recent.openedAt === active.opened_at && newerStamp(incoming, active);
  const merged = {
    sessionPath: openedLater ? recent.sessionPath : active.session_path,
    title: openedLater ? recent.title : active.title,
    openedAt: openedLater ? recent.openedAt : active.opened_at,
    activityUpdatedAt: active ? maxActivity(active.activity_updated_at, recent.updatedAt) : recent.updatedAt,
    stamp: active && newerStamp({ updated_at: active.updated_at, origin_node_id: active.origin_node_id }, incoming) ? { updated_at: active.updated_at, origin_node_id: active.origin_node_id } : incoming
  };
  const contentChanged = !active || merged.sessionPath !== active.session_path || merged.title !== active.title || merged.openedAt !== active.opened_at || merged.activityUpdatedAt !== active.activity_updated_at || Boolean(tombstone);
  const stampChanged = !active || merged.stamp.updated_at !== active.updated_at || merged.stamp.origin_node_id !== active.origin_node_id;
  if (local ? !contentChanged : !contentChanged && !stampChanged) return false;
  db.prepare(`INSERT INTO user_recent_sessions (username, project_id, engine, session_id, session_path, title, opened_at, activity_updated_at, updated_at, origin_node_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(username, project_id, engine, session_id) DO UPDATE SET session_path=excluded.session_path, title=excluded.title, opened_at=excluded.opened_at, activity_updated_at=excluded.activity_updated_at, updated_at=excluded.updated_at, origin_node_id=excluded.origin_node_id`).run(payload.username, target.projectId, target.engine, target.sessionId, merged.sessionPath, merged.title, merged.openedAt, merged.activityUpdatedAt, merged.stamp.updated_at, merged.stamp.origin_node_id);
  if (tombstone) db.prepare("DELETE FROM user_recent_session_tombstones WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ?").run(payload.username, target.projectId, target.engine, target.sessionId);
  return true;
}
function apply(db, payload, local = false) {
  const target = { projectId: resolveProjectAlias(db, payload.projectId), engine: payload.engine, sessionId: payload.sessionId };
  return payload.recent === null ? applyDelete(db, payload, target) : applyUpsert(db, payload, target, local);
}
function nextUpdatedAt(db, username, target) {
  const current = currentStamp(db, username, target);
  return new Date(Math.max(Date.now(), current ? Date.parse(current.updated_at) + 1 : 0)).toISOString();
}
function publish(db, operation, payload) {
  enqueueReplicationEvent(db, { originNodeId: payload.originNodeId, entityType: "user.recent", entityKey: entityKey(payload.username, payload), operation, payload });
}
function setUserRecentSession(username, recent, originNodeId) {
  if (!validRecent(recent)) throw new Error("Invalid recent session");
  const db = recentDatabase();
  let changed;
  db.exec("BEGIN IMMEDIATE");
  try {
    const canonical = { ...recent, projectId: resolveProjectAlias(db, recent.projectId), sessionPath: portableStoredPath(recent.sessionPath) };
    const payload = { username, projectId: canonical.projectId, engine: canonical.engine, sessionId: canonical.sessionId, recent: canonical, updatedAt: nextUpdatedAt(db, username, canonical), originNodeId };
    changed = apply(db, payload, true);
    if (changed) publish(db, "upsert", payload);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { recentSessions: listUserRecentSessions(username), changed };
}
function removeUserRecentSession(username, target, originNodeId) {
  if (!target.projectId || !isHarnessId(target.engine) || !target.sessionId) throw new Error("Invalid recent session");
  const db = recentDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const canonical = { ...target, projectId: resolveProjectAlias(db, target.projectId) };
    const payload = { username, ...canonical, recent: null, updatedAt: nextUpdatedAt(db, username, canonical), originNodeId };
    apply(db, payload);
    publish(db, "delete", payload);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return listUserRecentSessions(username);
}
function migrateLegacyRecentSessions(username, recents, originNodeId) {
  const db = recentDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT 1 FROM user_recent_session_migrations WHERE username = ?").get(username)) {
      db.exec("COMMIT");
      return;
    }
    const unique = /* @__PURE__ */ new Map();
    for (const recent of recents) {
      if (!validRecent(recent)) continue;
      const key = entityKey(username, recent);
      const current = unique.get(key);
      if (!current || recent.openedAt > current.openedAt) unique.set(key, recent);
    }
    for (const recent of unique.values()) {
      const canonical = { ...recent, projectId: resolveProjectAlias(db, recent.projectId), sessionPath: portableStoredPath(recent.sessionPath) };
      const payload = { username, projectId: canonical.projectId, engine: canonical.engine, sessionId: canonical.sessionId, recent: canonical, updatedAt: canonical.openedAt, originNodeId };
      if (apply(db, payload)) publish(db, "upsert", payload);
    }
    db.prepare("INSERT INTO user_recent_session_migrations (username, migrated_at) VALUES (?, ?)").run(username, (/* @__PURE__ */ new Date()).toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function recentPayload(event) {
  const value = event.payload;
  const recent = value?.recent;
  const valid = event.entityType === "user.recent" && ["upsert", "delete"].includes(event.operation) && value && typeof value === "object" && !Array.isArray(value) && typeof value.username === "string" && value.username.length > 0 && value.username.length <= 80 && typeof value.projectId === "string" && value.projectId.length > 0 && value.projectId.length <= 120 && isHarnessId(value.engine) && typeof value.sessionId === "string" && value.sessionId.length > 0 && value.sessionId.length <= 240 && typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)) && typeof value.originNodeId === "string" && value.originNodeId === event.originNodeId && (event.operation === "upsert" && recent !== null && recent !== void 0 && validRecent(recent) || event.operation === "delete" && recent === null) && event.entityKey === `${value.username}:${value.projectId}:${value.engine}:${value.sessionId}`;
  if (!valid) throw new Error("Malformed recent session replication payload");
  const stable = recent;
  if (stable && (stable.projectId !== value.projectId || stable.engine !== value.engine || stable.sessionId !== value.sessionId)) throw new Error("Malformed recent session replication payload");
  return value;
}
function applyUserRecentSessionEvent(db, event) {
  ensureUserRecentSessionSchema(db);
  apply(db, recentPayload(event));
}
export {
  applyUserRecentSessionEvent,
  ensureUserRecentSessionSchema,
  listUserRecentSessions,
  migrateLegacyRecentSessions,
  removeUserRecentSession,
  setUserRecentSession
};
