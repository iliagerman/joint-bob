import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-directory.js";
import { encryptSecretValue, decryptSecretValue } from "./secrets.js";
import type { BrowserProfile, BrowserSessionRecord, BrowserSessionView, BrowserStart } from "./browser-types.js";

type Identity = { projectId?: string; engine?: string; conversationId?: string };
export type RecoveryState = { origins: string[]; activeIndex: number; human: string | null };
const recoveryHumanSchema = z.object({ human: z.string().min(1).max(500).nullable() });
const recoverySchema = z.object({
  origins: z.array(z.string().max(2048).refine(value => {
    if (value === "about:blank") return true;
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && url.origin === value; }
    catch { return false; }
  })).max(100),
  activeIndex: z.number().int().min(-1).max(99),
  human: recoveryHumanSchema.shape.human,
}).refine(value => value.origins.length ? value.activeIndex >= 0 && value.activeIndex < value.origins.length : value.activeIndex <= 0);

function validateRecovery(value: unknown): RecoveryState {
  const result = recoverySchema.safeParse(value);
  if (!result.success) throw new Error("Invalid browser recovery state");
  return result.data;
}
type SessionRow = Omit<BrowserSessionRecord, "restoreOnRestart" | "profileId" | "url" | "error"> & { profileId: string | null; url: string | null; error: string | null; restoreOnRestart: number; recovery: string };

