import { conversationWorkActive } from "./conversation-work.js";
import { mkdirSync } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { enqueueReplicationEvent, ensureReplicationSchema, resolveProjectAlias } from "./replication.js";
import { isHarnessId } from "./types.js";
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
let database;
function reviewDatabase() {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 448 });
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
    CREATE TABLE IF NOT EXISTS conversation_review_notification_preferences (
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      session_path TEXT NOT NULL,
      PRIMARY KEY (user_id, project_id, session_path)
    );
  `);
  const columns = database.prepare("PRAGMA table_info(conversation_review_states)").all();
  if (!columns.some((column) => column.name === "notified")) {
    database.exec("ALTER TABLE conversation_review_states ADD COLUMN notified INTEGER NOT NULL DEFAULT 0");
  }
  return database;
}
function ensureConversationReviewReplicaSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS replicated_review_watermarks (
    username TEXT NOT NULL,
    project_id TEXT NOT NULL,
    engine TEXT NOT NULL,
    session_id TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    origin_node_id TEXT NOT NULL,
    PRIMARY KEY (username, project_id, engine, session_id)
  );`);
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'replicated_review_watermarks'").get();
  if (!row?.sql.includes("engine IN ('pi', 'claude')")) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE replicated_review_watermarks RENAME TO replicated_review_watermarks_old");
    db.exec("CREATE TABLE replicated_review_watermarks (username TEXT NOT NULL, project_id TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL, reviewed_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY (username, project_id, engine, session_id)); INSERT INTO replicated_review_watermarks SELECT * FROM replicated_review_watermarks_old; DROP TABLE replicated_review_watermarks_old;");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function remoteWatermarks(db, username, projectId) {
  ensureConversationReviewReplicaSchema(db);
  const rows = db.prepare("SELECT engine, session_id, reviewed_at FROM replicated_review_watermarks WHERE username = ? AND project_id = ?").all(username, projectId);
  return new Map(rows.map((row) => [`${row.engine}
${row.session_id}`, row.reviewed_at]));
}
function activityTime(value, fallback) {
  if (!value) return fallback;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? fallback : time.toISOString();
}
const REMOTE_WATERMARK_TOLERANCE_MS = 250;
function activityCovered(observedAt, reviewedAt, remoteReviewedAt) {
  if (observedAt <= reviewedAt) return true;
  return Boolean(remoteReviewedAt && Date.parse(observedAt) - Date.parse(remoteReviewedAt) <= REMOTE_WATERMARK_TOLERANCE_MS);
}
function reviewStatements(db) {
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
    `)
  };
}
function syncConversationReviewDetails(userId, username, projectId, sessions) {
  const db = reviewDatabase();
  const statements = reviewStatements(db);
  const remote = remoteWatermarks(db, username, projectId);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const states = /* @__PURE__ */ new Map();
  sessions = sessions.map((session) => ({ ...session, running: session.running || conversationWorkActive(session.engine, session.sessionId) }));
  db.exec("BEGIN IMMEDIATE");
  try {
    const tracking = statements.selectTracking.get(userId, projectId);
    const initializedAt = tracking?.initialized_at ?? now;
    if (!tracking) statements.insertTracking.run(userId, projectId, initializedAt);
    for (const session of sessions) {
      const latestAt = activityTime(session.updatedAt, now);
      const observedAt = session.silentReviewFrom && session.silentReviewUntil && latestAt > session.silentReviewFrom && latestAt <= session.silentReviewUntil ? session.silentReviewFrom : latestAt;
      const remoteReviewedAt = remote.get(`${session.engine}
${session.sessionId}`);
      const row = statements.select.get(userId, projectId, session.path);
      if (!row) {
        const baseline = tracking ? initializedAt : observedAt;
        const reviewedAt2 = remoteReviewedAt && remoteReviewedAt > baseline ? remoteReviewedAt : baseline;
        statements.insert.run(userId, projectId, session.path, observedAt, reviewedAt2, session.running ? 1 : 0);
        states.set(session.path, {
          state: session.running ? "running" : activityCovered(observedAt, reviewedAt2, remoteReviewedAt) ? "reviewed" : "needs_review",
          reviewedAt: reviewedAt2
        });
        continue;
      }
      const reviewedAt = remoteReviewedAt && remoteReviewedAt > row.reviewed_at ? remoteReviewedAt : row.reviewed_at;
      const remoteAdvanced = Boolean(remoteReviewedAt && remoteReviewedAt > row.reviewed_at);
      statements.update.run(observedAt, reviewedAt, session.running ? 1 : 0, session.running ? 1 : 0, remoteAdvanced ? 1 : 0, userId, projectId, session.path);
      states.set(session.path, {
        state: session.running ? "running" : activityCovered(observedAt, reviewedAt, remoteReviewedAt) ? "reviewed" : "needs_review",
        reviewedAt
      });
    }
    db.exec("COMMIT");
    return states;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function syncConversationReviewStates(userId, username, projectId, sessions) {
  return new Map([...syncConversationReviewDetails(userId, username, projectId, sessions)].map(([sessionPath, details]) => [sessionPath, details.state]));
}
function publishReview(db, username, projectId, session, reviewedAt, originNodeId) {
  ensureReplicationSchema(db);
  enqueueReplicationEvent(db, {
    originNodeId,
    entityType: "conversation.review",
    entityKey: `${username}:${projectId}:${session.engine}:${session.sessionId}`,
    operation: "upsert",
    payload: { username, projectId, engine: session.engine, sessionId: session.sessionId, reviewedAt, originNodeId }
  });
}
function markConversationsReviewed(userId, username, projectId, sessions, originNodeId) {
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
      upsertReviewWatermark(db, username, projectId, session.engine, session.sessionId, reviewedAt, originNodeId);
      publishReview(db, username, projectId, session, reviewedAt, originNodeId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function validReviewWatermark(value) {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}
function markConversationReviewed(userId, username, projectId, session, originNodeId) {
  markConversationsReviewed(userId, username, projectId, [session], originNodeId);
}
const MAX_REVIEW_WATERMARK_SKEW_MS = 5 * 6e4;
function reviewPayload(event) {
  const value = event.payload;
  const valid = event.entityType === "conversation.review" && event.operation === "upsert" && value && typeof value === "object" && !Array.isArray(value) && typeof value.username === "string" && value.username.length > 0 && typeof value.projectId === "string" && value.projectId.length > 0 && isHarnessId(value.engine) && typeof value.sessionId === "string" && value.sessionId.length > 0 && typeof value.reviewedAt === "string" && Number.isFinite(Date.parse(value.reviewedAt)) && typeof value.originNodeId === "string" && value.originNodeId === event.originNodeId && event.entityKey === `${value.username}:${value.projectId}:${value.engine}:${value.sessionId}`;
  if (!valid) throw new Error("Malformed conversation review replication payload");
  if (Date.parse(value.reviewedAt) > Date.now() + MAX_REVIEW_WATERMARK_SKEW_MS) throw new Error("Conversation review watermark is too far in the future");
  return value;
}
function upsertReviewWatermark(db, username, projectId, engine, sessionId, reviewedAt, originNodeId) {
  ensureConversationReviewReplicaSchema(db);
  db.prepare(`
    INSERT INTO replicated_review_watermarks (username, project_id, engine, session_id, reviewed_at, origin_node_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(username, project_id, engine, session_id) DO UPDATE SET
      reviewed_at = MAX(replicated_review_watermarks.reviewed_at, excluded.reviewed_at),
      origin_node_id = excluded.origin_node_id
  `).run(username, projectId, engine, sessionId, reviewedAt, originNodeId);
}
function applyConversationReviewEvent(db, event) {
  const payload = reviewPayload(event);
  upsertReviewWatermark(db, payload.username, resolveProjectAlias(db, payload.projectId), payload.engine, payload.sessionId, new Date(payload.reviewedAt).toISOString(), payload.originNodeId);
}
function conversationReviewNotificationPaths(userId, projectId) {
  const rows = reviewDatabase().prepare(`
    SELECT session_path FROM conversation_review_notification_preferences
    WHERE user_id = ? AND project_id = ?
  `).all(userId, projectId);
  return new Set(rows.map((row) => row.session_path));
}
function conversationReviewNotificationsEnabled(userId, projectId, sessionPath) {
  return conversationReviewNotificationPaths(userId, projectId).has(sessionPath);
}
function setConversationReviewNotifications(userId, projectId, sessionPath, enabled) {
  const db = reviewDatabase();
  if (!enabled) {
    db.prepare("DELETE FROM conversation_review_notification_preferences WHERE user_id = ? AND project_id = ? AND session_path = ?").run(userId, projectId, sessionPath);
    return;
  }
  db.prepare("INSERT OR IGNORE INTO conversation_review_notification_preferences (user_id, project_id, session_path) VALUES (?, ?, ?)").run(userId, projectId, sessionPath);
}
function releaseReviewNotification(userId, projectId, sessionPath) {
  reviewDatabase().prepare(`
    UPDATE conversation_review_states SET notified = 0
    WHERE user_id = ? AND project_id = ? AND session_path = ?
  `).run(userId, projectId, sessionPath);
}
function claimReviewNotifications(userId, projectId, sessionPaths) {
  if (!sessionPaths.length) return [];
  const db = reviewDatabase();
  const select = db.prepare(`
    SELECT states.session_path FROM conversation_review_states states
    JOIN conversation_review_notification_preferences preferences
      ON preferences.user_id = states.user_id AND preferences.project_id = states.project_id
        AND preferences.session_path = states.session_path
    WHERE states.user_id = ? AND states.project_id = ? AND states.session_path = ?
      AND states.notified = 0 AND states.last_activity_at > states.reviewed_at
  `);
  const claim = db.prepare(`
    UPDATE conversation_review_states SET notified = 1
    WHERE user_id = ? AND project_id = ? AND session_path = ?
  `);
  const claimed = [];
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
export {
  applyConversationReviewEvent,
  claimReviewNotifications,
  conversationReviewNotificationPaths,
  conversationReviewNotificationsEnabled,
  ensureConversationReviewReplicaSchema,
  markConversationReviewed,
  markConversationsReviewed,
  releaseReviewNotification,
  setConversationReviewNotifications,
  syncConversationReviewDetails,
  syncConversationReviewStates
};
