import { mkdirSync } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CANVAS_CHORD_MODIFIERS, normalizeCanvasChordTokens, type CanvasChordModifier } from "./canvas-keys.js";
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

export interface CanvasPanePreference {
  kind: "pane";
  id: string;
  projectId: string;
  sessionPath: string;
  sessionId: string;
  executionNodeId: string | null;
}

export interface CanvasRowPreference {
  id: string;
  /** Pinned pixel height, or null while the row shares available canvas height. */
  height: number | null;
  /** Proportional pane widths. They sum to one, so every row stays filled. */
  weights: number[];
  panes: CanvasPanePreference[];
}

export interface CanvasSplitPreference {
  kind: "split";
  id: string;
  axis: "row" | "column";
  ratio: number;
  first: CanvasNodePreference;
  second: CanvasNodePreference;
}
export type CanvasNodePreference = CanvasPanePreference | CanvasSplitPreference;
export interface CanvasPagePreference {
  id: string;
  name: string;
  root: CanvasNodePreference | null;
  focusedPaneId: string | null;
  projectFilter: string;
}
export interface CanvasLayoutPreference {
  version: 6;
  pages: CanvasPagePreference[];
  activePageId: string;
}

const emptyCanvasLayout = (): CanvasLayoutPreference => ({ version: 6, pages: [{ id: "page-1", name: "Page 1", root: null, focusedPaneId: null, projectFilter: "" }], activePageId: "page-1" });

export const CANVAS_MIN_PANE_WIDTH = 0.08;
export const CANVAS_WIDTH_TOLERANCE = 1e-6;
export const CANVAS_MIN_ROW_HEIGHT = 200;
export const CANVAS_MAX_ROW_HEIGHT = 2400;

export function canvasRowGeometryIsLegal(row: { height?: number | null; weights: number[] }): boolean {
  const total = row.weights.reduce((sum, weight) => sum + weight, 0);
  return Math.abs(total - 1) <= CANVAS_WIDTH_TOLERANCE
    && row.weights.every((weight) => weight >= CANVAS_MIN_PANE_WIDTH - CANVAS_WIDTH_TOLERANCE)
    && (row.height === null || row.height === undefined
      || (row.height >= CANVAS_MIN_ROW_HEIGHT && row.height <= CANVAS_MAX_ROW_HEIGHT));
}

