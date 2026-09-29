import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-directory.js";

/**
 * Conversation catalogs summarize every transcript, and those summaries lived only in memory,
 * so each restart re-read and re-parsed every transcript on disk: gigabytes on a machine that
 * also holds its twin's history. A restarting node stayed too busy to report healthy, and
 * every failed start began again from nothing. The summaries are kept here instead. They are
 * local-only: they describe this machine's files.
 */
let database: DatabaseSync | undefined;
let directory: string | undefined;

function summaryDatabase(): DatabaseSync {
  const current = resolveDataDirectory();
  if (database && directory === current) return database;
  database?.close();
  mkdirSync(current, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(path.join(current, "node.db"));
  database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS transcript_summaries(kind TEXT NOT NULL, file TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind, file))");
  directory = current;
  return database;
}

export function storedTranscriptSummary<T>(kind: string, file: string): T | undefined {
  const row = summaryDatabase().prepare("SELECT payload FROM transcript_summaries WHERE kind=? AND file=?").get(kind, file) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as T : undefined;
}

export function storeTranscriptSummary(kind: string, file: string, value: unknown): void {
  summaryDatabase().prepare("INSERT INTO transcript_summaries VALUES(?,?,?) ON CONFLICT(kind, file) DO UPDATE SET payload=excluded.payload").run(kind, file, JSON.stringify(value));
}

export function forgetTranscriptSummary(kind: string, file: string): void {
  summaryDatabase().prepare("DELETE FROM transcript_summaries WHERE kind=? AND file=?").run(kind, file);
}
