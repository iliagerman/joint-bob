import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";
import { resolveDataDirectory } from "./data-directory.js";

/**
 * Quick notes are paused drafts. They sit in a node-local backlog until they are
 * launched through the prompt queue; only `pending` and `failed` notes are
 * backlog, because a started note lives on as a conversation of its own.
 */
export type QuickNoteStatus = "pending" | "starting" | "started" | "completed" | "failed";

export interface QuickNoteImage {
  id: string;
  kind: "image";
  name: string;
  mimeType: string;
  /** Base64 bytes on the wire; on disk they are the node's own files. */
  data: string;
}

export interface QuickNote {
  id: string;
  projectId: string;
  title: string;
  content: string;
  harnessId: string;
  provider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  /** Execution node the note names; null runs on the note's own node. */
  nodeId: string | null;
  secretAccountIds: string[];
  images: QuickNoteImage[];
  /** One-time due instant; a scheduled note never starts before it. */
  scheduledAt: string | null;
  status: QuickNoteStatus;
  error: string | null;
  sessionId: string | null;
  launchRequestId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuickNoteImageInput {
  id?: string;
  kind: "image";
  name: string;
  mimeType: string;
  data: string;
}

export interface QuickNoteInput {
  projectId: string;
  title: string;
  content: string;
  harnessId: string;
  provider?: string | null;
  modelId?: string | null;
  thinkingLevel?: string | null;
  nodeId?: string | null;
  secretAccountIds?: string[];
  images?: QuickNoteImageInput[];
  scheduledAt?: string | null;
}

/** Global node-local control over automatic quick note dispatch. */
export interface QuickNoteQueue { enabled: boolean; maxParallel: number }

interface QuickNoteRow {
  id: string;
  project_id: string;
  title: string;
  content: string;
  harness_id: string;
  provider: string | null;
  model_id: string | null;
  thinking_level: string | null;
  node_id: string | null;
  secret_account_ids: string;
  scheduled_at: string | null;
  status: string;
  error: string | null;
  session_id: string | null;
  launch_request_id: string | null;
  created_at: string;
  updated_at: string;
}

interface QuickNoteImageRow { id: string; note_id: string; name: string; mime_type: string }

let database: DatabaseSync | null = null;

function imagesDirectory(): string {
  return path.join(resolveDataDirectory(), "quick-note-images");
}

function imageFile(noteId: string, imageId: string): string {
  return path.join(imagesDirectory(), noteId, imageId);
}

function db(): DatabaseSync {
  if (database) return database;
  const directory = resolveDataDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(path.join(directory, "node.db"));
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS quick_notes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      harness_id TEXT NOT NULL,
      provider TEXT,
      model_id TEXT,
      thinking_level TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS quick_notes_project_updated ON quick_notes(project_id, updated_at DESC);`);
  const columns = (database.prepare("PRAGMA table_info(quick_notes)").all() as Array<{ name: string }>).map((column) => column.name);
  const migration: Array<[string, string]> = [
    ["node_id", "TEXT"],
    ["secret_account_ids", "TEXT NOT NULL DEFAULT '[]'"],
    ["scheduled_at", "TEXT"],
    ["status", "TEXT NOT NULL DEFAULT 'pending'"],
    ["error", "TEXT"],
    ["session_id", "TEXT"],
    ["launch_request_id", "TEXT"],
  ];
  for (const [column, definition] of migration) if (!columns.includes(column)) database.exec(`ALTER TABLE quick_notes ADD COLUMN ${column} ${definition}`);
  database.exec(`CREATE TABLE IF NOT EXISTS quick_note_images (
      id TEXT NOT NULL,
      note_id TEXT NOT NULL REFERENCES quick_notes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      PRIMARY KEY (note_id, id)
    );
    CREATE TABLE IF NOT EXISTS quick_note_queue (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      max_parallel INTEGER NOT NULL DEFAULT 1,
      suspended INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO quick_note_queue (singleton, enabled, max_parallel) VALUES (1, 0, 1);
    CREATE INDEX IF NOT EXISTS quick_notes_backlog ON quick_notes(status, created_at, id);`);
  return database;
}

function decodeImage(input: QuickNoteImageInput): { id: string; name: string; mimeType: string; bytes: Buffer } {
  if (input.id && !/^[a-f0-9-]{36}$/i.test(input.id)) throw new Error("Invalid image id");
  const bytes = Buffer.from(input.data, "base64");
  if (bytes.byteLength === 0 || bytes.toString("base64") !== input.data) throw new Error("Invalid base64 image data");
  return { id: input.id ?? randomUUID(), name: input.name, mimeType: input.mimeType, bytes };
}

function storeImages(noteId: string, inputs: QuickNoteImageInput[]): QuickNoteImage[] {
  const directory = path.join(imagesDirectory(), noteId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const decoded = inputs.map(decodeImage);
  // The incoming set fully replaces whatever the note held before.
  const keep = new Set(decoded.map((image) => image.id));
  for (const existing of readdirSync(directory)) {
    if (!keep.has(existing)) { try { unlinkSync(path.join(directory, existing)); } catch { /* already gone */ } }
  }
  const rows = db().prepare("SELECT id, note_id, name, mime_type FROM quick_note_images WHERE note_id = ?").all(noteId) as unknown as QuickNoteImageRow[];
  for (const row of rows) if (!keep.has(row.id)) db().prepare("DELETE FROM quick_note_images WHERE note_id = ? AND id = ?").run(noteId, row.id);
  for (const image of decoded) {
    writeFileSync(path.join(directory, image.id), image.bytes, { mode: 0o600 });
    db().prepare(`INSERT INTO quick_note_images (id, note_id, name, mime_type) VALUES (?, ?, ?, ?)
      ON CONFLICT(note_id, id) DO UPDATE SET name = excluded.name, mime_type = excluded.mime_type`).run(image.id, noteId, image.name, image.mimeType);
  }
  try { if (decoded.length === 0) rmSync(directory, { recursive: true, force: true }); } catch { /* nothing to clean */ }
  return decoded.map((image) => ({ id: image.id, kind: "image" as const, name: image.name, mimeType: image.mimeType, data: image.bytes.toString("base64") }));
}

function fromRow(row: QuickNoteRow, tolerateMissing = false): QuickNote {
  let missingImage: string | null = null;
  const images = (db().prepare("SELECT id, note_id, name, mime_type FROM quick_note_images WHERE note_id = ? ORDER BY id").all(row.id) as unknown as QuickNoteImageRow[])
    .map((image) => {
      let data = "";
      try { data = readFileSync(imageFile(row.id, image.id)).toString("base64"); }
      catch {
        missingImage = `Quick note image file is missing: ${image.name}`;
        if (!tolerateMissing) throw new Error(missingImage);
      }
      return { id: image.id, kind: "image" as const, name: image.name, mimeType: image.mime_type, data };
    });
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    content: row.content,
    harnessId: row.harness_id,
    provider: row.provider,
    modelId: row.model_id,
    thinkingLevel: row.thinking_level,
    nodeId: row.node_id,
    secretAccountIds: JSON.parse(row.secret_account_ids) as string[],
    images,
    scheduledAt: row.scheduled_at,
    status: missingImage ? "failed" : row.status as QuickNoteStatus,
    error: missingImage || row.error,
    sessionId: row.session_id,
    launchRequestId: row.launch_request_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function noteRow(id: string): QuickNoteRow | undefined {
  return db().prepare("SELECT * FROM quick_notes WHERE id = ?").get(id) as unknown as QuickNoteRow | undefined;
}

/** Backlog listing for one project: paused drafts and failed launches only. */
export function listQuickNotes(projectId: string): QuickNote[] {
  return (db().prepare("SELECT * FROM quick_notes WHERE project_id = ? AND status IN ('pending', 'failed') ORDER BY updated_at DESC, id").all(projectId) as unknown as QuickNoteRow[]).map(row => fromRow(row, true));
}

/** Backlog listing across every project on this node. */
export function listAllQuickNotes(): QuickNote[] {
  return (db().prepare("SELECT * FROM quick_notes WHERE status IN ('pending', 'failed') ORDER BY updated_at DESC, id").all() as unknown as QuickNoteRow[]).map(row => fromRow(row, true));
}

/** Dispatch order: every pending note on the node, oldest first. */
export function listPendingQuickNoteSummaries(): Array<Pick<QuickNote, "id" | "status" | "createdAt" | "scheduledAt">> {
  return db().prepare("SELECT id, status, created_at AS createdAt, scheduled_at AS scheduledAt FROM quick_notes WHERE status = 'pending' ORDER BY created_at, id").all() as unknown as Array<Pick<QuickNote, "id" | "status" | "createdAt" | "scheduledAt">>;
}

export function getQuickNote(id: string): QuickNote | undefined {
  const row = noteRow(id);
  return row ? fromRow(row) : undefined;
}

function insertNote(input: QuickNoteInput, id: string, now: string, status: QuickNoteStatus): QuickNoteRow {
  const provider = input.provider ?? null;
  const modelId = input.modelId ?? null;
  if (Boolean(provider) !== Boolean(modelId)) throw new Error("Provider and model must be selected together");
  const row: QuickNoteRow = {
    id,
    project_id: input.projectId,
    title: input.title.trim(),
    content: input.content,
    harness_id: input.harnessId,
    provider,
    model_id: modelId,
    thinking_level: input.thinkingLevel ?? null,
    node_id: input.nodeId ?? null,
    secret_account_ids: JSON.stringify([...new Set(input.secretAccountIds ?? [])]),
    scheduled_at: input.scheduledAt ?? null,
    status,
    error: null,
    session_id: null,
    launch_request_id: null,
    created_at: now,
    updated_at: now,
  };
  db().prepare(`INSERT INTO quick_notes
    (id, project_id, title, content, harness_id, provider, model_id, thinking_level, node_id, secret_account_ids, scheduled_at, status, error, session_id, launch_request_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.project_id, row.title, row.content, row.harness_id, row.provider, row.model_id, row.thinking_level, row.node_id, row.secret_account_ids, row.scheduled_at, row.status, row.error, row.session_id, row.launch_request_id, row.created_at, row.updated_at);
  return row;
}

export function createQuickNote(input: QuickNoteInput): QuickNote {
  const now = new Date().toISOString();
  input.images?.forEach(decodeImage);
  const row = insertNote(input, nanoid(12), now, "pending");
  if (input.images?.length) storeImages(row.id, input.images);
  return fromRow(row);
}

export function updateQuickNote(id: string, input: QuickNoteInput): QuickNote | undefined {
  const row = noteRow(id);
  if (!row) return undefined;
  const existing = fromRow(row, true);
  if (!["pending", "failed"].includes(row.status)) throw new Error("Wait for the quick note launch to finish before editing it");
  input.images?.forEach(decodeImage);
  const updatedAt = new Date().toISOString();
  const provider = input.provider ?? null;
  const modelId = input.modelId ?? null;
  if (Boolean(provider) !== Boolean(modelId)) throw new Error("Provider and model must be selected together");
  db().prepare(`UPDATE quick_notes SET project_id = ?, title = ?, content = ?, harness_id = ?, provider = ?, model_id = ?, thinking_level = ?,
    node_id = ?, secret_account_ids = ?, scheduled_at = ?, status = 'pending', error = NULL, updated_at = ? WHERE id = ?`)
    .run(input.projectId, input.title.trim(), input.content, input.harnessId, provider, modelId, input.thinkingLevel ?? null,
      input.nodeId ?? null, JSON.stringify([...new Set(input.secretAccountIds ?? [])]), input.scheduledAt ?? null, updatedAt, id);
  storeImages(id, input.images ?? existing.images.map(({ id: imageId, kind, name, mimeType, data }) => ({ id: imageId, kind, name, mimeType, data })));
  return getQuickNote(id);
}

export function deleteQuickNote(id: string): boolean {
  const changed = db().prepare("DELETE FROM quick_notes WHERE id = ?").run(id).changes > 0;
  if (changed) { try { rmSync(path.join(imagesDirectory(), id), { recursive: true, force: true }); } catch { /* already gone */ } }
  return changed;
}

/** Atomically moves a note into `starting` so neither a second click nor the
    scheduler's dispatch pass can launch the same note twice. */
export function claimQuickNoteForLaunch(id: string, sessionId: string, launchRequestId: string, from: QuickNoteStatus[] = ["pending"]): QuickNote | undefined {
  const placeholders = from.map(() => "?").join(", ");
  const changed = db().prepare(`UPDATE quick_notes SET status = 'starting', session_id = ?, launch_request_id = ?, error = NULL, updated_at = ? WHERE id = ? AND status IN (${placeholders})`)
    .run(sessionId, launchRequestId, new Date().toISOString(), id, ...from).changes > 0;
  return changed ? getQuickNote(id) : undefined;
}

export function markQuickNoteStarted(id: string): void {
  db().prepare("UPDATE quick_notes SET status = 'started', updated_at = ? WHERE id = ? AND status = 'starting'").run(new Date().toISOString(), id);
}

export function finishQuickNote(id: string, status: "completed" | "failed", error: string | null): void {
  db().prepare("UPDATE quick_notes SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, error, new Date().toISOString(), id);
}

export function getQuickNoteQueue(): QuickNoteQueue {
  const row = db().prepare("SELECT enabled, max_parallel FROM quick_note_queue WHERE singleton = 1").get() as { enabled: number; max_parallel: number };
  return { enabled: Boolean(row.enabled), maxParallel: row.max_parallel };
}

export function setQuickNoteQueue(update: { enabled?: boolean; maxParallel?: number }): QuickNoteQueue {
  if (update.maxParallel !== undefined) {
    if (!Number.isInteger(update.maxParallel) || update.maxParallel < 1 || update.maxParallel > 20) throw new Error("Parallel limit must be a whole number between 1 and 20");
  }
  const current = getQuickNoteQueue();
  const next = { enabled: update.enabled ?? current.enabled, maxParallel: update.maxParallel ?? current.maxParallel };
  db().prepare("UPDATE quick_note_queue SET enabled = ?, max_parallel = ?, suspended = 0 WHERE singleton = 1").run(next.enabled ? 1 : 0, next.maxParallel);
  return next;
}

/** Disables automatic dispatch after an uncertain recovery outcome. */
export function disableQuickNoteQueue(): void {
  db().prepare("UPDATE quick_note_queue SET enabled = 0, suspended = 1 WHERE singleton = 1").run();
}

/** A restart never replays an uncertain dispatch: the launch is marked failed so a
    person decides whether the conversation it may have created is enough. */
export function recoverUncertainQuickNoteLaunches(): Array<Pick<QuickNote, "id" | "projectId" | "harnessId" | "sessionId" | "launchRequestId">> {
  const uncertain = db().prepare("SELECT * FROM quick_notes WHERE status IN ('starting', 'started')").all() as unknown as QuickNoteRow[];
  const now = new Date().toISOString();
  for (const row of uncertain) {
    db().prepare("UPDATE quick_notes SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run("Node restarted during the quick note launch; outcome uncertain.", now, row.id);
  }
  return uncertain.map(row => ({ id: row.id, projectId: row.project_id, sessionId: row.session_id, launchRequestId: row.launch_request_id, harnessId: row.harness_id }));
}

export function quickNoteQueueSuspended(): boolean {
  return Boolean(db().prepare("SELECT suspended FROM quick_note_queue WHERE singleton = 1").get()?.suspended);
}