function equalCanvasWeights(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

function normalizedCanvasWeights(weights: unknown, count: number): number[] {
  if (!Array.isArray(weights) || weights.length !== count) return equalCanvasWeights(count);
  const total = weights.reduce<number>((sum, weight) => sum + Number(weight), 0);
  const normalized = weights.map((weight) => Number(weight) / total);
  return normalized.every((weight) => weight >= CANVAS_MIN_PANE_WIDTH) ? normalized : equalCanvasWeights(count);
}

interface StoredCanvasLayout {
  version: number;
  rows: Array<{ id: string; height?: number | null; weights?: number[]; panes: CanvasPanePreference[] }>;
  focusedPaneId: string | null;
}

/** Migrates row layouts to persisted split trees. */
function splitRows(rows: StoredCanvasLayout["rows"]): CanvasNodePreference | null {
  // Right-nested splits reproduce the exact widths the row weights described, and
  // rows stack in a column split with equal shares — the same shape the client builds.
  const weighted = (items: CanvasNodePreference[], weights: number[] | undefined, axis: "row" | "column"): CanvasNodePreference | null => {
    if (!items.length) return null;
    if (items.length === 1) return items[0];
    const values = Array.isArray(weights) && weights.length === items.length && weights.every((weight) => Number.isFinite(weight) && weight > 0)
      ? weights
      : items.map(() => 1);
    const total = values.reduce((sum, value) => sum + value, 0);
    const ratio = Math.min(0.85, Math.max(0.15, values[0] / total));
    // items.length >= 2 here, so the tail always yields at least one pane.
    const rest = weighted(items.slice(1), values.slice(1), axis) as CanvasNodePreference;
    return { kind: "split", id: crypto.randomUUID(), axis, ratio, first: items[0], second: rest };
  };
  return weighted(rows.map((row) => weighted(row.panes, row.weights, "row")).filter((node): node is CanvasNodePreference => Boolean(node)), rows.map(() => 1), "column");
}
function nodeDepth(node: CanvasNodePreference | null): number {
  return !node ? 0 : node.kind === "pane" ? 1 : 1 + Math.max(nodeDepth(node.first), nodeDepth(node.second));
}
function balancedNodes(items: CanvasPanePreference[], axis: "row" | "column" = "row"): CanvasNodePreference | null {
  if (!items.length) return null;
  if (items.length === 1) return items[0];
  const middle = Math.ceil(items.length / 2);
  return { kind: "split", id: crypto.randomUUID(), axis, ratio: middle / items.length, first: balancedNodes(items.slice(0, middle), axis === "row" ? "column" : "row")!, second: balancedNodes(items.slice(middle), axis === "row" ? "column" : "row")! };
}
/** A legacy tree that breaks the v6 limits is spread over pages of eight as balanced
 *  trees, in reading order, exactly like the client's migration. Panes past nine
 *  pages are dropped: a pane is only a view onto a conversation. */
function legacyPages(tree: CanvasNodePreference | null, focusedPaneId: string | null): { roots: Array<CanvasNodePreference | null>; focusedPaneId: string | null } {
  const items = panesInCanvasNode(tree);
  let roots: Array<CanvasNodePreference | null>;
  if (items.length <= 8 && nodeDepth(tree) <= 8) {
    roots = [tree];
  } else {
    roots = [];
    for (let start = 0; start < items.length && roots.length < 9; start += 8) {
      roots.push(balancedNodes(items.slice(start, start + 8)));
    }
    if (!roots.length) roots = [null];
  }
  const ids = new Set(roots.flatMap((root) => panesInCanvasNode(root).map((pane) => pane.id)));
  return { roots, focusedPaneId: focusedPaneId && ids.has(focusedPaneId) ? focusedPaneId : null };
}
function legacyPageLayout(roots: Array<CanvasNodePreference | null>, focusedPaneId: string | null): CanvasLayoutPreference {
  return {
    version: 6,
    // Focus lands on the page that actually holds the pane, and only when that
    // pane survived the spread; otherwise it is dropped rather than invalidated.
    pages: roots.map((root, index) => ({ id: `page-${index + 1}`, name: `Page ${index + 1}`, root, focusedPaneId: focusedPaneId && panesInCanvasNode(root).some((pane) => pane.id === focusedPaneId) ? focusedPaneId : null, projectFilter: "" })),
    activePageId: "page-1",
  };
}

export function normalizeCanvasLayoutPreference(layout: StoredCanvasLayout | CanvasLayoutPreference | { version: 1; root: CanvasNodePreference | null; focusedPaneId: string | null }): CanvasLayoutPreference {
  const source = layout as StoredCanvasLayout & CanvasLayoutPreference & { root?: CanvasNodePreference | null };
  if (source.version === 6) return source;
  const { roots, focusedPaneId } = legacyPages(source.version === 1 ? source.root ?? null : splitRows(source.rows), source.focusedPaneId ?? null);
  return legacyPageLayout(roots, focusedPaneId);
}

export type CanvasModifier = CanvasChordModifier;

/** Canvas keyboard shortcuts for one account. Every command holds one chord or a
 * two-stroke sequence, at most four physical keys, or null when unbound. Conversation
 * keys ride the `base` modifier chord plus their own single key. */
export interface CanvasKeymapPreference {
  version: 3;
  base: CanvasModifier[];
  commands: Record<string, string[] | null>;
}

const CANVAS_MODIFIERS: CanvasModifier[] = [...CANVAS_CHORD_MODIFIERS];
// Order matters: a command added later takes its default chord only if no earlier
// command already holds it, so an existing account never loses a binding it configured.
const CANVAS_KEYMAP_COMMANDS = [
  "toggleView", "spotlight", "pendingReviews", "recents", "runningConversations", "settings", "focusInput",
  "paneSearch", "recentPane", "focusPane",
  "splitRight", "splitBelow", "closePane", "createPage",
  "nextPage", "prevPage", "focusLeft", "focusRight", "focusUp", "focusDown",
  "page1", "page2", "page3", "page4", "page5", "page6", "page7", "page8", "page9",
  "toggleProjects", "toggleChats", "board", "newProject", "newPiChat", "newClaudeChat",
  "runsOn", "selectAgent", "selectModel", "selectThinking", "terminal", "notify", "addToCanvas", "rename",
] as const;

export const defaultCanvasKeymap = (): CanvasKeymapPreference => ({
  version: 3,
  base: ["meta", "shift"],
  commands: {
    toggleView: ["meta", "shift", "V"],
    spotlight: ["meta", "shift", "P"],
    pendingReviews: ["meta", "shift", "R"],
    recents: ["meta", "K"],
    runningConversations: ["meta", "shift", "O"],
    settings: ["meta", ","],
    focusInput: ["meta", "shift", "I"],
    toggleProjects: ["ctrl", "shift", "["],
    toggleChats: ["ctrl", "shift", "]"],
    board: ["meta", "shift", "B"],
    newProject: ["meta", "alt", "P"],
    newPiChat: ["meta", "alt", "N"],
    newClaudeChat: ["meta", "alt", "C"],
    runsOn: ["ctrl", "alt", "N"],
    selectAgent: ["ctrl", "alt", "A"],
    selectModel: ["ctrl", "alt", "M"],
    selectThinking: ["ctrl", "alt", "T"],
    terminal: ["ctrl", "alt", "X"],
    notify: ["ctrl", "alt", "Y"],
    addToCanvas: ["ctrl", "alt", "V"],
    rename: ["ctrl", "alt", "R"],
    paneSearch: ["meta", "shift", "F"],
    recentPane: ["meta", "shift", "E"],
    focusPane: ["meta", "shift", "G"],
    splitRight: ["ctrl", "SPACE", "\\"],
    splitBelow: ["ctrl", "SPACE", "-"],
    closePane: ["ctrl", "SPACE", "X"],
    createPage: ["meta", "shift", "C"],
    nextPage: ["ctrl", "alt", "ARROWRIGHT"],
    prevPage: ["ctrl", "alt", "ARROWLEFT"],
    focusLeft: ["ctrl", "shift", "ARROWLEFT"],
    focusRight: ["ctrl", "shift", "ARROWRIGHT"],
    focusUp: ["ctrl", "shift", "ARROWUP"],
    focusDown: ["ctrl", "shift", "ARROWDOWN"],
    ...Object.fromEntries([..."123456789"].map((digit, index) => [`page${index + 1}`, ["ctrl", "alt", digit]])),
  },
});

// Keymaps saved before chords existed held one key per command under one shared
// modifier set; those keys ride whatever modifiers the account had chosen.
const LEGACY_COMMAND_KEYS: Record<string, string> = { recentPane: "E", focusPane: "G", paneSearch: "F", toggleView: "V", spotlight: "P", pendingReviews: "R" };
// Legacy keys were stored in any case; the chord vocabulary is upper case.
const canonicalChordKey = (key: unknown): string | undefined => (typeof key === "string" ? key.toUpperCase() : undefined);

function shortcutPrefix(shortcut: string[]): string[] | null {
  return shortcut.filter((token) => !CANVAS_MODIFIERS.includes(token as CanvasModifier)).length === 2 ? shortcut.slice(0, -1) : null;
}

function shortcutsConflict(left: string[], right: string[]): boolean {
  if (JSON.stringify(left) === JSON.stringify(right)) return true;
  const leftPrefix = shortcutPrefix(left);
  const rightPrefix = shortcutPrefix(right);
  return Boolean(leftPrefix && !rightPrefix && JSON.stringify(leftPrefix) === JSON.stringify(right)
    || rightPrefix && !leftPrefix && JSON.stringify(rightPrefix) === JSON.stringify(left));
}

/**
 * Accepts any stored or posted shape and mirrors the page's `normalizeCanvasKeymap`:
 * a shortcut without Command, Control, or Option would swallow ordinary typing, so
 * an unusable one falls back to the default; a shortcut two commands would share goes to
 * the earlier command, and the later one is left unbound.
 */
export function normalizeCanvasKeymapPreference(value: unknown): CanvasKeymapPreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultCanvasKeymap();
  const source = value as Record<string, unknown>;
  const legacy = !source.commands;
  const base = (normalizeCanvasChordTokens(legacy ? source.modifiers : source.base, true) ?? [...defaultCanvasKeymap().base]) as CanvasModifier[];
  const commands: Record<string, string[] | null> = {};
  const taken: string[][] = [];
  for (const command of CANVAS_KEYMAP_COMMANDS) {
    let raw = legacy
      ? (source[command] === null ? null
        : LEGACY_COMMAND_KEYS[command] ? [...base, canonicalChordKey(source[command]) ?? LEGACY_COMMAND_KEYS[command]]
          : [...defaultCanvasKeymap().commands[command]!])
      : (((source.commands as Record<string, unknown> | undefined)?.[command] === undefined
        ? [...defaultCanvasKeymap().commands[command]!]
        : (source.commands as Record<string, unknown>)[command]) as unknown);
    if (!(Number(source.version) >= 2) && command === "splitRight" && JSON.stringify(raw) === JSON.stringify(["ctrl", "\\"])) raw = ["ctrl", "SPACE", "\\"];
    if (!(Number(source.version) >= 2) && command === "splitBelow" && JSON.stringify(raw) === JSON.stringify(["ctrl", "-"])) raw = ["ctrl", "SPACE", "-"];
    if (!(Number(source.version) >= 3) && command === "closePane" && JSON.stringify(raw) === JSON.stringify(["meta", "shift", "X"])) raw = ["ctrl", "SPACE", "X"];
    const chord = raw === null || typeof raw === "string" ? null : normalizeCanvasChordTokens(raw);
    commands[command] = chord && !taken.some((existing) => shortcutsConflict(existing, chord)) ? chord : null;
    if (commands[command]) taken.push(commands[command]);
  }
  return { version: 3, base, commands };
}

