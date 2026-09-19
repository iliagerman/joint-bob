import { conversationRuntimeDatabase } from "./conversation-runtime.js";
import type { ChatMessage, HarnessId } from "./types.js";

export interface TurnFailure { failedAt: string; error: string; }

function database(): ReturnType<typeof conversationRuntimeDatabase> {
  const db = conversationRuntimeDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_turn_failures (
    engine TEXT NOT NULL, session_id TEXT NOT NULL, failed_at TEXT NOT NULL, error TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS conversation_turn_failures_session ON conversation_turn_failures(engine, session_id, failed_at)");
  return db;
}

/** A harness turn that failed leaves a record the conversation shows on every reopen, not just a passing toast. */
export function recordTurnFailure(engine: HarnessId, sessionId: string, error: string, failedAt = new Date().toISOString()): void {
  database().prepare("INSERT INTO conversation_turn_failures VALUES (?, ?, ?, ?)").run(engine, sessionId, failedAt, error);
}

export function listTurnFailures(engine: HarnessId, sessionId: string): TurnFailure[] {
  const rows = database().prepare("SELECT failed_at, error FROM conversation_turn_failures WHERE engine = ? AND session_id = ? ORDER BY failed_at, rowid").all(engine, sessionId);
  return rows.map((row) => ({ failedAt: String(row.failed_at), error: String(row.error) }));
}

/** Places each failure before the first message recorded after it, so it reads where the turn broke. */
export function withTurnFailures(messages: ChatMessage[], failures: TurnFailure[]): ChatMessage[] {
  if (!failures.length) return messages;
  const merged = [...messages];
  failures.forEach((failure, index) => {
    const message: ChatMessage = { id: `failure:${failure.failedAt}:${index}`, role: "error", text: failure.error, timestamp: failure.failedAt };
    const later = merged.findIndex((candidate) => candidate.timestamp !== undefined && candidate.timestamp > failure.failedAt);
    merged.splice(later === -1 ? merged.length : later, 0, message);
  });
  return merged;
}
