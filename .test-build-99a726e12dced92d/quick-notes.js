import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";
import { resolveDataDirectory } from "./data-directory.js";
let database = null;
function imagesDirectory() {
  return path.join(resolveDataDirectory(), "quick-note-images");
}
function imageFile(noteId, imageId) {
  return path.join(imagesDirectory(), noteId, imageId);
}
function db() {
  if (database) return database;
  const directory = resolveDataDirectory();
  mkdirSync(directory, { recursive: true, mode: 448 });
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
  const columns = database.prepare("PRAGMA table_info(quick_notes)").all().map((column) => column.name);
  const migration = [
    ["position", "INTEGER NOT NULL DEFAULT 0"],
    ["node_id", "TEXT"],
    ["secret_account_ids", "TEXT NOT NULL DEFAULT '[]'"],
    ["scheduled_at", "TEXT"],
    ["status", "TEXT NOT NULL DEFAULT 'pending'"],
    ["error", "TEXT"],
    ["session_id", "TEXT"],
    ["launch_request_id", "TEXT"]
  ];
  for (const [column, definition] of migration) if (!columns.includes(column)) database.exec(`ALTER TABLE quick_notes ADD COLUMN ${column} ${definition}`);
  if (!columns.includes("dispatched_at")) database.exec(`BEGIN IMMEDIATE;
    ALTER TABLE quick_notes ADD COLUMN dispatched_at TEXT;
    UPDATE quick_notes SET dispatched_at = updated_at WHERE session_id IS NOT NULL;
    COMMIT;`);
  if (!columns.includes("position")) database.exec(`WITH ranked AS (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rank FROM quick_notes)
    UPDATE quick_notes SET position = (SELECT rank FROM ranked WHERE ranked.id = quick_notes.id)`);
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
function decodeImage(input) {
  if (input.id && !/^[a-f0-9-]{36}$/i.test(input.id)) throw new Error("Invalid image id");
  const bytes = Buffer.from(input.data, "base64");
  if (bytes.byteLength === 0 || bytes.toString("base64") !== input.data) throw new Error("Invalid base64 image data");
  return { id: input.id ?? randomUUID(), name: input.name, mimeType: input.mimeType, bytes };
}
function storeImages(noteId, inputs) {
  const directory = path.join(imagesDirectory(), noteId);
  mkdirSync(directory, { recursive: true, mode: 448 });
  const decoded = inputs.map(decodeImage);
  const keep = new Set(decoded.map((image) => image.id));
  for (const existing of readdirSync(directory)) {
    if (!keep.has(existing)) {
      try {
        unlinkSync(path.join(directory, existing));
      } catch {
      }
    }
  }
  const rows = db().prepare("SELECT id, note_id, name, mime_type FROM quick_note_images WHERE note_id = ?").all(noteId);
  for (const row of rows) if (!keep.has(row.id)) db().prepare("DELETE FROM quick_note_images WHERE note_id = ? AND id = ?").run(noteId, row.id);
  for (const image of decoded) {
    writeFileSync(path.join(directory, image.id), image.bytes, { mode: 384 });
    db().prepare(`INSERT INTO quick_note_images (id, note_id, name, mime_type) VALUES (?, ?, ?, ?)
      ON CONFLICT(note_id, id) DO UPDATE SET name = excluded.name, mime_type = excluded.mime_type`).run(image.id, noteId, image.name, image.mimeType);
  }
  try {
    if (decoded.length === 0) rmSync(directory, { recursive: true, force: true });
  } catch {
  }
  return decoded.map((image) => ({ id: image.id, kind: "image", name: image.name, mimeType: image.mimeType, data: image.bytes.toString("base64") }));
}
function fromRow(row, tolerateMissing = false) {
  let missingImage = null;
  const images = db().prepare("SELECT id, note_id, name, mime_type FROM quick_note_images WHERE note_id = ? ORDER BY id").all(row.id).map((image) => {
    let data = "";
    try {
      data = readFileSync(imageFile(row.id, image.id)).toString("base64");
    } catch {
      missingImage = `Quick note image file is missing: ${image.name}`;
      if (!tolerateMissing) throw new Error(missingImage);
    }
    return { id: image.id, kind: "image", name: image.name, mimeType: image.mime_type, data };
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
    secretAccountIds: JSON.parse(row.secret_account_ids),
    images,
    scheduledAt: row.scheduled_at,
    status: missingImage ? "failed" : row.status,
    error: missingImage || row.error,
    sessionId: row.session_id,
    launchRequestId: row.launch_request_id,
    dispatchedAt: row.dispatched_at,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function noteRow(id) {
  return db().prepare("SELECT * FROM quick_notes WHERE id = ?").get(id);
}
function listQuickNotes(projectId) {
  return db().prepare("SELECT * FROM quick_notes WHERE project_id = ? AND status IN ('pending', 'failed') ORDER BY position, created_at, id").all(projectId).map((row) => fromRow(row, true));
}
function listAllQuickNotes() {
  return db().prepare("SELECT * FROM quick_notes WHERE status IN ('pending', 'failed') ORDER BY position, created_at, id").all().map((row) => fromRow(row, true));
}
function listPendingQuickNoteSummaries() {
  return db().prepare("SELECT id, project_id AS projectId, status, position, created_at AS createdAt, scheduled_at AS scheduledAt FROM quick_notes WHERE status = 'pending' AND dispatched_at IS NULL ORDER BY position, created_at, id").all();
}
function moveQuickNote(id, targetId) {
  const database2 = db();
  database2.exec("BEGIN IMMEDIATE");
  try {
    const note = noteRow(id), target = noteRow(targetId);
    if (!note || !target || note.dispatched_at || target.dispatched_at || ![note.status, target.status].every((status) => ["pending", "failed"].includes(status))) {
      throw new Error("Only backlog notes on the same home node can be reordered");
    }
    database2.prepare("UPDATE quick_notes SET position = CASE id WHEN ? THEN ? ELSE ? END WHERE id IN (?, ?)").run(id, target.position, note.position, id, targetId);
    database2.exec("COMMIT");
  } catch (error) {
    database2.exec("ROLLBACK");
    throw error;
  }
}
function getQuickNote(id) {
  const row = noteRow(id);
  return row ? fromRow(row) : void 0;
}
function insertNote(input, id, now, status) {
  const provider = input.provider ?? null;
  const modelId = input.modelId ?? null;
  if (Boolean(provider) !== Boolean(modelId)) throw new Error("Provider and model must be selected together");
  const row = {
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
    dispatched_at: null,
    position: db().prepare("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM quick_notes").get().position,
    created_at: now,
    updated_at: now
  };
  db().prepare(`INSERT INTO quick_notes
    (id, project_id, title, content, harness_id, provider, model_id, thinking_level, node_id, secret_account_ids, scheduled_at, status, error, session_id, launch_request_id, created_at, updated_at, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.project_id, row.title, row.content, row.harness_id, row.provider, row.model_id, row.thinking_level, row.node_id, row.secret_account_ids, row.scheduled_at, row.status, row.error, row.session_id, row.launch_request_id, row.created_at, row.updated_at, row.position);
  return row;
}
function createQuickNote(input) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  input.images?.forEach(decodeImage);
  const row = insertNote(input, nanoid(12), now, "pending");
  if (input.images?.length) storeImages(row.id, input.images);
  return fromRow(row);
}
function updateQuickNote(id, input) {
  const row = noteRow(id);
  if (!row) return void 0;
  const existing = fromRow(row, true);
  if (row.dispatched_at) throw new Error("This note was already dispatched; its launch cannot be edited. Open its conversation instead");
  if (!["pending", "failed"].includes(row.status)) throw new Error("Wait for the quick note launch to finish before editing it");
  input.images?.forEach(decodeImage);
  const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  const provider = input.provider ?? null;
  const modelId = input.modelId ?? null;
  if (Boolean(provider) !== Boolean(modelId)) throw new Error("Provider and model must be selected together");
  db().prepare(`UPDATE quick_notes SET project_id = ?, title = ?, content = ?, harness_id = ?, provider = ?, model_id = ?, thinking_level = ?,
    node_id = ?, secret_account_ids = ?, scheduled_at = ?, status = 'pending', error = NULL, updated_at = ? WHERE id = ?`).run(
    input.projectId,
    input.title.trim(),
    input.content,
    input.harnessId,
    provider,
    modelId,
    input.thinkingLevel ?? null,
    input.nodeId ?? null,
    JSON.stringify([...new Set(input.secretAccountIds ?? [])]),
    input.scheduledAt ?? null,
    updatedAt,
    id
  );
  storeImages(id, input.images ?? existing.images.map(({ id: imageId, kind, name, mimeType, data }) => ({ id: imageId, kind, name, mimeType, data })));
  return getQuickNote(id);
}
function deleteQuickNote(id) {
  const changed = db().prepare("DELETE FROM quick_notes WHERE id = ?").run(id).changes > 0;
  if (changed) {
    try {
      rmSync(path.join(imagesDirectory(), id), { recursive: true, force: true });
    } catch {
    }
  }
  return changed;
}
function claimQuickNoteForLaunch(id, sessionId, launchRequestId, from = ["pending"]) {
  const placeholders = from.map(() => "?").join(", ");
  const changed = db().prepare(`UPDATE quick_notes SET status = 'starting', session_id = ?, launch_request_id = ?, error = NULL, updated_at = ? WHERE id = ? AND dispatched_at IS NULL AND status IN (${placeholders})`).run(sessionId, launchRequestId, (/* @__PURE__ */ new Date()).toISOString(), id, ...from).changes > 0;
  return changed ? getQuickNote(id) : void 0;
}
function markQuickNoteDispatched(id) {
  db().prepare("UPDATE quick_notes SET dispatched_at = COALESCE(dispatched_at, ?), updated_at = ? WHERE id = ? AND status = 'starting'").run((/* @__PURE__ */ new Date()).toISOString(), (/* @__PURE__ */ new Date()).toISOString(), id);
}
function markQuickNoteStarted(id) {
  markQuickNoteDispatched(id);
  db().prepare("UPDATE quick_notes SET status = 'started', updated_at = ? WHERE id = ? AND status = 'starting'").run((/* @__PURE__ */ new Date()).toISOString(), id);
}
function finishQuickNote(id, status, error) {
  db().prepare("UPDATE quick_notes SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, error, (/* @__PURE__ */ new Date()).toISOString(), id);
}
function getQuickNoteQueue() {
  const row = db().prepare("SELECT enabled, max_parallel FROM quick_note_queue WHERE singleton = 1").get();
  return { enabled: Boolean(row.enabled), maxParallel: row.max_parallel };
}
function setQuickNoteQueue(update) {
  if (update.maxParallel !== void 0) {
    if (!Number.isInteger(update.maxParallel) || update.maxParallel < 1 || update.maxParallel > 20) throw new Error("Parallel limit must be a whole number between 1 and 20");
  }
  const current = getQuickNoteQueue();
  const next = { enabled: update.enabled ?? current.enabled, maxParallel: update.maxParallel ?? current.maxParallel };
  db().prepare("UPDATE quick_note_queue SET enabled = ?, max_parallel = ?, suspended = 0 WHERE singleton = 1").run(next.enabled ? 1 : 0, next.maxParallel);
  return next;
}
function disableQuickNoteQueue() {
  db().prepare("UPDATE quick_note_queue SET enabled = 0, suspended = 1 WHERE singleton = 1").run();
}
function recoverUncertainQuickNoteLaunches() {
  const uncertain = db().prepare("SELECT * FROM quick_notes WHERE status IN ('starting', 'started')").all();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (const row of uncertain) {
    db().prepare("UPDATE quick_notes SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run("Node restarted during the quick note launch; outcome uncertain.", now, row.id);
  }
  return uncertain.map((row) => ({ id: row.id, projectId: row.project_id, sessionId: row.session_id, launchRequestId: row.launch_request_id, harnessId: row.harness_id }));
}
function quickNoteQueueSuspended() {
  return Boolean(db().prepare("SELECT suspended FROM quick_note_queue WHERE singleton = 1").get()?.suspended);
}
export {
  claimQuickNoteForLaunch,
  createQuickNote,
  deleteQuickNote,
  disableQuickNoteQueue,
  finishQuickNote,
  getQuickNote,
  getQuickNoteQueue,
  listAllQuickNotes,
  listPendingQuickNoteSummaries,
  listQuickNotes,
  markQuickNoteDispatched,
  markQuickNoteStarted,
  moveQuickNote,
  quickNoteQueueSuspended,
  recoverUncertainQuickNoteLaunches,
  setQuickNoteQueue,
  updateQuickNote
};
