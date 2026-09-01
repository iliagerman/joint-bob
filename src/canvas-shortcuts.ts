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
    CREATE TABLE IF NOT EXISTS canvas_shortcut_tombstones (
      username TEXT NOT NULL,
      binding TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      origin_node_id TEXT NOT NULL,
      PRIMARY KEY (username, binding)
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

function publish(db: DatabaseSync, operation: "upsert" | "delete", payload: ShortcutPayload): void {
  enqueueReplicationEvent(db, {
    originNodeId: payload.originNodeId,
    entityType: "canvas.shortcut",
    entityKey: `${payload.username}:${payload.binding}`,
    operation,
    payload,
  });
}

/** Drops one binding and records the release, so no node can revive it later. */
function release(db: DatabaseSync, username: string, binding: string, updatedAt: string, originNodeId: string): void {
  db.prepare("DELETE FROM canvas_shortcuts WHERE username = ? AND binding = ?").run(username, binding);
  db.prepare(`INSERT INTO canvas_shortcut_tombstones (username, binding, updated_at, origin_node_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(username, binding) DO UPDATE SET
      updated_at = MAX(canvas_shortcut_tombstones.updated_at, excluded.updated_at),
      origin_node_id = excluded.origin_node_id`).run(username, binding, updatedAt, originNodeId);
  publish(db, "delete", { username, binding, updatedAt, originNodeId });
}

function bindingsFor(db: DatabaseSync, username: string, target: CanvasShortcutTarget): string[] {
  const rows = db
    .prepare("SELECT binding FROM canvas_shortcuts WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ?")
    .all(username, target.projectId, target.engine, target.sessionId) as unknown as Array<{ binding: string }>;
  return rows.map((row) => row.binding);
}

export function setCanvasShortcut(username: string, binding: string, target: CanvasShortcutTarget, originNodeId: string): CanvasShortcut[] {
  const key = canonicalCanvasBinding(binding);
  if (!target.projectId || !target.sessionId) throw new Error("A canvas binding needs a conversation");
  const db = shortcutDatabase();
  const updatedAt = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const held of bindingsFor(db, username, target)) {
      if (held !== key) release(db, username, held, updatedAt, originNodeId);
    }
    db.prepare(`INSERT INTO canvas_shortcuts (username, binding, project_id, engine, session_id, updated_at, origin_node_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username, binding) DO UPDATE SET
        project_id = excluded.project_id, engine = excluded.engine, session_id = excluded.session_id,
        updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id`)
      .run(username, key, target.projectId, target.engine, target.sessionId, updatedAt, originNodeId);
    // A reassignment outlives an earlier release of the same key.
    db.prepare("DELETE FROM canvas_shortcut_tombstones WHERE username = ? AND binding = ?").run(username, key);
    publish(db, "upsert", { username, binding: key, ...target, updatedAt, originNodeId });
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
    release(db, username, key, new Date().toISOString(), originNodeId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return listCanvasShortcuts(username);
}

/** Frees the bindings of conversations that just left the canvas. */
export function releaseCanvasShortcuts(username: string, targets: CanvasShortcutTarget[], originNodeId: string): CanvasShortcut[] {
  const db = shortcutDatabase();
  const updatedAt = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const target of targets) {
      for (const held of bindingsFor(db, username, target)) release(db, username, held, updatedAt, originNodeId);
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
  const valid = event.entityType === "canvas.shortcut" && ["upsert", "delete"].includes(event.operation)
    && value && typeof value === "object" && !Array.isArray(value)
    && typeof value.username === "string" && value.username.length > 0
    && typeof value.binding === "string" && /^[0-9A-Z]$/.test(value.binding)
    && typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))
    && typeof value.originNodeId === "string" && value.originNodeId === event.originNodeId
    && event.entityKey === `${value.username}:${value.binding}`
    && (!assignment || (typeof value.projectId === "string" && value.projectId.length > 0
      && ["pi", "claude"].includes(value.engine ?? "")
      && typeof value.sessionId === "string" && value.sessionId.length > 0));
  if (!valid) throw new Error("Malformed canvas shortcut replication payload");
  return value as ShortcutPayload;
}

