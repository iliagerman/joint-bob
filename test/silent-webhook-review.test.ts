import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { ensureConversationRecord, getConversationRecord } from "../src/conversation-records.js";
import { markSilentWebhookRequest, silentScheduledReview } from "../src/server/scheduled-review.js";
import { addProject } from "../src/store.js";

test("a webhook turn marked silent leaves a silent review boundary; an ordinary one does not", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-silent-webhook-"));
  try {
    const project = await addProject("Silent webhook", path.join(root, "project"), { writeInstructions: false });
    const node = await getClusterNode();
    const sessionId = randomUUID();
    await ensureConversationRecord(project.id, "pi", sessionId, node.id);

    assert.equal(await silentScheduledReview(project, "pi", sessionId, randomUUID()), undefined, "a prompt nobody marked stays reviewable");

    const requestId = randomUUID();
    markSilentWebhookRequest(requestId);
    const finish = await silentScheduledReview(project, "pi", sessionId, requestId);
    assert.ok(finish, "a marked webhook prompt is captured");
    await finish();
    const record = await getConversationRecord(project.id, "pi", sessionId);
    assert.ok(record?.silentReviewFrom && record.silentReviewUntil, "the run's activity is recorded as silent");
    assert.equal(await silentScheduledReview(project, "pi", sessionId, requestId), undefined, "a request is silent once");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