/** Node-local metadata. Neither these tables nor encrypted login states replicate. */
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
      CREATE TABLE IF NOT EXISTS browser_profiles (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, label TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, stateEncrypted TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS browser_downloads (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, name TEXT NOT NULL, ready INTEGER NOT NULL, error TEXT
      );`);
    this.migrateProfiles();
  }

  private migrateProfiles(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.addColumn("browser_profiles", "persistent", "INTEGER NOT NULL DEFAULT 0");
      this.addColumn("browser_sessions", "restoreOnRestart", "INTEGER NOT NULL DEFAULT 0");
      const legacy = !this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'browser_running_profile'").get();
      this.addColumn("browser_sessions", "recovery", `TEXT NOT NULL DEFAULT '{"origins":[],"activeIndex":0,"human":null}'`);
      // Old ephemeral contexts could share one snapshot. Keep every historical row,
      // but retire their live leases before enforcing native profile exclusivity.
      if (legacy) this.db.exec("UPDATE browser_sessions SET state = 'interrupted', error = 'Legacy browser session interrupted; explicitly restart' WHERE state = 'running' AND restoreOnRestart = 0 AND (profileId IS NULL OR profileId IN (SELECT id FROM browser_profiles WHERE persistent = 0))");
      this.db.exec("DROP INDEX IF EXISTS browser_running_identity; CREATE UNIQUE INDEX IF NOT EXISTS browser_running_profile ON browser_sessions(profileId) WHERE state = 'running' OR restoreOnRestart = 1; COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); this.db.close(); throw error; }
  }

  private addColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some(row => row.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  interruptRunning(protectedProfiles: string[] = []): void {
    this.db.prepare(`UPDATE browser_sessions SET state = 'interrupted', updatedAt = ?, error = ? WHERE state = 'running'${protectedProfiles.length ? ` AND (profileId IS NULL OR profileId NOT IN (${protectedProfiles.map(() => "?").join(",")}))` : ""}`)
      .run(new Date().toISOString(), "Browser node stopped. Explicitly restart the session; saved profiles can restore login, not in-flight execution.", ...protectedProfiles);
    this.db.prepare("UPDATE browser_downloads SET error = 'Download interrupted by node restart' WHERE ready = 0 AND error IS NULL").run();

  }

  create(start: BrowserStart): BrowserSessionRecord {
    const now = new Date().toISOString();
    const persistent = start.profileId ? this.profile(start.profileId, start.projectId).persistent === true : false;
    const origin = !start.url || start.url === "about:blank" ? "about:blank" : new URL(start.url).origin;
    const recovery = validateRecovery({ origins: [origin], activeIndex: 0, human: null });
    const row = { ...start, url: start.url ? origin : undefined, id: randomUUID(), state: "running" as const, restoreOnRestart: persistent, createdAt: now, updatedAt: now };
    this.db.prepare("INSERT INTO browser_sessions (id, projectId, engine, conversationId, appNodeId, url, profileId, state, createdAt, updatedAt, restoreOnRestart, recovery) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(row.id, row.projectId, row.engine, row.conversationId, row.appNodeId, row.url ?? null, row.profileId ?? null, row.state, now, now, persistent ? 1 : 0, JSON.stringify(recovery));
    return row;
  }

  recovery(id: string): RecoveryState {
    const row = this.db.prepare("SELECT recovery FROM browser_sessions WHERE id = ?").get(id) as { recovery: string };
    let recovery: unknown;
    try { recovery = JSON.parse(row.recovery); }
    catch { throw new Error("Invalid browser recovery state"); }
    return validateRecovery(recovery);
  }

  recoveryHuman(id: string): string | null {
    // Validate ownership separately so invalid tab URLs do not conceal a pause.
    const row = this.db.prepare("SELECT recovery FROM browser_sessions WHERE id = ?").get(id) as { recovery: string };
    let recovery: unknown;
    try { recovery = JSON.parse(row.recovery); }
    catch { throw new Error("Invalid browser recovery ownership"); }
    const result = recoveryHumanSchema.safeParse(recovery);
    if (!result.success) throw new Error("Invalid browser recovery ownership");
    return result.data.human;
  }

  checkpoint(id: string, recovery: RecoveryState): void {
    this.db.prepare("UPDATE browser_sessions SET recovery = ?, updatedAt = ? WHERE id = ?").run(JSON.stringify(validateRecovery(recovery)), new Date().toISOString(), id);
  }

  resume(id: string): void {
    this.db.prepare("UPDATE browser_sessions SET state = 'running', error = NULL, restoreOnRestart = 1, updatedAt = ? WHERE id = ?").run(new Date().toISOString(), id);
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

  setRestoreIntent(id: string, restoreOnRestart: boolean): void {
    this.db.prepare("UPDATE browser_sessions SET restoreOnRestart = ? WHERE id = ?").run(restoreOnRestart ? 1 : 0, id);
  }

  finish(id: string, state: "closed" | "interrupted", error?: string, restoreOnRestart = false): void {
    this.db.prepare("UPDATE browser_sessions SET state = ?, error = ?, restoreOnRestart = ?, updatedAt = ? WHERE id = ?").run(state, error ?? null, restoreOnRestart ? 1 : 0, new Date().toISOString(), id);
  }

  profiles(projectId: string): BrowserProfile[] {
    const rows = this.db.prepare("SELECT id, projectId, label, createdAt, updatedAt, persistent FROM browser_profiles WHERE projectId = ? ORDER BY createdAt DESC").all(projectId) as unknown as BrowserProfile[];
    return rows.map(row => ({ ...row, persistent: Boolean(row.persistent) }));
  }

  saveProfile(projectId: string, label: string, state: unknown): BrowserProfile {
    const now = new Date().toISOString();
    const profile = { id: randomUUID(), projectId, label, createdAt: now, updatedAt: now, persistent: false };
    this.db.prepare("INSERT INTO browser_profiles (id, projectId, label, createdAt, updatedAt, stateEncrypted) VALUES (?,?,?,?,?,?)").run(profile.id, projectId, label, now, now, encryptSecretValue(JSON.stringify(state)));
    return profile;
  }

  profileState(id: string, projectId: string): unknown {
    const row = this.db.prepare("SELECT stateEncrypted FROM browser_profiles WHERE id = ? AND projectId = ?").get(id, projectId) as { stateEncrypted: string } | undefined;
    if (!row) throw new Error("Browser profile not found in this project");
    return JSON.parse(decryptSecretValue(row.stateEncrypted));
  }

  profile(id: string, projectId: string): BrowserProfile {
    const profile = this.profiles(projectId).find(row => row.id === id);
    if (!profile) throw new Error("Browser profile not found in this project");
    return profile;
  }

  private validateLabel(projectId: string, label: string, id?: string): string {
    label = label.trim();
    if (!label || label.length > 80) throw new Error("Profile name must contain 1..80 characters");
    if (this.profiles(projectId).some(row => row.id !== id && row.label === label)) throw new Error("Profile label already exists in this project");
    return label;
  }

  createProfile(projectId: string, label: string): BrowserProfile {
    const now = new Date().toISOString();
    const profile = { id: randomUUID(), projectId, label: this.validateLabel(projectId, label), createdAt: now, updatedAt: now, persistent: true };
    this.db.prepare("INSERT INTO browser_profiles (id, projectId, label, createdAt, updatedAt, stateEncrypted, persistent) VALUES (?,?,?,?,?,'',1)")
      .run(profile.id, projectId, profile.label, now, now);
    return profile;
  }

  renameProfile(id: string, projectId: string, label: string): BrowserProfile {
    this.profile(id, projectId);
    this.db.prepare("UPDATE browser_profiles SET label = ?, updatedAt = ? WHERE id = ?").run(this.validateLabel(projectId, label, id), new Date().toISOString(), id);
    return this.profile(id, projectId);
  }

  markPersistent(id: string, projectId: string): void {
    this.profile(id, projectId);
    this.db.prepare("UPDATE browser_profiles SET persistent = 1, stateEncrypted = '', updatedAt = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  assertProfileUnused(id: string, projectId: string): void {
    this.profile(id, projectId);
    if (this.db.prepare("SELECT id FROM browser_sessions WHERE profileId = ? AND (state = 'running' OR restoreOnRestart = 1)").get(id)) throw new Error("Browser profile in use by a running or restore-pending session");
  }

  deleteProfile(id: string, projectId: string): void {
    this.assertProfileUnused(id, projectId);
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
    const { recovery, ...record } = row;
    return { ...record, restoreOnRestart: Boolean(row.restoreOnRestart), url: row.url ?? undefined, profileId: row.profileId ?? undefined, error: row.error ?? undefined };
  }
}
