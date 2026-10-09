import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { getClusterNode } from "./cluster.js";
import { userIdForUsername, usernameForUser } from "./auth.js";
import { resolveProjectAlias } from "./replication.js";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import webpush from "web-push";
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
const legacyStorePath = path.join(dataDir, "push.json");
const keyPath = path.join(dataDir, "secret.key");
let database;
function encryptionKey() {
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
    if (error.code !== "ENOENT") throw error;
    const key = randomBytes(32);
    writeFileSync(keyPath, key.toString("base64"), { mode: 384 });
    return key;
  }
}
function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${encrypted.toString("base64")}`;
}
function decrypt(value) {
  const [iv, tag, encrypted] = value.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Stored push credential is invalid");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}
function endpointDigest(endpoint) {
  return createHash("sha256").update(endpoint).digest("hex");
}
function subscriptionKey(endpoint, projectId, sessionPath) {
  return createHash("sha256").update(`${endpoint}\0${projectId}\0${sessionPath}`).digest("hex");
}
function legacyStore() {
  let content;
  try {
    content = readFileSync(legacyStorePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Legacy push store is invalid");
  const store = parsed;
  if (store.vapidKeys !== void 0 && (!store.vapidKeys.publicKey || !store.vapidKeys.privateKey || typeof store.vapidKeys.publicKey !== "string" || typeof store.vapidKeys.privateKey !== "string")) {
    throw new Error("Legacy push store is invalid");
  }
  if (store.subscriptions !== void 0 && !Array.isArray(store.subscriptions)) throw new Error("Legacy push store is invalid");
  for (const record of store.subscriptions ?? []) {
    if (!record || typeof record !== "object" || !record.subscription || typeof record.subscription.endpoint !== "string" || !record.subscription.keys || typeof record.subscription.keys.p256dh !== "string" || typeof record.subscription.keys.auth !== "string" || typeof record.projectId !== "string" || typeof record.sessionPath !== "string" || typeof record.title !== "string") {
      throw new Error("Legacy push store is invalid");
    }
  }
  return store;
}
const LEGACY_VERSION = { updatedAt: "", originNodeId: "", vapidPublicKey: null, vapidPrivateKeyEncrypted: null };
function saveSubscription(db, record, version = LEGACY_VERSION) {
  const digest = endpointDigest(record.subscription.endpoint);
  if (record.projectId === "*") {
    db.prepare("DELETE FROM push_session_subscriptions WHERE endpoint_digest = ?").run(digest);
  } else if (record.sessionPath === "*") {
    db.prepare("DELETE FROM push_session_subscriptions WHERE endpoint_digest = ? AND project_id = ?").run(digest, record.projectId);
  }
  db.prepare(`
    INSERT INTO push_session_subscriptions
      (subscription_key, endpoint_digest, user_id, username, project_id, session_path, title, subscription,
       updated_at, origin_node_id, vapid_public_key, vapid_private_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(subscription_key) DO UPDATE SET
      user_id = excluded.user_id,
      username = excluded.username,
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
    record.username ?? null,
    record.projectId,
    record.sessionPath,
    record.title,
    encrypt(JSON.stringify(record.subscription)),
    version.updatedAt,
    version.originNodeId,
    version.vapidPublicKey,
    version.vapidPrivateKeyEncrypted
  );
}
function pruneSubscriptionEvents(db, entityKey) {
  db.prepare("DELETE FROM push_subscription_deliveries WHERE event_id IN (SELECT event_id FROM push_subscription_events WHERE entity_key = ?)").run(entityKey);
  db.prepare("DELETE FROM push_subscription_events WHERE entity_key = ?").run(entityKey);
}
function insertSubscriptionEvent(db, event) {
  pruneSubscriptionEvents(db, event.entityKey);
  db.prepare("INSERT INTO push_subscription_events (event_id, entity_key, operation, payload_encrypted, updated_at, origin_node_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(event.id, event.entityKey, event.operation, encrypt(JSON.stringify(event.value)), event.updatedAt, event.originNodeId, event.createdAt);
}
function pushDatabase() {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 448 });
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
  const columns = database.prepare("PRAGMA table_info(push_session_subscriptions)").all();
  const additions = [
    ["user_id", "TEXT NOT NULL DEFAULT ''"],
    ["username", "TEXT"],
    ["updated_at", "TEXT NOT NULL DEFAULT ''"],
    ["origin_node_id", "TEXT NOT NULL DEFAULT ''"],
    ["vapid_public_key", "TEXT"],
    ["vapid_private_key", "TEXT"]
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
      `).run(legacy.vapidKeys.publicKey, encrypt(legacy.vapidKeys.privateKey), (/* @__PURE__ */ new Date()).toISOString());
    }
    for (const record of legacy?.subscriptions ?? []) saveSubscription(database, { ...record, userId: "" });
    if (!database.prepare("SELECT singleton FROM push_vapid_keys WHERE singleton = 1").get()) {
      const vapidKeys2 = webpush.generateVAPIDKeys();
      database.prepare(`
        INSERT INTO push_vapid_keys (singleton, public_key, private_key, created_at)
        VALUES (1, ?, ?, ?)
      `).run(vapidKeys2.publicKey, encrypt(vapidKeys2.privateKey), (/* @__PURE__ */ new Date()).toISOString());
    }
    database.prepare("INSERT INTO push_migrations (version) VALUES (1)").run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return database;
}
function vapidKeys() {
  const row = pushDatabase().prepare("SELECT public_key, private_key FROM push_vapid_keys WHERE singleton = 1").get();
  return { publicKey: row.public_key, privateKey: decrypt(row.private_key) };
}
function configureWebPush() {
  const keys = vapidKeys();
  webpush.setVapidDetails("https://github.com/iliagerman/joint-bob", keys.publicKey, keys.privateKey);
}
async function getVapidPublicKey() {
  const keys = vapidKeys();
  webpush.setVapidDetails("https://github.com/iliagerman/joint-bob", keys.publicKey, keys.privateKey);
  return keys.publicKey;
}
function nextEndpointTimestamp(db, digest) {
  const row = db.prepare(`SELECT MAX(updated_at) AS updated_at FROM (
    SELECT updated_at FROM push_session_subscriptions WHERE endpoint_digest=?
    UNION ALL SELECT updated_at FROM push_subscription_tombstones WHERE endpoint_digest=?)`).get(digest, digest);
  return new Date(Math.max(Date.now(), row.updated_at ? Date.parse(row.updated_at) + 1 : 0)).toISOString();
}
async function savePushSubscription(subscription, userId, projectId, sessionPath, title, username) {
  configureWebPush();
  const keys = vapidKeys();
  const db = pushDatabase();
  db.exec("BEGIN IMMEDIATE");
  const updatedAt = nextEndpointTimestamp(db, endpointDigest(subscription.endpoint));
  try {
    db.prepare("DELETE FROM push_subscription_tombstones WHERE endpoint_digest = ?").run(endpointDigest(subscription.endpoint));
    saveSubscription(db, { subscription, userId, username, projectId, sessionPath, title }, {
      updatedAt,
      originNodeId: "",
      vapidPublicKey: keys.publicKey,
      vapidPrivateKeyEncrypted: encrypt(keys.privateKey)
    });
    insertSubscriptionEvent(db, {
      id: randomUUID(),
      entityKey: subscriptionKey(subscription.endpoint, projectId, sessionPath),
      operation: "upsert",
      value: { userId, username, projectId, sessionPath, title, subscription, vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey },
      updatedAt,
      originNodeId: "",
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function listPushSubscriberUserIds(projectId) {
  const db = pushDatabase();
  const rows = db.prepare("SELECT DISTINCT user_id, username, project_id FROM push_session_subscriptions").all();
  const usernames = new Set(rows.flatMap((row) => row.username ? [row.username.toLowerCase()] : []));
  const resolvedUsers = new Map([...usernames].map((username) => [username, userIdForUsername(username)]));
  const canonical = resolveProjectAlias(db, projectId);
  const ids = rows.flatMap((row) => {
    if (row.project_id !== "*" && resolveProjectAlias(db, row.project_id) !== canonical) return [];
    if (row.username) return resolvedUsers.get(row.username.toLowerCase()) ? [resolvedUsers.get(row.username.toLowerCase())] : [];
    return row.user_id ? [row.user_id] : [];
  });
  return [...new Set(ids)];
}
async function deletePushSubscription(endpoint) {
  configureWebPush();
  const db = pushDatabase();
  const digest = endpointDigest(endpoint);
  db.exec("BEGIN IMMEDIATE");
  const updatedAt = nextEndpointTimestamp(db, digest);
  try {
    const rows = db.prepare("SELECT subscription_key FROM push_session_subscriptions WHERE endpoint_digest = ?").all(digest);
    for (const row of rows) pruneSubscriptionEvents(db, row.subscription_key);
    db.prepare("DELETE FROM push_session_subscriptions WHERE endpoint_digest = ?").run(digest);
    db.prepare("INSERT INTO push_subscription_tombstones (endpoint_digest, updated_at, origin_node_id) VALUES (?, ?, ?) ON CONFLICT(endpoint_digest) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id").run(digest, updatedAt, "");
    insertSubscriptionEvent(db, {
      id: randomUUID(),
      entityKey: digest,
      operation: "delete",
      value: { endpoint },
      updatedAt,
      originNodeId: "",
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validateSubscriptionEvent(event) {
  if (!UUID_PATTERN.test(event.id)) throw new Error("Push subscription event ID must be a UUID");
  if (event.operation !== "upsert" && event.operation !== "delete") throw new Error("Push subscription event operation must be upsert or delete");
  if (!event.updatedAt || Number.isNaN(Date.parse(event.updatedAt))) throw new Error("Push subscription event needs an ISO updatedAt");
  if (typeof event.originNodeId !== "string" || event.originNodeId.length > 64) throw new Error("Push subscription event origin node ID is invalid");
  if (!DIGEST_PATTERN.test(event.entityKey)) throw new Error("Push subscription event entity key must be a digest");
  if (event.operation === "delete") {
    const value2 = event.value;
    if (!value2 || typeof value2.endpoint !== "string" || !value2.endpoint || value2.endpoint.length > 2e3) throw new Error("Push subscription delete event needs an endpoint");
    if (endpointDigest(value2.endpoint) !== event.entityKey) throw new Error("Push subscription event entity key does not match its endpoint");
    return;
  }
  const value = event.value;
  if (!value || typeof value !== "object") throw new Error("Push subscription event needs a value");
  if (typeof value.userId !== "string" || !value.userId || value.userId.length > 128) throw new Error("Push subscription event user ID is invalid");
  if (value.username !== void 0 && (typeof value.username !== "string" || !value.username || value.username.length > 80)) throw new Error("Push subscription event username is invalid");
  if (typeof value.projectId !== "string" || !value.projectId || value.projectId.length > 300) throw new Error("Push subscription event project ID is invalid");
  if (typeof value.sessionPath !== "string" || !value.sessionPath || value.sessionPath.length > 2e3) throw new Error("Push subscription event session path is invalid");
  if (typeof value.title !== "string" || value.title.length > 200) throw new Error("Push subscription event title is invalid");
  const subscription = value.subscription;
  if (!subscription || typeof subscription.endpoint !== "string" || !subscription.endpoint || subscription.endpoint.length > 2e3 || !subscription.keys || typeof subscription.keys.p256dh !== "string" || !subscription.keys.p256dh || subscription.keys.p256dh.length > 500 || typeof subscription.keys.auth !== "string" || !subscription.keys.auth || subscription.keys.auth.length > 500) {
    throw new Error("Push subscription event subscription is invalid");
  }
  if (typeof value.vapidPublicKey !== "string" || !value.vapidPublicKey || value.vapidPublicKey.length > 200) throw new Error("Push subscription event VAPID public key is invalid");
  if (typeof value.vapidPrivateKey !== "string" || !value.vapidPrivateKey || value.vapidPrivateKey.length > 200) throw new Error("Push subscription event VAPID private key is invalid");
  if (subscriptionKey(subscription.endpoint, value.projectId, value.sessionPath) !== event.entityKey) throw new Error("Push subscription event entity key does not match its value");
}
function compareVersion(left, right) {
  return left.updated_at === right.updated_at ? left.origin_node_id.localeCompare(right.origin_node_id) : left.updated_at.localeCompare(right.updated_at);
}
function applySubscriptionUpsert(db, event) {
  const value = event.value;
  const digest = endpointDigest(value.subscription.endpoint);
  const incoming = { updated_at: event.updatedAt, origin_node_id: event.originNodeId };
  const tombstone = db.prepare("SELECT updated_at, origin_node_id FROM push_subscription_tombstones WHERE endpoint_digest = ?").get(digest);
  if (tombstone && compareVersion(incoming, tombstone) <= 0) return false;
  const current = db.prepare("SELECT updated_at, origin_node_id FROM push_session_subscriptions WHERE subscription_key = ?").get(event.entityKey);
  if (current && compareVersion(incoming, current) <= 0) return false;
  const isNtfy = value.subscription.endpoint.startsWith("ntfy+");
  const endpointRows = isNtfy ? db.prepare("SELECT * FROM push_session_subscriptions WHERE endpoint_digest=?").all(digest) : [];
  if (endpointRows.some((row) => compareVersion(incoming, row) < 0)) return false;
  db.prepare("DELETE FROM push_subscription_tombstones WHERE endpoint_digest = ?").run(digest);
  if (isNtfy) {
    const canonical = resolveProjectAlias(db, value.projectId);
    for (const row of endpointRows) {
      const sameAccount = row.username && value.username ? row.username.toLowerCase() === value.username.toLowerCase() : !row.username && row.user_id === value.userId;
      if (!sameAccount || resolveProjectAlias(db, row.project_id) !== canonical || row.subscription_key === event.entityKey) continue;
      pruneSubscriptionEvents(db, row.subscription_key);
      db.prepare("DELETE FROM push_session_subscriptions WHERE subscription_key=?").run(row.subscription_key);
    }
  }
  saveSubscription(db, { subscription: value.subscription, userId: value.userId, username: value.username, projectId: value.projectId, sessionPath: value.sessionPath, title: value.title }, {
    updatedAt: event.updatedAt,
    originNodeId: event.originNodeId,
    vapidPublicKey: value.vapidPublicKey,
    vapidPrivateKeyEncrypted: encrypt(value.vapidPrivateKey)
  });
  return true;
}
function applySubscriptionDelete(db, event) {
  const incoming = { updated_at: event.updatedAt, origin_node_id: event.originNodeId };
  const tombstone = db.prepare("SELECT updated_at, origin_node_id FROM push_subscription_tombstones WHERE endpoint_digest = ?").get(event.entityKey);
  if (tombstone && compareVersion(incoming, tombstone) <= 0) return false;
  const newest = db.prepare("SELECT updated_at, origin_node_id FROM push_session_subscriptions WHERE endpoint_digest = ? ORDER BY updated_at DESC, origin_node_id DESC LIMIT 1").get(event.entityKey);
  if (newest && compareVersion(incoming, newest) <= 0) return false;
  db.prepare("INSERT INTO push_subscription_tombstones (endpoint_digest, updated_at, origin_node_id) VALUES (?, ?, ?) ON CONFLICT(endpoint_digest) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id").run(event.entityKey, event.updatedAt, event.originNodeId);
  db.prepare("DELETE FROM push_session_subscriptions WHERE endpoint_digest = ?").run(event.entityKey);
  return true;
}
async function pushSubscriptionEventsForPeer(peerId, now = /* @__PURE__ */ new Date()) {
  const db = pushDatabase();
  const at = now.toISOString();
  db.prepare("INSERT OR IGNORE INTO push_subscription_deliveries (event_id, peer_id, attempts, next_attempt_at, delivered_at, last_error) SELECT event_id, ?, 0, ?, NULL, NULL FROM push_subscription_events").run(peerId, at);
  const rows = db.prepare(`
    SELECT e.event_id, e.entity_key, e.operation, e.payload_encrypted, e.updated_at, e.origin_node_id, e.created_at
    FROM push_subscription_events e
    JOIN push_subscription_deliveries d ON d.event_id = e.event_id
    WHERE d.peer_id = ? AND d.delivered_at IS NULL AND d.next_attempt_at <= ?
    ORDER BY e.created_at, e.event_id LIMIT 100
  `).all(peerId, at);
  return rows.map((row) => ({
    id: row.event_id,
    entityKey: row.entity_key,
    operation: row.operation,
    value: JSON.parse(decrypt(row.payload_encrypted)),
    updatedAt: row.updated_at,
    originNodeId: row.origin_node_id,
    createdAt: row.created_at
  }));
}
async function recordPushSubscriptionReceipt(peerId, eventIds) {
  if (!eventIds.length) return;
  const db = pushDatabase();
  const update = db.prepare("UPDATE push_subscription_deliveries SET delivered_at = COALESCE(delivered_at, ?), last_error = NULL WHERE peer_id = ? AND event_id = ?");
  for (const id of eventIds) update.run((/* @__PURE__ */ new Date()).toISOString(), peerId, id);
}
async function recordPushSubscriptionFailure(peerId, eventIds, message, now = /* @__PURE__ */ new Date()) {
  if (!eventIds.length) return;
  const db = pushDatabase();
  const current = db.prepare("SELECT attempts FROM push_subscription_deliveries WHERE peer_id = ? AND event_id = ? AND delivered_at IS NULL");
  const update = db.prepare("UPDATE push_subscription_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE peer_id = ? AND event_id = ? AND delivered_at IS NULL");
  for (const id of eventIds) {
    const row = current.get(peerId, id);
    if (!row) continue;
    const attempts = row.attempts + 1;
    update.run(attempts, new Date(now.getTime() + Math.min(300, 2 ** Math.min(attempts, 8)) * 1e3).toISOString(), message, peerId, id);
  }
}
async function receivePushSubscriptionEvents(events) {
  for (const event of events) validateSubscriptionEvent(event);
  const db = pushDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const received = [];
    const inbox = db.prepare("INSERT OR IGNORE INTO push_subscription_inbox (event_id, origin_node_id, received_at) VALUES (?, ?, ?)");
    for (const event of events) {
      if (!inbox.run(event.id, event.originNodeId, (/* @__PURE__ */ new Date()).toISOString()).changes) {
        received.push(event.id);
        continue;
      }
      const applied = event.operation === "delete" ? applySubscriptionDelete(db, event) : applySubscriptionUpsert(db, event);
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
const NTFY_ENDPOINT_PREFIX = "ntfy+";
const NTFY_NO_TOKEN = "-";
async function ntfyConversationTargets(projectId, conversationId) {
  const db = pushDatabase();
  const canonical = resolveProjectAlias(db, projectId);
  const rows = db.prepare("SELECT * FROM push_session_subscriptions WHERE session_path = ?").all(conversationId);
  const targets = rows.flatMap((row) => {
    if (resolveProjectAlias(db, row.project_id) !== canonical) return [];
    const subscription = JSON.parse(decrypt(row.subscription));
    if (!subscription.endpoint.startsWith(NTFY_ENDPOINT_PREFIX)) return [];
    const target = new URL(subscription.endpoint.slice(NTFY_ENDPOINT_PREFIX.length));
    target.hash = "";
    const segments = target.pathname.split("/").filter(Boolean);
    const topic = segments.pop();
    if (!topic) throw new Error("Stored ntfy target has no topic");
    target.pathname = segments.length ? `/${segments.join("/")}` : "";
    return [{ url: target.href.replace(/\/$/, ""), topic: decodeURIComponent(topic), token: subscription.keys.auth === NTFY_NO_TOKEN ? "" : subscription.keys.auth }];
  });
  return [...new Map(targets.map((target) => [`${target.url}\0${target.topic}\0${target.token}`, target])).values()];
}
function ntfySubscription(serviceUrl, topic, token, projectId, sessionPath) {
  const conversation = createHash("sha256").update(`${projectId}\0${sessionPath}`).digest("hex").slice(0, 16);
  return {
    endpoint: `${NTFY_ENDPOINT_PREFIX}${serviceUrl.replace(/\/+$/, "")}/${topic}#${conversation}`,
    keys: { p256dh: "ntfy", auth: token || NTFY_NO_TOKEN }
  };
}
function userProjectSubscriptions(db, userId, projectId, includeGlobal = false) {
  const username = usernameForUser(userId) ?? null;
  const rows = db.prepare("SELECT * FROM push_session_subscriptions WHERE username=? COLLATE NOCASE OR (username IS NULL AND user_id=?)").all(username, userId);
  const canonical = resolveProjectAlias(db, projectId);
  return rows.filter((row) => includeGlobal && row.project_id === "*" || resolveProjectAlias(db, row.project_id) === canonical);
}
async function migratePushConversationSubscriptions(userId, username, projectId, sessions) {
  const db = pushDatabase();
  const canonical = resolveProjectAlias(db, projectId);
  if (usernameForUser(userId)?.toLowerCase() !== username.toLowerCase()) throw new Error("Push migration account does not match");
  const rows = userProjectSubscriptions(db, userId, canonical, true);
  const identities = /* @__PURE__ */ new Map();
  for (const session of sessions) {
    const id = session.conversationId || session.id;
    identities.set(id, id);
    identities.set(session.path, id);
    identities.set(`draft:${session.harnessId}:${session.id}`, id);
    for (const segment of session.segments ?? []) {
      identities.set(segment.path, id);
      identities.set(`draft:${segment.engine}:${segment.sessionId}`, id);
    }
  }
  for (const row of rows) {
    if (row.project_id !== "*" && resolveProjectAlias(db, row.project_id) !== canonical) continue;
    const target = row.session_path === "*" ? "*" : identities.get(row.session_path);
    if (!target && row.username) continue;
    if (row.username?.toLowerCase() === username.toLowerCase() && (!target || target === row.session_path)) continue;
    migrateSubscriptionRow(db, row, username, target ?? row.session_path);
  }
}
function migrateSubscriptionRow(db, row, username, sessionPath) {
  const subscription = JSON.parse(decrypt(row.subscription));
  db.exec("BEGIN IMMEDIATE");
  try {
    const updatedAt = nextEndpointTimestamp(db, endpointDigest(subscription.endpoint));
    const destinationKey = subscriptionKey(subscription.endpoint, row.project_id, sessionPath);
    const destination = db.prepare("SELECT updated_at,origin_node_id FROM push_session_subscriptions WHERE subscription_key=?").get(destinationKey);
    pruneSubscriptionEvents(db, row.subscription_key);
    db.prepare("DELETE FROM push_session_subscriptions WHERE subscription_key=?").run(row.subscription_key);
    if (destinationKey !== row.subscription_key && destination && compareVersion(destination, row) >= 0) {
      db.exec("COMMIT");
      return;
    }
    const privateKey = row.vapid_private_key ? decrypt(row.vapid_private_key) : vapidKeys().privateKey;
    const publicKey = row.vapid_public_key ?? vapidKeys().publicKey;
    saveSubscription(db, { subscription, userId: row.user_id, username, projectId: row.project_id, sessionPath, title: row.title }, { updatedAt, originNodeId: "", vapidPublicKey: publicKey, vapidPrivateKeyEncrypted: encrypt(privateKey) });
    insertSubscriptionEvent(db, { id: randomUUID(), entityKey: destinationKey, operation: "upsert", value: { userId: row.user_id, username, projectId: row.project_id, sessionPath, title: row.title, subscription, vapidPublicKey: publicKey, vapidPrivateKey: privateKey }, updatedAt, originNodeId: "", createdAt: updatedAt });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function ntfySubscribedSessionPaths(userId, projectId) {
  const db = pushDatabase();
  const rows = userProjectSubscriptions(db, userId, projectId);
  const paths = /* @__PURE__ */ new Set();
  for (const row of rows) {
    const subscription = JSON.parse(decrypt(row.subscription));
    if (subscription.endpoint.startsWith(NTFY_ENDPOINT_PREFIX)) paths.add(row.session_path);
  }
  return paths;
}
async function deleteNtfySubscriptions(userId, projectId, sessionPath) {
  const db = pushDatabase();
  const rows = userProjectSubscriptions(db, userId, projectId).filter((row) => row.session_path === sessionPath);
  for (const row of rows) {
    const subscription = JSON.parse(decrypt(row.subscription));
    if (subscription.endpoint.startsWith(NTFY_ENDPOINT_PREFIX)) await deletePushSubscription(subscription.endpoint);
  }
}
async function sendNtfyNotification(subscription, title, message, click) {
  const target = new URL(subscription.endpoint.slice(NTFY_ENDPOINT_PREFIX.length));
  target.hash = "";
  const segments = target.pathname.split("/").filter(Boolean);
  const topic = segments.pop() ?? "";
  target.pathname = `/${segments.join("/")}`;
  const headers = { "Content-Type": "application/json" };
  if (subscription.keys.auth !== NTFY_NO_TOKEN) headers.Authorization = `Bearer ${subscription.keys.auth}`;
  const response = await fetch(target, {
    method: "POST",
    headers,
    body: JSON.stringify({ topic, title, message, ...click ? { click } : {} }),
    signal: AbortSignal.timeout(1e4)
  });
  if (!response.ok) console.warn(`ntfy publish to ${target.host} failed with status ${response.status}`);
  return response.ok;
}
const DEFAULT_REVIEW_BODY = "Tap to open the conversation and review the result.";
const REVIEW_PREVIEW_MAX_CHARS = 140;
function reviewNotificationBody(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = message.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    return text.length > REVIEW_PREVIEW_MAX_CHARS ? `${text.slice(0, REVIEW_PREVIEW_MAX_CHARS - 1)}\u2026` : text;
  }
  return DEFAULT_REVIEW_BODY;
}
async function notifyConversationReview(userId, projectId, sessionPath, title, body = DEFAULT_REVIEW_BODY) {
  const keys = vapidKeys();
  const db = pushDatabase();
  const rows = userProjectSubscriptions(db, userId, projectId, true).filter((row) => row.session_path === sessionPath || row.session_path === "*");
  if (!rows.length) return false;
  const notificationTitle = `${title || "Conversation"} needs review`;
  const conversationUrl = `/?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionPath)}`;
  const payload = JSON.stringify({ title: notificationTitle, body, url: conversationUrl });
  const records = rows.map((row) => ({
    subscription: JSON.parse(decrypt(row.subscription)),
    vapidDetails: {
      subject: "https://github.com/iliagerman/joint-bob",
      publicKey: row.vapid_public_key ?? keys.publicKey,
      privateKey: row.vapid_private_key ? decrypt(row.vapid_private_key) : keys.privateKey
    }
  }));
  const clusterUrl = records.some(({ subscription }) => subscription.endpoint.startsWith(NTFY_ENDPOINT_PREFIX)) ? (await getClusterNode()).url : "";
  const deadEndpoints = /* @__PURE__ */ new Set();
  const delivered = await Promise.all(records.map(async ({ subscription, vapidDetails }) => {
    if (subscription.endpoint.startsWith(NTFY_ENDPOINT_PREFIX)) {
      try {
        return await sendNtfyNotification(subscription, notificationTitle, body, clusterUrl ? `${clusterUrl}${conversationUrl}` : "");
      } catch (error) {
        console.warn("ntfy publish failed", error);
        return false;
      }
    }
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
export {
  NTFY_ENDPOINT_PREFIX,
  deleteNtfySubscriptions,
  deletePushSubscription,
  getVapidPublicKey,
  listPushSubscriberUserIds,
  migratePushConversationSubscriptions,
  notifyConversationReview,
  ntfyConversationTargets,
  ntfySubscribedSessionPaths,
  ntfySubscription,
  pushSubscriptionEventsForPeer,
  receivePushSubscriptionEvents,
  recordPushSubscriptionFailure,
  recordPushSubscriptionReceipt,
  reviewNotificationBody,
  savePushSubscription
};
