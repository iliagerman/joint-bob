// Pure Canvas layout operations. The canvas is a stack of up to ten rows, each
// holding up to eight conversation panes. Rows persist a pixel height after the
// user resizes them; panes persist proportional widths that always fill the row.

export const CANVAS_MAX_ROWS = 10;
export const CANVAS_MAX_ROW_PANES = 8;
export const CANVAS_MIN_PANE_WIDTH = 0.08;
export const CANVAS_MIN_ROW_HEIGHT = 200;
export const CANVAS_MAX_ROW_HEIGHT = 2400;

export function canonicalSessionPath(sessionPath) {
  return sessionPath.replace(/\.sync-conflict-[^/\\]+(?=\.jsonl$)/, "");
}

export function emptyCanvasLayout() {
  return { version: 5, rows: [], focusedPaneId: null };
}

export function listCanvasPanes(layout) {
  return layout.rows.flatMap((row) => row.panes);
}

function paneOf(layout, paneId) {
  for (let rowIndex = 0; rowIndex < layout.rows.length; rowIndex += 1) {
    const index = layout.rows[rowIndex].panes.findIndex((pane) => pane.id === paneId);
    if (index >= 0) return { rowIndex, index };
  }
  throw new Error("Unknown canvas pane");
}

function equalWeights(count) {
  return Array.from({ length: count }, () => 1 / count);
}

function normalizedWeights(weights, count) {
  if (!Array.isArray(weights) || weights.length !== count) return equalWeights(count);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const normalized = weights.map((weight) => weight / total);
  return normalized.every((weight) => weight >= CANVAS_MIN_PANE_WIDTH) ? normalized : equalWeights(count);
}

function rowOf(panes, weights = equalWeights(panes.length), height = null) {
  return {
    id: crypto.randomUUID(),
    height,
    weights: normalizedWeights(weights, panes.length),
    panes: panes.map((pane) => ({ ...pane })),
  };
}

function assertIdentityFree(layout, pane, ignoredPaneId = null) {
  for (const candidate of listCanvasPanes(layout)) {
    if (candidate.id === ignoredPaneId) continue;
    const sameSession = candidate.projectId === pane.projectId && candidate.sessionId === pane.sessionId;
    const samePath = candidate.projectId === pane.projectId
      && canonicalSessionPath(candidate.sessionPath) === canonicalSessionPath(pane.sessionPath);
    if (sameSession || samePath) throw new Error("Conversation is already on the canvas");
  }
}

function withRows(layout, rows, focusedPaneId = layout.focusedPaneId) {
  return { version: 5, rows, focusedPaneId };
}

function rebalance(row) {
  if (!row.panes.length) return row;
  return { ...row, weights: normalizedWeights(row.weights, row.panes.length) };
}

function insertPane(row, pane, index) {
  const panes = [...row.panes];
  panes.splice(index, 0, { ...pane });
  return { ...row, panes, weights: equalWeights(panes.length) };
}

/** Flattens a legacy subtree into panes in reading order; old split ratios are discarded. */
function legacyPanes(node) {
  if (!node) return [];
  if (node.kind === "pane") return [node];
  return [...legacyPanes(node.first), ...legacyPanes(node.second)];
}

/** Version 1 columns stack rows; row splits flatten into one row. */
export function migrateCanvasLayout(legacy) {
  const rows = [];
  const visit = (node) => {
    if (!node) return;
    if (node.kind === "pane") { rows.push(rowOf([node])); return; }
    if (node.axis === "column") {
      visit(node.first);
      visit(node.second);
      return;
    }
    const panes = legacyPanes(node);
    for (let start = 0; start < panes.length; start += CANVAS_MAX_ROW_PANES) {
      rows.push(rowOf(panes.slice(start, start + CANVAS_MAX_ROW_PANES)));
    }
  };
  visit(legacy.root);
  return { version: 5, rows: rows.slice(0, CANVAS_MAX_ROWS), focusedPaneId: legacy.focusedPaneId ?? null };
}

/** Accepts every stored layout and returns the current resizable format. */
export function normalizeCanvasLayout(layout) {
  if (!layout || layout.version === 1) return migrateCanvasLayout(layout || { root: null, focusedPaneId: null });
  if (layout.version === 5) return layout;
  const rows = layout.rows.map((row) => ({
    id: row.id,
    height: row.height ?? null,
    weights: normalizedWeights(row.weights, row.panes.length),
    panes: row.panes,
  }));
  return { version: 5, rows, focusedPaneId: layout.focusedPaneId ?? null };
}

