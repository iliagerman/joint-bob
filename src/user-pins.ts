import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { enqueueReplicationEvent, ensureReplicationSchema, resolveProjectAlias, type ReplicationEvent } from "./replication.js";
import type { ConversationEngine } from "./conversation-ownership.js";
import { isHarnessId } from "./types.js";

export type UserPinTarget =
  | { kind: "project"; projectId: string }
  | { kind: "conversation"; projectId: string; engine: ConversationEngine; sessionId: string };

export interface UserPins {
  projectIds: string[];
  conversations: Array<{ projectId: string; engine: ConversationEngine; sessionId: string }>;
}

interface PinPayload {
  username: string;
  kind: UserPinTarget["kind"];
  projectId: string;
  engine?: ConversationEngine;
  sessionId?: string;
  pinned: boolean;
  updatedAt: string;
  originNodeId: string;
}

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
let database: DatabaseSync | undefined;

export function ensureUserPinSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS user_pins (
    username TEXT NOT NULL COLLATE NOCASE,
    kind TEXT NOT NULL CHECK (kind IN ('project', 'conversation')),
    project_id TEXT NOT NULL,
    engine TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
    updated_at TEXT NOT NULL,
    origin_node_id TEXT NOT NULL,
    PRIMARY KEY (username, kind, project_id, engine, session_id)
  );`);
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_pins'").get() as { sql: string } | undefined;
  if (!row?.sql.includes("engine IN ('', 'pi', 'claude')")) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE user_pins RENAME TO user_pins_old");
    db.exec("CREATE TABLE user_pins (username TEXT NOT NULL COLLATE NOCASE, kind TEXT NOT NULL CHECK (kind IN ('project', 'conversation')), project_id TEXT NOT NULL, engine TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)), updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY (username, kind, project_id, engine, session_id)); INSERT INTO user_pins SELECT * FROM user_pins_old; DROP TABLE user_pins_old;");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function pinDatabase(): DatabaseSync {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(path.join(dataDir, "node.db"));
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensureUserPinSchema(database);
  ensureReplicationSchema(database);
  return database;
}

function targetParts(target: UserPinTarget): { engine: string; sessionId: string } {
  return target.kind === "conversation"
    ? { engine: target.engine, sessionId: target.sessionId }
    : { engine: "", sessionId: "" };
}

function entityKey(username: string, target: UserPinTarget): string {
  const { engine, sessionId } = targetParts(target);
  return `${username}:${target.kind}:${target.projectId}:${engine}:${sessionId}`;
}

function nextUpdatedAt(db: DatabaseSync, username: string, target: UserPinTarget): string {
  const { engine, sessionId } = targetParts(target);
  const current = db.prepare("SELECT updated_at FROM user_pins WHERE username = ? AND kind = ? AND project_id = ? AND engine = ? AND session_id = ?")
    .get(username, target.kind, target.projectId, engine, sessionId) as { updated_at: string } | undefined;
  const now = Date.now();
  return new Date(Math.max(now, current ? Date.parse(current.updated_at) + 1 : now)).toISOString();
}

function applyPin(db: DatabaseSync, payload: PinPayload): void {
  const projectId = resolveProjectAlias(db, payload.projectId);
  const engine = payload.kind === "conversation" ? payload.engine! : "";
  const sessionId = payload.kind === "conversation" ? payload.sessionId! : "";
  const current = db.prepare("SELECT updated_at, origin_node_id FROM user_pins WHERE username = ? AND kind = ? AND project_id = ? AND engine = ? AND session_id = ?")
    .get(payload.username, payload.kind, projectId, engine, sessionId) as { updated_at: string; origin_node_id: string } | undefined;
  if (current && `${payload.updatedAt}\n${payload.originNodeId}` <= `${current.updated_at}\n${current.origin_node_id}`) return;
  db.prepare(`INSERT INTO user_pins (username, kind, project_id, engine, session_id, pinned, updated_at, origin_node_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(username, kind, project_id, engine, session_id) DO UPDATE SET
      pinned = excluded.pinned, updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id`)
    .run(payload.username, payload.kind, projectId, engine, sessionId, payload.pinned ? 1 : 0, payload.updatedAt, payload.originNodeId);
}

export function setUserPin(username: string, target: UserPinTarget, pinned: boolean, originNodeId: string): UserPins {
  const db = pinDatabase();
  const updatedAt = nextUpdatedAt(db, username, target);
  const payload: PinPayload = { username, ...target, pinned, updatedAt, originNodeId };
  db.exec("BEGIN IMMEDIATE");
  try {
    applyPin(db, payload);
    enqueueReplicationEvent(db, {
      originNodeId,
      entityType: "user.pin",
      entityKey: entityKey(username, target),
      operation: pinned ? "upsert" : "delete",
      payload,
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return listUserPins(username);
}

export function listUserPins(username: string): UserPins {
  const rows = pinDatabase().prepare("SELECT kind, project_id, engine, session_id FROM user_pins WHERE username = ? AND pinned = 1 ORDER BY kind, project_id, engine, session_id")
    .all(username) as unknown as Array<{ kind: UserPinTarget["kind"]; project_id: string; engine: ConversationEngine | ""; session_id: string }>;
  return {
    projectIds: rows.filter((row) => row.kind === "project").map((row) => row.project_id),
    conversations: rows.filter((row) => row.kind === "conversation").map((row) => ({ projectId: row.project_id, engine: row.engine as ConversationEngine, sessionId: row.session_id })),
  };
}

function pinPayload(event: ReplicationEvent): PinPayload {
  const value = event.payload as Partial<PinPayload>;
  const conversation = value?.kind === "conversation";
  const valid = event.entityType === "user.pin" && ["upsert", "delete"].includes(event.operation)
    && value && typeof value === "object" && !Array.isArray(value)
    && typeof value.username === "string" && value.username.length > 0 && value.username.length <= 80
    && ["project", "conversation"].includes(value.kind ?? "")
    && typeof value.projectId === "string" && value.projectId.length > 0 && value.projectId.length <= 120
    && (conversation ? isHarnessId(value.engine) && typeof value.sessionId === "string" && value.sessionId.length > 0 && value.sessionId.length <= 240 : value.engine === undefined && value.sessionId === undefined)
    && typeof value.pinned === "boolean" && value.pinned === (event.operation === "upsert")
    && typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))
    && typeof value.originNodeId === "string" && value.originNodeId === event.originNodeId;
  if (!valid) throw new Error("Malformed user pin replication payload");
  const target = conversation
    ? { kind: "conversation" as const, projectId: value.projectId!, engine: value.engine!, sessionId: value.sessionId! }
    : { kind: "project" as const, projectId: value.projectId! };
  if (event.entityKey !== entityKey(value.username!, target)) throw new Error("Malformed user pin replication payload");
  return value as PinPayload;
}

export function applyUserPinEvent(db: DatabaseSync, event: ReplicationEvent): void {
  ensureUserPinSchema(db);
  applyPin(db, pinPayload(event));
}
