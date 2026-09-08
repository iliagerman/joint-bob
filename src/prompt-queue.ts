import { mkdirSync } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
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
  messageText: string | null;
  promptSuffix: string | null;
  displaySuffix: string | null;
  attachmentPaths: string[];
}

interface QueuedPromptRow {
  id: number;
  prompt_text: string;
  display_text: string;
  message_text: string | null;
  prompt_suffix: string | null;
  display_suffix: string | null;
  attachment_paths: string | null;
}

const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
let database: DatabaseSync | undefined;

export function ensurePromptQueueSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_prompt_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_key TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    display_text TEXT NOT NULL,
    message_text TEXT,
    prompt_suffix TEXT,
    display_suffix TEXT,
    attachment_paths TEXT,
    created_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS conversation_prompt_queue_order ON conversation_prompt_queue(queue_key, id);`);
  const columns = new Set((db.prepare("PRAGMA table_info(conversation_prompt_queue)").all() as Array<{ name: string }>).map((column) => column.name));
  for (const column of ["message_text", "prompt_suffix", "display_suffix", "attachment_paths"]) {
    if (!columns.has(column)) db.exec(`ALTER TABLE conversation_prompt_queue ADD COLUMN ${column} TEXT`);
  }
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
  return {
    id: row.id,
    promptText: row.prompt_text,
    displayText: row.display_text,
    messageText: row.message_text,
    promptSuffix: row.prompt_suffix,
    displaySuffix: row.display_suffix,
    attachmentPaths: row.attachment_paths ? JSON.parse(row.attachment_paths) as string[] : [],
  };
}

interface QueuedPromptMetadata {
  messageText: string;
  promptSuffix: string;
  displaySuffix: string;
  attachmentPaths: string[];
}

export function enqueuePrompt(queueKey: string, promptText: string, displayText: string, metadata: QueuedPromptMetadata): QueuedPrompt {
  const db = queueDatabase();
  const result = db.prepare(`INSERT INTO conversation_prompt_queue
    (queue_key, prompt_text, display_text, message_text, prompt_suffix, display_suffix, attachment_paths, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      queueKey, promptText, displayText, metadata.messageText, metadata.promptSuffix,
      metadata.displaySuffix, JSON.stringify(metadata.attachmentPaths), new Date().toISOString(),
    );
  return { id: Number(result.lastInsertRowid), promptText, displayText, ...metadata };
}

/** Oldest first, so a caller replays the queue in the order it was typed. */
export function listQueuedPrompts(queueKey: string): QueuedPrompt[] {
  const rows = queueDatabase().prepare(`SELECT id, prompt_text, display_text, message_text, prompt_suffix, display_suffix, attachment_paths
    FROM conversation_prompt_queue WHERE queue_key = ? ORDER BY id`).all(queueKey) as unknown as QueuedPromptRow[];
  return rows.map(rowToPrompt);
}

/** Claiming a prompt is the delete itself, so two clients watching the same
 * conversation cannot both run it. Returns false when someone else took it. */
export function claimQueuedPrompt(id: number): boolean {
  return Number(queueDatabase().prepare("DELETE FROM conversation_prompt_queue WHERE id = ?").run(id).changes) > 0;
}

export function cancelQueuedPrompt(queueKey: string, id: number): QueuedPrompt | null {
  const db = queueDatabase();
  const row = db.prepare(`SELECT id, prompt_text, display_text, message_text, prompt_suffix, display_suffix, attachment_paths
    FROM conversation_prompt_queue WHERE queue_key = ? AND id = ?`).get(queueKey, id) as unknown as QueuedPromptRow | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM conversation_prompt_queue WHERE queue_key = ? AND id = ?").run(queueKey, id);
  return rowToPrompt(row);
}

export function editQueuedPrompt(queueKey: string, id: number, promptText: string, displayText: string, messageText: string): boolean {
  return Number(queueDatabase().prepare("UPDATE conversation_prompt_queue SET prompt_text = ?, display_text = ?, message_text = ? WHERE queue_key = ? AND id = ?")
    .run(promptText, displayText, messageText, queueKey, id).changes) > 0;
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