export function addCanvasPane(layout, pane, targetPaneId, axis) {
  assertIdentityFree(layout, pane);
  const rows = layout.rows.map((row) => ({ ...row, panes: [...row.panes], weights: [...row.weights] }));
  if (!rows.length) return withRows(layout, [rowOf([pane])], pane.id);
  let rowIndex = rows.length - 1;
  let index = rows[rowIndex].panes.length;
  if (targetPaneId) {
    const target = paneOf(layout, targetPaneId);
    rowIndex = target.rowIndex;
    index = target.index + 1;
  }
  if (axis === "column") {
    if (rows.length >= CANVAS_MAX_ROWS) throw new Error("The canvas holds at most ten rows");
    rows.splice(rowIndex + 1, 0, rowOf([pane]));
    return withRows(layout, rows, pane.id);
  }
  if (axis !== "row") throw new Error("Unknown placement");
  if (rows[rowIndex].panes.length >= CANVAS_MAX_ROW_PANES) throw new Error("A row holds at most eight conversations");
  rows[rowIndex] = insertPane(rows[rowIndex], pane, index);
  return withRows(layout, rows, pane.id);
}

export function replaceCanvasPane(layout, paneId, pane) {
  const at = paneOf(layout, paneId);
  assertIdentityFree(layout, pane, paneId);
  const rows = layout.rows.map((row, rowNumber) => rowNumber === at.rowIndex
    ? { ...row, panes: row.panes.map((candidate, index) => index === at.index ? { ...pane, id: paneId } : candidate) }
    : row);
  return withRows(layout, rows);
}

export function removeCanvasPane(layout, paneId) {
  const at = paneOf(layout, paneId);
  const rows = layout.rows
    .map((row, rowNumber) => rowNumber === at.rowIndex
      ? rebalance({ ...row, panes: row.panes.filter((_, index) => index !== at.index), weights: row.weights.filter((_, index) => index !== at.index) })
      : row)
    .filter((row) => row.panes.length);
  return withRows(layout, rows, layout.focusedPaneId === paneId ? null : layout.focusedPaneId);
}

export function canvasPaneMoves(layout, paneId) {
  const at = paneOf(layout, paneId);
  const row = layout.rows[at.rowIndex];
  return {
    left: at.index > 0,
    right: at.index < row.panes.length - 1,
    up: at.rowIndex > 0 && layout.rows[at.rowIndex - 1].panes.length < CANVAS_MAX_ROW_PANES,
    down: at.rowIndex < layout.rows.length - 1
      ? layout.rows[at.rowIndex + 1].panes.length < CANVAS_MAX_ROW_PANES
      : row.panes.length > 1 && layout.rows.length < CANVAS_MAX_ROWS,
  };
}

export function moveCanvasPane(layout, paneId, direction) {
  const moves = canvasPaneMoves(layout, paneId);
  if (!moves[direction]) throw new Error(`Cannot move that pane ${direction}`);
  const at = paneOf(layout, paneId);
  const rows = layout.rows.map((row) => ({ ...row, panes: [...row.panes], weights: [...row.weights] }));
  const row = rows[at.rowIndex];
  const [pane] = row.panes.splice(at.index, 1);
  const [weight] = row.weights.splice(at.index, 1);
  if (direction === "left" || direction === "right") {
    const target = direction === "left" ? at.index - 1 : at.index + 1;
    row.panes.splice(target, 0, pane);
    row.weights.splice(target, 0, weight);
  } else {
    rows[at.rowIndex] = rebalance(row);
    const targetIndex = direction === "up" ? at.rowIndex - 1 : at.rowIndex + 1;
    if (rows[targetIndex]) rows[targetIndex] = insertPane(rows[targetIndex], pane, direction === "up" ? rows[targetIndex].panes.length : 0);
    else rows.splice(targetIndex, 0, rowOf([pane]));
  }
  return withRows(layout, rows.filter((candidate) => candidate.panes.length));
}

export function setCanvasRowBoundary(layout, rowId, paneIndex, left, right) {
  const row = layout.rows.find((candidate) => candidate.id === rowId);
  if (!row || paneIndex < 0 || paneIndex + 1 >= row.panes.length) throw new Error("Unknown canvas boundary");
  if (![left, right].every((value) => Number.isFinite(value) && value > 0)) throw new Error("Invalid canvas weights");
  const total = left + right;
  if (!Number.isFinite(total)) throw new Error("Invalid canvas weights");
  const minimum = Math.min(CANVAS_MIN_PANE_WIDTH, total / 2);
  const nextLeft = Math.min(total - minimum, Math.max(minimum, left));
  const rows = layout.rows.map((candidate) => candidate.id === rowId ? {
    ...candidate,
    weights: candidate.weights.map((weight, index) => index === paneIndex ? nextLeft : index === paneIndex + 1 ? total - nextLeft : weight),
  } : candidate);
  return withRows(layout, rows);
}

export function setCanvasRowHeight(layout, rowId, height) {
  if (!Number.isFinite(height)) throw new Error("Invalid canvas row height");
  if (!layout.rows.some((row) => row.id === rowId)) throw new Error("Unknown canvas row");
  const clamped = Math.round(Math.min(CANVAS_MAX_ROW_HEIGHT, Math.max(CANVAS_MIN_ROW_HEIGHT, height)));
  return withRows(layout, layout.rows.map((row) => row.id === rowId ? { ...row, height: clamped } : row));
}

