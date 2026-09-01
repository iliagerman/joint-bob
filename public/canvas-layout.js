// Pure Canvas layout operations. The canvas is a uniform grid: a stack of up to ten
// rows, each holding up to eight panes side by side. Panes reference conversations by
// identity and are never cloned or copied - moving a pane only changes where it
// appears.
//
// A row stores nothing but its panes. Every row shares the canvas height equally and
// every pane shares its row's width equally, so the grid is always completely filled
// and no pane can ever leave a gap. Version 1 split trees and the version 2 and 3
// weighted rows migrate on read by dropping their widths and pinned heights.

export const CANVAS_MAX_ROWS = 10;
export const CANVAS_MAX_ROW_PANES = 8;

export function canonicalSessionPath(sessionPath) {
  return sessionPath.replace(/\.sync-conflict-[^/\\]+(?=\.jsonl$)/, "");
}

export function emptyCanvasLayout() {
  return { version: 4, rows: [], focusedPaneId: null };
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

function rowOf(panes) {
  return { id: crypto.randomUUID(), panes: panes.map((pane) => ({ ...pane })) };
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
  return { version: 4, rows, focusedPaneId };
}

/** Flattens a legacy subtree into panes in reading order; ratios no longer matter. */
function legacyPanes(node) {
  if (!node) return [];
  if (node.kind === "pane") return [node];
  return [...legacyPanes(node.first), ...legacyPanes(node.second)];
}

/** Version 1 columns stack rows; a row split flattens into one row of panes. */
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
  return { version: 4, rows: rows.slice(0, CANVAS_MAX_ROWS), focusedPaneId: legacy.focusedPaneId ?? null };
}

/** Accepts stored version 1, 2, 3, or 4 layouts and always returns a version 4 layout. */
export function normalizeCanvasLayout(layout) {
  if (!layout || layout.version === 1) return migrateCanvasLayout(layout || { root: null, focusedPaneId: null });
  if (layout.version === 4) return layout;
  const rows = layout.rows.map((row) => ({ id: row.id, panes: row.panes }));
  return { version: 4, rows, focusedPaneId: layout.focusedPaneId ?? null };
}

export function addCanvasPane(layout, pane, targetPaneId, axis) {
  assertIdentityFree(layout, pane);
  const rows = layout.rows.map((row) => ({ ...row, panes: [...row.panes] }));
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
  // The survivors widen to fill the row: the grid never keeps the removed pane's space.
  const rows = layout.rows
    .map((row, rowNumber) => rowNumber === at.rowIndex
      ? { ...row, panes: row.panes.filter((_, index) => index !== at.index) }
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
  const rows = layout.rows.map((row) => ({ ...row, panes: [...row.panes] }));
  const row = rows[at.rowIndex];
  const [pane] = row.panes.splice(at.index, 1);
  if (direction === "left" || direction === "right") {
    row.panes.splice(direction === "left" ? at.index - 1 : at.index + 1, 0, pane);
  } else if (direction === "up") {
    rows[at.rowIndex - 1].panes.push(pane);
  } else {
    const below = rows[at.rowIndex + 1];
    if (below) below.panes.unshift(pane);
    else rows.splice(at.rowIndex + 1, 0, rowOf([pane]));
  }
  return withRows(layout, rows.filter((candidate) => candidate.panes.length));
}

/** Reflows every pane into as square a grid as fits.
 * Panes keep their reading order, so nothing appears to jump to another canvas. */
export function organizeCanvasLayout(layout) {
  const panes = listCanvasPanes(layout);
  if (!panes.length) return layout;
  const columns = Math.min(CANVAS_MAX_ROW_PANES, Math.ceil(Math.sqrt(panes.length)));
  const rows = [];
  for (let start = 0; start < panes.length; start += columns) rows.push(rowOf(panes.slice(start, start + columns)));
  // Focus hides every other pane, which would make the new grid look like nothing happened.
  return withRows(layout, rows, null);
}

/** Which agent runs a pane's conversation. Draft paths carry it; plain paths are Pi. */
export function canvasPaneEngine(pane) {
  return pane.sessionPath.startsWith("claude:") || pane.sessionPath.startsWith("draft:claude:") ? "claude" : "pi";
}

export function toggleCanvasFocus(layout, paneId) {
  paneOf(layout, paneId);
  return withRows(layout, layout.rows, layout.focusedPaneId === paneId ? null : paneId);
}
