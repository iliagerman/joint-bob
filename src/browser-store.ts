import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-directory.js";
import { encryptSecretValue, decryptSecretValue } from "./secrets.js";
import { browserLoginRequestSchema, type BrowserLoginRequest, type BrowserProfile, type BrowserProfileGrant, type BrowserSessionRecord, type BrowserSessionView, type BrowserStart } from "./browser-types.js";

/** Conversation deletion drops that conversation's profile assignments everywhere
    on this node. The profile entities themselves are durable and stay. */
export function dropBrowserConversationGrants(projectId: string, conversationId: string): void {
  const store = new BrowserStore();
  try { store.dropConversationGrants(projectId, conversationId); }
  finally { store.close(); }
}

/** Same drop inside an existing node.db handle, for replication apply: the browser
    tables may not exist yet on a node that never opened a browser session. */
export function dropConversationGrantsInDatabase(db: DatabaseSync, projectId: string, conversationId: string): void {
  db.exec("CREATE TABLE IF NOT EXISTS browser_profile_grants (profileId TEXT NOT NULL, scope TEXT NOT NULL, projectId TEXT, conversationId TEXT, createdAt TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS browser_profile_grant_identity ON browser_profile_grants(profileId, scope, ifnull(projectId, ''), ifnull(conversationId, ''))");
  db.prepare("DELETE FROM browser_profile_grants WHERE scope = 'conversation' AND projectId = ? AND conversationId = ?").run(projectId, conversationId);
}

type Identity = { projectId?: string; engine?: string; conversationId?: string };
export type RecoveryState = { origins: string[]; activeIndex: number; human: string | null; credentialOrigins?: string[] };
const recoveryHumanSchema = z.object({ human: z.string().min(1).max(500).nullable() });
const recoverySchema = z.object({
  origins: z.array(z.string().max(2048).refine(value => {
    if (value === "about:blank") return true;
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && url.origin === value; }
    catch { return false; }
  })).max(100),
  activeIndex: z.number().int().min(-1).max(99),
  human: recoveryHumanSchema.shape.human,
  credentialOrigins: z.array(z.string().max(2048).refine(value => {
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && url.origin === value; }
    catch { return false; }
  })).max(1000).optional(),
}).refine(value => value.origins.length ? value.activeIndex >= 0 && value.activeIndex < value.origins.length : value.activeIndex <= 0);

