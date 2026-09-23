import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { nanoid } from "nanoid";
import { resolveDataDirectory } from "./data-directory.js";

export interface QuickNote {
  id: string;
  projectId: string;
  title: string;
  content: string;
  harnessId: string;
  provider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuickNoteInput {
  projectId: string;
  title: string;
  content: string;
  harnessId: string;
  provider?: string | null;
  modelId?: string | null;
  thinkingLevel?: string | null;
}

interface QuickNoteRow {
  id: string;
  project_id: string;
  title: string;
  content: string;
  harness_id: string;
  provider: string | null;
  model_id: string | null;
  thinking_level: string | null;
  created_at: string;
  updated_at: string;
}

let database: DatabaseSync | null = null;

function db(): DatabaseSync {
  if (database) return database;
  database = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
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
  return database;
}

function fromRow(row: QuickNoteRow): QuickNote {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    content: row.content,
    harnessId: row.harness_id,
    provider: row.provider,
    modelId: row.model_id,
    thinkingLevel: row.thinking_level,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listQuickNotes(projectId: string): QuickNote[] {
  return (db().prepare("SELECT * FROM quick_notes WHERE project_id = ? ORDER BY updated_at DESC, id").all(projectId) as unknown as QuickNoteRow[]).map(fromRow);
}

export function getQuickNote(id: string): QuickNote | undefined {
  const row = db().prepare("SELECT * FROM quick_notes WHERE id = ?").get(id) as unknown as QuickNoteRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function createQuickNote(input: QuickNoteInput): QuickNote {
  const now = new Date().toISOString();
  const note: QuickNote = {
    id: nanoid(12),
    ...input,
    title: input.title.trim(),
    provider: input.provider ?? null,
    modelId: input.modelId ?? null,
    thinkingLevel: input.thinkingLevel ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db().prepare(`INSERT INTO quick_notes
    (id, project_id, title, content, harness_id, provider, model_id, thinking_level, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(note.id, note.projectId, note.title, note.content, note.harnessId, note.provider, note.modelId, note.thinkingLevel, note.createdAt, note.updatedAt);
  return note;
}

export function updateQuickNote(id: string, input: QuickNoteInput): QuickNote | undefined {
  const existing = getQuickNote(id);
  if (!existing) return undefined;
  const updatedAt = new Date().toISOString();
  db().prepare(`UPDATE quick_notes SET project_id = ?, title = ?, content = ?, harness_id = ?, provider = ?, model_id = ?, thinking_level = ?, updated_at = ? WHERE id = ?`)
    .run(input.projectId, input.title.trim(), input.content, input.harnessId, input.provider ?? null, input.modelId ?? null, input.thinkingLevel ?? null, updatedAt, id);
  return getQuickNote(id);
}

export function deleteQuickNote(id: string): boolean {
  return db().prepare("DELETE FROM quick_notes WHERE id = ?").run(id).changes > 0;
}
