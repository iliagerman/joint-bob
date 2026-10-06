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

export class AuthError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}

export interface MfaLoginChallenge { mfaRequired: true; challenge: string }
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

function validUsername(username: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/.test(username);
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

function isRateLimited(username: string): boolean {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const count = authDatabase().prepare("SELECT COUNT(*) AS count FROM login_attempts WHERE username = ? AND attempted_at >= ?")
    .get(username.toLowerCase(), cutoff) as { count: number };
  return count.count >= 5;
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

export function authenticate(username: string, password: string): AuthSession | MfaLoginChallenge {
  ensureConfiguredAdministrator();
  const db = authDatabase();
  const normalizedUsername = username.trim();
  // Either the username or the email signs in; both are unique on a node.
  const row = parseUser(db.prepare("SELECT * FROM users WHERE username = ? OR (instr(?, '@') > 0 AND email = ? COLLATE NOCASE)").get(normalizedUsername, normalizedUsername, normalizedUsername) as UserRow | undefined);
  if (isRateLimited(normalizedUsername)) {
    appendAuditEvent(db, { eventType: "auth.login.rate_limited", actorType: "system", entityType: "auth.login", details: { knownUser: Boolean(row) } });
    throw new Error("Too many login attempts. Try again in 15 minutes");
  }
  if (!row || !timingSafeEqual(passwordDigest(password, row.password_salt), row.password_hash)) {
    db.exec("BEGIN");
    try {
      recordLoginAttempt(db, normalizedUsername);
      appendAuditEvent(db, { eventType: "auth.login.failed", actorType: "system", entityType: "auth.login", details: { knownUser: Boolean(row) } });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    throw new Error("Invalid username or password");
  }
  if (row.home_node_id !== null && row.remote_mfa === 1) {
    throw new AuthError(403, "This account uses two-factor sign-in, which works only on its home node for now");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM login_attempts WHERE username = ?").run(normalizedUsername.toLowerCase());
    if (mfaStatus(row.id).enabled) {
      checkMfaRateLimit(row.id);
      const challenge = randomBytes(32).toString("base64url");
      db.prepare("DELETE FROM mfa_login_challenges WHERE expires_at <= ? OR user_id = ?").run(new Date().toISOString(), row.id);
      db.prepare("INSERT INTO mfa_login_challenges (challenge_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .run(digest(challenge), row.id, new Date(Date.now() + 5 * 60_000).toISOString());
      db.exec("COMMIT");
      return { mfaRequired: true, challenge };
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
    WHERE login_sessions.id = ? AND login_sessions.expires_at > ?
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

export function completeMfaLogin(challenge: string, code: string): AuthSession {
  const db = authDatabase();
  const hash = digest(challenge);
  const row = db.prepare("SELECT users.* FROM mfa_login_challenges JOIN users ON users.id = user_id WHERE challenge_hash = ? AND expires_at > ?")
    .get(hash, new Date().toISOString()) as UserRow | undefined;
  if (!row) throw new AuthError(401, "Sign-in expired. Go back and enter your password again");
  return mfaAction(row.id, (db) => {
    const claimed = db.prepare("DELETE FROM mfa_login_challenges WHERE challenge_hash = ? AND expires_at > ?").run(hash, new Date().toISOString());
    if (claimed.changes !== 1) throw new AuthError(401, "Sign-in expired. Go back and enter your password again");
    if (!consumeMfaCode(db, row.id, code)) throw new AuthError(401, "Invalid or already used code. Use a fresh authenticator code or an unused recovery code");
    return createLoginSession(db, row);
  });
}

export function beginMfaSetup(session: AuthSession, currentPassword: string): { secret: string; otpauthUri: string } {
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

export function sessionCookieValue(session: AuthSession): string {
  return `${sessionCookieName}=${session.id}; Path=/; HttpOnly;${secureAttribute} SameSite=Strict; Max-Age=${Math.floor(sessionLifetimeMs / 1000)}`;
}

export function clearSessionCookieValue(): string {
  return `${sessionCookieName}=; Path=/; HttpOnly;${secureAttribute} SameSite=Strict; Max-Age=0`;
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
  /** The home node requires a second factor; this node can't verify it, so it refuses sign-in. */
  mfaRequired: boolean;
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
  const email = input.email === null ? null : normalizeEmail(input.email);
  if (email !== null && !validEmail(email)) throw new Error("Invalid email for replicated user");
  const db = authDatabase();
  const now = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT id, home_node_id FROM users WHERE username = ? COLLATE NOCASE").get(input.username) as { id: string; home_node_id: string | null } | undefined;
    if (existing && existing.home_node_id === null) throw new Error("Cannot overwrite the home user with a replicated user");
    if (existing && existing.home_node_id !== input.homeNodeId) throw new Error("Username conflict: replicated user from different home node");
    if (email !== null && emailTaken(db, email, existing?.id)) throw new Error("Email conflict: another account on this node uses that email");
    const id = existing?.id ?? nanoid(18);
    if (existing) {
      db.prepare("UPDATE users SET password_hash = ?, password_salt = ?, email = ?, remote_mfa = ?, account_id = ?, updated_at = ? WHERE id = ?")
        .run(input.passwordHash, input.passwordSalt, email, input.mfaRequired ? 1 : 0, input.accountId, now, id);
    } else {
      db.prepare(`INSERT INTO users (id, username, password_hash, password_salt, must_change_password, home_node_id, email, remote_mfa, account_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`).run(id, input.username, input.passwordHash, input.passwordSalt, input.homeNodeId, email, input.mfaRequired ? 1 : 0, input.accountId, now, now);
    }
    appendAuditEvent(db, { eventType: existing ? "auth.replicated_user.updated" : "auth.replicated_user.created", actorType: "system", entityType: "user", entityId: id, details: { homeNodeId: input.homeNodeId } });
    db.exec("COMMIT");
    return { id, username: input.username, homeNodeId: input.homeNodeId, createdAt: now, updatedAt: now };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Removes a replicated user and all their sessions. */
export function deleteReplicatedUser(homeNodeId: string, username: string): boolean {
  const db = authDatabase();
  const user = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE AND home_node_id = ?").get(username, homeNodeId) as { id: string } | undefined;
  if (!user) return false;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM login_sessions WHERE user_id = ?").run(user.id);
    db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
    db.exec("COMMIT");
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
  updatedAt: string;
}

/** Every local account's sign-in record, for the nodes it may sign in to. MFA secrets are
    encrypted with this node's key and never travel; a peer only learns MFA is required. */
export function localAccountsForReplication(): LocalAccountCredentials[] {
  const db = authDatabase();
  const rows = db.prepare(`SELECT users.username, users.email, users.password_hash, users.password_salt, users.updated_at, users.account_id, users.home_node_id,
      EXISTS (SELECT 1 FROM user_mfa WHERE user_mfa.user_id = users.id) AS mfa
    FROM users WHERE home_node_id IS NULL ORDER BY username`).all() as unknown as Array<{ username: string; email: string | null; password_hash: Uint8Array; password_salt: Uint8Array; updated_at: string; mfa: number; account_id: string | null; home_node_id: null }>;
  return rows.map((row) => ({ accountId: accountIdForRow(db, row), username: row.username, email: row.email, passwordHash: Buffer.from(row.password_hash), passwordSalt: Buffer.from(row.password_salt), mfaEnabled: row.mfa === 1, updatedAt: row.updated_at }));
}
