import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One conversation the user opened, newest first, capped by the client. */
export interface RecentSession {
  projectId: string;
  sessionPath: string;
  title: string;
  openedAt: string;
  /** When the conversation itself last moved; null for entries stored before this was tracked. */
  updatedAt: string | null;
}

export interface CanvasPanePreference {
  kind: "pane";
  id: string;
  projectId: string;
  sessionPath: string;
  sessionId: string;
  executionNodeId: string | null;
}

/** A row of the uniform canvas grid. It carries nothing but its panes: every row is
 * the same height and every pane in a row is the same width, so the grid is always
 * completely filled and no stored geometry can leave an empty space. */
export interface CanvasRowPreference {
  id: string;
  panes: CanvasPanePreference[];
}

export interface CanvasLayoutPreference {
  version: 4;
  rows: CanvasRowPreference[];
  focusedPaneId: string | null;
}

const emptyCanvasLayout = (): CanvasLayoutPreference => ({ version: 4, rows: [], focusedPaneId: null });

export interface UserPreferences {
  theme: "light" | "dark" | null;
  notificationsEnabled: boolean;
  completionSound: "off" | "chime" | "bell";
  installDismissed: boolean;
  mobileView: "projects" | "sessions" | "board" | "chat" | "canvas";
  activeProjectId: string | null;
  activeSessionPath: string | null;
  activeSessionId: string | null;
  activeNodeId: string | null;
  legacyMigrated: boolean;
  pinnedProjectIds: string[];
  pinnedSessionPaths: string[];
  projectsPanelCollapsed: boolean;
  chatsPanelCollapsed: boolean;
  recentSessions: RecentSession[];
  lastSeenVersion: string | null;
  canvasLayout: CanvasLayoutPreference;
}

interface PreferenceRow {
  theme: UserPreferences["theme"];
  notifications_enabled: number;
  completion_sound: UserPreferences["completionSound"];
  install_dismissed: number;
  mobile_view: UserPreferences["mobileView"];
  active_project_id: string | null;
  active_session_path: string | null;
  active_session_id: string | null;
  active_node_id: string | null;
  legacy_migrated: number;
  pinned_project_ids: string;
  pinned_session_paths: string;
  projects_panel_collapsed: number;
  chats_panel_collapsed: number;
  recent_sessions: string;
  last_seen_version: string | null;
  canvas_layout: string;
}

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
let database: DatabaseSync | undefined;

