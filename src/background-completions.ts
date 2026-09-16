import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-directory.js";
import { supervisorDatabaseFile } from "./background-tasks.js";

export interface CompletionRecord {
  taskId: string;
  projectId: string;
  conversationId: string;
  status: string;
  createdAt: string;
  deliveryState: "pending" | "queued" | "blocked";
  targetNodeId: string | null;
  error: string | null;
}

let database: DatabaseSync | undefined;
let cursor = 0;

function openNodeDatabase(dataDirectory = resolveDataDirectory()): DatabaseSync {
  if (database) return database;
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const opened = new DatabaseSync(path.join(dataDirectory, "node.db"));
  try {
    opened.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS background_completion_outbox(
        task_id TEXT PRIMARY KEY, identity TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
        delivery_state TEXT NOT NULL DEFAULT 'pending', target_node_id TEXT, error TEXT,
        next_attempt_at INTEGER NOT NULL DEFAULT 0);`);
    database = opened;
    return opened;
  } catch (error) { opened.close(); throw error; }
}

export function parseCompletionIdentity(value: string): [string, string] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === 2 && parsed.every((part) => typeof part === "string" && part.length > 0 && part.length <= 200)
      ? parsed as [string, string]
      : null;
  } catch { return null; }
}

export function ingestBackgroundCompletions(dataDirectory = resolveDataDirectory()): number {
  const file = supervisorDatabaseFile(dataDirectory);
  if (!file) { cursor = 0; return 0; }
  const source = new DatabaseSync(file, { readOnly: true });
  try {
    source.exec("PRAGMA busy_timeout=5000");
    const rows = source.prepare(`SELECT c.rowid AS row_id,c.task_id,c.created_at,t.identity,t.status
      FROM supervisor_completions c JOIN supervisor_tasks t ON t.id=c.task_id
      WHERE c.rowid>? ORDER BY c.rowid LIMIT 100`).all(cursor) as unknown as Array<{ row_id: number; task_id: string; created_at: string; identity: string; status: string }>;
    if (!rows.length) { cursor = 0; return 0; }
    const db = openNodeDatabase(dataDirectory);
    db.exec("BEGIN IMMEDIATE");
    try {
      const insert = db.prepare("INSERT OR IGNORE INTO background_completion_outbox(task_id,identity,status,created_at) VALUES(?,?,?,?)");
      for (const row of rows) {
        const identity = parseCompletionIdentity(row.identity);
        if (identity && identity[0] !== "system:update") insert.run(row.task_id, row.identity, row.status, row.created_at);
      }
      db.exec("COMMIT");
      cursor = rows.at(-1)!.row_id;
      return rows.length;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { source.close(); }
}

function record(row: Record<string, unknown>): CompletionRecord | null {
  const identity = parseCompletionIdentity(String(row.identity));
  if (!identity) return null;
  return { taskId: String(row.task_id), projectId: identity[0], conversationId: identity[1], status: String(row.status), createdAt: String(row.created_at), deliveryState: row.delivery_state as CompletionRecord["deliveryState"], targetNodeId: row.target_node_id === null ? null : String(row.target_node_id), error: row.error === null ? null : String(row.error) };
}

export function pendingBackgroundCompletions(limit = 20): CompletionRecord[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Invalid completion limit");
  return (openNodeDatabase().prepare("SELECT * FROM background_completion_outbox WHERE delivery_state!='queued' AND next_attempt_at<=? ORDER BY next_attempt_at,created_at LIMIT ?").all(Date.now(), limit) as Record<string, unknown>[]).map(record).filter((value): value is CompletionRecord => value !== null);
}

export function setBackgroundCompletionDelivery(taskId: string, state: "queued" | "blocked", targetNodeId: string | null, error: string | null): void {
  openNodeDatabase().prepare("UPDATE background_completion_outbox SET delivery_state=?,target_node_id=?,error=?,next_attempt_at=? WHERE task_id=?").run(state, targetNodeId, error?.slice(0, 200) ?? null, state === "queued" ? 0 : Date.now() + 5000, taskId);
}

export function getDeliveryStatus(taskId: string): CompletionRecord | null {
  const row = openNodeDatabase().prepare("SELECT * FROM background_completion_outbox WHERE task_id=?").get(taskId) as Record<string, unknown> | undefined;
  return row ? record(row) : null;
}

export function closeBackgroundCompletionStore(): void { database?.close(); database = undefined; cursor = 0; }
