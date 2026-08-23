import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("conversation review state starts reviewed and tracks later completion per account", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-reviews-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const reviews = await import(`../src/conversation-reviews.ts?test=${Date.now()}-${Math.random()}`);
    const initial = reviews.syncConversationReviewStates("user-a", "project", [{ path: "session", updatedAt: "2026-01-01T00:00:00.000Z", running: false }]);
    assert.equal(initial.get("session"), "reviewed");

    const newSessionTime = new Date(Date.now() + 1000).toISOString();
    const newSession = reviews.syncConversationReviewStates("user-a", "project", [
      { path: "session", updatedAt: "2026-01-01T00:00:00.000Z", running: false },
      { path: "new-session", updatedAt: newSessionTime, running: false },
    ]);
    assert.equal(newSession.get("new-session"), "needs_review");

    const running = reviews.syncConversationReviewStates("user-a", "project", [{ path: "session", updatedAt: "2026-01-01T00:01:00.000Z", running: true }]);
    assert.equal(running.get("session"), "running");
    const finished = reviews.syncConversationReviewStates("user-a", "project", [{ path: "session", updatedAt: "2026-01-01T00:01:00.000Z", running: false }]);
    assert.equal(finished.get("session"), "needs_review");

    reviews.markConversationReviewed("user-a", "project", "session");
    const reviewed = reviews.syncConversationReviewStates("user-a", "project", [{ path: "session", updatedAt: "2026-01-01T00:01:00.000Z", running: false }]);
    assert.equal(reviewed.get("session"), "reviewed");

    const otherAccount = reviews.syncConversationReviewStates("user-b", "project", [{ path: "session", updatedAt: "2026-01-01T00:01:00.000Z", running: false }]);
    assert.equal(otherAccount.get("session"), "reviewed");
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("conversation UI exposes state counts, automatic review, notifications, and sounds", async () => {
  const [html, app, styles, server] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("src/server.ts", "utf8"),
  ]);

  assert.match(html, /data-filter="active"[^>]*>Running <span/);
  assert.match(html, /data-filter="review"[^>]*>Needs review <span/);
  assert.match(html, /data-filter="done"[^>]*>Reviewed <span/);
  assert.match(html, /id="completionSoundSelect"[^>]*data-testid="notifications-sound-select"/);
  assert.match(html, /id="previewSoundButton"[^>]*data-testid="notifications-sound-preview-button"/);
  assert.match(app, /markSessionReviewed/);
  assert.match(app, /playCompletionSound/);
  assert.match(app, /sessionPath: "\*"/);
  assert.match(app, /session\.reviewState/);
  assert.match(styles, /\.chat-status-dot/);
  assert.match(server, /sessions\/reviewed/);
});
