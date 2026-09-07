import assert from "node:assert/strict";
import test from "node:test";
import { addCanvasPane, createCanvasPage, emptyCanvasLayout, listCanvasPanes, selectCanvasPage, toggleCanvasFocus, canvasPageGeometry } from "../public/canvas-layout.js";

// Minimal DOM stub: enough surface for the canvas controller's render and picker
// paths to actually execute, so runtime errors (not just source shapes) fail.

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.handlers = new Map();
    this.value = "";
    this.text = "";
    this.open = false;
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    };
  }
  get firstElementChild() { return this.children.find((child) => child instanceof FakeElement) ?? null; }
  get parentElement() { return this.parentNode instanceof FakeElement ? this.parentNode : null; }
  get isConnected() {
    let node = this.parentNode;
    while (node) {
      if (node === registry.get("#canvasRoot") || node === document) return true;
      node = node.parentNode;
    }
    return false;
  }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text; }
  set className(value) { this.classNames = value; }
  append(...nodes) {
    for (const node of nodes) {
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = parent;
    parent.children[index] = node;
    this.parentNode = null;
  }
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentNode = null;
  }
  remove() { this.parentNode?.removeChild(this); }
  setAttribute(name, value) { this[`attr:${name}`] = value; }
  getBoundingClientRect() { return { left: 0, right: 400, width: 400, height: 300 }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  scrollIntoView() { this.scrolledIntoView = true; }
  focus() { this.focused = true; }
  addEventListener(type, handler) { this.handlers.set(type, handler); }
  dispatch(type, event = {}) { return this.handlers.get(type)?.({ pointerId: 1, ...event }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

const registry = new Map();
const document = {
  createElement: (tag) => new FakeElement(tag),
  querySelector: (selector) => registry.get(selector) || null,
};
for (const selector of ["#canvasRoot", "#canvasPageTabs", "#canvasPageMoveLeftButton", "#canvasPageMoveRightButton", "#canvasPageAddButton", "#canvasPageDeleteButton", "#canvasConversationDialog", "#canvasProjectSelect", "#canvasSessionSearch", "#canvasSplitPosition", "#canvasSessionOptions", "#canvasPickerStatus", "#canvasPickerCancelButton", "#canvasAddButton", "#canvasOrganizeButton", "#canvasShortcutBar", "#canvasShortcutDialog", "#canvasShortcutSubject", "#canvasShortcutKey", "#canvasShortcutStatus", "#canvasShortcutRemoveButton", "#canvasShortcutSaveButton", "#canvasShortcutChordLabel", "#canvasFinderButton", "#canvasFinderDialog", "#canvasFinderInput", "#canvasFinderResults", "#canvasFinderStatus", "#canvasKeymapButton", "#canvasKeymapDialog", "#canvasKeymapStatus", "#canvasKeymapSaveButton", "#canvasKeymapResetButton", "#canvasKeymapModifier-meta", "#canvasKeymapModifier-ctrl", "#canvasKeymapModifier-alt", "#canvasKeymapModifier-shift", "#canvasKeymapCommand-recentPane", "#canvasKeymapCommand-focusPane", "#canvasKeymapCommand-paneSearch", "#canvasKeymapCommand-toggleView", "#canvasProjectFilter", "#canvasArrangeSelect"]) {
  registry.set(selector, new FakeElement(selector.slice(1)));
}
const windowListeners = new Map<string, (event: unknown) => void>();
registry.get("#canvasSplitPosition").value = "right";
globalThis.document = document;
globalThis.location = { origin: "http://canvas.test" };
globalThis.window = {
  addEventListener: (type: string, handler: (event: unknown) => void) => windowListeners.set(type, handler),
  location: { origin: "http://canvas.test" },
};
globalThis.Option = class {
  constructor(text, value) { this.text = text; this.value = value; }
};

const { createConversationCanvas } = await import("../public/canvas.js");

const sessions = [
  { id: "s-one", path: "/tmp/one.jsonl", title: "One", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z", firstMessage: "first one", harnessId: "pi", reviewState: "reviewed", running: false, executionNodeId: null },
  { id: "s-two", path: "/tmp/two.jsonl", title: "Two", createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", firstMessage: "first two", harnessId: "claude", reviewState: "needs_review", running: false, executionNodeId: null },
  { id: "s-three", path: "/tmp/three.jsonl", title: "Three", createdAt: "2026-03-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z", firstMessage: "first three", harnessId: "pi", reviewState: "reviewed", running: false, executionNodeId: null },
];
const harnesses = [{ id: "pi", label: "Pi", newSessionPath: "new" }, { id: "claude", label: "Claude", newSessionPath: "claude:new" }];
const saved = [];
const shortcutSettingsOpens = [];
const spotlightOpens = [];
const pendingReviewOpens = [];
let failSessions = false;
let storedShortcuts = [];
const apiCalls = [];
const viewToggles = [];
let confirmClose = false;
const confirmations = [];
const controller = createConversationCanvas({
  api: async (path, options = {}) => {
    apiCalls.push(`${options.method || "GET"} ${path}`);
    if (path.startsWith("/api/canvas/shortcuts")) {
      const last = decodeURIComponent(path.split("/").pop());
      if (options.method === "PUT") {
        const body = JSON.parse(options.body);
        storedShortcuts = [...storedShortcuts.filter((entry) => entry.binding !== last && entry.sessionId !== body.sessionId), { binding: last, ...body }];
      }
      if (options.method === "POST" && last === "release") {
        const body = JSON.parse(options.body);
        storedShortcuts = storedShortcuts.filter((entry) => entry.sessionId !== body.sessionId);
      }
      if (options.method === "DELETE") storedShortcuts = storedShortcuts.filter((entry) => entry.binding !== last);
      return { shortcuts: storedShortcuts };
    }
    if (path.includes("/sessions")) {
      if (failSessions) throw new Error("Temporary metadata failure");
      return { sessions };
    }
    if (path.includes("/harnesses")) return { harnesses };
    return {};
  },
  getProjects: () => [{ id: "p-one", name: "Project One" }],
  saveLayout: (next) => saved.push(next),
  openShortcutSettings: () => { shortcutSettingsOpens.push(Date.now()); },
  openSpotlight: () => { spotlightOpens.push(Date.now()); },
  openPendingReviews: () => { pendingReviewOpens.push(Date.now()); },
  showMessage: () => {},
  toggleView: () => { viewToggles.push("toggled"); },
  confirmAction: async (options) => { confirmations.push(options); return confirmClose; },
});

const paneFor = (sessionId, sessionPath) => ({ kind: "pane", id: `pane-${sessionId}`, projectId: "p-one", sessionPath, sessionId, executionNodeId: null });
const textOf = (element) => element.children.map((child) => child.text || textOf(child)).join(" ");

let originalFrames = [];

test("the canvas renders and moves direct-child panes without rebuilding frames", async () => {
  const root = registry.get("#canvasRoot");
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  layout = addCanvasPane(layout, paneFor("s-two", "/tmp/two.jsonl"), "pane-s-one", "right");
  controller.setLayout(layout);
  await controller.activate();

  const frames = [];
  walk2(root, frames);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].src, "http://canvas.test/?canvasPane=1&projectId=p-one&sessionPath=%2Ftmp%2Fone.jsonl&sessionId=s-one");
  assert.equal(frames[1].src, "http://canvas.test/?canvasPane=1&projectId=p-one&sessionPath=%2Ftmp%2Ftwo.jsonl&sessionId=s-two");

  assert.ok(frames.every((frame) => frame.parentNode.parentNode.parentNode === root), "pane sections stay direct children of the root grid");

  // A metadata re-render reuses the exact same frame elements.
  await controller.activate();
  const framesAfter = [];
  walk2(root, framesAfter);
  assert.deepEqual(framesAfter, frames);

  failSessions = true;
  await controller.activate();
  failSessions = false;
  const framesAfterFailure = [];
  walk2(root, framesAfterFailure);
  assert.deepEqual(framesAfterFailure, frames, "metadata failure retains the existing frames");
  assert.equal(root.children.filter((element) => element.tagName === "section").length, 2, "metadata failure does not duplicate panes");
  await controller.activate();

  const assertFramesUnchanged = (message) => {
    const currentFrames = [];
    walk2(root, currentFrames);
    assert.deepEqual(currentFrames, frames, message);
  };

  const focus = findElement(root, (element) => element["attr:aria-label"] === "Focus on Project One · One");
  focus.dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertFramesUnchanged("focus keeps browsing contexts attached");
  const showAll = findElement(root, (element) => element["attr:aria-label"] === "Show all canvas panes");
  assert.ok(showAll, "the focused action names what it will do");
  showAll.dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertFramesUnchanged("unfocus keeps browsing contexts attached");

  // A geometric move swaps the two panes' slots while every browsing context stays
  // attached, and the pane that moved offers to move back.
  const moveLeft = findElement(root, (element) => String(element["attr:aria-label"] || "").includes("Move Project One · Two left"));
  assert.ok(moveLeft);
  moveLeft.dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const framesAfterMove = [];
  walk2(root, framesAfterMove);
  assert.deepEqual(framesAfterMove, frames);
  assert.deepEqual(listCanvasPanes(saved.at(-1)).map((item) => item.sessionId), ["s-two", "s-one"],
    "a geometric move swaps the two panes' positions");
  const moveBack = findElement(root, (element) => String(element["attr:aria-label"] || "").includes("Move Project One · One left"));
  assert.ok(moveBack, "the pane that moved right offers to move back");
  moveBack.dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertFramesUnchanged("returning across the split keeps browsing contexts attached");
  originalFrames = frames;
});

function walk2(node, sink) {
  if (node instanceof FakeElement) {
    if (node.tagName === "iframe") sink.push(node);
    node.children.forEach((child) => walk2(child, sink));
  }
}

function findElement(node, predicate) {
  if (!(node instanceof FakeElement)) return null;
  if (predicate(node)) return node;
  for (const child of node.children) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return null;
}

test("the picker adds an existing conversation through its button handlers", async () => {
  // A real select resets to its first option; the stub keeps the preset value.
  registry.get("#canvasProjectSelect").value = "p-one";
  controller.openPicker();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const options = registry.get("#canvasSessionOptions");
  const option = options.children.find((child) => textOf(child).includes("Three"));
  assert.ok(option, "picker lists a conversation not already on the canvas");
  assert.ok(!options.children.some((child) => textOf(child).includes("One")), "conversations already on the canvas are excluded");
  option.dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(registry.get("#canvasConversationDialog").open, false);
  const added = saved.at(-1);
  assert.equal(added.version, 6);
  assert.deepEqual(listCanvasPanes(added).map((pane) => pane.sessionId).sort(), ["s-one", "s-three", "s-two"]);

  const root = registry.get("#canvasRoot");
  const frames = [];
  walk2(root, frames);
  assert.equal(frames.length, 3);
  assert.ok(originalFrames.every((frame) => frames.includes(frame)), "adding a pane keeps every existing iframe alive");
  assert.equal(root.children.filter((child) => child.dataset.paneId).length, 3);

  const removeThree = findElement(root, (element) => String(element["attr:aria-label"] || "").includes("Remove Project One · Three from the canvas"));
  assert.ok(removeThree);
  removeThree.dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const framesAfterRemove = [];
  walk2(root, framesAfterRemove);
  assert.deepEqual(framesAfterRemove, originalFrames, "removing one pane leaves both unaffected browsing contexts attached");
});

test("Ctrl+Space split shortcuts open the picker relative to the active pane", async () => {
  const root = registry.get("#canvasRoot");
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  layout = addCanvasPane(layout, paneFor("s-two", "/tmp/two.jsonl"), "pane-s-one", "right");
  controller.setLayout(layout);
  await controller.activate();

  const frames = [];
  walk2(root, frames);
  for (const frame of frames) frame.contentWindow = { postMessage() {} };
  windowListeners.get("message")({
    origin: "http://canvas.test", source: frames[1].contentWindow, data: { type: "canvasPaneActive" },
  });

  let prevented = 0;
  const press = (event) => windowListeners.get("keydown")({ ...event, preventDefault: () => { prevented += 1; } });
  press({ code: "Space", key: " ", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });
  press({ code: "ShiftLeft", key: "Shift", ctrlKey: false, metaKey: false, altKey: false, shiftKey: true });
  press({ code: "Backslash", key: "|", ctrlKey: false, metaKey: false, altKey: false, shiftKey: true });
  assert.equal(prevented, 2, "the split sequence never reaches the active conversation");
  assert.equal(registry.get("#canvasConversationDialog").open, true);
  assert.equal(registry.get("#canvasSplitPosition").value, "right");

  registry.get("#canvasProjectSelect").value = "p-one";
  await new Promise((resolve) => setTimeout(resolve, 0));
  const option = registry.get("#canvasSessionOptions").children.find((child) => textOf(child).includes("Three"));
  option.dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(listCanvasPanes(saved.at(-1)).map((pane) => pane.sessionId), ["s-one", "s-two", "s-three"],
    "the new pane lands immediately right of the active pane");

  press({ code: "Space", key: " ", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });
  press({ code: "Minus", key: "-", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
  assert.equal(registry.get("#canvasConversationDialog").open, true);
  assert.equal(registry.get("#canvasSplitPosition").value, "below");
  registry.get("#canvasConversationDialog").close();
});

test("Ctrl+Space X closes the active pane only after Y confirmation", async () => {
  const root = registry.get("#canvasRoot");
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  layout = addCanvasPane(layout, paneFor("s-two", "/tmp/two.jsonl"), "pane-s-one", "row");
  controller.setLayout({ ...layout, focusedPaneId: null });
  await controller.activate();

  const frames = [];
  walk2(root, frames);
  for (const frame of frames) frame.contentWindow = { postMessage() {} };
  windowListeners.get("message")({
    origin: "http://canvas.test", source: frames[1].contentWindow, data: { type: "canvasPaneActive" },
  });
  const pressClose = () => {
    windowListeners.get("keydown")({ code: "Space", key: " ", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, preventDefault() {} });
    windowListeners.get("keydown")({ code: "KeyX", key: "x", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault() {} });
  };

  confirmClose = false;
  pressClose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(confirmations.at(-1).title, /Two/);
  assert.equal(root.children.filter((element) => element.tagName === "section").length, 2, "N keeps the pane open");

  confirmClose = true;
  pressClose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(listCanvasPanes(saved.at(-1)).map((pane) => pane.sessionId), ["s-one"], "Y closes the active pane");
});

test("the picker opens a pane on a brand-new conversation", async () => {
  registry.get("#canvasProjectSelect").value = "p-one";
  controller.openPicker();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const options = registry.get("#canvasSessionOptions");
  const start = options.children.find((child) => child.dataset.testid === "canvas-start-conversation-pi");
  assert.ok(start, "the picker offers a brand-new conversation per agent");
  assert.ok(options.children.some((child) => child.dataset.testid === "canvas-start-conversation-claude"));

  start.dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(registry.get("#canvasConversationDialog").open, false);
  const draft = listCanvasPanes(saved.at(-1)).find((pane) => pane.sessionPath.startsWith("draft:pi:"));
  assert.ok(draft, "the new pane owns a draft path no other pane can collide with");
  assert.equal(draft.sessionPath, `draft:pi:${draft.sessionId}`);

  const frames = [];
  walk2(registry.get("#canvasRoot"), frames);
  assert.ok(frames.some((frame) => frame.src.includes(encodeURIComponent(draft.sessionPath))),
    "the pane frame opens on the draft identity, so no listed conversation is required");
});

test("stored widths render from a migrated v5 layout", async () => {
  const layout = {
    version: 5,
    rows: [{
      id: "sized-row",
      height: 900,
      weights: [0.6, 0.25, 0.15],
      panes: [
        paneFor("s-one", "/tmp/one.jsonl"),
        paneFor("s-two", "/tmp/two.jsonl"),
        paneFor("s-three", "/tmp/three.jsonl"),
      ],
    }],
    focusedPaneId: null,
  };
  controller.setLayout(layout);
  await controller.activate();
  const root = registry.get("#canvasRoot");
  const spans = layout.rows[0].panes.map((pane) => root.children
    .find((candidate) => candidate.dataset.paneId === pane.id).style.gridColumn.split(" / ").map(Number));
  assert.deepEqual(spans, [[1, 601], [601, 851], [851, 1001]],
    "the migrated split tree keeps the exact widths the row weights described");
  assert.deepEqual(root.children.find((candidate) => candidate.dataset.paneId === "pane-s-one").style.gridRow.split(" / ").map(Number), [1, 1001]);
});

test("keyboard split handles change nested split ratios", async () => {
  const root = registry.get("#canvasRoot");
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  layout = addCanvasPane(layout, paneFor("s-two", "/tmp/two.jsonl"), "pane-s-one", "right");
  layout = addCanvasPane(layout, paneFor("s-three", "/tmp/three.jsonl"), "pane-s-two", "below");
  controller.setLayout(layout);
  await controller.activate();

  const widthHandle = root.children.find((element) => element.classNames === "canvas-resize canvas-resize-row");
  assert.ok(widthHandle, "a nested layout has a vertical split handle");
  assert.equal(widthHandle["attr:role"], "separator");
  assert.equal(widthHandle["attr:aria-orientation"], "vertical");
  widthHandle.dispatch("keydown", { key: "ArrowRight", preventDefault() {} });
  const activePage = () => saved.at(-1).pages.find((page) => page.id === saved.at(-1).activePageId);
  assert.ok(Math.abs(activePage().root.ratio - 0.55) < 1e-9, "ArrowRight grows the left pane's share");

  const heightHandle = root.children.find((element) => element.classNames === "canvas-resize canvas-resize-column");
  assert.ok(heightHandle, "a nested layout has a horizontal split handle");
  assert.equal(heightHandle["attr:role"], "separator");
  assert.equal(heightHandle["attr:aria-orientation"], "horizontal");
  heightHandle.dispatch("keydown", { key: "ArrowDown", preventDefault() {} });
  assert.ok(Math.abs(activePage().root.second.ratio - 0.55) < 1e-9, "ArrowDown grows the upper pane's share");
});

test("the empty-canvas message never lingers under real panes", async () => {
  const root = registry.get("#canvasRoot");
  controller.setLayout(emptyCanvasLayout());
  await controller.activate();
  assert.ok(root.children.some((element) => element.classNames === "canvas-empty"), "an empty canvas explains itself");

  registry.get("#canvasProjectSelect").value = "p-one";
  controller.openPicker();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const option = registry.get("#canvasSessionOptions").children.find((child) => textOf(child).includes("One"));
  option.dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(root.children.filter((element) => element.tagName === "section").length, 1);
  assert.ok(!root.children.some((element) => element.classNames === "canvas-empty"),
    "the placeholder is removed as soon as the first pane arrives");
});

test("arrange orders panes by activity or creation date", async () => {
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-two", "/tmp/two.jsonl"));
  layout = addCanvasPane(layout, paneFor("s-one", "/tmp/one.jsonl"), "pane-s-two", "row");
  layout = addCanvasPane(layout, paneFor("s-three", "/tmp/three.jsonl"), "pane-s-one", "row");
  controller.setLayout(layout);
  await controller.activate();

  const arrange = registry.get("#canvasArrangeSelect");
  arrange.value = "recent";
  arrange.dispatch("change");
  assert.deepEqual(listCanvasPanes(saved.at(-1)).map((item) => item.sessionId), ["s-one", "s-three", "s-two"]);

  arrange.value = "created";
  arrange.dispatch("change");
  assert.deepEqual(listCanvasPanes(saved.at(-1)).map((item) => item.sessionId), ["s-three", "s-two", "s-one"]);
});

test("organize lays every pane out as an even grid", async () => {
  const root = registry.get("#canvasRoot");
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  layout = addCanvasPane(layout, paneFor("s-two", "/tmp/two.jsonl"), "pane-s-one", "below");
  layout = addCanvasPane(layout, paneFor("s-three", "/tmp/three.jsonl"), "pane-s-two", "below");
  controller.setLayout(layout);
  await controller.activate();

  const before = [];
  walk2(root, before);
  registry.get("#canvasOrganizeButton").dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const geometry = canvasPageGeometry(saved.at(-1));
  const twoThirds = 2 / 3;
  assert.deepEqual(geometry.panes.get("pane-s-one"), { top: 0, bottom: 0.5, left: 0, right: twoThirds }, "one lands in the upper left half");
  assert.deepEqual(geometry.panes.get("pane-s-two"), { top: 0.5, bottom: 1, left: 0, right: twoThirds }, "two lands below it");
  assert.deepEqual(geometry.panes.get("pane-s-three"), { top: 0, bottom: 1, left: twoThirds, right: 1 }, "three takes the remaining right column");
  const after = [];
  walk2(root, after);
  assert.deepEqual(after, before, "organizing keeps every browsing context attached");
});

test("a shortcut is assigned from the title, listed in the bar, and released when the pane closes", async () => {
  const root = registry.get("#canvasRoot");
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  layout = addCanvasPane(layout, paneFor("s-two", "/tmp/two.jsonl"), "pane-s-one", "row");
  controller.setLayout({ ...layout, focusedPaneId: null });
  await controller.activate();

  // The badge sits with the conversation's title and opens the assignment dialog.
  const badge = findElement(root, (element) => element["attr:aria-label"] === "Assign a keyboard shortcut to Project One · Two");
  assert.ok(badge, "an unbound conversation offers a shortcut");
  badge.dispatch("click");
  assert.equal(registry.get("#canvasShortcutDialog").open, true);
  assert.equal(registry.get("#canvasShortcutSubject").text, "Project One · Two");

  registry.get("#canvasShortcutKey").value = "4";
  registry.get("#canvasShortcutSaveButton").dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(registry.get("#canvasShortcutDialog").open, false);
  assert.ok(apiCalls.includes("PUT /api/canvas/shortcuts/4"));
  assert.deepEqual(storedShortcuts.map((entry) => [entry.binding, entry.sessionId]), [["4", "s-two"]]);

  const bar = registry.get("#canvasShortcutBar");
  assert.equal(bar.hidden, false);
  assert.equal(bar.children.length, 1, "the bar lists one binding per bound conversation");
  assert.ok(textOf(bar).includes("Two"), "the bar names the conversation the key reaches");

  // Cmd+Shift+4 reveals that pane and puts the cursor in its composer.
  const pane = root.children.find((element) => element.dataset.paneId === "pane-s-two");
  const frame = [];
  walk2(pane, frame);
  const posted = [];
  frame[0].contentWindow = { postMessage: (message) => posted.push(message) };
  let defaultPrevented = false;
  windowListeners.get("keydown")({ code: "Digit4", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false, preventDefault: () => { defaultPrevented = true; } });
  assert.equal(defaultPrevented, true, "a bound combination never reaches the browser");
  assert.equal(pane.scrolledIntoView, true);
  assert.deepEqual(posted, [{ type: "canvasFocusComposer" }]);

  // An unbound combination is left alone.
  let untouched = true;
  windowListeners.get("keydown")({ code: "Digit7", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false, preventDefault: () => { untouched = false; } });
  assert.equal(untouched, true);

  // A keystroke typed inside a pane arrives as a message and still reveals.
  pane.scrolledIntoView = false;
  windowListeners.get("message")({ origin: "http://canvas.test", data: { type: "canvasShortcut", code: "Digit4", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false } });
  assert.equal(pane.scrolledIntoView, true, "the iframe forwards the combination it swallowed");

  // Closing the conversation releases its binding.
  const remove = findElement(root, (element) => String(element["attr:aria-label"] || "").includes("Remove Project One · Two from the canvas"));
  remove.dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(apiCalls.includes("POST /api/canvas/shortcuts/release"),
    "a closed conversation is released by conversation, not by the key the page last saw");
  assert.deepEqual(storedShortcuts, []);
  assert.equal(registry.get("#canvasShortcutBar").hidden, true);
});

test("a shortcut reaches a pane that focus mode is hiding", async () => {
  const root = registry.get("#canvasRoot");
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  layout = addCanvasPane(layout, paneFor("s-two", "/tmp/two.jsonl"), "pane-s-one", "right");
  storedShortcuts = [{ binding: "5", projectId: "p-one", engine: "pi", sessionId: "s-two" }];
  controller.setLayout(toggleCanvasFocus(layout, "pane-s-one"));
  await controller.activate();

  const pane = root.children.find((element) => element.dataset.paneId === "pane-s-two");
  const frame = [];
  walk2(pane, frame);
  const posted = [];
  frame[0].contentWindow = { postMessage: (message) => posted.push(message) };

  windowListeners.get("keydown")({ code: "Digit5", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false, preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(saved.at(-1).pages.find((page) => page.id === saved.at(-1).activePageId).focusedPaneId, "pane-s-two",
    "focus moves to the pane the key names, instead of revealing a hidden one");
  assert.ok(posted.some((message) => message.type === "canvasFocusComposer"));

  // Filtering releases focus mode in the DOM as well as the data, or the stale
  // focus CSS would keep hiding every pane the filter shows.
  registry.get("#canvasProjectFilter").value = "p-one";
  registry.get("#canvasProjectFilter").dispatch("change");
  assert.equal(root.classList.contains("canvas-focused"), false, "filtering releases focus mode");
  assert.equal(saved.at(-1).pages.find((page) => page.id === saved.at(-1).activePageId).focusedPaneId, null);
});

test("only the real pane frames may drive the canvas over postMessage", async () => {
  const root = registry.get("#canvasRoot");
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  layout = addCanvasPane(layout, paneFor("s-two", "/tmp/two.jsonl"), "pane-s-one", "row");
  storedShortcuts = [{ binding: "6", projectId: "p-one", engine: "pi", sessionId: "s-two" }];
  controller.setLayout({ ...layout, focusedPaneId: null });
  await controller.activate();

  const pane = root.children.find((element) => element.dataset.paneId === "pane-s-two");
  const frames = [];
  walk2(root, frames);
  for (const frame of frames) frame.contentWindow = { postMessage() {} };
  pane.scrolledIntoView = false;

  const combination = { type: "canvasShortcut", code: "Digit6", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false };
  windowListeners.get("message")({ origin: "http://canvas.test", source: { postMessage() {} }, data: combination });
  assert.equal(pane.scrolledIntoView, false, "a same-origin window that is not a pane cannot press a shortcut");
  windowListeners.get("message")({ origin: "https://elsewhere.test", source: frames[0].contentWindow, data: combination });
  assert.equal(pane.scrolledIntoView, false, "another origin cannot press a shortcut either");
  windowListeners.get("message")({ origin: "http://canvas.test", source: frames[0].contentWindow, data: combination });
  assert.equal(pane.scrolledIntoView, true, "a real pane frame still works");
});

test("the jump key toggles between the two conversations most recently reached", async () => {
  const root = registry.get("#canvasRoot");
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  layout = addCanvasPane(layout, paneFor("s-two", "/tmp/two.jsonl"), "pane-s-one", "row");
  controller.setLayout({ ...layout, focusedPaneId: null });
  await controller.activate();

  const frames = [];
  walk2(root, frames);
  for (const frame of frames) frame.contentWindow = { postMessage() {} };
  const first = root.children.find((element) => element.dataset.paneId === "pane-s-one");
  const second = root.children.find((element) => element.dataset.paneId === "pane-s-two");

  // Establish a known history: the user worked in One, then in Two.
  const visit = (frame) => windowListeners.get("message")({
    origin: "http://canvas.test", source: frame.contentWindow, data: { type: "canvasPaneActive" },
  });
  visit(frames[0]);
  visit(frames[1]);

  const press = () => {
    first.scrolledIntoView = false;
    second.scrolledIntoView = false;
    windowListeners.get("keydown")({ code: "KeyE", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false, preventDefault() {} });
  };

  press();
  assert.equal(first.scrolledIntoView, true, "the jump key goes back to the conversation before this one");
  assert.equal(second.scrolledIntoView, false);

  press();
  assert.equal(second.scrolledIntoView, true, "pressing it again returns, instead of cycling onwards");
  assert.equal(first.scrolledIntoView, false);

  press();
  assert.equal(first.scrolledIntoView, true, "the pair keeps alternating");
});

test("the focus key brings the pane the user last touched forward", async () => {
  // Earlier tests in this file leave a custom keymap behind; start from the defaults.
  controller.setKeymap({ modifiers: ["meta", "shift"], recentPane: "E", focusPane: "G", paneSearch: "F" });
  const root = registry.get("#canvasRoot");
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  layout = addCanvasPane(layout, paneFor("s-two", "/tmp/two.jsonl"), "pane-s-one", "right");
  controller.setLayout(layout);
  await controller.activate();

  const frames = [];
  walk2(root, frames);
  const posted = [];
  for (const frame of frames) frame.contentWindow = { postMessage: (message) => posted.push(message) };
  const second = root.children.find((element) => element.dataset.paneId === "pane-s-two");

  // The user works in the second conversation, so that is "the current one".
  windowListeners.get("message")({ origin: "http://canvas.test", source: frames[1].contentWindow, data: { type: "canvasPaneActive" } });

  const priorSaves = saved.length;
  windowListeners.get("keydown")({ code: "KeyG", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false, preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(saved.length > priorSaves, "focusing commits a layout");
  assert.equal(saved.at(-1).pages.find((page) => page.id === saved.at(-1).activePageId).focusedPaneId, "pane-s-two",
    "the conversation the user was in becomes the focused one");
  assert.equal(second.classList.contains("focused"), true, "and the canvas actually shows it alone");
  assert.equal(root.classList.contains("canvas-focused"), true);
  assert.ok(posted.some((message) => message.type === "canvasFocusComposer"), "the cursor lands in that conversation");

  // The same key is the way back: a conversation already in front returns to the others.
  windowListeners.get("keydown")({ code: "KeyG", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false, preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(saved.at(-1).pages.find((page) => page.id === saved.at(-1).activePageId).focusedPaneId, null,
    "pressing it on the conversation already in front takes it back");
  assert.equal(second.classList.contains("focused"), false, "and the canvas shows every conversation again");
  assert.equal(root.classList.contains("canvas-focused"), false);
});

test("the finder ranks canvas conversations by title and opens the chosen one", async () => {
  const root = registry.get("#canvasRoot");
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  layout = addCanvasPane(layout, paneFor("s-two", "/tmp/two.jsonl"), "pane-s-one", "row");
  layout = addCanvasPane(layout, paneFor("s-three", "/tmp/three.jsonl"), "pane-s-two", "row");
  controller.setLayout({ ...layout, focusedPaneId: null });
  await controller.activate();

  registry.get("#canvasFinderButton").dispatch("click");
  assert.equal(registry.get("#canvasFinderDialog").open, true);

  registry.get("#canvasFinderInput").value = "three";
  registry.get("#canvasFinderInput").dispatch("input");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const results = registry.get("#canvasFinderResults");
  assert.equal(results.children.length, 1, "searching for 'three' finds one match");
  assert.ok(textOf(results).includes("Three"));

  results.children[0].dispatch("click");
  assert.equal(registry.get("#canvasFinderDialog").open, false, "clicking an option closes the dialog");
  const pane = root.children.find((element) => element.dataset.paneId === "pane-s-three");
  assert.equal(pane.scrolledIntoView, true);

  // A query that matches nothing must empty the list and say so, not show everything.
  registry.get("#canvasFinderButton").dispatch("click");
  registry.get("#canvasFinderInput").value = "zzzz";
  registry.get("#canvasFinderInput").dispatch("input");
  assert.equal(registry.get("#canvasFinderResults").children.length, 0);
  assert.ok(registry.get("#canvasFinderStatus").text.length > 0, "an empty result explains itself");
  registry.get("#canvasFinderDialog").close();
});

// The keymap is edited in Settings now, so the canvas is handed one rather than
// collecting it. What the canvas still owns is which combination it answers.
test("a saved keymap changes which combination the canvas answers", async () => {
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  layout = addCanvasPane(layout, paneFor("s-two", "/tmp/two.jsonl"), "pane-s-one", "row");
  controller.setLayout({ ...layout, focusedPaneId: null });
  await controller.activate();

  controller.setKeymap({ modifiers: ["ctrl", "alt"], recentPane: null, focusPane: null, paneSearch: "J", toggleView: "V", spotlight: "P", pendingReviews: "R" });

  windowListeners.get("keydown")({ code: "KeyF", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false, preventDefault() {} });
  assert.equal(registry.get("#canvasFinderDialog").open, false, "old combination does not open finder");

  windowListeners.get("keydown")({ code: "KeyJ", metaKey: false, shiftKey: false, ctrlKey: true, altKey: true, preventDefault() {} });
  assert.equal(registry.get("#canvasFinderDialog").open, true, "new combination opens finder");
  registry.get("#canvasFinderDialog").close();
  controller.setKeymap({ modifiers: ["meta", "shift"], recentPane: "E", focusPane: "G", paneSearch: "F", toggleView: "V", spotlight: "P", pendingReviews: "R" });
});

// The search bar spans the whole workspace, so its key answers with the canvas closed.
test("the search bar key reaches the app even when the canvas is not open", async () => {
  controller.setKeymap({ modifiers: ["meta", "shift"], recentPane: "E", focusPane: "G", paneSearch: "F", toggleView: "V", spotlight: "P", pendingReviews: "R" });
  controller.deactivate();
  const priorOpens = spotlightOpens.length;
  windowListeners.get("keydown")({ code: "KeyP", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false, preventDefault() {} });
  assert.equal(spotlightOpens.length, priorOpens + 1, "the closed canvas still forwards the search key");

  // The pending reviews list is workspace-wide for the same reason.
  const priorReviews = pendingReviewOpens.length;
  windowListeners.get("keydown")({ code: "KeyR", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false, preventDefault() {} });
  assert.equal(pendingReviewOpens.length, priorReviews + 1, "the closed canvas still forwards the reviews key");
  await controller.activate();
});

// The canvas hands the user to Settings rather than owning a keymap dialog of its own.
test("the canvas Shortcuts button opens the Settings shortcuts panel", async () => {
  const priorOpens = shortcutSettingsOpens.length;
  registry.get("#canvasKeymapButton").dispatch("click");
  assert.equal(shortcutSettingsOpens.length, priorOpens + 1);
});

// A pane is an iframe, so the help chord typed inside a conversation never reaches the
// canvas document on its own; the pane forwards it and the canvas answers.
test("the help chord forwarded from a pane opens the shortcuts panel", async () => {
  const root = registry.get("#canvasRoot");
  controller.setLayout(addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl")));
  await controller.activate();
  const frames = [];
  walk2(root, frames);
  for (const frame of frames) frame.contentWindow = { postMessage() {} };

  const priorOpens = shortcutSettingsOpens.length;
  windowListeners.get("message")({
    origin: "http://canvas.test", source: frames[0].contentWindow, data: { type: "canvasHelpShortcut" },
  });
  assert.equal(shortcutSettingsOpens.length, priorOpens + 1, "the pane's help chord reaches Settings");

  // A window that this canvas never framed must not be able to drive it.
  windowListeners.get("message")({ origin: "http://canvas.test", source: {}, data: { type: "canvasHelpShortcut" } });
  assert.equal(shortcutSettingsOpens.length, priorOpens + 1, "an unknown window is ignored");
});

test("an open conversation can be added to the canvas from outside it", async () => {
  controller.setLayout(emptyCanvasLayout());
  await controller.activate();

  controller.addSessionPane("p-one", { id: "s-two", path: "/tmp/two.jsonl", executionNodeId: null });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const panes = listCanvasPanes(saved.at(-1));
  assert.equal(panes.length, 1, "one pane is on the canvas");
  assert.equal(panes[0].sessionId, "s-two");

  const root = registry.get("#canvasRoot");
  const sections = root.children.filter((element) => element.tagName === "section");
  assert.equal(sections.length, 1, "root has one section");

  assert.throws(() => controller.addSessionPane("p-one", { id: "s-two", path: "/tmp/two.jsonl", executionNodeId: null }), /already on the canvas/);
});

test("pages render tabs and keep every frame while switching", async () => {
  const root = registry.get("#canvasRoot");
  const layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  controller.setLayout(layout);
  await controller.activate();
  const frames = [];
  walk2(root, frames);
  assert.equal(frames.length, 1);

  registry.get("#canvasPageAddButton").dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const created = saved.at(-1);
  assert.equal(created.pages.length, 2);
  assert.equal(created.pages[1].name, "Page 2");
  assert.equal(created.activePageId, created.pages[1].id);
  const tabs = registry.get("#canvasPageTabs");
  assert.equal(tabs.children.length, 2);
  assert.equal(tabs.children[1]["attr:aria-selected"], "true");
  assert.ok(root.children.some((element) => element.classNames === "canvas-empty"),
    "an empty page explains itself");
  assert.equal(root.children.filter((element) => element.tagName === "section").length, 1,
    "the other page's pane section stays attached");
  assert.equal(frames[0].isConnected, true, "the other page's frame is hidden, not destroyed");

  registry.get("#canvasProjectSelect").value = "p-one";
  controller.openPicker();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const option = registry.get("#canvasSessionOptions").children.find((child) => textOf(child).includes("Three"));
  option.dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const withTwoPages = saved.at(-1);
  const activeRoot = withTwoPages.pages.find((page) => page.id === withTwoPages.activePageId).root;
  assert.ok(activeRoot, "the new pane lands on the active page");
  assert.deepEqual(listCanvasPanes(withTwoPages).map((pane) => pane.sessionId).sort(), ["s-one", "s-three"],
    "the pages hold their own conversations");
  const framesTwo = [];
  walk2(root, framesTwo);
  assert.equal(framesTwo.length, 2);
  assert.ok(framesTwo.includes(frames[0]), "adding to a page keeps every existing frame alive");

  tabs.children[0].dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(saved.at(-1).activePageId, saved.at(-1).pages[0].id);
  const framesBack = [];
  walk2(root, framesBack);
  assert.deepEqual(framesBack, framesTwo, "switching pages keeps every browsing context attached");

  assert.equal(registry.get("#canvasPageMoveLeftButton").disabled, true, "the first page cannot move left");
  registry.get("#canvasPageMoveRightButton").dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(saved.at(-1).pages.map((page) => page.name), ["Page 2", "Page 1"],
    "moving a page reorders its tab");

  confirmClose = true;
  registry.get("#canvasPageDeleteButton").dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const afterDelete = saved.at(-1);
  assert.equal(afterDelete.pages.length, 1);
  assert.equal(afterDelete.pages[0].name, "Page 2");
  const framesAfterDelete = [];
  walk2(root, framesAfterDelete);
  const pageTwoFrame = framesTwo.find((frame) => frame !== frames[0]);
  assert.deepEqual(framesAfterDelete, [pageTwoFrame], "deleting the active page removes only its own pane");
  confirmClose = false;
});

test("a shortcut into another page switches pages without stale focus", async () => {
  // Earlier tests in this file leave a custom keymap behind; start from the defaults.
  controller.setKeymap({ modifiers: ["meta", "shift"], recentPane: "E", focusPane: "G", paneSearch: "F", toggleView: "V" });
  const root = registry.get("#canvasRoot");
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  layout = addCanvasPane(layout, paneFor("s-two", "/tmp/two.jsonl"), "pane-s-one", "right");
  layout = createCanvasPage(layout);
  layout = addCanvasPane(layout, paneFor("s-three", "/tmp/three.jsonl"), null, "right");
  layout = selectCanvasPage(layout, layout.pages[0].id);
  layout = toggleCanvasFocus(layout, "pane-s-one");
  storedShortcuts = [{ binding: "7", projectId: "p-one", engine: "pi", sessionId: "s-three" }];
  controller.setLayout(layout);
  await controller.activate();

  const frames = [];
  walk2(root, frames);
  for (const frame of frames) frame.contentWindow = { postMessage() {} };
  windowListeners.get("keydown")({ code: "Digit7", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false, preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(saved.at(-1).activePageId, saved.at(-1).pages[1].id, "the shortcut switches to the owning page");
  assert.equal(root.classList.contains("canvas-focused"), false, "the previous page's focus mode does not survive the switch");
  const pane = root.children.find((element) => element.dataset.paneId === "pane-s-three");
  assert.equal(pane.hidden, false, "the target pane is visible at once");
});

test("adding a pane leaves focus mode so the new conversation is visible", async () => {
  const root = registry.get("#canvasRoot");
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  layout = toggleCanvasFocus(layout, "pane-s-one");
  controller.setLayout(layout);
  await controller.activate();

  controller.addSessionPane("p-one", { id: "s-two", path: "/tmp/two.jsonl", executionNodeId: null });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const page = saved.at(-1).pages.find((item) => item.id === saved.at(-1).activePageId);
  assert.equal(page.focusedPaneId, null, "adding a pane exits focus mode");
  assert.deepEqual(listCanvasPanes(saved.at(-1)).map((pane) => pane.sessionId).sort(), ["s-one", "s-two"]);
  const sections = root.children.filter((element) => element.tagName === "section");
  assert.equal(sections.length, 2);
  assert.ok(sections.every((section) => !section.hidden), "both panes are visible");
});

test("a conversation keeps a key a canvas command also wants", async () => {
  // Earlier tests in this file leave a custom keymap behind; start from the defaults.
  controller.setKeymap({ modifiers: ["meta", "shift"], recentPane: "E", focusPane: "G", paneSearch: "F" });
  storedShortcuts = [{ binding: "F", projectId: "p-one", engine: "pi", sessionId: "s-two" }];
  const root = registry.get("#canvasRoot");
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  layout = addCanvasPane(layout, paneFor("s-two", "/tmp/two.jsonl"), "pane-s-one", "row");
  controller.setLayout({ ...layout, focusedPaneId: null });
  await controller.activate();

  const frames = [];
  walk2(root, frames);
  for (const frame of frames) frame.contentWindow = { postMessage() {} };
  const pane = root.children.find((element) => element.dataset.paneId === "pane-s-two");
  const finder = registry.get("#canvasFinderDialog");
  finder.close();
  pane.scrolledIntoView = false;

  // F is also the default search key. The conversation that already holds it wins.
  windowListeners.get("keydown")({ code: "KeyF", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false, preventDefault() {} });
  assert.equal(finder.open, false, "a command must not run while a conversation holds its key");
  assert.equal(pane.scrolledIntoView, true, "the conversation's own binding still works");

  // Free the key and the command becomes reachable again.
  storedShortcuts = [];
  await controller.reloadShortcuts();
  pane.scrolledIntoView = false;
  windowListeners.get("keydown")({ code: "KeyF", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false, preventDefault() {} });
  assert.equal(finder.open, true, "the command runs once no conversation holds the key");
  assert.equal(pane.scrolledIntoView, false, "the command runs instead of the conversation jump");
  finder.close();
});

// Switching between the canvas and the conversation list is the one canvas command that
// has to answer from the conversation list too — otherwise the key only ever works in the
// direction that leaves the canvas.
test("the view toggle answers whether the canvas is open or closed", async () => {
  controller.setKeymap({ modifiers: ["meta", "shift"], recentPane: "E", focusPane: "G", paneSearch: "F", toggleView: "V" });
  const chord = { metaKey: true, shiftKey: true, ctrlKey: false, altKey: false };
  controller.deactivate();

  let prevented = false;
  windowListeners.get("keydown")({ ...chord, code: "KeyV", preventDefault: () => { prevented = true; } });
  assert.equal(viewToggles.length, 1, "the closed canvas still answers its own toggle key");
  assert.equal(prevented, true, "the toggle takes the keystroke");

  // Every other command belongs to the canvas and stays inert while it is closed.
  const finder = registry.get("#canvasFinderDialog");
  windowListeners.get("keydown")({ ...chord, code: "KeyF", preventDefault() {} });
  assert.equal(finder.open, false, "the pane search stays with the open canvas");

  await controller.activate();
  windowListeners.get("keydown")({ ...chord, code: "KeyV", preventDefault() {} });
  assert.equal(viewToggles.length, 2, "and answers again from inside the canvas");
});
