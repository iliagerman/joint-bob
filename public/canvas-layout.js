// Pure recursive canvas layout operations.
export const CANVAS_MAX_PAGES = 9;
export const CANVAS_MAX_PAGE_PANES = 8;
export const CANVAS_MAX_SPLIT_DEPTH = 8;
export const CANVAS_MIN_SPLIT_RATIO = 0.15;
export const CANVAS_MAX_SPLIT_RATIO = 0.85;

export function canonicalSessionPath(sessionPath) { return sessionPath.replace(/\.sync-conflict-[^/\\]+(?=\.jsonl$)/, ""); }
export function emptyCanvasLayout() { return { version: 6, pages: [{ id: "page-1", name: "Page 1", root: null, focusedPaneId: null, projectFilter: "" }], activePageId: "page-1" }; }
const copy = (node) => !node ? null : node.kind === "pane" ? { ...node } : { ...node, first: copy(node.first), second: copy(node.second) };
const panes = (node, result = []) => { if (!node) return result; if (node.kind === "pane") result.push(node); else { panes(node.first, result); panes(node.second, result); } return result; };
const find = (node, id) => !node ? null : node.id === id ? node : node.kind === "split" ? find(node.first, id) || find(node.second, id) : null;
const replace = (node, id, value) => node.id === id ? value : node.kind === "pane" ? node : { ...node, first: replace(node.first, id, value), second: replace(node.second, id, value) };
const pageIndex = (layout, pageId) => { const index = layout.pages.findIndex((page) => page.id === pageId); if (index < 0) throw new Error("Unknown canvas page"); return index; };
export function activeCanvasPage(layout) { return layout.pages[pageIndex(layout, layout.activePageId)]; }
export function listCanvasPagePanes(layout, pageId = layout.activePageId) { return panes(layout.pages[pageIndex(layout, pageId)].root); }
export function listCanvasPanes(layout) { return layout.pages.flatMap((page) => panes(page.root)); }
const panePage = (layout, paneId) => {
  const index = layout.pages.findIndex((page) => panes(page.root).some((pane) => pane.id === paneId));
  if (index < 0) throw new Error("Unknown canvas pane");
  return index;
};
export function canvasPageForPane(layout, paneId) { return layout.pages[panePage(layout, paneId)]; }
const withPage = (layout, index, page) => ({ ...layout, pages: layout.pages.map((item, i) => i === index ? page : item) });
const withRoot = (layout, index, root, focusedPaneId = layout.pages[index].focusedPaneId) => withPage(layout, index, { ...layout.pages[index], root, focusedPaneId });
function assertIdentityFree(layout, pane, ignored = null) { for (const item of listCanvasPanes(layout)) { if (item.id === ignored) continue; if (item.id === pane.id || item.projectId === pane.projectId && (item.sessionId === pane.sessionId || canonicalSessionPath(item.sessionPath) === canonicalSessionPath(pane.sessionPath))) throw new Error("Conversation is already on the canvas"); } }
function depth(node) { return !node ? 0 : node.kind === "pane" ? 1 : 1 + Math.max(depth(node.first), depth(node.second)); }
function split(pane, target, placement) { const axis = placement === "left" || placement === "right" ? "row" : "column"; const node = { kind: "split", id: crypto.randomUUID(), axis, ratio: 0.5, first: copy(target), second: copy(pane) }; if (placement === "left" || placement === "above") [node.first, node.second] = [node.second, node.first]; return node; }
export function addCanvasPane(layout, pane, targetPaneId = null, placement = "right") {
  placement = placement === "row" ? "right" : placement === "column" ? "below" : placement;
  if (!["left", "right", "above", "below"].includes(placement)) throw new Error("Unknown placement");
  assertIdentityFree(layout, pane); const index = targetPaneId ? panePage(layout, targetPaneId) : pageIndex(layout, layout.activePageId); const page = layout.pages[index];
  if (panes(page.root).length >= CANVAS_MAX_PAGE_PANES) throw new Error("A page holds at most eight conversations");
  const target = targetPaneId ? find(page.root, targetPaneId) : panes(page.root).at(-1);
  if (page.root && (!target || target.kind !== "pane")) throw new Error("Unknown canvas pane");
  let root = !page.root ? copy(pane) : replace(page.root, target.id, split(pane, target, placement));
  if (depth(root) > CANVAS_MAX_SPLIT_DEPTH) throw new Error("Canvas splits cannot nest deeper than eight levels");
  return { ...withRoot(layout, index, root), activePageId: page.id };
}
export function replaceCanvasPane(layout, paneId, pane) { const index = panePage(layout, paneId); assertIdentityFree(layout, pane, paneId); return withRoot(layout, index, replace(layout.pages[index].root, paneId, { ...pane, id: paneId })); }
export function removeCanvasPane(layout, paneId) { const index = panePage(layout, paneId); const remove = (node) => { if (node.kind === "pane") return node.id === paneId ? null : node; const first = remove(node.first); const second = remove(node.second); return !first ? second : !second ? first : { ...node, first, second }; }; const page = layout.pages[index]; return withRoot(layout, index, remove(page.root), page.focusedPaneId === paneId ? null : page.focusedPaneId); }
export function setCanvasSplitRatio(layout, splitId, ratio) { if (!Number.isFinite(ratio)) throw new Error("Invalid canvas ratio"); const index = layout.pages.findIndex((page) => find(page.root, splitId)?.kind === "split"); if (index < 0) throw new Error("Unknown canvas split"); const node = find(layout.pages[index].root, splitId); return withRoot(layout, index, replace(layout.pages[index].root, splitId, { ...node, ratio: Math.min(CANVAS_MAX_SPLIT_RATIO, Math.max(CANVAS_MIN_SPLIT_RATIO, ratio)) })); }
export function canvasPageGeometry(layout, pageId = layout.activePageId) { const result = { panes: new Map(), splits: new Map() }; const walk = (node, top, bottom, left, right) => { if (!node) return; if (node.kind === "pane") { result.panes.set(node.id, { top, bottom, left, right }); return; } const boundary = node.axis === "row" ? left + (right - left) * node.ratio : top + (bottom - top) * node.ratio; result.splits.set(node.id, { axis: node.axis, ratio: node.ratio, top, bottom, left, right, boundary }); if (node.axis === "row") { walk(node.first, top, bottom, left, boundary); walk(node.second, top, bottom, boundary, right); } else { walk(node.first, top, boundary, left, right); walk(node.second, boundary, bottom, left, right); } }; walk(activeCanvasPage({ ...layout, activePageId: pageId }).root, 0, 1, 0, 1); return result; }
export function canvasPaneNeighbor(layout, paneId, direction) { if (!["left", "right", "up", "down"].includes(direction)) throw new Error("Unknown canvas direction"); const index = panePage(layout, paneId); const geometry = canvasPageGeometry(layout, layout.pages[index].id); const source = geometry.panes.get(paneId); if (!source) throw new Error("Unknown canvas pane"); const horizontal = direction === "left" || direction === "right"; const candidates = [...geometry.panes.entries()].flatMap(([id, box]) => { if (id === paneId) return []; const forward = direction === "left" ? source.left - box.right : direction === "right" ? box.left - source.right : direction === "up" ? source.top - box.bottom : box.top - source.bottom; if (forward < -1e-9) return []; const overlap = horizontal ? Math.min(source.bottom, box.bottom) - Math.max(source.top, box.top) : Math.min(source.right, box.right) - Math.max(source.left, box.left); const center = horizontal ? Math.abs((source.top + source.bottom - box.top - box.bottom) / 2) : Math.abs((source.left + source.right - box.left - box.right) / 2); return [{ id, overlap, forward, center }]; }); candidates.sort((a, b) => {
    const overlapOrder = Number(b.overlap > 0) - Number(a.overlap > 0);
    return overlapOrder || a.forward - b.forward || a.center - b.center || a.id.localeCompare(b.id);
  }); return candidates[0]?.id || null; }
