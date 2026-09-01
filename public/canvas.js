// Canvas controller: renders a persisted row-based layout of panes, each embedding
// the normal chat surface pointed at one exact conversation. A pane never clones or
// copies a conversation; it reopens an existing session, or - only when the user
// picks it in the dialog - opens one brand-new conversation the pane document
// creates on its own node.
//
// Panes are direct children of the canvas root, placed on a fine-grained CSS grid
// through inline grid-area styles. Adding, removing, moving, resizing, or focusing
// a pane only changes styles: pane elements are never reparented, so no iframe
// ever reloads and no draft or scroll position is lost. Only a conversation
// identity change (replace) or a pane removal destroys a frame.

import {
  addCanvasPane, canvasPaneEngine, canvasPaneMoves, canonicalSessionPath, CANVAS_MAX_ROW_HEIGHT,
  CANVAS_MIN_PANE_WIDTH, CANVAS_MIN_ROW_HEIGHT, clampCanvasPaneWidth, clampCanvasRowHeight,
  emptyCanvasLayout, listCanvasPanes, moveCanvasPane, normalizeCanvasLayout, organizeCanvasLayout,
  removeCanvasPane, replaceCanvasPane, setCanvasPaneWidth, setCanvasRowHeight, toggleCanvasFocus,
} from "./canvas-layout.js";

// The canvas grid has this many fractional columns; pane widths quantize to them.
const CANVAS_GRID_UNITS = 1000;
// One keyboard press of a resize separator.
const CANVAS_WIDTH_STEP = 0.05;
const CANVAS_ROW_HEIGHT_STEP = 40;

