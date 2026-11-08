import { mkdirSync } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SHORTCUT_CHORD_MODIFIERS, normalizeShortcutChordTokens, type ShortcutChordModifier } from "./shortcut-keys.js";
import { isHarnessId, type HarnessId } from "./types.js";

/** One conversation the user opened, newest first, capped by the client. */
export interface RecentSession {
  projectId: string;
  sessionPath: string;
  title: string;
  openedAt: string;
  /** Stable cluster identity. Absent on entries saved before pin replication. */
  engine?: HarnessId;
  sessionId?: string;
  /** When the conversation itself last moved; null for entries stored before this was tracked. */
  updatedAt: string | null;
}

export type ShortcutModifier = ShortcutChordModifier;

/** The app's keyboard shortcuts for one account. Every command holds one chord or a
 * two-stroke sequence, at most four physical keys, or null when unbound. Conversation
 * keys ride the `base` modifier chord plus their own single key. */
export interface KeymapPreference {
  version: 4;
  base: ShortcutModifier[];
  commands: Record<string, string[] | null>;
}

const SHORTCUT_MODIFIERS: ShortcutModifier[] = [...SHORTCUT_CHORD_MODIFIERS];
// Order matters: a command added later takes its default chord only if no earlier
// command already holds it, so an existing account never loses a binding it configured.
const KEYMAP_COMMANDS = [
  "toggleView", "spotlight", "pendingReviews", "recents", "runningConversations", "settings", "focusInput", "savedCommands",
  "toggleProjects", "toggleChats", "board", "newProject", "newPiChat", "newClaudeChat", "newKiroChat", "quickNote", "toggleNotes",
  "runsOn", "selectAgent", "selectModel", "selectThinking", "terminal", "notify", "rename", "browser", "scheduledTasks",
  "backgroundTasks", "chatFiles", "sessionActions", "markDone", "autoRespond", "git", "explainConversation", "costs", "activity",
] as const;

/** Mirrors `DEFAULT_KEYMAP` in `public/keymap.js`; every command rides
 * Control+Option (Control+Alt off a Mac) so a button badge can name the key alone.
 * Conversation keys keep their own base chord, which no command may share. */
const COMMAND_MODIFIERS: ShortcutModifier[] = ["ctrl", "alt"];
const commandChord = (key: string): string[] => [...COMMAND_MODIFIERS, key];

export const defaultKeymap = (): KeymapPreference => ({
  version: 4,
  base: ["meta", "shift"],
  commands: {
    toggleView: commandChord("V"),
    spotlight: commandChord("P"),
    pendingReviews: commandChord("R"),
    recents: commandChord("K"),
    runningConversations: commandChord("O"),
    settings: commandChord(","),
    focusInput: commandChord("I"),
    savedCommands: ["ctrl", "alt", "shift", "L"],
    toggleProjects: commandChord("["),
    toggleChats: commandChord("]"),
    board: commandChord("D"),
    newProject: commandChord("="),
    newPiChat: commandChord("N"),
    newClaudeChat: commandChord("C"),
    newKiroChat: commandChord("Q"),
    quickNote: commandChord("."),
    toggleNotes: commandChord("/"),
    runsOn: commandChord("H"),
    selectAgent: commandChord("A"),
    selectModel: commandChord("M"),
    selectThinking: commandChord("T"),
    terminal: commandChord("X"),
    browser: commandChord("B"),
    notify: commandChord("Y"),
    rename: commandChord("E"),
    scheduledTasks: commandChord("S"),
    backgroundTasks: commandChord("U"),
    chatFiles: commandChord("Z"),
    // The letters under Control+Option are all taken, so these add Shift, as costs does.
    sessionActions: ["ctrl", "alt", "shift", "A"],
    markDone: ["ctrl", "alt", "shift", "D"],
    autoRespond: ["ctrl", "alt", "shift", "R"],
    git: ["ctrl", "alt", "shift", "G"],
    explainConversation: ["ctrl", "alt", "shift", "E"],
    costs: ["ctrl", "alt", "shift", "C"],
    activity: ["ctrl", "alt", "shift", "S"],
  },
});

function shortcutPrefix(shortcut: string[]): string[] | null {
  return shortcut.filter((token) => !SHORTCUT_MODIFIERS.includes(token as ShortcutModifier)).length === 2 ? shortcut.slice(0, -1) : null;
}

