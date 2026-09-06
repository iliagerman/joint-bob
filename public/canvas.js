// Canvas controller: renders a persisted recursive, multi-page layout of panes, each
// embedding the normal chat surface pointed at one exact conversation. A pane never
// clones or copies a conversation; it reopens an existing session, or - only when the
// user picks it in the dialog - opens one brand-new conversation the pane document
// creates on its own node.
//
// Panes are direct children of the canvas root, placed on a fine-grained CSS grid
// through inline grid-area styles. Adding, removing, moving, resizing, focusing, or
// switching pages only changes styles: pane elements are never reparented, so no
// iframe reloads and no draft or scroll position is lost.

import {
  addCanvasPane, arrangeCanvasLayout, CANVAS_KEYMAP_COMMANDS, CANVAS_MAX_PAGES, CANVAS_MODIFIERS, canonicalCanvasKey, canvasChordLabel,
  canvasChordIsUsable, canvasChordMatches, canvasKeyFromCode, canvasPaneEngine, canvasPaneMoves, canvasPaneNeighbor, canvasSplitPlacement,
  canonicalSessionPath, isCanvasModifierKey, isCanvasSplitLeader,
  DEFAULT_CANVAS_KEYMAP, emptyCanvasLayout, fuzzyMatchScore, activeCanvasPage, canvasPageForPane,
  canvasPageGeometry, createCanvasPage, listCanvasPagePanes, listCanvasPanes, moveCanvasPage, moveCanvasPane,
  normalizeCanvasKeymap, normalizeCanvasLayout, organizeCanvasLayout, removeCanvasPage, removeCanvasPane,
  replaceCanvasPane, selectCanvasPage, setCanvasPageFilter, setCanvasSplitRatio, toggleCanvasFocus,
} from "./canvas-layout.js";

const CANVAS_GRID_UNITS = 1000;

