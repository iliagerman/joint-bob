import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import webpush, { type PushSubscription } from "web-push";

interface PushRecord {
  subscription: PushSubscription;
  userId: string;
  projectId: string;
  sessionPath: string;
  title: string;
}

interface PushStore {
  vapidKeys?: { publicKey: string; privateKey: string };
  subscriptions?: PushRecord[];
}

interface VapidRow {
  public_key: string;
  private_key: string;
}

interface SubscriptionRow {
  subscription: string;
}

interface UserRow {
  user_id: string;
}

interface ColumnRow {
  name: string;
}

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
const legacyStorePath = path.join(dataDir, "push.json");
const keyPath = path.join(dataDir, "secret.key");
let database: DatabaseSync | undefined;

function encryptionKey(): Buffer {
  const configured = process.env.JOINT_BOB_SECRET_KEY ?? process.env.MASTER_BOB_SECRET_KEY;
  if (configured) {
    const key = Buffer.from(configured, "base64");
    if (key.length !== 32) throw new Error("JOINT_BOB_SECRET_KEY must be a base64-encoded 32-byte key");
    return key;
  }
  try {
    const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error("Joint Bob secret key is invalid");
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const key = randomBytes(32);
    writeFileSync(keyPath, key.toString("base64"), { mode: 0o600 });
    return key;
  }
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${encrypted.toString("base64")}`;
}

function decrypt(value: string): string {
  const [iv, tag, encrypted] = value.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Stored push credential is invalid");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}

function endpointDigest(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

function subscriptionKey(endpoint: string, projectId: string, sessionPath: string): string {
  return createHash("sha256").update(`${endpoint}\0${projectId}\0${sessionPath}`).digest("hex");
}

function legacyStore(): PushStore | undefined {
  let content: string;
  try {
    content = readFileSync(legacyStorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Legacy push store is invalid");
  const store = parsed as PushStore;
  if (store.vapidKeys !== undefined && (!store.vapidKeys.publicKey || !store.vapidKeys.privateKey || typeof store.vapidKeys.publicKey !== "string" || typeof store.vapidKeys.privateKey !== "string")) {
    throw new Error("Legacy push store is invalid");
  }
  if (store.subscriptions !== undefined && !Array.isArray(store.subscriptions)) throw new Error("Legacy push store is invalid");
  for (const record of store.subscriptions ?? []) {
    if (!record || typeof record !== "object" || !record.subscription || typeof record.subscription.endpoint !== "string" || !record.subscription.keys || typeof record.subscription.keys.p256dh !== "string" || typeof record.subscription.keys.auth !== "string" || typeof record.projectId !== "string" || typeof record.sessionPath !== "string" || typeof record.title !== "string") {
      throw new Error("Legacy push store is invalid");
    }
  }
  return store;
}

function saveSubscription(db: DatabaseSync, record: PushRecord): void {
  const digest = endpointDigest(record.subscription.endpoint);
  // A device asking for every project supersedes its per-project rows, exactly as a project-wide
  // session subscription supersedes that project's per-conversation rows.
  if (record.projectId === "*") {
    db.prepare("DELETE FROM push_session_subscriptions WHERE endpoint_digest = ?").run(digest);
  } else if (record.sessionPath === "*") {
    db.prepare("DELETE FROM push_session_subscriptions WHERE endpoint_digest = ? AND project_id = ?")
      .run(digest, record.projectId);
  }
  db.prepare(`
    INSERT INTO push_session_subscriptions
      (subscription_key, endpoint_digest, user_id, project_id, session_path, title, subscription)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(subscription_key) DO UPDATE SET
      user_id = excluded.user_id,
      title = excluded.title,
      subscription = excluded.subscription
  `).run(
    subscriptionKey(record.subscription.endpoint, record.projectId, record.sessionPath),
    digest,
    record.userId,
    record.projectId,
    record.sessionPath,
    record.title,
    encrypt(JSON.stringify(record.subscription)),
  );
}

function pushDatabase(): DatabaseSync {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS push_vapid_keys (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint_digest TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_path TEXT NOT NULL,
      title TEXT NOT NULL,
      subscription TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS push_subscriptions_project_session ON push_subscriptions(project_id, session_path);
    CREATE TABLE IF NOT EXISTS push_session_subscriptions (
      subscription_key TEXT PRIMARY KEY,
      endpoint_digest TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL,
      session_path TEXT NOT NULL,
      title TEXT NOT NULL,
      subscription TEXT NOT NULL,
      UNIQUE(endpoint_digest, project_id, session_path)
    );
    CREATE INDEX IF NOT EXISTS push_session_subscriptions_project_session
      ON push_session_subscriptions(project_id, session_path);
    CREATE INDEX IF NOT EXISTS push_session_subscriptions_endpoint
      ON push_session_subscriptions(endpoint_digest);
    INSERT OR IGNORE INTO push_session_subscriptions
      (subscription_key, endpoint_digest, project_id, session_path, title, subscription)
      SELECT endpoint_digest || ':' || project_id || ':' || session_path,
        endpoint_digest, project_id, session_path, title, subscription
      FROM push_subscriptions;
    DELETE FROM push_subscriptions;
    CREATE TABLE IF NOT EXISTS push_migrations (
      version INTEGER PRIMARY KEY
    );
  `);
  const columns = database.prepare("PRAGMA table_info(push_session_subscriptions)").all() as unknown as ColumnRow[];
  if (!columns.some((column) => column.name === "user_id")) {
    database.exec("ALTER TABLE push_session_subscriptions ADD COLUMN user_id TEXT NOT NULL DEFAULT ''");
  }
  if (database.prepare("SELECT version FROM push_migrations WHERE version = 1").get()) return database;

  const legacy = legacyStore();
  database.exec("BEGIN");
  try {
    if (legacy?.vapidKeys) {
      database.prepare(`
        INSERT OR IGNORE INTO push_vapid_keys (singleton, public_key, private_key, created_at)
        VALUES (1, ?, ?, ?)
      `).run(legacy.vapidKeys.publicKey, encrypt(legacy.vapidKeys.privateKey), new Date().toISOString());
    }
    for (const record of legacy?.subscriptions ?? []) saveSubscription(database, { ...record, userId: "" });
    if (!database.prepare("SELECT singleton FROM push_vapid_keys WHERE singleton = 1").get()) {
      const vapidKeys = webpush.generateVAPIDKeys();
      database.prepare(`
        INSERT INTO push_vapid_keys (singleton, public_key, private_key, created_at)
        VALUES (1, ?, ?, ?)
      `).run(vapidKeys.publicKey, encrypt(vapidKeys.privateKey), new Date().toISOString());
    }
    database.prepare("INSERT INTO push_migrations (version) VALUES (1)").run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return database;
}

