import { conversationRuntimeDatabase } from "./conversation-runtime.js";
function database() {
  const db = conversationRuntimeDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_turn_failures (
    engine TEXT NOT NULL, session_id TEXT NOT NULL, failed_at TEXT NOT NULL, error TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS conversation_turn_failures_session ON conversation_turn_failures(engine, session_id, failed_at)");
  return db;
}
function recordTurnFailure(engine, sessionId, error, failedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  database().prepare("INSERT INTO conversation_turn_failures VALUES (?, ?, ?, ?)").run(engine, sessionId, failedAt, error);
}
function listTurnFailures(engine, sessionId) {
  const rows = database().prepare("SELECT failed_at, error FROM conversation_turn_failures WHERE engine = ? AND session_id = ? ORDER BY failed_at, rowid").all(engine, sessionId);
  return rows.map((row) => ({ failedAt: String(row.failed_at), error: String(row.error) }));
}
function withTurnFailures(messages, failures) {
  if (!failures.length) return messages;
  const merged = [...messages];
  failures.forEach((failure, index) => {
    const message = { id: `failure:${failure.failedAt}:${index}`, role: "error", text: failure.error, timestamp: failure.failedAt };
    const later = merged.findIndex((candidate) => candidate.timestamp !== void 0 && candidate.timestamp > failure.failedAt);
    merged.splice(later === -1 ? merged.length : later, 0, message);
  });
  return merged;
}
export {
  listTurnFailures,
  recordTurnFailure,
  withTurnFailures
};
