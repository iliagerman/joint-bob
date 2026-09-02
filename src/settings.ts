import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { accessSync, constants as fsConstants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appendAuditEvent, ensureAuditSchema } from "./audit.js";
import { defaultManagedHome } from "./managed-home.js";

export interface RuntimeSettings {
  executable: string;
  configPath: string;
  sessionPath: string;
}

export interface SyncthingSettings {
  endpoint: string;
  apiKey?: string | null;
}

export interface SettingsInput {
  pi: RuntimeSettings;
  claude: RuntimeSettings;
  syncthing: SyncthingSettings;
  projects?: { homePath?: string; rootPath?: string; personalRootPath?: string; workRootPath?: string };
}

export interface SettingsResponse {
  pi: RuntimeSettings;
  claude: RuntimeSettings;
  syncthing: { endpoint: string; apiKeyConfigured: boolean };
  projects: { homePath: string };
  restartRequired: { pi: boolean; claude: boolean };
}

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
const keyPath = path.join(dataDir, "secret.key");
let database: DatabaseSync | undefined;
let encryptionKey: Buffer | undefined;

function settingsDatabase(): DatabaseSync {
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

function decrypt(value: string): string {
  const [iv, tag, encrypted] = value.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Stored secret is invalid");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}

function setting(keyName: string): { value: string; isSecret: boolean } | undefined {
  const row = settingsDatabase().prepare("SELECT value, is_secret FROM node_settings WHERE key = ?").get(keyName) as { value: string; is_secret: number } | undefined;
  if (!row) return undefined;
  return { value: row.value, isSecret: row.is_secret === 1 };
}

function value(keyName: string, fallback = ""): string {
  const found = setting(keyName);
  if (!found) return fallback;
  return found.isSecret ? decrypt(found.value) : found.value;
}

function save(db: DatabaseSync, keyName: string, settingValue: string, isSecret = false): void {
  db.prepare(`
    INSERT INTO node_settings (key, value, is_secret, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret, updated_at = excluded.updated_at
  `).run(keyName, isSecret ? encrypt(settingValue) : settingValue, isSecret ? 1 : 0, new Date().toISOString());
}

function loopbackEndpoint(endpoint: string): boolean {
  if (!endpoint) return true;
  try {
    const url = new URL(endpoint);
    return url.protocol === "http:" || url.protocol === "https:"
      ? ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
      : false;
  } catch {
    return false;
  }
}

function detectedExecutable(command: "pi" | "claude"): string {
  const configured = value(`${command}.executable`);
  if (configured) return configured;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch (error) {
      if (!["EACCES", "ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return command;
}

function runtime(prefix: "pi" | "claude"): RuntimeSettings {
  const configPath = prefix === "pi" ? path.join(os.homedir(), ".pi", "agent") : path.join(os.homedir(), ".claude");
  const sessionPath = prefix === "pi" ? path.join(configPath, "sessions") : path.join(configPath, "projects");
  return {
    executable: detectedExecutable(prefix),
    configPath: value(`${prefix}.configPath`) || configPath,
    sessionPath: value(`${prefix}.sessionPath`) || sessionPath,
  };
}

export function syncthingApiKey(): string | undefined {
  const configured = setting("syncthing.apiKey");
  return configured ? decrypt(configured.value) : undefined;
}

export function getSettings(): SettingsResponse {
  return {
    pi: runtime("pi"),
    claude: runtime("claude"),
    syncthing: {
      endpoint: value("syncthing.endpoint"),
      apiKeyConfigured: Boolean(setting("syncthing.apiKey")),
    },
    projects: { homePath: value("projects.homePath", defaultManagedHome()) },
    restartRequired: { pi: false, claude: false },
  };
}

function validateRuntimeSettings(label: "Pi" | "Claude", settings: RuntimeSettings): void {
  if (settings.configPath && !path.isAbsolute(settings.configPath)) throw new Error(`${label} config path must be blank or absolute`);
  if (settings.sessionPath && !path.isAbsolute(settings.sessionPath)) throw new Error(`${label} session path must be blank or absolute`);
  if (settings.executable && (settings.executable.includes("/") || settings.executable.includes("\\")) && !path.isAbsolute(settings.executable)) {
    throw new Error(`${label} executable must be a command name or absolute path`);
  }
}

export function updateSettings(input: SettingsInput, actorId?: string): SettingsResponse {
  if (!loopbackEndpoint(input.syncthing.endpoint)) throw new Error("Syncthing endpoint must use a loopback host");
  validateRuntimeSettings("Pi", input.pi);
  validateRuntimeSettings("Claude", input.claude);
  const db = settingsDatabase();
  const previous = getSettings();
  const homePath = input.projects?.homePath ?? previous.projects.homePath;
  if (!homePath.trim() || !path.isAbsolute(homePath)) throw new Error("Joint Bob home folder must be absolute");
  db.exec("BEGIN");
  try {
    for (const [prefix, settings] of [["pi", input.pi], ["claude", input.claude]] as const) {
      save(db, `${prefix}.executable`, settings.executable);
      save(db, `${prefix}.configPath`, settings.configPath);
      save(db, `${prefix}.sessionPath`, settings.sessionPath);
    }
    save(db, "syncthing.endpoint", input.syncthing.endpoint);
    save(db, "projects.homePath", path.resolve(homePath));
    if (input.syncthing.apiKey !== undefined) {
      if (input.syncthing.apiKey) save(db, "syncthing.apiKey", input.syncthing.apiKey, true);
      else db.prepare("DELETE FROM node_settings WHERE key = 'syncthing.apiKey'").run();
    }
    const settings = getSettings();
    appendAuditEvent(db, {
      eventType: "settings.updated",
      actorType: actorId ? "user" : "system",
      actorId,
      entityType: "settings",
      details: {
        piChanged: JSON.stringify(previous.pi) !== JSON.stringify(settings.pi),
        claudeChanged: JSON.stringify(previous.claude) !== JSON.stringify(settings.claude),
        syncthingChanged: previous.syncthing.endpoint !== settings.syncthing.endpoint || previous.syncthing.apiKeyConfigured !== settings.syncthing.apiKeyConfigured,
        projectHomeChanged: previous.projects.homePath !== settings.projects.homePath,
        apiKeyConfigured: settings.syncthing.apiKeyConfigured,
      },
    });
    db.exec("COMMIT");
    return {
      ...settings,
      restartRequired: {
        pi: previous.pi.configPath !== settings.pi.configPath,
        claude: previous.claude.executable !== settings.claude.executable || previous.claude.configPath !== settings.claude.configPath,
      },
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
