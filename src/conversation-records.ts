import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConversationEngine } from "./conversation-ownership.js";

export interface ConversationRecord {
  projectId: string;
  engine: ConversationEngine;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
let databasePromise: Promise<DatabaseSync> | undefined;

async function database(): Promise<DatabaseSync> {
  if (!databasePromise) databasePromise = (async () => {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_records (
      project_id TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine IN ('pi', 'claude')), session_id TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, engine, session_id)
    )`);
    return db;
  })();
  return databasePromise;
}

function row(record: Record<string, unknown>): ConversationRecord {
  return { projectId: String(record.project_id), engine: record.engine as ConversationEngine, sessionId: String(record.session_id), createdAt: String(record.created_at), updatedAt: String(record.updated_at) };
}

export async function ensureConversationRecord(projectId: string, engine: ConversationEngine, sessionId: string): Promise<ConversationRecord> {
  const db = await database();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO conversation_records (project_id, engine, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id, engine, session_id) DO UPDATE SET updated_at = excluded.updated_at`).run(projectId, engine, sessionId, now, now);
  return row(db.prepare("SELECT * FROM conversation_records WHERE project_id = ? AND engine = ? AND session_id = ?").get(projectId, engine, sessionId) as Record<string, unknown>);
}

export async function getConversationRecord(projectId: string, engine: ConversationEngine, sessionId: string): Promise<ConversationRecord | undefined> {
  const value = (await database()).prepare("SELECT * FROM conversation_records WHERE project_id = ? AND engine = ? AND session_id = ?").get(projectId, engine, sessionId) as Record<string, unknown> | undefined;
  return value ? row(value) : undefined;
}

export async function listConversationRecords(projectId: string): Promise<ConversationRecord[]> {
  return ((await database()).prepare("SELECT * FROM conversation_records WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as Record<string, unknown>[]).map(row);
}

export async function deleteConversationRecord(projectId: string, engine: ConversationEngine, sessionId: string): Promise<boolean> {
  return (await database()).prepare("DELETE FROM conversation_records WHERE project_id = ? AND engine = ? AND session_id = ?").run(projectId, engine, sessionId).changes > 0;
}

export function conversationDraftPath(engine: ConversationEngine, sessionId: string): string {
  return `draft:${engine}:${sessionId}`;
}

export function parseConversationDraftPath(value: string | null): { engine: ConversationEngine; sessionId: string } | undefined {
  const match = value?.match(/^draft:(pi|claude):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
  return match ? { engine: match[1] as ConversationEngine, sessionId: match[2] } : undefined;
}
