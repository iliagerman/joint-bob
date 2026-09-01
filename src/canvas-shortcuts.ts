import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConversationEngine } from "./conversation-ownership.js";
import { enqueueReplicationEvent, ensureReplicationSchema, resolveProjectAlias, type ReplicationEvent } from "./replication.js";

/**
 * Keyboard bindings that jump to one canvas conversation. A binding belongs to an
 * account, not to a node: user ids are node-local, so rows are keyed by username and
 * replicate across the cluster the way review watermarks do. Two accounts on the same
 * node never see each other's bindings.
 *
 * A binding is a slot and a conversation holds at most one of them, so assigning
 * either one releases whatever it displaces. Releases are tombstoned, so a release
 * that reaches a node before the assignment it replaced is not undone by it.
 */
export interface CanvasShortcutTarget {
  projectId: string;
  engine: ConversationEngine;
  sessionId: string;
}

export interface CanvasShortcut extends CanvasShortcutTarget {
  binding: string;
  updatedAt: string;
}

interface ShortcutRow {
  binding: string;
  project_id: string;
  engine: ConversationEngine;
  session_id: string;
  updated_at: string;
}

interface ShortcutPayload {
  username: string;
  binding?: string;
  projectId?: string;
  engine?: ConversationEngine;
  sessionId?: string;
  updatedAt: string;
  originNodeId: string;
}

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
let database: DatabaseSync | undefined;

/**
 * Two last-writer-wins registers decide everything. One marks the newest write that
 * touched a key, the other the newest write that touched a conversation. A row exists
 * only where an assignment won both, so nodes agree on the bindings no matter what
 * order the events reach them in - a release delivered before the assignment it
 * replaced still wins, and so does a key move whose first half arrives last.
 */
export function ensureCanvasShortcutSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS canvas_shortcuts (
      username TEXT NOT NULL,
      binding TEXT NOT NULL,
      project_id TEXT NOT NULL,
      engine TEXT NOT NULL CHECK(engine IN ('pi', 'claude')),
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
  carryOldStateIntoRegisters(db);
}

/** The stamp comparison of `wins()`, written as a SQL upsert guard. */
const KEEPS_THE_NEWER = (table: string) => `updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id
  WHERE excluded.updated_at > ${table}.updated_at
    OR (excluded.updated_at = ${table}.updated_at AND excluded.origin_node_id > ${table}.origin_node_id)`;

/**
 * Makes any older database describe itself in the registers' terms. Bindings written
 * before the registers existed would otherwise look unopposed, and a build that let a
 * register move past a row it should have cleared could leave that row behind forever.
 * Every step is idempotent, so this runs on each open.
 */
