import { mkdirSync } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CANVAS_CHORD_MODIFIERS, normalizeCanvasChordTokens } from "./canvas-keys.js";
import { isHarnessId } from "./types.js";
const emptyCanvasLayout = () => ({ version: 6, pages: [{ id: "page-1", name: "Page 1", root: null, focusedPaneId: null, projectFilter: "" }], activePageId: "page-1" });
const CANVAS_MIN_PANE_WIDTH = 0.08;
const CANVAS_WIDTH_TOLERANCE = 1e-6;
const CANVAS_MIN_ROW_HEIGHT = 200;
const CANVAS_MAX_ROW_HEIGHT = 2400;
function canvasRowGeometryIsLegal(row) {
  const total = row.weights.reduce((sum, weight) => sum + weight, 0);
  return Math.abs(total - 1) <= CANVAS_WIDTH_TOLERANCE && row.weights.every((weight) => weight >= CANVAS_MIN_PANE_WIDTH - CANVAS_WIDTH_TOLERANCE) && (row.height === null || row.height === void 0 || row.height >= CANVAS_MIN_ROW_HEIGHT && row.height <= CANVAS_MAX_ROW_HEIGHT);
}
function equalCanvasWeights(count) {
  return Array.from({ length: count }, () => 1 / count);
}
function normalizedCanvasWeights(weights, count) {
  if (!Array.isArray(weights) || weights.length !== count) return equalCanvasWeights(count);
  const total = weights.reduce((sum, weight) => sum + Number(weight), 0);
  const normalized = weights.map((weight) => Number(weight) / total);
  return normalized.every((weight) => weight >= CANVAS_MIN_PANE_WIDTH) ? normalized : equalCanvasWeights(count);
}
function splitRows(rows) {
  const weighted = (items, weights, axis) => {
    if (!items.length) return null;
    if (items.length === 1) return items[0];
    const values = Array.isArray(weights) && weights.length === items.length && weights.every((weight) => Number.isFinite(weight) && weight > 0) ? weights : items.map(() => 1);
    const total = values.reduce((sum, value) => sum + value, 0);
    const ratio = Math.min(0.85, Math.max(0.15, values[0] / total));
    const rest = weighted(items.slice(1), values.slice(1), axis);
    return { kind: "split", id: crypto.randomUUID(), axis, ratio, first: items[0], second: rest };
  };
  return weighted(rows.map((row) => weighted(row.panes, row.weights, "row")).filter((node) => Boolean(node)), rows.map(() => 1), "column");
}
function nodeDepth(node) {
  return !node ? 0 : node.kind === "pane" ? 1 : 1 + Math.max(nodeDepth(node.first), nodeDepth(node.second));
}
function balancedNodes(items, axis = "row") {
  if (!items.length) return null;
  if (items.length === 1) return items[0];
  const middle = Math.ceil(items.length / 2);
  return { kind: "split", id: crypto.randomUUID(), axis, ratio: middle / items.length, first: balancedNodes(items.slice(0, middle), axis === "row" ? "column" : "row"), second: balancedNodes(items.slice(middle), axis === "row" ? "column" : "row") };
}
function legacyPages(tree, focusedPaneId) {
  const items = panesInCanvasNode(tree);
  let roots;
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
function legacyPageLayout(roots, focusedPaneId) {
  return {
    version: 6,
    // Focus lands on the page that actually holds the pane, and only when that
    // pane survived the spread; otherwise it is dropped rather than invalidated.
    pages: roots.map((root, index) => ({ id: `page-${index + 1}`, name: `Page ${index + 1}`, root, focusedPaneId: focusedPaneId && panesInCanvasNode(root).some((pane) => pane.id === focusedPaneId) ? focusedPaneId : null, projectFilter: "" })),
    activePageId: "page-1"
  };
}
function normalizeCanvasLayoutPreference(layout) {
  const source = layout;
  if (source.version === 6) return source;
  const { roots, focusedPaneId } = legacyPages(source.version === 1 ? source.root ?? null : splitRows(source.rows), source.focusedPaneId ?? null);
  return legacyPageLayout(roots, focusedPaneId);
}
const CANVAS_MODIFIERS = [...CANVAS_CHORD_MODIFIERS];
const CANVAS_KEYMAP_COMMANDS = [
  "toggleView",
  "spotlight",
  "pendingReviews",
  "recents",
  "runningConversations",
  "settings",
  "focusInput",
  "paneSearch",
  "recentPane",
  "focusPane",
  "splitRight",
  "splitBelow",
  "closePane",
  "createPage",
  "nextPage",
  "prevPage",
  "focusLeft",
  "focusRight",
  "focusUp",
  "focusDown",
  "page1",
  "page2",
  "page3",
  "page4",
  "page5",
  "page6",
  "page7",
  "page8",
  "page9",
  "toggleProjects",
  "toggleChats",
  "board",
  "newProject",
  "newPiChat",
  "newClaudeChat",
  "newKiroChat",
  "quickNote",
  "toggleNotes",
  "runsOn",
  "selectAgent",
  "selectModel",
  "selectThinking",
  "terminal",
  "notify",
  "addToCanvas",
  "rename",
  "browser",
  "scheduledTasks",
  "backgroundTasks",
  "chatFiles",
  "costs"
];
const CANVAS_COMMAND_MODIFIERS = ["ctrl", "alt"];
const commandChord = (key) => [...CANVAS_COMMAND_MODIFIERS, key];
const defaultCanvasKeymap = () => ({
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
    addToCanvas: commandChord("J"),
    rename: commandChord("E"),
    scheduledTasks: commandChord("S"),
    backgroundTasks: commandChord("U"),
    chatFiles: commandChord("Z"),
    costs: ["ctrl", "alt", "shift", "C"],
    paneSearch: commandChord("F"),
    recentPane: commandChord("L"),
    focusPane: commandChord("G"),
    splitRight: commandChord("\\"),
    splitBelow: commandChord("-"),
    closePane: commandChord("W"),
    // Pages sit on the digits, and the digit that selects no page creates one.
    createPage: commandChord("0"),
    prevPage: commandChord(";"),
    nextPage: commandChord("'"),
    focusLeft: commandChord("ARROWLEFT"),
    focusRight: commandChord("ARROWRIGHT"),
    focusUp: commandChord("ARROWUP"),
    focusDown: commandChord("ARROWDOWN"),
    ...Object.fromEntries([..."123456789"].map((digit, index) => [`page${index + 1}`, commandChord(digit)]))
  }
});
function shortcutPrefix(shortcut) {
  return shortcut.filter((token) => !CANVAS_MODIFIERS.includes(token)).length === 2 ? shortcut.slice(0, -1) : null;
}
function shortcutsConflict(left, right) {
  if (JSON.stringify(left) === JSON.stringify(right)) return true;
  const leftPrefix = shortcutPrefix(left);
  const rightPrefix = shortcutPrefix(right);
  return Boolean(leftPrefix && !rightPrefix && JSON.stringify(leftPrefix) === JSON.stringify(right) || rightPrefix && !leftPrefix && JSON.stringify(rightPrefix) === JSON.stringify(left));
}
function normalizeCanvasKeymapPreference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultCanvasKeymap();
  const source = value;
  const base = normalizeCanvasChordTokens(source.commands ? source.base : source.modifiers, true) ?? [...defaultCanvasKeymap().base];
  const rebuild = !(Number(source.version) >= 4);
  const commands = {};
  const taken = [];
  for (const command of CANVAS_KEYMAP_COMMANDS) {
    const stored = source.commands?.[command];
    const raw = rebuild || stored === void 0 ? [...defaultCanvasKeymap().commands[command]] : stored;
    const chord = raw === null || typeof raw === "string" ? null : normalizeCanvasChordTokens(raw);
    commands[command] = chord && !taken.some((existing) => shortcutsConflict(existing, chord)) ? chord : null;
    if (commands[command]) taken.push(commands[command]);
  }
  return { version: 4, base, commands };
}
function parseCanvasKeymap(value) {
  try {
    return normalizeCanvasKeymapPreference(JSON.parse(value));
  } catch {
    return defaultCanvasKeymap();
  }
}
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
let database;
function preferencesDatabase() {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 448 });
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
  const columns = database.prepare("PRAGMA table_info(user_preferences)").all();
  if (!columns.some((column) => column.name === "completion_sound")) database.exec("ALTER TABLE user_preferences ADD COLUMN completion_sound TEXT NOT NULL DEFAULT 'chime'");
  if (!columns.some((column) => column.name === "active_session_id")) database.exec("ALTER TABLE user_preferences ADD COLUMN active_session_id TEXT");
  if (!columns.some((column) => column.name === "active_node_id")) database.exec("ALTER TABLE user_preferences ADD COLUMN active_node_id TEXT");
  if (!columns.some((column) => column.name === "pinned_project_ids")) database.exec("ALTER TABLE user_preferences ADD COLUMN pinned_project_ids TEXT NOT NULL DEFAULT '[]'");
  if (!columns.some((column) => column.name === "pinned_session_paths")) database.exec("ALTER TABLE user_preferences ADD COLUMN pinned_session_paths TEXT NOT NULL DEFAULT '[]'");
  if (!columns.some((column) => column.name === "focus_ui_enabled")) database.exec("ALTER TABLE user_preferences ADD COLUMN focus_ui_enabled INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "projects_panel_collapsed")) database.exec("ALTER TABLE user_preferences ADD COLUMN projects_panel_collapsed INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "chats_panel_collapsed")) database.exec("ALTER TABLE user_preferences ADD COLUMN chats_panel_collapsed INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "recent_sessions")) database.exec("ALTER TABLE user_preferences ADD COLUMN recent_sessions TEXT NOT NULL DEFAULT '[]'");
  if (!columns.some((column) => column.name === "last_seen_version")) database.exec("ALTER TABLE user_preferences ADD COLUMN last_seen_version TEXT");
  if (!columns.some((column) => column.name === "canvas_layout")) database.exec(`ALTER TABLE user_preferences ADD COLUMN canvas_layout TEXT NOT NULL DEFAULT '{"version":1,"root":null,"focusedPaneId":null}'`);
  if (!columns.some((column) => column.name === "canvas_keymap")) database.exec(`ALTER TABLE user_preferences ADD COLUMN canvas_keymap TEXT NOT NULL DEFAULT '{"modifiers":["meta","shift"],"recentPane":"E","focusPane":"G","paneSearch":"F"}'`);
  if (!columns.some((column) => column.name === "conversation_last_read")) database.exec("ALTER TABLE user_preferences ADD COLUMN conversation_last_read TEXT NOT NULL DEFAULT '{}'");
  if (!columns.some((column) => column.name === "git_reviewer")) database.exec("ALTER TABLE user_preferences ADD COLUMN git_reviewer TEXT NOT NULL DEFAULT 'null'");
  return database;
}
function ensurePreferences(userId) {
  preferencesDatabase().prepare(`
    INSERT INTO user_preferences (user_id, updated_at)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO NOTHING
  `).run(userId, (/* @__PURE__ */ new Date()).toISOString());
}
function parseStringList(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
const CONVERSATION_LAST_READ_LIMIT = 300;
function boundConversationLastRead(marks) {
  const ids = Object.keys(marks);
  if (ids.length <= CONVERSATION_LAST_READ_LIMIT) return marks;
  return Object.fromEntries(ids.sort((left, right) => marks[right] - marks[left]).slice(0, CONVERSATION_LAST_READ_LIMIT).map((id) => [id, marks[id]]));
}
function parseConversationLastRead(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry) => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0));
  } catch {
    return {};
  }
}
function canonicalSessionPath(sessionPath) {
  return sessionPath.replace(/\.sync-conflict-[^/\\]+(?=\.jsonl$)/, "");
}
function canonicalRecentSessions(sessions) {
  const identities = /* @__PURE__ */ new Set();
  return sessions.flatMap((entry) => {
    const canonicalEntry = { ...entry, sessionPath: canonicalSessionPath(entry.sessionPath), updatedAt: entry.updatedAt ?? null };
    const identity = `${entry.projectId}\0${canonicalEntry.sessionPath}`;
    if (identities.has(identity)) return [];
    identities.add(identity);
    return [canonicalEntry];
  });
}
function parseRecentSessions(value) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const sessions = parsed.filter((entry) => typeof entry === "object" && entry !== null && typeof entry.projectId === "string" && typeof entry.sessionPath === "string" && typeof entry.title === "string" && typeof entry.openedAt === "string" && (entry.engine === void 0 || isHarnessId(entry.engine)) && (entry.sessionId === void 0 || typeof entry.sessionId === "string"));
    return canonicalRecentSessions(sessions);
  } catch {
    return [];
  }
}
function validStoredCanvasNode(node, depth, ids, identities) {
  if (!node || typeof node !== "object" || depth > 8) return null;
  const item = node;
  if (typeof item.id !== "string" || !item.id || item.id.length > 200 || ids.has(item.id)) return null;
  ids.add(item.id);
  if (item.kind === "pane") {
    if (typeof item.projectId !== "string" || !item.projectId || item.projectId.length > 120 || typeof item.sessionPath !== "string" || !item.sessionPath || item.sessionPath.length > 2e3 || typeof item.sessionId !== "string" || !item.sessionId || item.sessionId.length > 200 || !(item.executionNodeId === null || typeof item.executionNodeId === "string" && item.executionNodeId.length <= 100) || item.harnessId !== void 0 && !isHarnessId(item.harnessId)) return null;
    const sessionPath = canonicalSessionPath(item.sessionPath);
    const identity = `${item.projectId}\0${item.sessionId}`;
    const pathIdentity = `${item.projectId}\0${sessionPath}`;
    if (identities.has(identity) || identities.has(pathIdentity)) return null;
    identities.add(identity);
    identities.add(pathIdentity);
    return { kind: "pane", id: item.id, projectId: item.projectId, sessionPath, sessionId: item.sessionId, executionNodeId: item.executionNodeId, ...item.harnessId === void 0 ? {} : { harnessId: item.harnessId } };
  }
  if (item.kind !== "split" || item.axis !== "row" && item.axis !== "column" || typeof item.ratio !== "number" || !Number.isFinite(item.ratio) || item.ratio < 0.15 || item.ratio > 0.85) return null;
  const first = validStoredCanvasNode(item.first, depth + 1, ids, identities);
  const second = validStoredCanvasNode(item.second, depth + 1, ids, identities);
  return first && second ? { kind: "split", id: item.id, axis: item.axis, ratio: item.ratio, first, second } : null;
}
function validStoredCanvasLayout(value) {
  if (!value || typeof value !== "object") return null;
  const source = value;
  if (source.version !== 6 || !Array.isArray(source.pages) || source.pages.length < 1 || source.pages.length > 9 || typeof source.activePageId !== "string") return null;
  const ids = /* @__PURE__ */ new Set();
  const identities = /* @__PURE__ */ new Set();
  const pages = [];
  for (const item of source.pages) {
    if (!item || typeof item !== "object") return null;
    const page = item;
    if (typeof page.id !== "string" || !page.id || page.id.length > 200 || ids.has(page.id) || typeof page.name !== "string" || !page.name.trim() || page.name.length > 80 || typeof page.projectFilter !== "string" || page.projectFilter.length > 120 || !(page.focusedPaneId === null || typeof page.focusedPaneId === "string")) return null;
    ids.add(page.id);
    const root = page.root === null ? null : validStoredCanvasNode(page.root, 1, ids, identities);
    if (page.root !== null && !root) return null;
    const pagePanes = panesInCanvasNode(root);
    if (pagePanes.length > 8 || page.focusedPaneId && !pagePanes.some((pane) => pane.id === page.focusedPaneId)) return null;
    pages.push({ id: page.id, name: page.name, root, focusedPaneId: page.focusedPaneId, projectFilter: page.projectFilter });
  }
  return pages.some((page) => page.id === source.activePageId) ? { version: 6, pages, activePageId: source.activePageId } : null;
}
function panesInCanvasNode(node, result = []) {
  if (!node) return result;
  if (node.kind === "pane") result.push(node);
  else {
    panesInCanvasNode(node.first, result);
    panesInCanvasNode(node.second, result);
  }
  return result;
}
function parseCanvasLayout(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return emptyCanvasLayout();
    if (parsed.version === 1) {
      const legacy = parsed;
      const ids2 = /* @__PURE__ */ new Set();
      const identities = /* @__PURE__ */ new Set();
      const root = validStoredCanvasNode(legacy.root ?? null, 1, ids2, identities);
      if (legacy.root != null && !root) return emptyCanvasLayout();
      const panes = panesInCanvasNode(root);
      const focusedPaneId = typeof legacy.focusedPaneId === "string" && panes.some((pane) => pane.id === legacy.focusedPaneId) ? legacy.focusedPaneId : null;
      const { roots, focusedPaneId: keptFocus } = legacyPages(root, focusedPaneId);
      return legacyPageLayout(roots, keptFocus);
    }
    if (parsed.version === 6) return validStoredCanvasLayout(parsed) ?? emptyCanvasLayout();
    const layout = parsed;
    const ids = /* @__PURE__ */ new Set();
    const sessionIdentities = /* @__PURE__ */ new Set();
    const pathIdentities = /* @__PURE__ */ new Set();
    const paneIds = /* @__PURE__ */ new Set();
    if (!Array.isArray(layout.rows) || layout.rows.length > 10) return emptyCanvasLayout();
    const rows = [];
    for (const row of layout.rows) {
      if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id || row.id.length > 200 || ids.has(row.id)) return emptyCanvasLayout();
      ids.add(row.id);
      if (!Array.isArray(row.panes) || row.panes.length < 1 || row.panes.length > 8) return emptyCanvasLayout();
      if (![2, 3, 4, 5].includes(layout.version)) return emptyCanvasLayout();
      if (layout.version !== 4 && (!Array.isArray(row.weights) || row.weights.length !== row.panes.length || !row.weights.every((weight) => typeof weight === "number" && Number.isFinite(weight) && weight > 0))) return emptyCanvasLayout();
      if ((layout.version === 3 || layout.version === 5) && !(row.height === void 0 || row.height === null || typeof row.height === "number" && Number.isFinite(row.height))) return emptyCanvasLayout();
      const panes = [];
      for (const item of row.panes) {
        if (!item || typeof item !== "object") return emptyCanvasLayout();
        if (typeof item.id !== "string" || !item.id || item.id.length > 200 || ids.has(item.id)) return emptyCanvasLayout();
        ids.add(item.id);
        if (item.kind !== "pane" || typeof item.projectId !== "string" || !item.projectId || item.projectId.length > 120 || typeof item.sessionPath !== "string" || !item.sessionPath || item.sessionPath.length > 2e3 || typeof item.sessionId !== "string" || !item.sessionId || item.sessionId.length > 200 || !(item.executionNodeId === null || typeof item.executionNodeId === "string" && item.executionNodeId.length <= 100) || item.harnessId !== void 0 && !isHarnessId(item.harnessId)) return emptyCanvasLayout();
        const identity = `${item.projectId}\0${item.sessionId}`;
        const pathIdentity = `${item.projectId}\0${canonicalSessionPath(item.sessionPath)}`;
        if (sessionIdentities.has(identity) || pathIdentities.has(pathIdentity)) return emptyCanvasLayout();
        sessionIdentities.add(identity);
        pathIdentities.add(pathIdentity);
        paneIds.add(item.id);
        panes.push({ kind: "pane", id: item.id, projectId: item.projectId, sessionPath: canonicalSessionPath(item.sessionPath), sessionId: item.sessionId, executionNodeId: item.executionNodeId, ...item.harnessId === void 0 ? {} : { harnessId: item.harnessId } });
      }
      const weights = normalizedCanvasWeights(row.weights, panes.length);
      const height = layout.version === 3 || layout.version === 5 ? row.height ?? null : null;
      if (layout.version === 5 && !canvasRowGeometryIsLegal({ height, weights: row.weights })) return emptyCanvasLayout();
      rows.push({ id: row.id, height, weights, panes });
    }
    if (!(layout.focusedPaneId === null || typeof layout.focusedPaneId === "string" && paneIds.has(layout.focusedPaneId))) return emptyCanvasLayout();
    return normalizeCanvasLayoutPreference({ version: layout.version, rows, focusedPaneId: layout.focusedPaneId ?? null });
  } catch {
    return emptyCanvasLayout();
  }
}
function migrateLegacyCanvasLayout(parsed) {
  const legacy = parsed;
  const ids = /* @__PURE__ */ new Set();
  const sessionIdentities = /* @__PURE__ */ new Set();
  const pathIdentities = /* @__PURE__ */ new Set();
  const paneIds = /* @__PURE__ */ new Set();
  const pane = (item) => {
    if (!item || typeof item !== "object") return null;
    const candidate = item;
    if (candidate.kind !== "pane" || typeof candidate.id !== "string" || !candidate.id || ids.has(candidate.id)) return null;
    if (typeof candidate.projectId !== "string" || !candidate.projectId || candidate.projectId.length > 120 || typeof candidate.sessionPath !== "string" || !candidate.sessionPath || candidate.sessionPath.length > 2e3 || typeof candidate.sessionId !== "string" || !candidate.sessionId || candidate.sessionId.length > 200 || !(candidate.executionNodeId === null || typeof candidate.executionNodeId === "string" && candidate.executionNodeId.length <= 100) || candidate.harnessId !== void 0 && !isHarnessId(candidate.harnessId)) return null;
    const identity = `${candidate.projectId}\0${candidate.sessionId}`;
    const pathIdentity = `${candidate.projectId}\0${canonicalSessionPath(candidate.sessionPath)}`;
    if (sessionIdentities.has(identity) || pathIdentities.has(pathIdentity)) return null;
    ids.add(candidate.id);
    sessionIdentities.add(identity);
    pathIdentities.add(pathIdentity);
    paneIds.add(candidate.id);
    return { kind: "pane", id: candidate.id, projectId: candidate.projectId, sessionPath: canonicalSessionPath(candidate.sessionPath), sessionId: candidate.sessionId, executionNodeId: candidate.executionNodeId, ...candidate.harnessId === void 0 ? {} : { harnessId: candidate.harnessId } };
  };
  const rows = [];
  let valid = true;
  const chunk = (entries) => {
    for (let start = 0; start < entries.length && rows.length < 10; start += 8) {
      const panes = entries.slice(start, start + 8);
      rows.push({ id: crypto.randomUUID(), height: null, weights: equalCanvasWeights(panes.length), panes });
    }
  };
  const collect = (candidate, level, entries) => {
    if (!candidate || typeof candidate !== "object" || level > 8) {
      valid = false;
      return;
    }
    const entry = candidate;
    if (entry.kind === "pane") {
      const flat = pane(entry);
      if (flat) entries.push(flat);
      else valid = false;
      return;
    }
    if (entry.kind !== "split" || entry.axis !== "row" && entry.axis !== "column") {
      valid = false;
      return;
    }
    if (entry.axis === "row" && (typeof entry.ratio !== "number" || !Number.isFinite(entry.ratio) || entry.ratio < 0.15 || entry.ratio > 0.85)) {
      valid = false;
      return;
    }
    collect(entry.first, level + 1, entries);
    collect(entry.second, level + 1, entries);
  };
  const visit = (node, depth) => {
    if (!node) return;
    if (typeof node !== "object" || depth > 8) {
      valid = false;
      return;
    }
    const item = node;
    if (item.kind === "split" && item.axis === "column") {
      if (typeof item.ratio !== "number" || !Number.isFinite(item.ratio) || item.ratio < 0.15 || item.ratio > 0.85) {
        valid = false;
        return;
      }
      visit(item.first, depth + 1);
      visit(item.second, depth + 1);
      return;
    }
    const entries = [];
    collect(item, depth, entries);
    chunk(entries);
  };
  visit(legacy.root, 0);
  if (!valid || typeof legacy.focusedPaneId === "string" && !paneIds.has(legacy.focusedPaneId)) return emptyCanvasLayout();
  return normalizeCanvasLayoutPreference({ version: 5, rows, focusedPaneId: typeof legacy.focusedPaneId === "string" ? legacy.focusedPaneId : null });
}
function preferencesFromRow(row) {
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
    focusUiEnabled: row.focus_ui_enabled === 1,
    projectsPanelCollapsed: row.projects_panel_collapsed === 1,
    chatsPanelCollapsed: row.chats_panel_collapsed === 1,
    lastSeenVersion: row.last_seen_version,
    canvasLayout: parseCanvasLayout(row.canvas_layout),
    canvasKeymap: parseCanvasKeymap(row.canvas_keymap),
    conversationLastRead: parseConversationLastRead(row.conversation_last_read),
    gitReviewer: JSON.parse(row.git_reviewer)
  };
}
function currentPreferences(userId) {
  const row = preferencesDatabase().prepare(`
    SELECT theme, notifications_enabled, completion_sound, install_dismissed, mobile_view,
      active_project_id, active_session_path, active_session_id, active_node_id, legacy_migrated,
      pinned_project_ids, pinned_session_paths, focus_ui_enabled, projects_panel_collapsed, chats_panel_collapsed,
      last_seen_version, canvas_layout, canvas_keymap, conversation_last_read, git_reviewer
    FROM user_preferences WHERE user_id = ?
  `).get(userId);
  return preferencesFromRow(row);
}
function getUserPreferences(userId) {
  ensurePreferences(userId);
  return currentPreferences(userId);
}
function readLegacyRecentSessions(userId) {
  ensurePreferences(userId);
  const row = preferencesDatabase().prepare("SELECT recent_sessions FROM user_preferences WHERE user_id = ?").get(userId);
  return parseRecentSessions(row.recent_sessions);
}
function allPinnedSessionPaths() {
  const rows = preferencesDatabase().prepare("SELECT pinned_session_paths FROM user_preferences").all();
  return [...new Set(rows.flatMap((row) => parseStringList(row.pinned_session_paths)))];
}
function updateUserPreferences(userId, partial) {
  const columns = [];
  const values = [];
  const fields = [
    ["theme", "theme", (value) => value],
    ["notificationsEnabled", "notifications_enabled", (value) => value ? 1 : 0],
    ["completionSound", "completion_sound", (value) => value],
    ["installDismissed", "install_dismissed", (value) => value ? 1 : 0],
    ["mobileView", "mobile_view", (value) => value],
    ["activeProjectId", "active_project_id", (value) => value],
    ["activeSessionPath", "active_session_path", (value) => value],
    ["activeSessionId", "active_session_id", (value) => value],
    ["activeNodeId", "active_node_id", (value) => value],
    ["legacyMigrated", "legacy_migrated", (value) => value ? 1 : 0],
    ["pinnedProjectIds", "pinned_project_ids", (value) => JSON.stringify(value)],
    ["pinnedSessionPaths", "pinned_session_paths", (value) => JSON.stringify(value)],
    ["focusUiEnabled", "focus_ui_enabled", (value) => value ? 1 : 0],
    ["projectsPanelCollapsed", "projects_panel_collapsed", (value) => value ? 1 : 0],
    ["chatsPanelCollapsed", "chats_panel_collapsed", (value) => value ? 1 : 0],
    ["lastSeenVersion", "last_seen_version", (value) => value],
    ["canvasLayout", "canvas_layout", (value) => JSON.stringify(value)],
    ["canvasKeymap", "canvas_keymap", (value) => JSON.stringify(value)],
    ["conversationLastRead", "conversation_last_read", (value) => JSON.stringify(boundConversationLastRead(value))],
    ["gitReviewer", "git_reviewer", (value) => JSON.stringify(value)]
  ];
  for (const [property, column, serialize] of fields) {
    if (partial[property] === void 0) continue;
    columns.push(`${column} = ?`);
    values.push(serialize(partial[property]));
  }
  const db = preferencesDatabase();
  db.exec("BEGIN");
  try {
    ensurePreferences(userId);
    if (columns.length) {
      db.prepare(`UPDATE user_preferences SET ${columns.join(", ")}, updated_at = ? WHERE user_id = ?`).run(...values, (/* @__PURE__ */ new Date()).toISOString(), userId);
    }
    const preferences = currentPreferences(userId);
    db.exec("COMMIT");
    return preferences;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export {
  CANVAS_MAX_ROW_HEIGHT,
  CANVAS_MIN_PANE_WIDTH,
  CANVAS_MIN_ROW_HEIGHT,
  CANVAS_WIDTH_TOLERANCE,
  CONVERSATION_LAST_READ_LIMIT,
  allPinnedSessionPaths,
  boundConversationLastRead,
  canvasRowGeometryIsLegal,
  defaultCanvasKeymap,
  getUserPreferences,
  migrateLegacyCanvasLayout,
  normalizeCanvasKeymapPreference,
  normalizeCanvasLayoutPreference,
  readLegacyRecentSessions,
  updateUserPreferences
};
