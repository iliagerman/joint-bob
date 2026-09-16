import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
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
  vapid_public_key: string | null;
  vapid_private_key: string | null;
}

interface VersionRow {
  updated_at: string;
  origin_node_id: string;
}

interface EventRow {
  event_id: string;
  entity_key: string;
  operation: "upsert" | "delete";
  payload_encrypted: string;
  updated_at: string;
  origin_node_id: string;
  created_at: string;
}

/** The material a subscription carries to a peer. Values travel in the event body, which the
    mesh transport already authenticates and encrypts in flight; each side stores them under
    its own key — the same contract secret-replication.ts uses for credentials. */
export interface PushSubscriptionUpsertValue {
  userId: string;
  projectId: string;
  sessionPath: string;
  title: string;
  subscription: PushSubscription;
  vapidPublicKey: string;
  vapidPrivateKey: string;
}

export interface PushSubscriptionDeleteValue {
  endpoint: string;
}

export interface PushSubscriptionEvent {
  id: string;
  entityKey: string;
  operation: "upsert" | "delete";
  value: PushSubscriptionUpsertValue | PushSubscriptionDeleteValue;
  updatedAt: string;
  originNodeId: string;
  createdAt: string;
}

interface UserRow {
  user_id: string;
}

interface ColumnRow {
  name: string;
}

const dataDir = resolveDataDirectory();
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

interface SubscriptionVersion {
  updatedAt: string;
  originNodeId: string;
  vapidPublicKey: string | null;
  vapidPrivateKeyEncrypted: string | null;
}

const LEGACY_VERSION: SubscriptionVersion = { updatedAt: "", originNodeId: "", vapidPublicKey: null, vapidPrivateKeyEncrypted: null };

