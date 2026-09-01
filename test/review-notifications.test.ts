import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

async function withDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-review-notifications-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    await run(dataDir);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("a conversation entering review is claimed for notification exactly once", async () => {
  await withDataDir(async () => {
    const reviews = await import(new URL(`../src/conversation-reviews.ts?claim=${Date.now()}`, import.meta.url).href);

    reviews.syncConversationReviewStates("user-a", "project", [{ path: "session", updatedAt: "2026-01-01T00:00:00.000Z", running: false }]);
    const pending = reviews.syncConversationReviewStates("user-a", "project", [{ path: "session", updatedAt: "2026-01-01T00:01:00.000Z", running: false }]);
    assert.equal(pending.get("session"), "needs_review");

    assert.deepEqual(reviews.claimReviewNotifications("user-a", "project", ["session"]), ["session"]);
    assert.deepEqual(reviews.claimReviewNotifications("user-a", "project", ["session"]), []);
  });
});

test("reviewing a conversation re-arms its next notification", async () => {
  await withDataDir(async () => {
    const reviews = await import(new URL(`../src/conversation-reviews.ts?rearm=${Date.now()}`, import.meta.url).href);

    reviews.syncConversationReviewStates("user-a", "project", [{ path: "session", updatedAt: "2026-01-01T00:00:00.000Z", running: false }]);
    reviews.syncConversationReviewStates("user-a", "project", [{ path: "session", updatedAt: "2026-01-01T00:01:00.000Z", running: false }]);
    reviews.claimReviewNotifications("user-a", "project", ["session"]);

    reviews.markConversationReviewed("user-a", "project", { path: "session", updatedAt: "2026-01-01T00:01:00.000Z" });
    reviews.syncConversationReviewStates("user-a", "project", [{ path: "session", updatedAt: "2026-01-01T00:02:00.000Z", running: false }]);

    assert.deepEqual(reviews.claimReviewNotifications("user-a", "project", ["session"]), ["session"]);
  });
});

test("a conversation that starts running again re-arms its next notification", async () => {
  await withDataDir(async () => {
    const reviews = await import(new URL(`../src/conversation-reviews.ts?running=${Date.now()}`, import.meta.url).href);

    reviews.syncConversationReviewStates("user-a", "project", [{ path: "session", updatedAt: "2026-01-01T00:00:00.000Z", running: false }]);
    reviews.syncConversationReviewStates("user-a", "project", [{ path: "session", updatedAt: "2026-01-01T00:01:00.000Z", running: false }]);
    reviews.claimReviewNotifications("user-a", "project", ["session"]);

    reviews.syncConversationReviewStates("user-a", "project", [{ path: "session", updatedAt: "2026-01-01T00:02:00.000Z", running: true }]);
    reviews.syncConversationReviewStates("user-a", "project", [{ path: "session", updatedAt: "2026-01-01T00:03:00.000Z", running: false }]);

    assert.deepEqual(reviews.claimReviewNotifications("user-a", "project", ["session"]), ["session"]);
  });
});

test("notification claims are per account", async () => {
  await withDataDir(async () => {
    const reviews = await import(new URL(`../src/conversation-reviews.ts?accounts=${Date.now()}`, import.meta.url).href);

    for (const userId of ["user-a", "user-b"]) {
      reviews.syncConversationReviewStates(userId, "project", [{ path: "session", updatedAt: "2026-01-01T00:00:00.000Z", running: false }]);
      reviews.syncConversationReviewStates(userId, "project", [{ path: "session", updatedAt: "2026-01-01T00:01:00.000Z", running: false }]);
    }
    reviews.claimReviewNotifications("user-a", "project", ["session"]);

    assert.deepEqual(reviews.claimReviewNotifications("user-b", "project", ["session"]), ["session"]);
  });
});

test("a device subscribed to every project is a subscriber of each one", async () => {
  await withDataDir(async (dataDir) => {
    const push = await import(new URL(`../src/push.ts?wildcard=${Date.now()}`, import.meta.url).href);
    const subscription = { endpoint: "https://push.example.test/device", keys: { p256dh: "p256dh-value", auth: "auth-value" } };

    await push.savePushSubscription(subscription, "user-a", "project-one", "*", "Joint Bob");
    await push.savePushSubscription(subscription, "user-a", "*", "*", "Joint Bob");

    assert.deepEqual(await push.listPushSubscriberUserIds("project-one"), ["user-a"]);
    assert.deepEqual(await push.listPushSubscriberUserIds("never-opened-project"), ["user-a"]);

    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    const rows = db.prepare("SELECT project_id, user_id FROM push_session_subscriptions").all() as Array<{ project_id: string; user_id: string }>;
    assert.deepEqual(rows.map((row) => `${row.project_id}/${row.user_id}`), ["*/user-a"]);
    db.close();
  });
});

test("the service worker notification vibrates so a phone announces a review", async () => {
  const worker = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");

  assert.match(worker, /vibrate:/);
  assert.match(worker, /const CACHE_NAME = "joint-bob-v88";/);
});

test("the client subscribes for reviews across every project", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(app, /projectId: "\*"/);
});
