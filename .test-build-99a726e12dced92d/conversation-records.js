import { mkdir } from "node:fs/promises";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { enqueueReplicationEvent, ensureReplicationSchema } from "./replication.js";
import { dropConversationGrantsInDatabase } from "./browser-store.js";
import { isHarnessId } from "./types.js";
const dataDir = resolveDataDirectory();
let databasePromise;
function createConversationRecordTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_records (
    project_id TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL DEFAULT '', task_id TEXT,
    conversation_id TEXT, segment_index INTEGER NOT NULL DEFAULT 0, cron_task_id TEXT,
    silent_review_from TEXT, silent_review_until TEXT,
    PRIMARY KEY (project_id, engine, session_id)
  ); CREATE TABLE IF NOT EXISTS conversation_record_tombstones (
    project_id TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY (project_id, engine, session_id)
  );`);
}
function ensureConversationRecordSchema(db) {
  createConversationRecordTables(db);
  const records = db.prepare("PRAGMA table_info(conversation_records)").all();
  if (!records.some((column) => column.name === "origin_node_id")) db.exec("ALTER TABLE conversation_records ADD COLUMN origin_node_id TEXT NOT NULL DEFAULT ''");
  if (!records.some((column) => column.name === "cron_task_id")) db.exec("ALTER TABLE conversation_records ADD COLUMN cron_task_id TEXT");
  if (!records.some((column) => column.name === "silent_review_from")) db.exec("ALTER TABLE conversation_records ADD COLUMN silent_review_from TEXT");
  if (!records.some((column) => column.name === "silent_review_until")) db.exec("ALTER TABLE conversation_records ADD COLUMN silent_review_until TEXT");
  if (!records.some((column) => column.name === "task_id")) db.exec("ALTER TABLE conversation_records ADD COLUMN task_id TEXT");
  if (!records.some((column) => column.name === "conversation_id")) db.exec("ALTER TABLE conversation_records ADD COLUMN conversation_id TEXT");
  if (!records.some((column) => column.name === "segment_index")) db.exec("ALTER TABLE conversation_records ADD COLUMN segment_index INTEGER NOT NULL DEFAULT 0");
  for (const table of ["conversation_records", "conversation_record_tombstones"]) {
    const row2 = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!row2?.sql.includes("engine IN ('pi', 'claude')")) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
      createConversationRecordTables(db);
      const columns = db.prepare(`PRAGMA table_info(${table}_old)`).all();
      const origin = columns.some((column) => column.name === "origin_node_id") ? "origin_node_id" : "''";
      if (table === "conversation_records") {
        const taskId = columns.some((column) => column.name === "task_id") ? "task_id" : "NULL";
        db.exec(`INSERT INTO conversation_records (project_id, engine, session_id, created_at, updated_at, origin_node_id, task_id) SELECT project_id, engine, session_id, created_at, updated_at, ${origin}, ${taskId} FROM conversation_records_old`);
      } else db.exec(`INSERT INTO conversation_record_tombstones (project_id, engine, session_id, updated_at, origin_node_id) SELECT project_id, engine, session_id, updated_at, ${origin} FROM conversation_record_tombstones_old`);
      db.exec(`DROP TABLE ${table}_old`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
function publishLegacyRecords(db) {
  const clusterNode = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cluster_node'").get() ? db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get() : void 0;
  if (!clusterNode) return;
  const legacy = db.prepare("SELECT * FROM conversation_records WHERE origin_node_id = ''").all();
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
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function removeSubagentRecords(db) {
  db.prepare("DELETE FROM conversation_records WHERE engine = 'claude' AND session_id LIKE '%/%'").run();
}
async function database() {
  if (!databasePromise) databasePromise = (async () => {
    await mkdir(dataDir, { recursive: true, mode: 448 });
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    ensureConversationRecordSchema(db);
    ensureReplicationSchema(db);
    publishLegacyRecords(db);
    removeSubagentRecords(db);
    return db;
  })();
  return databasePromise;
}
function row(record) {
  const conversationId = record.conversation_id === null || record.conversation_id === void 0 ? void 0 : String(record.conversation_id);
  return {
    projectId: String(record.project_id),
    engine: record.engine,
    sessionId: String(record.session_id),
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
    originNodeId: String(record.origin_node_id),
    taskId: record.task_id === null || record.task_id === void 0 ? null : String(record.task_id),
    ...record.cron_task_id ? { cronTaskId: String(record.cron_task_id) } : {},
    ...record.silent_review_from ? { silentReviewFrom: String(record.silent_review_from) } : {},
    ...record.silent_review_until ? { silentReviewUntil: String(record.silent_review_until) } : {},
    ...conversationId ? { conversationId, segmentIndex: Number(record.segment_index ?? 0) } : {}
  };
}
async function markCronConversation(projectId, engine, sessionId, cronTaskId, originNodeId) {
  const db = await database();
  const existing = selectRecord(db, projectId, engine, sessionId);
  if (!existing) throw new Error("Cron conversation record not found");
  const record = { ...existing, cronTaskId, originNodeId, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE conversation_records SET cron_task_id = ?, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND engine = ? AND session_id = ?").run(cronTaskId, record.updatedAt, originNodeId, projectId, engine, sessionId);
    publish(db, "upsert", projectId, engine, sessionId, record, record.updatedAt, originNodeId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function markSilentScheduledRun(projectId, engine, sessionId, from, until, originNodeId) {
  const db = await database();
  const existing = selectRecord(db, projectId, engine, sessionId);
  if (!existing) throw new Error("Scheduled conversation record not found");
  const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  const record = { ...existing, silentReviewFrom: from, silentReviewUntil: until, updatedAt, originNodeId };
  if (!validSilentReviewBoundary(record)) throw new Error("Invalid silent review boundary");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE conversation_records SET silent_review_from = ?, silent_review_until = ?, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND engine = ? AND session_id = ?").run(from, until, updatedAt, originNodeId, projectId, engine, sessionId);
    publish(db, "upsert", projectId, engine, sessionId, record, updatedAt, originNodeId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function selectRecord(db, projectId, engine, sessionId) {
  const value = db.prepare("SELECT * FROM conversation_records WHERE project_id = ? AND engine = ? AND session_id = ?").get(projectId, engine, sessionId);
  return value ? row(value) : void 0;
}
function publish(db, operation, projectId, engine, sessionId, record, updatedAt, originNodeId) {
  enqueueReplicationEvent(db, { originNodeId, entityType: "conversation.record", entityKey: `${projectId}:${engine}:${sessionId}`, operation, payload: { projectId, engine, sessionId, record, updatedAt, originNodeId } });
}
async function ensureConversationRecord(projectId, engine, sessionId, originNodeId, taskId, lineage) {
  const db = await database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = selectRecord(db, projectId, engine, sessionId);
    if (existing) {
      if (taskId && existing.taskId && taskId !== existing.taskId) throw new Error("Conversation record has a different task ID");
      if (lineage && !existing.conversationId) {
        const updated2 = { ...existing, ...lineage, updatedAt: (/* @__PURE__ */ new Date()).toISOString(), originNodeId };
        db.prepare("UPDATE conversation_records SET conversation_id = ?, segment_index = ?, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND engine = ? AND session_id = ?").run(lineage.conversationId, lineage.segmentIndex, updated2.updatedAt, originNodeId, projectId, engine, sessionId);
        publish(db, "upsert", projectId, engine, sessionId, updated2, updated2.updatedAt, originNodeId);
        db.exec("COMMIT");
        return updated2;
      }
      if (!taskId || existing.taskId) {
        db.exec("COMMIT");
        return existing;
      }
      const updated = { ...existing, taskId, updatedAt: (/* @__PURE__ */ new Date()).toISOString(), originNodeId };
      db.prepare("UPDATE conversation_records SET task_id = ?, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND engine = ? AND session_id = ?").run(taskId, updated.updatedAt, originNodeId, projectId, engine, sessionId);
      publish(db, "upsert", projectId, engine, sessionId, updated, updated.updatedAt, originNodeId);
      db.exec("COMMIT");
      return updated;
    }
    if (db.prepare("SELECT 1 FROM conversation_record_tombstones WHERE project_id = ? AND engine = ? AND session_id = ?").get(projectId, engine, sessionId)) throw new Error("Conversation record was deleted");
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const record = { projectId, engine, sessionId, createdAt: now, updatedAt: now, originNodeId, taskId: taskId ?? null, ...lineage ? { conversationId: lineage.conversationId, segmentIndex: lineage.segmentIndex } : {} };
    db.prepare("INSERT INTO conversation_records (project_id, engine, session_id, created_at, updated_at, origin_node_id, task_id, conversation_id, segment_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(projectId, engine, sessionId, now, now, originNodeId, record.taskId, record.conversationId ?? null, record.segmentIndex ?? 0);
    publish(db, "upsert", projectId, engine, sessionId, record, now, originNodeId);
    db.exec("COMMIT");
    return record;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function getConversationRecord(projectId, engine, sessionId) {
  return selectRecord(await database(), projectId, engine, sessionId);
}
async function listConversationRecords(projectId) {
  return (await database()).prepare("SELECT * FROM conversation_records WHERE project_id = ? ORDER BY updated_at DESC").all(projectId).map(row);
}
async function listConversationSegments(projectId, conversationId) {
  const records = await listConversationRecords(projectId);
  return records.filter((record) => (record.conversationId ?? record.sessionId) === conversationId).sort((left, right) => (left.segmentIndex ?? 0) - (right.segmentIndex ?? 0) || left.createdAt.localeCompare(right.createdAt));
}
async function latestConversationSegment(conversationId) {
  const records = (await database()).prepare("SELECT * FROM conversation_records WHERE conversation_id = ? OR session_id = ?").all(conversationId, conversationId).map(row);
  return records.filter((record) => (record.conversationId ?? record.sessionId) === conversationId).sort((left, right) => (left.segmentIndex ?? 0) - (right.segmentIndex ?? 0) || left.createdAt.localeCompare(right.createdAt)).at(-1);
}
async function deleteConversationRecord(projectId, engine, sessionId, originNodeId) {
  const db = await database();
  const existing = selectRecord(db, projectId, engine, sessionId);
  const tombstone = db.prepare("SELECT 1 FROM conversation_record_tombstones WHERE project_id = ? AND engine = ? AND session_id = ?").get(projectId, engine, sessionId);
  if (!existing && tombstone) return false;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM conversation_records WHERE project_id = ? AND engine = ? AND session_id = ?").run(projectId, engine, sessionId);
    db.prepare("INSERT INTO conversation_record_tombstones (project_id, engine, session_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, engine, session_id) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id").run(projectId, engine, sessionId, now, originNodeId);
    publish(db, "delete", projectId, engine, sessionId, null, now, originNodeId);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function deletedConversationKeys(projectId) {
  const db = await database();
  const rows = db.prepare("SELECT engine, session_id FROM conversation_record_tombstones WHERE project_id = ?").all(resolveProjectAlias(db, projectId));
  return new Set(rows.map((row2) => `${row2.engine}:${row2.session_id}`));
}
function resolveProjectAlias(db, projectId) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_aliases'").get()) return projectId;
  return db.prepare("SELECT project_id FROM project_aliases WHERE alias_id = ?").get(projectId)?.project_id ?? projectId;
}
function validSilentReviewBoundary(record) {
  const { silentReviewFrom: from, silentReviewUntil: until } = record;
  if (from === void 0 && until === void 0) return true;
  const timestamp = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
  return timestamp(from) && timestamp(until) && from <= until;
}
function payloadFor(event) {
  const value = event.payload;
  if (event.entityType !== "conversation.record" || !["upsert", "delete"].includes(event.operation) || !value || typeof value !== "object" || Array.isArray(value) || typeof value.projectId !== "string" || !isHarnessId(value.engine) || typeof value.sessionId !== "string" || typeof value.updatedAt !== "string" || typeof value.originNodeId !== "string" || value.originNodeId !== event.originNodeId || event.entityKey !== `${value.projectId}:${value.engine}:${value.sessionId}` || event.operation === "upsert" !== Boolean(value.record)) throw new Error("Malformed conversation record replication payload");
  if (value.record && (value.record.projectId !== value.projectId || value.record.engine !== value.engine || value.record.sessionId !== value.sessionId || value.record.updatedAt !== value.updatedAt || value.record.originNodeId !== value.originNodeId || typeof value.record.createdAt !== "string" || value.record.cronTaskId !== void 0 && typeof value.record.cronTaskId !== "string" || !validSilentReviewBoundary(value.record) || value.record.taskId !== void 0 && value.record.taskId !== null && typeof value.record.taskId !== "string" || value.record.conversationId !== void 0 && typeof value.record.conversationId !== "string" || value.record.segmentIndex !== void 0 && typeof value.record.segmentIndex !== "number")) throw new Error("Malformed conversation record replication payload");
  return value;
}
function applyConversationRecordEvent(db, event) {
  const payload = payloadFor(event);
  const projectId = resolveProjectAlias(db, payload.projectId);
  const identities = db.prepare(`SELECT project_id FROM conversation_records WHERE engine=? AND session_id=?
    UNION SELECT project_id FROM conversation_record_tombstones WHERE engine=? AND session_id=?`).all(payload.engine, payload.sessionId, payload.engine, payload.sessionId);
  if (identities.some((row2) => resolveProjectAlias(db, row2.project_id) !== projectId)) throw new Error("Conversation identity belongs to a different project");
  const current = db.prepare("SELECT updated_at, origin_node_id FROM conversation_records WHERE project_id = ? AND engine = ? AND session_id = ? UNION ALL SELECT updated_at, origin_node_id FROM conversation_record_tombstones WHERE project_id = ? AND engine = ? AND session_id = ? ORDER BY updated_at DESC, origin_node_id DESC LIMIT 1").get(projectId, payload.engine, payload.sessionId, projectId, payload.engine, payload.sessionId);
  if (current && `${payload.updatedAt}
