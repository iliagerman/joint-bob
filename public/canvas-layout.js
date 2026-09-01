// Pure Canvas layout operations. The canvas is a stack of up to ten rows; each
// row holds up to eight panes side by side. Panes reference conversations by
// identity and are never cloned or copied - moving a pane only changes where it
// appears.
//
// A pane owns its own width as a fraction of the row, so a row's widths may sum
// to less than one and leave the rest of the row empty: narrowing one pane never
// widens its neighbour. A row owns its height in pixels, or null while it still
// shares whatever height the canvas has; pinned heights are what make the canvas
// scroll. Version 1 split trees and version 2 shared-weight rows migrate on read.

export const CANVAS_MAX_ROWS = 10;
export const CANVAS_MAX_ROW_PANES = 8;
export const CANVAS_MIN_PANE_WIDTH = 0.08;
export const CANVAS_MIN_ROW_HEIGHT = 200;
export const CANVAS_MAX_ROW_HEIGHT = 2400;

export function canonicalSessionPath(sessionPath) {
  return sessionPath.replace(/\.sync-conflict-[^/\\]+(?=\.jsonl$)/, "");
}

export function emptyCanvasLayout() {
  return { version: 3, rows: [], focusedPaneId: null };
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

function rowOf(panes, weights = panes.map(() => 1 / panes.length), height = null) {
  return { id: crypto.randomUUID(), height, weights: [...weights], panes: panes.map((pane) => ({ ...pane })) };
}

/** Rescales widths to fill exactly `budget`, keeping every pane above the floor.
 * Panes above the floor absorb the whole adjustment; nothing collapses to nothing. */
function fitWidths(weights, budget) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const scaled = weights.map((weight) => (weight / total) * budget);
  if (scaled.every((weight) => weight >= CANVAS_MIN_PANE_WIDTH)) return scaled;
  const spare = budget - weights.length * CANVAS_MIN_PANE_WIDTH;
  return weights.map((weight) => CANVAS_MIN_PANE_WIDTH + (weight / total) * spare);
}

/** Places a new width in a row: it fills the spare room, or shrinks the rest to fit. */
function insertWidth(weights, index, desired) {
  const used = weights.reduce((sum, weight) => sum + weight, 0);
  const room = 1 - used;
  if (room >= CANVAS_MIN_PANE_WIDTH) {
    const next = [...weights];
    next.splice(index, 0, Math.min(desired, room));
    return next;
  }
  // Every pane already in the row still needs its floor, so the newcomer is capped.
  const headroom = 1 - weights.length * CANVAS_MIN_PANE_WIDTH;
  const width = Math.min(headroom, Math.max(CANVAS_MIN_PANE_WIDTH, desired));
  const shrunk = fitWidths(weights, 1 - width);
  shrunk.splice(index, 0, width);
  return shrunk;
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
  return { version: 3, rows, focusedPaneId };
}

/** Split a weighted pane list into legal rows without losing legacy widths. */
function chunkIntoRows(entries) {
  const rows = [];
  for (let start = 0; start < entries.length && rows.length < CANVAS_MAX_ROWS; start += CANVAS_MAX_ROW_PANES) {
    const chunk = entries.slice(start, start + CANVAS_MAX_ROW_PANES);
    rows.push(rowOf(chunk.map((entry) => entry.pane), fitWidths(chunk.map((entry) => entry.weight), 1)));
  }
  return rows;
}

/** Approximate a mixed legacy subtree in one row while retaining row ratios. */
function weightedLegacyPanes(node, weight = 1) {
  if (!node) return [];
  if (node.kind === "pane") return [{ pane: node, weight }];
  if (node.axis === "row") {
    return [
      ...weightedLegacyPanes(node.first, weight * node.ratio),
      ...weightedLegacyPanes(node.second, weight * (1 - node.ratio)),
    ];
  }
  return [
    ...weightedLegacyPanes(node.first, weight / 2),
    ...weightedLegacyPanes(node.second, weight / 2),
  ];
}

/** Version 1 columns stack rows; row splits flatten while retaining their ratios. */
export function migrateCanvasLayout(legacy) {
  const rows = [];
  const visit = (node) => {
    if (!node) return;
    if (node.kind === "pane") { rows.push(rowOf([node])); return; }
    if (node.kind === "split" && node.axis === "column") {
      visit(node.first);
      visit(node.second);
      return;
    }
    rows.push(...chunkIntoRows(weightedLegacyPanes(node)));
  };
  visit(legacy.root);
  return { version: 3, rows: rows.slice(0, CANVAS_MAX_ROWS), focusedPaneId: legacy.focusedPaneId ?? null };
}