export function createConversationCanvas({ api, getProjects, saveLayout, showMessage }) {
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
  // row id -> the separator that drags that row's height.
  const rowNodes = new Map();
  let emptyNode = null;
  // Keyboard bindings for this account, as the node last reported them. They belong to
  // the account rather than the canvas, so a pane may hold one that no row shows yet.
  let shortcuts = [];
  let shortcutPane = null;
  // conversation identity -> the title last rendered for it, so the shortcut bar can
  // name a conversation without waiting for another metadata round trip.
  const paneTitles = new Map();

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
    const badge = button(held ? `⌘⇧${held.binding}` : "⌘⇧");
    badge.className = "canvas-shortcut-badge";
    badge.dataset.testid = "canvas-pane-shortcut-button";
    badge.setAttribute("aria-label", held
      ? `Change the keyboard shortcut for ${title}, currently Command Shift ${held.binding}`
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

  /** Column span (1-based grid lines) for each pane, packed left to right.
   * Widths are fractions of the row, so the spans stop wherever they stop: the
   * rest of the row simply stays empty. */
  function paneColumns(weights) {
    const spans = [];
    let line = 1;
    for (const weight of weights) {
      const start = Math.min(CANVAS_GRID_UNITS, Math.max(1, line));
      const end = Math.min(CANVAS_GRID_UNITS + 1, Math.max(start + 1, start + Math.round(weight * CANVAS_GRID_UNITS)));
      spans.push([start, end]);
      line = end;
    }
    return spans;
  }

  /** A row the user never dragged shares the canvas height; a dragged one is pinned. */
  const rowTrack = (row) => (row.height ? `${row.height}px` : `minmax(${CANVAS_MIN_ROW_HEIGHT}px, 1fr)`);

  function rowTemplate(pinnedRowId = null, pinnedHeight = null) {
    if (!layout.rows.length) return "minmax(0, 1fr)";
    return layout.rows
      .map((row) => rowTrack(row.id === pinnedRowId ? { ...row, height: pinnedHeight } : row))
      .join(" ");
  }

  /** An unpinned row's height is whatever it currently measures on screen. */
  function rowHeightOf(row) {
    if (row.height) return row.height;
    const node = paneNodes.get(paneIdentity(row.panes[0]));
    const measured = node ? node.element.getBoundingClientRect().height : 0;
    return measured || CANVAS_MIN_ROW_HEIGHT;
  }

  /** Styles only: positions every pane on the root grid. No DOM structure changes. */
  function placeAll() {
    root.style.gridTemplateColumns = `repeat(${CANVAS_GRID_UNITS}, minmax(0, 1fr))`;
    root.style.gridTemplateRows = rowTemplate();
    for (const [rowIndex, row] of layout.rows.entries()) {
      const spans = paneColumns(row.weights);
      for (const [index, pane] of row.panes.entries()) {
        const node = paneNodes.get(paneIdentity(pane));
        if (!node) continue;
        node.element.style.gridRow = `${rowIndex + 1} / ${rowIndex + 2}`;
        node.element.style.gridColumn = `${spans[index][0]} / ${spans[index][1]}`;
        node.strip.setAttribute("aria-valuenow", String(Math.round(row.weights[index] * 100)));
        // The widest this pane could be drawn: its neighbours keep the rest of the row.
        node.strip.setAttribute("aria-valuemax", String(Math.round(clampCanvasPaneWidth(row, index, 1) * 100)));
      }
      const separator = rowNodes.get(row.id);
      if (!separator) continue;
      separator.style.gridRow = `${rowIndex + 1} / ${rowIndex + 2}`;
      separator.style.gridColumn = "1 / -1";
      separator.setAttribute("aria-valuenow", String(rowHeightOf(row)));
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
      const index = row.panes.findIndex((candidate) => candidate.id === paneId);
      if (index >= 0) return { row, rowIndex, index };
    }
    return null;
  }

  /** Live width preview for one row: restyles the row's panes, commits nothing. */
  function restyleRow(row, weights) {
    const spans = paneColumns(weights);
    for (const [index, pane] of row.panes.entries()) {
      const node = paneNodes.get(paneIdentity(pane));
      if (node) node.element.style.gridColumn = `${spans[index][0]} / ${spans[index][1]}`;
    }
  }

  function wireWidthPointer(strip, pane) {
    let drag = null;
    strip.addEventListener("pointerdown", (event) => {
      const at = locatePane(pane.id);
      const node = paneNodes.get(paneIdentity(pane));
      if (!at || !node) return;
      const width = at.row.weights[at.index];
      // The row's pixel width, derived from this pane, so no padding is guessed.
      const rowWidth = node.element.getBoundingClientRect().width / Math.max(width, CANVAS_MIN_PANE_WIDTH);
      drag = { pointerId: event.pointerId, startX: event.clientX, width, rowWidth: Math.max(1, rowWidth) };
      strip.setPointerCapture(event.pointerId);
    });
    const draggedWidth = (at, event, from) => clampCanvasPaneWidth(at.row, at.index,
      from.width + (event.clientX - from.startX) / from.rowWidth);
    strip.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const at = locatePane(pane.id);
      if (!at) return;
      const width = draggedWidth(at, event, drag);
      restyleRow(at.row, at.row.weights.map((weight, index) => index === at.index ? width : weight));
      strip.setAttribute("aria-valuenow", String(Math.round(width * 100)));
    });
    const finish = (event, complete) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const ending = drag;
      drag = null;
      strip.releasePointerCapture(event.pointerId);
      const at = locatePane(pane.id);
      if (!complete || !at) { placeAll(); return; }
      commit(setCanvasPaneWidth(layout, at.row.id, at.index, draggedWidth(at, event, ending)));
      placeAll();
    };
    strip.addEventListener("pointerup", (event) => finish(event, true));
    strip.addEventListener("pointercancel", (event) => finish(event, false));
  }

  function wireWidthKeyboard(strip, pane) {
    strip.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const at = locatePane(pane.id);
      if (!at) return;
      const step = event.key === "ArrowRight" ? CANVAS_WIDTH_STEP : -CANVAS_WIDTH_STEP;
      commit(setCanvasPaneWidth(layout, at.row.id, at.index, at.row.weights[at.index] + step));
      placeAll();
    });
  }

  /** The strip on a pane's right edge sets that pane's own width and nothing else. */
  function widthStrip(pane) {
    const strip = text("div", "", "canvas-resize");
    strip.tabIndex = 0;
    strip.setAttribute("role", "separator");
    strip.setAttribute("aria-orientation", "vertical");
    strip.setAttribute("aria-valuemin", "8");
    strip.setAttribute("aria-label", "Resize this conversation's width");
    wireWidthPointer(strip, pane);
    wireWidthKeyboard(strip, pane);
    return strip;
  }

  function wireRowPointer(strip, rowId) {
    let drag = null;
    strip.addEventListener("pointerdown", (event) => {
      const row = layout.rows.find((candidate) => candidate.id === rowId);
      if (!row) return;
      drag = { pointerId: event.pointerId, startY: event.clientY, height: rowHeightOf(row) };
      strip.setPointerCapture(event.pointerId);
    });
    strip.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      root.style.gridTemplateRows = rowTemplate(rowId, clampCanvasRowHeight(drag.height + event.clientY - drag.startY));
    });
    const finish = (event, complete) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const ending = drag;
      drag = null;
      strip.releasePointerCapture(event.pointerId);
      if (complete) commit(setCanvasRowHeight(layout, rowId, ending.height + event.clientY - ending.startY));
      placeAll();
    };
    strip.addEventListener("pointerup", (event) => finish(event, true));
    strip.addEventListener("pointercancel", (event) => finish(event, false));
  }

  function wireRowKeyboard(strip, rowId) {
    strip.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const row = layout.rows.find((candidate) => candidate.id === rowId);
      if (!row) return;
      const step = event.key === "ArrowDown" ? CANVAS_ROW_HEIGHT_STEP : -CANVAS_ROW_HEIGHT_STEP;
      commit(setCanvasRowHeight(layout, rowId, rowHeightOf(row) + step));
      placeAll();
    });
  }

  /** The strip along a row's bottom edge pins that row's height, so the canvas scrolls. */
  function rowSeparator(rowId) {
    const strip = text("div", "", "canvas-row-resize");
    strip.tabIndex = 0;
    strip.setAttribute("role", "separator");
    strip.setAttribute("aria-orientation", "horizontal");
    // The value it announces is a pixel height, so its bounds are pixels too.
    strip.setAttribute("aria-valuemin", String(CANVAS_MIN_ROW_HEIGHT));
    strip.setAttribute("aria-valuemax", String(CANVAS_MAX_ROW_HEIGHT));
    strip.setAttribute("aria-label", "Resize this canvas row's height");
    wireRowPointer(strip, rowId);
    wireRowKeyboard(strip, rowId);
    return strip;
  }

  function syncRowSeparators() {
    const liveRowIds = new Set(layout.rows.map((row) => row.id));
    for (const [rowId, element] of [...rowNodes.entries()]) {
      if (liveRowIds.has(rowId)) continue;
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

  /** Panes are iframes and swallow the keystroke, so each one learns the bound keys
   * and forwards only those; everything else stays with the conversation. */
  function publishBindings() {
    const bindings = shortcuts.map((shortcut) => shortcut.binding);
    for (const node of paneNodes.values()) {
      const frame = node.body.firstElementChild;
      frame?.contentWindow?.postMessage({ type: "canvasShortcutBindings", bindings }, location.origin);
    }
  }

  function revealPane(paneId) {
    const pane = listCanvasPanes(layout).find((candidate) => candidate.id === paneId);
    const node = pane ? paneNodes.get(paneIdentity(pane)) : null;
    if (!node) return;
    node.element.scrollIntoView({ block: "nearest", behavior: "smooth" });
    node.element.classList.add("canvas-revealed");
    setTimeout(() => node.element.classList.remove("canvas-revealed"), 1200);
    node.body.firstElementChild?.contentWindow?.postMessage({ type: "canvasFocusComposer" }, location.origin);
  }

  /** Command and Shift with one digit or letter. Reading `code` keeps the binding on
   * the physical key, so Shift's punctuation and other layouts do not change it. */
  function bindingFromCombination(combination) {
    if (!combination.metaKey || !combination.shiftKey || combination.ctrlKey || combination.altKey) return null;
    const match = /^(?:Digit([0-9])|Key([A-Z]))$/.exec(combination.code || "");
    return match ? match[1] || match[2] : null;
  }

  function handleShortcutCombination(combination) {
    if (!active) return false;
    const binding = bindingFromCombination(combination);
    if (!binding) return false;
    const shortcut = shortcuts.find((candidate) => candidate.binding === binding);
    if (!shortcut) return false;
    const pane = listCanvasPanes(layout).find((candidate) => shortcutIdentity(paneShortcutTarget(candidate)) === shortcutIdentity(shortcut));
    if (!pane) return false;
    revealPane(pane.id);
    return true;
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
      chip.append(text("kbd", `⌘⇧${entry.shortcut.binding}`));
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
    const current = shortcutFor(shortcutPane);
    if (!current) { shortcutDialog.close(); return; }
    try {
      await releaseShortcuts([shortcutPane]);
      shortcutDialog.close();
      render();
    } catch (error) {
      shortcutStatus.textContent = error instanceof Error ? error.message : "Could not remove that shortcut";
    }
  }

  /** A conversation leaving the canvas gives its key back to the account. */
  async function releaseShortcuts(panes) {
    for (const pane of panes) {
      const held = shortcutFor(pane);
      if (!held) continue;
      await shortcutRequest(`/api/canvas/shortcuts/${encodeURIComponent(held.binding)}`, { method: "DELETE" });
    }
  }

  function removePane(pane) {
    commit(removeCanvasPane(layout, pane.id));
    void releaseShortcuts([pane])
      .catch((error) => showMessage(error instanceof Error ? error.message : "Could not release that shortcut"))
      .finally(() => render());
    render();
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
      strip = widthStrip(pane);
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
        if (replaced) void releaseShortcuts([replaced]).catch(() => {});
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
  window.addEventListener("keydown", (event) => {
    if (handleShortcutCombination(event)) event.preventDefault();
  });
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    if (event.data?.type === "canvasShortcut") handleShortcutCombination(event.data);
    // A pane that just finished loading has no bindings yet.
    if (event.data?.type === "canvasPaneReady") publishBindings();
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
    openPicker,
  };
}