/** A hand-edited column must degrade to the default chord, never take the node down. */
function parseCanvasKeymap(value: string): CanvasKeymapPreference {
  try {
    return normalizeCanvasKeymapPreference(JSON.parse(value));
  } catch {
    return defaultCanvasKeymap();
  }
}

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
  lastSeenVersion: string | null;
  canvasLayout: CanvasLayoutPreference;
  canvasKeymap: CanvasKeymapPreference;
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
  last_seen_version: string | null;
  canvas_layout: string;
  canvas_keymap: string;
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
      canvas_keymap TEXT NOT NULL DEFAULT '{"modifiers":["meta","shift"],"recentPane":"E","focusPane":"G","paneSearch":"F"}',
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
  if (!columns.some((column) => column.name === "canvas_keymap")) database.exec("ALTER TABLE user_preferences ADD COLUMN canvas_keymap TEXT NOT NULL DEFAULT '{\"modifiers\":[\"meta\",\"shift\"],\"recentPane\":\"E\",\"focusPane\":\"G\",\"paneSearch\":\"F\"}'");
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
      && typeof entry.openedAt === "string"
      && (entry.engine === undefined || isHarnessId(entry.engine))
      && (entry.sessionId === undefined || typeof entry.sessionId === "string"));
    return canonicalRecentSessions(sessions);
  } catch {
    return [];
  }
}