/** Gives a row its share of the canvas back, so a double-click undoes a drag. */
export function clearCanvasRowHeight(layout, rowId) {
  if (!layout.rows.some((row) => row.id === rowId)) throw new Error("Unknown canvas row");
  return withRows(layout, layout.rows.map((row) => row.id === rowId ? { ...row, height: null } : row));
}

export function organizeCanvasLayout(layout) {
  const panes = listCanvasPanes(layout);
  if (!panes.length) return layout;
  const columns = Math.min(CANVAS_MAX_ROW_PANES, Math.ceil(Math.sqrt(panes.length)));
  const rows = [];
  for (let start = 0; start < panes.length; start += columns) rows.push(rowOf(panes.slice(start, start + columns)));
  return withRows(layout, rows, null);
}

export function canvasPaneEngine(pane) {
  return pane.sessionPath.startsWith("claude:") || pane.sessionPath.startsWith("draft:claude:") ? "claude" : "pi";
}

export function toggleCanvasFocus(layout, paneId) {
  paneOf(layout, paneId);
  return withRows(layout, layout.rows, layout.focusedPaneId === paneId ? null : paneId);
}

/**
 * Canvas keyboard shortcuts. One modifier chord serves every canvas key, so the user
 * configures it once instead of per binding. Order here is the order the chord is
 * drawn in, so ⌘ comes first and the labels match what the panes already showed.
 */
export const CANVAS_MODIFIERS = ["meta", "ctrl", "alt", "shift"];
export const CANVAS_KEYMAP_COMMANDS = ["recentPane", "focusPane", "paneSearch"];
export const DEFAULT_CANVAS_KEYMAP = {
  modifiers: ["meta", "shift"],
  recentPane: "E",
  focusPane: "G",
  paneSearch: "F",
};

/** Shift alone is not a chord: it would swallow every capital letter a conversation
 * is typing. Every canvas chord needs Command, Control, or Option. */
export function canvasChordIsUsable(modifiers) {
  return modifiers.some((name) => name !== "shift");
}

const MODIFIER_SYMBOLS = { meta: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };

/** One digit or letter, upper case, or null when nothing is bound. */
export function canonicalCanvasKey(key) {
  const canonical = String(key ?? "").toUpperCase();
  return /^[0-9A-Z]$/.test(canonical) ? canonical : null;
}

/**
 * Accepts anything the node or an older client stored. A chord with no modifier would
 * swallow ordinary typing, so an empty set falls back to the default; two commands
 * sharing one key would make the second unreachable, so the later one is dropped.
 */
export function normalizeCanvasKeymap(keymap) {
  const source = keymap && typeof keymap === "object" ? keymap : {};
  const chosen = Array.isArray(source.modifiers) ? source.modifiers : [];
  const modifiers = CANVAS_MODIFIERS.filter((name) => chosen.includes(name));
  const normalized = { modifiers: canvasChordIsUsable(modifiers) ? modifiers : [...DEFAULT_CANVAS_KEYMAP.modifiers] };
  const taken = new Set();
  for (const command of CANVAS_KEYMAP_COMMANDS) {
    const key = canonicalCanvasKey(source[command]);
    normalized[command] = key && !taken.has(key) ? key : null;
    if (normalized[command]) taken.add(key);
  }
  return normalized;
}

/** Exactly the configured modifiers, so a chord never fires with an extra one held. */
export function canvasChordMatches(keymap, combination) {
  const held = {
    meta: Boolean(combination.metaKey),
    ctrl: Boolean(combination.ctrlKey),
    alt: Boolean(combination.altKey),
    shift: Boolean(combination.shiftKey),
  };
  return CANVAS_MODIFIERS.every((name) => held[name] === keymap.modifiers.includes(name));
}

/** Reading `code` keeps a binding on the physical key, so Shift's punctuation and
 * other keyboard layouts never change it. */
export function canvasKeyFromCode(code) {
  const match = /^(?:Digit([0-9])|Key([A-Z]))$/.exec(code || "");
  return match ? match[1] || match[2] : null;
}

export function canvasChordLabel(keymap, key = "") {
  return CANVAS_MODIFIERS.filter((name) => keymap.modifiers.includes(name))
    .map((name) => MODIFIER_SYMBOLS[name]).join("") + key;
}

/**
 * Subsequence match with a score, so typing initials finds the conversation people
 * mean. Adjacent characters and matches that start a word rank highest; a shorter
 * title wins a tie. Returns null when the query is not a subsequence at all.
 */
export function fuzzyMatchScore(text, query) {
  if (!query) return 0;
  const haystack = String(text).toLowerCase();
  const needle = String(query).toLowerCase();
  let score = 0;
  let index = -1;
  let previous = -2;
  for (const character of needle) {
    index = haystack.indexOf(character, index + 1);
    if (index < 0) return null;
    score += index === previous + 1 ? 10 : 1;
    if (index === 0 || /[\s·\-_/]/.test(haystack[index - 1])) score += 5;
    previous = index;
  }
  return score - haystack.length / 100;
}
