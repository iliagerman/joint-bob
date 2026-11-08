import type { DatabaseSync } from "node:sqlite";

/**
 * Which conversation started which through the worktree CLI, on the machine where it ran. A webhook's run often only opens a
 * worktree and starts the conversation that does the work; this is how what the run started is found again.
 */
export interface ConversationStart {
  projectId: string;
  /** The conversation that ran the start command: its harness session and its conversation id (they differ after a switch). */
  parentSessionId: string;
  parentConversationId: string;
  childSessionId: string;
  engine: string;
  worktreeId: string;
  startedAt: string;
}

export function ensureConversationStartSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_starts (
    child_session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_session_id TEXT NOT NULL, parent_conversation_id TEXT NOT NULL,
    engine TEXT NOT NULL, worktree_id TEXT NOT NULL, started_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS conversation_starts_parent ON conversation_starts(project_id, parent_session_id);`);
}

export function recordConversationStart(db: DatabaseSync, start: ConversationStart): void {
  ensureConversationStartSchema(db);
  db.prepare(`INSERT OR IGNORE INTO conversation_starts (child_session_id, project_id, parent_session_id, parent_conversation_id, engine, worktree_id, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(start.childSessionId, start.projectId, start.parentSessionId, start.parentConversationId, start.engine, start.worktreeId, start.startedAt);
}

interface Row { child_session_id: string; project_id: string; parent_session_id: string; parent_conversation_id: string; engine: string; worktree_id: string; started_at: string }

const fromRow = (row: Row): ConversationStart => ({
  projectId: row.project_id, parentSessionId: row.parent_session_id, parentConversationId: row.parent_conversation_id, childSessionId: row.child_session_id,
  engine: row.engine, worktreeId: row.worktree_id, startedAt: row.started_at,
});

/** The conversations one conversation started, oldest first. It is named by its session or its conversation id. */
export function conversationsStartedBy(db: DatabaseSync, projectId: string, parentId: string): ConversationStart[] {
  ensureConversationStartSchema(db);
  return (db.prepare(`SELECT * FROM conversation_starts WHERE project_id = ? AND (parent_session_id = ? OR parent_conversation_id = ?) ORDER BY started_at, rowid`)
    .all(projectId, parentId, parentId) as unknown as Row[]).map(fromRow);
}

/** Who started a conversation, when it was started through the worktree CLI. */
export function conversationStarter(db: DatabaseSync, projectId: string, childSessionId: string): ConversationStart | undefined {
  ensureConversationStartSchema(db);
  const row = db.prepare("SELECT * FROM conversation_starts WHERE project_id = ? AND child_session_id = ?").get(projectId, childSessionId) as Row | undefined;
  return row ? fromRow(row) : undefined;
}