function validStoredCanvasNode(node: unknown, depth: number, ids: Set<string>, identities: Set<string>): CanvasNodePreference | null {
  if (!node || typeof node !== "object" || depth > 8) return null;
  const item = node as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id || item.id.length > 200 || ids.has(item.id)) return null;
  ids.add(item.id);
  if (item.kind === "pane") {
    if (typeof item.projectId !== "string" || !item.projectId || item.projectId.length > 120 || typeof item.sessionPath !== "string" || !item.sessionPath || item.sessionPath.length > 2000 || typeof item.sessionId !== "string" || !item.sessionId || item.sessionId.length > 200 || !(item.executionNodeId === null || typeof item.executionNodeId === "string" && item.executionNodeId.length <= 100)) return null;
    const sessionPath = canonicalSessionPath(item.sessionPath);
    const identity = `${item.projectId}\0${item.sessionId}`;
    const pathIdentity = `${item.projectId}\0${sessionPath}`;
    if (identities.has(identity) || identities.has(pathIdentity)) return null;
    identities.add(identity); identities.add(pathIdentity);
    return { kind: "pane", id: item.id, projectId: item.projectId, sessionPath, sessionId: item.sessionId, executionNodeId: item.executionNodeId as string | null };
  }
  if (item.kind !== "split" || (item.axis !== "row" && item.axis !== "column") || typeof item.ratio !== "number" || !Number.isFinite(item.ratio) || item.ratio < .15 || item.ratio > .85) return null;
  const first = validStoredCanvasNode(item.first, depth + 1, ids, identities);
  const second = validStoredCanvasNode(item.second, depth + 1, ids, identities);
  return first && second ? { kind: "split", id: item.id, axis: item.axis, ratio: item.ratio, first, second } : null;
}
function validStoredCanvasLayout(value: unknown): CanvasLayoutPreference | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (source.version !== 6 || !Array.isArray(source.pages) || source.pages.length < 1 || source.pages.length > 9 || typeof source.activePageId !== "string") return null;
  const ids = new Set<string>(); const identities = new Set<string>(); const pages: CanvasPagePreference[] = [];
  for (const item of source.pages) {
    if (!item || typeof item !== "object") return null;
    const page = item as Record<string, unknown>;
    if (typeof page.id !== "string" || !page.id || page.id.length > 200 || ids.has(page.id) || typeof page.name !== "string" || !page.name.trim() || page.name.length > 80 || typeof page.projectFilter !== "string" || page.projectFilter.length > 120 || !(page.focusedPaneId === null || typeof page.focusedPaneId === "string")) return null;
    ids.add(page.id); const root = page.root === null ? null : validStoredCanvasNode(page.root, 1, ids, identities);
    if (page.root !== null && !root) return null;
    const pagePanes = panesInCanvasNode(root);
    if (pagePanes.length > 8 || page.focusedPaneId && !pagePanes.some((pane) => pane.id === page.focusedPaneId)) return null;
    pages.push({ id: page.id, name: page.name, root, focusedPaneId: page.focusedPaneId as string | null, projectFilter: page.projectFilter });
  }
  return pages.some((page) => page.id === source.activePageId) ? { version: 6, pages, activePageId: source.activePageId } : null;
}
function panesInCanvasNode(node: CanvasNodePreference | null, result: CanvasPanePreference[] = []): CanvasPanePreference[] { if (!node) return result; if (node.kind === "pane") result.push(node); else { panesInCanvasNode(node.first, result); panesInCanvasNode(node.second, result); } return result; }

