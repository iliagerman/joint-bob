import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-directory.js";
let database;
let directory;
function summaryDatabase() {
  const current = resolveDataDirectory();
  if (database && directory === current) return database;
  database?.close();
  mkdirSync(current, { recursive: true, mode: 448 });
  database = new DatabaseSync(path.join(current, "node.db"));
  database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS transcript_summaries(kind TEXT NOT NULL, file TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind, file))");
  directory = current;
  return database;
}
function storedTranscriptSummary(kind, file) {
  const row = summaryDatabase().prepare("SELECT payload FROM transcript_summaries WHERE kind=? AND file=?").get(kind, file);
  return row ? JSON.parse(row.payload) : void 0;
}
function storeTranscriptSummary(kind, file, value) {
  summaryDatabase().prepare("INSERT INTO transcript_summaries VALUES(?,?,?) ON CONFLICT(kind, file) DO UPDATE SET payload=excluded.payload").run(kind, file, JSON.stringify(value));
}
function forgetTranscriptSummary(kind, file) {
  summaryDatabase().prepare("DELETE FROM transcript_summaries WHERE kind=? AND file=?").run(kind, file);
}
export {
  forgetTranscriptSummary,
  storeTranscriptSummary,
  storedTranscriptSummary
};