function shortcutsConflict(left: string[], right: string[]): boolean {
  if (JSON.stringify(left) === JSON.stringify(right)) return true;
  const leftPrefix = shortcutPrefix(left);
  const rightPrefix = shortcutPrefix(right);
  return Boolean(leftPrefix && !rightPrefix && JSON.stringify(leftPrefix) === JSON.stringify(right)
    || rightPrefix && !leftPrefix && JSON.stringify(rightPrefix) === JSON.stringify(left));
}

/**
 * Accepts any stored or posted shape and mirrors the page's `normalizeKeymap`:
 * a shortcut without Command, Control, or Option would swallow ordinary typing, so
 * an unusable one falls back to the default; a shortcut two commands would share goes to
 * the earlier command, and the later one is left unbound. A keymap saved before version
 * 4 describes the old per-command modifier scheme, so its command chords are rebuilt
 * from the defaults and only the conversation base modifiers carry over.
 */
export function normalizeKeymapPreference(value: unknown): KeymapPreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultKeymap();
  const source = value as Record<string, unknown>;
  // Before commands existed the base modifiers were stored as `modifiers`.
  const base = (normalizeShortcutChordTokens(source.commands ? source.base : source.modifiers, true)
    ?? [...defaultKeymap().base]) as ShortcutModifier[];
  const rebuild = !(Number(source.version) >= 4);
  const commands: Record<string, string[] | null> = {};
  const taken: string[][] = [];
  for (const command of KEYMAP_COMMANDS) {
    const stored = (source.commands as Record<string, unknown> | undefined)?.[command];
    const raw: unknown = rebuild || stored === undefined ? [...defaultKeymap().commands[command]!] : stored;
    const chord = raw === null || typeof raw === "string" ? null : normalizeShortcutChordTokens(raw);
    commands[command] = chord && !taken.some((existing) => shortcutsConflict(existing, chord)) ? chord : null;
    if (commands[command]) taken.push(commands[command]!);
  }
  return { version: 4, base, commands };
}

/** A hand-edited column must degrade to the default chord, never take the node down. */
function parseKeymap(value: string): KeymapPreference {
  try {
    return normalizeKeymapPreference(JSON.parse(value));
  } catch {
    return defaultKeymap();
  }
}

export interface TerminalDockPreference {
  orientation: "horizontal" | "vertical";
  horizontalSize: number;
  verticalSize: number;
}

export interface UserPreferences {
  theme: "light" | "dark" | null;
  notificationsEnabled: boolean;
  completionSound: "off" | "chime" | "bell";
  terminalDock: TerminalDockPreference;
  installDismissed: boolean;
  mobileView: "projects" | "sessions" | "board" | "chat" | "control";
  activeProjectId: string | null;
  activeSessionPath: string | null;
  activeSessionId: string | null;
  activeNodeId: string | null;
  legacyMigrated: boolean;
  pinnedProjectIds: string[];
  pinnedSessionPaths: string[];
  focusUiEnabled: boolean;
  projectsPanelCollapsed: boolean;
  chatsPanelCollapsed: boolean;
  lastSeenVersion: string | null;
  /** The keyboard shortcuts. Named for the canvas they once belonged to; the name stays so saved preferences, roaming profiles and older pages still match. */
  canvasKeymap: KeymapPreference;
  /** Per conversation, the newest message time (epoch ms) the reader has viewed. */
  conversationLastRead: Record<string, number>;
  /** Conversation-list visibility per project. Missing entries use the hidden defaults. */
  projectConversationVisibility: Record<string, { done: boolean; scheduled: boolean }>;
  /** The control center board: card colors and free positions by conversation, the layout and the project filter. */
  controlCenter: ControlCenterPreference;
  /** Default Git reviewer; null means choose from the conversation's last harness. */
  gitReviewer: GitReviewerPreference | null;
}

export interface GitReviewerPreference {
  harnessId: HarnessId;
  provider?: string;
  modelId: string;
  thinkingLevel: string;
}

interface PreferenceRow {
  theme: UserPreferences["theme"];
  notifications_enabled: number;
  completion_sound: UserPreferences["completionSound"];
  terminal_dock: string;
  install_dismissed: number;
  mobile_view: UserPreferences["mobileView"];
  active_project_id: string | null;
  active_session_path: string | null;
  active_session_id: string | null;
  active_node_id: string | null;
  legacy_migrated: number;
  pinned_project_ids: string;
  pinned_session_paths: string;
  focus_ui_enabled: number;
  projects_panel_collapsed: number;
  chats_panel_collapsed: number;
  last_seen_version: string | null;
  git_reviewer: string;
  canvas_keymap: string;
  conversation_last_read: string;
  project_conversation_visibility: string;
  control_center: string;
}