/** A hand-edited canvas row must degrade to an empty canvas, never take the node down. */
function parseCanvasLayout(value: string): CanvasLayoutPreference {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyCanvasLayout();
    if ((parsed as { version?: unknown }).version === 1) {
      // A stored version 1 tree is validated exactly like a stored version 6 page,
      // then runs through the same spread-over-pages migration so oversized legacy
      // trees cannot produce a layout the schema would reject.
      const legacy = parsed as { root?: unknown; focusedPaneId?: unknown };
      const ids = new Set<string>();
      const identities = new Set<string>();
      const root = validStoredCanvasNode(legacy.root ?? null, 1, ids, identities);
      if (legacy.root != null && !root) return emptyCanvasLayout();
      const panes = panesInCanvasNode(root);
      const focusedPaneId = typeof legacy.focusedPaneId === "string" && panes.some((pane) => pane.id === legacy.focusedPaneId)
        ? legacy.focusedPaneId
        : null;
      const { roots, focusedPaneId: keptFocus } = legacyPages(root, focusedPaneId);
      return legacyPageLayout(roots, keptFocus);
    }
    if ((parsed as { version?: unknown }).version === 6) return validStoredCanvasLayout(parsed) ?? emptyCanvasLayout();
    const layout = parsed as unknown as {
      version: number;
      rows: Array<CanvasRowPreference & { height?: number | null; weights?: number[] }>;
      focusedPaneId: string | null;
    };
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
      if (![2, 3, 4, 5].includes(layout.version)) return emptyCanvasLayout();
      if (layout.version !== 4 && (!Array.isArray(row.weights) || row.weights.length !== row.panes.length
        || !row.weights.every((weight) => typeof weight === "number" && Number.isFinite(weight) && weight > 0))) return emptyCanvasLayout();
      if ((layout.version === 3 || layout.version === 5)
        && !(row.height === undefined || row.height === null || (typeof row.height === "number" && Number.isFinite(row.height)))) return emptyCanvasLayout();
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
      const weights = normalizedCanvasWeights(row.weights, panes.length);
      const height = layout.version === 3 || layout.version === 5 ? row.height ?? null : null;
      if (layout.version === 5 && !canvasRowGeometryIsLegal({ height, weights: row.weights! })) return emptyCanvasLayout();
      rows.push({ id: row.id, height, weights, panes });
    }
    if (!(layout.focusedPaneId === null || (typeof layout.focusedPaneId === "string" && paneIds.has(layout.focusedPaneId)))) return emptyCanvasLayout();
    return normalizeCanvasLayoutPreference({ version: layout.version, rows, focusedPaneId: layout.focusedPaneId ?? null });
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
      const panes = entries.slice(start, start + 8);
      rows.push({ id: crypto.randomUUID(), height: null, weights: equalCanvasWeights(panes.length), panes });
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
  return normalizeCanvasLayoutPreference({ version: 5, rows, focusedPaneId: typeof legacy.focusedPaneId === "string" ? legacy.focusedPaneId : null });
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
    lastSeenVersion: row.last_seen_version,
    canvasLayout: parseCanvasLayout(row.canvas_layout),
    canvasKeymap: parseCanvasKeymap(row.canvas_keymap),
  };
}

function currentPreferences(userId: string): UserPreferences {
  const row = preferencesDatabase().prepare(`
    SELECT theme, notifications_enabled, completion_sound, install_dismissed, mobile_view,
      active_project_id, active_session_path, active_session_id, active_node_id, legacy_migrated,
      pinned_project_ids, pinned_session_paths, projects_panel_collapsed, chats_panel_collapsed,
      last_seen_version, canvas_layout, canvas_keymap
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
    ["lastSeenVersion", "last_seen_version", (value) => value as string | null],
    ["canvasLayout", "canvas_layout", (value) => JSON.stringify(value as CanvasLayoutPreference)],
    ["canvasKeymap", "canvas_keymap", (value) => JSON.stringify(value as CanvasKeymapPreference)],
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
