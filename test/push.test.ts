import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import webpush from "web-push";

async function withPushStore(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-push-"));
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

async function rawDatabase(dataDir: string): Promise<Buffer> {
  const files = ["node.db", "node.db-wal"];
  const content = await Promise.all(files.map(async (file) => {
    try {
      return await readFile(path.join(dataDir, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
      throw error;
    }
  }));
  return Buffer.concat(content);
}

function decrypt(value: string, key: Buffer): string {
  const [iv, tag, encrypted] = value.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Missing encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}

test("push SQLite state persists generated VAPID keys and encrypts credentials", async () => {
  await withPushStore(async (dataDir) => {
    const moduleUrl = new URL(`../src/push.ts?generated=${Date.now()}`, import.meta.url);
    const push = await import(moduleUrl.href);
    const first = await push.getVapidPublicKey();
    const second = await push.getVapidPublicKey();
    const endpoint = "https://push.example.test/subscription-secret";
    const p256dh = "p256dh-secret-value";
    const auth = "auth-secret-value";
    const subscription = { endpoint, keys: { p256dh, auth } };
    await push.savePushSubscription(subscription, "project", "watch", "Pi");
    await push.savePushSubscription(subscription, "project", "second-session", "Claude");

    assert.equal(first, second);
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    const subscriptionCount = db.prepare("SELECT COUNT(*) AS count FROM push_session_subscriptions").get() as { count: number };
    assert.equal(subscriptionCount.count, 2);
    await push.savePushSubscription(subscription, "project", "*", "Joint Bob");
    const projectSubscription = db.prepare("SELECT session_path FROM push_session_subscriptions WHERE project_id = ?").all("project") as Array<{ session_path: string }>;
    assert.equal(projectSubscription.length, 1);
    assert.equal(projectSubscription[0].session_path, "*");
    const row = db.prepare("SELECT private_key FROM push_vapid_keys WHERE singleton = 1").get() as { private_key: string };
    const privateKey = decrypt(row.private_key, Buffer.from((await readFile(path.join(dataDir, "secret.key"), "utf8")).trim(), "base64"));
    const raw = (await rawDatabase(dataDir)).toString("utf8");
    assert.doesNotMatch(raw, new RegExp(privateKey));
    assert.doesNotMatch(raw, new RegExp(endpoint));
    assert.doesNotMatch(raw, new RegExp(p256dh));
    assert.doesNotMatch(raw, new RegExp(auth));
    db.close();
  });
});

test("push imports a valid legacy store without modifying it", async () => {
  await withPushStore(async (dataDir) => {
    const vapidKeys = webpush.generateVAPIDKeys();
    const legacy = JSON.stringify({
      vapidKeys,
      subscriptions: [{
        subscription: { endpoint: "https://push.example.test/legacy", keys: { p256dh: "legacy-p256dh", auth: "legacy-auth" } },
        projectId: "project",
        sessionPath: "watch",
        title: "Legacy",
      }],
    }, null, 2);
    const legacyPath = path.join(dataDir, "push.json");
    await writeFile(legacyPath, legacy, { mode: 0o600 });
    const moduleUrl = new URL(`../src/push.ts?legacy=${Date.now()}`, import.meta.url);
    const push = await import(moduleUrl.href);

    assert.equal(await push.getVapidPublicKey(), vapidKeys.publicKey);
    assert.equal(await readFile(legacyPath, "utf8"), legacy);
  });
});

test("push rejects malformed legacy JSON", async () => {
  await withPushStore(async (dataDir) => {
    await writeFile(path.join(dataDir, "push.json"), "{invalid");
    const moduleUrl = new URL(`../src/push.ts?invalid=${Date.now()}`, import.meta.url);
    const push = await import(moduleUrl.href);

    await assert.rejects(push.getVapidPublicKey(), SyntaxError);
  });
});
