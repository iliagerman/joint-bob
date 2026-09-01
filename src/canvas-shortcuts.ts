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
  binding: string;
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
    );`);
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

let lastIssuedAt = 0;

function nextStamp(originNodeId: string): WriteStamp {
  lastIssuedAt = Math.max(Date.now(), lastIssuedAt + 1);
  return { updatedAt: new Date(lastIssuedAt).toISOString(), originNodeId };
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
function applyAssignment(db: DatabaseSync, username: string, binding: string, target: CanvasShortcutTarget, stamp: WriteStamp): void {
  const keyIsFree = wins(stamp, bindingMark(db, username, binding));
  const conversationIsFree = wins(stamp, conversationMark(db, username, target));
  // The registers move even when the write loses one of them, or an event delivered
  // out of order would look unopposed to a node that had already discarded it.
  if (keyIsFree) markBinding(db, username, binding, stamp);
  if (conversationIsFree) markConversation(db, username, target, stamp);
  if (!keyIsFree || !conversationIsFree) return;
  db.prepare("DELETE FROM canvas_shortcuts WHERE username = ? AND (binding = ? OR (project_id = ? AND engine = ? AND session_id = ?))")
    .run(username, binding, target.projectId, target.engine, target.sessionId);
  db.prepare(`INSERT INTO canvas_shortcuts (username, binding, project_id, engine, session_id, updated_at, origin_node_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(username, binding, target.projectId, target.engine, target.sessionId, stamp.updatedAt, stamp.originNodeId);
}

/** Frees a key, and the conversation it held when the caller knows which one. */
function applyRelease(db: DatabaseSync, username: string, binding: string, target: CanvasShortcutTarget | null, stamp: WriteStamp): void {
  if (wins(stamp, bindingMark(db, username, binding))) {
    markBinding(db, username, binding, stamp);
    db.prepare("DELETE FROM canvas_shortcuts WHERE username = ? AND binding = ?").run(username, binding);
  }
  if (!target || !wins(stamp, conversationMark(db, username, target))) return;
  markConversation(db, username, target, stamp);
  db.prepare("DELETE FROM canvas_shortcuts WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ?")
    .run(username, target.projectId, target.engine, target.sessionId);
}

function publish(db: DatabaseSync, operation: "upsert" | "delete", username: string, binding: string, target: CanvasShortcutTarget | null, stamp: WriteStamp): void {
  enqueueReplicationEvent(db, {
    originNodeId: stamp.originNodeId,
    entityType: "canvas.shortcut",
    entityKey: `${username}:${binding}`,
    operation,
    payload: { username, binding, ...(target ?? {}), updatedAt: stamp.updatedAt, originNodeId: stamp.originNodeId },
  });
}

function heldBindings(db: DatabaseSync, username: string, target: CanvasShortcutTarget): string[] {
  const rows = db
    .prepare("SELECT binding FROM canvas_shortcuts WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ?")
    .all(username, target.projectId, target.engine, target.sessionId) as unknown as Array<{ binding: string }>;
  return rows.map((row) => row.binding);
}

export function setCanvasShortcut(username: string, binding: string, target: CanvasShortcutTarget, originNodeId: string): CanvasShortcut[] {
  const key = canonicalCanvasBinding(binding);
  if (!target.projectId || !target.sessionId) throw new Error("A canvas binding needs a conversation");
  const db = shortcutDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const stamp = nextStamp(originNodeId);
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
    const stamp = nextStamp(originNodeId);
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
    for (const target of targets) {
      for (const binding of heldBindings(db, username, target)) {
        const stamp = nextStamp(originNodeId);
        applyRelease(db, username, binding, target, stamp);
        publish(db, "delete", username, binding, target, stamp);
      }
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
    && typeof value.binding === "string" && /^[0-9A-Z]$/.test(value.binding)
    && typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))
    && typeof value.originNodeId === "string" && value.originNodeId === event.originNodeId
    && event.entityKey === `${value.username}:${value.binding}`
    // A release names its conversation when the releasing node knew it, and cannot
    // name a partial one: an assignment always must.
    && (named || (!assignment && value.projectId === undefined && value.engine === undefined && value.sessionId === undefined));
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
  if (event.operation === "delete") applyRelease(db, payload.username, payload.binding, target, stamp);
  else applyAssignment(db, payload.username, payload.binding, target!, stamp);
}