function validateRecovery(value: unknown): RecoveryState {
  const result = recoverySchema.safeParse(value);
  if (!result.success) throw new Error("Invalid browser recovery state");
  return result.data;
}
type SessionRow = Omit<BrowserSessionRecord, "restoreOnRestart" | "profileId" | "url" | "error"> & { profileId: string | null; url: string | null; error: string | null; restoreOnRestart: number; recovery: string; loginRequest: string | null };

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
      CREATE TABLE IF NOT EXISTS browser_profile_grants (
        profileId TEXT NOT NULL, scope TEXT NOT NULL, projectId TEXT, conversationId TEXT, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS browser_migrations (
        id TEXT PRIMARY KEY, appliedAt TEXT NOT NULL
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
      this.addColumn("browser_profiles", "crossNodeAccess", "INTEGER NOT NULL DEFAULT 0");
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS browser_profile_grant_identity ON browser_profile_grants(profileId, scope, ifnull(projectId, ''), ifnull(conversationId, ''))");
      this.addColumn("browser_sessions", "restoreOnRestart", "INTEGER NOT NULL DEFAULT 0");
      this.addColumn("browser_sessions", "loginRequest", "TEXT");
      const legacy = !this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'browser_running_profile'").get();
      this.addColumn("browser_sessions", "recovery", `TEXT NOT NULL DEFAULT '{"origins":[],"activeIndex":0,"human":null}'`);
      // Old ephemeral contexts could share one snapshot. Keep every historical row,
      // but retire their live leases before enforcing native profile exclusivity.
      if (legacy) this.db.exec("UPDATE browser_sessions SET state = 'interrupted', error = 'Legacy browser session interrupted; explicitly restart' WHERE state = 'running' AND restoreOnRestart = 0 AND (profileId IS NULL OR profileId IN (SELECT id FROM browser_profiles WHERE persistent = 0))");
      this.db.exec("DROP INDEX IF EXISTS browser_running_identity; CREATE UNIQUE INDEX IF NOT EXISTS browser_running_profile ON browser_sessions(profileId) WHERE state = 'running' OR restoreOnRestart = 1");
      // Grants replace attachment-as-permission. Each pre-existing profile keeps exactly
      // the access it had: one conversation grant per distinct conversation that already
      // ran it, derived from its own session history. A profile no conversation ever ran
      // stays a dormant entity until granted. The marker table is browser-owned;
      // PRAGMA user_version belongs to the whole node.db and must stay shared.
      const applied = this.db.prepare("SELECT 1 FROM browser_migrations WHERE id = 'profile-grants-conversation-backfill'").get();
      if (!applied) {
        // One grant per distinct (profile, project, conversation). GROUP BY, not
        // DISTINCT: the row's createdAt must not widen the identity, or two sessions
        // of one conversation would violate the grant's unique index on upgrade.
        this.db.exec(`INSERT INTO browser_profile_grants (profileId, scope, projectId, conversationId, createdAt)
          SELECT session.profileId, 'conversation', session.projectId, session.conversationId, MAX(session.updatedAt)
          FROM browser_sessions session WHERE session.profileId IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM browser_profile_grants grant WHERE grant.profileId = session.profileId AND grant.scope = 'conversation' AND grant.projectId = session.projectId AND grant.conversationId = session.conversationId)
          GROUP BY session.profileId, session.projectId, session.conversationId`);
        // Profiles that predate grants keep the cross-node behavior they were built
        // with; only profiles created after this migration start node-only.
        this.db.exec("UPDATE browser_profiles SET crossNodeAccess = 1");
        this.db.prepare("INSERT OR IGNORE INTO browser_migrations (id, appliedAt) VALUES ('profile-grants-conversation-backfill', ?)").run(new Date().toISOString());
      }
      this.db.exec("COMMIT");
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
    const persistent = start.profileId ? this.profile(start.profileId).persistent === true : false;
    const origin = !start.url || start.url === "about:blank" ? "about:blank" : new URL(start.url).origin;
    const recovery = validateRecovery({ origins: [origin], activeIndex: 0, human: null });
    const row = { ...start, url: start.url ? origin : undefined, id: randomUUID(), state: "running" as const, restoreOnRestart: persistent, createdAt: now, updatedAt: now };
    try {
      this.db.prepare("INSERT INTO browser_sessions (id, projectId, engine, conversationId, appNodeId, url, profileId, state, createdAt, updatedAt, restoreOnRestart, recovery) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(row.id, row.projectId, row.engine, row.conversationId, row.appNodeId, row.url ?? null, row.profileId ?? null, row.state, now, now, persistent ? 1 : 0, JSON.stringify(recovery));
    } catch (error) {
      // The unique live lease means another conversation holds the profile.
      if (error instanceof Error && /UNIQUE constraint failed: browser_sessions.profileId/.test(error.message)) throw new Error("Browser profile is already active in another conversation. Close it there first.");
      throw error;
    }
    return row;
  }

  loginRequest(id: string): BrowserLoginRequest | null {
    this.get(id);
    const row = this.db.prepare("SELECT loginRequest FROM browser_sessions WHERE id = ?").get(id) as { loginRequest: string | null };
    if (row.loginRequest === null) return null;
    try { return browserLoginRequestSchema.parse(JSON.parse(row.loginRequest)); }
    catch { throw new Error("Invalid browser login request"); }
  }

  setLoginRequest(id: string, request: BrowserLoginRequest | null): void {
    this.get(id);
    const value = request === null ? null : JSON.stringify(browserLoginRequestSchema.parse(request));
    this.db.prepare("UPDATE browser_sessions SET loginRequest = ?, updatedAt = ? WHERE id = ?").run(value, new Date().toISOString(), id);
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

  // Removes a stopped session record and its download history. A running or
  // restore-pending session must be closed first, so its live lease and any
  // automatic restore intent are gone before the row disappears.
  forget(id: string): void {
    const row = this.get(id);
    if (row.state === "running" || row.restoreOnRestart) throw new Error("Close the browser before removing its session");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM browser_downloads WHERE sessionId = ?").run(id);
      this.db.prepare("DELETE FROM browser_sessions WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  profiles(projectId: string): BrowserProfile[] {
    const rows = this.db.prepare("SELECT id, projectId, label, createdAt, updatedAt, persistent, crossNodeAccess FROM browser_profiles WHERE projectId = ? ORDER BY createdAt DESC").all(projectId) as unknown as BrowserProfile[];
    return rows.map(row => ({ ...row, persistent: Boolean(row.persistent), crossNodeAccess: Boolean(row.crossNodeAccess) }));
  }

  profile(id: string): BrowserProfile {
    const row = this.db.prepare("SELECT id, projectId, label, createdAt, updatedAt, persistent, crossNodeAccess FROM browser_profiles WHERE id = ?").get(id) as unknown as BrowserProfile | undefined;
    if (!row) throw new Error("Browser profile not found");
    return { ...row, persistent: Boolean(row.persistent), crossNodeAccess: Boolean(row.crossNodeAccess) };
  }

  profileOrNull(id: string | undefined | null): BrowserProfile | null {
    if (!id) return null;
    try { return this.profile(id); } catch { return null; }
  }

  profileGrants(id: string): BrowserProfileGrant[] {
    this.profile(id);
    return (this.db.prepare("SELECT scope, projectId, conversationId, createdAt FROM browser_profile_grants WHERE profileId = ? ORDER BY createdAt, scope").all(id) as unknown as Array<BrowserProfileGrant>).map(grant => ({
      scope: grant.scope,
      ...(grant.projectId ? { projectId: grant.projectId } : {}),
      ...(grant.conversationId ? { conversationId: grant.conversationId } : {}),
      createdAt: grant.createdAt,
    }));
  }

  private validateGrant(id: string, grant: Pick<BrowserProfileGrant, "scope" | "projectId" | "conversationId">): { scope: BrowserProfileGrant["scope"]; projectId: string | null; conversationId: string | null } {
    this.profile(id);
    const identifier = (value: string | undefined, max = 200) => typeof value === "string" && value.length >= 1 && value.length <= max ? value : null;
    if (grant.scope === "global") {
      if (grant.projectId !== undefined || grant.conversationId !== undefined) throw new Error("A global grant takes no project or conversation");
      return { scope: grant.scope, projectId: null, conversationId: null };
    }
    if (grant.scope === "project") {
      const projectId = identifier(grant.projectId);
      if (!projectId || grant.conversationId !== undefined) throw new Error("A project grant takes exactly a project");
      return { scope: grant.scope, projectId, conversationId: null };
    }
    if (grant.scope === "conversation") {
      const projectId = identifier(grant.projectId), conversationId = identifier(grant.conversationId);
      if (!projectId || !conversationId) throw new Error("A conversation grant takes exactly a project and a conversation");
      return { scope: grant.scope, projectId, conversationId };
    }
    throw new Error("Unknown browser profile grant scope");
  }

  grantProfileAccess(id: string, grant: Pick<BrowserProfileGrant, "scope" | "projectId" | "conversationId">): BrowserProfileGrant[] {
    const valid = this.validateGrant(id, grant);
    this.db.prepare("INSERT OR IGNORE INTO browser_profile_grants (profileId, scope, projectId, conversationId, createdAt) VALUES (?,?,?,?,?)")
      .run(id, valid.scope, valid.projectId, valid.conversationId, new Date().toISOString());
    return this.profileGrants(id);
  }

  revokeProfileAccess(id: string, grant: Pick<BrowserProfileGrant, "scope" | "projectId" | "conversationId">): BrowserProfileGrant[] {
    const valid = this.validateGrant(id, grant);
    const changes = this.db.prepare("DELETE FROM browser_profile_grants WHERE profileId = ? AND scope = ? AND ifnull(projectId, '') = ? AND ifnull(conversationId, '') = ?")
      .run(id, valid.scope, valid.projectId ?? "", valid.conversationId ?? "").changes;
    if (!changes) throw new Error("Browser profile grant not found");
    return this.profileGrants(id);
  }

  setProfileCrossNode(id: string, allowed: boolean): BrowserProfile {
    this.profile(id);
    this.db.prepare("UPDATE browser_profiles SET crossNodeAccess = ?, updatedAt = ? WHERE id = ?").run(allowed ? 1 : 0, new Date().toISOString(), id);
    return this.profile(id);
  }

  profileUsable(id: string, projectId: string, conversationId?: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM browser_profile_grants WHERE profileId = ? AND (
      scope = 'global' OR (scope = 'project' AND projectId = ?)${conversationId ? " OR (scope = 'conversation' AND projectId = ? AND conversationId = ?)" : ""}
    ) LIMIT 1`).get(id, projectId, ...(conversationId ? [projectId, conversationId] : [])));
  }

  usableProfiles(projectId: string, conversationId?: string): BrowserProfile[] {
    return this.profiles(projectId)
      .concat((this.db.prepare(`SELECT DISTINCT browser_profiles.id FROM browser_profiles JOIN browser_profile_grants ON browser_profile_grants.profileId = browser_profiles.id
        WHERE browser_profiles.projectId != ? AND (scope = 'global' OR (scope = 'project' AND browser_profile_grants.projectId = ?)${conversationId ? " OR (scope = 'conversation' AND browser_profile_grants.projectId = ? AND conversationId = ?)" : ""})`)
        .all(projectId, projectId, ...(conversationId ? [projectId, conversationId] : [])) as unknown as Array<{ id: string }>).map(({ id }) => this.profile(id)))
      .filter((profile, index, all) => all.findIndex(other => other.id === profile.id) === index)
      .filter(profile => this.profileUsable(profile.id, projectId, conversationId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(profile => ({ ...profile, grants: this.profileGrants(profile.id) }));
  }

  /** Deleting a conversation drops its conversation-scoped assignments. The durable
      entity, project grants, and other conversations' assignments are untouched. */
  dropConversationGrants(projectId: string, conversationId: string): number {
    return Number(this.db.prepare("DELETE FROM browser_profile_grants WHERE scope = 'conversation' AND projectId = ? AND conversationId = ?").run(projectId, conversationId).changes);
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

  private validateLabel(projectId: string, label: string, id?: string): string {
    label = label.trim();
    if (!label || label.length > 80) throw new Error("Profile name must contain 1..80 characters");
    if (this.profiles(projectId).some(row => row.id !== id && row.label === label)) throw new Error("Profile label already exists in this project");
    return label;
  }

  createProfile(projectId: string, label: string, crossNodeAccess = false): BrowserProfile {
    const now = new Date().toISOString();
    const profile = { id: randomUUID(), projectId, label: this.validateLabel(projectId, label), createdAt: now, updatedAt: now, persistent: true, crossNodeAccess };
    this.db.prepare("INSERT INTO browser_profiles (id, projectId, label, createdAt, updatedAt, stateEncrypted, persistent, crossNodeAccess) VALUES (?,?,?,?,?,'',1,?)")
      .run(profile.id, profile.projectId, profile.label, now, now, crossNodeAccess ? 1 : 0);
    return profile;
  }

  renameProfile(id: string, label: string): BrowserProfile {
    const home = this.profile(id).projectId;
    this.db.prepare("UPDATE browser_profiles SET label = ?, updatedAt = ? WHERE id = ?").run(this.validateLabel(home, label, id), new Date().toISOString(), id);
    return this.profile(id);
  }

  markPersistent(id: string): void {
    this.profile(id);
    this.db.prepare("UPDATE browser_profiles SET persistent = 1, stateEncrypted = '', updatedAt = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  assertProfileUnused(id: string): void {
    this.profile(id);
    if (this.db.prepare("SELECT id FROM browser_sessions WHERE profileId = ? AND (state = 'running' OR restoreOnRestart = 1)").get(id)) throw new Error("Browser profile in use by a running or restore-pending session");
  }

  deleteProfile(id: string, projectId: string): void {
    this.assertProfileDeletable(id, projectId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM browser_profile_grants WHERE profileId = ?").run(id);
      this.db.prepare("DELETE FROM browser_profiles WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /** Full delete precondition, separated so callers can validate before any
      filesystem removal: not live, and reachable from this project. */
  assertProfileDeletable(id: string, projectId: string): void {
    this.assertProfileUnused(id);
    // The entity can be deleted from its home project or any project it is granted to.
    if (this.profile(id).projectId !== projectId && !this.profileUsable(id, projectId)) throw new Error("Browser profile not found in this project");
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
    const { recovery, loginRequest, ...record } = row;
    return { ...record, restoreOnRestart: Boolean(row.restoreOnRestart), url: row.url ?? undefined, profileId: row.profileId ?? undefined, error: row.error ?? undefined };
  }
}
