import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import test from "node:test";
import { syncConversationReviewStates } from "../src/conversation-reviews.js";
import { resolveDataDirectory } from "../src/data-directory.js";

test("review reconciliation reserves the writer before reading", (t) => {
  const session = {
    path: "review-lock-session",
    engine: "pi" as const,
    sessionId: "review-lock-session",
    updatedAt: "2026-01-01T00:00:00.000Z",
    running: false,
  };
  syncConversationReviewStates("u", "user", "project", [session]);

  const writer = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  try {
    writer.exec("PRAGMA busy_timeout = 0; CREATE TABLE review_lock_probe(value INTEGER); INSERT INTO review_lock_probe VALUES (0);");
    const statementPrototype = Object.getPrototypeOf(writer.prepare("SELECT 1")) as object;
    const original = (statementPrototype as { get: StatementSync["get"] }).get;
    let attempted = false;
    let blocked = false;
    t.mock.method(statementPrototype, "get", function (this: StatementSync, ...args: SQLInputValue[]) {
      const result = original.apply(this, args);
      if (!attempted && this.sourceSQL.includes("SELECT initialized_at FROM conversation_review_tracking")) {
        attempted = true;
        try {
          writer.exec("UPDATE review_lock_probe SET value = 1");
        } catch (error) {
          if ((error as { errcode?: number }).errcode !== 5) throw error;
          blocked = true;
        }
      }
      return result;
    });

    const states = syncConversationReviewStates("u", "user", "project", [{
      ...session,
      updatedAt: "2026-01-02T00:00:00.000Z",
    }]);
    assert.equal(states.get(session.path), "needs_review");
    assert.equal(attempted, true);
    assert.equal(blocked, true);

    writer.exec("UPDATE review_lock_probe SET value = 1");
    const row = writer.prepare("SELECT value FROM review_lock_probe").get() as { value: number };
    assert.equal(row.value, 1);
  } finally {
    writer.close();
  }
});
