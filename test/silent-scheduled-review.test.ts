import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { ensureConversationRecord, getConversationRecord, markSilentScheduledRun } from "../src/conversation-records.js";
import { syncConversationReviewStates } from "../src/conversation-reviews.js";

test("silent scheduled activity stays reviewed; earlier unread and later manual activity remain reviewable", async () => {
  const projectId = randomUUID(), sessionId = randomUUID(), userId = randomUUID();
  const node = await getClusterNode();
  await ensureConversationRecord(projectId, "pi", sessionId, node.id);
  const session = { path: `draft:pi:${sessionId}`, engine: "pi" as const, sessionId, running: false, updatedAt: "2026-01-01T00:00:00.000Z" };
  const review = (value: typeof session & { silentReviewFrom?: string; silentReviewUntil?: string }) =>
    syncConversationReviewStates(userId, "silent-review-user", projectId, [value]).get(session.path);
  assert.equal(review(session), "reviewed");
  assert.equal(review({ ...session, updatedAt: "2026-01-02T00:00:00.000Z" }), "needs_review");
  assert.equal(review({ ...session, running: true, updatedAt: "2026-01-03T00:00:00.000Z" }), "running");
  await markSilentScheduledRun(projectId, "pi", sessionId, "2026-01-02T00:00:00.000Z", "2026-01-04T00:00:00.000Z", node.id);
  const record = await getConversationRecord(projectId, "pi", sessionId);
  assert.equal(record?.silentReviewUntil, "2026-01-04T00:00:00.000Z", "silent boundary persists for other viewers/nodes");
  assert.equal(review({ ...session, ...record, updatedAt: "2026-01-04T00:00:00.000Z" }), "needs_review", "earlier manual turn stays unread");
  assert.equal(review({ ...session, ...record, updatedAt: "2026-01-04T00:00:00.000Z" }), "needs_review", "a second refresh must not erase earlier unread activity");
  const anotherUser = randomUUID();
  const fresh = (updatedAt: string) => syncConversationReviewStates(anotherUser, "other-silent-user", projectId, [{ ...session, ...record, updatedAt }]).get(session.path);
  assert.equal(fresh("2026-01-04T00:00:00.000Z"), "reviewed");
  assert.equal(fresh("2026-01-05T00:00:00.000Z"), "needs_review", "later manual turn must trigger review");
});