function carryOldStateIntoRegisters(db: DatabaseSync): void {
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
  // A binding is real only while its stamp is what both registers still hold.
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

/** A clock starting at zero could reissue a stamp the registers already carry, so a
 * database that has never had one starts from the newest write it knows about. */
function seedClock(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM canvas_shortcut_clock WHERE singleton = 1").get()) return;
  const rows = db.prepare(`SELECT MAX(updated_at) AS newest FROM (
      SELECT updated_at FROM canvas_shortcut_binding_marks
      UNION ALL SELECT updated_at FROM canvas_shortcut_conversation_marks
      UNION ALL SELECT updated_at FROM canvas_shortcuts
    )`).get() as { newest: string | null } | undefined;
  const newest = rows?.newest ? Date.parse(rows.newest) : 0;
  db.prepare("INSERT INTO canvas_shortcut_clock (singleton, last_issued_at) VALUES (1, ?)")
    .run(Number.isFinite(newest) ? newest : 0);
}

function shortcutDatabase(): DatabaseSync {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensureCanvasShortcutSchema(database);
  ensureReplicationSchema(database);
  return database;
}

/** One digit or letter, stored upper case so `b` and `B` are the same key. */
export function canonicalCanvasBinding(binding: string): string {
  const canonical = String(binding).toUpperCase();
  if (!/^[0-9A-Z]$/.test(canonical)) throw new Error("A canvas binding is one digit or letter");
  return canonical;
}

function rowToShortcut(row: ShortcutRow): CanvasShortcut {
  return { binding: row.binding, projectId: row.project_id, engine: row.engine, sessionId: row.session_id, updatedAt: row.updated_at };
}

export function listCanvasShortcuts(username: string): CanvasShortcut[] {
  const rows = shortcutDatabase()
    .prepare("SELECT binding, project_id, engine, session_id, updated_at FROM canvas_shortcuts WHERE username = ? ORDER BY binding")
    .all(username) as unknown as ShortcutRow[];
  return rows.map(rowToShortcut);
}

/** A total order over writes. Two nodes are separated by their id; one node never
 * issues the same instant twice, so no two writes anywhere compare equal. */
interface WriteStamp {
  updatedAt: string;
  originNodeId: string;
}

/** The clock is persisted, not just remembered: a restart inside the same millisecond,
 * or a clock that steps back, must never let this node issue a stamp twice. */
function nextStamp(db: DatabaseSync, originNodeId: string): WriteStamp {
  const previous = (db.prepare("SELECT last_issued_at FROM canvas_shortcut_clock WHERE singleton = 1").get() as { last_issued_at: number } | undefined)?.last_issued_at ?? 0;
  const issued = Math.max(Date.now(), previous + 1);
  db.prepare(`INSERT INTO canvas_shortcut_clock (singleton, last_issued_at) VALUES (1, ?)
    ON CONFLICT(singleton) DO UPDATE SET last_issued_at = excluded.last_issued_at`).run(issued);
  return { updatedAt: new Date(issued).toISOString(), originNodeId };
}

function wins(candidate: WriteStamp, held: WriteStamp | undefined): boolean {
  if (!held) return true;
  if (candidate.updatedAt !== held.updatedAt) return candidate.updatedAt > held.updatedAt;
  return candidate.originNodeId > held.originNodeId;
}

function stampOf(row: { updated_at: string; origin_node_id: string } | undefined): WriteStamp | undefined {
  return row ? { updatedAt: row.updated_at, originNodeId: row.origin_node_id } : undefined;
}

function bindingMark(db: DatabaseSync, username: string, binding: string): WriteStamp | undefined {
  return stampOf(db.prepare("SELECT updated_at, origin_node_id FROM canvas_shortcut_binding_marks WHERE username = ? AND binding = ?")
    .get(username, binding) as { updated_at: string; origin_node_id: string } | undefined);
}

function conversationMark(db: DatabaseSync, username: string, target: CanvasShortcutTarget): WriteStamp | undefined {
  return stampOf(db.prepare("SELECT updated_at, origin_node_id FROM canvas_shortcut_conversation_marks WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ?")
    .get(username, target.projectId, target.engine, target.sessionId) as { updated_at: string; origin_node_id: string } | undefined);
}

function markBinding(db: DatabaseSync, username: string, binding: string, stamp: WriteStamp): void {
  db.prepare(`INSERT INTO canvas_shortcut_binding_marks (username, binding, updated_at, origin_node_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(username, binding) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id`)
    .run(username, binding, stamp.updatedAt, stamp.originNodeId);
}

function markConversation(db: DatabaseSync, username: string, target: CanvasShortcutTarget, stamp: WriteStamp): void {
  db.prepare(`INSERT INTO canvas_shortcut_conversation_marks (username, project_id, engine, session_id, updated_at, origin_node_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(username, project_id, engine, session_id) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id`)
    .run(username, target.projectId, target.engine, target.sessionId, stamp.updatedAt, stamp.originNodeId);
}

/** Binds one key to one conversation, displacing whatever either of them held. */
function claimBinding(db: DatabaseSync, username: string, binding: string, stamp: WriteStamp): boolean {
  if (!wins(stamp, bindingMark(db, username, binding))) return false;
  markBinding(db, username, binding, stamp);
  // Advancing a register always clears what it made stale, even when the write goes on
  // to lose its other register. Leaving the row behind is what made the result depend
  // on the order the events arrived in.
  db.prepare("DELETE FROM canvas_shortcuts WHERE username = ? AND binding = ?").run(username, binding);
  return true;
}

function claimConversation(db: DatabaseSync, username: string, target: CanvasShortcutTarget, stamp: WriteStamp): boolean {
  if (!wins(stamp, conversationMark(db, username, target))) return false;
  markConversation(db, username, target, stamp);
  db.prepare("DELETE FROM canvas_shortcuts WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ?")
    .run(username, target.projectId, target.engine, target.sessionId);
  return true;
}

function applyAssignment(db: DatabaseSync, username: string, binding: string, target: CanvasShortcutTarget, stamp: WriteStamp): void {
  const claimedKey = claimBinding(db, username, binding, stamp);
  const claimedConversation = claimConversation(db, username, target, stamp);
  if (!claimedKey || !claimedConversation) return;
  db.prepare(`INSERT INTO canvas_shortcuts (username, binding, project_id, engine, session_id, updated_at, origin_node_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(username, binding, target.projectId, target.engine, target.sessionId, stamp.updatedAt, stamp.originNodeId);
}

/** Frees a key, a conversation, or both - whichever the release names. */
function applyRelease(db: DatabaseSync, username: string, binding: string | null, target: CanvasShortcutTarget | null, stamp: WriteStamp): void {
  if (binding) claimBinding(db, username, binding, stamp);
  if (target) claimConversation(db, username, target, stamp);
}

/** A release may name only the conversation, so the key is not always the identity. */
function publish(db: DatabaseSync, operation: "upsert" | "delete", username: string, binding: string | null, target: CanvasShortcutTarget | null, stamp: WriteStamp): void {
  const subject = binding ?? `${target!.projectId}/${target!.engine}/${target!.sessionId}`;
  enqueueReplicationEvent(db, {
    originNodeId: stamp.originNodeId,
    entityType: "canvas.shortcut",
    entityKey: `${username}:${subject}`,
    operation,
    payload: { username, ...(binding ? { binding } : {}), ...(target ?? {}), updatedAt: stamp.updatedAt, originNodeId: stamp.originNodeId },
  });
}

export function setCanvasShortcut(username: string, binding: string, target: CanvasShortcutTarget, originNodeId: string): CanvasShortcut[] {
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

export function clearCanvasShortcut(username: string, binding: string, originNodeId: string): CanvasShortcut[] {
  const key = canonicalCanvasBinding(binding);
  const db = shortcutDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const held = db.prepare("SELECT project_id, engine, session_id FROM canvas_shortcuts WHERE username = ? AND binding = ?")
      .get(username, key) as { project_id: string; engine: ConversationEngine; session_id: string } | undefined;
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

/** Frees the keys of conversations that just left the canvas. Naming the conversation
 * rather than the key is what makes this safe when another node moved that key. */
export function releaseCanvasShortcuts(username: string, targets: CanvasShortcutTarget[], originNodeId: string): CanvasShortcut[] {
  const db = shortcutDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    // Named by conversation, never by key: this node may not have heard yet that
    // another one bound it, and the release still has to overtake that assignment.
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

function shortcutPayload(event: ReplicationEvent): ShortcutPayload {
  const value = event.payload as Partial<ShortcutPayload>;
  const assignment = event.operation === "upsert";
  const named = typeof value?.projectId === "string" && value.projectId.length > 0
    && ["pi", "claude"].includes(value?.engine ?? "")
    && typeof value?.sessionId === "string" && value.sessionId.length > 0;
  const valid = event.entityType === "canvas.shortcut" && ["upsert", "delete"].includes(event.operation)
    && value && typeof value === "object" && !Array.isArray(value)
    && typeof value.username === "string" && value.username.length > 0
    && (value.binding === undefined || (typeof value.binding === "string" && /^[0-9A-Z]$/.test(value.binding)))
    && typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))
    && typeof value.originNodeId === "string" && value.originNodeId === event.originNodeId
    && event.entityKey === `${value.username}:${value.binding ?? `${value.projectId}/${value.engine}/${value.sessionId}`}`
    // A release names a key, a conversation, or both, and never a partial conversation.
    // An assignment must always name both.
    && (assignment
      ? named && typeof value.binding === "string"
      : (named || (value.projectId === undefined && value.engine === undefined && value.sessionId === undefined && typeof value.binding === "string")));
  if (!valid) throw new Error("Malformed canvas shortcut replication payload");
  return value as ShortcutPayload;
}

export function applyCanvasShortcutEvent(db: DatabaseSync, event: ReplicationEvent): void {
  const payload = shortcutPayload(event);
  ensureCanvasShortcutSchema(db);
  const stamp: WriteStamp = { updatedAt: new Date(payload.updatedAt).toISOString(), originNodeId: payload.originNodeId };
  const target = payload.projectId
    ? { projectId: resolveProjectAlias(db, payload.projectId), engine: payload.engine!, sessionId: payload.sessionId! }
    : null;
  if (event.operation === "delete") applyRelease(db, payload.username, payload.binding ?? null, target, stamp);
  else applyAssignment(db, payload.username, payload.binding!, target!, stamp);
}
