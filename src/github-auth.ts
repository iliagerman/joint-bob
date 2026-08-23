import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appendAuditEvent, ensureAuditSchema } from "./audit.js";
import { getClusterNode } from "./cluster.js";

/** A named credential group. `id` is stable so renaming `label` never breaks project assignments. */
export interface GitHubGroup { id: string; label: string; isDefault: boolean }

type ProjectGitHubAuth = { group: string | null; token?: string };
interface LegacyGitHubAuthStore { accounts: Record<string, string | undefined>; projects: Record<string, { account: string; token?: string }>; }
interface VersionRow { updated_at: string; origin_node_id: string; }
interface CredentialEventRow { event_id: string; entity_type: "account" | "project"; entity_key: string; operation: "upsert" | "delete"; payload_encrypted: string; updated_at: string; origin_node_id: string; created_at: string; }

/** Account upserts carry `{ label, token }`. A bare string is the pre-groups shape and is still accepted from older peers. */
export type GitHubCredentialEvent =
  | { id: string; entityType: "account"; key: string; operation: "upsert"; value: { label: string; token: string; isDefault?: boolean } | string; updatedAt: string; originNodeId: string; createdAt: string }
  | { id: string; entityType: "project"; key: string; operation: "upsert"; value: { account: string; token: string | null }; updatedAt: string; originNodeId: string; createdAt: string }
  | { id: string; entityType: "account" | "project"; key: string; operation: "delete"; updatedAt: string; originNodeId: string; createdAt: string };

export interface GitHubAuthStatus { groups: GitHubGroup[]; project?: { group: string | null; hasOverride: boolean; configured: boolean }; }

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
const legacyAuthPath = path.join(dataDir, "github-auth.json");
const configuredAuthPath = process.env.JOINT_BOB_GITHUB_AUTH_PATH ?? process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH;
const externalLegacyAuthPath = configuredAuthPath ?? legacyAuthPath;
const askPassPath = path.join(dataDir, "github-askpass.sh");
const keyPath = path.join(dataDir, "secret.key");
let database: DatabaseSync | undefined;
let legacyMigrationInitialized = false;

const emptyStore = (): LegacyGitHubAuthStore => ({ accounts: {}, projects: {} });
/** Ids the pre-groups build shipped. Kept so migration emits their tombstones and labels them on sight. */
const legacyAccounts = ["personal", "sela"];
const legacyAccountLabels: Record<string, string> = { personal: "Personal", sela: "Sela" };

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
  if (!iv || !tag || !encrypted) throw new Error("Stored GitHub credential is invalid");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}

/** Exactly one group is the default. Projects with no group of their own fall back to it. */
function ensureOneDefaultGroup(db: DatabaseSync): void {
  const current = db.prepare("SELECT account FROM github_accounts WHERE is_default = 1 ORDER BY account LIMIT 1").get() as { account: string } | undefined;
  const chosen = current ?? db.prepare("SELECT account FROM github_accounts ORDER BY account LIMIT 1").get() as { account: string } | undefined;
  if (!chosen) return;
  db.prepare("UPDATE github_accounts SET is_default = CASE WHEN account = ? THEN 1 ELSE 0 END").run(chosen.account);
}

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).some((entry) => entry.name === column);
}