export function canvasPaneMoves(layout, paneId) { return Object.fromEntries(["left", "right", "up", "down"].map((direction) => [direction, Boolean(canvasPaneNeighbor(layout, paneId, direction))])); }
export function moveCanvasPane(layout, paneId, direction) { const target = canvasPaneNeighbor(layout, paneId, direction); if (!target) throw new Error(`Cannot move that pane ${direction}`); const index = panePage(layout, paneId); const first = find(layout.pages[index].root, paneId); const second = find(layout.pages[index].root, target); // The whole node swaps position, ids included: a pane's identity follows its
  // conversation, so focus and visit history keep pointing at it after the move.
  const exchange = (node) => node.kind === "pane" ? node.id === paneId ? second : node.id === target ? first : node : { ...node, first: exchange(node.first), second: exchange(node.second) }; return withRoot(layout, index, exchange(layout.pages[index].root)); }
export function toggleCanvasFocus(layout, paneId) { const index = panePage(layout, paneId); const page = layout.pages[index]; return withRoot(layout, index, page.root, page.focusedPaneId === paneId ? null : paneId); }
function balanced(items, axis = "row") { if (!items.length) return null; if (items.length === 1) return copy(items[0]); const middle = Math.ceil(items.length / 2); return { kind: "split", id: crypto.randomUUID(), axis, ratio: middle / items.length, first: balanced(items.slice(0, middle), axis === "row" ? "column" : "row"), second: balanced(items.slice(middle), axis === "row" ? "column" : "row") }; }
export function arrangeCanvasLayout(layout, paneIds) { const page = activeCanvasPage(layout); const existing = panes(page.root); if (new Set(paneIds).size !== paneIds.length || paneIds.length !== existing.length || existing.some((pane) => !paneIds.includes(pane.id))) throw new Error("An arrangement must include every canvas pane"); const ordered = paneIds.map((id) => find(page.root, id)); return withRoot(layout, pageIndex(layout, page.id), balanced(ordered), null); }
export function organizeCanvasLayout(layout) { const page = activeCanvasPage(layout); return page.root ? arrangeCanvasLayout(layout, panes(page.root).map((pane) => pane.id)) : layout; }
export function createCanvasPage(layout) { if (layout.pages.length >= CANVAS_MAX_PAGES) throw new Error("The canvas holds at most nine pages"); const used = layout.pages.map((page) => Number(/^Page (\d+)$/.exec(page.name)?.[1]) || 0); const number = Math.max(0, ...used) + 1; const page = { id: crypto.randomUUID(), name: `Page ${number}`, root: null, focusedPaneId: null, projectFilter: "" }; return { ...layout, pages: [...layout.pages, page], activePageId: page.id }; }
export function selectCanvasPage(layout, pageId) { pageIndex(layout, pageId); return { ...layout, activePageId: pageId }; }
export function moveCanvasPage(layout, pageId, direction) { if (direction !== "left" && direction !== "right") throw new Error("Unknown canvas page direction"); const index = pageIndex(layout, pageId); const target = index + (direction === "left" ? -1 : 1); if (target < 0 || target >= layout.pages.length) throw new Error(`Cannot move that page ${direction}`); const pages = [...layout.pages]; [pages[index], pages[target]] = [pages[target], pages[index]]; return { ...layout, pages }; }
export function removeCanvasPage(layout, pageId) { const index = pageIndex(layout, pageId); if (layout.pages.length === 1) return emptyCanvasLayout(); const pages = layout.pages.filter((page) => page.id !== pageId); return { ...layout, pages, activePageId: layout.activePageId === pageId ? pages[Math.min(index, pages.length - 1)].id : layout.activePageId }; }
export function setCanvasPageFilter(layout, projectFilter) { const index = pageIndex(layout, layout.activePageId); return withPage(layout, index, { ...layout.pages[index], projectFilter }); }
function rowsTree(rows) {
  const weighted = (items, weights, axis) => {
    if (!items.length) return null;
    if (items.length === 1) return copy(items[0]);
    const valid = Array.isArray(weights) && weights.length === items.length && weights.every((weight) => Number.isFinite(weight) && weight > 0);
    const values = valid ? weights : items.map(() => 1);
    const total = values.reduce((sum, value) => sum + value, 0);
    const ratio = Math.min(CANVAS_MAX_SPLIT_RATIO, Math.max(CANVAS_MIN_SPLIT_RATIO, values[0] / total));
    return { kind: "split", id: crypto.randomUUID(), axis, ratio, first: copy(items[0]), second: weighted(items.slice(1), values.slice(1), axis) };
  };
  return weighted(rows.map((row) => weighted(row.panes, row.weights, "row")).filter(Boolean), rows.map(() => 1), "column");
}
/** A legacy tree that breaks the v6 limits (more than eight conversations, or splits
 *  deeper than eight) is spread over pages of eight as balanced trees, in reading
 *  order. Panes past nine pages are dropped: a pane is only a view onto a
 *  conversation that stays in its project. */
