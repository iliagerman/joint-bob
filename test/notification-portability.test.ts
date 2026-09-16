import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import webpush from "web-push";
import type { ReplicationEvent } from "../src/replication.js";
import type { SessionSummary } from "../src/types.js";

async function isolated(run: (dataDir: string, tag: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "notification-portability-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try { await run(dataDir, randomUUID()); }
  finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
}

function event(entityType: string, payload: Record<string, unknown>, originNodeId = "peer-a"): ReplicationEvent {
  return {
    id: randomUUID(), originNodeId, entityType, operation: "upsert",
    entityKey: JSON.stringify([String(payload.username).toLowerCase(), payload.projectId, payload.conversationId]),
    payload, createdAt: new Date().toISOString(),
  } as ReplicationEvent;
}

test("legacy push rows migrate to stable IDs without replacing credentials or unresolved rows", async (context) => {
  await isolated(async (dataDir, tag) => {
    const auth = await import(`../src/auth.ts?portable-auth-${tag}`);
    auth.createAdministrator("portable-admin", "portable-test-password", false);
    const user = auth.authenticate("portable-admin", "portable-test-password");
    const push = await import(`../src/push.ts?portable-push-${tag}`) as typeof import("../src/push.js");
    assert.equal(typeof push.migratePushConversationSubscriptions, "function", "migration API must exist");
    const browser = { endpoint: "https://push.example.test/legacy", keys: { p256dh: "p256", auth: "auth" } };
    const ntfy = push.ntfySubscription("http://127.0.0.1:9", "topic", "", "project", "/old/node/session.jsonl");
    await push.savePushSubscription(browser, "foreign-user-id", "*", "*", "All", "portable-admin");
    await push.savePushSubscription({ ...browser, endpoint: "https://push.example.test/wrong-account" }, user.userId, "project", "logical-id", "Wrong", "unknown-admin");
    await push.savePushSubscription(ntfy, user.userId, "project", "/old/node/session.jsonl", "Legacy");
    await push.savePushSubscription({ ...browser, endpoint: "https://push.example.test/unresolved" }, user.userId, "project", "/unknown.jsonl", "Unknown");
    const before = await push.pushSubscriptionEventsForPeer("peer");
    const oldNtfy = before.find((candidate) => candidate.operation === "upsert" && (candidate.value as { sessionPath?: string }).sessionPath === "/old/node/session.jsonl")!;
    const oldValue = oldNtfy.value as import("../src/push.js").PushSubscriptionUpsertValue;
    const session = { id: "local-id", conversationId: "logical-id", path: "/old/node/session.jsonl", harnessId: "pi", segments: [] } as unknown as SessionSummary;
    await push.migratePushConversationSubscriptions(user.userId, "portable-admin", "project", [session]);
    const migrated = (await push.pushSubscriptionEventsForPeer("new-peer")).filter((candidate) => candidate.operation === "upsert");
    const stable = migrated.find((candidate) => (candidate.value as import("../src/push.js").PushSubscriptionUpsertValue).sessionPath === "logical-id" && (candidate.value as import("../src/push.js").PushSubscriptionUpsertValue).subscription.endpoint.startsWith("ntfy+"))!;
    const value = stable.value as import("../src/push.js").PushSubscriptionUpsertValue;
    assert.equal(value.username, "portable-admin");
    assert.equal(value.subscription.endpoint, oldValue.subscription.endpoint);
    assert.equal(value.vapidPublicKey, oldValue.vapidPublicKey);
    assert.equal(value.vapidPrivateKey, oldValue.vapidPrivateKey);
    assert.ok(migrated.some((candidate) => (candidate.value as { sessionPath?: string }).sessionPath === "/unknown.jsonl"));
    const count = migrated.length;
    await push.migratePushConversationSubscriptions(user.userId, "portable-admin", "project", [session]);
    assert.equal((await push.pushSubscriptionEventsForPeer("another-peer")).filter((candidate) => candidate.operation === "upsert").length, count);
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    assert.equal((db.prepare("SELECT username FROM push_session_subscriptions WHERE title='All'").get() as { username: string }).username, "portable-admin");
    db.close();
    await push.deleteNtfySubscriptions(user.userId, "project", "logical-id");
    const sent: string[] = [];
    context.mock.method(webpush, "sendNotification", async (subscription) => { sent.push(subscription.endpoint); return {} as never; });
    assert.equal(await push.notifyConversationReview(user.userId, "project", "logical-id", "Portable"), true);
    assert.deepEqual(sent, [browser.endpoint], "username owns the subscription even when its stored user ID is foreign");
  });
});

test("delivery consolidation preserves the same conversation in unrelated projects", async () => {
  await isolated(async (dataDir, tag) => {
    const notifications = await import(`../src/conversation-notifications.ts?project-scope-${tag}`);
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    notifications.ensureConversationNotificationSchema(db);
    db.prepare("INSERT INTO conversation_notification_deliveries VALUES(?,?,?,?,?,?)").run("admin", "project-one", "conversation", "2025-01-01T00:00:00.000Z", null, null);
    db.prepare("INSERT INTO conversation_notification_deliveries VALUES(?,?,?,?,?,?)").run("admin", "project-two", "conversation", "2025-01-02T00:00:00.000Z", null, null);
    db.close();
    notifications.claimConversationNotification("admin", "project-one", "conversation", "2025-01-03T00:00:00.000Z");
    const verify = new DatabaseSync(path.join(dataDir, "node.db"));
    assert.deepEqual(verify.prepare("SELECT project_id,delivered_at FROM conversation_notification_deliveries ORDER BY project_id").all().map((row) => ({ ...row })), [
      { project_id: "project-one", delivered_at: "2025-01-01T00:00:00.000Z" },
      { project_id: "project-two", delivered_at: "2025-01-02T00:00:00.000Z" },
    ]);
    verify.close();
  });
});

test("newer stable ntfy replication rejects a stale legacy path without collapsing browser conversations", async () => {
  const originDir = await mkdtemp(path.join(os.tmpdir(), "notification-origin-"));
  const replicaDir = await mkdtemp(path.join(os.tmpdir(), "notification-replica-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  try {
    process.env.PI_WEB_DATA_DIR = originDir;
    const origin = await import(`../src/push.ts?stale-origin-${randomUUID()}`) as typeof import("../src/push.js");
    const legacy = origin.ntfySubscription("http://127.0.0.1:9", "topic", "", "project", "/old/session.jsonl");
    await origin.savePushSubscription(legacy, "origin-user", "project", "/old/session.jsonl", "Legacy", "portable-admin");
    const oldEvent = (await origin.pushSubscriptionEventsForPeer("capture"))[0];
    const oldValue = oldEvent.value as import("../src/push.js").PushSubscriptionUpsertValue;
    const stableEvent = { ...oldEvent, id: randomUUID(), entityKey: createSubscriptionKey(legacy.endpoint, "project", "logical-id"), updatedAt: new Date(Date.parse(oldEvent.updatedAt) + 1).toISOString(), value: { ...oldValue, sessionPath: "logical-id" } };

    process.env.PI_WEB_DATA_DIR = replicaDir;
    const replica = await import(`../src/push.ts?stale-replica-${randomUUID()}`) as typeof import("../src/push.js");
    await replica.receivePushSubscriptionEvents([stableEvent]);
    await replica.receivePushSubscriptionEvents([{ ...oldEvent, id: randomUUID() }]);
    const browser = { endpoint: "https://push.example.test/shared", keys: { p256dh: "p256", auth: "auth" } };
    const base = stableEvent.value as import("../src/push.js").PushSubscriptionUpsertValue;
    const browserEvents = ["first", "second"].map((sessionPath, index) => ({ ...stableEvent, id: randomUUID(), entityKey: createSubscriptionKey(browser.endpoint, "project", sessionPath), updatedAt: new Date(Date.parse(stableEvent.updatedAt) + index + 1).toISOString(), value: { ...base, subscription: browser, sessionPath } }));
    await replica.receivePushSubscriptionEvents(browserEvents);
    const db = new DatabaseSync(path.join(replicaDir, "node.db"));
    const rows = db.prepare("SELECT session_path FROM push_session_subscriptions ORDER BY session_path").all() as Array<{ session_path: string }>;
    assert.deepEqual(rows.map((row) => row.session_path), ["first", "logical-id", "second"]);
    db.close();
    const forwarded = (await replica.pushSubscriptionEventsForPeer("forward")).filter((candidate) => candidate.operation === "upsert");
    assert.equal(forwarded.some((candidate) => (candidate.value as { sessionPath: string }).sessionPath === "/old/session.jsonl"), false);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    await rm(originDir, { recursive: true, force: true }); await rm(replicaDir, { recursive: true, force: true });
  }
});

function createSubscriptionKey(endpoint: string, projectId: string, sessionPath: string): string {
  return createHash("sha256").update(`${endpoint}\0${projectId}\0${sessionPath}`).digest("hex");
}

test("delivery aliases merge watermark and live claim independently", async () => {
  await isolated(async (dataDir, tag) => {
    const notifications = await import(`../src/conversation-notifications.ts?alias-${tag}`);
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    notifications.ensureConversationNotificationSchema(db);
    db.exec("CREATE TABLE project_aliases(alias_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,created_at TEXT NOT NULL)");
    db.prepare("INSERT INTO project_aliases VALUES(?,?,?)").run("old-project", "project", new Date().toISOString());
    db.prepare("INSERT INTO conversation_notification_deliveries VALUES(?,?,?,?,?,?)").run("admin", "old-project", "conversation", "2025-01-03T00:00:00.000Z", null, null);
    db.prepare("INSERT INTO conversation_notification_deliveries VALUES(?,?,?,?,?,?)").run("admin", "project", "conversation", "2025-01-01T00:00:00.000Z", "2025-01-04T00:00:00.000Z", new Date().toISOString());
    db.close();
    assert.equal(notifications.claimConversationNotification("admin", "project", "conversation", "2025-01-05T00:00:00.000Z"), false, "alias watermark must not hide canonical live claim");
  });
});

test("failed claims retry and an older success cannot clear a newer claim", async (context) => {
  await isolated(async (_dataDir, tag) => {
    const notifications = await import(`../src/conversation-notifications.ts?claims-${tag}`);
    context.mock.method(Date, "now", () => Date.parse("2025-02-01T00:00:00.000Z"));
    assert.equal(notifications.claimConversationNotification("admin", "project", "conversation", "2025-01-01T00:00:00.000Z"), true);
    notifications.finishConversationNotification("admin", "project", "conversation", "2025-01-01T00:00:00.000Z", false, "node-a");
    assert.equal(notifications.claimConversationNotification("admin", "project", "conversation", "2025-01-01T00:00:00.000Z"), true);
    context.mock.method(Date, "now", () => Date.parse("2025-02-01T00:02:00.000Z"));
    assert.equal(notifications.claimConversationNotification("admin", "project", "conversation", "2025-01-02T00:00:00.000Z"), true);
    notifications.finishConversationNotification("admin", "project", "conversation", "2025-01-01T00:00:00.000Z", true, "node-a");
    assert.equal(notifications.claimConversationNotification("admin", "project", "conversation", "2025-01-03T00:00:00.000Z"), false);
  });
});

test("ntfy delete and re-enable is monotonic within one wallclock tick", async (context) => {
  const originDir = await mkdtemp(path.join(os.tmpdir(), "notification-origin-"));
  const replicaDir = await mkdtemp(path.join(os.tmpdir(), "notification-replica-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  try {
    context.mock.method(Date, "now", () => Date.parse("2025-03-01T00:00:00.000Z"));
    process.env.PI_WEB_DATA_DIR = originDir;
    const origin = await import(`../src/push.ts?monotonic-origin-${randomUUID()}`) as typeof import("../src/push.js");
    const target = origin.ntfySubscription("http://127.0.0.1:9", "topic", "", "project", "conversation");
    await origin.savePushSubscription(target, "origin-user", "project", "conversation", "Title", "admin");
    const first = await origin.pushSubscriptionEventsForPeer("replica");
    await origin.deletePushSubscription(target.endpoint);
    await origin.savePushSubscription(target, "origin-user", "project", "conversation", "Title", "admin");
    const newest = await origin.pushSubscriptionEventsForPeer("replica");
    assert.ok(newest[0].updatedAt > first[0].updatedAt);
    process.env.PI_WEB_DATA_DIR = replicaDir;
    const replica = await import(`../src/push.ts?monotonic-replica-${randomUUID()}`) as typeof import("../src/push.js");
    await replica.receivePushSubscriptionEvents(newest);
    assert.equal((await replica.pushSubscriptionEventsForPeer("third")).some((candidate) => candidate.operation === "upsert"), true);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    await rm(originDir, { recursive: true, force: true }); await rm(replicaDir, { recursive: true, force: true });
  }
});

test("aliased preference and delivery events use canonical ISO ordering", async () => {
  await isolated(async (dataDir, tag) => {
    const notifications = await import(`../src/conversation-notifications.ts?events-${tag}`);
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    notifications.ensureConversationNotificationSchema(db);
    db.exec("CREATE TABLE project_aliases(alias_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,created_at TEXT NOT NULL)");
    db.prepare("INSERT INTO project_aliases VALUES(?,?,?)").run("alias", "project", new Date().toISOString());
    notifications.applyConversationNotificationEvent(db, event("conversation.notification", { username: "Admin", projectId: "alias", conversationId: "c", enabled: false, updatedAt: "2025-01-01T01:00:00+01:00", originNodeId: "peer-a" }));
    notifications.applyConversationNotificationEvent(db, event("conversation.notification", { username: "admin", projectId: "project", conversationId: "c", enabled: true, updatedAt: "2025-01-01T00:00:00.001Z", originNodeId: "peer-a" }));
    assert.equal(notifications.conversationNotifications("admin", "project").get("c")?.enabled, true);
    assert.throws(() => notifications.applyConversationNotificationEvent(db, event("conversation.notification", { username: "admin", projectId: "project", conversationId: "c", enabled: true, updatedAt: "bad", originNodeId: "" }, "")), /malformed/i);
    db.close();
  });
});