function authDatabase(migrate = true): DatabaseSync {
  if (!database) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(`
      CREATE TABLE IF NOT EXISTS github_accounts (account TEXT PRIMARY KEY, token TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', is_default INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS github_project_auth (project_id TEXT PRIMARY KEY, account TEXT NOT NULL, token TEXT, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS github_auth_migrations (source TEXT PRIMARY KEY, migrated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS github_legacy_file_migrations (path TEXT PRIMARY KEY, digest TEXT NOT NULL, applied_digest TEXT, migrated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS github_account_tombstones (account TEXT PRIMARY KEY, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS github_project_auth_tombstones (project_id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS github_credential_events (event_id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_key TEXT NOT NULL, operation TEXT NOT NULL, payload_encrypted TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS github_credential_deliveries (event_id TEXT NOT NULL, peer_id TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT, PRIMARY KEY(event_id, peer_id));
      CREATE TABLE IF NOT EXISTS github_credential_inbox (event_id TEXT PRIMARY KEY, origin_node_id TEXT NOT NULL, received_at TEXT NOT NULL);
    `);
    if (!tableHasColumn(database, "github_accounts", "origin_node_id")) database.exec("ALTER TABLE github_accounts ADD COLUMN origin_node_id TEXT NOT NULL DEFAULT ''");
    if (!tableHasColumn(database, "github_accounts", "label")) database.exec("ALTER TABLE github_accounts ADD COLUMN label TEXT NOT NULL DEFAULT ''");
    // Groups that predate labels (either the old build or a peer still on it) get a readable one.
    for (const [account, label] of Object.entries(legacyAccountLabels)) database.prepare("UPDATE github_accounts SET label = ? WHERE account = ? AND label = ''").run(label, account);
    database.exec("UPDATE github_accounts SET label = account WHERE label = ''");
    if (!tableHasColumn(database, "github_accounts", "is_default")) database.exec("ALTER TABLE github_accounts ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0");
    ensureOneDefaultGroup(database);
    if (!tableHasColumn(database, "github_project_auth", "origin_node_id")) database.exec("ALTER TABLE github_project_auth ADD COLUMN origin_node_id TEXT NOT NULL DEFAULT ''");
    if (!tableHasColumn(database, "github_legacy_file_migrations", "applied_digest")) database.exec("ALTER TABLE github_legacy_file_migrations ADD COLUMN applied_digest TEXT");
    ensureAuditSchema(database);
  }
  if (migrate && !legacyMigrationInitialized) {
    migrateLegacyStore();
    legacyMigrationInitialized = true;
  }
  return database;
}

function parseStore(raw: string): LegacyGitHubAuthStore {
  const parsed = JSON.parse(raw) as Partial<LegacyGitHubAuthStore>;
  return { accounts: parsed.accounts ?? {}, projects: parsed.projects ?? {} };
}

