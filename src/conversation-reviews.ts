import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ConversationEngine } from "./conversation-ownership.js";
import { enqueueReplicationEvent, ensureReplicationSchema, resolveProjectAlias, type ReplicationEvent } from "./replication.js";

export type ConversationReviewState = "running" | "needs_review" | "reviewed";

interface ConversationStateInput {
  path: string;
  engine: ConversationEngine;
  sessionId: string;
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

interface RemoteWatermarkRow {
  engine: ConversationEngine;
  session_id: string;
  reviewed_at: string;
}

interface ReviewStatements {
  selectTracking: StatementSync;
  insertTracking: StatementSync;
  select: StatementSync;
  insert: StatementSync;
  update: StatementSync;
}

interface ReviewPayload {
  username: string;
  projectId: string;
  engine: ConversationEngine;
  sessionId: string;
  reviewedAt: string;
  originNodeId: string;
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

/** Watermarks reviewed on another node, keyed by identities stable across the cluster. */
export function ensureConversationReviewReplicaSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS replicated_review_watermarks (
    username TEXT NOT NULL,
    project_id TEXT NOT NULL,
    engine TEXT NOT NULL CHECK(engine IN ('pi', 'claude')),
    session_id TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    origin_node_id TEXT NOT NULL,
    PRIMARY KEY (username, project_id, engine, session_id)
  );`);
}

function remoteWatermarks(db: DatabaseSync, username: string, projectId: string): Map<string, string> {
  ensureConversationReviewReplicaSchema(db);
  const rows = db.prepare("SELECT engine, session_id, reviewed_at FROM replicated_review_watermarks WHERE username = ? AND project_id = ?").all(username, projectId) as unknown as RemoteWatermarkRow[];
  return new Map(rows.map((row) => [`${row.engine}\n${row.session_id}`, row.reviewed_at]));
}

function activityTime(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? fallback : time.toISOString();
}

// Two nodes read the same transcript's recency a few milliseconds apart (record
// timestamp on one, file mtime on the other). A watermark replicated from the node
// where the review happened must still cover that activity, so a small skew between
// the observed activity and a remote watermark counts as reviewed. The window is
// deliberately tiny: activity landing inside it after a review mark stays reviewed.
const REMOTE_WATERMARK_TOLERANCE_MS = 250;

function activityCovered(observedAt: string, reviewedAt: string, remoteReviewedAt: string | undefined): boolean {
  if (observedAt <= reviewedAt) return true;
  return Boolean(remoteReviewedAt && Date.parse(observedAt) - Date.parse(remoteReviewedAt) <= REMOTE_WATERMARK_TOLERANCE_MS);
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
      SET last_activity_at = ?, reviewed_at = ?, was_running = ?,
        notified = CASE WHEN ? = 1 OR ? = 1 THEN 0 ELSE notified END
      WHERE user_id = ? AND project_id = ? AND session_path = ?
    `),
  };
}

/**
 * Reconciles the account's review rows against the sessions a project lists. The
 * reviewed watermark is the higher of the local row and any watermark another node
 * replicated for the same (username, project, engine, session id), so marking a
 * conversation reviewed anywhere marks it everywhere.
 */
