import assert from "node:assert/strict";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import webpush from "web-push";

type PushModule = typeof import("../src/push.js");

async function withDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-push-replication-"));
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

async function freshPush(tag: string): Promise<PushModule> {
  const moduleUrl = new URL(`../src/push.ts?replication-${tag}-${Date.now()}`, import.meta.url);
  return await import(moduleUrl.href) as PushModule;
}

async function rawDatabase(dataDir: string): Promise<string> {
  const files = ["node.db", "node.db-wal"];
  const content = await Promise.all(files.map(async (file) => {
    try {
      return await readFile(path.join(dataDir, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
      throw error;
    }
  }));
  return Buffer.concat(content).toString("utf8");
}

function decrypt(value: string, key: Buffer): string {
  const [iv, tag, encrypted] = value.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Missing encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}

async function secretKey(dataDir: string): Promise<Buffer> {
  return Buffer.from((await readFile(path.join(dataDir, "secret.key"), "utf8")).trim(), "base64");
}

const subscription = {
  endpoint: "https://push.example.test/replicated-device-endpoint",
  keys: { p256dh: "replicated-p256dh-secret", auth: "replicated-auth-secret" },
};

test("saving a subscription queues an encrypted replication event for peers", async () => {
  await withDataDir(async (dataDir) => {
    const push = await freshPush("origin");
    await push.savePushSubscription(subscription, "user-a", "*", "*", "Joint Bob");

    const events = await push.pushSubscriptionEventsForPeer("peer-1");
    assert.equal(events.length, 1);
    assert.equal(events[0].operation, "upsert");
    const value = events[0].value as { userId: string; projectId: string; sessionPath: string; subscription: typeof subscription; vapidPublicKey: string; vapidPrivateKey: string };
    assert.equal(value.userId, "user-a");
    assert.equal(value.projectId, "*");
    assert.equal(value.sessionPath, "*");
    assert.equal(value.subscription.endpoint, subscription.endpoint);
    assert.equal(value.vapidPublicKey, await push.getVapidPublicKey());
    assert.ok(value.vapidPrivateKey.length > 0);

    // Nothing sensitive may sit unencrypted in the database file (same rule push.test.ts enforces).
    const raw = await rawDatabase(dataDir);
    assert.doesNotMatch(raw, /replicated-device-endpoint/);
    assert.doesNotMatch(raw, /replicated-p256dh-secret/);
    assert.doesNotMatch(raw, /replicated-auth-secret/);
    assert.doesNotMatch(raw, new RegExp(value.vapidPrivateKey.replace(/[+/]/g, ".")));

    // A receipt settles delivery for that peer; other peers still get the event.
    await push.recordPushSubscriptionReceipt("peer-1", [events[0].id]);
    assert.equal((await push.pushSubscriptionEventsForPeer("peer-1")).length, 0);
    assert.equal((await push.pushSubscriptionEventsForPeer("peer-2")).length, 1);

    // Re-saving replaces the queued event instead of piling up history.
    await push.savePushSubscription(subscription, "user-a", "*", "*", "Joint Bob");
    const requeued = await push.pushSubscriptionEventsForPeer("peer-1");
    assert.equal(requeued.length, 1);
    assert.notEqual(requeued[0].id, events[0].id);
  });
});

test("unsubscribing queues a delete event keyed by the endpoint digest", async () => {
  await withDataDir(async () => {
    const push = await freshPush("delete");
    await push.savePushSubscription(subscription, "user-a", "*", "*", "Joint Bob");
    await push.deletePushSubscription(subscription.endpoint);

    const events = await push.pushSubscriptionEventsForPeer("peer-1");
    const deletes = events.filter((event) => event.operation === "delete");
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].entityKey, createHash("sha256").update(subscription.endpoint).digest("hex"));
    assert.deepEqual(deletes[0].value, { endpoint: subscription.endpoint });
    // The superseded upsert is no longer queued: a fresh peer must not resurrect the subscription.
    assert.equal(events.some((event) => event.operation === "upsert"), false);
  });
});