function pagesFromTree(tree) {
  const items = panes(tree);
  if (items.length <= CANVAS_MAX_PAGE_PANES && depth(tree) <= CANVAS_MAX_SPLIT_DEPTH) return [tree];
  const pages = [];
  for (let start = 0; start < items.length && pages.length < CANVAS_MAX_PAGES; start += CANVAS_MAX_PAGE_PANES) {
    pages.push(balanced(items.slice(start, start + CANVAS_MAX_PAGE_PANES)));
  }
  return pages.length ? pages : [null];
}
function legacyPageLayout(roots, focusedPaneId) {
  return {
    version: 6,
    // Focus lands on the page that actually holds the pane, and only when that
    // pane survived the spread; otherwise it is dropped rather than invalidated.
    pages: roots.map((root, index) => ({ id: `page-${index + 1}`, name: `Page ${index + 1}`, root, focusedPaneId: focusedPaneId && panes(root).some((pane) => pane.id === focusedPaneId) ? focusedPaneId : null, projectFilter: "" })),
    activePageId: "page-1",
  };
}
export function migrateCanvasLayout(legacy) {
  return legacyPageLayout(pagesFromTree(legacy?.root ? copy(legacy.root) : null), legacy?.focusedPaneId);
}
export function normalizeCanvasLayout(layout) {
  if (!layout || layout.version === 1) return migrateCanvasLayout(layout);
  if (layout.version >= 2 && layout.version <= 5) return legacyPageLayout(pagesFromTree(rowsTree(layout.rows)), layout.focusedPaneId);
  if (layout.version !== 6) throw new Error("Unknown canvas layout version");
  return layout;
}
export function canvasPaneEngine(pane) { return pane.sessionPath.startsWith("claude:") || pane.sessionPath.startsWith("draft:claude:") ? "claude" : "pi"; }
export const CANVAS_MODIFIERS = ["meta", "ctrl", "alt", "shift"]; export const CANVAS_KEYMAP_COMMANDS = ["recentPane", "focusPane", "paneSearch", "toggleView", "spotlight", "pendingReviews"]; export const DEFAULT_CANVAS_KEYMAP = { modifiers: ["meta", "shift"], recentPane: "E", focusPane: "G", paneSearch: "F", toggleView: "V", spotlight: "P", pendingReviews: "R" };
export const canvasChordIsUsable = (modifiers) => modifiers.some((name) => name !== "shift");
/** The keys a canvas shortcut may hold. Mirrors `src/canvas-keys.ts`; Space is the
 *  split leader, and "/" and "\\" cannot ride a URL path segment to the shortcut routes. */
