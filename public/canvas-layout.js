// Pure Canvas layout operations. The canvas is a stack of up to ten rows; each
// row holds up to eight panes side by side. Panes reference conversations by
// identity and are never cloned or copied - moving a pane only changes where it
// appears. Version 1 split trees migrate into rows on read.

export const CANVAS_MAX_ROWS = 10;
export const CANVAS_MAX_ROW_PANES = 8;

export function canonicalSessionPath(sessionPath) {
  return sessionPath.replace(/\.sync-conflict-[^/\\]+(?=\.jsonl$)/, "");
}

export function emptyCanvasLayout() {
  return { version: 2, rows: [], focusedPaneId: null };
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

function rowOf(panes, weights = panes.map(() => 1)) {
  return { id: crypto.randomUUID(), weights: [...weights], panes: panes.map((pane) => ({ ...pane })) };
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
  return { version: 2, rows, focusedPaneId };
}

/** Split a weighted pane list into legal rows without losing legacy widths. */
function chunkIntoRows(entries) {
  const rows = [];
  for (let start = 0; start < entries.length && rows.length < CANVAS_MAX_ROWS; start += CANVAS_MAX_ROW_PANES) {
    const chunk = entries.slice(start, start + CANVAS_MAX_ROW_PANES);
    rows.push(rowOf(chunk.map((entry) => entry.pane), chunk.map((entry) => entry.weight)));
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
  return { version: 2, rows: rows.slice(0, CANVAS_MAX_ROWS), focusedPaneId: legacy.focusedPaneId ?? null };
}

/** Accepts stored version 1 or 2 layouts and always returns a version 2 layout. */
export function normalizeCanvasLayout(layout) {
  if (!layout || layout.version === 1) return migrateCanvasLayout(layout || { root: null, focusedPaneId: null });
  return layout;
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
  row.weights.splice(index, 0, 1);
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
    rows[at.rowIndex - 1].panes.push(pane);
    rows[at.rowIndex - 1].weights.push(1);
  } else {
    const below = rows[at.rowIndex + 1];
    if (below) { below.panes.unshift(pane); below.weights.unshift(1); }
    else rows.splice(at.rowIndex + 1, 0, rowOf([pane]));
  }
  return withRows(layout, rows.filter((candidate) => candidate.panes.length));
}

/** Adjusts the shared boundary between two neighbouring panes in a row. */
export function setCanvasRowBoundary(layout, rowId, paneIndex, left, right) {
  const row = layout.rows.find((candidate) => candidate.id === rowId);
  if (!row || paneIndex < 0 || paneIndex + 1 >= row.panes.length) throw new Error("Unknown canvas boundary");
  if (![left, right].every((value) => Number.isFinite(value) && value > 0)) throw new Error("Invalid canvas weights");
  const rows = layout.rows.map((candidate) => candidate.id === rowId ? { ...candidate, weights: [...candidate.weights] } : candidate);
  const target = rows.find((candidate) => candidate.id === rowId);
  // Keep the pair's total so other panes in the row keep their share.
  const total = left + right;
  if (!Number.isFinite(total)) throw new Error("Invalid canvas weights");
  const share = 0.15 * total;
  target.weights[paneIndex] = Math.min(total - share, Math.max(share, left));
  target.weights[paneIndex + 1] = total - target.weights[paneIndex];
  return withRows(layout, rows);
}

export function toggleCanvasFocus(layout, paneId) {
  paneOf(layout, paneId);
  return withRows(layout, layout.rows, layout.focusedPaneId === paneId ? null : paneId);
}
