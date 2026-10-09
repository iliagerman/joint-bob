import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";
import { resolveDataDirectory } from "./data-directory.js";
const GIT_REVIEW_THREAD_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
let database;
function reviewDatabase() {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 448 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS git_review_threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT,
      harness_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      thinking_level TEXT NOT NULL,
      selection TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      messages TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS git_review_threads_project ON git_review_threads (project_id, expires_at);
    CREATE INDEX IF NOT EXISTS git_review_threads_conversation ON git_review_threads (conversation_id, expires_at);
  `);
  return database;
}
function pruneExpired(db, now) {
  db.prepare("DELETE FROM git_review_threads WHERE expires_at <= ?").run(now);
}
function rowToThread(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    harnessId: row.harness_id,
    provider: row.provider,
    modelId: row.model_id,
    thinkingLevel: row.thinking_level,
    selection: JSON.parse(row.selection),
    snapshot: row.snapshot,
    messages: JSON.parse(row.messages),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}
function createGitReviewThread(input) {
  const db = reviewDatabase();
  const now = /* @__PURE__ */ new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + GIT_REVIEW_THREAD_TTL_MS).toISOString();
  pruneExpired(db, nowIso);
  const messages = [
    { role: "user", text: input.question, createdAt: nowIso },
    { role: "assistant", text: input.answer, createdAt: nowIso }
  ];
  const id = nanoid();
  db.prepare(`
    INSERT INTO git_review_threads
      (id, project_id, conversation_id, harness_id, provider, model_id, thinking_level, selection, snapshot, messages, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.projectId,
    input.conversationId ?? null,
    input.harnessId,
    input.provider,
    input.modelId,
    input.thinkingLevel,
    JSON.stringify(input.selection),
    input.snapshot,
    JSON.stringify(messages),
    nowIso,
    nowIso,
    expiresAt
  );
  return {
    id,
    projectId: input.projectId,
    conversationId: input.conversationId ?? null,
    harnessId: input.harnessId,
    provider: input.provider,
    modelId: input.modelId,
    thinkingLevel: input.thinkingLevel,
    selection: input.selection,
    snapshot: input.snapshot,
    messages,
    createdAt: nowIso,
    updatedAt: nowIso,
    expiresAt
  };
}
function getGitReviewThread(id) {
  const db = reviewDatabase();
  pruneExpired(db, (/* @__PURE__ */ new Date()).toISOString());
  const row = db.prepare("SELECT * FROM git_review_threads WHERE id = ?").get(id);
  return row ? rowToThread(row) : void 0;
}
function appendGitReviewMessages(id, question, answer) {
  const db = reviewDatabase();
  const now = /* @__PURE__ */ new Date();
  const nowIso = now.toISOString();
  pruneExpired(db, nowIso);
  const row = db.prepare("SELECT * FROM git_review_threads WHERE id = ?").get(id);
  if (!row) return void 0;
  const thread = rowToThread(row);
  const messages = [
    ...thread.messages,
    { role: "user", text: question, createdAt: nowIso },
    { role: "assistant", text: answer, createdAt: nowIso }
  ];
  const expiresAt = new Date(now.getTime() + GIT_REVIEW_THREAD_TTL_MS).toISOString();
  db.prepare("UPDATE git_review_threads SET messages = ?, updated_at = ?, expires_at = ? WHERE id = ?").run(JSON.stringify(messages), nowIso, expiresAt, id);
  return { ...thread, messages, updatedAt: nowIso, expiresAt };
}
function toSummary(thread) {
  return {
    id: thread.id,
    conversationId: thread.conversationId,
    harnessId: thread.harnessId,
    modelId: thread.modelId,
    selection: thread.selection,
    question: thread.messages.find((message) => message.role === "user")?.text ?? "",
    messageCount: thread.messages.length,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    expiresAt: thread.expiresAt
  };
}
function listGitReviewThreads(projectId, conversationId) {
  const db = reviewDatabase();
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  pruneExpired(db, nowIso);
  const rows = conversationId === void 0 ? db.prepare("SELECT * FROM git_review_threads WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) : db.prepare("SELECT * FROM git_review_threads WHERE project_id = ? AND conversation_id IS ? ORDER BY updated_at DESC").all(projectId, conversationId);
  return rows.map((row) => toSummary(rowToThread(row)));
}
function deleteGitReviewThread(id) {
  const db = reviewDatabase();
  const result = db.prepare("DELETE FROM git_review_threads WHERE id = ?").run(id);
  return result.changes > 0;
}
export {
  GIT_REVIEW_THREAD_TTL_MS,
  appendGitReviewMessages,
  createGitReviewThread,
  deleteGitReviewThread,
  getGitReviewThread,
  listGitReviewThreads
};
