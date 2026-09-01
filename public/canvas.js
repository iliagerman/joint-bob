// Canvas controller: renders a persisted split layout of panes, each embedding the
// normal chat surface pointed at one exact conversation. A pane never clones or
// copies a conversation; it reopens an existing session, or - only when the user
// picks it in the dialog - opens one brand-new conversation the pane document
// creates on its own node.
//
// Pane elements are keyed and reused across renders so a resize, focus, or swap
// never reloads an iframe: drafts, scroll, and transient UI state survive. Only a
// conversation identity change (replace) or a pane removal destroys a frame.

import {
  addCanvasPane, canonicalSessionPath, emptyCanvasLayout, listCanvasPanes,
  removeCanvasPane, replaceCanvasPane, setCanvasSplitRatio, swapCanvasPanes, toggleCanvasFocus,
} from "./canvas-layout.js";

export function createConversationCanvas({ api, getProjects, saveLayout, showMessage }) {
  const root = document.querySelector("#canvasRoot");
  const dialog = document.querySelector("#canvasConversationDialog");
  const projectSelect = document.querySelector("#canvasProjectSelect");
  const searchInput = document.querySelector("#canvasSessionSearch");
  const positionSelect = document.querySelector("#canvasSplitPosition");
  const optionsList = document.querySelector("#canvasSessionOptions");
  const pickerStatus = document.querySelector("#canvasPickerStatus");

  let layout = emptyCanvasLayout();
  let active = false;
  let generation = 0;
  let pickerTargetPaneId = null;
  let replacePaneId = null;
  let pickerSessions = [];
  let pickerGeneration = 0;
  let swapSourcePaneId = null;
  let harnesses = [];
  // conversation identity -> { element, body, paneId }: keyed by the conversation,
  // not the layout slot, so a swap moves live frames between slots instead of
  // destroying and rebuilding them.
  const paneNodes = new Map();

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
      remove.addEventListener("click", () => { commit(removeCanvasPane(layout, pane.id)); render(); });
      bar.append(replace, remove);
      return bar;
    }
    const title = `${project.name} · ${session.title || session.path}`;
    bar.append(text("strong", title, "canvas-pane-title"));
    const context = `${String(session.firstMessage || "").slice(0, 90)} · ${session.harnessId === "claude" ? "Claude" : "Pi"} · ${statusLine(session)}`;
    bar.append(text("span", context, "canvas-pane-meta"));
    const actions = [
      ["Add beside", `Add a conversation beside ${title}`, () => onPicker(pane.id, null)],
      [layout.focusedPaneId === pane.id ? "Show all" : "Focus", `Focus on ${title}`, () => focusPane(pane.id)],
    ];
    if (swapSourcePaneId === pane.id) actions.push(["Cancel swap", "Cancel swapping this pane", () => { swapSourcePaneId = null; render(); }]);
    else if (swapSourcePaneId) actions.push(["Swap here", `Swap with the armed pane in place of ${title}`, () => { const source = swapSourcePaneId; swapSourcePaneId = null; commit(swapCanvasPanes(layout, source, pane.id)); render(); }]);
    else actions.push(["Swap", `Arm ${title} for swapping`, () => { swapSourcePaneId = pane.id; render(); }]);
    actions.push(["Remove", `Remove ${title} from the canvas`, () => { commit(removeCanvasPane(layout, pane.id)); render(); }]);
    for (const [label, ariaLabel, action] of actions) {
      const element = button(label);
      element.setAttribute("aria-label", ariaLabel);
      element.addEventListener("click", action);
      bar.append(element);
    }
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

  // Focus is pure CSS over the always-present tree, so no frame is ever unmounted.
  function applyFocus() {
    root.classList.toggle("canvas-focused", Boolean(layout.focusedPaneId));
    for (const node of paneNodes.values()) node.element.classList.toggle("focused", node.paneId === layout.focusedPaneId);
  }

  function focusPane(paneId) {
    commit(toggleCanvasFocus(layout, paneId));
    // Header-only refresh: the label flips between Focus and Show all.
    render({ reuseOnly: true });
  }

  function applySplitStyle(grid, split, ratio) {
    const fraction = `${ratio}fr 8px ${1 - ratio}fr`;
    if (split.axis === "row") grid.style.gridTemplateColumns = fraction;
    else grid.style.gridTemplateRows = fraction;
  }

  function resizeHandle(split, grid) {
    const handle = text("div", "", "canvas-resize");
    const rowAxis = split.axis === "row";
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", rowAxis ? "vertical" : "horizontal");
    handle.setAttribute("aria-valuemin", "15");
    handle.setAttribute("aria-valuemax", "85");
    handle.setAttribute("aria-valuenow", String(Math.round(split.ratio * 100)));
    handle.setAttribute("aria-label", rowAxis ? "Resize side-by-side panes" : "Resize stacked panes");
    let pointerId = null;
    let startPoint = 0;
    let startRatio = split.ratio;
    let gridSize = 1;
    let dragRatio = split.ratio;
    handle.addEventListener("pointerdown", (event) => {
      pointerId = event.pointerId;
      startPoint = rowAxis ? event.clientX : event.clientY;
      startRatio = split.ratio;
      dragRatio = split.ratio;
      const rect = grid.getBoundingClientRect();
      gridSize = Math.max(1, rowAxis ? rect.width : rect.height);
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      const position = rowAxis ? event.clientX : event.clientY;
      dragRatio = Math.min(0.85, Math.max(0.15, startRatio + (position - startPoint) / gridSize));
      applySplitStyle(grid, split, dragRatio);
      handle.setAttribute("aria-valuenow", String(Math.round(dragRatio * 100)));
    });
    const finish = (event, commitRatio) => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      pointerId = null;
      handle.releasePointerCapture(event.pointerId);
      if (!commitRatio) {
        dragRatio = split.ratio;
        applySplitStyle(grid, split, split.ratio);
        handle.setAttribute("aria-valuenow", String(Math.round(split.ratio * 100)));
        return;
      }
      // Geometry updates in place: no rerender, so no frame ever reloads.
      commit(setCanvasSplitRatio(layout, split.id, dragRatio));
      applySplitStyle(grid, split, dragRatio);
      handle.setAttribute("aria-valuenow", String(Math.round(dragRatio * 100)));
    };
    handle.addEventListener("pointerup", (event) => finish(event, true));
    handle.addEventListener("pointercancel", (event) => finish(event, false));
    handle.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (swapSourcePaneId) { swapSourcePaneId = null; render(); }
        return;
      }
      const forward = rowAxis ? event.key === "ArrowRight" : event.key === "ArrowDown";
      const backward = rowAxis ? event.key === "ArrowLeft" : event.key === "ArrowUp";
      if (!forward && !backward) return;
      event.preventDefault();
      const requested = Math.min(0.85, Math.max(0.15, split.ratio + (forward ? 0.05 : -0.05)));
      commit(setCanvasSplitRatio(layout, split.id, requested));
      dragRatio = requested;
      applySplitStyle(grid, split, requested);
      handle.setAttribute("aria-valuenow", String(Math.round(requested * 100)));
    });
    return handle;
  }

  function nodeElement(node) {
    if (node.kind === "pane") return paneNodes.get(paneIdentity(node))?.element || text("div", "", "canvas-pane");
    const grid = document.createElement("div");
    grid.className = `canvas-split canvas-split-${node.axis}`;
    applySplitStyle(grid, node, node.ratio);
    grid.append(nodeElement(node.first), resizeHandle(node, grid), nodeElement(node.second));
    return grid;
  }

  async function render({ reuseOnly = false } = {}) {
    if (!active) return;
    const current = ++generation;
    const onPicker = (targetPaneId, replaceId) => openPicker(targetPaneId, replaceId);
    const panes = listCanvasPanes(layout);
    const liveIdentities = new Set(panes.map((pane) => paneIdentity(pane)));
    for (const identity of [...paneNodes.keys()]) {
      if (!liveIdentities.has(identity)) paneNodes.delete(identity);
    }
    if (!panes.length) {
      paneNodes.clear();
      root.replaceChildren();
      root.classList.remove("canvas-focused");
      const empty = text("div", "", "canvas-empty");
      empty.append(text("h2", "The canvas is empty"));
      empty.append(text("p", "Add an existing conversation to begin."));
      const add = button("Add conversation");
      add.className = "primary";
      add.addEventListener("click", () => openPicker(null, null));
      empty.append(add);
      root.append(empty);
      return;
    }
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
    if (!active || current !== generation) return;
    for (const pane of panes) {
      const entry = metadata.get(pane.projectId) || {};
      const listed = (entry.sessions || []).find((candidate) => candidate.id === pane.sessionId
        || canonicalSessionPath(candidate.path) === canonicalSessionPath(pane.sessionPath)) || null;
      // Until the agent writes its first transcript line the new conversation is not
      // listed yet; the pane still opens on the draft identity it was created with.
      const session = listed || (draftHarnessId(pane.sessionPath) ? draftSession(pane) : null);
      const identity = paneIdentity(pane);
      const cached = paneNodes.get(identity);
      const keepBody = cached && cached.body.dataset.live === "1" && session;
      const body = keepBody ? cached.body
        : session ? paneBody(pane, entry.project, session)
          : paneUnavailable((entry && entry.error) || "This conversation is no longer listed on this node.", pane, onPicker);
      const header = paneHeader(pane, entry.project || null, session, onPicker);
      let element = cached && cached.body === body ? cached.element : null;
      if (!element) {
        element = document.createElement("section");
        element.className = "canvas-pane";
      }
      element.dataset.paneId = pane.id;
      // Replace only the header child in place: the body (and its iframe) stays
      // attached, so status or label refreshes never reload a conversation.
      if (element.firstElementChild) element.firstElementChild.replaceWith(header);
      else element.append(header);
      if (!body.isConnected || body.parentElement !== element) element.append(body);
      paneNodes.set(identity, { element, body, paneId: pane.id });
    }
    if (reuseOnly) {
      applyFocus();
      return;
    }
    const tree = layout.root ? nodeElement(layout.root) : null;
    if (tree) root.replaceChildren(tree);
    applyFocus();
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
        commit(replaceCanvasPane(layout, replacePaneId, pane));
      } else {
        const target = pickerTargetPaneId || layout.focusedPaneId || listCanvasPanes(layout)[0]?.id;
        let next = addCanvasPane(layout, pane, target, axis);
        // Adding while a pane is focused would hide the new pane; show the whole canvas.
        if (next.focusedPaneId) next = { ...next, focusedPaneId: null };
        commit(next);
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
    swapSourcePaneId = null;
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

  return {
    setLayout(next) {
      layout = next || emptyCanvasLayout();
      paneNodes.clear();
      if (active) render();
    },
    activate() {
      active = true;
      void ensureHarnesses();
      return render();
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