function vapidKeys(): { publicKey: string; privateKey: string } {
  const row = pushDatabase().prepare("SELECT public_key, private_key FROM push_vapid_keys WHERE singleton = 1").get() as unknown as VapidRow;
  return { publicKey: row.public_key, privateKey: decrypt(row.private_key) };
}

function configureWebPush(): void {
  const keys = vapidKeys();
  webpush.setVapidDetails("mailto:joint-bob@localhost", keys.publicKey, keys.privateKey);
}

export async function getVapidPublicKey(): Promise<string> {
  const keys = vapidKeys();
  webpush.setVapidDetails("mailto:joint-bob@localhost", keys.publicKey, keys.privateKey);
  return keys.publicKey;
}

export async function savePushSubscription(subscription: PushSubscription, userId: string, projectId: string, sessionPath: string, title: string): Promise<void> {
  configureWebPush();
  saveSubscription(pushDatabase(), { subscription, userId, projectId, sessionPath, title });
}

/**
 * The accounts with a device waiting on this project, so review notifications are only computed for
 * someone who actually asked for them.
 */
export async function listPushSubscriberUserIds(projectId: string): Promise<string[]> {
  const rows = pushDatabase().prepare(`
    SELECT DISTINCT user_id FROM push_session_subscriptions
    WHERE (project_id = ? OR project_id = '*') AND user_id <> ''
  `).all(projectId) as unknown as UserRow[];
  return rows.map((row) => row.user_id);
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  configureWebPush();
  pushDatabase().prepare("DELETE FROM push_session_subscriptions WHERE endpoint_digest = ?").run(endpointDigest(endpoint));
}

export async function notifyConversationReview(userId: string, projectId: string, sessionPath: string, title: string): Promise<void> {
  configureWebPush();
  const rows = pushDatabase().prepare(`
    SELECT subscription FROM push_session_subscriptions
    WHERE user_id = ?
      AND (project_id = ? OR project_id = '*')
      AND (session_path = ? OR session_path = '*')
  `).all(userId, projectId, sessionPath) as unknown as SubscriptionRow[];
  if (!rows.length) return;

  const payload = JSON.stringify({
    title: `${title || "Conversation"} needs review`,
    body: "Tap to open the conversation and review the result.",
    url: `/?projectId=${encodeURIComponent(projectId)}&sessionPath=${encodeURIComponent(sessionPath)}`,
  });
  const records = rows.map((row) => JSON.parse(decrypt(row.subscription)) as PushSubscription);
  const deadEndpoints = new Set<string>();
  await Promise.all(records.map(async (subscription) => {
    try {
      await webpush.sendNotification(subscription, payload);
    } catch (error) {
      const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 0;
      if (statusCode === 404 || statusCode === 410) deadEndpoints.add(subscription.endpoint);
      else console.warn("Push notification failed", error);
    }
  }));

  if (deadEndpoints.size) {
    const statement = pushDatabase().prepare("DELETE FROM push_session_subscriptions WHERE endpoint_digest = ?");
    for (const endpoint of deadEndpoints) statement.run(endpointDigest(endpoint));
  }
}
