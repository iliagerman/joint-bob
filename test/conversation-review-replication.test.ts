import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

/**
 * Review watermarks replicate by cluster-stable identity (username, project,
 * engine, session id) and merge by highest watermark, so duplicates, reordering,
 * and differing transcript paths across nodes cannot regress a review.
 */


async function withClusterNode(dataDir: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dataDir, "node.db"));
  db.exec("CREATE TABLE IF NOT EXISTS cluster_node (id TEXT NOT NULL, name TEXT NOT NULL, singleton INTEGER NOT NULL, url TEXT NOT NULL, paired_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.prepare("INSERT INTO cluster_node (id, name, singleton, url, created_at, updated_at) VALUES ('local-node', 'Local', 1, 'http://127.0.0.1:1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
  db.close();
}

async function freshModule(dataDir: string, suffix: string) {
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    return await import(`../src/conversation-reviews.ts?review-replication=${suffix}`);
  } finally {
    delete process.env.PI_WEB_DATA_DIR;
  }
}

test("marking a conversation reviewed enqueues a replication event keyed by stable identity", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-review-outbox-"));
  try {
    const reviews = await freshModule(dataDir, `${Date.now()}-1`);
    reviews.markConversationsReviewed("user-1", "ilia", "project-1", [
      { path: "/Users/me/.claude/projects/x/session-a.jsonl", engine: "claude", sessionId: "session-a", updatedAt: "2026-09-01T10:00:00.000Z" },
    ], "node-a");

    const db = new DatabaseSync(path.join(dataDir, "node.db"), { readOnly: true });
    const events = db.prepare("SELECT origin_node_id, entity_type, entity_key, operation, payload FROM replication_outbox WHERE entity_type = 'conversation.review'").all() as Array<{ origin_node_id: string; entity_type: string; entity_key: string; operation: string; payload: string }>;
    assert.equal(events.length, 1);
    assert.equal(events[0].entity_key, "ilia:project-1:claude:session-a");
    assert.equal(events[0].operation, "upsert");
    assert.deepEqual(JSON.parse(events[0].payload), {
      username: "ilia", projectId: "project-1", engine: "claude", sessionId: "session-a",
      reviewedAt: "2026-09-01T10:00:00.000Z", originNodeId: "node-a",
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("replicated watermarks keep the highest value through duplicates and reordering", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-review-merge-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const { randomUUID } = await import("node:crypto");
    await withClusterNode(dataDir);
    const { receiveReplicationBatch } = await import("../src/replication.js?review-merge=" + Date.now());
    const event = (reviewedAt: string, id = randomUUID()) => ({
      id, originNodeId: "node-b", entityType: "conversation.review",
      entityKey: `ilia:project-1:pi:session-b`, operation: "upsert",
      payload: { username: "ilia", projectId: "project-1", engine: "pi", sessionId: "session-b", reviewedAt, originNodeId: "node-b" },
      createdAt: reviewedAt,
    });

    await receiveReplicationBatch({ events: [event("2026-09-01T12:00:00.000Z")] });
    await receiveReplicationBatch({ events: [event("2026-09-01T11:00:00.000Z")] });
    const first = await receiveReplicationBatch({ events: [event("2026-09-01T10:00:00.000Z", "fixed-id-1")] });
    const duplicate = await receiveReplicationBatch({ events: [event("2026-09-01T13:00:00.000Z", "fixed-id-1")] });

    const db = new DatabaseSync(path.join(dataDir, "node.db"), { readOnly: true });
    const rows = db.prepare("SELECT reviewed_at FROM replicated_review_watermarks WHERE username = 'ilia' AND project_id = 'project-1'").all() as Array<{ reviewed_at: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reviewed_at, "2026-09-01T12:00:00.000Z");
    // A redelivered event id is acknowledged without reapplying its older payload.
    assert.deepEqual(duplicate, ["fixed-id-1"]);
    assert.deepEqual(first, ["fixed-id-1"]);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a remote watermark outranks the local row and another account's watermark does not apply", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-review-remote-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const { randomUUID } = await import("node:crypto");
    await withClusterNode(dataDir);
    const { receiveReplicationBatch } = await import("../src/replication.js?review-remote=" + Date.now());
    const reviews = await import(`../src/conversation-reviews.ts?review-remote-mod=${Date.now()}`);

    const now = Date.now();
    const at = (offsetMs: number): string => new Date(now + offsetMs).toISOString();
    await receiveReplicationBatch({ events: [{
      id: randomUUID(), originNodeId: "node-b", entityType: "conversation.review", operation: "upsert",
      entityKey: "ilia:project-1:pi:session-c",
      payload: { username: "ilia", projectId: "project-1", engine: "pi", sessionId: "session-c", reviewedAt: at(-3_600_000), originNodeId: "node-b" },
      createdAt: at(-3_600_000),
    }, {
      id: randomUUID(), originNodeId: "node-b", entityType: "conversation.review", operation: "upsert",
      entityKey: "other:project-1:pi:session-c",
      payload: { username: "other", projectId: "project-1", engine: "pi", sessionId: "session-c", reviewedAt: at(-1_800_000), originNodeId: "node-b" },
      createdAt: at(-1_800_000),
    }] });

    // Local activity is older than ilia's remote watermark.
    const states = reviews.syncConversationReviewStates("user-9", "ilia", "project-1", [
      { path: "/home/user/.pi/agent/sessions/session-c.jsonl", engine: "pi", sessionId: "session-c", updatedAt: at(-7_200_000), running: false },
    ]);
    assert.equal(states.get("/home/user/.pi/agent/sessions/session-c.jsonl"), "reviewed");

    const afterActivity = reviews.syncConversationReviewStates("user-9", "ilia", "project-1", [
      { path: "/home/user/.pi/agent/sessions/session-c.jsonl", engine: "pi", sessionId: "session-c", updatedAt: at(-1_800_000), running: false },
    ]);
    assert.equal(afterActivity.get("/home/user/.pi/agent/sessions/session-c.jsonl"), "needs_review");

    // The same conversation under a different absolute path still resolves by session id.
    const moved = reviews.syncConversationReviewStates("user-9", "ilia", "project-1", [
      { path: "/Users/me/.pi/agent/sessions/session-c.jsonl", engine: "pi", sessionId: "session-c", updatedAt: at(-5_400_000), running: false },
    ]);
    assert.equal(moved.get("/Users/me/.pi/agent/sessions/session-c.jsonl"), "reviewed");

    // Another account's watermark did not leak into ilia's row.
    const otherViewed = reviews.syncConversationReviewStates("user-9", "ilia", "project-1", [
      { path: "/Users/me/.pi/agent/sessions/session-c.jsonl", engine: "pi", sessionId: "session-c", updatedAt: at(60_000), running: false },
    ]);
    assert.equal(otherViewed.get("/Users/me/.pi/agent/sessions/session-c.jsonl"), "needs_review");
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the running and review wiring is present end to end", async () => {
  const { readFile } = await import("node:fs/promises");
  const [server, app] = await Promise.all([readFile("src/server.ts", "utf8"), readFile("public/app.js", "utf8")]);

  // The conversation list consults replicated leases, not just local runtime.
  const listing = server.slice(server.indexOf("async function listProjectSessionsWithReviewState"), server.indexOf("app.get(\"/api/projects/:projectId/sessions\""));
  assert.match(listing, /conversationLeaseRunning\(session\.harnessId, session\.id\)/);
  // Leases travel on an authenticated cluster route pushed from the periodic loop.
  assert.match(server, /app\.post\("\/api\/cluster\/sessions\/runtime-snapshot"/);
  assert.match(server, /pushRuntimeLeaseSnapshots\(\)\.catch/);
  assert.match(server, /"POST \/cluster\/sessions\/runtime-snapshot"/);
  // Review marks publish durable events, and applying them wakes every watcher.
  assert.match(server, /entityType === "conversation\.review"/);
  assert.match(server, /broadcastSessionsChangedToAllProjects\(\)/);
  // The client trails a sessionsChanged burst with a pending-reviews refresh.
  assert.match(app, /function schedulePendingReviewsRefresh\(\)/);
  const watchHandler = app.slice(app.indexOf('socket.addEventListener("message"', app.indexOf("// ---- Project watch socket")), app.indexOf("close", app.indexOf('socket.addEventListener("message"', app.indexOf("// ---- Project watch socket"))));
  assert.match(watchHandler, /schedulePendingReviewsRefresh\(\)/);
});

test("a review watermark too far in the future is rejected", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-review-future-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const { randomUUID } = await import("node:crypto");
    const { receiveReplicationBatch } = await import("../src/replication.js?review-future=" + Date.now());
    await withClusterNode(dataDir);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await assert.rejects(receiveReplicationBatch({ events: [{
      id: randomUUID(), originNodeId: "node-b", entityType: "conversation.review", operation: "upsert",
      entityKey: `ilia:project-1:pi:session-f`,
      payload: { username: "ilia", projectId: "project-1", engine: "pi", sessionId: "session-f", reviewedAt: future, originNodeId: "node-b" },
      createdAt: future,
    }] }), /too far in the future/);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a remote review re-arms the account's next notification", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-review-rearm-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const { randomUUID } = await import("node:crypto");
    await withClusterNode(dataDir);
    const { receiveReplicationBatch } = await import("../src/replication.js?review-rearm=" + Date.now());
    const reviews = await import(`../src/conversation-reviews.ts?review-rearm-mod=${Date.now()}`);
    const session = { path: "session-g", engine: "pi" as const, sessionId: "session-g", running: false };
    const now = Date.now();
    const at = (offsetMs: number): string => new Date(now + offsetMs).toISOString();

    // A pending review is claimed and notified once.
    reviews.syncConversationReviewStates("user-1", "ilia", "project-1", [{ ...session, updatedAt: at(-60_000) }]);
    reviews.syncConversationReviewStates("user-1", "ilia", "project-1", [{ ...session, updatedAt: at(-30_000) }]);
    assert.deepEqual(reviews.claimReviewNotifications("user-1", "project-1", [session.path]), [session.path]);

    // Another node reviews the conversation; the replicated watermark advances past the claim.
    await receiveReplicationBatch({ events: [{
      id: randomUUID(), originNodeId: "node-b", entityType: "conversation.review", operation: "upsert",
      entityKey: "ilia:project-1:pi:session-g",
      payload: { username: "ilia", projectId: "project-1", engine: "pi", sessionId: "session-g", reviewedAt: at(-20_000), originNodeId: "node-b" },
      createdAt: at(-20_000),
    }] });
    reviews.syncConversationReviewStates("user-1", "ilia", "project-1", [{ ...session, updatedAt: at(-30_000) }]);

    // A later run whose running lease this node never observed must notify again.
    reviews.syncConversationReviewStates("user-1", "ilia", "project-1", [{ ...session, updatedAt: at(-5_000) }]);
    assert.deepEqual(reviews.claimReviewNotifications("user-1", "project-1", [session.path]), [session.path]);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("malformed review events are rejected", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-review-invalid-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const { randomUUID } = await import("node:crypto");
    await withClusterNode(dataDir);
    const { receiveReplicationBatch } = await import("../src/replication.js?review-invalid=" + Date.now());
    await assert.rejects(receiveReplicationBatch({ events: [{
      id: randomUUID(), originNodeId: "node-b", entityType: "conversation.review", operation: "upsert",
      entityKey: "ilia:project-1:pi:session-d",
      payload: { username: "ilia", projectId: "project-1", engine: "pi", sessionId: "WRONG", reviewedAt: "2026-09-01T09:00:00.000Z", originNodeId: "node-b" },
      createdAt: "2026-09-01T09:00:00.000Z",
    }] }), /Malformed conversation review replication payload/);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});
