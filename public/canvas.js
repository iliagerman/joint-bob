// Canvas controller: renders a persisted row-based layout of panes, each embedding
// the normal chat surface pointed at one exact conversation. A pane never clones or
// copies a conversation; it reopens an existing session, or - only when the user
// picks it in the dialog - opens one brand-new conversation the pane document
// creates on its own node.
//
// Panes are direct children of the canvas root, placed on a fine-grained CSS grid
// through inline grid-area styles. Adding, removing, moving, resizing, or focusing a
// pane only changes styles: pane elements are never reparented, so no iframe reloads
// and no draft or scroll position is lost.

import {
  addCanvasPane, CANVAS_KEYMAP_COMMANDS, CANVAS_MODIFIERS, canonicalCanvasKey, canvasChordLabel,
  canvasChordIsUsable, canvasChordMatches, canvasKeyFromCode, canvasPaneEngine, canvasPaneMoves, canonicalSessionPath,
  CANVAS_MAX_ROW_HEIGHT, CANVAS_MIN_PANE_WIDTH, CANVAS_MIN_ROW_HEIGHT, clearCanvasRowHeight,
  DEFAULT_CANVAS_KEYMAP, emptyCanvasLayout, fuzzyMatchScore, listCanvasPanes,
  moveCanvasPane, normalizeCanvasKeymap, normalizeCanvasLayout, organizeCanvasLayout, removeCanvasPane,
  replaceCanvasPane, setCanvasRowBoundary, setCanvasRowHeight, toggleCanvasFocus,
} from "./canvas-layout.js";

const CANVAS_GRID_UNITS = 1000;
const CANVAS_WIDTH_STEP = 0.05;
const CANVAS_ROW_HEIGHT_STEP = 40;

