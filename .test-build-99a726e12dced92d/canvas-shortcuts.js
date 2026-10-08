import { mkdirSync } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalCanvasKeyToken } from "./canvas-keys.js";
import { enqueueReplicationEvent, ensureReplicationSchema, resolveProjectAlias } from "./replication.js";
import { isHarnessId } from "./types.js";
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
let database;
function ensureCanvasShortcutSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS canvas_shortcuts (
      username TEXT NOT NULL,
      binding TEXT NOT NULL,
      project_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      origin_node_id TEXT NOT NULL,
      PRIMARY KEY (username, binding)
    );
    CREATE TABLE IF NOT EXISTS canvas_shortcut_binding_marks (
      username TEXT NOT NULL,
      binding TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      origin_node_id TEXT NOT NULL,
      PRIMARY KEY (username, binding)
    );
    CREATE TABLE IF NOT EXISTS canvas_shortcut_conversation_marks (
      username TEXT NOT NULL,
      project_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      origin_node_id TEXT NOT NULL,
      PRIMARY KEY (username, project_id, engine, session_id)
    );
    CREATE TABLE IF NOT EXISTS canvas_shortcut_clock (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      last_issued_at INTEGER NOT NULL
    );`);
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'canvas_shortcuts'").get();
  if (row?.sql.includes("engine IN ('pi', 'claude')")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("ALTER TABLE canvas_shortcuts RENAME TO canvas_shortcuts_old");
      db.exec("CREATE TABLE canvas_shortcuts (username TEXT NOT NULL, binding TEXT NOT NULL, project_id TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY (username, binding)); INSERT INTO canvas_shortcuts SELECT * FROM canvas_shortcuts_old; DROP TABLE canvas_shortcuts_old;");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  carryOldStateIntoRegisters(db);
}
const KEEPS_THE_NEWER = (table) => `updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id
  WHERE excluded.updated_at > ${table}.updated_at
    OR (excluded.updated_at = ${table}.updated_at AND excluded.origin_node_id > ${table}.origin_node_id)`;
function carryOldStateIntoRegisters(db) {
  db.exec(`INSERT INTO canvas_shortcut_binding_marks (username, binding, updated_at, origin_node_id)
      SELECT username, binding, updated_at, origin_node_id FROM canvas_shortcuts WHERE true
      ON CONFLICT(username, binding) DO UPDATE SET ${KEEPS_THE_NEWER("canvas_shortcut_binding_marks")};
    INSERT INTO canvas_shortcut_conversation_marks (username, project_id, engine, session_id, updated_at, origin_node_id)
      SELECT username, project_id, engine, session_id, updated_at, origin_node_id FROM canvas_shortcuts WHERE true
      ON CONFLICT(username, project_id, engine, session_id) DO UPDATE SET ${KEEPS_THE_NEWER("canvas_shortcut_conversation_marks")};`);
  const retired = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'canvas_shortcut_tombstones'").get();
  if (retired) {
    db.exec(`INSERT INTO canvas_shortcut_binding_marks (username, binding, updated_at, origin_node_id)
        SELECT username, binding, updated_at, origin_node_id FROM canvas_shortcut_tombstones WHERE true
        ON CONFLICT(username, binding) DO UPDATE SET ${KEEPS_THE_NEWER("canvas_shortcut_binding_marks")};
      DROP TABLE canvas_shortcut_tombstones;`);
  }
  db.exec(`DELETE FROM canvas_shortcuts WHERE NOT EXISTS (
      SELECT 1 FROM canvas_shortcut_binding_marks mark
      WHERE mark.username = canvas_shortcuts.username AND mark.binding = canvas_shortcuts.binding
        AND mark.updated_at = canvas_shortcuts.updated_at AND mark.origin_node_id = canvas_shortcuts.origin_node_id
    ) OR NOT EXISTS (
      SELECT 1 FROM canvas_shortcut_conversation_marks mark
      WHERE mark.username = canvas_shortcuts.username AND mark.project_id = canvas_shortcuts.project_id
        AND mark.engine = canvas_shortcuts.engine AND mark.session_id = canvas_shortcuts.session_id
        AND mark.updated_at = canvas_shortcuts.updated_at AND mark.origin_node_id = canvas_shortcuts.origin_node_id
    );`);
  seedClock(db);
}
function seedClock(db) {
  if (db.prepare("SELECT 1 FROM canvas_shortcut_clock WHERE singleton = 1").get()) return;
  const rows = db.prepare(`SELECT MAX(updated_at) AS newest FROM (
      SELECT updated_at FROM canvas_shortcut_binding_marks
      UNION ALL SELECT updated_at FROM canvas_shortcut_conversation_marks
      UNION ALL SELECT updated_at FROM canvas_shortcuts
    )`).get();
  const newest = rows?.newest ? Date.parse(rows.newest) : 0;
  db.prepare("INSERT INTO canvas_shortcut_clock (singleton, last_issued_at) VALUES (1, ?)").run(Number.isFinite(newest) ? newest : 0);
}
function shortcutDatabase() {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 448 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensureCanvasShortcutSchema(database);
  ensureReplicationSchema(database);
  return database;
}
function canonicalCanvasBinding(binding) {
  const canonical = canonicalCanvasKeyToken(binding);
  if (!canonical) throw new Error("A canvas binding is one digit, letter, punctuation key, or Enter");
  return canonical;
}
function rowToShortcut(row) {
  return { binding: row.binding, projectId: row.project_id, engine: row.engine, sessionId: row.session_id, updatedAt: row.updated_at };
}
function listCanvasShortcuts(username) {
  const rows = shortcutDatabase().prepare("SELECT binding, project_id, engine, session_id, updated_at FROM canvas_shortcuts WHERE username = ? ORDER BY binding").all(username);
  return rows.map(rowToShortcut);
}
function nextStamp(db, originNodeId) {
  const previous = db.prepare("SELECT last_issued_at FROM canvas_shortcut_clock WHERE singleton = 1").get()?.last_issued_at ?? 0;
  const issued = Math.max(Date.now(), previous + 1);
  db.prepare(`INSERT INTO canvas_shortcut_clock (singleton, last_issued_at) VALUES (1, ?)
    ON CONFLICT(singleton) DO UPDATE SET last_issued_at = excluded.last_issued_at`).run(issued);
  return { updatedAt: new Date(issued).toISOString(), originNodeId };
}
function wins(candidate, held) {
  if (!held) return true;
  if (candidate.updatedAt !== held.updatedAt) return candidate.updatedAt > held.updatedAt;
  return candidate.originNodeId > held.originNodeId;
}
function stampOf(row) {
  return row ? { updatedAt: row.updated_at, originNodeId: row.origin_node_id } : void 0;
}
function bindingMark(db, username, binding) {
  return stampOf(db.prepare("SELECT updated_at, origin_node_id FROM canvas_shortcut_binding_marks WHERE username = ? AND binding = ?").get(username, binding));
}
function conversationMark(db, username, target) {
  return stampOf(db.prepare("SELECT updated_at, origin_node_id FROM canvas_shortcut_conversation_marks WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ?").get(username, target.projectId, target.engine, target.sessionId));
}
function markBinding(db, username, binding, stamp) {
  db.prepare(`INSERT INTO canvas_shortcut_binding_marks (username, binding, updated_at, origin_node_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(username, binding) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id`).run(username, binding, stamp.updatedAt, stamp.originNodeId);
}
function markConversation(db, username, target, stamp) {
  db.prepare(`INSERT INTO canvas_shortcut_conversation_marks (username, project_id, engine, session_id, updated_at, origin_node_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(username, project_id, engine, session_id) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id`).run(username, target.projectId, target.engine, target.sessionId, stamp.updatedAt, stamp.originNodeId);
}
function claimBinding(db, username, binding, stamp) {
  if (!wins(stamp, bindingMark(db, username, binding))) return false;
  markBinding(db, username, binding, stamp);
  db.prepare("DELETE FROM canvas_shortcuts WHERE username = ? AND binding = ?").run(username, binding);
  return true;
}
function claimConversation(db, username, target, stamp) {
  if (!wins(stamp, conversationMark(db, username, target))) return false;
  markConversation(db, username, target, stamp);
  db.prepare("DELETE FROM canvas_shortcuts WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ?").run(username, target.projectId, target.engine, target.sessionId);
  return true;
}
function applyAssignment(db, username, binding, target, stamp) {
  const claimedKey = claimBinding(db, username, binding, stamp);
  const claimedConversation = claimConversation(db, username, target, stamp);
  if (!claimedKey || !claimedConversation) return;
  db.prepare(`INSERT INTO canvas_shortcuts (username, binding, project_id, engine, session_id, updated_at, origin_node_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(username, binding, target.projectId, target.engine, target.sessionId, stamp.updatedAt, stamp.originNodeId);
}
function applyRelease(db, username, binding, target, stamp) {
  if (binding) claimBinding(db, username, binding, stamp);
  if (target) claimConversation(db, username, target, stamp);
}
function publish(db, operation, username, binding, target, stamp) {
  const subject = binding ?? `${target.projectId}/${target.engine}/${target.sessionId}`;
  enqueueReplicationEvent(db, {
    originNodeId: stamp.originNodeId,
    entityType: "canvas.shortcut",
    entityKey: `${username}:${subject}`,
    operation,
    payload: { username, ...binding ? { binding } : {}, ...target ?? {}, updatedAt: stamp.updatedAt, originNodeId: stamp.originNodeId }
  });
}
function setCanvasShortcut(username, binding, target, originNodeId) {
  const key = canonicalCanvasBinding(binding);
  if (!target.projectId || !target.sessionId) throw new Error("A canvas binding needs a conversation");
  const db = shortcutDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const stamp = nextStamp(db, originNodeId);
    applyAssignment(db, username, key, target, stamp);
    publish(db, "upsert", username, key, target, stamp);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return listCanvasShortcuts(username);
}
function clearCanvasShortcut(username, binding, originNodeId) {
  const key = canonicalCanvasBinding(binding);
  const db = shortcutDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const held = db.prepare("SELECT project_id, engine, session_id FROM canvas_shortcuts WHERE username = ? AND binding = ?").get(username, key);
    const target = held ? { projectId: held.project_id, engine: held.engine, sessionId: held.session_id } : null;
    const stamp = nextStamp(db, originNodeId);
    applyRelease(db, username, key, target, stamp);
    publish(db, "delete", username, key, target, stamp);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return listCanvasShortcuts(username);
}
function releaseCanvasShortcuts(username, targets, originNodeId) {
  const db = shortcutDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const target of targets) {
      const stamp = nextStamp(db, originNodeId);
      applyRelease(db, username, null, target, stamp);
      publish(db, "delete", username, null, target, stamp);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return listCanvasShortcuts(username);
}
function shortcutPayload(event) {
  const value = event.payload;
  const assignment = event.operation === "upsert";
  const named = typeof value?.projectId === "string" && value.projectId.length > 0 && isHarnessId(value?.engine) && typeof value?.sessionId === "string" && value.sessionId.length > 0;
  const valid = event.entityType === "canvas.shortcut" && ["upsert", "delete"].includes(event.operation) && value && typeof value === "object" && !Array.isArray(value) && typeof value.username === "string" && value.username.length > 0 && (value.binding === void 0 || canonicalCanvasKeyToken(value.binding) === value.binding) && typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)) && typeof value.originNodeId === "string" && value.originNodeId === event.originNodeId && event.entityKey === `${value.username}:${value.binding ?? `${value.projectId}/${value.engine}/${value.sessionId}`}` && (assignment ? named && typeof value.binding === "string" : named || value.projectId === void 0 && value.engine === void 0 && value.sessionId === void 0 && typeof value.binding === "string");
  if (!valid) throw new Error("Malformed canvas shortcut replication payload");
  return value;
}
function applyCanvasShortcutEvent(db, event) {
  const payload = shortcutPayload(event);
  ensureCanvasShortcutSchema(db);
  const stamp = { updatedAt: new Date(payload.updatedAt).toISOString(), originNodeId: payload.originNodeId };
  const target = payload.projectId ? { projectId: resolveProjectAlias(db, payload.projectId), engine: payload.engine, sessionId: payload.sessionId } : null;
  if (event.operation === "delete") applyRelease(db, payload.username, payload.binding ?? null, target, stamp);
  else applyAssignment(db, payload.username, payload.binding, target, stamp);
}
export {
  applyCanvasShortcutEvent,
  canonicalCanvasBinding,
  clearCanvasShortcut,
  ensureCanvasShortcutSchema,
  listCanvasShortcuts,
  releaseCanvasShortcuts,
  setCanvasShortcut
};
