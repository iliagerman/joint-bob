import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConversationEngine } from "./conversation-ownership.js";
import { enqueueReplicationEvent, ensureReplicationSchema, type ReplicationEvent } from "./replication.js";
import { isHarnessId } from "./types.js";

export interface ConversationRecord {
  projectId: string;
  engine: ConversationEngine;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  originNodeId: string;
}

interface ConversationRecordPayload {
  projectId: string;
  engine: ConversationEngine;
  sessionId: string;
  record: ConversationRecord | null;
  updatedAt: string;
  originNodeId: string;
}

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
let databasePromise: Promise<DatabaseSync> | undefined;

function createConversationRecordTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_records (
    project_id TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (project_id, engine, session_id)
  ); CREATE TABLE IF NOT EXISTS conversation_record_tombstones (
    project_id TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY (project_id, engine, session_id)
  );`);
}

export function ensureConversationRecordSchema(db: DatabaseSync): void {
  createConversationRecordTables(db);
  const records = db.prepare("PRAGMA table_info(conversation_records)").all() as unknown as Array<{ name: string }>;
  if (!records.some((column) => column.name === "origin_node_id")) db.exec("ALTER TABLE conversation_records ADD COLUMN origin_node_id TEXT NOT NULL DEFAULT ''");
  for (const table of ["conversation_records", "conversation_record_tombstones"]) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
    if (!row?.sql.includes("engine IN ('pi', 'claude')")) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
      createConversationRecordTables(db);
      const columns = db.prepare(`PRAGMA table_info(${table}_old)`).all() as unknown as Array<{ name: string }>;
      const origin = columns.some((column) => column.name === "origin_node_id") ? "origin_node_id" : "''";
      if (table === "conversation_records") db.exec(`INSERT INTO conversation_records (project_id, engine, session_id, created_at, updated_at, origin_node_id) SELECT project_id, engine, session_id, created_at, updated_at, ${origin} FROM conversation_records_old`);
      else db.exec(`INSERT INTO conversation_record_tombstones (project_id, engine, session_id, updated_at, origin_node_id) SELECT project_id, engine, session_id, updated_at, ${origin} FROM conversation_record_tombstones_old`);
      db.exec(`DROP TABLE ${table}_old`);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
}

function publishLegacyRecords(db: DatabaseSync): void {
  const clusterNode = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cluster_node'").get()
    ? db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get() as { id: string } | undefined
    : undefined;
  if (!clusterNode) return;
  const legacy = db.prepare("SELECT * FROM conversation_records WHERE origin_node_id = ''").all() as Record<string, unknown>[];
  if (!legacy.length) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const update = db.prepare("UPDATE conversation_records SET origin_node_id = ? WHERE project_id = ? AND engine = ? AND session_id = ?");
    for (const value of legacy) {
      const record = { ...row(value), originNodeId: clusterNode.id };
      update.run(clusterNode.id, record.projectId, record.engine, record.sessionId);
      publish(db, "upsert", record.projectId, record.engine, record.sessionId, record, record.updatedAt, clusterNode.id);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

async function database(): Promise<DatabaseSync> {
  if (!databasePromise) databasePromise = (async () => {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    ensureConversationRecordSchema(db);
    ensureReplicationSchema(db);
    publishLegacyRecords(db);
    return db;
  })();
  return databasePromise;
}

function row(record: Record<string, unknown>): ConversationRecord {
  return { projectId: String(record.project_id), engine: record.engine as ConversationEngine, sessionId: String(record.session_id), createdAt: String(record.created_at), updatedAt: String(record.updated_at), originNodeId: String(record.origin_node_id) };
}

function selectRecord(db: DatabaseSync, projectId: string, engine: ConversationEngine, sessionId: string): ConversationRecord | undefined {
  const value = db.prepare("SELECT * FROM conversation_records WHERE project_id = ? AND engine = ? AND session_id = ?").get(projectId, engine, sessionId) as Record<string, unknown> | undefined;
  return value ? row(value) : undefined;
}

function publish(db: DatabaseSync, operation: "upsert" | "delete", projectId: string, engine: ConversationEngine, sessionId: string, record: ConversationRecord | null, updatedAt: string, originNodeId: string): void {
  enqueueReplicationEvent(db, { originNodeId, entityType: "conversation.record", entityKey: `${projectId}:${engine}:${sessionId}`, operation, payload: { projectId, engine, sessionId, record, updatedAt, originNodeId } });
}

export async function ensureConversationRecord(projectId: string, engine: ConversationEngine, sessionId: string, originNodeId: string): Promise<ConversationRecord> {
  const db = await database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = selectRecord(db, projectId, engine, sessionId);
    if (existing) { db.exec("COMMIT"); return existing; }
    if (db.prepare("SELECT 1 FROM conversation_record_tombstones WHERE project_id = ? AND engine = ? AND session_id = ?").get(projectId, engine, sessionId)) throw new Error("Conversation record was deleted");
    const now = new Date().toISOString();
    const record = { projectId, engine, sessionId, createdAt: now, updatedAt: now, originNodeId };
    db.prepare("INSERT INTO conversation_records (project_id, engine, session_id, created_at, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?, ?)").run(projectId, engine, sessionId, now, now, originNodeId);
    publish(db, "upsert", projectId, engine, sessionId, record, now, originNodeId);
    db.exec("COMMIT");
    return record;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function getConversationRecord(projectId: string, engine: ConversationEngine, sessionId: string): Promise<ConversationRecord | undefined> {
  return selectRecord(await database(), projectId, engine, sessionId);
}

export async function listConversationRecords(projectId: string): Promise<ConversationRecord[]> {
  return ((await database()).prepare("SELECT * FROM conversation_records WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as Record<string, unknown>[]).map(row);
}

export async function deleteConversationRecord(projectId: string, engine: ConversationEngine, sessionId: string, originNodeId: string): Promise<boolean> {
  const db = await database();
  const existing = selectRecord(db, projectId, engine, sessionId);
  const tombstone = db.prepare("SELECT 1 FROM conversation_record_tombstones WHERE project_id = ? AND engine = ? AND session_id = ?").get(projectId, engine, sessionId);
  if (!existing && tombstone) return false;
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM conversation_records WHERE project_id = ? AND engine = ? AND session_id = ?").run(projectId, engine, sessionId);
    db.prepare("INSERT INTO conversation_record_tombstones (project_id, engine, session_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, engine, session_id) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id").run(projectId, engine, sessionId, now, originNodeId);
    publish(db, "delete", projectId, engine, sessionId, null, now, originNodeId);
    db.exec("COMMIT");
    return true;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function resolveProjectAlias(db: DatabaseSync, projectId: string): string {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_aliases'").get()) return projectId;
  return (db.prepare("SELECT project_id FROM project_aliases WHERE alias_id = ?").get(projectId) as { project_id: string } | undefined)?.project_id ?? projectId;
}

function payloadFor(event: ReplicationEvent): ConversationRecordPayload {
  const value = event.payload as Partial<ConversationRecordPayload>;
  if (event.entityType !== "conversation.record" || !["upsert", "delete"].includes(event.operation) || !value || typeof value !== "object" || Array.isArray(value)
    || typeof value.projectId !== "string" || !isHarnessId(value.engine) || typeof value.sessionId !== "string" || typeof value.updatedAt !== "string" || typeof value.originNodeId !== "string" || value.originNodeId !== event.originNodeId || event.entityKey !== `${value.projectId}:${value.engine}:${value.sessionId}` || (event.operation === "upsert") !== Boolean(value.record)) throw new Error("Malformed conversation record replication payload");
  if (value.record && (value.record.projectId !== value.projectId || value.record.engine !== value.engine || value.record.sessionId !== value.sessionId || value.record.updatedAt !== value.updatedAt || value.record.originNodeId !== value.originNodeId || typeof value.record.createdAt !== "string")) throw new Error("Malformed conversation record replication payload");
  return value as ConversationRecordPayload;
}

export function applyConversationRecordEvent(db: DatabaseSync, event: ReplicationEvent): void {
  const payload = payloadFor(event);
  const projectId = resolveProjectAlias(db, payload.projectId);
  const current = db.prepare("SELECT updated_at, origin_node_id FROM conversation_records WHERE project_id = ? AND engine = ? AND session_id = ? UNION ALL SELECT updated_at, origin_node_id FROM conversation_record_tombstones WHERE project_id = ? AND engine = ? AND session_id = ? ORDER BY updated_at DESC, origin_node_id DESC LIMIT 1").get(projectId, payload.engine, payload.sessionId, projectId, payload.engine, payload.sessionId) as { updated_at: string; origin_node_id: string } | undefined;
  if (current && `${payload.updatedAt}\n${payload.originNodeId}` <= `${current.updated_at}\n${current.origin_node_id}`) return;
  if (!payload.record) {
    db.prepare("DELETE FROM conversation_records WHERE project_id = ? AND engine = ? AND session_id = ?").run(projectId, payload.engine, payload.sessionId);
    db.prepare("INSERT INTO conversation_record_tombstones (project_id, engine, session_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, engine, session_id) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id").run(projectId, payload.engine, payload.sessionId, payload.updatedAt, payload.originNodeId);
    return;
  }
  db.prepare("INSERT INTO conversation_records (project_id, engine, session_id, created_at, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, engine, session_id) DO UPDATE SET created_at = excluded.created_at, updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id").run(projectId, payload.engine, payload.sessionId, payload.record.createdAt, payload.updatedAt, payload.originNodeId);
  db.prepare("DELETE FROM conversation_record_tombstones WHERE project_id = ? AND engine = ? AND session_id = ?").run(projectId, payload.engine, payload.sessionId);
}

export function conversationDraftPath(engine: ConversationEngine, sessionId: string): string { return `draft:${engine}:${sessionId}`; }

export function parseConversationDraftPath(value: string | null): { engine: ConversationEngine; sessionId: string } | undefined {
  const match = value?.match(/^draft:([a-z][a-z0-9-]*):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/);
  return match ? { engine: match[1] as ConversationEngine, sessionId: match[2] } : undefined;
}