export function createConversationCanvas({ api, getProjects, saveLayout, saveKeymap, showMessage }) {
  const root = document.querySelector("#canvasRoot");
  const dialog = document.querySelector("#canvasConversationDialog");
  const projectSelect = document.querySelector("#canvasProjectSelect");
  const searchInput = document.querySelector("#canvasSessionSearch");
  const positionSelect = document.querySelector("#canvasSplitPosition");
  const optionsList = document.querySelector("#canvasSessionOptions");
  const pickerStatus = document.querySelector("#canvasPickerStatus");
  const organizeButton = document.querySelector("#canvasOrganizeButton");
  const shortcutBar = document.querySelector("#canvasShortcutBar");
  const shortcutDialog = document.querySelector("#canvasShortcutDialog");
  const shortcutSubject = document.querySelector("#canvasShortcutSubject");
  const shortcutKeyInput = document.querySelector("#canvasShortcutKey");
  const shortcutStatus = document.querySelector("#canvasShortcutStatus");
  const shortcutRemoveButton = document.querySelector("#canvasShortcutRemoveButton");
  const shortcutSaveButton = document.querySelector("#canvasShortcutSaveButton");
  const shortcutChordLabel = document.querySelector("#canvasShortcutChordLabel");
  const finderButton = document.querySelector("#canvasFinderButton");
  const finderDialog = document.querySelector("#canvasFinderDialog");
  const finderInput = document.querySelector("#canvasFinderInput");
  const finderResults = document.querySelector("#canvasFinderResults");
  const finderStatus = document.querySelector("#canvasFinderStatus");
  const keymapButton = document.querySelector("#canvasKeymapButton");
  const keymapDialog = document.querySelector("#canvasKeymapDialog");
  const keymapStatus = document.querySelector("#canvasKeymapStatus");
  const keymapSaveButton = document.querySelector("#canvasKeymapSaveButton");
  const keymapResetButton = document.querySelector("#canvasKeymapResetButton");
  const keymapModifierInputs = new Map(CANVAS_MODIFIERS
    .map((name) => [name, document.querySelector(`#canvasKeymapModifier-${name}`)]));
  const keymapCommandInputs = new Map(CANVAS_KEYMAP_COMMANDS
    .map((command) => [command, document.querySelector(`#canvasKeymapCommand-${command}`)]));

  let layout = emptyCanvasLayout();
  let active = false;
  let generation = 0;
  let pickerTargetPaneId = null;
  let replacePaneId = null;
  let pickerSessions = [];
  let pickerGeneration = 0;
  let harnesses = [];
  // conversation identity -> { element, body, strip, paneId }: keyed by the
  // conversation, not the layout slot, so a move only restyles the same element.
  const paneNodes = new Map();
  // row id -> separator that changes that row's height.
  const rowNodes = new Map();
  let emptyNode = null;
  // Keyboard bindings for this account, as the node last reported them. They belong to
  // the account rather than the canvas, so a pane may hold one that no row shows yet.
  let shortcuts = [];
  let shortcutPane = null;
  // conversation identity -> the title last rendered for it, so the shortcut bar can
  // name a conversation without waiting for another metadata round trip.
  const paneTitles = new Map();
  // The account's canvas chord and command keys, as the node last reported them.
  let keymap = normalizeCanvasKeymap(DEFAULT_CANVAS_KEYMAP);
  // Pane ids, most recently reached first, so one key toggles between the last two.
  const visitOrder = [];
  let finderMatches = [];
  let finderIndex = 0;

  const text = (tag, value, className) => {
    const element = document.createElement(tag);
    element.textContent = value;
    if (className) element.className = className;
    return element;
  };
  const button = (label) => {
    const element = text("button", label);
    element.type = "button";
    return element;
  };
  const paneIdentity = (pane) => `${pane.projectId}\0${pane.sessionId}\0${canonicalSessionPath(pane.sessionPath)}`;
  // A pane the user opened on a brand-new conversation carries the draft path the
  // pane document will create the conversation under, so two of them never collide.
  const draftHarnessId = (sessionPath) => (sessionPath.startsWith("draft:") ? sessionPath.split(":")[1] : null);
  const harnessLabel = (harnessId) => harnesses.find((candidate) => candidate.id === harnessId)?.label || "conversation";
  const draftSession = (pane) => {
    const harnessId = draftHarnessId(pane.sessionPath);
    return {
      id: pane.sessionId, path: pane.sessionPath, harnessId,
      title: `New ${harnessLabel(harnessId)} conversation`,
      firstMessage: "", running: false, reviewState: "reviewed", executionNodeId: null,
    };
  };

  async function loadShortcuts() {
    try {
      shortcuts = (await api("/api/canvas/shortcuts")).shortcuts || [];
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Could not load canvas shortcuts");
    }
  }

  async function ensureHarnesses() {
    if (harnesses.length) return;
    try {
      const body = await api("/api/harnesses");
      harnesses = body.harnesses || [];
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Could not load agents");
    }
  }

  function commit(next) {
    layout = next;
    saveLayout(next);
  }

  async function sessionsFor(projectId) {
    const body = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
    return body.sessions;
  }

  function statusLine(session) {
    if (session.running) return "Running";
    if (session.reviewState === "needs_review") return "Needs review";
    return "Idle";
  }

  function paneHeader(pane, project, session, onPicker) {
    const bar = document.createElement("header");
    bar.className = "canvas-pane-header";
    if (!project || !session) {
      bar.append(text("strong", project ? project.name : "Unavailable project", "canvas-pane-title"));
      bar.append(text("span", session ? session.title || session.path : "Conversation unavailable", "canvas-pane-meta"));
      const replace = button("Replace");
      replace.setAttribute("aria-label", "Replace unavailable conversation");
      replace.addEventListener("click", () => onPicker(pane.id, pane.id));
      const remove = button("Remove");
      remove.setAttribute("aria-label", "Remove unavailable conversation");
      remove.addEventListener("click", () => removePane(pane));
      bar.append(replace, remove);
      return bar;
    }
    const title = `${project.name} · ${session.title || session.path}`;
    paneTitles.set(paneIdentity(pane), title);
    bar.append(text("strong", title, "canvas-pane-title"));
    const held = shortcutFor(pane);
    const badge = button(canvasChordLabel(keymap, held ? held.binding : ""));
    badge.className = "canvas-shortcut-badge";
    badge.dataset.testid = "canvas-pane-shortcut-button";
    badge.setAttribute("aria-label", held
      ? `Change the keyboard shortcut for ${title}, currently ${canvasChordLabel(keymap, held.binding)}`
      : `Assign a keyboard shortcut to ${title}`);
    badge.addEventListener("click", () => openShortcutDialog(pane, title));
    bar.append(badge);
    const context = `${String(session.firstMessage || "").slice(0, 90)} · ${session.harnessId === "claude" ? "Claude" : "Pi"} · ${statusLine(session)}`;
    bar.append(text("span", context, "canvas-pane-meta"));
    const action = (label, ariaLabel, run) => {
      const element = button(label);
      element.setAttribute("aria-label", ariaLabel);
      element.addEventListener("click", run);
      bar.append(element);
    };
    action("Add beside", `Add a conversation beside ${title}`, () => onPicker(pane.id, null));
    const focusLabel = layout.focusedPaneId === pane.id ? "Show all canvas panes" : `Focus on ${title}`;
    action(layout.focusedPaneId === pane.id ? "Show all" : "Focus", focusLabel, () => focusPane(pane.id));
    const moves = canvasPaneMoves(layout, pane.id);
    const moveSymbols = { left: "◀", right: "▶", up: "▲", down: "▼" };
    for (const direction of ["left", "right", "up", "down"]) {
      const move = button(moveSymbols[direction]);
      move.className = "canvas-move";
      move.disabled = !moves[direction];
      const words = direction === "up" || direction === "down" ? `one row ${direction}` : direction;
      move.setAttribute("aria-label", `Move ${title} ${words}`);
      move.title = `Move ${words}`;
      move.addEventListener("click", () => {
        commit(moveCanvasPane(layout, pane.id, direction));
        placeAll();
        render();
      });
      bar.append(move);
    }
    action("Remove", `Remove ${title} from the canvas`, () => removePane(pane));
    return bar;
  }

  function paneBody(pane, project, session) {
    const cached = paneNodes.get(paneIdentity(pane));
    // Same conversation and a live frame: keep the existing body untouched.
    if (cached && cached.body.dataset.live === "1") return cached.body;
    const url = new URL("/", location.origin);
    url.searchParams.set("canvasPane", "1");
    url.searchParams.set("projectId", pane.projectId);
    url.searchParams.set("sessionPath", session.path);
    url.searchParams.set("sessionId", pane.sessionId);
    if (session.executionNodeId) url.searchParams.set("nodeId", session.executionNodeId);
    const frame = document.createElement("iframe");
    frame.src = url.href;
    frame.title = `${project ? project.name : "Conversation"} · ${session.title || session.path}`;
    const body = document.createElement("div");
    body.className = "canvas-pane-body";
    body.dataset.live = "1";
    body.append(frame);
    return body;
  }

  function paneUnavailable(message, pane, onPicker) {
    const body = document.createElement("div");
    body.className = "canvas-unavailable";
    body.dataset.live = "0";
    body.append(text("p", message));
    const replace = button("Replace");
    replace.setAttribute("aria-label", "Replace unavailable conversation");
    replace.addEventListener("click", () => onPicker(pane.id, pane.id));
    body.append(replace);
    return body;
  }

  /** Grid lines for proportional pane widths, kept strictly increasing. */
  function boundaryLines(weights) {
    const lines = [1];
    let consumed = 0;
    for (let index = 0; index < weights.length; index += 1) {
      consumed += weights[index];
      const remaining = weights.length - index - 1;
      const lastLine = CANVAS_GRID_UNITS + 1 - remaining;
      lines.push(Math.min(lastLine, Math.max(lines[index] + 1, 1 + Math.round(consumed * CANVAS_GRID_UNITS))));
    }
    lines[lines.length - 1] = CANVAS_GRID_UNITS + 1;
    return lines;
  }

  const rowTrack = (row) => (row.height ? `${row.height}px` : `minmax(${CANVAS_MIN_ROW_HEIGHT}px, 1fr)`);
  function rowTemplate(resizedRowId = null, resizedHeight = null) {
    if (!layout.rows.length) return "minmax(0, 1fr)";
    return layout.rows.map((row) => rowTrack(row.id === resizedRowId ? { ...row, height: resizedHeight } : row)).join(" ");
  }

  function rowHeightOf(row) {
    if (row.height) return row.height;
    const node = paneNodes.get(paneIdentity(row.panes[0]));
    return node?.element.getBoundingClientRect().height || CANVAS_MIN_ROW_HEIGHT;
  }

  /** Styles only: positions every pane on the root grid. No DOM structure changes. */
  function placeAll() {
    root.style.gridTemplateColumns = `repeat(${CANVAS_GRID_UNITS}, minmax(0, 1fr))`;
    root.style.gridTemplateRows = rowTemplate();
    for (const [rowIndex, row] of layout.rows.entries()) {
      const lines = boundaryLines(row.weights);
      for (const [index, pane] of row.panes.entries()) {
        const node = paneNodes.get(paneIdentity(pane));
        if (!node) continue;
        node.element.style.gridRow = `${rowIndex + 1} / ${rowIndex + 2}`;
        node.element.style.gridColumn = `${lines[index]} / ${lines[index + 1]}`;
        node.strip.hidden = index === 0;
        if (index > 0) {
          const pair = row.weights[index - 1] + row.weights[index];
          const minimum = Math.round((CANVAS_MIN_PANE_WIDTH / pair) * 100);
          node.strip.setAttribute("aria-valuemin", String(minimum));
          node.strip.setAttribute("aria-valuemax", String(100 - minimum));
          node.strip.setAttribute("aria-valuenow", String(Math.round((row.weights[index - 1] / pair) * 100)));
        }
      }
      const separator = rowNodes.get(row.id);
      if (!separator) continue;
      separator.style.gridRow = `${rowIndex + 1} / ${rowIndex + 2}`;
      separator.style.gridColumn = "1 / -1";
      separator.setAttribute("aria-valuenow", String(Math.round(rowHeightOf(row))));
    }
  }

  // Focus is styles only: the focused pane spans the whole grid, others hide.
  function applyFocus() {
    const focused = layout.focusedPaneId;
    root.classList.toggle("canvas-focused", Boolean(focused));
    for (const node of paneNodes.values()) node.element.classList.toggle("focused", node.paneId === focused);
    root.style.gridTemplateRows = focused ? "minmax(0, 1fr)" : rowTemplate();
    for (const node of paneNodes.values()) {
      if (node.paneId === focused) node.element.style.gridArea = "1 / 1 / -1 / -1";
    }
  }

  function focusPane(paneId) {
    commit(toggleCanvasFocus(layout, paneId));
    if (layout.focusedPaneId) applyFocus();
    else { applyFocus(); placeAll(); }
    // Refresh controls in place; cached frame bodies stay attached.
    render();
  }

  function locatePane(paneId) {
    for (const [rowIndex, row] of layout.rows.entries()) {
      const index = row.panes.findIndex((pane) => pane.id === paneId);
      if (index >= 0) return { row, rowIndex, index };
    }
    return null;
  }

  function boundaryPair(weights, fraction) {
    const total = weights[0] + weights[1];
    const left = Math.min(total - CANVAS_MIN_PANE_WIDTH, Math.max(CANVAS_MIN_PANE_WIDTH, fraction * total));
    return [left, total - left];
  }

  function previewBoundary(at, pair) {
    const weights = [...at.row.weights];
    weights[at.index - 1] = pair[0];
    weights[at.index] = pair[1];
    const lines = boundaryLines(weights);
    for (const index of [at.index - 1, at.index]) {
      const node = paneNodes.get(paneIdentity(at.row.panes[index]));
      if (node) node.element.style.gridColumn = `${lines[index]} / ${lines[index + 1]}`;
    }
  }

  function wireBoundaryPointer(strip, pane) {
    let drag = null;
    strip.addEventListener("pointerdown", (event) => {
      const at = locatePane(pane.id);
      if (!at || at.index === 0) return;
      const own = paneNodes.get(paneIdentity(pane))?.element.getBoundingClientRect();
      const left = paneNodes.get(paneIdentity(at.row.panes[at.index - 1]))?.element.getBoundingClientRect();
      if (!own || !left) return;
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startLeft: own.left - left.left,
        pairWidth: own.right - left.left,
        weights: [at.row.weights[at.index - 1], at.row.weights[at.index]],
      };
      strip.setPointerCapture(event.pointerId);
      root.classList.add("canvas-resizing");
    });
    const pairAt = (event, from) => boundaryPair(from.weights,
      (from.startLeft + event.clientX - from.startX) / Math.max(1, from.pairWidth));
    strip.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const at = locatePane(pane.id);
      if (at?.index > 0) previewBoundary(at, pairAt(event, drag));
    });
    const finish = (event, complete) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const ending = drag;
      drag = null;
      strip.releasePointerCapture(event.pointerId);
      root.classList.remove("canvas-resizing");
      const at = locatePane(pane.id);
      if (!complete || !at || at.index === 0) { placeAll(); return; }
      const pair = pairAt(event, ending);
      commit(setCanvasRowBoundary(layout, at.row.id, at.index - 1, pair[0], pair[1]));
      placeAll();
    };
    strip.addEventListener("pointerup", (event) => finish(event, true));
    strip.addEventListener("pointercancel", (event) => finish(event, false));
  }

  function boundaryStrip(pane) {
    const strip = text("div", "", "canvas-resize");
    strip.tabIndex = 0;
    strip.dataset.testid = "canvas-pane-width-handle";
    strip.setAttribute("role", "separator");
    strip.setAttribute("aria-orientation", "vertical");
    strip.setAttribute("aria-label", "Resize adjacent conversation widths");
    wireBoundaryPointer(strip, pane);
    strip.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const at = locatePane(pane.id);
      if (!at || at.index === 0) return;
      const left = at.row.weights[at.index - 1];
      const right = at.row.weights[at.index];
      const delta = event.key === "ArrowRight" ? CANVAS_WIDTH_STEP : -CANVAS_WIDTH_STEP;
      const pair = boundaryPair([left, right], (left + delta) / (left + right));
      commit(setCanvasRowBoundary(layout, at.row.id, at.index - 1, pair[0], pair[1]));
      placeAll();
    });
    return strip;
  }

  function wireRowPointer(strip, rowId) {
    let drag = null;
    strip.addEventListener("pointerdown", (event) => {
      const row = layout.rows.find((candidate) => candidate.id === rowId);
      if (!row) return;
      drag = { pointerId: event.pointerId, startY: event.clientY, height: rowHeightOf(row) };
      strip.setPointerCapture(event.pointerId);
      root.classList.add("canvas-resizing");
    });
    strip.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const height = Math.min(CANVAS_MAX_ROW_HEIGHT, Math.max(CANVAS_MIN_ROW_HEIGHT, drag.height + event.clientY - drag.startY));
      root.style.gridTemplateRows = rowTemplate(rowId, Math.round(height));
    });
    const finish = (event, complete) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const ending = drag;
      drag = null;
      strip.releasePointerCapture(event.pointerId);
      root.classList.remove("canvas-resizing");
      if (complete) commit(setCanvasRowHeight(layout, rowId, ending.height + event.clientY - ending.startY));
      placeAll();
    };
    strip.addEventListener("pointerup", (event) => finish(event, true));
    strip.addEventListener("pointercancel", (event) => finish(event, false));
  }

  function rowSeparator(rowId) {
    const strip = text("div", "", "canvas-row-resize");
    strip.tabIndex = 0;
    strip.dataset.testid = "canvas-row-height-handle";
    strip.setAttribute("role", "separator");
    strip.setAttribute("aria-orientation", "horizontal");
    strip.setAttribute("aria-valuemin", String(CANVAS_MIN_ROW_HEIGHT));
    strip.setAttribute("aria-valuemax", String(CANVAS_MAX_ROW_HEIGHT));
    strip.setAttribute("aria-label", "Resize this canvas row's height");
    strip.title = "Drag to resize this row · double-click to fit";
    wireRowPointer(strip, rowId);
    strip.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const row = layout.rows.find((candidate) => candidate.id === rowId);
      if (!row) return;
      const delta = event.key === "ArrowDown" ? CANVAS_ROW_HEIGHT_STEP : -CANVAS_ROW_HEIGHT_STEP;
      commit(setCanvasRowHeight(layout, rowId, rowHeightOf(row) + delta));
      placeAll();
    });
    strip.addEventListener("dblclick", () => {
      commit(clearCanvasRowHeight(layout, rowId));
      placeAll();
    });
    return strip;
  }

  function syncRowSeparators() {
    const liveRows = new Set(layout.rows.map((row) => row.id));
    for (const [rowId, element] of [...rowNodes.entries()]) {
      if (liveRows.has(rowId)) continue;
      element.remove();
      rowNodes.delete(rowId);
    }
    for (const row of layout.rows) {
      if (rowNodes.has(row.id)) continue;
      const separator = rowSeparator(row.id);
      rowNodes.set(row.id, separator);
      root.append(separator);
    }
  }

  const shortcutIdentity = (target) => `${target.projectId}\0${target.engine}\0${target.sessionId}`;
  const paneShortcutTarget = (pane) => ({ projectId: pane.projectId, engine: canvasPaneEngine(pane), sessionId: pane.sessionId });
  const shortcutFor = (pane) => shortcuts.find((candidate) => shortcutIdentity(candidate) === shortcutIdentity(paneShortcutTarget(pane))) || null;
  const paneTitle = (pane) => paneTitles.get(paneIdentity(pane)) || pane.sessionPath;

  async function shortcutRequest(path, options) {
    const body = await api(path, options);
    shortcuts = body.shortcuts || [];
    publishBindings();
  }

  /** Panes are iframes and swallow the keystroke, so each one learns the chord and the
   * keys the canvas claims, and forwards only those; everything else stays with the
   * conversation. */
  function publishBindings() {
    const commands = CANVAS_KEYMAP_COMMANDS.map((command) => keymap[command]).filter(Boolean);
    const bindings = [...shortcuts.map((shortcut) => shortcut.binding), ...commands];
    for (const node of paneNodes.values()) {
      const frame = node.body.firstElementChild;
      frame?.contentWindow?.postMessage({ type: "canvasShortcutBindings", bindings, modifiers: keymap.modifiers }, location.origin);
    }
  }

  /** Most recently reached panes first, so the jump key toggles between the last two. */
  function noteVisit(paneId) {
    const index = visitOrder.indexOf(paneId);
    if (index >= 0) visitOrder.splice(index, 1);
    visitOrder.unshift(paneId);
    visitOrder.length = Math.min(visitOrder.length, 20);
  }

  const livePaneIds = () => new Set(listCanvasPanes(layout).map((pane) => pane.id));

  /** The pane the user last worked in; before they have, the layout's own order decides. */
  function currentPaneId() {
    const live = livePaneIds();
    return visitOrder.find((id) => live.has(id)) || layout.focusedPaneId || listCanvasPanes(layout)[0]?.id || null;
  }

  /** The pane before the current one, so one key jumps back and forth between two. */
  function previousPaneId() {
    const live = livePaneIds();
    const visited = visitOrder.filter((id) => live.has(id));
    if (visited[1]) return visited[1];
    return listCanvasPanes(layout).find((pane) => pane.id !== visited[0])?.id || null;
  }

  function revealPane(paneId) {
    const pane = listCanvasPanes(layout).find((candidate) => candidate.id === paneId);
    const node = pane ? paneNodes.get(paneIdentity(pane)) : null;
    if (!node) return false;
    noteVisit(paneId);
    // Focus mode hides every other pane, so a shortcut into one moves focus instead of
    // scrolling to something the canvas is not showing.
    if (layout.focusedPaneId && layout.focusedPaneId !== paneId) {
      commit(toggleCanvasFocus(layout, paneId));
      applyFocus();
      render();
    }
    node.element.scrollIntoView({ block: "nearest", behavior: "smooth" });
    node.element.classList.add("canvas-revealed");
    setTimeout(() => node.element.classList.remove("canvas-revealed"), 1200);
    node.body.firstElementChild?.contentWindow?.postMessage({ type: "canvasFocusComposer" }, location.origin);
    return true;
  }

  /** Brings the conversation the user last worked in forward, alone on the canvas. */
  function focusCurrentPane() {
    const paneId = currentPaneId();
    if (!paneId) return false;
    if (layout.focusedPaneId !== paneId) {
      commit(toggleCanvasFocus(layout, paneId));
      applyFocus();
      render();
    }
    return revealPane(paneId);
  }

  /** A conversation's own key is checked first: adding a command must never silently
   * take a binding the user already had. */
  function handleShortcutCombination(combination) {
    if (!active || !canvasChordMatches(keymap, combination)) return false;
    const key = canvasKeyFromCode(combination.code);
    if (!key) return false;
    const shortcut = shortcuts.find((candidate) => candidate.binding === key);
    if (shortcut) {
      const pane = listCanvasPanes(layout).find((candidate) => shortcutIdentity(paneShortcutTarget(candidate)) === shortcutIdentity(shortcut));
      return pane ? revealPane(pane.id) : false;
    }
    if (key === keymap.paneSearch) { openFinder(); return true; }
    if (key === keymap.recentPane) return revealPane(previousPaneId());
    if (key === keymap.focusPane) return focusCurrentPane();
    return false;
  }

  function renderShortcutBar() {
    shortcutBar.replaceChildren();
    const bound = listCanvasPanes(layout)
      .map((pane) => ({ pane, shortcut: shortcutFor(pane) }))
      .filter((entry) => entry.shortcut);
    shortcutBar.hidden = !bound.length;
    for (const entry of bound) {
      const chip = button("");
      chip.className = "canvas-shortcut-chip";
      chip.setAttribute("aria-label", `Go to ${paneTitle(entry.pane)}`);
      chip.append(text("kbd", canvasChordLabel(keymap, entry.shortcut.binding)));
      chip.append(text("span", paneTitle(entry.pane)));
      chip.addEventListener("click", () => revealPane(entry.pane.id));
      shortcutBar.append(chip);
    }
  }

  function openShortcutDialog(pane, title) {
    shortcutPane = pane;
    shortcutSubject.textContent = title;
    const current = shortcutFor(pane);
    shortcutKeyInput.value = current ? current.binding : "";
    shortcutChordLabel.textContent = `Press ${canvasChordLabel(keymap)} with this key`;
    shortcutStatus.textContent = "";
    shortcutRemoveButton.hidden = !current;
    shortcutDialog.showModal();
  }

  async function saveShortcut() {
    const binding = String(shortcutKeyInput.value || "").trim().toUpperCase();
    if (!/^[0-9A-Z]$/.test(binding)) {
      shortcutStatus.textContent = "Pick one digit or letter.";
      return;
    }
    if (CANVAS_KEYMAP_COMMANDS.some((command) => keymap[command] === binding)) {
      shortcutStatus.textContent = "That key already runs a canvas command.";
      return;
    }
    try {
      await shortcutRequest(`/api/canvas/shortcuts/${encodeURIComponent(binding)}`, {
        method: "PUT",
        body: JSON.stringify(paneShortcutTarget(shortcutPane)),
      });
      shortcutDialog.close();
      render();
    } catch (error) {
      shortcutStatus.textContent = error instanceof Error ? error.message : "Could not save that shortcut";
    }
  }

  async function removeShortcut() {
    try {
      await releaseShortcuts([shortcutPane]);
      shortcutDialog.close();
      render();
    } catch (error) {
      shortcutStatus.textContent = error instanceof Error ? error.message : "Could not remove that shortcut";
    }
  }

  /** A conversation leaving the canvas gives its key back to the account. The node
   * releases by conversation, never by the key this page last saw: another node may
   * have moved that key to a different conversation since. */
  async function releaseShortcuts(panes) {
    for (const pane of panes) {
      await shortcutRequest("/api/canvas/shortcuts/release", {
        method: "POST",
        body: JSON.stringify(paneShortcutTarget(pane)),
      });
    }
  }

  function reportShortcutFailure(error) {
    showMessage(error instanceof Error ? error.message : "Could not release that shortcut");
  }

  /**
   * Fuzzy finder over the conversations already on the canvas, so a wide canvas stays
   * navigable by title instead of by hunting for the right pane.
   */
  function renderFinder() {
    const query = finderInput.value.trim();
    finderMatches = listCanvasPanes(layout)
      .map((pane) => ({ pane, title: paneTitle(pane) }))
      .map((entry) => ({ ...entry, score: fuzzyMatchScore(entry.title, query) }))
      .filter((entry) => entry.score !== null)
      .sort((left, right) => right.score - left.score);
    finderIndex = Math.min(finderIndex, Math.max(0, finderMatches.length - 1));
    finderResults.replaceChildren();
    for (const [index, entry] of finderMatches.entries()) {
      const option = button("");
      option.className = `canvas-finder-option${index === finderIndex ? " active" : ""}`;
      option.dataset.testid = "canvas-finder-option";
      option.setAttribute("aria-label", `Go to ${entry.title}`);
      option.append(text("strong", entry.title));
      const held = shortcutFor(entry.pane);
      if (held) option.append(text("kbd", canvasChordLabel(keymap, held.binding)));
      option.addEventListener("click", () => chooseFinderMatch(index));
      finderResults.append(option);
    }
    finderStatus.textContent = finderMatches.length ? "" : "No conversation on the canvas matches that.";
  }

  function chooseFinderMatch(index) {
    const entry = finderMatches[index];
    if (!entry) return;
    finderDialog.close();
    revealPane(entry.pane.id);
  }

  function openFinder() {
    if (!listCanvasPanes(layout).length) {
      showMessage("The canvas has no conversations to search yet.");
      return;
    }
    finderInput.value = "";
    finderIndex = 0;
    renderFinder();
    finderDialog.showModal();
    finderInput.focus();
  }

  function openKeymapDialog() {
    for (const [name, input] of keymapModifierInputs) input.checked = keymap.modifiers.includes(name);
    for (const [command, input] of keymapCommandInputs) input.value = keymap[command] || "";
    keymapStatus.textContent = "";
    keymapDialog.showModal();
  }

  /** Reads the dialog into one keymap, refusing a chord or a key that cannot work. */
  function keymapFromDialog() {
    const modifiers = CANVAS_MODIFIERS.filter((name) => keymapModifierInputs.get(name).checked);
    if (!canvasChordIsUsable(modifiers)) throw new Error("Pick Command, Control, or Option. Shift on its own would swallow ordinary typing.");
    const draft = { modifiers };
    const taken = new Set();
    for (const [command, input] of keymapCommandInputs) {
      const typed = String(input.value || "").trim();
      const key = typed ? canonicalCanvasKey(typed) : null;
      if (typed && !key) throw new Error("Each command key is one digit or letter.");
      if (key && taken.has(key)) throw new Error("Two commands cannot share one key.");
      if (key && shortcuts.some((candidate) => candidate.binding === key)) {
        throw new Error(`${key} already belongs to a conversation on the canvas.`);
      }
      if (key) taken.add(key);
      draft[command] = key;
    }
    return normalizeCanvasKeymap(draft);
  }

  async function saveKeymapFromDialog() {
    let next;
    try {
      next = keymapFromDialog();
    } catch (error) {
      keymapStatus.textContent = error.message;
      return;
    }
    try {
      await saveKeymap(next);
    } catch (error) {
      keymapStatus.textContent = error instanceof Error ? error.message : "Could not save these shortcuts";
      return;
    }
    keymap = next;
    keymapDialog.close();
    render();
  }

  /**
   * Puts one already-open conversation on the canvas, from the conversation list or the
   * chat menu. A full row spills into a new one rather than refusing.
   */
  function addSessionPane(projectId, session) {
    const pane = {
      kind: "pane", id: crypto.randomUUID(), projectId,
      sessionPath: session.path, sessionId: session.id,
      executionNodeId: session.executionNodeId ?? null,
    };
    const panes = listCanvasPanes(layout);
    const target = layout.focusedPaneId || panes[panes.length - 1]?.id || null;
    let next;
    try {
      next = addCanvasPane(layout, pane, target, "row");
    } catch (error) {
      if (!/at most eight/.test(error.message)) throw error;
      next = addCanvasPane(layout, pane, target, "column");
    }
    commit({ ...next, focusedPaneId: null });
    if (active) render();
  }

  function removePane(pane) {
    commit(removeCanvasPane(layout, pane.id));
    render();
    // Always ask, never check first: this page's copy of the bindings may predate
    // another node assigning one to this conversation. Releasing an unbound
    // conversation is a no-op on the node.
    void releaseShortcuts([pane]).then(render, reportShortcutFailure);
  }

  async function loadCanvasMetadata(panes) {
    const metadata = new Map();
    await Promise.all([...new Set(panes.map((pane) => pane.projectId))].map(async (projectId) => {
      const project = getProjects().find((candidate) => candidate.id === projectId) || null;
      try {
        metadata.set(projectId, { project, sessions: await sessionsFor(projectId) });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not load conversations";
        showMessage(message);
        metadata.set(projectId, { project, sessions: [], error: message });
      }
    }));
    return metadata;
  }

  function syncPaneElement(pane, entry, onPicker) {
    const listed = (entry.sessions || []).find((candidate) => candidate.id === pane.sessionId
      || canonicalSessionPath(candidate.path) === canonicalSessionPath(pane.sessionPath)) || null;
    // The draft stays renderable before its first transcript line reaches the list.
    const session = listed || (draftHarnessId(pane.sessionPath) ? draftSession(pane) : null);
    const identity = paneIdentity(pane);
    const cached = paneNodes.get(identity);
    // Once a frame is live, metadata outages or eventual-consistency gaps must
    // never destroy its browsing context. The unavailable header still permits
    // explicit replace/remove when the session is no longer listed.
    const body = cached?.body.dataset.live === "1" ? cached.body
      : session ? paneBody(pane, entry.project, session)
        : paneUnavailable(entry.error || "This conversation is no longer listed on this node.", pane, onPicker);
    const header = paneHeader(pane, entry.project || null, session, onPicker);
    let element = cached?.element || null;
    let strip = cached?.strip || null;
    if (!element) {
      element = document.createElement("section");
      element.className = "canvas-pane";
      strip = boundaryStrip(pane);
      element.append(strip);
      root.append(element);
    }
    element.dataset.paneId = pane.id;
    // Replace only the header. The body and iframe stay attached.
    const headerSlot = element.children.length > 1 ? element.children[1] : null;
    if (headerSlot) headerSlot.replaceWith(header);
    else element.append(header);
    if (cached && cached.body !== body && cached.body.parentElement === element) cached.body.replaceWith(body);
    else if (!body.isConnected || body.parentElement !== element) element.append(body);
    paneNodes.set(identity, { element, body, strip, paneId: pane.id });
  }

  function renderEmptyCanvas() {
    paneNodes.clear();
    rowNodes.clear();
    renderShortcutBar();
    root.replaceChildren();
    root.classList.remove("canvas-focused");
    root.style.gridTemplateColumns = "";
    root.style.gridTemplateRows = "";
    const empty = text("div", "", "canvas-empty");
    empty.append(text("h2", "The canvas is empty"));
    empty.append(text("p", "Add an existing conversation to begin."));
    const add = button("Add conversation");
    add.className = "primary";
    add.addEventListener("click", () => openPicker(null, null));
    empty.append(add);
    emptyNode = empty;
    root.append(empty);
  }

  async function render() {
    if (!active) return;
    const current = ++generation;
    const panes = listCanvasPanes(layout);
    const liveIdentities = new Set(panes.map((pane) => paneIdentity(pane)));
    for (const [identity, node] of [...paneNodes.entries()]) {
      if (!liveIdentities.has(identity)) {
        node.element.remove();
        paneNodes.delete(identity);
      }
    }
    if (!panes.length) { renderEmptyCanvas(); return; }
    // The placeholder is a plain child of the grid: drop it the moment panes exist.
    if (emptyNode) { emptyNode.remove(); emptyNode = null; }
    const metadata = await loadCanvasMetadata(panes);
    if (!active || current !== generation) return;
    const onPicker = (targetPaneId, replaceId) => openPicker(targetPaneId, replaceId);
    for (const pane of panes) syncPaneElement(pane, metadata.get(pane.projectId) || {}, onPicker);
    syncRowSeparators();
    placeAll();
    applyFocus();
    renderShortcutBar();
    publishBindings();
  }

  function sessionTaken(session, projectId) {
    return listCanvasPanes(layout).some((pane) => {
      if (pane.id === replacePaneId) return false;
      return pane.projectId === projectId && (pane.sessionId === session.id
        || canonicalSessionPath(pane.sessionPath) === canonicalSessionPath(session.path));
    });
  }

  function pickerOption(title, subtitle, testId, onChoose) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "canvas-session-option";
    if (testId) option.dataset.testid = testId;
    option.append(text("strong", title));
    if (subtitle) option.append(text("span", subtitle));
    option.addEventListener("click", onChoose);
    optionsList.append(option);
  }

  function renderPickerOptions() {
    const query = searchInput.value.trim().toLowerCase();
    optionsList.replaceChildren();
    const projectId = projectSelect.value;
    if (projectId) {
      for (const harness of harnesses) {
        const title = `Start a new ${harness.label} conversation`;
        if (!title.toLowerCase().includes(query)) continue;
        pickerOption(title, "Opens an empty conversation in the new pane", `canvas-start-conversation-${harness.id}`, () => chooseDraft(harness));
      }
    }
    const sessions = pickerSessions.filter((session) => !sessionTaken(session, projectId));
    const matches = sessions.filter((session) => `${session.title || ""}\n${session.firstMessage || ""}\n${session.path || ""}`.toLowerCase().includes(query));
    for (const session of matches) {
      pickerOption(session.title || session.path, session.firstMessage || "", null, () => chooseSession(session));
    }
    if (!optionsList.childElementCount) optionsList.append(text("p", matches.length || sessions.length ? "No conversation matches that search." : "Every conversation in this project is already on the canvas.", "canvas-picker-empty"));
  }

  async function loadPickerSessions() {
    // A slow response for one project must never land on another project's picker.
    const requestedProjectId = projectSelect.value;
    const requestGeneration = ++pickerGeneration;
    pickerStatus.textContent = "Loading conversations…";
    try {
      const sessions = await sessionsFor(requestedProjectId);
      if (requestedProjectId !== projectSelect.value || requestGeneration !== pickerGeneration) return;
      pickerSessions = sessions;
      pickerStatus.textContent = "";
      renderPickerOptions();
    } catch (error) {
      if (requestedProjectId !== projectSelect.value || requestGeneration !== pickerGeneration) return;
      pickerSessions = [];
      optionsList.replaceChildren();
      pickerStatus.textContent = error instanceof Error ? error.message : "Could not load conversations";
    }
  }

  function chooseSession(session) {
    addChosenPane({
      kind: "pane", id: crypto.randomUUID(),
      projectId: projectSelect.value, sessionPath: session.path,
      sessionId: session.id, executionNodeId: session.executionNodeId ?? null,
    });
  }

  // The canvas mints the conversation id here; the pane document creates the
  // conversation under it, so the pane resolves to the real session once it lists.
  function chooseDraft(harness) {
    const sessionId = crypto.randomUUID();
    addChosenPane({
      kind: "pane", id: crypto.randomUUID(),
      projectId: projectSelect.value, sessionPath: `draft:${harness.id}:${sessionId}`,
      sessionId, executionNodeId: null,
    });
  }

  function addChosenPane(pane) {
    try {
      const axis = positionSelect.value === "below" ? "column" : "row";
      if (replacePaneId) {
        const replaced = listCanvasPanes(layout).find((candidate) => candidate.id === replacePaneId);
        commit(replaceCanvasPane(layout, replacePaneId, pane));
        if (replaced) void releaseShortcuts([replaced]).then(render, reportShortcutFailure);
      } else {
        const panes = listCanvasPanes(layout);
        const target = pickerTargetPaneId || layout.focusedPaneId || panes[panes.length - 1]?.id;
        // Adding while a pane is focused would hide the new pane; show the whole canvas.
        commit({ ...addCanvasPane(layout, pane, target, axis), focusedPaneId: null });
      }
      dialog.close();
      render();
    } catch (error) {
      pickerStatus.textContent = error instanceof Error ? error.message : "Could not add that conversation";
    }
  }

  function openPicker(targetPaneId = null, replaceId = null) {
    pickerTargetPaneId = targetPaneId;
    replacePaneId = replaceId;
    searchInput.value = "";
    pickerStatus.textContent = "";
    const projects = getProjects();
    const previous = projectSelect.value;
    projectSelect.replaceChildren(...projects.map((project) => new Option(project.name, project.id)));
    if (projects.some((project) => project.id === previous)) projectSelect.value = previous;
    if (!projects.length) {
      pickerSessions = [];
      optionsList.replaceChildren();
      pickerStatus.textContent = "No projects are available on this node.";
    } else {
      void ensureHarnesses().then(renderPickerOptions);
      void loadPickerSessions();
    }
    dialog.showModal();
  }

  projectSelect.addEventListener("change", () => void loadPickerSessions());
  searchInput.addEventListener("input", renderPickerOptions);
  organizeButton.addEventListener("click", () => {
    commit(organizeCanvasLayout(layout));
    placeAll();
    render();
  });
  shortcutSaveButton.addEventListener("click", () => void saveShortcut());
  shortcutRemoveButton.addEventListener("click", () => void removeShortcut());
  finderButton.addEventListener("click", openFinder);
  finderInput.addEventListener("input", () => { finderIndex = 0; renderFinder(); });
  finderInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      finderIndex = Math.min(finderMatches.length - 1, Math.max(0, finderIndex + step));
      renderFinder();
      return;
    }
    if (event.key !== "Enter") return;
    // The dialog's form would submit and close before the pane is revealed.
    event.preventDefault();
    chooseFinderMatch(finderIndex);
  });
  keymapButton.addEventListener("click", openKeymapDialog);
  keymapSaveButton.addEventListener("click", () => void saveKeymapFromDialog());
  keymapResetButton.addEventListener("click", () => {
    for (const [name, input] of keymapModifierInputs) input.checked = DEFAULT_CANVAS_KEYMAP.modifiers.includes(name);
    for (const [command, input] of keymapCommandInputs) input.value = DEFAULT_CANVAS_KEYMAP[command];
    keymapStatus.textContent = "";
  });
  window.addEventListener("keydown", (event) => {
    if (handleShortcutCombination(event)) event.preventDefault();
  });
  // Same origin is not enough: any window on this origin could post these. Only the
  // frames this canvas created may press a shortcut or ask for the binding table.
  const paneIdForSource = (source) => [...paneNodes.values()]
    .find((node) => node.body.firstElementChild?.contentWindow === source)?.paneId ?? null;
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    const paneId = paneIdForSource(event.source);
    if (paneId === null) return;
    if (event.data?.type === "canvasShortcut") handleShortcutCombination(event.data);
    // A pane that just finished loading has no bindings yet.
    if (event.data?.type === "canvasPaneReady") publishBindings();
    // Knowing which pane the user last touched is what makes "the current one" real.
    if (event.data?.type === "canvasPaneActive") noteVisit(paneId);
  });

  return {
    setLayout(next) {
      layout = normalizeCanvasLayout(next);
      paneNodes.clear();
      rowNodes.clear();
      emptyNode = null;
      root.replaceChildren();
      if (active) render();
    },
    activate() {
      active = true;
      void ensureHarnesses();
      return loadShortcuts().then(render);
    },
    deactivate() {
      // Frames stay alive (hidden with the panel) so returning to the canvas
      // restores every pane exactly as it was left.
      active = false;
      generation++;
    },
    reloadShortcuts() {
      return loadShortcuts().then(render);
    },
    setKeymap(next) {
      keymap = normalizeCanvasKeymap(next);
      if (active) render();
    },
    openKeymapDialog,
    openFinder,
    addSessionPane,
    openPicker,
  };
}
