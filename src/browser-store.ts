import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-directory.js";
import { encryptSecretValue, decryptSecretValue } from "./secrets.js";
import type { BrowserProfile, BrowserSessionRecord, BrowserSessionView, BrowserStart } from "./browser-types.js";

type Identity = { projectId?: string; engine?: string; conversationId?: string };
type SessionRow = BrowserSessionRecord & { profileId: string | null; url: string | null; error: string | null };

/** Executor-only metadata. Neither these tables nor encrypted login states replicate. */
export class BrowserStore {
  private readonly db: DatabaseSync;

  constructor() {
    const root = resolveDataDirectory();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(root, "node.db"));
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS browser_sessions (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, engine TEXT NOT NULL, conversationId TEXT NOT NULL,
        appNodeId TEXT NOT NULL, url TEXT, profileId TEXT, state TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS browser_running_identity ON browser_sessions(projectId,conversationId) WHERE state = 'running';
      CREATE TABLE IF NOT EXISTS browser_profiles (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, label TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, stateEncrypted TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS browser_downloads (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, name TEXT NOT NULL, ready INTEGER NOT NULL, error TEXT
      );`);
  }

  interruptRunning(): void {
    this.db.prepare("UPDATE browser_sessions SET state = 'interrupted', updatedAt = ?, error = ? WHERE state = 'running'")
      .run(new Date().toISOString(), "Browser executor stopped. Explicitly restart the session; saved profiles can restore login, not in-flight execution.");
    this.db.prepare("UPDATE browser_downloads SET error = 'Download interrupted by executor restart' WHERE ready = 0 AND error IS NULL").run();
    // Upgrade early executor databases whose uniqueness also included the harness.
    this.db.exec("DROP INDEX IF EXISTS browser_running_identity; CREATE UNIQUE INDEX browser_running_identity ON browser_sessions(projectId,conversationId) WHERE state = 'running'");
  }

  create(start: BrowserStart): BrowserSessionRecord {
    const now = new Date().toISOString();
    const row: BrowserSessionRecord = { ...start, id: randomUUID(), state: "running", createdAt: now, updatedAt: now };
    this.db.prepare("INSERT INTO browser_sessions (id, projectId, engine, conversationId, appNodeId, url, profileId, state, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(row.id, row.projectId, row.engine, row.conversationId, row.appNodeId, row.url ?? null, row.profileId ?? null, row.state, now, now);
    return row;
  }

  get(id: string): BrowserSessionRecord {
    const row = this.db.prepare("SELECT * FROM browser_sessions WHERE id = ?").get(id) as unknown as SessionRow | undefined;
    if (!row) throw new Error("Browser session not found");
    return this.record(row);
  }

  list(identity: Identity = {}): BrowserSessionRecord[] {
    const fields = ["projectId", "engine", "conversationId"] as const;
    // Harness segments share one logical conversation, including its paused owner.
    const selected = fields.filter(field => identity[field] !== undefined && !(field === "engine" && identity.conversationId !== undefined));
    const rows = this.db.prepare(`SELECT * FROM browser_sessions${selected.length ? ` WHERE ${selected.map(field => `${field} = ?`).join(" AND ")}` : ""} ORDER BY createdAt DESC`)
      .all(...selected.map(field => identity[field]!)) as unknown as SessionRow[];
    return rows.map(row => this.record(row));
  }

  finish(id: string, state: "closed" | "interrupted", error?: string): void {
    this.db.prepare("UPDATE browser_sessions SET state = ?, error = ?, updatedAt = ? WHERE id = ?").run(state, error ?? null, new Date().toISOString(), id);
  }

  profiles(projectId: string): BrowserProfile[] {
    const rows = this.db.prepare("SELECT id, projectId, label, createdAt, updatedAt FROM browser_profiles WHERE projectId = ? ORDER BY createdAt DESC").all(projectId) as unknown as BrowserProfile[];
    return rows.map(row => ({ ...row }));
  }

  saveProfile(projectId: string, label: string, state: unknown): BrowserProfile {
    const now = new Date().toISOString();
    const profile = { id: randomUUID(), projectId, label, createdAt: now, updatedAt: now };
    this.db.prepare("INSERT INTO browser_profiles VALUES (?,?,?,?,?,?)").run(profile.id, projectId, label, now, now, encryptSecretValue(JSON.stringify(state)));
    return profile;
  }

  profileState(id: string, projectId: string): unknown {
    const row = this.db.prepare("SELECT stateEncrypted FROM browser_profiles WHERE id = ? AND projectId = ?").get(id, projectId) as { stateEncrypted: string } | undefined;
    if (!row) throw new Error("Browser profile not found in this project");
    return JSON.parse(decryptSecretValue(row.stateEncrypted));
  }

  deleteProfile(id: string, projectId: string): void {
    if (!this.db.prepare("DELETE FROM browser_profiles WHERE id = ? AND projectId = ?").run(id, projectId).changes) throw new Error("Browser profile not found in this project");
  }

  saveDownload(sessionId: string, item: BrowserSessionView["downloads"][number]): void {
    this.db.prepare("INSERT INTO browser_downloads (id, sessionId, name, ready, error) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ready = excluded.ready, error = excluded.error")
      .run(item.id, sessionId, item.name, item.ready ? 1 : 0, item.error ?? null);
  }

  downloads(sessionId: string): BrowserSessionView["downloads"] {
    const rows = this.db.prepare("SELECT id, name, ready, error FROM browser_downloads WHERE sessionId = ? ORDER BY rowid").all(sessionId) as unknown as Array<{ id: string; name: string; ready: number; error: string | null }>;
    return rows.map(row => ({ id: row.id, name: row.name, ready: Boolean(row.ready), ...(row.error ? { error: row.error } : {}) }));
  }

  close(): void { this.db.close(); }

  private record(row: SessionRow): BrowserSessionRecord {
    return { ...row, url: row.url ?? undefined, profileId: row.profileId ?? undefined, error: row.error ?? undefined };
  }
}
