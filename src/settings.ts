import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { accessSync, constants as fsConstants, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

export const RESOURCE_TYPES = ["skills", "prompts", "rules", "plugins"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];
export interface ResourcePaths { skills: string[]; prompts: string[]; rules: string[]; plugins: string[]; }
export interface ScopedResourcePaths { global: ResourcePaths; project: ResourcePaths; }

export interface SettingsInput {
  pi: RuntimeSettings;
  claude: RuntimeSettings;
  syncthing: SyncthingSettings;
  projects?: { homePath?: string; rootPath?: string; personalRootPath?: string; workRootPath?: string };
  resources?: ResourcePaths;
}

export interface SettingsResponse {
  pi: RuntimeSettings;
  claude: RuntimeSettings;
  syncthing: { endpoint: string; apiKeyConfigured: boolean };
  projects: { homePath: string };
  resources: ResourcePaths;
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

function detectedExecutable(command: string): string {
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

function runtimeDefaults(prefix: "pi" | "claude"): RuntimeSettings {
  const configPath = prefix === "pi" ? path.join(os.homedir(), ".pi", "agent") : path.join(os.homedir(), ".claude");
  return { executable: detectedExecutable(prefix), configPath, sessionPath: path.join(configPath, prefix === "pi" ? "sessions" : "projects") };
}

export function getRuntimeDefaults(): { pi: RuntimeSettings; claude: RuntimeSettings } {
  return { pi: runtimeDefaults("pi"), claude: runtimeDefaults("claude") };
}

function runtime(prefix: "pi" | "claude"): RuntimeSettings {
  const defaults = runtimeDefaults(prefix);
  return {
    executable: value(`${prefix}.executable`) || defaults.executable,
    configPath: value(`${prefix}.configPath`) || defaults.configPath,
    sessionPath: value(`${prefix}.sessionPath`) || defaults.sessionPath,
  };
}

export function syncthingApiKey(): string | undefined {
  const configured = setting("syncthing.apiKey");
  return configured ? decrypt(configured.value) : undefined;
}

function emptyResourcePaths(): ResourcePaths {
  return { skills: [], prompts: [], rules: [], plugins: [] };
}

function readResourcePaths(prefix: string): ResourcePaths {
  const result = emptyResourcePaths();
  for (const type of RESOURCE_TYPES) {
    const stored = setting(`${prefix}${type}`);
    if (!stored) continue;
    const parsed: unknown = JSON.parse(stored.value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error(`Stored ${type} resource paths are invalid`);
    result[type] = parsed;
  }
  return normalizeResourcePaths(result);
}

function normalizeResourcePaths(input: ResourcePaths): ResourcePaths {
  const result = emptyResourcePaths();
  for (const type of RESOURCE_TYPES) {
    if (!Array.isArray(input[type]) || input[type].length > 20) throw new Error(`${type} resource paths must contain at most 20 entries`);
    for (const entry of input[type]) {
      if (typeof entry !== "string" || entry.length > 1000 || !path.isAbsolute(entry)) throw new Error("Resource paths must be absolute and at most 1000 characters");
      const resolved = path.resolve(entry);
      if (!result[type].includes(resolved)) result[type].push(resolved);
    }
  }
  return result;
}

export function getProjectResourcePaths(projectId: string): ResourcePaths {
  return readResourcePaths(`projects.${projectId}.resources.`);
}

export function getScopedResourcePaths(projectId?: string): ScopedResourcePaths {
  return { global: getSettings().resources, project: projectId ? getProjectResourcePaths(projectId) : emptyResourcePaths() };
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
    resources: readResourcePaths("resources."),
    restartRequired: { pi: false, claude: false },
  };
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isTemporaryPath(candidate: string): boolean {
  const roots = [os.tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp", "/private/tmp"])];
  return roots.some((root) => isInside(root, candidate));
}

function validateRuntimePath(label: "Pi" | "Claude", field: "config" | "session", input: string, defaultPath: string): void {
  if (!input) return;
  if (!path.isAbsolute(input)) throw new Error(`${label} ${field} path must be blank or absolute`);
  const resolved = path.resolve(input);
  if (resolved !== path.resolve(defaultPath) && isTemporaryPath(resolved) && !isTemporaryPath(dataDir)) throw new Error(`${label} ${field} path must not be under the OS temporary directory`);
  if (/^\/(Users|home)\/[^/]+(?:\/|$)/.test(resolved) && !isInside(os.homedir(), resolved)) throw new Error(`${label} ${field} path must be under the current home directory`);
}

function validateRuntimeSettings(label: "Pi" | "Claude", settings: RuntimeSettings): void {
  const defaults = runtimeDefaults(label === "Pi" ? "pi" : "claude");
  validateRuntimePath(label, "config", settings.configPath, defaults.configPath);
  validateRuntimePath(label, "session", settings.sessionPath, defaults.sessionPath);
  if (settings.executable && (settings.executable.includes("/") || settings.executable.includes("\\")) && !path.isAbsolute(settings.executable)) throw new Error(`${label} executable must be a command name or absolute path`);
}

function validateSessionRoots(pi: RuntimeSettings, claude: RuntimeSettings): void {
  if (pi.sessionPath && claude.sessionPath && (isInside(pi.sessionPath, claude.sessionPath) || isInside(claude.sessionPath, pi.sessionPath))) throw new Error("Pi and Claude session paths must not overlap");
}

export interface RuntimeReadiness { executable: RuntimeFieldReadiness; configPath: RuntimeFieldReadiness; sessionPath: RuntimeFieldReadiness; }
export interface RuntimeFieldReadiness { ok: boolean; message: string; }

function unavailable(error: unknown): boolean { return ["EACCES", "ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""); }

function checkDirectory(value: string, writable: boolean): RuntimeFieldReadiness {
  if (!value) return { ok: true, message: "Blank (uses node default)" };
  try {
    if (!statSync(value).isDirectory()) return { ok: false, message: "Path is not a directory" };
    accessSync(value, fsConstants.R_OK | (writable ? fsConstants.W_OK : 0));
    return { ok: true, message: "Ready" };
  } catch (error) {
    if (unavailable(error)) return { ok: false, message: "Directory is unavailable" };
    throw error;
  }
}

function checkExecutable(value: string): RuntimeFieldReadiness {
  if (!value) return { ok: true, message: "Blank (uses node default)" };
  const executable = path.isAbsolute(value) ? value : detectedExecutable(value);
  try { accessSync(executable, fsConstants.X_OK); return { ok: true, message: "Ready" }; } catch (error) {
    if (unavailable(error)) return { ok: false, message: "Executable is unavailable" };
    throw error;
  }
}

function checkRuntime(settings: RuntimeSettings): RuntimeReadiness {
  return { executable: checkExecutable(settings.executable), configPath: checkDirectory(settings.configPath, false), sessionPath: checkDirectory(settings.sessionPath, true) };
}

export function checkRuntimeSettings(input: { pi: RuntimeSettings; claude: RuntimeSettings }): { pi: RuntimeReadiness; claude: RuntimeReadiness } {
  return { pi: checkRuntime(input.pi), claude: checkRuntime(input.claude) };
}

export function updateSettings(input: SettingsInput, actorId?: string): SettingsResponse {
  if (!loopbackEndpoint(input.syncthing.endpoint)) throw new Error("Syncthing endpoint must use a loopback host");
  validateRuntimeSettings("Pi", input.pi);
  validateRuntimeSettings("Claude", input.claude);
  validateSessionRoots(input.pi, input.claude);
  const db = settingsDatabase();
  const previous = getSettings();
  const homePath = input.projects?.homePath ?? previous.projects.homePath;
  const resources = input.resources ? normalizeResourcePaths(input.resources) : previous.resources;
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
    for (const type of RESOURCE_TYPES) save(db, `resources.${type}`, JSON.stringify(resources[type]));
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
        resourcesChanged: JSON.stringify(previous.resources) !== JSON.stringify(settings.resources),
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

export function updateProjectResourcePaths(projectId: string, input: ResourcePaths, actorId?: string): ResourcePaths {
  const resources = normalizeResourcePaths(input);
  const db = settingsDatabase();
  db.exec("BEGIN");
  try {
    for (const type of RESOURCE_TYPES) save(db, `projects.${projectId}.resources.${type}`, JSON.stringify(resources[type]));
    appendAuditEvent(db, { eventType: "settings.updated", actorType: actorId ? "user" : "system", actorId, entityType: "project", entityId: projectId, details: { resourcesChanged: true } });
    db.exec("COMMIT");
    return resources;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