const dataDir = resolveDataDirectory();
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
      terminal_dock TEXT NOT NULL DEFAULT '{"orientation":"horizontal","horizontalSize":320,"verticalSize":440}',
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
      canvas_keymap TEXT NOT NULL DEFAULT '{"modifiers":["meta","shift"],"recentPane":"E","focusPane":"G","paneSearch":"F"}',
      updated_at TEXT NOT NULL
    );
  `);
  const columns = database.prepare("PRAGMA table_info(user_preferences)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "completion_sound")) database.exec("ALTER TABLE user_preferences ADD COLUMN completion_sound TEXT NOT NULL DEFAULT 'chime'");
  if (!columns.some((column) => column.name === "terminal_dock")) database.exec(`ALTER TABLE user_preferences ADD COLUMN terminal_dock TEXT NOT NULL DEFAULT '{"orientation":"horizontal","horizontalSize":320,"verticalSize":440}'`);
  if (!columns.some((column) => column.name === "active_session_id")) database.exec("ALTER TABLE user_preferences ADD COLUMN active_session_id TEXT");
  if (!columns.some((column) => column.name === "active_node_id")) database.exec("ALTER TABLE user_preferences ADD COLUMN active_node_id TEXT");
  if (!columns.some((column) => column.name === "pinned_project_ids")) database.exec("ALTER TABLE user_preferences ADD COLUMN pinned_project_ids TEXT NOT NULL DEFAULT '[]'");
  if (!columns.some((column) => column.name === "pinned_session_paths")) database.exec("ALTER TABLE user_preferences ADD COLUMN pinned_session_paths TEXT NOT NULL DEFAULT '[]'");
  if (!columns.some((column) => column.name === "focus_ui_enabled")) database.exec("ALTER TABLE user_preferences ADD COLUMN focus_ui_enabled INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "projects_panel_collapsed")) database.exec("ALTER TABLE user_preferences ADD COLUMN projects_panel_collapsed INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "chats_panel_collapsed")) database.exec("ALTER TABLE user_preferences ADD COLUMN chats_panel_collapsed INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "recent_sessions")) database.exec("ALTER TABLE user_preferences ADD COLUMN recent_sessions TEXT NOT NULL DEFAULT '[]'");
  if (!columns.some((column) => column.name === "last_seen_version")) database.exec("ALTER TABLE user_preferences ADD COLUMN last_seen_version TEXT");
  if (!columns.some((column) => column.name === "canvas_keymap")) database.exec("ALTER TABLE user_preferences ADD COLUMN canvas_keymap TEXT NOT NULL DEFAULT '{\"modifiers\":[\"meta\",\"shift\"],\"recentPane\":\"E\",\"focusPane\":\"G\",\"paneSearch\":\"F\"}'");
  if (!columns.some((column) => column.name === "conversation_last_read")) database.exec("ALTER TABLE user_preferences ADD COLUMN conversation_last_read TEXT NOT NULL DEFAULT '{}'");
  if (!columns.some((column) => column.name === "git_reviewer")) database.exec("ALTER TABLE user_preferences ADD COLUMN git_reviewer TEXT NOT NULL DEFAULT 'null'");
  if (!columns.some((column) => column.name === "project_conversation_visibility")) database.exec("ALTER TABLE user_preferences ADD COLUMN project_conversation_visibility TEXT NOT NULL DEFAULT '{}'");
  if (!columns.some((column) => column.name === "control_center")) database.exec("ALTER TABLE user_preferences ADD COLUMN control_center TEXT NOT NULL DEFAULT '{}'");
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

export const DEFAULT_TERMINAL_DOCK_PREFERENCE: TerminalDockPreference = {
  orientation: "horizontal", horizontalSize: 320, verticalSize: 440,
};

export function normalizeTerminalDockPreference(value: unknown): TerminalDockPreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_TERMINAL_DOCK_PREFERENCE };
  const source = value as Record<string, unknown>;
  const size = (candidate: unknown, fallback: number) => typeof candidate === "number" && Number.isFinite(candidate)
    ? Math.max(180, Math.min(2500, Math.round(candidate)))
    : fallback;
  return {
    orientation: source.orientation === "vertical" ? "vertical" : "horizontal",
    horizontalSize: size(source.horizontalSize, DEFAULT_TERMINAL_DOCK_PREFERENCE.horizontalSize),
    verticalSize: size(source.verticalSize, DEFAULT_TERMINAL_DOCK_PREFERENCE.verticalSize),
  };
}

function parseTerminalDockPreference(value: string): TerminalDockPreference {
  try { return normalizeTerminalDockPreference(JSON.parse(value)); }
  catch { return { ...DEFAULT_TERMINAL_DOCK_PREFERENCE }; }
}

/** The read map is bounded; the conversations read longest ago fall off first. */
export const CONVERSATION_LAST_READ_LIMIT = 300;
export function boundConversationLastRead(marks: Record<string, number>): Record<string, number> {
  const ids = Object.keys(marks);
  if (ids.length <= CONVERSATION_LAST_READ_LIMIT) return marks;
  return Object.fromEntries(ids.sort((left, right) => marks[right] - marks[left]).slice(0, CONVERSATION_LAST_READ_LIMIT).map((id) => [id, marks[id]]));
}

/** Same hand-edited-row tolerance as parseStringList, for the read-watermark map. */
function parseConversationLastRead(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0));
  } catch {
    return {};
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
      && typeof entry.openedAt === "string"
      && (entry.engine === undefined || isHarnessId(entry.engine))
      && (entry.sessionId === undefined || typeof entry.sessionId === "string"));
    return canonicalRecentSessions(sessions);
  } catch {
    return [];
  }
}

export interface ControlCenterPreference {
  /** Card color by `projectId:conversationId`, as #rrggbb. */
  colors: Record<string, string>;
  /** Project ids the board is limited to; empty shows every project. */
  filter: string[];
  /** Bob's chat sits on the left unless the person moved it to the right; how wide it is in pixels. */
  chatRight: boolean;
  chatWidth: number;
}

const emptyControlCenter = (): ControlCenterPreference => ({ colors: {}, filter: [], chatRight: false, chatWidth: 400 });

function parseControlCenter(value: string): ControlCenterPreference {
  try {
    const stored = JSON.parse(value) as Partial<ControlCenterPreference> | null;
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return emptyControlCenter();
    return {
      colors: stored.colors && typeof stored.colors === "object" ? Object.fromEntries(Object.entries(stored.colors).filter(([key, color]) => key.length <= 300 && /^#[0-9a-f]{6}$/i.test(String(color)))) : {},
      filter: Array.isArray(stored.filter) ? stored.filter.filter((id): id is string => typeof id === "string" && id.length <= 200) : [],
      chatRight: stored.chatRight === true,
      chatWidth: typeof stored.chatWidth === "number" && stored.chatWidth >= 300 && stored.chatWidth <= 820 ? stored.chatWidth : 400,
    };
  } catch { return emptyControlCenter(); }
}

function parseProjectConversationVisibility(value: string): UserPreferences["projectConversationVisibility"] {
  try {
    const entries = JSON.parse(value);
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return {};
    const result: UserPreferences["projectConversationVisibility"] = {};
    for (const [id, setting] of Object.entries(entries)) {
      if (id.length > 240 || !setting || typeof setting !== "object" || Array.isArray(setting)) continue;
      const candidate = setting as { done?: unknown; scheduled?: unknown };
      if (typeof candidate.done === "boolean" && typeof candidate.scheduled === "boolean") result[id] = { done: candidate.done, scheduled: candidate.scheduled };
    }
    return result;
  } catch { return {}; }
}

function preferencesFromRow(row: PreferenceRow): UserPreferences {
  return {
    theme: row.theme,
    notificationsEnabled: row.notifications_enabled === 1,
    completionSound: row.completion_sound,
    terminalDock: parseTerminalDockPreference(row.terminal_dock),
    installDismissed: row.install_dismissed === 1,
    // The canvas view no longer exists; a saved canvas view opens the control center that replaced it.
    mobileView: (row.mobile_view as string) === "canvas" ? "control" : row.mobile_view,
    activeProjectId: row.active_project_id,
    activeSessionPath: row.active_session_path,
    activeSessionId: row.active_session_id,
    activeNodeId: row.active_node_id,
    legacyMigrated: row.legacy_migrated === 1,
    pinnedProjectIds: parseStringList(row.pinned_project_ids),
    pinnedSessionPaths: parseStringList(row.pinned_session_paths),
    focusUiEnabled: row.focus_ui_enabled === 1,
    projectsPanelCollapsed: row.projects_panel_collapsed === 1,
    chatsPanelCollapsed: row.chats_panel_collapsed === 1,
    lastSeenVersion: row.last_seen_version,
    canvasKeymap: parseKeymap(row.canvas_keymap),
    conversationLastRead: parseConversationLastRead(row.conversation_last_read),
    projectConversationVisibility: parseProjectConversationVisibility(row.project_conversation_visibility),
    controlCenter: parseControlCenter(row.control_center),
    gitReviewer: JSON.parse(row.git_reviewer) as GitReviewerPreference | null,
  };
}

function currentPreferences(userId: string): UserPreferences {
  const row = preferencesDatabase().prepare(`
    SELECT theme, notifications_enabled, completion_sound, terminal_dock, install_dismissed, mobile_view,
      active_project_id, active_session_path, active_session_id, active_node_id, legacy_migrated,
      pinned_project_ids, pinned_session_paths, focus_ui_enabled, projects_panel_collapsed, chats_panel_collapsed,
      last_seen_version, canvas_keymap, conversation_last_read, project_conversation_visibility, control_center, git_reviewer
    FROM user_preferences WHERE user_id = ?
  `).get(userId) as unknown as PreferenceRow;
  return preferencesFromRow(row);
}

export function getUserPreferences(userId: string): UserPreferences {
  ensurePreferences(userId);
  return currentPreferences(userId);
}

/** The pre-sync recents column, read once to seed the replicated recents table. */
export function readLegacyRecentSessions(userId: string): RecentSession[] {
  ensurePreferences(userId);
  const row = preferencesDatabase().prepare("SELECT recent_sessions FROM user_preferences WHERE user_id = ?").get(userId) as { recent_sessions: string };
  return parseRecentSessions(row.recent_sessions);
}

export function allPinnedSessionPaths(): string[] {
  const rows = preferencesDatabase().prepare("SELECT pinned_session_paths FROM user_preferences").all() as Array<{ pinned_session_paths: string }>;
  return [...new Set(rows.flatMap((row) => parseStringList(row.pinned_session_paths)))];
}

export function updateUserPreferences(userId: string, partial: Partial<UserPreferences>): UserPreferences {
  const columns: string[] = [];
  const values: Array<string | number | null> = [];
  const fields: Array<[keyof UserPreferences, string, (value: never) => string | number | null]> = [
    ["theme", "theme", (value) => value as string | null],
    ["notificationsEnabled", "notifications_enabled", (value) => value ? 1 : 0],
    ["completionSound", "completion_sound", (value) => value as string],
    ["terminalDock", "terminal_dock", (value) => JSON.stringify(normalizeTerminalDockPreference(value))],
    ["installDismissed", "install_dismissed", (value) => value ? 1 : 0],
    ["mobileView", "mobile_view", (value) => value as string],
    ["activeProjectId", "active_project_id", (value) => value as string | null],
    ["activeSessionPath", "active_session_path", (value) => value as string | null],
    ["activeSessionId", "active_session_id", (value) => value as string | null],
    ["activeNodeId", "active_node_id", (value) => value as string | null],
    ["legacyMigrated", "legacy_migrated", (value) => value ? 1 : 0],
    ["pinnedProjectIds", "pinned_project_ids", (value) => JSON.stringify(value)],
    ["pinnedSessionPaths", "pinned_session_paths", (value) => JSON.stringify(value)],
    ["focusUiEnabled", "focus_ui_enabled", (value) => value ? 1 : 0],
    ["projectsPanelCollapsed", "projects_panel_collapsed", (value) => value ? 1 : 0],
    ["chatsPanelCollapsed", "chats_panel_collapsed", (value) => value ? 1 : 0],
    ["lastSeenVersion", "last_seen_version", (value) => value as string | null],
    ["canvasKeymap", "canvas_keymap", (value) => JSON.stringify(value as KeymapPreference)],
    ["conversationLastRead", "conversation_last_read", (value) => JSON.stringify(boundConversationLastRead(value as Record<string, number>))],
    ["projectConversationVisibility", "project_conversation_visibility", (value) => JSON.stringify(value)],
    // A 2.213 page still sends the free layout's positions and mode; the board has one layout now, so they are not kept. The chat's
    // side as pages before 2.235 saved it (right unless moved) is not kept either: the chat starts on the left once for everyone.
    ["controlCenter", "control_center", (value) => {
      const { positions: _positions, layout: _layout, chatSide: _chatSide, ...kept } = value as ControlCenterPreference & { positions?: unknown; layout?: unknown; chatSide?: unknown };
      return JSON.stringify(kept);
    }],
    ["gitReviewer", "git_reviewer", (value) => JSON.stringify(value)],
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