/** A total order over writes. Clocks collide, so the origin node breaks the tie and
 * every node settles on the same winner whatever order the events arrive in. */
interface WriteStamp {
  updatedAt: string;
  originNodeId: string;
}

function wins(candidate: WriteStamp, held: WriteStamp | undefined): boolean {
  if (!held) return true;
  if (candidate.updatedAt !== held.updatedAt) return candidate.updatedAt > held.updatedAt;
  return candidate.originNodeId > held.originNodeId;
}

function stampOf(row: { updated_at: string; origin_node_id: string } | undefined): WriteStamp | undefined {
  return row ? { updatedAt: row.updated_at, originNodeId: row.origin_node_id } : undefined;
}

function tombstoneStamp(db: DatabaseSync, username: string, binding: string): WriteStamp | undefined {
  return stampOf(db.prepare("SELECT updated_at, origin_node_id FROM canvas_shortcut_tombstones WHERE username = ? AND binding = ?")
    .get(username, binding) as { updated_at: string; origin_node_id: string } | undefined);
}

function bindingStamp(db: DatabaseSync, username: string, binding: string): WriteStamp | undefined {
  return stampOf(db.prepare("SELECT updated_at, origin_node_id FROM canvas_shortcuts WHERE username = ? AND binding = ?")
    .get(username, binding) as { updated_at: string; origin_node_id: string } | undefined);
}

function raiseTombstone(db: DatabaseSync, username: string, binding: string, stamp: WriteStamp): void {
  if (!wins(stamp, tombstoneStamp(db, username, binding))) return;
  db.prepare(`INSERT INTO canvas_shortcut_tombstones (username, binding, updated_at, origin_node_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(username, binding) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id`)
    .run(username, binding, stamp.updatedAt, stamp.originNodeId);
}

export function applyCanvasShortcutEvent(db: DatabaseSync, event: ReplicationEvent): void {
  const payload = shortcutPayload(event);
  ensureCanvasShortcutSchema(db);
  const stamp: WriteStamp = { updatedAt: new Date(payload.updatedAt).toISOString(), originNodeId: payload.originNodeId };
  if (event.operation === "delete") {
    raiseTombstone(db, payload.username, payload.binding, stamp);
    if (!wins(bindingStamp(db, payload.username, payload.binding) ?? stamp, stamp)) {
      db.prepare("DELETE FROM canvas_shortcuts WHERE username = ? AND binding = ?").run(payload.username, payload.binding);
    }
    return;
  }
  if (!wins(stamp, tombstoneStamp(db, payload.username, payload.binding))) return;
  if (!wins(stamp, bindingStamp(db, payload.username, payload.binding))) return;
  const projectId = resolveProjectAlias(db, payload.projectId!);
  // One conversation holds one binding. Two nodes can bind it at once, so the newest
  // assignment wins and the keys it displaces are tombstoned rather than merely deleted,
  // or the assignment they replaced would reappear when it arrives late.
  const held = db.prepare("SELECT binding, updated_at, origin_node_id FROM canvas_shortcuts WHERE username = ? AND project_id = ? AND engine = ? AND session_id = ? AND binding <> ?")
    .all(payload.username, projectId, payload.engine!, payload.sessionId!, payload.binding) as unknown as Array<{ binding: string; updated_at: string; origin_node_id: string }>;
  if (held.some((row) => !wins(stamp, stampOf(row)))) return;
  for (const row of held) {
    db.prepare("DELETE FROM canvas_shortcuts WHERE username = ? AND binding = ?").run(payload.username, row.binding);
    raiseTombstone(db, payload.username, row.binding, stamp);
  }
  db.prepare(`INSERT INTO canvas_shortcuts (username, binding, project_id, engine, session_id, updated_at, origin_node_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(username, binding) DO UPDATE SET
      project_id = excluded.project_id, engine = excluded.engine, session_id = excluded.session_id,
      updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id`)
    .run(payload.username, payload.binding, projectId, payload.engine!, payload.sessionId!, stamp.updatedAt, stamp.originNodeId);
  db.prepare("DELETE FROM canvas_shortcut_tombstones WHERE username = ? AND binding = ?").run(payload.username, payload.binding);
}