test("a peer applies replicated subscriptions and keeps the origin node's VAPID keys", async () => {
  const originDir = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-push-replication-a-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  try {
    process.env.PI_WEB_DATA_DIR = originDir;
    const origin = await freshPush("node-a");
    await origin.savePushSubscription(subscription, "user-a", "*", "*", "Joint Bob");
    const originPublicKey = await origin.getVapidPublicKey();
    const events = await origin.pushSubscriptionEventsForPeer("peer-b");
    const originDb = new DatabaseSync(path.join(originDir, "node.db"));
    const originKeyRow = originDb.prepare("SELECT private_key FROM push_vapid_keys WHERE singleton = 1").get() as { private_key: string };
    const originPrivateKey = decrypt(originKeyRow.private_key, await secretKey(originDir));
    originDb.close();

    await withDataDir(async (replicaDir) => {
      const replica = await freshPush("node-b");
      const received = await replica.receivePushSubscriptionEvents(events);
      assert.deepEqual(received, events.map((event) => event.id));

      // The replica generates its own VAPID identity, but the replicated row keeps the origin's.
      const replicaPublicKey = await replica.getVapidPublicKey();
      assert.notEqual(replicaPublicKey, originPublicKey);
      const db = new DatabaseSync(path.join(replicaDir, "node.db"));
      const row = db.prepare("SELECT user_id, project_id, session_path, subscription, vapid_public_key, vapid_private_key FROM push_session_subscriptions").get() as { user_id: string; project_id: string; session_path: string; subscription: string; vapid_public_key: string; vapid_private_key: string };
      assert.equal(row.user_id, "user-a");
      assert.equal(row.project_id, "*");
      assert.equal(row.vapid_public_key, originPublicKey);
      const key = await secretKey(replicaDir);
      assert.equal(decrypt(row.vapid_private_key, key), originPrivateKey);
      assert.equal((JSON.parse(decrypt(row.subscription, key)) as typeof subscription).endpoint, subscription.endpoint);
      db.close();

      // Everything sensitive is re-encrypted under the replica's own key.
      const raw = await rawDatabase(replicaDir);
      assert.doesNotMatch(raw, /replicated-device-endpoint/);
      assert.doesNotMatch(raw, /replicated-p256dh-secret/);

      // The subscriber is now visible for review notifications on this node too.
      assert.deepEqual(await replica.listPushSubscriberUserIds("any-project"), ["user-a"]);

      // Replays are acknowledged without duplicating rows.
      assert.deepEqual(await replica.receivePushSubscriptionEvents(events), events.map((event) => event.id));
      const countDb = new DatabaseSync(path.join(replicaDir, "node.db"));
      const count = countDb.prepare("SELECT COUNT(*) AS count FROM push_session_subscriptions").get() as { count: number };
      countDb.close();
      assert.equal(count.count, 1);

      // A stale upsert loses to the applied version.
      const staleUpsert = { ...events[0], id: randomUUID(), updatedAt: "2000-01-01T00:00:00.000Z", value: { ...(events[0].value as object), title: "Stale" } };
      await replica.receivePushSubscriptionEvents([staleUpsert as typeof events[0]]);
      const titleDb = new DatabaseSync(path.join(replicaDir, "node.db"));
      const title = titleDb.prepare("SELECT title FROM push_session_subscriptions").get() as { title: string };
      titleDb.close();
      assert.equal(title.title, "Joint Bob");

      // A newer delete removes the subscription, and a stale upsert cannot resurrect it.
      const deleteEvent = {
        id: randomUUID(),
        entityKey: createHash("sha256").update(subscription.endpoint).digest("hex"),
        operation: "delete" as const,
        value: { endpoint: subscription.endpoint },
        updatedAt: new Date(Date.now() + 60_000).toISOString(),
        originNodeId: events[0].originNodeId,
        createdAt: new Date().toISOString(),
      };
      await replica.receivePushSubscriptionEvents([deleteEvent]);
      assert.deepEqual(await replica.listPushSubscriberUserIds("any-project"), []);
      const resurrect = { ...events[0], id: randomUUID() };
      await replica.receivePushSubscriptionEvents([resurrect]);
      assert.deepEqual(await replica.listPushSubscriberUserIds("any-project"), []);
    });
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(originDir, { recursive: true, force: true });
  }
});

test("expired push endpoints replicate their deletion", async (context) => {
  await withDataDir(async () => {
    const push = await freshPush("expired");
    await push.savePushSubscription(subscription, "user-a", "*", "*", "Joint Bob");
    const [upsert] = await push.pushSubscriptionEventsForPeer("peer-1");
    await push.recordPushSubscriptionReceipt("peer-1", [upsert.id]);
    context.mock.method(webpush, "sendNotification", async () => { throw Object.assign(new Error("Gone"), { statusCode: 410 }); });

    await push.notifyConversationReview("user-a", "project", "pi:session", "Conversation");

    const [event] = await push.pushSubscriptionEventsForPeer("peer-1");
    assert.equal(event.operation, "delete");
    assert.deepEqual(event.value, { endpoint: subscription.endpoint });
  });
});

test("malformed replication events are rejected before anything is written", async () => {
  await withDataDir(async () => {
    const push = await freshPush("invalid");
    const forged = {
      id: randomUUID(),
      entityKey: "not-a-digest",
      operation: "upsert" as const,
      value: { userId: "user-a", projectId: "*", sessionPath: "*", title: "X", subscription, vapidPublicKey: "pk", vapidPrivateKey: "sk" },
      updatedAt: new Date().toISOString(),
      originNodeId: "",
      createdAt: new Date().toISOString(),
    };
    await assert.rejects(push.receivePushSubscriptionEvents([forged]), /entity key/i);
    assert.deepEqual(await push.listPushSubscriberUserIds("any-project"), []);
  });
});