function legacySources(): string[] {
  return [...new Set([externalLegacyAuthPath, legacyAuthPath])];
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

interface LegacySnapshot { source: string; digest: string; store: LegacyGitHubAuthStore; }
interface LegacyMigrationRow { digest: string; applied_digest: string | null; }

function applyLegacySnapshot(db: DatabaseSync, store: LegacyGitHubAuthStore): void {
  for (const account of new Set([...legacyAccounts, ...Object.keys(store.accounts)])) {
    const token = store.accounts[account];
    const updatedAt = nextVersion(db, "account", account, "");
    if (token) {
      db.prepare("INSERT INTO github_accounts (account, token, label, is_default, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?, '') ON CONFLICT(account) DO UPDATE SET token = excluded.token, label = excluded.label, updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id").run(account, encrypt(token), legacyAccountLabels[account] ?? account, account === "personal" ? 1 : 0, updatedAt);
      db.prepare("DELETE FROM github_account_tombstones WHERE account = ?").run(account);
    } else {
      db.prepare("DELETE FROM github_accounts WHERE account = ?").run(account);
      db.prepare("INSERT INTO github_account_tombstones (account, updated_at, origin_node_id) VALUES (?, ?, '') ON CONFLICT(account) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id").run(account, updatedAt);
    }
  }
  ensureOneDefaultGroup(db);
  const activeProjectIds = new Set((db.prepare("SELECT project_id FROM github_project_auth").all() as unknown as Array<{ project_id: string }>).map((row) => row.project_id));
  for (const [projectId, project] of Object.entries(store.projects)) {
    const updatedAt = nextVersion(db, "project", projectId, "");
    db.prepare("INSERT INTO github_project_auth (project_id, account, token, updated_at, origin_node_id) VALUES (?, ?, ?, ?, '') ON CONFLICT(project_id) DO UPDATE SET account = excluded.account, token = excluded.token, updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id")
      .run(projectId, project.account, project.token ? encrypt(project.token) : null, updatedAt);
    db.prepare("DELETE FROM github_project_auth_tombstones WHERE project_id = ?").run(projectId);
  }
  for (const projectId of activeProjectIds) {
    if (projectId in store.projects) continue;
    const updatedAt = nextVersion(db, "project", projectId, "");
    db.prepare("DELETE FROM github_project_auth WHERE project_id = ?").run(projectId);
    db.prepare("INSERT INTO github_project_auth_tombstones (project_id, updated_at, origin_node_id) VALUES (?, ?, '') ON CONFLICT(project_id) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id").run(projectId, updatedAt);
  }
}

function migrateLegacyStore(): void {
  const db = database!;
  const snapshots: LegacySnapshot[] = [];
  for (const source of legacySources()) {
    try {
      const raw = readFileSync(source, "utf8");
      snapshots.push({ source, digest: sha256(raw), store: parseStore(raw) });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const configured = configuredAuthPath ? snapshots.find(({ source }) => source === configuredAuthPath) : undefined;
  const authoritative = configured ?? snapshots.find(({ source }) => source === legacyAuthPath);
  const marker = db.prepare("SELECT source FROM github_auth_migrations WHERE source = 'json'").get();
  const migrations = new Map(snapshots.map((snapshot) => [snapshot.source, db.prepare("SELECT digest, applied_digest FROM github_legacy_file_migrations WHERE path = ?").get(snapshot.source) as LegacyMigrationRow | undefined]));
  const cleanupCurrent = snapshots.every((snapshot) => migrations.get(snapshot.source)?.digest === snapshot.digest);
  const appliedCurrent = !authoritative || migrations.get(authoritative.source)?.applied_digest === authoritative.digest;
  if (marker && cleanupCurrent && appliedCurrent) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const now = new Date().toISOString();
    if (authoritative && !appliedCurrent) applyLegacySnapshot(db, authoritative.store);
    for (const snapshot of snapshots) {
      db.prepare("INSERT INTO github_legacy_file_migrations (path, digest, migrated_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET digest = excluded.digest, migrated_at = excluded.migrated_at").run(snapshot.source, snapshot.digest, now);
    }
    if (authoritative && !appliedCurrent) {
      db.prepare("UPDATE github_legacy_file_migrations SET applied_digest = ? WHERE path = ?").run(authoritative.digest, authoritative.source);
    }
    db.prepare("INSERT OR IGNORE INTO github_auth_migrations (source, migrated_at) VALUES ('json', ?)").run(now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function ensureGitHubCredentialMigration(): void {
  authDatabase(true);
}

export function cleanupLegacyGitHubCredentialFiles(): void {
  const db = authDatabase(false);
  if (!db.prepare("SELECT source FROM github_auth_migrations WHERE source = 'json'").get()) {
    throw new Error("GitHub credential migration is not complete");
  }
  const existingSources: string[] = [];
  for (const source of legacySources()) {
    try {
      const raw = readFileSync(source, "utf8");
      const migration = db.prepare("SELECT digest FROM github_legacy_file_migrations WHERE path = ?").get(source) as { digest: string } | undefined;
      if (!migration || migration.digest !== sha256(raw)) throw new Error("Legacy GitHub credential file changed after migration");
      existingSources.push(source);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const source of existingSources) {
    try { unlinkSync(source); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function ensureLocalFiles(): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(askPassPath, '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "x-access-token" ;;\n  *) printf "%s\\n" "$PI_GITHUB_TOKEN" ;;\nesac\n', { mode: 0o700 });
}

function assertGroupId(value: string): void { if (!value.trim() || value.length > 64 || /\s/.test(value)) throw new Error("GitHub group ID must be 1-64 characters with no spaces"); }
function assertGroupLabel(value: string): void { if (!value.trim() || value.length > 64) throw new Error("GitHub group name must be between 1 and 64 characters"); }
function assertToken(value: string): void { if (value.length < 1 || value.length > 5000) throw new Error("GitHub token must be between 1 and 5000 characters"); }
function assertProjectKey(value: string): void { if (!value.trim()) throw new Error("Project ID is required"); }
function compareVersion(left: VersionRow, right: VersionRow): number { return left.updated_at === right.updated_at ? left.origin_node_id.localeCompare(right.origin_node_id) : left.updated_at.localeCompare(right.updated_at); }
function nextVersion(db: DatabaseSync, entityType: "account" | "project", key: string, originNodeId: string): string {
  const [active, tombstone] = entityType === "account" ? ["github_accounts", "github_account_tombstones"] : ["github_project_auth", "github_project_auth_tombstones"];
  const keyColumn = entityType === "account" ? "account" : "project_id";
  const current = db.prepare(`SELECT updated_at, origin_node_id FROM ${active} WHERE ${keyColumn} = ? UNION ALL SELECT updated_at, origin_node_id FROM ${tombstone} WHERE ${keyColumn} = ? ORDER BY updated_at DESC, origin_node_id DESC LIMIT 1`).get(key, key) as VersionRow | undefined;
  const now = new Date();
  if (!current || now.getTime() > Date.parse(current.updated_at)) return now.toISOString();
  return new Date(Date.parse(current.updated_at) + 1).toISOString();
}
function resolveProjectAlias(db: DatabaseSync, projectId: string): string {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_aliases'").get();
  if (!exists) return projectId;
  return (db.prepare("SELECT project_id FROM project_aliases WHERE alias_id = ?").get(projectId) as { project_id: string } | undefined)?.project_id ?? projectId;
}

function insertCredentialEvent(db: DatabaseSync, event: GitHubCredentialEvent): void {
  const value = event.operation === "delete" ? null : event.value;
  db.prepare("INSERT OR IGNORE INTO github_credential_events (event_id, entity_type, entity_key, operation, payload_encrypted, updated_at, origin_node_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(event.id, event.entityType, event.key, event.operation, encrypt(JSON.stringify(value)), event.updatedAt, event.originNodeId, event.createdAt);
}

type CredentialEventInput =
  | { entityType: "account"; key: string; operation: "upsert"; value: { label: string; token: string; isDefault?: boolean }; updatedAt: string; originNodeId: string }
  | { entityType: "project"; key: string; operation: "upsert"; value: { account: string; token: string | null }; updatedAt: string; originNodeId: string }
  | { entityType: "account" | "project"; key: string; operation: "delete"; updatedAt: string; originNodeId: string };

function enqueueCredentialEvent(db: DatabaseSync, event: CredentialEventInput): GitHubCredentialEvent {
  const queued = { ...event, id: randomUUID(), createdAt: new Date().toISOString() } as GitHubCredentialEvent;
  insertCredentialEvent(db, queued);
  return queued;
}

function groupToken(groupId: string | null): string | undefined {
  if (!groupId) return undefined;
  const row = authDatabase().prepare("SELECT token FROM github_accounts WHERE account = ?").get(groupId) as { token: string } | undefined;
  return row ? decrypt(row.token) : undefined;
}
function projectAuth(projectId: string): ProjectGitHubAuth {
  const db = authDatabase();
  const row = db.prepare("SELECT account, token FROM github_project_auth WHERE project_id = ?").get(resolveProjectAlias(db, projectId)) as { account: string; token: string | null } | undefined;
  return row ? { group: row.account || null, ...(row.token ? { token: decrypt(row.token) } : {}) } : { group: null };
}

export async function listGitHubGroups(): Promise<GitHubGroup[]> {
  const rows = authDatabase().prepare("SELECT account, label, is_default FROM github_accounts ORDER BY label COLLATE NOCASE").all() as unknown as Array<{ account: string; label: string; is_default: number }>;
  return rows.map((row) => ({ id: row.account, label: row.label || row.account, isDefault: Boolean(row.is_default) }));
}

function defaultGroupId(): string | null {
  const row = authDatabase().prepare("SELECT account FROM github_accounts WHERE is_default = 1 LIMIT 1").get() as { account: string } | undefined;
  return row?.account ?? null;
}

export async function getGitHubAuthStatus(projectId?: string): Promise<GitHubAuthStatus> {
  const status: GitHubAuthStatus = { groups: await listGitHubGroups() };
  if (projectId) {
    const project = projectAuth(projectId);
    status.project = { group: project.group, hasOverride: Boolean(project.token), configured: Boolean(project.token || groupToken(project.group ?? defaultGroupId())) };
  }
  return status;
}

/** Turns a label into a URL-safe id, uniquified against groups that already exist. */
function groupIdFromLabel(db: DatabaseSync, label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "group";
  let candidate = base;
  for (let suffix = 2; db.prepare("SELECT 1 FROM github_accounts WHERE account = ?").get(candidate); suffix += 1) candidate = `${base}-${suffix}`;
  return candidate;
}

/** Creates a group (no `id`) or updates one in place. Omitting `token` on an update keeps the stored token. */
export async function saveGitHubGroup(input: { id?: string; label: string; token?: string; isDefault?: boolean }, actorId?: string): Promise<GitHubGroup> {
  assertGroupLabel(input.label);
  if (input.id !== undefined) assertGroupId(input.id);
  if (input.token !== undefined) assertToken(input.token);
  const node = await getClusterNode();
  const db = authDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = input.id ? db.prepare("SELECT token FROM github_accounts WHERE account = ?").get(input.id) as { token: string } | undefined : undefined;
    if (input.id && !existing && input.token === undefined) throw new Error("GitHub group not found");
    if (!input.id && input.token === undefined) throw new Error("A new GitHub group needs a token");
    const id = input.id ?? groupIdFromLabel(db, input.label);
    const label = input.label.trim();
    const token = input.token ?? decrypt(existing!.token);
    const updatedAt = nextVersion(db, "account", id, node.id);
    const firstGroup = !db.prepare("SELECT 1 FROM github_accounts LIMIT 1").get();
    const isDefault = input.isDefault ?? (firstGroup || Boolean(db.prepare("SELECT 1 FROM github_accounts WHERE account = ? AND is_default = 1").get(id)));
    db.prepare("INSERT INTO github_accounts (account, token, label, is_default, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account) DO UPDATE SET token = excluded.token, label = excluded.label, is_default = excluded.is_default, updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id")
      .run(id, encrypt(token), label, isDefault ? 1 : 0, updatedAt, node.id);
    if (isDefault) db.prepare("UPDATE github_accounts SET is_default = 0 WHERE account <> ?").run(id);
    db.prepare("DELETE FROM github_account_tombstones WHERE account = ?").run(id);
    enqueueCredentialEvent(db, { entityType: "account", key: id, operation: "upsert", value: { label, token, isDefault }, updatedAt, originNodeId: node.id });
    appendAuditEvent(db, { eventType: "github.group.saved", actorType: actorId ? "user" : "system", actorId, entityType: "github.group", entityId: id, details: { label, created: !existing, isDefault } });
    db.exec("COMMIT");
    return { id, label, isDefault };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** Deletes a group. Projects that used it are left with no group and lose GitHub access until reassigned. */
export async function deleteGitHubGroup(groupId: string, actorId?: string): Promise<void> {
  assertGroupId(groupId);
  const node = await getClusterNode();
  const db = authDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const updatedAt = nextVersion(db, "account", groupId, node.id);
    db.prepare("DELETE FROM github_accounts WHERE account = ?").run(groupId);
    db.prepare("INSERT INTO github_account_tombstones (account, updated_at, origin_node_id) VALUES (?, ?, ?) ON CONFLICT(account) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id").run(groupId, updatedAt, node.id);
    enqueueCredentialEvent(db, { entityType: "account", key: groupId, operation: "delete", updatedAt, originNodeId: node.id });
    const orphaned = db.prepare("SELECT project_id, token FROM github_project_auth WHERE account = ?").all(groupId) as unknown as Array<{ project_id: string; token: string | null }>;
    for (const row of orphaned) {
      const projectUpdatedAt = nextVersion(db, "project", row.project_id, node.id);
      db.prepare("UPDATE github_project_auth SET account = '', updated_at = ?, origin_node_id = ? WHERE project_id = ?").run(projectUpdatedAt, node.id, row.project_id);
      enqueueCredentialEvent(db, { entityType: "project", key: row.project_id, operation: "upsert", value: { account: "", token: row.token ? decrypt(row.token) : null }, updatedAt: projectUpdatedAt, originNodeId: node.id });
    }
    ensureOneDefaultGroup(db);
    appendAuditEvent(db, { eventType: "github.group.deleted", actorType: actorId ? "user" : "system", actorId, entityType: "github.group", entityId: groupId, details: { orphanedProjects: orphaned.length } });
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function updateProjectGitHubAuth(projectId: string, group: string | null, token?: string | null, actorId?: string): Promise<void> {
  assertProjectKey(projectId);
  if (group !== null) assertGroupId(group);
  if (token !== undefined && token !== null && token !== "") assertToken(token);
  const account = group ?? "";
  const node = await getClusterNode();
  const db = authDatabase();
  const key = resolveProjectAlias(db, projectId);
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT token FROM github_project_auth WHERE project_id = ?").get(key) as { token: string | null } | undefined;
    const resolved = token === undefined ? (existing?.token ? decrypt(existing.token) : undefined) : token || undefined;
    const updatedAt = nextVersion(db, "project", key, node.id);
    db.prepare("INSERT INTO github_project_auth (project_id, account, token, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET account = excluded.account, token = excluded.token, updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id")
      .run(key, account, resolved ? encrypt(resolved) : null, updatedAt, node.id);
    db.prepare("DELETE FROM github_project_auth_tombstones WHERE project_id = ?").run(key);
    enqueueCredentialEvent(db, { entityType: "project", key, operation: "upsert", value: { account, token: resolved ?? null }, updatedAt, originNodeId: node.id });
    const accountConfigured = Boolean(db.prepare("SELECT account FROM github_accounts WHERE account = ?").get(account));
    appendAuditEvent(db, { eventType: "github.project.updated", actorType: actorId ? "user" : "system", actorId, entityType: "github.project", entityId: key, details: { account, configured: Boolean(resolved || accountConfigured) } });
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function removeProjectGitHubAuth(projectId: string, actorId?: string): Promise<void> {
  assertProjectKey(projectId);
  const node = await getClusterNode();
  const db = authDatabase();
  const key = resolveProjectAlias(db, projectId);
  db.exec("BEGIN IMMEDIATE");
  try {
    const updatedAt = nextVersion(db, "project", key, node.id);
    db.prepare("DELETE FROM github_project_auth WHERE project_id = ?").run(key);
    db.prepare("INSERT INTO github_project_auth_tombstones (project_id, updated_at, origin_node_id) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id").run(key, updatedAt, node.id);
    enqueueCredentialEvent(db, { entityType: "project", key, operation: "delete", updatedAt, originNodeId: node.id });
    appendAuditEvent(db, { eventType: "github.project.updated", actorType: actorId ? "user" : "system", actorId, entityType: "github.project", entityId: key, details: { configured: false } });
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function eventFromRow(row: CredentialEventRow): GitHubCredentialEvent {
  const value = JSON.parse(decrypt(row.payload_encrypted)) as unknown;
  const common = { id: row.event_id, entityType: row.entity_type, key: row.entity_key, operation: row.operation, updatedAt: row.updated_at, originNodeId: row.origin_node_id, createdAt: row.created_at };
  if (row.operation === "delete") return common as GitHubCredentialEvent;
  return { ...common, value } as GitHubCredentialEvent;
}

/** Older peers send an account value as a bare token string; normalise both shapes to `{ label, token }`. */
function accountEventValue(key: string, value: { label: string; token: string; isDefault?: boolean } | string): { label: string; token: string; isDefault?: boolean } {
  return typeof value === "string" ? { label: legacyAccountLabels[key] ?? key, token: value } : value;
}

function validateEvent(event: GitHubCredentialEvent): void {
  if (!event.key.trim() || event.key.length > 64 || (event.entityType === "account" && /\s/.test(event.key))) throw new Error("Malformed GitHub credential event key");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(event.id) || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(event.originNodeId) || Number.isNaN(Date.parse(event.updatedAt)) || Number.isNaN(Date.parse(event.createdAt))) throw new Error("Malformed GitHub credential event metadata");
  if (event.operation === "delete") { if ("value" in event) throw new Error("Delete GitHub credential event cannot contain a value"); return; }
  if (!("value" in event)) throw new Error("Upsert GitHub credential event requires a value");
  if (event.entityType === "account") {
    const value = typeof event.value === "string" ? { label: event.key, token: event.value } : event.value;
    if (!value || typeof value !== "object" || typeof value.label !== "string" || typeof value.token !== "string") throw new Error("Malformed account credential event");
    assertGroupLabel(value.label);
    assertToken(value.token);
    return;
  }
  if (!event.value || typeof event.value !== "object" || typeof event.value.account !== "string" || event.value.account.length > 64 || !(event.value.token === null || typeof event.value.token === "string")) throw new Error("Malformed project credential event");
  if (typeof event.value.token === "string") assertToken(event.value.token);
}

function backfillLegacyEvents(db: DatabaseSync, nodeId: string): void {
  const accountRows = db.prepare("SELECT account, token, label, is_default, updated_at FROM github_accounts WHERE origin_node_id = ''").all() as unknown as Array<{ account: string; token: string; label: string; is_default: number; updated_at: string }>;
  for (const row of accountRows) {
    db.prepare("UPDATE github_accounts SET origin_node_id = ? WHERE account = ?").run(nodeId, row.account);
    enqueueCredentialEvent(db, { entityType: "account", key: row.account, operation: "upsert", value: { label: row.label || row.account, token: decrypt(row.token), isDefault: Boolean(row.is_default) }, updatedAt: row.updated_at, originNodeId: nodeId });
  }
  const accountTombstones = db.prepare("SELECT account, updated_at FROM github_account_tombstones WHERE origin_node_id = ''").all() as unknown as Array<{ account: string; updated_at: string }>;
  for (const row of accountTombstones) {
    db.prepare("UPDATE github_account_tombstones SET origin_node_id = ? WHERE account = ?").run(nodeId, row.account);
    enqueueCredentialEvent(db, { entityType: "account", key: row.account, operation: "delete", updatedAt: row.updated_at, originNodeId: nodeId });
  }
  const projectRows = db.prepare("SELECT project_id, account, token, updated_at FROM github_project_auth WHERE origin_node_id = ''").all() as unknown as Array<{ project_id: string; account: string; token: string | null; updated_at: string }>;
  for (const row of projectRows) {
    const key = row.project_id;
    db.prepare("UPDATE github_project_auth SET origin_node_id = ? WHERE project_id = ?").run(nodeId, key);
    enqueueCredentialEvent(db, { entityType: "project", key, operation: "upsert", value: { account: row.account, token: row.token ? decrypt(row.token) : null }, updatedAt: row.updated_at, originNodeId: nodeId });
  }
  const projectTombstones = db.prepare("SELECT project_id, updated_at FROM github_project_auth_tombstones WHERE origin_node_id = ''").all() as unknown as Array<{ project_id: string; updated_at: string }>;
  for (const row of projectTombstones) {
    db.prepare("UPDATE github_project_auth_tombstones SET origin_node_id = ? WHERE project_id = ?").run(nodeId, row.project_id);
    enqueueCredentialEvent(db, { entityType: "project", key: row.project_id, operation: "delete", updatedAt: row.updated_at, originNodeId: nodeId });
  }
}

export async function githubCredentialEventsForPeer(peerId: string, now = new Date()): Promise<GitHubCredentialEvent[]> {
  const local = await getClusterNode();
  const db = authDatabase();
  const at = now.toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    backfillLegacyEvents(db, local.id);
    db.prepare("INSERT OR IGNORE INTO github_credential_deliveries (event_id, peer_id, attempts, next_attempt_at, delivered_at, last_error) SELECT event_id, ?, 0, ?, NULL, NULL FROM github_credential_events").run(peerId, at);
    const rows = db.prepare("SELECT e.event_id, e.entity_type, e.entity_key, e.operation, e.payload_encrypted, e.updated_at, e.origin_node_id, e.created_at FROM github_credential_events e JOIN github_credential_deliveries d ON d.event_id = e.event_id WHERE d.peer_id = ? AND d.delivered_at IS NULL AND d.next_attempt_at <= ? ORDER BY e.created_at, e.event_id LIMIT 100").all(peerId, at) as unknown as CredentialEventRow[];
    const events = rows.map(eventFromRow);
    db.exec("COMMIT");
    return events;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function receiveGitHubCredentialEvents(events: GitHubCredentialEvent[]): Promise<string[]> {
  for (const event of events) validateEvent(event);
  const db = authDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const received: string[] = [];
    const inbox = db.prepare("INSERT OR IGNORE INTO github_credential_inbox (event_id, origin_node_id, received_at) VALUES (?, ?, ?)");
    for (const incoming of events) {
      if (!inbox.run(incoming.id, incoming.originNodeId, new Date().toISOString()).changes) { received.push(incoming.id); continue; }
      const event = incoming.entityType === "project" ? { ...incoming, key: resolveProjectAlias(db, incoming.key) } as GitHubCredentialEvent : incoming;
      const [active, tombstone, keyColumn] = event.entityType === "account" ? ["github_accounts", "github_account_tombstones", "account"] : ["github_project_auth", "github_project_auth_tombstones", "project_id"];
      const current = db.prepare(`SELECT updated_at, origin_node_id FROM ${active} WHERE ${keyColumn} = ? UNION ALL SELECT updated_at, origin_node_id FROM ${tombstone} WHERE ${keyColumn} = ? ORDER BY updated_at DESC, origin_node_id DESC LIMIT 1`).get(event.key, event.key) as VersionRow | undefined;
      if (!current || compareVersion({ updated_at: event.updatedAt, origin_node_id: event.originNodeId }, current) > 0) {
        if (event.operation === "delete") {
          db.prepare(`DELETE FROM ${active} WHERE ${keyColumn} = ?`).run(event.key);
          db.prepare(`INSERT INTO ${tombstone} (${keyColumn}, updated_at, origin_node_id) VALUES (?, ?, ?) ON CONFLICT(${keyColumn}) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id`).run(event.key, event.updatedAt, event.originNodeId);
        } else if (event.entityType === "account") {
          const value = accountEventValue(event.key, event.value);
          db.prepare("INSERT INTO github_accounts (account, token, label, is_default, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account) DO UPDATE SET token = excluded.token, label = excluded.label, is_default = excluded.is_default, updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id").run(event.key, encrypt(value.token), value.label, value.isDefault ? 1 : 0, event.updatedAt, event.originNodeId);
          db.prepare("DELETE FROM github_account_tombstones WHERE account = ?").run(event.key);
          if (value.isDefault) db.prepare("UPDATE github_accounts SET is_default = 0 WHERE account <> ?").run(event.key);
        } else {
          db.prepare("INSERT INTO github_project_auth (project_id, account, token, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET account = excluded.account, token = excluded.token, updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id").run(event.key, event.value.account, event.value.token ? encrypt(event.value.token) : null, event.updatedAt, event.originNodeId);
          db.prepare("DELETE FROM github_project_auth_tombstones WHERE project_id = ?").run(event.key);
        }
      }
      insertCredentialEvent(db, event);
      received.push(incoming.id);
    }
    ensureOneDefaultGroup(db);
    db.exec("COMMIT");
    return received;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function recordGitHubCredentialReceipt(peerId: string, eventIds: string[]): Promise<void> {
  if (!eventIds.length) return;
  const db = authDatabase();
  db.exec("BEGIN IMMEDIATE");
  try { const update = db.prepare("UPDATE github_credential_deliveries SET delivered_at = COALESCE(delivered_at, ?), last_error = NULL WHERE peer_id = ? AND event_id = ?"); for (const id of eventIds) update.run(new Date().toISOString(), peerId, id); db.exec("COMMIT"); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function recordGitHubCredentialFailure(peerId: string, eventIds: string[], message: string, now = new Date()): Promise<void> {
  if (!eventIds.length) return;
  const db = authDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT attempts FROM github_credential_deliveries WHERE peer_id = ? AND event_id = ? AND delivered_at IS NULL");
    const update = db.prepare("UPDATE github_credential_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE peer_id = ? AND event_id = ? AND delivered_at IS NULL");
    for (const id of eventIds) { const row = current.get(peerId, id) as { attempts: number } | undefined; if (!row) continue; const attempts = row.attempts + 1; update.run(attempts, new Date(now.getTime() + Math.min(300, 2 ** Math.min(attempts, 8)) * 1000).toISOString(), message, peerId, id); }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function gitHubEnvironment(projectId: string): NodeJS.ProcessEnv {
  ensureLocalFiles();
  const project = projectAuth(projectId);
  const token = project.token || groupToken(project.group ?? defaultGroupId());
  if (!token) return {};
  return { GH_TOKEN: token, GITHUB_TOKEN: token, PI_GITHUB_TOKEN: token, GIT_ASKPASS: askPassPath, GIT_TERMINAL_PROMPT: "0" };
}
