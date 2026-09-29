import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("conversation review state starts reviewed and tracks later completion per account", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-reviews-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const reviews = await import(`../src/conversation-reviews.ts?test=${Date.now()}-${Math.random()}`);
    const session = { path: "session", engine: "pi" as const, sessionId: "session-id", updatedAt: "2026-01-01T00:00:00.000Z", running: false };
    const initial = reviews.syncConversationReviewStates("user-a", "user-a-name", "project", [session]);
    assert.equal(initial.get("session"), "reviewed");

    const newSessionTime = new Date(Date.now() + 1000).toISOString();
    const newSession = reviews.syncConversationReviewStates("user-a", "user-a-name", "project", [
      session,
      { path: "new-session", engine: "pi" as const, sessionId: "new-session-id", updatedAt: newSessionTime, running: false },
    ]);
    assert.equal(newSession.get("new-session"), "needs_review");

    const running = reviews.syncConversationReviewStates("user-a", "user-a-name", "project", [{ ...session, updatedAt: "2026-01-01T00:01:00.000Z", running: true }]);
    assert.equal(running.get("session"), "running");
    const finished = reviews.syncConversationReviewStates("user-a", "user-a-name", "project", [{ ...session, updatedAt: "2026-01-01T00:01:00.000Z", running: false }]);
    assert.equal(finished.get("session"), "needs_review");

    reviews.markConversationReviewed("user-a", "user-a-name", "project", { ...session, updatedAt: "2026-01-01T00:01:00.000Z" }, "node-a");
    const reviewed = reviews.syncConversationReviewStates("user-a", "user-a-name", "project", [{ ...session, updatedAt: "2026-01-01T00:01:00.000Z", running: false }]);
    assert.equal(reviewed.get("session"), "reviewed");

    const otherAccount = reviews.syncConversationReviewStates("user-b", "user-b-name", "project", [{ ...session, updatedAt: "2026-01-01T00:01:00.000Z", running: false }]);
    assert.equal(otherAccount.get("session"), "reviewed");

    const bulkTime = new Date(Date.now() + 1000).toISOString();
    const bulkSessions = [
      { path: "bulk-a", engine: "pi" as const, sessionId: "bulk-a-id", updatedAt: bulkTime, running: false },
      { path: "bulk-b", engine: "pi" as const, sessionId: "bulk-b-id", updatedAt: bulkTime, running: false },
    ];
    const bulkPending = reviews.syncConversationReviewStates("user-a", "user-a-name", "project", bulkSessions);
    assert.equal(bulkPending.get("bulk-a"), "needs_review");
    assert.equal(bulkPending.get("bulk-b"), "needs_review");
    reviews.markConversationsReviewed("user-a", "user-a-name", "project", bulkSessions, "node-a");
    const bulkReviewed = reviews.syncConversationReviewStates("user-a", "user-a-name", "project", bulkSessions);
    assert.equal(bulkReviewed.get("bulk-a"), "reviewed");
    assert.equal(bulkReviewed.get("bulk-b"), "reviewed");

    const clickWatermark = new Date(Date.now() + 2000).toISOString();
    const afterClick = new Date(Date.now() + 3000).toISOString();
    const raceSession = { path: "race", engine: "pi" as const, sessionId: "race-id", running: false };
    reviews.syncConversationReviewStates("user-a", "user-a-name", "project", [{ ...raceSession, updatedAt: clickWatermark }]);
    reviews.syncConversationReviewStates("user-a", "user-a-name", "project", [{ ...raceSession, updatedAt: afterClick }]);
    reviews.markConversationReviewed("user-a", "user-a-name", "project", { ...raceSession, updatedAt: clickWatermark }, "node-a");
    const race = reviews.syncConversationReviewStates("user-a", "user-a-name", "project", [{ ...raceSession, updatedAt: afterClick }]);
    assert.equal(race.get("race"), "needs_review");
    assert.throws(() => reviews.markConversationReviewed("user-a", "user-a-name", "project", { ...raceSession }), /watermark is invalid/);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