${payload.originNodeId}` <= `${current.updated_at}
${current.origin_node_id}`) {
    if (payload.record?.cronTaskId) db.prepare("UPDATE conversation_records SET cron_task_id = ? WHERE project_id = ? AND engine = ? AND session_id = ? AND cron_task_id IS NULL").run(payload.record.cronTaskId, projectId, payload.engine, payload.sessionId);
    if (payload.record?.silentReviewUntil && payload.record.silentReviewFrom) db.prepare("UPDATE conversation_records SET silent_review_from = ?, silent_review_until = ? WHERE project_id = ? AND engine = ? AND session_id = ? AND (silent_review_until IS NULL OR silent_review_until < ?)").run(payload.record.silentReviewFrom, payload.record.silentReviewUntil, projectId, payload.engine, payload.sessionId, payload.record.silentReviewUntil);
    return;
  }
  if (payload.record && payload.engine === "claude" && payload.sessionId.includes("/")) return;
  if (!payload.record) {
    const existing = db.prepare("SELECT conversation_id FROM conversation_records WHERE project_id = ? AND engine = ? AND session_id = ?").get(projectId, payload.engine, payload.sessionId);
    const logical = existing?.conversation_id ?? void 0;
    const segments = logical ? db.prepare("SELECT session_id AS sessionId FROM conversation_records WHERE project_id = ? AND conversation_id = ?").all(projectId, logical).map(({ sessionId }) => sessionId) : [];
    for (const conversationId of /* @__PURE__ */ new Set([payload.sessionId, ...logical ? [logical] : [], ...segments])) dropConversationGrantsInDatabase(db, projectId, conversationId);
    db.prepare("DELETE FROM conversation_records WHERE project_id = ? AND engine = ? AND session_id = ?").run(projectId, payload.engine, payload.sessionId);
    db.prepare("INSERT INTO conversation_record_tombstones (project_id, engine, session_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, engine, session_id) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id").run(projectId, payload.engine, payload.sessionId, payload.updatedAt, payload.originNodeId);
    return;
  }
  db.prepare("INSERT INTO conversation_records (project_id, engine, session_id, created_at, updated_at, origin_node_id, task_id, conversation_id, segment_index, cron_task_id, silent_review_from, silent_review_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, engine, session_id) DO UPDATE SET created_at = excluded.created_at, updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id, task_id = excluded.task_id, conversation_id = excluded.conversation_id, segment_index = excluded.segment_index, cron_task_id = COALESCE(excluded.cron_task_id, conversation_records.cron_task_id), silent_review_from = CASE WHEN excluded.silent_review_until > COALESCE(conversation_records.silent_review_until, '') THEN excluded.silent_review_from ELSE conversation_records.silent_review_from END, silent_review_until = CASE WHEN excluded.silent_review_until > COALESCE(conversation_records.silent_review_until, '') THEN excluded.silent_review_until ELSE conversation_records.silent_review_until END").run(projectId, payload.engine, payload.sessionId, payload.record.createdAt, payload.updatedAt, payload.originNodeId, payload.record.taskId ?? null, payload.record.conversationId ?? null, payload.record.segmentIndex ?? 0, payload.record.cronTaskId ?? null, payload.record.silentReviewFrom ?? null, payload.record.silentReviewUntil ?? null);
  db.prepare("DELETE FROM conversation_record_tombstones WHERE project_id = ? AND engine = ? AND session_id = ?").run(projectId, payload.engine, payload.sessionId);
}
function conversationDraftPath(engine, sessionId) {
  return `draft:${engine}:${sessionId}`;
}
function parseConversationDraftPath(value) {
  const match = value?.match(/^draft:([a-z][a-z0-9-]*):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/);
  return match ? { engine: match[1], sessionId: match[2] } : void 0;
}
export {
  applyConversationRecordEvent,
  conversationDraftPath,
  deleteConversationRecord,
  deletedConversationKeys,
  ensureConversationRecord,
  ensureConversationRecordSchema,
  getConversationRecord,
  latestConversationSegment,
  listConversationRecords,
  listConversationSegments,
  markCronConversation,
  markSilentScheduledRun,
  parseConversationDraftPath
};
