import { ACCOUNT_KEY_COLUMNS } from "./account-keys.js";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { mkdirSync } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";
import { appendAuditEvent, ensureAuditSchema } from "./audit.js";
import { decryptSecretValue, encryptSecretValue } from "./secrets.js";
import { generateTotpSecret, verifyTotp } from "./totp.js";
import { accountIdFor, canonicalLocalHome, normalizeEmail, validEmail, type AccountRole } from "./accounts.js";
import { save, settingsDatabase } from "./settings-store.js";

export class AuthError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}

export interface MfaLoginChallenge { mfaRequired: true; challenge: string; mfaSetupRequired?: boolean; remoteMfa?: boolean; offlineMfa?: boolean }
export interface MfaStatus { enabled: boolean; recoveryCodesRemaining: number }

// Already-open sockets must lose access when MFA changes revoke their login session.
export const authSessionEvents = new EventEmitter();

export interface AuthStatus {
  authenticated: boolean;
  setupRequired: boolean;
  mustChangePassword?: boolean;
  csrfToken?: string;
  username?: string;
  email?: string | null;
  accountId?: string;
  role?: AccountRole | null;
  /** Signed in, but this account has no email yet: the client asks for one. */
  needsEmail?: boolean;
  /** True when the user is logged into a node that is not their home node. */
  isRemoteLogin?: boolean;
}

export interface AuthSession {
  id: string;
  userId: string;
  username: string;
  /** Cluster-stable identity of the person; empty only before the node has an identity. */
  accountId: string;
  email: string | null;
  /** Local accounts are admin or member; replicated accounts have no role here. */
  role: AccountRole | null;
  csrfToken: string;
  mustChangePassword: boolean;
  /** True when the user is logged into a node that is not their home node. */
  isRemoteLogin: boolean;
  /** The node ID where this user account originates. Null for the home user. */
  homeNodeId: string | null;
  /** A request another node relays for this person (live-link.ts): never the admin's powers. */
  live?: boolean;
}

export interface LoginSessionSummary {
  id: string;
  createdAt: string;
  expiresAt: string;
}

interface UserRow {
  id: string;
  username: string;
  password_hash: Buffer;
  password_salt: Buffer;
  must_change_password: number;
  home_node_id: string | null;
  email: string | null;
  role: AccountRole | null;
  remote_mfa: number;
  account_id: string | null;
  disabled: number;
}

interface SessionRow {
  id: string;
  user_id: string;
  username: string;
  csrf_token: string;
  must_change_password: number;
  is_remote_login: number;
  home_node_id: string | null;
  email: string | null;
  role: AccountRole | null;
  account_id: string | null;
}

const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
let database: DatabaseSync | undefined;

