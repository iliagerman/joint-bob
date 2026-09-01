import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Prompts a user sent while a Claude turn was still running. Until now the queue
 * lived only in the WebSocket connection, so a reload, a reconnect, or a restart
 * silently dropped a message the user had already sent. A row here means "handed
 * to this node, not yet handed to the agent"; the row is deleted the moment the
 * turn that carries it starts, because from then on the transcript records it.
 */

export interface QueuedPrompt {
  id: number;
  promptText: string;
  displayText: string;
}

interface QueuedPromptRow {
  id: number;
  prompt_text: string;
  display_text: string;
}

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
let database: DatabaseSync | undefined;

export function ensurePromptQueueSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_prompt_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_key TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    display_text TEXT NOT NULL,
    created_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS conversation_prompt_queue_order ON conversation_prompt_queue(queue_key, id);`);
}

function queueDatabase(): DatabaseSync {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensurePromptQueueSchema(database);
  return database;
}

function rowToPrompt(row: QueuedPromptRow): QueuedPrompt {
  return { id: row.id, promptText: row.prompt_text, displayText: row.display_text };
}

export function enqueuePrompt(queueKey: string, promptText: string, displayText: string): QueuedPrompt {
  const db = queueDatabase();
  const result = db.prepare("INSERT INTO conversation_prompt_queue (queue_key, prompt_text, display_text, created_at) VALUES (?, ?, ?, ?)")
    .run(queueKey, promptText, displayText, new Date().toISOString());
  return { id: Number(result.lastInsertRowid), promptText, displayText };
}

/** Oldest first, so a caller replays the queue in the order it was typed. */
export function listQueuedPrompts(queueKey: string): QueuedPrompt[] {
  const rows = queueDatabase().prepare("SELECT id, prompt_text, display_text FROM conversation_prompt_queue WHERE queue_key = ? ORDER BY id").all(queueKey) as unknown as QueuedPromptRow[];
  return rows.map(rowToPrompt);
}

/** Claiming a prompt is the delete itself, so two clients watching the same
 * conversation cannot both run it. Returns false when someone else took it. */
export function claimQueuedPrompt(id: number): boolean {
  return Number(queueDatabase().prepare("DELETE FROM conversation_prompt_queue WHERE id = ?").run(id).changes) > 0;
}

export function clearQueuedPrompts(queueKey: string): void {
  queueDatabase().prepare("DELETE FROM conversation_prompt_queue WHERE queue_key = ?").run(queueKey);
}

/** A new conversation only learns its real id part-way through its first turn;
 * prompts queued before that are keyed on the placeholder and move with it. */
export function rekeyQueuedPrompts(fromKey: string, toKey: string): void {
  if (fromKey === toKey) return;
  queueDatabase().prepare("UPDATE conversation_prompt_queue SET queue_key = ? WHERE queue_key = ?").run(toKey, fromKey);
}