function preferencesDatabase(): DatabaseSync {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      theme TEXT,
      notifications_enabled INTEGER NOT NULL DEFAULT 0,
      completion_sound TEXT NOT NULL DEFAULT 'chime',
      install_dismissed INTEGER NOT NULL DEFAULT 0,
      mobile_view TEXT NOT NULL DEFAULT 'projects',
      active_project_id TEXT,
      active_session_path TEXT,
      active_session_id TEXT,
      active_node_id TEXT,
      legacy_migrated INTEGER NOT NULL DEFAULT 0,
      pinned_project_ids TEXT NOT NULL DEFAULT '[]',
      pinned_session_paths TEXT NOT NULL DEFAULT '[]',
      projects_panel_collapsed INTEGER NOT NULL DEFAULT 0,
      chats_panel_collapsed INTEGER NOT NULL DEFAULT 0,
      canvas_layout TEXT NOT NULL DEFAULT '{"version":1,"root":null,"focusedPaneId":null}',
      updated_at TEXT NOT NULL
    );
  `);
  const columns = database.prepare("PRAGMA table_info(user_preferences)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "completion_sound")) database.exec("ALTER TABLE user_preferences ADD COLUMN completion_sound TEXT NOT NULL DEFAULT 'chime'");
  if (!columns.some((column) => column.name === "active_session_id")) database.exec("ALTER TABLE user_preferences ADD COLUMN active_session_id TEXT");
  if (!columns.some((column) => column.name === "active_node_id")) database.exec("ALTER TABLE user_preferences ADD COLUMN active_node_id TEXT");
  if (!columns.some((column) => column.name === "pinned_project_ids")) database.exec("ALTER TABLE user_preferences ADD COLUMN pinned_project_ids TEXT NOT NULL DEFAULT '[]'");
  if (!columns.some((column) => column.name === "pinned_session_paths")) database.exec("ALTER TABLE user_preferences ADD COLUMN pinned_session_paths TEXT NOT NULL DEFAULT '[]'");
  if (!columns.some((column) => column.name === "projects_panel_collapsed")) database.exec("ALTER TABLE user_preferences ADD COLUMN projects_panel_collapsed INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "chats_panel_collapsed")) database.exec("ALTER TABLE user_preferences ADD COLUMN chats_panel_collapsed INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "recent_sessions")) database.exec("ALTER TABLE user_preferences ADD COLUMN recent_sessions TEXT NOT NULL DEFAULT '[]'");
  if (!columns.some((column) => column.name === "last_seen_version")) database.exec("ALTER TABLE user_preferences ADD COLUMN last_seen_version TEXT");
  if (!columns.some((column) => column.name === "canvas_layout")) database.exec("ALTER TABLE user_preferences ADD COLUMN canvas_layout TEXT NOT NULL DEFAULT '{\"version\":1,\"root\":null,\"focusedPaneId\":null}'");
  return database;
}

function ensurePreferences(userId: string): void {
  preferencesDatabase().prepare(`
    INSERT INTO user_preferences (user_id, updated_at)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO NOTHING
  `).run(userId, new Date().toISOString());
}

/** Stored as a JSON array in one column; a hand-edited row must not take the app down. */
function parseStringList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function canonicalSessionPath(sessionPath: string): string {
  return sessionPath.replace(/\.sync-conflict-[^/\\]+(?=\.jsonl$)/, "");
}

function canonicalRecentSessions(sessions: RecentSession[]): RecentSession[] {
  const identities = new Set<string>();
  return sessions.flatMap((entry) => {
    const canonicalEntry = { ...entry, sessionPath: canonicalSessionPath(entry.sessionPath), updatedAt: entry.updatedAt ?? null };
    const identity = `${entry.projectId}\0${canonicalEntry.sessionPath}`;
    if (identities.has(identity)) return [];
    identities.add(identity);
    return [canonicalEntry];
  });
}

/** Same hand-edited-row tolerance as parseStringList, for the recents object list. */
function parseRecentSessions(value: string): RecentSession[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const sessions = parsed.filter((entry): entry is RecentSession =>
      typeof entry === "object"
      && entry !== null
      && typeof entry.projectId === "string"
      && typeof entry.sessionPath === "string"
      && typeof entry.title === "string"
      && typeof entry.openedAt === "string");
    return canonicalRecentSessions(sessions);
  } catch {
    return [];
  }
}

/** A hand-edited canvas row must degrade to an empty canvas, never take the node down.
 * Version 1 split trees are accepted and flattened into rows, matching the client. */
function parseCanvasLayout(value: string): CanvasLayoutPreference {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyCanvasLayout();
    if ((parsed as { version?: unknown }).version === 1) return migrateLegacyCanvasLayout(parsed);
    const layout = parsed as CanvasLayoutPreference;
    const ids = new Set<string>();
    const sessionIdentities = new Set<string>();
    const pathIdentities = new Set<string>();
    const paneIds = new Set<string>();
    if (!Array.isArray(layout.rows) || layout.rows.length > 10) return emptyCanvasLayout();
    const rows: CanvasRowPreference[] = [];
    for (const row of layout.rows) {
      if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id || row.id.length > 200 || ids.has(row.id)) return emptyCanvasLayout();
      ids.add(row.id);
      if (!Array.isArray(row.panes) || row.panes.length < 1 || row.panes.length > 8) return emptyCanvasLayout();
      const panes: CanvasPanePreference[] = [];
      for (const item of row.panes) {
        if (!item || typeof item !== "object") return emptyCanvasLayout();
        if (typeof item.id !== "string" || !item.id || item.id.length > 200 || ids.has(item.id)) return emptyCanvasLayout();
        ids.add(item.id);
        if (item.kind !== "pane"
          || typeof item.projectId !== "string" || !item.projectId || item.projectId.length > 120
          || typeof item.sessionPath !== "string" || !item.sessionPath || item.sessionPath.length > 2000
          || typeof item.sessionId !== "string" || !item.sessionId || item.sessionId.length > 200
          || !(item.executionNodeId === null || (typeof item.executionNodeId === "string" && item.executionNodeId.length <= 100))) return emptyCanvasLayout();
        const identity = `${item.projectId}\0${item.sessionId}`;
        const pathIdentity = `${item.projectId}\0${canonicalSessionPath(item.sessionPath)}`;
        if (sessionIdentities.has(identity) || pathIdentities.has(pathIdentity)) return emptyCanvasLayout();
        sessionIdentities.add(identity);
        pathIdentities.add(pathIdentity);
        paneIds.add(item.id);
        panes.push({ kind: "pane", id: item.id, projectId: item.projectId, sessionPath: canonicalSessionPath(item.sessionPath), sessionId: item.sessionId, executionNodeId: item.executionNodeId });
      }
      // Versions 2 and 3 stored per-pane widths and pinned row heights. The grid has
      // no room for either, so reading one simply drops them.
      rows.push({ id: row.id, panes });
    }
    if (![2, 3, 4].includes(layout.version)
      || !(layout.focusedPaneId === null || (typeof layout.focusedPaneId === "string" && paneIds.has(layout.focusedPaneId)))) return emptyCanvasLayout();
    return { version: 4, rows, focusedPaneId: layout.focusedPaneId ?? null };
  } catch {
    return emptyCanvasLayout();
  }
}

/** Version 1 split tree -> rows: a column stacks rows, a row split flattens to one row. */
export function migrateLegacyCanvasLayout(parsed: unknown): CanvasLayoutPreference {
  const legacy = parsed as { root?: unknown; focusedPaneId?: unknown };
  const ids = new Set<string>();
  const sessionIdentities = new Set<string>();
  const pathIdentities = new Set<string>();
  const paneIds = new Set<string>();
  const pane = (item: unknown): CanvasPanePreference | null => {
    if (!item || typeof item !== "object") return null;
    const candidate = item as Record<string, unknown>;
    if (candidate.kind !== "pane" || typeof candidate.id !== "string" || !candidate.id || ids.has(candidate.id)) return null;
    if (typeof candidate.projectId !== "string" || !candidate.projectId || candidate.projectId.length > 120
      || typeof candidate.sessionPath !== "string" || !candidate.sessionPath || candidate.sessionPath.length > 2000
      || typeof candidate.sessionId !== "string" || !candidate.sessionId || candidate.sessionId.length > 200
      || !(candidate.executionNodeId === null || (typeof candidate.executionNodeId === "string" && candidate.executionNodeId.length <= 100))) return null;
    const identity = `${candidate.projectId}\0${candidate.sessionId}`;
    const pathIdentity = `${candidate.projectId}\0${canonicalSessionPath(candidate.sessionPath)}`;
    if (sessionIdentities.has(identity) || pathIdentities.has(pathIdentity)) return null;
    ids.add(candidate.id);
    sessionIdentities.add(identity);
    pathIdentities.add(pathIdentity);
    paneIds.add(candidate.id);
    return { kind: "pane", id: candidate.id, projectId: candidate.projectId, sessionPath: canonicalSessionPath(candidate.sessionPath), sessionId: candidate.sessionId, executionNodeId: candidate.executionNodeId };
  };
  const rows: CanvasRowPreference[] = [];
  let valid = true;
  const chunk = (entries: CanvasPanePreference[]) => {
    for (let start = 0; start < entries.length && rows.length < 10; start += 8) {
      rows.push({ id: crypto.randomUUID(), panes: entries.slice(start, start + 8) });
    }
  };
  // Split ratios are still validated, then discarded: the grid spaces panes evenly.
  const collect = (candidate: unknown, level: number, entries: CanvasPanePreference[]): void => {
    if (!candidate || typeof candidate !== "object" || level > 8) { valid = false; return; }
    const entry = candidate as Record<string, unknown>;
    if (entry.kind === "pane") {
      const flat = pane(entry);
      if (flat) entries.push(flat);
      else valid = false;
      return;
    }
    if (entry.kind !== "split" || (entry.axis !== "row" && entry.axis !== "column")) { valid = false; return; }
    if (entry.axis === "row" && (typeof entry.ratio !== "number" || !Number.isFinite(entry.ratio) || entry.ratio < 0.15 || entry.ratio > 0.85)) { valid = false; return; }
    collect(entry.first, level + 1, entries);
    collect(entry.second, level + 1, entries);
  };
  const visit = (node: unknown, depth: number): void => {
    if (!node) return;
    if (typeof node !== "object" || depth > 8) { valid = false; return; }
    const item = node as Record<string, unknown>;
    if (item.kind === "split" && item.axis === "column") {
      if (typeof item.ratio !== "number" || !Number.isFinite(item.ratio) || item.ratio < 0.15 || item.ratio > 0.85) { valid = false; return; }
      visit(item.first, depth + 1);
      visit(item.second, depth + 1);
      return;
    }
    const entries: CanvasPanePreference[] = [];
    collect(item, depth, entries);
    chunk(entries);
  };
  visit(legacy.root, 0);
  if (!valid || (typeof legacy.focusedPaneId === "string" && !paneIds.has(legacy.focusedPaneId))) return emptyCanvasLayout();
  return { version: 4, rows, focusedPaneId: typeof legacy.focusedPaneId === "string" ? legacy.focusedPaneId : null };
}

function preferencesFromRow(row: PreferenceRow): UserPreferences {
  return {
    theme: row.theme,
    notificationsEnabled: row.notifications_enabled === 1,
    completionSound: row.completion_sound,
    installDismissed: row.install_dismissed === 1,
    mobileView: row.mobile_view,
    activeProjectId: row.active_project_id,
    activeSessionPath: row.active_session_path,
    activeSessionId: row.active_session_id,
    activeNodeId: row.active_node_id,
    legacyMigrated: row.legacy_migrated === 1,
    pinnedProjectIds: parseStringList(row.pinned_project_ids),
    pinnedSessionPaths: parseStringList(row.pinned_session_paths),
    projectsPanelCollapsed: row.projects_panel_collapsed === 1,
    chatsPanelCollapsed: row.chats_panel_collapsed === 1,
    recentSessions: parseRecentSessions(row.recent_sessions),
    lastSeenVersion: row.last_seen_version,
    canvasLayout: parseCanvasLayout(row.canvas_layout),
  };
}

function currentPreferences(userId: string): UserPreferences {
  const row = preferencesDatabase().prepare(`
    SELECT theme, notifications_enabled, completion_sound, install_dismissed, mobile_view,
      active_project_id, active_session_path, active_session_id, active_node_id, legacy_migrated,
      pinned_project_ids, pinned_session_paths, projects_panel_collapsed, chats_panel_collapsed,
      recent_sessions, last_seen_version, canvas_layout
    FROM user_preferences WHERE user_id = ?
  `).get(userId) as unknown as PreferenceRow;
  return preferencesFromRow(row);
}

export function getUserPreferences(userId: string): UserPreferences {
  ensurePreferences(userId);
  return currentPreferences(userId);
}

export function updateUserPreferences(userId: string, partial: Partial<UserPreferences>): UserPreferences {
  const columns: string[] = [];
  const values: Array<string | number | null> = [];
  const fields: Array<[keyof UserPreferences, string, (value: never) => string | number | null]> = [
    ["theme", "theme", (value) => value as string | null],
    ["notificationsEnabled", "notifications_enabled", (value) => value ? 1 : 0],
    ["completionSound", "completion_sound", (value) => value as string],
    ["installDismissed", "install_dismissed", (value) => value ? 1 : 0],
    ["mobileView", "mobile_view", (value) => value as string],
    ["activeProjectId", "active_project_id", (value) => value as string | null],
    ["activeSessionPath", "active_session_path", (value) => value as string | null],
    ["activeSessionId", "active_session_id", (value) => value as string | null],
    ["activeNodeId", "active_node_id", (value) => value as string | null],
    ["legacyMigrated", "legacy_migrated", (value) => value ? 1 : 0],
    ["pinnedProjectIds", "pinned_project_ids", (value) => JSON.stringify(value)],
    ["pinnedSessionPaths", "pinned_session_paths", (value) => JSON.stringify(value)],
    ["projectsPanelCollapsed", "projects_panel_collapsed", (value) => value ? 1 : 0],
    ["chatsPanelCollapsed", "chats_panel_collapsed", (value) => value ? 1 : 0],
    ["recentSessions", "recent_sessions", (value) => JSON.stringify(canonicalRecentSessions(value as RecentSession[]))],
    ["lastSeenVersion", "last_seen_version", (value) => value as string | null],
    ["canvasLayout", "canvas_layout", (value) => JSON.stringify(value as CanvasLayoutPreference)],
  ];
  for (const [property, column, serialize] of fields) {
    if (partial[property] === undefined) continue;
    columns.push(`${column} = ?`);
    values.push(serialize(partial[property] as never));
  }

  const db = preferencesDatabase();
  db.exec("BEGIN");
  try {
    ensurePreferences(userId);
    if (columns.length) {
      db.prepare(`UPDATE user_preferences SET ${columns.join(", ")}, updated_at = ? WHERE user_id = ?`)
        .run(...values, new Date().toISOString(), userId);
    }
    const preferences = currentPreferences(userId);
    db.exec("COMMIT");
    return preferences;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
