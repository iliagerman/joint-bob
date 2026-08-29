import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export type ConversationReviewState = "running" | "needs_review" | "reviewed";

interface ConversationStateInput {
  path: string;
  updatedAt?: string;
  running: boolean;
}

interface ConversationStateRow {
  last_activity_at: string;
  reviewed_at: string;
  was_running: number;
}

interface ColumnRow {
  name: string;
}

interface ReviewStatements {
  selectTracking: StatementSync;
  insertTracking: StatementSync;
  select: StatementSync;
  insert: StatementSync;
  update: StatementSync;
}

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
let database: DatabaseSync | undefined;

function reviewDatabase(): DatabaseSync {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversation_review_tracking (
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      initialized_at TEXT NOT NULL,
      PRIMARY KEY (user_id, project_id)
    );
    CREATE TABLE IF NOT EXISTS conversation_review_states (
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      session_path TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      was_running INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, project_id, session_path)
    );
  `);
  const columns = database.prepare("PRAGMA table_info(conversation_review_states)").all() as unknown as ColumnRow[];
  if (!columns.some((column) => column.name === "notified")) {
    database.exec("ALTER TABLE conversation_review_states ADD COLUMN notified INTEGER NOT NULL DEFAULT 0");
  }
  return database;
}

function activityTime(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? fallback : time.toISOString();
}

function reviewStatements(db: DatabaseSync): ReviewStatements {
  return {
    selectTracking: db.prepare(`
      SELECT initialized_at FROM conversation_review_tracking
      WHERE user_id = ? AND project_id = ?
    `),
    insertTracking: db.prepare(`
      INSERT INTO conversation_review_tracking (user_id, project_id, initialized_at)
      VALUES (?, ?, ?)
    `),
    select: db.prepare(`
      SELECT last_activity_at, reviewed_at, was_running
      FROM conversation_review_states
      WHERE user_id = ? AND project_id = ? AND session_path = ?
    `),
    insert: db.prepare(`
      INSERT INTO conversation_review_states
        (user_id, project_id, session_path, last_activity_at, reviewed_at, was_running, notified)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `),
    update: db.prepare(`
      UPDATE conversation_review_states
      SET last_activity_at = ?, was_running = ?, notified = CASE WHEN ? = 1 THEN 0 ELSE notified END
      WHERE user_id = ? AND project_id = ? AND session_path = ?
    `),
  };
}

export function syncConversationReviewStates(userId: string, projectId: string, sessions: ConversationStateInput[]): Map<string, ConversationReviewState> {
  const db = reviewDatabase();
  const statements = reviewStatements(db);
  const now = new Date().toISOString();
  const states = new Map<string, ConversationReviewState>();
  db.exec("BEGIN");
  try {
    const tracking = statements.selectTracking.get(userId, projectId) as { initialized_at: string } | undefined;
    const initializedAt = tracking?.initialized_at ?? now;
    if (!tracking) statements.insertTracking.run(userId, projectId, initializedAt);
    for (const session of sessions) {
      const observedAt = activityTime(session.updatedAt, now);
      const row = statements.select.get(userId, projectId, session.path) as unknown as ConversationStateRow | undefined;
      if (!row) {
        const reviewedAt = tracking ? initializedAt : observedAt;
        statements.insert.run(userId, projectId, session.path, observedAt, reviewedAt, session.running ? 1 : 0);
        states.set(session.path, session.running ? "running" : observedAt > reviewedAt ? "needs_review" : "reviewed");
        continue;
      }
      const lastActivityAt = observedAt > row.last_activity_at ? observedAt : row.last_activity_at;
      statements.update.run(lastActivityAt, session.running ? 1 : 0, session.running ? 1 : 0, userId, projectId, session.path);
      states.set(session.path, session.running ? "running" : lastActivityAt > row.reviewed_at ? "needs_review" : "reviewed");
    }
    db.exec("COMMIT");
    return states;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function markConversationsReviewed(
  userId: string,
  projectId: string,
  sessions: Array<Pick<ConversationStateInput, "path" | "updatedAt">>,
): void {
  if (!sessions.length) return;
  const db = reviewDatabase();
  const statement = db.prepare(`
    INSERT INTO conversation_review_states
      (user_id, project_id, session_path, last_activity_at, reviewed_at, was_running, notified)
    VALUES (?, ?, ?, ?, ?, 0, 0)
    ON CONFLICT(user_id, project_id, session_path) DO UPDATE SET
      last_activity_at = MAX(conversation_review_states.last_activity_at, excluded.last_activity_at),
      reviewed_at = MAX(conversation_review_states.reviewed_at, excluded.reviewed_at),
      notified = 0
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const session of sessions) {
      if (!session.updatedAt || !validReviewWatermark(session.updatedAt)) throw new Error("Conversation review watermark is invalid");
      const reviewedAt = new Date(session.updatedAt).toISOString();
      statement.run(userId, projectId, session.path, reviewedAt, reviewedAt);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function validReviewWatermark(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

export function markConversationReviewed(
  userId: string,
  projectId: string,
  session: Pick<ConversationStateInput, "path" | "updatedAt">,
): void {
  markConversationsReviewed(userId, projectId, [session]);
}

/**
 * Marks the conversations that still owe this account a review notification and returns them, so a
 * conversation buzzes the phone once per review cycle no matter how often its transcript is rewritten
 * by a locally running agent or by one synchronized in from another node.
 */
export function claimReviewNotifications(userId: string, projectId: string, sessionPaths: string[]): string[] {
  if (!sessionPaths.length) return [];
  const db = reviewDatabase();
  const select = db.prepare(`
    SELECT session_path FROM conversation_review_states
    WHERE user_id = ? AND project_id = ? AND session_path = ?
      AND notified = 0 AND last_activity_at > reviewed_at
  `);
  const claim = db.prepare(`
    UPDATE conversation_review_states SET notified = 1
    WHERE user_id = ? AND project_id = ? AND session_path = ?
  `);
  const claimed: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const sessionPath of sessionPaths) {
      if (!select.get(userId, projectId, sessionPath)) continue;
      claim.run(userId, projectId, sessionPath);
      claimed.push(sessionPath);
    }
    db.exec("COMMIT");
    return claimed;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