/** Accepts stored version 1, 2, or 3 layouts and always returns a version 3 layout. */
export function normalizeCanvasLayout(layout) {
  if (!layout || layout.version === 1) return migrateCanvasLayout(layout || { root: null, focusedPaneId: null });
  if (layout.version === 3) return layout;
  const rows = layout.rows.map((row) => ({ ...row, height: null, weights: fitWidths(row.weights, 1) }));
  return { version: 3, rows, focusedPaneId: layout.focusedPaneId ?? null };
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
  const row = rows[rowIndex];
  if (row.panes.length >= CANVAS_MAX_ROW_PANES) throw new Error("A row holds at most eight conversations");
  row.panes.splice(index, 0, { ...pane });
  row.weights = insertWidth(row.weights, index, 1 / (row.panes.length));
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
  // Surviving panes keep their own widths; the removed pane's share becomes empty row.
  const rows = layout.rows
    .map((row, rowNumber) => rowNumber === at.rowIndex
      ? { ...row, panes: row.panes.filter((_, index) => index !== at.index), weights: row.weights.filter((_, index) => index !== at.index) }
      : row)
    .filter((row) => row.panes.length);
  return withRows(layout, rows, layout.focusedPaneId === paneId ? null : layout.focusedPaneId);
}

/** Which directional moves a pane can make, so the UI can disable the rest. */
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

/** Moves a pane one step: left/right swaps with its neighbour, up/down changes row. */
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
  } else if (direction === "up") {
    const above = rows[at.rowIndex - 1];
    above.panes.push(pane);
    above.weights = insertWidth(above.weights, above.panes.length - 1, weight);
  } else {
    const below = rows[at.rowIndex + 1];
    if (below) {
      below.panes.unshift(pane);
      below.weights = insertWidth(below.weights, 0, weight);
    // A brand-new row starts unpinned: inheriting a tall source row's height would
    // silently double the canvas and jump the scroll position.
    } else rows.splice(at.rowIndex + 1, 0, rowOf([pane], [weight]));
  }
  return withRows(layout, rows.filter((candidate) => candidate.panes.length));
}

/** The legal width for one pane: never under the floor, never past the row's end. */
export function clampCanvasPaneWidth(row, paneIndex, width) {
  const others = row.weights.reduce((sum, weight, index) => index === paneIndex ? sum : sum + weight, 0);
  const available = Math.max(CANVAS_MIN_PANE_WIDTH, 1 - others);
  return Math.min(available, Math.max(CANVAS_MIN_PANE_WIDTH, width));
}

export function clampCanvasRowHeight(height) {
  return Math.round(Math.min(CANVAS_MAX_ROW_HEIGHT, Math.max(CANVAS_MIN_ROW_HEIGHT, height)));
}

/** Sets one pane's own width, leaving every other pane in the row untouched. */
export function setCanvasPaneWidth(layout, rowId, paneIndex, width) {
  const row = layout.rows.find((candidate) => candidate.id === rowId);
  if (!row || paneIndex < 0 || paneIndex >= row.panes.length) throw new Error("Unknown canvas pane width");
  if (!Number.isFinite(width)) throw new Error("Invalid canvas width");
  const clamped = clampCanvasPaneWidth(row, paneIndex, width);
  const rows = layout.rows.map((candidate) => candidate.id === rowId
    ? { ...candidate, weights: candidate.weights.map((weight, index) => index === paneIndex ? clamped : weight) }
    : candidate);
  return withRows(layout, rows);
}

/** Pins one row's height in pixels. Rows the user never dragged stay at null. */
export function setCanvasRowHeight(layout, rowId, height) {
  const row = layout.rows.find((candidate) => candidate.id === rowId);
  if (!row) throw new Error("Unknown canvas row");
  if (!Number.isFinite(height)) throw new Error("Invalid canvas row height");
  const clamped = clampCanvasRowHeight(height);
  const rows = layout.rows.map((candidate) => candidate.id === rowId ? { ...candidate, height: clamped } : candidate);
  return withRows(layout, rows);
}

/** Reflows every pane into as square a grid as fits, resetting widths and heights.
 * Panes keep their reading order, so nothing appears to jump to another canvas. */
export function organizeCanvasLayout(layout) {
  const panes = listCanvasPanes(layout);
  if (!panes.length) return layout;
  const columns = Math.min(CANVAS_MAX_ROW_PANES, Math.ceil(Math.sqrt(panes.length)));
  const rows = [];
  for (let start = 0; start < panes.length; start += columns) {
    const chunk = panes.slice(start, start + columns);
    // A short last row keeps the grid's column width instead of stretching.
    rows.push(rowOf(chunk, chunk.map(() => 1 / columns)));
  }
  return withRows(layout, rows);
}

/** Which agent runs a pane's conversation. Draft paths carry it; plain paths are Pi. */
export function canvasPaneEngine(pane) {
  return pane.sessionPath.startsWith("claude:") || pane.sessionPath.startsWith("draft:claude:") ? "claude" : "pi";
}

export function toggleCanvasFocus(layout, paneId) {
  paneOf(layout, paneId);
  return withRows(layout, layout.rows, layout.focusedPaneId === paneId ? null : paneId);
}
