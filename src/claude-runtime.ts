import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ClaudeHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
}

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
const runningEvents = new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse"]);
const stoppedEvents = new Set(["SessionStart", "Stop", "StopFailure", "SessionEnd"]);
const staleAfterMs = 12 * 60 * 60 * 1000;
let database: DatabaseSync | undefined;

function runtimeDatabase(): DatabaseSync {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS claude_runtime_sessions (
      transcript_path TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      running INTEGER NOT NULL
    );
  `);
  return database;
}

function validateHookInput(input: unknown): ClaudeHookInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Claude hook input must be an object");
  const value = input as Record<string, unknown>;
  if (typeof value.session_id !== "string" || !value.session_id.trim()) throw new Error("Claude hook session_id is required");
  if (typeof value.transcript_path !== "string" || !path.isAbsolute(value.transcript_path) || !value.transcript_path.endsWith(".jsonl")) throw new Error("Claude hook transcript_path must be an absolute .jsonl path");
  if (typeof value.cwd !== "string" || !value.cwd.trim()) throw new Error("Claude hook cwd is required");
  if (typeof value.hook_event_name !== "string" || (!runningEvents.has(value.hook_event_name) && !stoppedEvents.has(value.hook_event_name))) throw new Error("Claude hook event is unsupported");
  return {
    session_id: value.session_id.trim(),
    transcript_path: path.resolve(value.transcript_path),
    cwd: value.cwd.trim(),
    hook_event_name: value.hook_event_name,
  };
}

export function recordClaudeHookEvent(input: unknown): void {
  const event = validateHookInput(input);
  const running = runningEvents.has(event.hook_event_name) ? 1 : 0;
  const db = runtimeDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO claude_runtime_sessions (transcript_path, session_id, updated_at, running)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(transcript_path) DO UPDATE SET
        session_id = excluded.session_id, updated_at = excluded.updated_at, running = excluded.running
    `).run(event.transcript_path, event.session_id, new Date().toISOString(), running);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function isClaudeSessionRunning(sessionPath: string): boolean {
  const transcriptPath = path.resolve(sessionPath.replace(/^claude:/, ""));
  const row = runtimeDatabase().prepare("SELECT updated_at, running FROM claude_runtime_sessions WHERE transcript_path = ?").get(transcriptPath) as { updated_at: string; running: number } | undefined;
  return Boolean(row?.running && Date.now() - Date.parse(row.updated_at) <= staleAfterMs);
}

/** Claude Code turns driven outside Joint Bob (hooks only) that are running right now. */
export function listRunningClaudeSessions(): Array<{ sessionId: string; transcriptPath: string }> {
  const rows = runtimeDatabase().prepare("SELECT session_id, transcript_path, updated_at, running FROM claude_runtime_sessions WHERE running = 1").all() as Array<{ session_id: string; transcript_path: string; updated_at: string; running: number }>;
  const now = Date.now();
  return rows
    .filter((row) => now - Date.parse(row.updated_at) <= staleAfterMs)
    .map((row) => ({ sessionId: row.session_id, transcriptPath: row.transcript_path }));
}
