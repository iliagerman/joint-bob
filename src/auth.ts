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
}

export interface AuthSession {
  id: string;
  userId: string;
  username: string;
  csrfToken: string;
  mustChangePassword: boolean;
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
}

interface SessionRow {
  id: string;
  user_id: string;
  username: string;
  csrf_token: string;
  must_change_password: number;
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
  ensureAuditSchema(database);
  return database;
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

function configuredAdministrator(): { username: string; password: string } | undefined {
  const username = (process.env.JOINT_BOB_ADMIN_USERNAME ?? process.env.MASTER_BOB_ADMIN_USERNAME)?.trim();
  const password = process.env.JOINT_BOB_INITIAL_PASSWORD ?? process.env.MASTER_BOB_INITIAL_PASSWORD;
  if (!username || !password) return undefined;
  if (!validUsername(username)) throw new Error("JOINT_BOB_ADMIN_USERNAME must be 3-80 letters, numbers, dots, underscores, or hyphens");
  if (!validPassword(password)) throw new Error("JOINT_BOB_INITIAL_PASSWORD must be at least 16 characters");
  return { username, password };
}

export function createAdministrator(username: string, password: string, mustChangePassword = true): void {
  if (!validUsername(username)) throw new Error("Username must be 3-80 letters, numbers, dots, underscores, or hyphens");
  if (!validPassword(password)) throw new Error("Password must be 16-200 characters");
  const db = authDatabase();
  if (userCount(db) !== 0) throw new Error("An administrator already exists");
  const now = new Date().toISOString();
  const salt = randomBytes(16);
  db.prepare(`
    INSERT INTO users (id, username, password_hash, password_salt, must_change_password, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(nanoid(18), username, passwordDigest(password, salt), salt, mustChangePassword ? 1 : 0, now, now);
}

function ensureConfiguredAdministrator(): void {
  if (userCount(authDatabase()) !== 0) return;
  const administrator = configuredAdministrator();
  if (administrator) createAdministrator(administrator.username, administrator.password);
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
    };
  }
  return { authenticated: false, setupRequired: userCount(authDatabase()) === 0 };
}

export function authenticate(username: string, password: string): AuthSession | MfaLoginChallenge {
  ensureConfiguredAdministrator();
  const db = authDatabase();
  const normalizedUsername = username.trim();
  const row = parseUser(db.prepare("SELECT * FROM users WHERE username = ?").get(normalizedUsername) as UserRow | undefined);
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
  db.prepare("INSERT INTO login_sessions (id, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, row.id, csrfToken, new Date(now.getTime() + sessionLifetimeMs).toISOString(), now.toISOString());
  appendAuditEvent(db, { eventType: "auth.login.succeeded", actorType: "user", actorId: row.id, entityType: "user", entityId: row.id });
  return { id, userId: row.id, username: row.username, csrfToken, mustChangePassword: row.must_change_password === 1 };
}

export function sessionForId(sessionId: string | undefined): AuthSession | undefined {
  if (!sessionId) return undefined;
  const now = new Date().toISOString();
  authDatabase().prepare("DELETE FROM login_sessions WHERE expires_at <= ?").run(now);
  const row = authDatabase().prepare(`
    SELECT login_sessions.id, login_sessions.user_id, users.username, login_sessions.csrf_token, users.must_change_password
    FROM login_sessions JOIN users ON users.id = login_sessions.user_id
    WHERE login_sessions.id = ? AND login_sessions.expires_at > ?
  `).get(sessionId, now) as SessionRow | undefined;
  if (!row) return undefined;
  return { id: row.id, userId: row.user_id, username: row.username, csrfToken: row.csrf_token, mustChangePassword: row.must_change_password === 1 };
}

/** The cluster-stable reviewer identity: usernames match across nodes even though user ids do not. */
export function usernameForUser(userId: string): string | undefined {
  return (authDatabase().prepare("SELECT username FROM users WHERE id = ?").get(userId) as { username: string } | undefined)?.username;
}

export function userIdForUsername(username: string): string | undefined {
  return (authDatabase().prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username) as { id: string } | undefined)?.id;
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