export const CANVAS_KEY_TOKENS = [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", "[", "]", ";", "'", ",", ".", "-", "=", "`", "ENTER"];
const CANVAS_KEYS = new Set(CANVAS_KEY_TOKENS);
export const canonicalCanvasKey = (key) => { const canonical = typeof key === "string" ? key.toUpperCase() : ""; return CANVAS_KEYS.has(canonical) ? canonical : null; };
export function normalizeCanvasKeymap(keymap) { const source = keymap && typeof keymap === "object" ? keymap : {}; const modifiers = CANVAS_MODIFIERS.filter((name) => (source.modifiers || []).includes(name)); const result = { modifiers: canvasChordIsUsable(modifiers) ? modifiers : [...DEFAULT_CANVAS_KEYMAP.modifiers] }; const used = new Set(); for (const command of CANVAS_KEYMAP_COMMANDS) { const key = canonicalCanvasKey(source[command] === undefined ? DEFAULT_CANVAS_KEYMAP[command] : source[command]); result[command] = key && !used.has(key) ? key : null; if (result[command]) used.add(key); } return result; }
export function canvasChordMatches(keymap, combination) { return CANVAS_MODIFIERS.every((name) => Boolean(combination[`${name}Key`]) === keymap.modifiers.includes(name)); }
/** Physical keys, so a shortcut survives a layout that moves the character elsewhere. */
const CANVAS_KEY_CODES = { BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Minus: "-", Equal: "=", Backquote: "`", Enter: "ENTER", NumpadEnter: "ENTER" };
export const canvasKeyFromCode = (code) => CANVAS_KEY_CODES[code] || /^(?:Digit([0-9])|Key([A-Z]))$/.exec(code || "")?.slice(1).find(Boolean) || null;
/** A key that types no character needs a symbol a person can read on a badge. */
export const canvasKeyLabel = (key) => key === "ENTER" ? "⏎" : (key || "");
const symbols = { meta: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" }; export const canvasChordLabel = (keymap, key = "") => CANVAS_MODIFIERS.filter((name) => keymap.modifiers.includes(name)).map((name) => symbols[name]).join("") + canvasKeyLabel(key);
export const isCanvasSplitLeader = (combination) => combination.code === "Space" && combination.ctrlKey && !combination.metaKey && !combination.altKey && !combination.shiftKey; export const canvasSplitPlacement = (combination) => combination.code === "Backslash" ? "right" : combination.code === "Minus" ? "below" : null; export const isCanvasModifierKey = (combination) => /^(?:Control|Shift|Alt|Meta)(?:Left|Right)$/.test(combination.code);
/** Command/Control + ? opens the shortcuts panel. This one is fixed: it is how a person
 *  finds out what the configurable keys are. It matches the typed "?" as well as
 *  Shift and "/", so a layout that puts "?" elsewhere still works - and the bare "/"
 *  is deliberately left alone, because the terminal and the code editor use it. */
export const isCanvasHelpShortcut = (combination) => (combination.metaKey || combination.ctrlKey)
  && !combination.altKey
  && (combination.key === "?" || (combination.code === "Slash" && combination.shiftKey));
export function fuzzyMatchScore(text, query) { if (!query) return 0; let score = 0, index = -1, prior = -2; const haystack = String(text).toLowerCase(); for (const character of String(query).toLowerCase()) { index = haystack.indexOf(character, index + 1); if (index < 0) return null; score += index === prior + 1 ? 10 : 1; if (index === 0 || /[\s·\-_/]/.test(haystack[index - 1])) score += 5; prior = index; } return score - haystack.length / 100; }
