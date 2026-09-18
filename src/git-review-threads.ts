import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";
import { resolveDataDirectory } from "./data-directory.js";
import type { HarnessId } from "./types.js";

// Review threads are a convenience cache of explanations, not durable project state,
// so they expire. A thread and its snapshot live this long after the last message.
export const GIT_REVIEW_THREAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface GitReviewSelection {
  /** "worktree" for a pending change, or a commit hash for a historical one. */
  scope: "worktree" | "commit";
  /** The commit hash when scope is "commit". */
  revision?: string;
  /** The reviewed file path, when the question targets one file. */
  filePath?: string;
  /** Whether the reviewed change was staged, for a worktree scope. */
  staged?: boolean;
}

export interface GitReviewMessage {
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface GitReviewThread {
  id: string;
  projectId: string;
  /** The conversation this review is scoped to, or null for a project-level review. */
  conversationId: string | null;
  harnessId: HarnessId;
  provider: string;
  modelId: string;
  thinkingLevel: string;
  selection: GitReviewSelection;
  /** The exact diff text the review was asked about, preserved so later edits do not rewrite it. */
  snapshot: string;
  messages: GitReviewMessage[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

interface ThreadRow {
  id: string;
  project_id: string;
  conversation_id: string | null;
  harness_id: string;
  provider: string;
  model_id: string;
  thinking_level: string;
  selection: string;
  snapshot: string;
  messages: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
let database: DatabaseSync | undefined;

function reviewDatabase(): DatabaseSync {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
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

/** Removes every thread whose expiry has passed. Called before each read and write. */
function pruneExpired(db: DatabaseSync, now: string): void {
  db.prepare("DELETE FROM git_review_threads WHERE expires_at <= ?").run(now);
}

function rowToThread(row: ThreadRow): GitReviewThread {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    harnessId: row.harness_id,
    provider: row.provider,
    modelId: row.model_id,
    thinkingLevel: row.thinking_level,
    selection: JSON.parse(row.selection) as GitReviewSelection,
    snapshot: row.snapshot,
    messages: JSON.parse(row.messages) as GitReviewMessage[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

export interface CreateGitReviewThreadInput {
  projectId: string;
  conversationId?: string | null;
  harnessId: HarnessId;
  provider: string;
  modelId: string;
  thinkingLevel: string;
  selection: GitReviewSelection;
  snapshot: string;
  question: string;
  answer: string;
}

export function createGitReviewThread(input: CreateGitReviewThreadInput): GitReviewThread {
  const db = reviewDatabase();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + GIT_REVIEW_THREAD_TTL_MS).toISOString();
  pruneExpired(db, nowIso);
  const messages: GitReviewMessage[] = [
    { role: "user", text: input.question, createdAt: nowIso },
    { role: "assistant", text: input.answer, createdAt: nowIso },
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
    expiresAt,
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
    expiresAt,
  };
}

export function getGitReviewThread(id: string): GitReviewThread | undefined {
  const db = reviewDatabase();
  pruneExpired(db, new Date().toISOString());
  const row = db.prepare("SELECT * FROM git_review_threads WHERE id = ?").get(id) as ThreadRow | undefined;
  return row ? rowToThread(row) : undefined;
}

/** Appends a follow-up exchange and pushes the expiry out from now. */
export function appendGitReviewMessages(id: string, question: string, answer: string): GitReviewThread | undefined {
  const db = reviewDatabase();
  const now = new Date();
  const nowIso = now.toISOString();
  pruneExpired(db, nowIso);
  const row = db.prepare("SELECT * FROM git_review_threads WHERE id = ?").get(id) as ThreadRow | undefined;
  if (!row) return undefined;
  const thread = rowToThread(row);
  const messages = [
    ...thread.messages,
    { role: "user" as const, text: question, createdAt: nowIso },
    { role: "assistant" as const, text: answer, createdAt: nowIso },
  ];
  const expiresAt = new Date(now.getTime() + GIT_REVIEW_THREAD_TTL_MS).toISOString();
  db.prepare("UPDATE git_review_threads SET messages = ?, updated_at = ?, expires_at = ? WHERE id = ?")
    .run(JSON.stringify(messages), nowIso, expiresAt, id);
  return { ...thread, messages, updatedAt: nowIso, expiresAt };
}

export interface GitReviewThreadSummary {
  id: string;
  conversationId: string | null;
  harnessId: HarnessId;
  modelId: string;
  selection: GitReviewSelection;
  question: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

function toSummary(thread: GitReviewThread): GitReviewThreadSummary {
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
    expiresAt: thread.expiresAt,
  };
}

/** Lists non-expired review threads for a project, optionally filtered to one conversation. */
export function listGitReviewThreads(projectId: string, conversationId?: string | null): GitReviewThreadSummary[] {
  const db = reviewDatabase();
  const nowIso = new Date().toISOString();
  pruneExpired(db, nowIso);
  const rows = conversationId === undefined
    ? db.prepare("SELECT * FROM git_review_threads WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as unknown as ThreadRow[]
    : db.prepare("SELECT * FROM git_review_threads WHERE project_id = ? AND conversation_id IS ? ORDER BY updated_at DESC").all(projectId, conversationId) as unknown as ThreadRow[];
  return rows.map((row) => toSummary(rowToThread(row)));
}

export function deleteGitReviewThread(id: string): boolean {
  const db = reviewDatabase();
  const result = db.prepare("DELETE FROM git_review_threads WHERE id = ?").run(id);
  return result.changes > 0;
}
