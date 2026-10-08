import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureAuditSchema } from "./audit.js";
import { resolveDataDirectory } from "./data-directory.js";
import { defaultManagedHome } from "./managed-home.js";
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
const keyPath = path.join(dataDir, "secret.key");
let database;
let encryptionKey;
let settingQuery;
function settingsDatabase() {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 448 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS node_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      is_secret INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
  const seed = database.prepare("INSERT OR IGNORE INTO node_settings (key, value, is_secret, updated_at) VALUES (?, ?, 0, ?)");
  const now = (/* @__PURE__ */ new Date()).toISOString();
  seed.run("projects.homePath", defaultManagedHome(), now);
  ensureAuditSchema(database);
  return database;
}
function key() {
  if (encryptionKey) return encryptionKey;
  const configured = process.env.JOINT_BOB_SECRET_KEY ?? process.env.MASTER_BOB_SECRET_KEY;
  if (configured) {
    encryptionKey = Buffer.from(configured, "base64");
    if (encryptionKey.length !== 32) throw new Error("JOINT_BOB_SECRET_KEY must be a base64-encoded 32-byte key");
    return encryptionKey;
  }
  try {
    encryptionKey = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    encryptionKey = randomBytes(32);
    writeFileSync(keyPath, encryptionKey.toString("base64"), { mode: 384 });
  }
  if (encryptionKey.length !== 32) throw new Error("Joint Bob secret key is invalid");
  return encryptionKey;
}
function encrypt(value2) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(value2, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${encrypted.toString("base64")}`;
}
function decrypt(value2) {
  const [iv, tag, encrypted] = value2.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Stored secret is invalid");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}
function setting(keyName) {
  settingQuery ??= settingsDatabase().prepare("SELECT value, is_secret FROM node_settings WHERE key = ?");
  const row = settingQuery.get(keyName);
  if (!row) return void 0;
  return { value: row.value, isSecret: row.is_secret === 1 };
}
function value(keyName, fallback = "") {
  const found = setting(keyName);
  if (!found) return fallback;
  return found.isSecret ? decrypt(found.value) : found.value;
}
function save(db, keyName, settingValue, isSecret = false) {
  db.prepare(`
    INSERT INTO node_settings (key, value, is_secret, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret, updated_at = excluded.updated_at
  `).run(keyName, isSecret ? encrypt(settingValue) : settingValue, isSecret ? 1 : 0, (/* @__PURE__ */ new Date()).toISOString());
}
export {
  decrypt,
  save,
  setting,
  settingsDatabase,
  value
};