export function createConversationCanvas({ api, getProjects, saveLayout, saveKeymap, showMessage, toggleView, confirmAction }) {
  const root = document.querySelector("#canvasRoot");
  const dialog = document.querySelector("#canvasConversationDialog");
  const projectSelect = document.querySelector("#canvasProjectSelect");
  const searchInput = document.querySelector("#canvasSessionSearch");
  const positionSelect = document.querySelector("#canvasSplitPosition");
  const optionsList = document.querySelector("#canvasSessionOptions");
  const pickerStatus = document.querySelector("#canvasPickerStatus");
  const organizeButton = document.querySelector("#canvasOrganizeButton");
  const projectFilter = document.querySelector("#canvasProjectFilter");
  const arrangeSelect = document.querySelector("#canvasArrangeSelect");
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

  const pageTabs = document.querySelector("#canvasPageTabs");
  const pageMoveLeftButton = document.querySelector("#canvasPageMoveLeftButton");
  const pageMoveRightButton = document.querySelector("#canvasPageMoveRightButton");
  const pageAddButton = document.querySelector("#canvasPageAddButton");
  const pageDeleteButton = document.querySelector("#canvasPageDeleteButton");
  let layout = emptyCanvasLayout();
  let previewLayout = null;
  let active = false;
  let generation = 0;
  let pickerTargetPaneId = null;
  let replacePaneId = null;
  let pickerSessions = [];
  let pickerGeneration = 0;
  let harnesses = [];
  let canvasMetadata = new Map();
  // conversation identity -> { element, body, strip, paneId }: keyed by the
  // conversation, not the layout slot, so a move only restyles the same element.
  const paneNodes = new Map();
  // Split separators are direct children of the canvas root.
  const splitNodes = new Map();
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
  let splitLeaderArmed = false;

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
    const focusLabel = activeCanvasPage(layout).focusedPaneId === pane.id ? "Show all canvas panes" : `Focus on ${title}`;
    action(activeCanvasPage(layout).focusedPaneId === pane.id ? "Show all" : "Focus", focusLabel, () => focusPane(pane.id));
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
    url.searchParams.set("sessionId", session.id);
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

  const gridLine = (value) => 1 + Math.round(value * CANVAS_GRID_UNITS);
  const paneStyle = (element, box) => {
    element.style.gridRow = `${gridLine(box.top)} / ${gridLine(box.bottom)}`;
    element.style.gridColumn = `${gridLine(box.left)} / ${gridLine(box.right)}`;
  };
  function filteredGeometry(panes) {
    const result = new Map();
    const walk = (items, top, bottom, left, right, axis = "row") => {
      if (items.length === 1) { result.set(items[0].id, { top, bottom, left, right }); return; }
      const middle = Math.ceil(items.length / 2);
      if (axis === "row") {
        const boundary = left + (right - left) * middle / items.length;
        walk(items.slice(0, middle), top, bottom, left, boundary, "column");
        walk(items.slice(middle), top, bottom, boundary, right, "column");
      } else {
        const boundary = top + (bottom - top) * middle / items.length;
        walk(items.slice(0, middle), top, boundary, left, right, "row");
        walk(items.slice(middle), boundary, bottom, left, right, "row");
      }
    };
    if (panes.length) walk(panes, 0, 1, 0, 1);
    return result;
  }
  function placeAll(source = previewLayout || layout) {
    const page = activeCanvasPage(source);
    const filtered = page.projectFilter ? listCanvasPagePanes(source).filter((pane) => pane.projectId === page.projectFilter) : null;
    const geometry = filtered ? { panes: filteredGeometry(filtered), splits: new Map() } : canvasPageGeometry(source);
    root.classList.toggle("canvas-filtered", Boolean(filtered));
    // Only the active page's panes and separators are placed; every other page's
    // elements stay attached but hidden, so switching pages never reloads a frame.
    for (const node of paneNodes.values()) node.element.hidden = true;
    for (const node of splitNodes.values()) node.element.hidden = true;
    for (const [paneId, box] of geometry.panes) {
      const pane = listCanvasPanes(source).find((item) => item.id === paneId);
      const node = pane && paneNodes.get(paneIdentity(pane));
      if (node) { node.element.hidden = false; paneStyle(node.element, box); }
    }
    for (const [splitId, box] of geometry.splits) {
      const node = splitNodes.get(splitId);
      if (!node) continue;
      node.element.hidden = false;
      node.element.setAttribute("aria-valuenow", String(Math.round(box.ratio * 100)));
      // A handle starts on the boundary line and spills half over each neighbour,
      // so it never occupies layout space of its own.
      if (box.axis === "row") {
        node.element.style.gridRow = `${gridLine(box.top)} / ${gridLine(box.bottom)}`;
        node.element.style.gridColumn = `${gridLine(box.boundary)} / ${gridLine(box.boundary) + 1}`;
      } else {
        node.element.style.gridRow = `${gridLine(box.boundary)} / ${gridLine(box.boundary) + 1}`;
        node.element.style.gridColumn = `${gridLine(box.left)} / ${gridLine(box.right)}`;
      }
    }
  }

  function applyFocus() {
    const focused = activeCanvasPage(layout).focusedPaneId;
    root.classList.toggle("canvas-focused", Boolean(focused));
    for (const node of paneNodes.values()) node.element.classList.toggle("focused", node.paneId === focused);
    if (focused) for (const node of paneNodes.values()) if (node.paneId === focused) node.element.style.gridArea = "1 / 1 / -1 / -1";
  }

  function focusPane(paneId) {
    commit(toggleCanvasFocus(layout, paneId));
    placeAll();
    applyFocus();
    // Refresh controls in place; cached frame bodies stay attached.
    render();
  }
  function wireSplitPointer(handle, splitId) {
    let drag = null;
    const ratioFor = (event, box) => {
      const bounds = root.getBoundingClientRect();
      return box.axis === "row"
        ? (event.clientX - (bounds.left + box.left * bounds.width)) / ((box.right - box.left) * bounds.width)
        : (event.clientY - (bounds.top + box.top * bounds.height)) / ((box.bottom - box.top) * bounds.height);
    };
    handle.addEventListener("pointerdown", (event) => {
      const box = canvasPageGeometry(layout).splits.get(splitId);
      if (!box) return;
      drag = { pointerId: event.pointerId, box };
      handle.setPointerCapture(event.pointerId);
      root.classList.add("canvas-resizing");
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      previewLayout = setCanvasSplitRatio(layout, splitId, ratioFor(event, drag.box));
      placeAll();
    });
    const finish = (event, save) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const ending = drag;
      drag = null;
      handle.releasePointerCapture(event.pointerId);
      root.classList.remove("canvas-resizing");
      previewLayout = null;
      if (save) commit(setCanvasSplitRatio(layout, splitId, ratioFor(event, ending.box)));
      placeAll();
    };
    handle.addEventListener("pointerup", (event) => finish(event, true));
    handle.addEventListener("pointercancel", (event) => finish(event, false));
    handle.addEventListener("keydown", (event) => {
      const box = canvasPageGeometry(layout).splits.get(splitId);
      const keys = box?.axis === "row" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
      if (!box || !keys.includes(event.key)) return;
      event.preventDefault();
      commit(setCanvasSplitRatio(layout, splitId, box.ratio + (["ArrowRight", "ArrowDown"].includes(event.key) ? .05 : -.05)));
      placeAll();
    });
  }
  function syncSplitSeparators() {
    const splits = new Map();
    for (const page of layout.pages) for (const [id, box] of canvasPageGeometry(layout, page.id).splits) splits.set(id, box);
    for (const [id, node] of splitNodes) if (!splits.has(id)) { node.element.remove(); splitNodes.delete(id); }
    for (const [id, box] of splits) {
      if (splitNodes.has(id)) continue;
      const element = text("div", "", `canvas-resize canvas-resize-${box.axis}`);
      element.tabIndex = 0;
      element.dataset.testid = "canvas-split-handle";
      element.setAttribute("role", "separator");
      element.setAttribute("aria-orientation", box.axis === "row" ? "vertical" : "horizontal");
      element.setAttribute("aria-label", box.axis === "row" ? "Resize the panes beside each other" : "Resize the panes above and below each other");
      element.setAttribute("aria-valuemin", "15");
      element.setAttribute("aria-valuemax", "85");
      wireSplitPointer(element, id);
      splitNodes.set(id, { element, splitId: id });
      root.append(element);
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

  const livePaneIds = () => new Set(listCanvasPagePanes(layout).map((pane) => pane.id));

  /** The pane the user last worked in; before they have, the layout's own order decides. */
  function currentPaneId() {
    const live = livePaneIds();
    return visitOrder.find((id) => live.has(id)) || activeCanvasPage(layout).focusedPaneId || listCanvasPagePanes(layout)[0]?.id || null;
  }

  /** The pane before the current one, so one key jumps back and forth between two. */
  function previousPaneId() {
    const live = livePaneIds();
    const visited = visitOrder.filter((id) => live.has(id));
    if (visited[1]) return visited[1];
    return listCanvasPagePanes(layout).find((pane) => pane.id !== visited[0])?.id || null;
  }

  function revealPane(paneId) {
    const pane = listCanvasPanes(layout).find((candidate) => candidate.id === paneId);
    const node = pane ? paneNodes.get(paneIdentity(pane)) : null;
    if (!node) return false;
    noteVisit(paneId);
    // Focus mode hides every other pane, so a shortcut into one moves focus instead of
    // scrolling to something the canvas is not showing.
    const owner = canvasPageForPane(layout, paneId);
    if (owner.id !== layout.activePageId) {
      commit(selectCanvasPage(layout, owner.id));
      showActivePage();
    }
    if (activeCanvasPage(layout).focusedPaneId && activeCanvasPage(layout).focusedPaneId !== paneId) {
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
    if (activeCanvasPage(layout).focusedPaneId !== paneId) {
      commit(toggleCanvasFocus(layout, paneId));
      applyFocus();
      render();
    }
    return revealPane(paneId);
  }

  function handleLeaderShortcut(combination, explicitPaneId = null) {
    if (!active) return false;
    if (isCanvasSplitLeader(combination)) { splitLeaderArmed = true; return true; }
    if (!splitLeaderArmed && !explicitPaneId) return false;
    if (isCanvasModifierKey(combination)) return false;
    splitLeaderArmed = false;
    const page = activeCanvasPage(layout);
    if (combination.code === "KeyC") {
      try {
        commit(createCanvasPage(layout));
        showActivePage();
      } catch (error) {
        showMessage(error instanceof Error ? error.message : "Could not create that page");
      }
      render();
      return true;
    }
    if (combination.code === "KeyN" || combination.code === "KeyP") {
      const step = combination.code === "KeyN" ? 1 : -1;
      const pages = layout.pages;
      commit(selectCanvasPage(layout, pages[(pages.indexOf(page) + step + pages.length) % pages.length].id));
      showActivePage();
      render();
      return true;
    }
    const digit = /^Digit([1-9])$/.exec(combination.code);
    if (digit && layout.pages[Number(digit[1]) - 1]) {
      commit(selectCanvasPage(layout, layout.pages[Number(digit[1]) - 1].id));
      showActivePage();
      render();
      return true;
    }
    const targetPaneId = explicitPaneId || currentPaneId();
    if (!targetPaneId) return false;
    const placement = canvasSplitPlacement(combination);
    if (placement) openPicker(targetPaneId, null, placement);
    else if (combination.code === "KeyX") void confirmClosePane(targetPaneId);
    else if (/^Arrow(?:Left|Right|Up|Down)$/.test(combination.code)) {
      const neighbor = canvasPaneNeighbor(layout, targetPaneId, combination.code.slice(5).toLowerCase());
      if (neighbor) revealPane(neighbor);
    } else return false;
    return true;
  }

  /** A conversation's own key is checked first: adding a command must never silently
   * take a binding the user already had. */
  function handleShortcutCombination(combination) {
    if (!canvasChordMatches(keymap, combination)) return false;
    const key = canvasKeyFromCode(combination.code);
    if (!key) return false;
    // Switching between the canvas and the conversation list is the only command that
    // also answers while the canvas is closed: it is how the user gets back to it.
    if (key === keymap.toggleView) {
      toggleView();
      return true;
    }
    if (!active) return false;
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
  /** Adding a pane leaves focus mode, as it did before: the canvas must show the
   *  new conversation, not keep hiding it behind the previously focused one. */
  function addPaneExitingFocus(layout, pane, target, placement) {
    let next = addCanvasPane(layout, pane, target, placement);
    const focused = activeCanvasPage(next).focusedPaneId;
    if (focused) next = toggleCanvasFocus(next, focused);
    return next;
  }

  function addSessionPane(projectId, session) {
    const pane = {
      kind: "pane", id: crypto.randomUUID(), projectId,
      sessionPath: session.path, sessionId: session.id,
      executionNodeId: session.executionNodeId ?? null,
    };
    const target = activeCanvasPage(layout).focusedPaneId || listCanvasPagePanes(layout).at(-1)?.id || null;
    let next;
    try {
      next = addPaneExitingFocus(layout, pane, target, "right");
    } catch (error) {
      if (!/at most eight/.test(error.message)) throw error;
      next = addPaneExitingFocus(layout, pane, target, "below");
    }
    commit(next);
    if (active) render();
  }

  async function confirmClosePane(paneId) {
    const pane = listCanvasPanes(layout).find((candidate) => candidate.id === paneId);
    if (!pane) return;
    const confirmed = await confirmAction({
      eyebrow: "Close canvas pane",
      title: `Close "${paneTitle(pane)}"?`,
      message: "The conversation stays in its project and can be added to the canvas again.",
      confirmLabel: "Yes (Y)",
      cancelLabel: "No (N)",
    });
    if (confirmed) removePane(pane);
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

  function sessionMatchesPane(candidate, pane) {
    if (candidate.id === pane.sessionId || canonicalSessionPath(candidate.path) === canonicalSessionPath(pane.sessionPath)) return true;
    // A conversation that switched harness lists only its newest segment; older
    // segments still identify the same conversation.
    return Boolean(candidate.segments?.some((segment) => segment.sessionId === pane.sessionId
      || canonicalSessionPath(segment.path) === canonicalSessionPath(pane.sessionPath)));
  }

  function syncPaneElement(pane, entry, onPicker) {
    const listed = (entry.sessions || []).find((candidate) => sessionMatchesPane(candidate, pane)) || null;
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
    if (!element) {
      element = document.createElement("section");
      element.className = "canvas-pane";
      root.append(element);
    }
    element.dataset.paneId = pane.id;
    // Replace only the header. The body and iframe stay attached.
    const headerSlot = element.children[0] || null;
    if (headerSlot) headerSlot.replaceWith(header);
    else element.append(header);
    if (cached && cached.body !== body && cached.body.parentElement === element) cached.body.replaceWith(body);
    else if (!body.isConnected || body.parentElement !== element) element.append(body);
    paneNodes.set(identity, { element, body, paneId: pane.id });
  }

  function renderEmptyCanvas() {
    arrangeSelect.disabled = true;
    if (!emptyNode) {
      emptyNode = text("div", "", "canvas-empty");
      emptyNode.append(text("h2", "The canvas is empty"), text("p", "Add an existing conversation to begin."));
      const add = button("Add conversation");
      add.className = "primary";
      add.addEventListener("click", () => openPicker(null, null));
      emptyNode.append(add);
    }
    root.append(emptyNode);
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
    if (!listCanvasPagePanes(layout).length) renderEmptyCanvas();
    else if (emptyNode) { emptyNode.remove(); emptyNode = null; }
    const metadata = await loadCanvasMetadata(panes);
    if (!active || current !== generation) return;
    canvasMetadata = metadata;
    syncProjectFilter();
    arrangeSelect.disabled = false;
    const onPicker = (targetPaneId, replaceId) => openPicker(targetPaneId, replaceId);
    for (const pane of panes) syncPaneElement(pane, metadata.get(pane.projectId) || {}, onPicker);
    renderPages();
    syncSplitSeparators();
    placeAll();
    applyFocus();
    renderShortcutBar();
    publishBindings();
  }

  /** Swaps the visible page at once, before any metadata refresh: a slow sessions
   *  response must never keep the previous page on screen after the switch. */
  function showActivePage() {
    renderPages();
    placeAll();
    applyFocus();
  }
  function renderPages() {
    const page = activeCanvasPage(layout);
    pageTabs.replaceChildren(...layout.pages.map((item) => {
      const tab = button(item.name);
      tab.className = "canvas-page-tab";
      tab.dataset.testid = "canvas-page-tab";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(item.id === page.id));
      tab.addEventListener("click", () => {
        commit(selectCanvasPage(layout, item.id));
        showActivePage();
        render();
      });
      return tab;
    }));
    const index = layout.pages.indexOf(page);
    pageMoveLeftButton.disabled = index === 0;
    pageMoveRightButton.disabled = index === layout.pages.length - 1;
    pageAddButton.disabled = layout.pages.length >= CANVAS_MAX_PAGES;
  }

  function syncProjectFilter() {
    const projects = getProjects();
    const projectIds = new Set(listCanvasPagePanes(layout).map((pane) => pane.projectId));
    const represented = projects.filter((project) => projectIds.has(project.id))
      .sort((left, right) => left.name.localeCompare(right.name));
    projectFilter.replaceChildren(new Option("All projects", ""), ...represented.map((project) => new Option(project.name, project.id)));
    const selected = activeCanvasPage(layout).projectFilter;
    // A persisted filter can outlive its project. Clear it in the layout too, or
    // the canvas would keep rendering a filtered, empty page forever.
    if (selected && !represented.some((project) => project.id === selected)) {
      commit(setCanvasPageFilter(layout, ""));
      projectFilter.value = "";
      return;
    }
    projectFilter.value = represented.some((project) => project.id === selected) ? selected : "";
  }

  function sessionForPane(pane) {
    return canvasMetadata.get(pane.projectId)?.sessions.find((session) => session.id === pane.sessionId
      || canonicalSessionPath(session.path) === canonicalSessionPath(pane.sessionPath)) || null;
  }

  function arrangeCanvas(by) {
    const projects = new Map(getProjects().map((project) => [project.id, project]));
    const entries = listCanvasPagePanes(layout).map((pane) => ({ pane, session: sessionForPane(pane) }));
    const title = (entry) => entry.session?.title || entry.pane.sessionPath;
    const tieBreak = (left, right) => title(left).localeCompare(title(right));
    entries.sort((left, right) => {
      if (by === "project") {
        const projectOrder = (projects.get(left.pane.projectId)?.name || left.pane.projectId)
          .localeCompare(projects.get(right.pane.projectId)?.name || right.pane.projectId);
        return projectOrder || tieBreak(left, right);
      }
      const field = by === "recent" ? "updatedAt" : "createdAt";
      return String(right.session?.[field] || "").localeCompare(String(left.session?.[field] || "")) || tieBreak(left, right);
    });
    commit(arrangeCanvasLayout(layout, entries.map((entry) => entry.pane.id)));
    arrangeSelect.value = "";
    render();
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
      if (replacePaneId) {
        const replaced = listCanvasPanes(layout).find((candidate) => candidate.id === replacePaneId);
        commit(replaceCanvasPane(layout, replacePaneId, pane));
        if (replaced) void releaseShortcuts([replaced]).then(render, reportShortcutFailure);
      } else {
        const target = pickerTargetPaneId || activeCanvasPage(layout).focusedPaneId || listCanvasPagePanes(layout).at(-1)?.id;
        commit(addPaneExitingFocus(layout, pane, target, positionSelect.value));
      }
      dialog.close();
      render();
    } catch (error) {
      pickerStatus.textContent = error instanceof Error ? error.message : "Could not add that conversation";
    }
  }

  function openPicker(targetPaneId = null, replaceId = null, placement = null) {
    pickerTargetPaneId = targetPaneId;
    replacePaneId = replaceId;
    if (placement) positionSelect.value = placement;
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

  pageAddButton.addEventListener("click", () => {
    try {
      commit(createCanvasPage(layout));
      showActivePage();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Could not create that page");
    }
    render();
  });
  pageMoveLeftButton.addEventListener("click", () => { commit(moveCanvasPage(layout, layout.activePageId, "left")); render(); });
  pageMoveRightButton.addEventListener("click", () => { commit(moveCanvasPage(layout, layout.activePageId, "right")); render(); });
  pageDeleteButton.addEventListener("click", async () => {
    const page = activeCanvasPage(layout);
    if (!await confirmAction({ eyebrow: "Delete canvas page", title: `Delete ${page.name}?`, message: "Its conversations remain available.", confirmLabel: "Delete", cancelLabel: "Cancel" })) return;
    const removed = listCanvasPagePanes(layout, page.id);
    commit(removeCanvasPage(layout, page.id));
    void releaseShortcuts(removed).then(render, reportShortcutFailure);
    showActivePage();
    render();
  });
  projectSelect.addEventListener("change", () => void loadPickerSessions());
  searchInput.addEventListener("input", renderPickerOptions);
  organizeButton.addEventListener("click", () => {
    commit(organizeCanvasLayout(layout));
    placeAll();
    render();
  });
  projectFilter.addEventListener("change", () => {
    const page = activeCanvasPage(layout);
    let next = setCanvasPageFilter(layout, projectFilter.value);
    if (page.focusedPaneId) next = toggleCanvasFocus(next, page.focusedPaneId);
    commit(next);
    root.scrollTop = 0;
    applyFocus();
    placeAll();
  });
  arrangeSelect.addEventListener("change", () => {
    if (arrangeSelect.value) arrangeCanvas(arrangeSelect.value);
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
    if (handleLeaderShortcut(event) || handleShortcutCombination(event)) event.preventDefault();
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
    if (event.data?.type === "canvasLeaderShortcut") {
      const codes = new Set(["Backslash", "Minus", "KeyX", "KeyC", "KeyN", "KeyP", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9"]);
      if (codes.has(event.data.code)) handleLeaderShortcut({ code: event.data.code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, paneId);
    }
    // A pane that just finished loading has no bindings yet.
    if (event.data?.type === "canvasPaneReady") publishBindings();
    // Knowing which pane the user last touched is what makes "the current one" real.
    if (event.data?.type === "canvasPaneActive") noteVisit(paneId);
  });

  return {
    setLayout(next) {
      layout = normalizeCanvasLayout(next);
      paneNodes.clear();
      splitNodes.clear();
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
