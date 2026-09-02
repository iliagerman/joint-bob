import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";
import { appendAuditEvent, ensureAuditSchema } from "./audit.js";

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

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
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

export function authenticate(username: string, password: string): AuthSession {
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
  const id = nanoid(32);
  const csrfToken = randomBytes(32).toString("hex");
  const now = new Date();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM login_attempts WHERE username = ?").run(normalizedUsername.toLowerCase());
    db.prepare(`
      INSERT INTO login_sessions (id, user_id, csrf_token, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, row.id, csrfToken, new Date(now.getTime() + sessionLifetimeMs).toISOString(), now.toISOString());
    appendAuditEvent(db, { eventType: "auth.login.succeeded", actorType: "user", actorId: row.id, entityType: "user", entityId: row.id });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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