export function syncConversationReviewStates(userId: string, username: string, projectId: string, sessions: ConversationStateInput[]): Map<string, ConversationReviewState> {
  const db = reviewDatabase();
  const statements = reviewStatements(db);
  const remote = remoteWatermarks(db, username, projectId);
  const now = new Date().toISOString();
  const states = new Map<string, ConversationReviewState>();
  db.exec("BEGIN");
  try {
    const tracking = statements.selectTracking.get(userId, projectId) as { initialized_at: string } | undefined;
    const initializedAt = tracking?.initialized_at ?? now;
    if (!tracking) statements.insertTracking.run(userId, projectId, initializedAt);
    for (const session of sessions) {
      const observedAt = activityTime(session.updatedAt, now);
      const remoteReviewedAt = remote.get(`${session.engine}\n${session.sessionId}`);
      const row = statements.select.get(userId, projectId, session.path) as unknown as ConversationStateRow | undefined;
      if (!row) {
        const baseline = tracking ? initializedAt : observedAt;
        const reviewedAt = remoteReviewedAt && remoteReviewedAt > baseline ? remoteReviewedAt : baseline;
        statements.insert.run(userId, projectId, session.path, observedAt, reviewedAt, session.running ? 1 : 0);
        states.set(session.path, session.running ? "running" : activityCovered(observedAt, reviewedAt, remoteReviewedAt) ? "reviewed" : "needs_review");
        continue;
      }
      // The reported time is authoritative in both directions. Clamping it to the highest value
      // ever seen made a single bad reading permanent, and a conversation whose recency was
      // inflated once could never return to reviewed.
      const reviewedAt = remoteReviewedAt && remoteReviewedAt > row.reviewed_at ? remoteReviewedAt : row.reviewed_at;
      // A remote review starts this account's next notification cycle, exactly like a local one.
      const remoteAdvanced = Boolean(remoteReviewedAt && remoteReviewedAt > row.reviewed_at);
      statements.update.run(observedAt, reviewedAt, session.running ? 1 : 0, session.running ? 1 : 0, remoteAdvanced ? 1 : 0, userId, projectId, session.path);
      states.set(session.path, session.running ? "running" : activityCovered(observedAt, reviewedAt, remoteReviewedAt) ? "reviewed" : "needs_review");
    }
    db.exec("COMMIT");
    return states;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function publishReview(db: DatabaseSync, username: string, projectId: string, session: { engine: ConversationEngine; sessionId: string }, reviewedAt: string, originNodeId: string): void {
  ensureReplicationSchema(db);
  enqueueReplicationEvent(db, {
    originNodeId,
    entityType: "conversation.review",
    entityKey: `${username}:${projectId}:${session.engine}:${session.sessionId}`,
    operation: "upsert",
    payload: { username, projectId, engine: session.engine, sessionId: session.sessionId, reviewedAt, originNodeId },
  });
}

export function markConversationsReviewed(
  userId: string,
  username: string,
  projectId: string,
  sessions: Array<Pick<ConversationStateInput, "path" | "engine" | "sessionId" | "updatedAt">>,
  originNodeId: string,
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
      publishReview(db, username, projectId, session, reviewedAt, originNodeId);
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
  username: string,
  projectId: string,
  session: Pick<ConversationStateInput, "path" | "engine" | "sessionId" | "updatedAt">,
  originNodeId: string,
): void {
  markConversationsReviewed(userId, username, projectId, [session], originNodeId);
}

// A review watermark legitimately tracks transcript activity, which cannot be far
// ahead of the receiver's clock; anything further out would suppress reviews forever.
const MAX_REVIEW_WATERMARK_SKEW_MS = 5 * 60_000;

function reviewPayload(event: ReplicationEvent): ReviewPayload {
  const value = event.payload as Partial<ReviewPayload>;
  const valid = event.entityType === "conversation.review" && event.operation === "upsert"
    && value && typeof value === "object" && !Array.isArray(value)
    && typeof value.username === "string" && value.username.length > 0
    && typeof value.projectId === "string" && value.projectId.length > 0
    && ["pi", "claude"].includes(value.engine ?? "")
    && typeof value.sessionId === "string" && value.sessionId.length > 0
    && typeof value.reviewedAt === "string" && Number.isFinite(Date.parse(value.reviewedAt))
    && typeof value.originNodeId === "string" && value.originNodeId === event.originNodeId
    && event.entityKey === `${value.username}:${value.projectId}:${value.engine}:${value.sessionId}`;
  if (!valid) throw new Error("Malformed conversation review replication payload");
  if (Date.parse(value.reviewedAt!) > Date.now() + MAX_REVIEW_WATERMARK_SKEW_MS) throw new Error("Conversation review watermark is too far in the future");
  return value as ReviewPayload;
}

export function applyConversationReviewEvent(db: DatabaseSync, event: ReplicationEvent): void {
  const payload = reviewPayload(event);
  ensureConversationReviewReplicaSchema(db);
  const projectId = resolveProjectAlias(db, payload.projectId);
  db.prepare(`
    INSERT INTO replicated_review_watermarks (username, project_id, engine, session_id, reviewed_at, origin_node_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(username, project_id, engine, session_id) DO UPDATE SET
      reviewed_at = MAX(replicated_review_watermarks.reviewed_at, excluded.reviewed_at),
      origin_node_id = excluded.origin_node_id
  `).run(payload.username, projectId, payload.engine, payload.sessionId, new Date(payload.reviewedAt).toISOString(), payload.originNodeId);
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