function saveSubscription(db: DatabaseSync, record: PushRecord, version = LEGACY_VERSION): void {
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
      (subscription_key, endpoint_digest, user_id, project_id, session_path, title, subscription,
       updated_at, origin_node_id, vapid_public_key, vapid_private_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(subscription_key) DO UPDATE SET
      user_id = excluded.user_id,
      title = excluded.title,
      subscription = excluded.subscription,
      updated_at = excluded.updated_at,
      origin_node_id = excluded.origin_node_id,
      vapid_public_key = excluded.vapid_public_key,
      vapid_private_key = excluded.vapid_private_key
  `).run(
    subscriptionKey(record.subscription.endpoint, record.projectId, record.sessionPath),
    digest,
    record.userId,
    record.projectId,
    record.sessionPath,
    record.title,
    encrypt(JSON.stringify(record.subscription)),
    version.updatedAt,
    version.originNodeId,
    version.vapidPublicKey,
    version.vapidPrivateKeyEncrypted,
  );
}

/** Replaces any queued event for the same entity: peers only ever need the newest state,
    and a delete must not leave a superseded upsert behind to resurrect the subscription. */
function pruneSubscriptionEvents(db: DatabaseSync, entityKey: string): void {
  db.prepare("DELETE FROM push_subscription_deliveries WHERE event_id IN (SELECT event_id FROM push_subscription_events WHERE entity_key = ?)").run(entityKey);
  db.prepare("DELETE FROM push_subscription_events WHERE entity_key = ?").run(entityKey);
}

function insertSubscriptionEvent(db: DatabaseSync, event: PushSubscriptionEvent): void {
  pruneSubscriptionEvents(db, event.entityKey);
  db.prepare("INSERT INTO push_subscription_events (event_id, entity_key, operation, payload_encrypted, updated_at, origin_node_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(event.id, event.entityKey, event.operation, encrypt(JSON.stringify(event.value)), event.updatedAt, event.originNodeId, event.createdAt);
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
    CREATE TABLE IF NOT EXISTS push_subscription_tombstones (
      endpoint_digest TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      origin_node_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_subscription_events (
      event_id TEXT PRIMARY KEY,
      entity_key TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload_encrypted TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      origin_node_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_subscription_deliveries (
      event_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_attempt_at TEXT NOT NULL,
      delivered_at TEXT,
      last_error TEXT,
      PRIMARY KEY (event_id, peer_id)
    );
    CREATE TABLE IF NOT EXISTS push_subscription_inbox (
      event_id TEXT PRIMARY KEY,
      origin_node_id TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
  `);
  const columns = database.prepare("PRAGMA table_info(push_session_subscriptions)").all() as unknown as ColumnRow[];
  const additions: Array<[string, string]> = [
    ["user_id", "TEXT NOT NULL DEFAULT ''"],
    ["updated_at", "TEXT NOT NULL DEFAULT ''"],
    ["origin_node_id", "TEXT NOT NULL DEFAULT ''"],
    ["vapid_public_key", "TEXT"],
    ["vapid_private_key", "TEXT"],
  ];
  for (const [name, definition] of additions) {
    if (!columns.some((column) => column.name === name)) {
      database.exec(`ALTER TABLE push_session_subscriptions ADD COLUMN ${name} ${definition}`);
    }
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
  webpush.setVapidDetails("https://github.com/iliagerman/joint-bob", keys.publicKey, keys.privateKey);
}

export async function getVapidPublicKey(): Promise<string> {
  const keys = vapidKeys();
  webpush.setVapidDetails("https://github.com/iliagerman/joint-bob", keys.publicKey, keys.privateKey);
  return keys.publicKey;
}

export async function savePushSubscription(subscription: PushSubscription, userId: string, projectId: string, sessionPath: string, title: string): Promise<void> {
  configureWebPush();
  const keys = vapidKeys();
  const db = pushDatabase();
  const updatedAt = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    // A device that re-subscribes after an unsubscribe is opting back in; the tombstone must
    // not keep beating its own newer upserts on peers.
    db.prepare("DELETE FROM push_subscription_tombstones WHERE endpoint_digest = ?").run(endpointDigest(subscription.endpoint));
    saveSubscription(db, { subscription, userId, projectId, sessionPath, title }, {
      updatedAt, originNodeId: "", vapidPublicKey: keys.publicKey, vapidPrivateKeyEncrypted: encrypt(keys.privateKey),
    });
    insertSubscriptionEvent(db, {
      id: randomUUID(),
      entityKey: subscriptionKey(subscription.endpoint, projectId, sessionPath),
      operation: "upsert",
      value: { userId, projectId, sessionPath, title, subscription, vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey },
      updatedAt,
      originNodeId: "",
      createdAt: new Date().toISOString(),
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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
  const db = pushDatabase();
  const digest = endpointDigest(endpoint);
  const updatedAt = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare("SELECT subscription_key FROM push_session_subscriptions WHERE endpoint_digest = ?").all(digest) as unknown as Array<{ subscription_key: string }>;
    for (const row of rows) pruneSubscriptionEvents(db, row.subscription_key);
    db.prepare("DELETE FROM push_session_subscriptions WHERE endpoint_digest = ?").run(digest);
    db.prepare("INSERT INTO push_subscription_tombstones (endpoint_digest, updated_at, origin_node_id) VALUES (?, ?, ?) ON CONFLICT(endpoint_digest) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id")
      .run(digest, updatedAt, "");
    insertSubscriptionEvent(db, {
      id: randomUUID(), entityKey: digest, operation: "delete", value: { endpoint },
      updatedAt, originNodeId: "", createdAt: new Date().toISOString(),
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Wire input from a peer that may be running a different build, so every field is checked
    before anything is written: a malformed batch is rejected, never half-applied. */
function validateSubscriptionEvent(event: PushSubscriptionEvent): void {
  if (!UUID_PATTERN.test(event.id)) throw new Error("Push subscription event ID must be a UUID");
  if (event.operation !== "upsert" && event.operation !== "delete") throw new Error("Push subscription event operation must be upsert or delete");
  if (!event.updatedAt || Number.isNaN(Date.parse(event.updatedAt))) throw new Error("Push subscription event needs an ISO updatedAt");
  if (typeof event.originNodeId !== "string" || event.originNodeId.length > 64) throw new Error("Push subscription event origin node ID is invalid");
  if (!DIGEST_PATTERN.test(event.entityKey)) throw new Error("Push subscription event entity key must be a digest");
  if (event.operation === "delete") {
    const value = event.value as PushSubscriptionDeleteValue;
    if (!value || typeof value.endpoint !== "string" || !value.endpoint || value.endpoint.length > 2000) throw new Error("Push subscription delete event needs an endpoint");
    if (endpointDigest(value.endpoint) !== event.entityKey) throw new Error("Push subscription event entity key does not match its endpoint");
    return;
  }
  const value = event.value as PushSubscriptionUpsertValue;
  if (!value || typeof value !== "object") throw new Error("Push subscription event needs a value");
  if (typeof value.userId !== "string" || !value.userId || value.userId.length > 128) throw new Error("Push subscription event user ID is invalid");
  if (typeof value.projectId !== "string" || !value.projectId || value.projectId.length > 300) throw new Error("Push subscription event project ID is invalid");
  if (typeof value.sessionPath !== "string" || !value.sessionPath || value.sessionPath.length > 2000) throw new Error("Push subscription event session path is invalid");
  if (typeof value.title !== "string" || value.title.length > 200) throw new Error("Push subscription event title is invalid");
  const subscription = value.subscription;
  if (!subscription || typeof subscription.endpoint !== "string" || !subscription.endpoint || subscription.endpoint.length > 2000
    || !subscription.keys || typeof subscription.keys.p256dh !== "string" || !subscription.keys.p256dh || subscription.keys.p256dh.length > 500
    || typeof subscription.keys.auth !== "string" || !subscription.keys.auth || subscription.keys.auth.length > 500) {
    throw new Error("Push subscription event subscription is invalid");
  }
  if (typeof value.vapidPublicKey !== "string" || !value.vapidPublicKey || value.vapidPublicKey.length > 200) throw new Error("Push subscription event VAPID public key is invalid");
  if (typeof value.vapidPrivateKey !== "string" || !value.vapidPrivateKey || value.vapidPrivateKey.length > 200) throw new Error("Push subscription event VAPID private key is invalid");
  if (subscriptionKey(subscription.endpoint, value.projectId, value.sessionPath) !== event.entityKey) throw new Error("Push subscription event entity key does not match its value");
}

function compareVersion(left: VersionRow, right: VersionRow): number {
  return left.updated_at === right.updated_at ? left.origin_node_id.localeCompare(right.origin_node_id) : left.updated_at.localeCompare(right.updated_at);
}

function applySubscriptionUpsert(db: DatabaseSync, event: PushSubscriptionEvent): boolean {
  const value = event.value as PushSubscriptionUpsertValue;
  const digest = endpointDigest(value.subscription.endpoint);
  const incoming: VersionRow = { updated_at: event.updatedAt, origin_node_id: event.originNodeId };
  const tombstone = db.prepare("SELECT updated_at, origin_node_id FROM push_subscription_tombstones WHERE endpoint_digest = ?").get(digest) as VersionRow | undefined;
  if (tombstone && compareVersion(incoming, tombstone) <= 0) return false;
  const current = db.prepare("SELECT updated_at, origin_node_id FROM push_session_subscriptions WHERE subscription_key = ?").get(event.entityKey) as VersionRow | undefined;
  if (current && compareVersion(incoming, current) <= 0) return false;
  db.prepare("DELETE FROM push_subscription_tombstones WHERE endpoint_digest = ?").run(digest);
  // Re-encrypted here with this node's own key, never stored under the sender's.
  saveSubscription(db, { subscription: value.subscription, userId: value.userId, projectId: value.projectId, sessionPath: value.sessionPath, title: value.title }, {
    updatedAt: event.updatedAt, originNodeId: event.originNodeId,
    vapidPublicKey: value.vapidPublicKey, vapidPrivateKeyEncrypted: encrypt(value.vapidPrivateKey),
  });
  return true;
}

function applySubscriptionDelete(db: DatabaseSync, event: PushSubscriptionEvent): boolean {
  const incoming: VersionRow = { updated_at: event.updatedAt, origin_node_id: event.originNodeId };
  const tombstone = db.prepare("SELECT updated_at, origin_node_id FROM push_subscription_tombstones WHERE endpoint_digest = ?").get(event.entityKey) as VersionRow | undefined;
  if (tombstone && compareVersion(incoming, tombstone) <= 0) return false;
  const newest = db.prepare("SELECT updated_at, origin_node_id FROM push_session_subscriptions WHERE endpoint_digest = ? ORDER BY updated_at DESC, origin_node_id DESC LIMIT 1").get(event.entityKey) as VersionRow | undefined;
  if (newest && compareVersion(incoming, newest) <= 0) return false;
  db.prepare("INSERT INTO push_subscription_tombstones (endpoint_digest, updated_at, origin_node_id) VALUES (?, ?, ?) ON CONFLICT(endpoint_digest) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id")
    .run(event.entityKey, event.updatedAt, event.originNodeId);
  db.prepare("DELETE FROM push_session_subscriptions WHERE endpoint_digest = ?").run(event.entityKey);
  return true;
}

/** Enrols every queued event for `peerId` lazily, then returns the batch it still owes,
    decrypted for the wire. Mirrors the generic replication outbox contract. */
export async function pushSubscriptionEventsForPeer(peerId: string, now = new Date()): Promise<PushSubscriptionEvent[]> {
  const db = pushDatabase();
  const at = now.toISOString();
  db.prepare("INSERT OR IGNORE INTO push_subscription_deliveries (event_id, peer_id, attempts, next_attempt_at, delivered_at, last_error) SELECT event_id, ?, 0, ?, NULL, NULL FROM push_subscription_events").run(peerId, at);
  const rows = db.prepare(`
    SELECT e.event_id, e.entity_key, e.operation, e.payload_encrypted, e.updated_at, e.origin_node_id, e.created_at
    FROM push_subscription_events e
    JOIN push_subscription_deliveries d ON d.event_id = e.event_id
    WHERE d.peer_id = ? AND d.delivered_at IS NULL AND d.next_attempt_at <= ?
    ORDER BY e.created_at, e.event_id LIMIT 100
  `).all(peerId, at) as unknown as EventRow[];
  return rows.map((row) => ({
    id: row.event_id, entityKey: row.entity_key, operation: row.operation,
    value: JSON.parse(decrypt(row.payload_encrypted)) as PushSubscriptionEvent["value"],
    updatedAt: row.updated_at, originNodeId: row.origin_node_id, createdAt: row.created_at,
  }));
}

export async function recordPushSubscriptionReceipt(peerId: string, eventIds: string[]): Promise<void> {
  if (!eventIds.length) return;
  const db = pushDatabase();
  const update = db.prepare("UPDATE push_subscription_deliveries SET delivered_at = COALESCE(delivered_at, ?), last_error = NULL WHERE peer_id = ? AND event_id = ?");
  for (const id of eventIds) update.run(new Date().toISOString(), peerId, id);
}

export async function recordPushSubscriptionFailure(peerId: string, eventIds: string[], message: string, now = new Date()): Promise<void> {
  if (!eventIds.length) return;
  const db = pushDatabase();
  const current = db.prepare("SELECT attempts FROM push_subscription_deliveries WHERE peer_id = ? AND event_id = ? AND delivered_at IS NULL");
  const update = db.prepare("UPDATE push_subscription_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE peer_id = ? AND event_id = ? AND delivered_at IS NULL");
  for (const id of eventIds) {
    const row = current.get(peerId, id) as { attempts: number } | undefined;
    if (!row) continue;
    const attempts = row.attempts + 1;
    update.run(attempts, new Date(now.getTime() + Math.min(300, 2 ** Math.min(attempts, 8)) * 1000).toISOString(), message, peerId, id);
  }
}

export async function receivePushSubscriptionEvents(events: PushSubscriptionEvent[]): Promise<string[]> {
  for (const event of events) validateSubscriptionEvent(event);
  const db = pushDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const received: string[] = [];
    const inbox = db.prepare("INSERT OR IGNORE INTO push_subscription_inbox (event_id, origin_node_id, received_at) VALUES (?, ?, ?)");
    for (const event of events) {
      if (!inbox.run(event.id, event.originNodeId, new Date().toISOString()).changes) { received.push(event.id); continue; }
      const applied = event.operation === "delete" ? applySubscriptionDelete(db, event) : applySubscriptionUpsert(db, event);
      // A winning event is stored for this node's own peers, so three-node meshes converge
      // without every node pairing with every other.
      if (applied) insertSubscriptionEvent(db, event);
      received.push(event.id);
    }
    db.exec("COMMIT");
    return received;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Reports whether at least one device was actually reached, so a caller that burned a
    one-shot notification claim can hand it back instead of recording a silent failure as sent. */
export async function notifyConversationReview(userId: string, projectId: string, sessionPath: string, title: string): Promise<boolean> {
  const keys = vapidKeys();
  const rows = pushDatabase().prepare(`
    SELECT subscription, vapid_public_key, vapid_private_key FROM push_session_subscriptions
    WHERE user_id = ?
      AND (project_id = ? OR project_id = '*')
      AND (session_path = ? OR session_path = '*')
  `).all(userId, projectId, sessionPath) as unknown as SubscriptionRow[];
  if (!rows.length) return false;

  const payload = JSON.stringify({
    title: `${title || "Conversation"} needs review`,
    body: "Tap to open the conversation and review the result.",
    url: `/?projectId=${encodeURIComponent(projectId)}&sessionPath=${encodeURIComponent(sessionPath)}`,
  });
  // A replicated subscription was created against its origin node's VAPID identity; the push
  // service only accepts sends signed with that same key pair, so each row carries its own.
  const records = rows.map((row) => ({
    subscription: JSON.parse(decrypt(row.subscription)) as PushSubscription,
    vapidDetails: {
      subject: "https://github.com/iliagerman/joint-bob",
      publicKey: row.vapid_public_key ?? keys.publicKey,
      privateKey: row.vapid_private_key ? decrypt(row.vapid_private_key) : keys.privateKey,
    },
  }));
  const deadEndpoints = new Set<string>();
  const delivered = await Promise.all(records.map(async ({ subscription, vapidDetails }) => {
    try {
      await webpush.sendNotification(subscription, payload, { vapidDetails });
      return true;
    } catch (error) {
      const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 0;
      if (statusCode === 404 || statusCode === 410) deadEndpoints.add(subscription.endpoint);
      else console.warn("Push notification failed", error);
      return false;
    }
  }));

  for (const endpoint of deadEndpoints) await deletePushSubscription(endpoint);
  return delivered.some(Boolean);
}