function authDatabase(): DatabaseSync {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash BLOB NOT NULL,
      password_salt BLOB NOT NULL,
      must_change_password INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS login_sessions_expires_at ON login_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS login_attempts (
      username TEXT NOT NULL,
      attempted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS login_attempts_username_attempted_at ON login_attempts(username, attempted_at);
    CREATE TABLE IF NOT EXISTS user_mfa (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      secret_encrypted TEXT NOT NULL,
      last_used_step INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mfa_enrollments (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES login_sessions(id) ON DELETE CASCADE,
      secret_encrypted TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
      user_id TEXT NOT NULL REFERENCES user_mfa(user_id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      PRIMARY KEY (user_id, code_hash)
    );
    CREATE TABLE IF NOT EXISTS mfa_login_challenges (
      challenge_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
  `);
  const challengeColumns = database.prepare("PRAGMA table_info(mfa_login_challenges)").all() as unknown as Array<{ name: string }>;
  if (!challengeColumns.some(column => column.name === "setup_secret_encrypted")) database.exec("ALTER TABLE mfa_login_challenges ADD COLUMN setup_secret_encrypted TEXT");
  ensureReplicatedUserSchema(database);
  ensureAuditSchema(database);
  return database;
}

function ensureReplicatedUserSchema(db: DatabaseSync): void {
  const userColumns = db.prepare("PRAGMA table_info(users)").all() as unknown as Array<{ name: string }>;
  if (!userColumns.some((column) => column.name === "home_node_id")) {
    db.exec("ALTER TABLE users ADD COLUMN home_node_id TEXT");
  }
  const sessionColumns = db.prepare("PRAGMA table_info(login_sessions)").all() as unknown as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === "is_remote_login")) {
    db.exec("ALTER TABLE login_sessions ADD COLUMN is_remote_login INTEGER NOT NULL DEFAULT 0");
  }
  if (!userColumns.some((column) => column.name === "email")) db.exec("ALTER TABLE users ADD COLUMN email TEXT");
  if (!userColumns.some((column) => column.name === "role")) db.exec("ALTER TABLE users ADD COLUMN role TEXT");
  if (!userColumns.some((column) => column.name === "remote_mfa")) db.exec("ALTER TABLE users ADD COLUMN remote_mfa INTEGER NOT NULL DEFAULT 0");
  if (!userColumns.some((column) => column.name === "account_id")) db.exec("ALTER TABLE users ADD COLUMN account_id TEXT");
  if (!userColumns.some((column) => column.name === "disabled")) db.exec("ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0");
  // A visitor's clusters as their home node states them: the shared projects they may see here.
  if (!userColumns.some((column) => column.name === "remote_clusters")) db.exec("ALTER TABLE users ADD COLUMN remote_clusters TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL");
  // Before roles existed a node had one local user, so whoever is local and unroled is its admin.
  db.exec("UPDATE users SET role = 'admin' WHERE home_node_id IS NULL AND role IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')");
}

/** The node's own id, read from the same database. Empty before the node has an identity. */
function localNodeId(db: DatabaseSync): string {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cluster_node'").get()) return "";
  return (db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get() as { id: string } | undefined)?.id ?? "";
}

/** A local user's id follows the current twin pairing at once; the stored copy only tells
    `refreshLocalAccountIds` which rows to move. A visitor's id is the one its home stated. */
function accountIdForRow(db: DatabaseSync, row: { username: string; home_node_id: string | null; account_id?: string | null }): string {
  if (row.home_node_id === null) {
    const home = canonicalLocalHome(db);
    return home ? accountIdFor(home, row.username) : "";
  }
  return row.account_id || accountIdFor(row.home_node_id, row.username);
}

/** Stores each local user's account id, and reports the ones that changed (twins were
    paired or unpaired), so their per-person rows can move to the new id. */
export function refreshLocalAccountIds(): Array<{ from: string; to: string }> {
  const db = authDatabase();
  const home = canonicalLocalHome(db);
  if (!home) return [];
  const changes: Array<{ from: string; to: string }> = [];
  const rows = db.prepare("SELECT id, username, account_id FROM users WHERE home_node_id IS NULL").all() as unknown as Array<{ id: string; username: string; account_id: string | null }>;
  for (const row of rows) {
    const next = accountIdFor(home, row.username);
    if (row.account_id === next) continue;
    db.prepare("UPDATE users SET account_id = ? WHERE id = ?").run(next, row.id);
    changes.push({ from: row.account_id ?? row.username, to: next });
  }
  return changes;
}

/** The account id of this node's own user called `username`, if there is one. */
export function localAccountIdForUsername(username: string): string | undefined {
  const db = authDatabase();
  const row = db.prepare("SELECT username, home_node_id, account_id FROM users WHERE username = ? COLLATE NOCASE AND home_node_id IS NULL").get(username) as { username: string; home_node_id: null; account_id: string | null } | undefined;
  return row ? accountIdForRow(db, row) || undefined : undefined;
}

function checkedEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (!validEmail(normalized)) throw new AuthError(400, "Enter a valid email address");
  return normalized;
}

function emailTaken(db: DatabaseSync, email: string, exceptUserId?: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id IS NOT ?").get(email, exceptUserId ?? null));
}

function passwordDigest(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 64);
}

/**
 * Proof that a person really signed in on another node. That node holds their sign-in
 * record, so only something made from the password itself tells a sign-in from a claim:
 * a second digest of it, which the node can make only while it has the password in hand.
 * The home node keeps a digest of that proof, and nothing of it is replicated.
 */
function ensureRoamingProofSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS roaming_sign_in_verifiers (user_id TEXT PRIMARY KEY, verifier TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS visitor_sign_in_proofs (user_id TEXT PRIMARY KEY, proof TEXT NOT NULL);`);
}
function roamingProof(password: string, salt: Buffer): string {
  return scryptSync(password, Buffer.concat([Buffer.from("joint-bob-roaming:"), salt]), 32).toString("hex");
}
function rememberRoamingProof(db: DatabaseSync, user: { id: string; home_node_id: string | null }, password: string, salt: Buffer): void {
  ensureRoamingProofSchema(db);
  const proof = roamingProof(password, salt);
  if (user.home_node_id === null) db.prepare("INSERT INTO roaming_sign_in_verifiers (user_id, verifier) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET verifier = excluded.verifier").run(user.id, digest(proof));
  else db.prepare("INSERT INTO visitor_sign_in_proofs (user_id, proof) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET proof = excluded.proof").run(user.id, proof);
}
/** On the node a visitor signed in to: the proof of it, for their home node. */
export function visitorSignInProof(userId: string): string | undefined {
  const db = authDatabase();
  ensureRoamingProofSchema(db);
  return (db.prepare("SELECT proof FROM visitor_sign_in_proofs WHERE user_id = ?").get(userId) as { proof: string } | undefined)?.proof;
}
export function forgetVisitorSignInProof(userId: string): void {
  const db = authDatabase();
  ensureRoamingProofSchema(db);
  db.prepare("DELETE FROM visitor_sign_in_proofs WHERE user_id = ?").run(userId);
}
/** At home: whether another node's proof shows this person signed in there. */
export function roamingProofValid(userId: string, proof: string): boolean {
  const db = authDatabase();
  ensureRoamingProofSchema(db);
  const stored = (db.prepare("SELECT verifier FROM roaming_sign_in_verifiers WHERE user_id = ?").get(userId) as { verifier: string } | undefined)?.verifier;
  const offered = digest(proof);
  return Boolean(stored) && stored!.length === offered.length && timingSafeEqual(Buffer.from(stored!), Buffer.from(offered));
}

function validUsername(username: string): boolean {
  // A name shaped like an account id would be taken for one where older rows are read.
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/.test(username) && !/^[0-9a-f]{32}$/i.test(username);
}

function validPassword(password: string): boolean {
  return password.length >= 16 && password.length <= 200;
}

function userCount(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
}

function configuredAdministrator(): { username: string; password: string; email?: string } | undefined {
  const username = (process.env.JOINT_BOB_ADMIN_USERNAME ?? process.env.MASTER_BOB_ADMIN_USERNAME)?.trim();
  const password = process.env.JOINT_BOB_INITIAL_PASSWORD ?? process.env.MASTER_BOB_INITIAL_PASSWORD;
  const email = process.env.JOINT_BOB_ADMIN_EMAIL?.trim() || undefined;
  if (!username || !password) return undefined;
  if (!validUsername(username)) throw new Error("JOINT_BOB_ADMIN_USERNAME must be 3-80 letters, numbers, dots, underscores, or hyphens");
  if (!validPassword(password)) throw new Error("JOINT_BOB_INITIAL_PASSWORD must be at least 16 characters");
  return { username, password, email };
}

export function createAdministrator(username: string, password: string, mustChangePassword = true, email?: string): void {
  if (!validUsername(username)) throw new Error("Username must be 3-80 letters, numbers, dots, underscores, or hyphens");
  if (!validPassword(password)) throw new Error("Password must be 16-200 characters");
  const db = authDatabase();
  if (userCount(db) !== 0) throw new Error("An administrator already exists");
  insertLocalUser(db, username, password, mustChangePassword, email === undefined ? null : checkedEmail(email), "admin");
  // A node that starts with the terminal off has nothing to be told about it.
  save(settingsDatabase(), "terminalAccess.noticeDismissed", "true");
}

export interface LocalUserRecord {
  userId: string;
  accountId: string;
  username: string;
  email: string | null;
  role: AccountRole;
  disabled: boolean;
  createdAt: string;
}

/** Member usernames also name the member's OS account, so they are lowercase and short. */
export function validMemberUsername(username: string): boolean {
  // Cluster and visitor OS accounts, and the self-test's, use these names.
  return /^[a-z][a-z0-9_-]{2,27}$/.test(username) && !/^[cv][0-9a-f]{12}$/.test(username) && !username.startsWith("zzjbselftest");
}

/** The admin adds a member. The member signs in once with the returned one-time password
    and must replace it; nobody, the admin included, can read or reset it afterwards. */
export function createLocalUser(input: { username: string; email: string }, actorId?: string): { user: LocalUserRecord; oneTimePassword: string } {
  if (!validMemberUsername(input.username)) throw new AuthError(400, "Username must be 3-28 lowercase letters, numbers, underscores or hyphens, starting with a letter");
  const db = authDatabase();
  const email = checkedEmail(input.email);
  const oneTimePassword = randomBytes(18).toString("base64url");
  // A person of this node comes before a visitor's record: one holding the same name or email
  // gives way, with the copy of theirs this node kept.
  const visitors = db.prepare("SELECT username, home_node_id FROM users WHERE home_node_id IS NOT NULL AND (username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE)").all(input.username, email) as unknown as Array<{ username: string; home_node_id: string }>;
  for (const visitor of visitors) deleteReplicatedUser(visitor.home_node_id, visitor.username);
  db.exec("BEGIN IMMEDIATE");
  try {
    const userId = insertLocalUser(db, input.username, oneTimePassword, true, email, "member");
    appendAuditEvent(db, { eventType: "auth.user.created", actorType: actorId ? "user" : "system", actorId, entityType: "user", entityId: userId });
    db.exec("COMMIT");
    return { user: localUser(userId)!, oneTimePassword };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function localUser(userId: string): LocalUserRecord | undefined {
  return listLocalUsers().find((user) => user.userId === userId);
}

/** Accounts only: no sign-in history, sessions or activity of anyone. */
export function listLocalUsers(): LocalUserRecord[] {
  const db = authDatabase();
  const rows = db.prepare("SELECT id, username, home_node_id, account_id, email, role, disabled, created_at FROM users WHERE home_node_id IS NULL ORDER BY created_at, username").all() as unknown as Array<{ id: string; username: string; home_node_id: null; account_id: string | null; email: string | null; role: AccountRole | null; disabled: number; created_at: string }>;
  return rows.map((row) => ({ userId: row.id, accountId: accountIdForRow(db, row), username: row.username, email: row.email, role: row.role ?? "member", disabled: row.disabled === 1, createdAt: row.created_at }));
}

function endSessions(db: DatabaseSync, userId: string): string[] {
  const ids = (db.prepare("SELECT id FROM login_sessions WHERE user_id = ?").all(userId) as unknown as Array<{ id: string }>).map((row) => row.id);
  db.prepare("DELETE FROM login_sessions WHERE user_id = ?").run(userId);
  return ids;
}

/** The admin turns a member off or on again. A disabled member is signed out everywhere here. */
export function setLocalUserDisabled(userId: string, disabled: boolean, actorId?: string): LocalUserRecord {
  const db = authDatabase();
  const user = localUser(userId);
  if (!user) throw new AuthError(404, "User not found");
  if (user.role === "admin") throw new AuthError(409, "Transfer the admin role before disabling this account");
  let ended: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?").run(disabled ? 1 : 0, new Date().toISOString(), userId);
    if (disabled) ended = endSessions(db, userId);
    appendAuditEvent(db, { eventType: disabled ? "auth.user.disabled" : "auth.user.enabled", actorType: actorId ? "user" : "system", actorId, entityType: "user", entityId: userId });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (ended.length) authSessionEvents.emit("revoked", ended);
  return localUser(userId)!;
}

/** Removes the account itself; the caller removes everything the account owned first. */
export function deleteLocalUser(userId: string, actorId?: string): void {
  const db = authDatabase();
  const user = localUser(userId);
  if (!user) throw new AuthError(404, "User not found");
  if (user.role === "admin") throw new AuthError(409, "The admin account can't be deleted");
  let ended: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    ended = endSessions(db, userId);
    for (const table of ["user_mfa", "mfa_recovery_codes", "mfa_login_challenges", "mfa_enrollments"]) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'admin_transfers'").get()) db.prepare("DELETE FROM admin_transfers WHERE to_user_id = ?").run(userId);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    appendAuditEvent(db, { eventType: "auth.user.deleted", actorType: actorId ? "user" : "system", actorId, entityType: "user", entityId: userId });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (ended.length) authSessionEvents.emit("revoked", ended);
}

function ensureAdminTransferSchema(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS admin_transfers (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), to_user_id TEXT NOT NULL, offered_by TEXT NOT NULL, offered_at TEXT NOT NULL)");
}

/** The admin offers the role to a member; nothing changes until the member accepts. */
export function offerAdminTransfer(toUserId: string, actorId: string): void {
  const db = authDatabase();
  ensureAdminTransferSchema(db);
  const user = localUser(toUserId);
  // Only the admin gives the role away, whatever route the call came through.
  if (localUser(actorId)?.role !== "admin") throw new AuthError(404, "Not found");
  if (!user || user.disabled || user.role === "admin") throw new AuthError(404, "User not found");
  db.prepare("INSERT INTO admin_transfers (singleton, to_user_id, offered_by, offered_at) VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET to_user_id = excluded.to_user_id, offered_by = excluded.offered_by, offered_at = excluded.offered_at")
    .run(toUserId, actorId, new Date().toISOString());
  appendAuditEvent(db, { eventType: "auth.admin_transfer.offered", actorType: "user", actorId, entityType: "user", entityId: toUserId });
}

export function cancelAdminTransfer(actorId: string): void {
  const db = authDatabase();
  ensureAdminTransferSchema(db);
  if (localUser(actorId)?.role !== "admin") throw new AuthError(404, "Not found");
  db.prepare("DELETE FROM admin_transfers").run();
  appendAuditEvent(db, { eventType: "auth.admin_transfer.cancelled", actorType: "user", actorId, entityType: "user" });
}

export function pendingAdminTransfer(): { toUserId: string; offeredAt: string } | undefined {
  const db = authDatabase();
  ensureAdminTransferSchema(db);
  const row = db.prepare("SELECT to_user_id, offered_at FROM admin_transfers WHERE singleton = 1").get() as { to_user_id: string; offered_at: string } | undefined;
  return row ? { toUserId: row.to_user_id, offeredAt: row.offered_at } : undefined;
}

/** The member takes the role. `beforeSwap` runs first, so everything the old admin owned
    implicitly is written down as theirs before the role moves. */
export function acceptAdminTransfer(session: AuthSession, beforeSwap: (oldAdminAccountId: string) => void): void {
  const db = authDatabase();
  ensureAdminTransferSchema(db);
  const pending = pendingAdminTransfer();
  if (!pending || pending.toUserId !== session.userId || session.isRemoteLogin) throw new AuthError(404, "No admin role is offered to you");
  const oldAdmin = listLocalUsers().find((user) => user.role === "admin");
  if (!oldAdmin) throw new AuthError(409, "This node has no admin to take over from");
  // Its writes use other connections to the same database, so it runs before this one locks it.
  beforeSwap(oldAdmin.accountId);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE users SET role = 'member' WHERE id = ?").run(oldAdmin.userId);
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(session.userId);
    db.prepare("DELETE FROM admin_transfers").run();
    appendAuditEvent(db, { eventType: "auth.admin_transfer.accepted", actorType: "user", actorId: session.userId, entityType: "user", entityId: session.userId });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function insertLocalUser(db: DatabaseSync, username: string, password: string, mustChangePassword: boolean, email: string | null, role: AccountRole): string {
  if (email && emailTaken(db, email)) throw new AuthError(409, "That email is already used on this node");
  if (db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username)) throw new AuthError(409, "That username is already used on this node");
  const now = new Date().toISOString();
  const salt = randomBytes(16);
  const id = nanoid(18);
  db.prepare(`
    INSERT INTO users (id, username, password_hash, password_salt, must_change_password, email, role, account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, username, passwordDigest(password, salt), salt, mustChangePassword ? 1 : 0, email, role, accountIdForRow(db, { username, home_node_id: null }) || null, now, now);
  return id;
}

function ensureConfiguredAdministrator(): void {
  if (userCount(authDatabase()) !== 0) return;
  const administrator = configuredAdministrator();
  if (administrator) createAdministrator(administrator.username, administrator.password, true, administrator.email);
}

function parseUser(row: UserRow | undefined): UserRow | undefined {
  return row;
}

function recordLoginAttempt(db: DatabaseSync, username: string): void {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM login_attempts WHERE attempted_at < ?").run(cutoff);
  db.prepare("INSERT INTO login_attempts (username, attempted_at) VALUES (?, ?)").run(username.toLowerCase(), new Date().toISOString());
}

function isRateLimited(username: string, limit = 5): boolean {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const count = authDatabase().prepare("SELECT COUNT(*) AS count FROM login_attempts WHERE username = ? AND attempted_at >= ?")
    .get(username.toLowerCase(), cutoff) as { count: number };
  return count.count >= limit;
}

/** Phone sign-in through a relay uses separate throttle buckets, so attempts from the
    internet never lock the owner out locally. It issues only a short-lived challenge
    until MFA is verified or enrolled (RELAY-PLAN.md §6 M2). */
export interface AuthenticateOptions {
  throttle?: Array<{ key: string; limit: number }>;
  requireMfa?: boolean;
  /** Refuse users whose home is another machine, with the same answer as a wrong password. */
  homeUsersOnly?: boolean;
}

export function authenticationStatus(session?: AuthSession): AuthStatus {
  ensureConfiguredAdministrator();
  if (session) {
    return {
      authenticated: true,
      setupRequired: false,
      mustChangePassword: session.mustChangePassword,
      csrfToken: session.csrfToken,
      username: session.username,
      email: session.email,
      accountId: session.accountId,
      role: session.role,
      needsEmail: !session.isRemoteLogin && !session.email,
      isRemoteLogin: session.isRemoteLogin,
    };
  }
  return { authenticated: false, setupRequired: userCount(authDatabase()) === 0 };
}

export function authenticate(username: string, password: string, options: AuthenticateOptions = {}): AuthSession | MfaLoginChallenge {
  ensureConfiguredAdministrator();
  const db = authDatabase();
  const normalizedUsername = username.trim();
  // Either the username or the email signs in; both are unique on a node.
  const row = parseUser(db.prepare("SELECT * FROM users WHERE username = ? OR (instr(?, '@') > 0 AND email = ? COLLATE NOCASE)").get(normalizedUsername, normalizedUsername, normalizedUsername) as UserRow | undefined);
  const buckets = options.throttle ?? [{ key: normalizedUsername, limit: 5 }];
  if (buckets.some((bucket) => isRateLimited(bucket.key, bucket.limit))) {
    appendAuditEvent(db, { eventType: "auth.login.rate_limited", actorType: "system", entityType: "auth.login", details: { knownUser: Boolean(row) } });
    throw new Error("Too many login attempts. Try again in 15 minutes");
  }
  const passwordMatches = Boolean(row && timingSafeEqual(passwordDigest(password, row.password_salt), row.password_hash));
  if (!row || !passwordMatches || (options.homeUsersOnly && row.home_node_id !== null)) {
    db.exec("BEGIN");
    try {
      for (const bucket of buckets) recordLoginAttempt(db, bucket.key);
      appendAuditEvent(db, { eventType: "auth.login.failed", actorType: "system", entityType: "auth.login", details: { knownUser: Boolean(row) } });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    throw new Error("Invalid username or password");
  }
  if (row.disabled === 1) throw new AuthError(403, "This account is disabled");
  if (row.home_node_id !== null && options.requireMfa && row.remote_mfa !== 1) {
    throw new AuthError(403, "Set up two-factor authentication on your home node before signing in here from a phone");
  }
  rememberRoamingProof(db, row, password, row.password_salt);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const bucket of buckets) db.prepare("DELETE FROM login_attempts WHERE username = ?").run(bucket.key.toLowerCase());
    const enabled = mfaStatus(row.id).enabled || row.remote_mfa === 1;
    if (enabled || options.requireMfa) {
      checkMfaRateLimit(row.id);
      const challenge = randomBytes(32).toString("base64url");
      db.prepare("DELETE FROM mfa_login_challenges WHERE expires_at <= ? OR user_id = ?").run(new Date().toISOString(), row.id);
      db.prepare("INSERT INTO mfa_login_challenges (challenge_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .run(digest(challenge), row.id, new Date(Date.now() + 5 * 60_000).toISOString());
      db.exec("COMMIT");
      return { mfaRequired: true, challenge, ...(!enabled ? { mfaSetupRequired: true } : {}), ...(row.home_node_id !== null ? { remoteMfa: true, offlineMfa: mfaStatus(row.id).enabled } : {}) };
    }
    const session = createLoginSession(db, row);
    db.exec("COMMIT");
    return session;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function createLoginSession(db: DatabaseSync, row: UserRow): AuthSession {
  const id = nanoid(32);
  const csrfToken = randomBytes(32).toString("hex");
  const now = new Date();
  const isRemoteLogin = row.home_node_id !== null;
  db.prepare("INSERT INTO login_sessions (id, user_id, csrf_token, expires_at, created_at, is_remote_login) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, row.id, csrfToken, new Date(now.getTime() + sessionLifetimeMs).toISOString(), now.toISOString(), isRemoteLogin ? 1 : 0);
  appendAuditEvent(db, { eventType: "auth.login.succeeded", actorType: "user", actorId: row.id, entityType: "user", entityId: row.id, details: { isRemoteLogin } });
  return { id, userId: row.id, username: row.username, accountId: accountIdForRow(db, row), email: row.email, role: row.role, csrfToken, mustChangePassword: row.must_change_password === 1, isRemoteLogin, homeNodeId: row.home_node_id };
}

export function sessionForId(sessionId: string | undefined): AuthSession | undefined {
  if (!sessionId) return undefined;
  const now = new Date().toISOString();
  authDatabase().prepare("DELETE FROM login_sessions WHERE expires_at <= ?").run(now);
  const row = authDatabase().prepare(`
    SELECT login_sessions.id, login_sessions.user_id, users.username, login_sessions.csrf_token,
      users.must_change_password, login_sessions.is_remote_login, users.home_node_id, users.email, users.role, users.account_id
    FROM login_sessions JOIN users ON users.id = login_sessions.user_id
    WHERE login_sessions.id = ? AND login_sessions.expires_at > ? AND users.disabled = 0
  `).get(sessionId, now) as SessionRow | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    accountId: accountIdForRow(authDatabase(), row),
    email: row.email,
    role: row.role,
    csrfToken: row.csrf_token,
    mustChangePassword: row.must_change_password === 1,
    isRemoteLogin: row.is_remote_login === 1,
    homeNodeId: row.home_node_id,
  };
}

/** The cluster-stable reviewer identity: usernames match across nodes even though user ids do not. */
export function usernameForUser(userId: string): string | undefined {
  return (authDatabase().prepare("SELECT username FROM users WHERE id = ?").get(userId) as { username: string } | undefined)?.username;
}

export function userIdForUsername(username: string): string | undefined {
  return (authDatabase().prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username) as { id: string } | undefined)?.id;
}

/** The account a node-local user id belongs to: the key per-person data is stored under. */
export function accountIdForUser(userId: string): string | undefined {
  const db = authDatabase();
  const row = db.prepare("SELECT username, home_node_id, account_id FROM users WHERE id = ?").get(userId) as { username: string; home_node_id: string | null; account_id: string | null } | undefined;
  const account = row ? accountIdForRow(db, row) : "";
  return account || undefined;
}

export function userIdForAccount(accountId: string): string | undefined {
  const db = authDatabase();
  const rows = db.prepare("SELECT id, username, home_node_id, account_id FROM users").all() as unknown as Array<{ id: string; username: string; home_node_id: string | null; account_id: string | null }>;
  return rows.find((row) => accountIdForRow(db, row) === accountId)?.id;
}

/** Sets the signed-in account's own email. Replicated accounts change theirs at home. */
export function setOwnEmail(session: AuthSession, email: string): string {
  if (session.isRemoteLogin) throw new AuthError(403, "Change your email on your home node");
  const db = authDatabase();
  const normalized = checkedEmail(email);
  if (emailTaken(db, normalized, session.userId)) throw new AuthError(409, "That email is already used on this node");
  db.prepare("UPDATE users SET email = ?, updated_at = ? WHERE id = ?").run(normalized, new Date().toISOString(), session.userId);
  appendAuditEvent(db, { eventType: "auth.email.changed", actorType: "user", actorId: session.userId, entityType: "user", entityId: session.userId });
  return normalized;
}

export function changePassword(session: AuthSession, currentPassword: string, newPassword: string): void {
  if (!validPassword(newPassword)) throw new Error("New password must be 16-200 characters");
  const row = authDatabase().prepare("SELECT * FROM users WHERE id = ?").get(session.userId) as UserRow | undefined;
  if (!row || !timingSafeEqual(passwordDigest(currentPassword, row.password_salt), row.password_hash)) {
    throw new Error("Current password is incorrect");
  }
  const salt = randomBytes(16);
  const db = authDatabase();
  db.exec("BEGIN");
  try {
    db.prepare(`
      UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0, updated_at = ? WHERE id = ?
    `).run(passwordDigest(newPassword, salt), salt, new Date().toISOString(), session.userId);
    rememberRoamingProof(db, row, newPassword, salt);
    db.prepare("DELETE FROM mfa_login_challenges WHERE user_id = ?").run(session.userId);
    db.prepare("DELETE FROM mfa_enrollments WHERE user_id = ?").run(session.userId);
    appendAuditEvent(db, { eventType: "auth.password.changed", actorType: "user", actorId: session.userId, entityType: "user", entityId: session.userId });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listLoginSessions(userId: string): LoginSessionSummary[] {
  const db = authDatabase();
  db.prepare("DELETE FROM login_sessions WHERE expires_at <= ?").run(new Date().toISOString());
  return db.prepare(`
    SELECT id, created_at AS createdAt, expires_at AS expiresAt
    FROM login_sessions WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId) as unknown as LoginSessionSummary[];
}

export function revokeUserSession(userId: string, sessionId: string): boolean {
  const db = authDatabase();
  db.exec("BEGIN");
  try {
    const result = db.prepare("DELETE FROM login_sessions WHERE id = ? AND user_id = ?").run(sessionId, userId);
    if (result.changes === 1) appendAuditEvent(db, { eventType: "auth.session.revoked", actorType: "user", actorId: userId, entityType: "auth.session" });
    db.exec("COMMIT");
    if (result.changes === 1) authSessionEvents.emit("revoked", [sessionId]);
    return result.changes === 1;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function revokeSession(sessionId: string): void {
  const db = authDatabase();
  const session = db.prepare("SELECT user_id FROM login_sessions WHERE id = ?").get(sessionId) as { user_id: string } | undefined;
  db.exec("BEGIN");
  try {
    const result = db.prepare("DELETE FROM login_sessions WHERE id = ?").run(sessionId);
    if (result.changes === 1) appendAuditEvent(db, { eventType: "auth.session.revoked", actorType: "user", actorId: session!.user_id, entityType: "auth.session" });
    db.exec("COMMIT");
    if (result.changes === 1) authSessionEvents.emit("revoked", [sessionId]);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function mfaStatus(userId: string): MfaStatus {
  const db = authDatabase();
  return {
    enabled: Boolean(db.prepare("SELECT 1 FROM user_mfa WHERE user_id = ?").get(userId)),
    recoveryCodesRemaining: (db.prepare("SELECT count(*) AS count FROM mfa_recovery_codes WHERE user_id = ?").get(userId) as { count: number }).count,
  };
}

function checkMfaRateLimit(userId: string): void {
  if (isRateLimited(`mfa:${userId}`)) throw new AuthError(429, "Too many MFA attempts. Try again in 15 minutes");
}

/** All factor consumption and the operation it authorizes commit together. Failures
 * persist separately after rollback, so a rejected operation cannot reset its budget. */
function mfaAction<T>(userId: string, action: (db: DatabaseSync) => T): T {
  const db = authDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    checkMfaRateLimit(userId);
    const result = action(db);
    db.prepare("DELETE FROM login_attempts WHERE username = ?").run(`mfa:${userId}`.toLowerCase());
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    if (error instanceof AuthError && [400, 401].includes(error.statusCode)) {
      recordLoginAttempt(db, `mfa:${userId}`);
      appendAuditEvent(db, { eventType: "auth.mfa.failed", actorType: "user", actorId: userId, entityType: "user", entityId: userId });
    }
    throw error;
  }
}

function requireMfaPassword(db: DatabaseSync, userId: string, password: string): void {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
  if (!row || !timingSafeEqual(passwordDigest(password, row.password_salt), row.password_hash)) throw new AuthError(400, "Current password is incorrect");
}

function recoveryDigest(userId: string, code: string): string {
  return digest(`mfa-recovery:${userId}:${code.replace(/[\s-]/g, "").toLowerCase()}`);
}

function replaceRecoveryCodes(db: DatabaseSync, userId: string): string[] {
  const codes = Array.from({ length: 10 }, () => randomBytes(10).toString("hex").match(/.{4}/g)!.join("-"));
  db.prepare("DELETE FROM mfa_recovery_codes WHERE user_id = ?").run(userId);
  const insert = db.prepare("INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (?, ?)");
  for (const code of codes) insert.run(userId, recoveryDigest(userId, code));
  return codes;
}

function consumeMfaCode(db: DatabaseSync, userId: string, code: string): boolean {
  const row = db.prepare("SELECT secret_encrypted, last_used_step FROM user_mfa WHERE user_id = ?").get(userId) as { secret_encrypted: string; last_used_step: number } | undefined;
  if (!row) return false;
  const normalized = code.replace(/\s/g, "");
  if (/^\d{6}$/.test(normalized)) {
    const step = verifyTotp(decryptSecretValue(row.secret_encrypted), normalized, Date.now(), row.last_used_step);
    if (step === undefined) return false;
    db.prepare("UPDATE user_mfa SET last_used_step = ? WHERE user_id = ?").run(step, userId);
    return true;
  }
  if (!/^[a-f0-9]{20}$/i.test(normalized.replaceAll("-", ""))) return false;
  return db.prepare("DELETE FROM mfa_recovery_codes WHERE user_id = ? AND code_hash = ?").run(userId, recoveryDigest(userId, normalized)).changes === 1;
}

export type VerifyRemoteMfa = (homeNodeId: string, accountId: string, proof: string, code: string) => Promise<void>;

/** Home verifies recovery codes and legacy visitors without a synced TOTP key. */
export function verifyAccountMfa(userId: string, proof: string, code: string): void {
  mfaAction(userId, db => {
    const row = db.prepare("SELECT * FROM users WHERE id = ? AND home_node_id IS NULL AND disabled = 0").get(userId) as UserRow | undefined;
    if (!row || !roamingProofValid(userId, proof)) throw new AuthError(401, "Sign-in expired. Go back and enter your password again");
    if (!consumeMfaCode(db, userId, code)) throw new AuthError(401, "Invalid or already used code. Use a fresh authenticator code or an unused recovery code");
  });
}

export async function completeMfaLogin(challenge: string, code: string, verifyRemote?: VerifyRemoteMfa, authorizeRemote?: (homeNodeId: string, accountId: string) => Promise<void>): Promise<AuthSession> {
  const db = authDatabase();
  const hash = digest(challenge);
  const row = db.prepare("SELECT users.* FROM mfa_login_challenges JOIN users ON users.id = user_id WHERE challenge_hash = ? AND expires_at > ? AND users.disabled = 0")
    .get(hash, new Date().toISOString()) as UserRow | undefined;
  if (!row) throw new AuthError(401, "Sign-in expired. Go back and enter your password again");
  if (row.home_node_id !== null) {
    if (!authorizeRemote) throw new AuthError(403, "Sign-in is not available on this node");
    await authorizeRemote(row.home_node_id, accountIdForRow(db, row));
  }
  // Replicated TOTP is checked here even while home is offline. Recovery codes stay
  // authoritative at home; copying them would let one code be spent on disconnected nodes.
  const localTotp = mfaStatus(row.id).enabled && /^\d{6}$/.test(code.replace(/\s/g, ""));
  if (row.home_node_id !== null && !localTotp) {
    const proof = visitorSignInProof(row.id);
    if (!verifyRemote || !proof || row.remote_mfa !== 1) throw new AuthError(401, "Sign-in expired. Go back and enter your password again");
    checkMfaRateLimit(row.id);
    await verifyRemote(row.home_node_id, accountIdForRow(db, row), proof, code);
    // No transaction spans the network request. Claim the challenge only after home accepts;
    // deletion, credential updates, expiry or a concurrent completion must still win.
    return mfaAction(row.id, db => {
      const current = db.prepare("SELECT * FROM users WHERE id = ? AND disabled = 0").get(row.id) as UserRow | undefined;
      const claimed = db.prepare("DELETE FROM mfa_login_challenges WHERE challenge_hash = ? AND expires_at > ?").run(hash, new Date().toISOString());
      if (!current || claimed.changes !== 1) throw new AuthError(401, "Sign-in expired. Go back and enter your password again");
      return createLoginSession(db, current);
    });
  }
  return mfaAction(row.id, (db) => {
    const claimed = db.prepare("DELETE FROM mfa_login_challenges WHERE challenge_hash = ? AND expires_at > ?").run(hash, new Date().toISOString());
    if (claimed.changes !== 1) throw new AuthError(401, "Sign-in expired. Go back and enter your password again");
    if (!consumeMfaCode(db, row.id, code)) throw new AuthError(401, "Invalid or already used code. Use a fresh authenticator code or an unused recovery code");
    return createLoginSession(db, row);
  });
}

// A gateway password proof can enroll MFA, but cannot open an app session until TOTP is proven.
function pendingGatewaySetup(db: DatabaseSync, challenge: string): UserRow {
  const row = db.prepare(`SELECT users.* FROM mfa_login_challenges JOIN users ON users.id = user_id
    WHERE challenge_hash = ? AND expires_at > ? AND users.disabled = 0 AND users.home_node_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM user_mfa WHERE user_id = users.id)`)
    .get(digest(challenge), new Date().toISOString()) as UserRow | undefined;
  if (!row) throw new AuthError(401, "Sign-in expired. Go back and enter your password again");
  return row;
}

export function beginGatewayMfaSetup(challenge: string): { secret: string; otpauthUri: string } {
  const db = authDatabase();
  const row = pendingGatewaySetup(db, challenge);
  checkMfaRateLimit(row.id);
  const secret = generateTotpSecret();
  db.prepare("UPDATE mfa_login_challenges SET setup_secret_encrypted = ? WHERE challenge_hash = ?")
    .run(encryptSecretValue(secret), digest(challenge));
  const label = encodeURIComponent(`Joint Bob:${row.username}@${hostname()}`);
  return { secret, otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=Joint%20Bob&algorithm=SHA1&digits=6&period=30` };
}

export function confirmGatewayMfaSetup(challenge: string, code: string): { session: AuthSession; recoveryCodes: string[] } {
  const db = authDatabase();
  const row = pendingGatewaySetup(db, challenge);
  const result = mfaAction(row.id, db => {
    const pending = db.prepare("SELECT setup_secret_encrypted FROM mfa_login_challenges WHERE challenge_hash = ? AND expires_at > ?")
      .get(digest(challenge), new Date().toISOString()) as { setup_secret_encrypted: string | null } | undefined;
    if (!pending?.setup_secret_encrypted) throw new AuthError(400, "MFA setup expired. Start setup again");
    const step = verifyTotp(decryptSecretValue(pending.setup_secret_encrypted), code.replace(/\s/g, ""));
    if (step === undefined) throw new AuthError(400, "Invalid authenticator code");
    db.prepare("INSERT INTO user_mfa (user_id, secret_encrypted, last_used_step) VALUES (?, ?, ?)")
      .run(row.id, pending.setup_secret_encrypted, step);
    const recoveryCodes = replaceRecoveryCodes(db, row.id);
    const session = createLoginSession(db, row);
    const revoked = invalidateOtherLogins(db, session);
    appendAuditEvent(db, { eventType: "auth.mfa.enabled", actorType: "user", actorId: row.id, entityType: "user", entityId: row.id });
    return { session, recoveryCodes, revoked };
  });
  authSessionEvents.emit("revoked", result.revoked);
  return { session: result.session, recoveryCodes: result.recoveryCodes };
}

function requireHomeMfaManagement(session: AuthSession): void {
  if (session.isRemoteLogin) throw new AuthError(403, "Manage MFA on your home node");
}

export function beginMfaSetup(session: AuthSession, currentPassword: string): { secret: string; otpauthUri: string } {
  requireHomeMfaManagement(session);
  return mfaAction(session.userId, (db) => {
    requireMfaPassword(db, session.userId, currentPassword);
    if (mfaStatus(session.userId).enabled) throw new AuthError(409, "MFA is already enabled");
    const secret = generateTotpSecret();
    db.prepare("DELETE FROM mfa_enrollments WHERE expires_at <= ?").run(new Date().toISOString());
    db.prepare("INSERT INTO mfa_enrollments (user_id, session_id, secret_encrypted, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET session_id = excluded.session_id, secret_encrypted = excluded.secret_encrypted, expires_at = excluded.expires_at")
      .run(session.userId, session.id, encryptSecretValue(secret), new Date(Date.now() + 10 * 60_000).toISOString());
    const label = encodeURIComponent(`Joint Bob:${session.username}@${hostname()}`);
    return { secret, otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=Joint%20Bob&algorithm=SHA1&digits=6&period=30` };
  });
}

export function cancelMfaSetup(session: AuthSession): void {
  requireHomeMfaManagement(session);
  authDatabase().prepare("DELETE FROM mfa_enrollments WHERE user_id = ? AND session_id = ?").run(session.userId, session.id);
}

function invalidateOtherLogins(db: DatabaseSync, session: AuthSession): string[] {
  const revoked = db.prepare("SELECT id FROM login_sessions WHERE user_id = ? AND id <> ?").all(session.userId, session.id) as Array<{ id: string }>;
  db.prepare("DELETE FROM login_sessions WHERE user_id = ? AND id <> ?").run(session.userId, session.id);
  db.prepare("DELETE FROM mfa_login_challenges WHERE user_id = ?").run(session.userId);
  db.prepare("DELETE FROM mfa_enrollments WHERE user_id = ?").run(session.userId);
  return revoked.map(row => row.id);
}

export function confirmMfaSetup(session: AuthSession, code: string): { recoveryCodes: string[] } {
  requireHomeMfaManagement(session);
  const result = mfaAction(session.userId, (db) => {
    if (mfaStatus(session.userId).enabled) throw new AuthError(409, "MFA is already enabled");
    const pending = db.prepare("SELECT secret_encrypted FROM mfa_enrollments WHERE user_id = ? AND session_id = ? AND expires_at > ?")
      .get(session.userId, session.id, new Date().toISOString()) as { secret_encrypted: string } | undefined;
    if (!pending) throw new AuthError(400, "MFA setup expired. Start setup again");
    const step = verifyTotp(decryptSecretValue(pending.secret_encrypted), code.replace(/\s/g, ""));
    if (step === undefined) throw new AuthError(400, "Invalid authenticator code");
    db.prepare("INSERT INTO user_mfa (user_id, secret_encrypted, last_used_step) VALUES (?, ?, ?)").run(session.userId, pending.secret_encrypted, step);
    const recoveryCodes = replaceRecoveryCodes(db, session.userId);
    const revoked = invalidateOtherLogins(db, session);
    appendAuditEvent(db, { eventType: "auth.mfa.enabled", actorType: "user", actorId: session.userId, entityType: "user", entityId: session.userId });
    return { recoveryCodes, revoked };
  });
  authSessionEvents.emit("revoked", result.revoked);
  return { recoveryCodes: result.recoveryCodes };
}

export function manageMfa(session: AuthSession, currentPassword: string, code: string, action: "disable" | "recovery-codes"): { recoveryCodes?: string[] } {
  requireHomeMfaManagement(session);
  const result = mfaAction(session.userId, (db) => {
    requireMfaPassword(db, session.userId, currentPassword);
    if (!mfaStatus(session.userId).enabled) throw new AuthError(409, "MFA is not enabled");
    if (!consumeMfaCode(db, session.userId, code)) throw new AuthError(400, "Invalid or already used code. Use a fresh authenticator code or an unused recovery code");
    const recoveryCodes = action === "recovery-codes" ? replaceRecoveryCodes(db, session.userId) : undefined;
    if (action === "disable") db.prepare("DELETE FROM user_mfa WHERE user_id = ?").run(session.userId);
    const revoked = invalidateOtherLogins(db, session);
    appendAuditEvent(db, { eventType: action === "disable" ? "auth.mfa.disabled" : "auth.mfa.recovery_regenerated", actorType: "user", actorId: session.userId, entityType: "user", entityId: session.userId });
    return { recoveryCodes, revoked };
  });
  authSessionEvents.emit("revoked", result.revoked);
  return result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {};
}

// Cookies ignore the port, so every node reachable at the same hostname shares one
// cookie jar: a second local node signing in would overwrite the first node's
// session. Each development node sets its own name; production keeps the default.
export const sessionCookieName = process.env.JOINT_BOB_SESSION_COOKIE ?? "mb_session";

// Safari drops a Secure cookie sent over plain HTTP, so a local HTTP node is
// impossible to sign into there. Development sets this; production never does.
const secureAttribute = process.env.JOINT_BOB_INSECURE_COOKIE === "1" ? "" : " Secure;";

/** Phone sessions through a relay gateway use a `__Host-` cookie. Every machine on a relay is
    a sibling name under the relay's domain, and browsers refuse to let a sibling set or shadow
    a `__Host-` cookie (RELAY-PLAN.md §6 M2). It is always Secure, as the prefix requires. */
export const gatewaySessionCookieName = `__Host-${sessionCookieName}`;

export function sessionCookieNameFor(gateway: boolean): string { return gateway ? gatewaySessionCookieName : sessionCookieName; }

export function sessionCookieValue(session: AuthSession, gateway = false): string {
  const secure = gateway ? " Secure;" : secureAttribute;
  return `${sessionCookieNameFor(gateway)}=${session.id}; Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=${Math.floor(sessionLifetimeMs / 1000)}`;
}

export function clearSessionCookieValue(gateway = false): string {
  const secure = gateway ? " Secure;" : secureAttribute;
  return `${sessionCookieNameFor(gateway)}=; Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=0`;
}

// ============================================================================
// Replicated User Management
// ============================================================================

export interface ReplicatedUserInput {
  username: string;
  email: string | null;
  passwordHash: Buffer;
  passwordSalt: Buffer;
  homeNodeId: string;
  /** Stated by the home node: its twins share one id for the same person. */
  accountId: string;
  /** A second factor is required even when an older home has not shared its TOTP key. */
  mfaRequired: boolean;
  /** From the authenticated home snapshot only. Re-encrypted under this node's key. */
  mfaSecret?: string | null;
  /** The clusters, shared with this node, that the person joined at home. */
  clusterIds?: string[];
}

export interface ReplicatedUserRecord {
  id: string;
  username: string;
  homeNodeId: string;
  createdAt: string;
  updatedAt: string;
}

/** Creates or updates a replicated user from another node. */
export function upsertReplicatedUser(input: ReplicatedUserInput): ReplicatedUserRecord {
  if (!validUsername(input.username)) throw new Error("Invalid username for replicated user");
  if (input.mfaSecret != null && (!input.mfaRequired || !/^[A-Z2-7]{32}$/.test(input.mfaSecret))) throw new Error("Invalid replicated MFA");
  const email = input.email == null ? null : normalizeEmail(input.email);
  if (email !== null && !validEmail(email)) throw new Error("Invalid email for replicated user");
  const db = authDatabase();
  const now = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT id, home_node_id, password_hash, password_salt, remote_mfa FROM users WHERE username = ? COLLATE NOCASE").get(input.username) as { id: string; home_node_id: string | null; password_hash: Uint8Array; password_salt: Uint8Array; remote_mfa: number } | undefined;
    if (existing && existing.home_node_id === null) throw new Error("Cannot overwrite the home user with a replicated user");
    if (existing && existing.home_node_id !== input.homeNodeId) throw new Error("Username conflict: replicated user from different home node");
    if (email !== null && emailTaken(db, email, existing?.id)) throw new Error("Email conflict: another account on this node uses that email");
    // The account id is the other node's statement. It may never be the id of a person of
    // this node, nor one another account here already answers to.
    if (input.accountId) {
      if (!/^[0-9a-f]{32}$/.test(input.accountId)) throw new Error("Invalid account id for replicated user");
      if (listLocalUsers().some((user) => user.accountId === input.accountId)) throw new Error("Account conflict: that account belongs to a person of this node");
      if (db.prepare("SELECT 1 FROM users WHERE account_id = ? AND id IS NOT ?").get(input.accountId, existing?.id ?? null)) throw new Error("Account conflict: another account here already has that id");
    }
    const id = existing?.id ?? nanoid(18);
    let revoked: string[] = [];
    const factor = db.prepare("SELECT secret_encrypted FROM user_mfa WHERE user_id = ?").get(id) as { secret_encrypted: string } | undefined;
    const factorChanged = (factor ? decryptSecretValue(factor.secret_encrypted) : null) !== (input.mfaSecret ?? null);
    if (existing) {
      if (factorChanged || !Buffer.from(existing.password_hash).equals(input.passwordHash) || !Buffer.from(existing.password_salt).equals(input.passwordSalt) || existing.remote_mfa !== (input.mfaRequired ? 1 : 0)) {
        db.prepare("DELETE FROM mfa_login_challenges WHERE user_id = ?").run(id);
        revoked = endSessions(db, id);
      }
      db.prepare("UPDATE users SET password_hash = ?, password_salt = ?, email = ?, remote_mfa = ?, account_id = ?, remote_clusters = ?, updated_at = ? WHERE id = ?")
        .run(input.passwordHash, input.passwordSalt, email, input.mfaRequired ? 1 : 0, input.accountId ?? null, JSON.stringify(input.clusterIds ?? []), now, id);
    } else {
      db.prepare(`INSERT INTO users (id, username, password_hash, password_salt, must_change_password, home_node_id, email, remote_mfa, account_id, remote_clusters, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.username, input.passwordHash, input.passwordSalt, input.homeNodeId, email, input.mfaRequired ? 1 : 0, input.accountId ?? null, JSON.stringify(input.clusterIds ?? []), now, now);
    }
    // A repeated snapshot never resets this node's replay counter. A removed or replaced
    // key discards its old factor and pending proofs, not the account's ownership.
    if (factorChanged) {
      db.prepare("DELETE FROM user_mfa WHERE user_id = ?").run(id);
      if (input.mfaSecret) db.prepare("INSERT INTO user_mfa (user_id, secret_encrypted, last_used_step) VALUES (?, ?, -1)").run(id, encryptSecretValue(input.mfaSecret));
    }
    appendAuditEvent(db, { eventType: existing ? "auth.replicated_user.updated" : "auth.replicated_user.created", actorType: "system", entityType: "user", entityId: id, details: { homeNodeId: input.homeNodeId } });
    db.exec("COMMIT");
    if (revoked.length) authSessionEvents.emit("revoked", revoked);
    return { id, username: input.username, homeNodeId: input.homeNodeId, createdAt: now, updatedAt: now };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** A visitor here by account id: their local user row and the node they call home. */
export function replicatedUserByAccount(accountId: string): { userId: string; username: string; homeNodeId: string } | undefined {
  const row = authDatabase().prepare("SELECT id, username, home_node_id FROM users WHERE account_id = ? AND home_node_id IS NOT NULL").get(accountId) as { id: string; username: string; home_node_id: string } | undefined;
  return row ? { userId: row.id, username: row.username, homeNodeId: row.home_node_id } : undefined;
}

/** Signs a visitor out here, as "Forget this node" asks; their sign-in record stays. */
export function endVisitorSessions(userId: string): void {
  const db = authDatabase();
  const visitor = db.prepare("SELECT 1 FROM users WHERE id = ? AND home_node_id IS NOT NULL").get(userId);
  const ended = visitor ? endSessions(db, userId) : [];
  if (ended.length) authSessionEvents.emit("revoked", ended);
}

/** The clusters a visitor joined at home, as their home node last stated them. */
export function visitorClusterIds(accountId: string): string[] {
  const row = authDatabase().prepare("SELECT remote_clusters FROM users WHERE account_id = ? AND home_node_id IS NOT NULL").get(accountId) as { remote_clusters: string | null } | undefined;
  try { const ids = JSON.parse(row?.remote_clusters ?? "[]") as unknown; return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []; } catch { return []; }
}

/** Removes a replicated user and all their sessions. */
export function deleteReplicatedUser(homeNodeId: string, username: string): boolean {
  const db = authDatabase();
  const user = db.prepare("SELECT id, account_id FROM users WHERE username = ? COLLATE NOCASE AND home_node_id = ?").get(username, homeNodeId) as { id: string; account_id: string | null } | undefined;
  if (!user) return false;

  let revoked: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const ended = (db.prepare("SELECT id FROM login_sessions WHERE user_id = ?").all(user.id) as unknown as Array<{ id: string }>).map((session) => session.id);
    db.prepare("DELETE FROM login_sessions WHERE user_id = ?").run(user.id);
    db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
    ensureRoamingProofSchema(db);
    db.prepare("DELETE FROM visitor_sign_in_proofs WHERE user_id = ?").run(user.id);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_preferences'").get()) db.prepare("DELETE FROM user_preferences WHERE user_id = ?").run(user.id);
    revoked = ended;
    // Their copy here goes with them: every per-person row and their roaming profile.
    if (user.account_id) {
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as Array<{ name: string }>).map((row) => row.name));
      for (const [table, column] of [...ACCOUNT_KEY_COLUMNS, ["visitor_profiles", "account_id"] as [string, string]]) {
        if (tables.has(table)) db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(user.account_id);
      }
    }
    db.exec("COMMIT");
    // Open pages and sockets of theirs end now, not at their next request.
    if (revoked.length) authSessionEvents.emit("revoked", revoked);
    appendAuditEvent(db, { eventType: "auth.replicated_user.deleted", actorType: "system", entityType: "user", entityId: user.id, details: { homeNodeId } });
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Lists all replicated users on this node. */
export function listReplicatedUsers(): ReplicatedUserRecord[] {
  const db = authDatabase();
  const rows = db.prepare(`
    SELECT id, username, home_node_id, created_at, updated_at
    FROM users WHERE home_node_id IS NOT NULL ORDER BY username
  `).all() as unknown as Array<{ id: string; username: string; home_node_id: string; created_at: string; updated_at: string }>;
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    homeNodeId: row.home_node_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export interface LocalAccountCredentials {
  accountId: string;
  username: string;
  email: string | null;
  passwordHash: Buffer;
  passwordSalt: Buffer;
  mfaEnabled: boolean;
  mfaSecret?: string | null;
  updatedAt: string;
}

/** Only the home exports its accounts. The authenticated snapshot transport can include
    TOTP keys for offline verification; recovery codes and replay counters never travel. */
export function localAccountsForReplication(includeMfa = false): LocalAccountCredentials[] {
  const db = authDatabase();
  const rows = db.prepare(`SELECT users.username, users.email, users.password_hash, users.password_salt, users.updated_at, users.account_id, users.home_node_id,
      (SELECT secret_encrypted FROM user_mfa WHERE user_mfa.user_id = users.id) AS mfa
    FROM users WHERE home_node_id IS NULL AND disabled = 0 ORDER BY username`).all() as unknown as Array<{ username: string; email: string | null; password_hash: Uint8Array; password_salt: Uint8Array; updated_at: string; mfa: string | null; account_id: string | null; home_node_id: null }>;
  return rows.map((row) => ({ accountId: accountIdForRow(db, row), username: row.username, email: row.email, passwordHash: Buffer.from(row.password_hash), passwordSalt: Buffer.from(row.password_salt), mfaEnabled: Boolean(row.mfa), ...(includeMfa ? { mfaSecret: row.mfa ? decryptSecretValue(row.mfa) : null } : {}), updatedAt: row.updated_at }));
}
