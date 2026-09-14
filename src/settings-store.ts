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
let database: DatabaseSync | undefined;
let encryptionKey: Buffer | undefined;

export function settingsDatabase(): DatabaseSync {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
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
  const now = new Date().toISOString();
  seed.run("projects.homePath", defaultManagedHome(), now);
  ensureAuditSchema(database);
  return database;
}

function key(): Buffer {
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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    encryptionKey = randomBytes(32);
    writeFileSync(keyPath, encryptionKey.toString("base64"), { mode: 0o600 });
  }
  if (encryptionKey.length !== 32) throw new Error("Joint Bob secret key is invalid");
  return encryptionKey;
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${encrypted.toString("base64")}`;
}

export function decrypt(value: string): string {
  const [iv, tag, encrypted] = value.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Stored secret is invalid");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}

export function setting(keyName: string): { value: string; isSecret: boolean } | undefined {
  const row = settingsDatabase().prepare("SELECT value, is_secret FROM node_settings WHERE key = ?").get(keyName) as { value: string; is_secret: number } | undefined;
  if (!row) return undefined;
  return { value: row.value, isSecret: row.is_secret === 1 };
}

export function value(keyName: string, fallback = ""): string {
  const found = setting(keyName);
  if (!found) return fallback;
  return found.isSecret ? decrypt(found.value) : found.value;
}

export function save(db: DatabaseSync, keyName: string, settingValue: string, isSecret = false): void {
  db.prepare(`
    INSERT INTO node_settings (key, value, is_secret, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret, updated_at = excluded.updated_at
  `).run(keyName, isSecret ? encrypt(settingValue) : settingValue, isSecret ? 1 : 0, new Date().toISOString());
}
