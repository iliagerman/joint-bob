import assert from "node:assert/strict";
import test from "node:test";
import { addCanvasPane, emptyCanvasLayout, listCanvasPanes } from "../public/canvas-layout.js";

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
for (const selector of ["#canvasRoot", "#canvasConversationDialog", "#canvasProjectSelect", "#canvasSessionSearch", "#canvasSplitPosition", "#canvasSessionOptions", "#canvasPickerStatus", "#canvasPickerCancelButton", "#canvasAddButton", "#canvasOrganizeButton", "#canvasShortcutBar", "#canvasShortcutDialog", "#canvasShortcutSubject", "#canvasShortcutKey", "#canvasShortcutStatus", "#canvasShortcutRemoveButton", "#canvasShortcutSaveButton"]) {
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
  { id: "s-one", path: "/tmp/one.jsonl", title: "One", firstMessage: "first one", harnessId: "pi", reviewState: "reviewed", running: false, executionNodeId: null },
  { id: "s-two", path: "/tmp/two.jsonl", title: "Two", firstMessage: "first two", harnessId: "claude", reviewState: "needs_review", running: false, executionNodeId: null },
  { id: "s-three", path: "/tmp/three.jsonl", title: "Three", firstMessage: "first three", harnessId: "pi", reviewState: "reviewed", running: false, executionNodeId: null },
];
const harnesses = [{ id: "pi", label: "Pi", newSessionPath: "new" }, { id: "claude", label: "Claude", newSessionPath: "claude:new" }];
const saved = [];
let failSessions = false;
let storedShortcuts = [];
const apiCalls = [];
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
  showMessage: () => {},
});

const paneFor = (sessionId, sessionPath) => ({ kind: "pane", id: `pane-${sessionId}`, projectId: "p-one", sessionPath, sessionId, executionNodeId: null });
const textOf = (element) => element.children.map((child) => child.text || textOf(child)).join(" ");

let originalFrames = [];

test("the canvas renders and moves direct-child panes without rebuilding frames", async () => {
  const root = registry.get("#canvasRoot");
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  layout = addCanvasPane(layout, paneFor("s-two", "/tmp/two.jsonl"), "pane-s-one", "row");
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

  const moveDown = findElement(root, (element) => String(element["attr:aria-label"] || "").includes("Move Project One · Two one row down"));
  moveDown.dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertFramesUnchanged("cross-row movement keeps browsing contexts attached");
  const moveUp = findElement(root, (element) => String(element["attr:aria-label"] || "").includes("Move Project One · Two one row up"));
  moveUp.dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertFramesUnchanged("returning across rows keeps browsing contexts attached");

  // Horizontal movement also changes only grid placement.
  const moveLeft = findElement(root, (element) => String(element["attr:aria-label"] || "").includes("Move Project One · Two left"));
  assert.ok(moveLeft);
  moveLeft.dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const framesAfterMove = [];
  walk2(root, framesAfterMove);
  assert.deepEqual(framesAfterMove, frames);
  assert.deepEqual(saved.at(-1).rows[0].panes.map((item) => item.sessionId), ["s-two", "s-one"]);
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
  assert.equal(added.version, 4);
  assert.deepEqual(listCanvasPanes(added).map((pane) => pane.sessionId).sort(), ["s-one", "s-three", "s-two"]);

  const root = registry.get("#canvasRoot");
  const frames = [];
  walk2(root, frames);
  assert.equal(frames.length, 3);
  assert.ok(originalFrames.every((frame) => frames.includes(frame)), "adding a pane keeps every existing iframe alive");
  // Three panes in one row split it into three equal, gapless thirds.
  const spans = added.rows[0].panes.map((pane) => root.children
    .find((candidate) => candidate.dataset.paneId === pane.id).style.gridColumn.split(" / ").map(Number));
  assert.deepEqual(spans, [[1, 281], [281, 561], [561, 841]], "every pane owns an equal share and the row ends filled");

  const removeThree = findElement(root, (element) => String(element["attr:aria-label"] || "").includes("Remove Project One · Three from the canvas"));
  assert.ok(removeThree);
  removeThree.dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const framesAfterRemove = [];
  walk2(root, framesAfterRemove);
  assert.deepEqual(framesAfterRemove, originalFrames, "removing one pane leaves both unaffected browsing contexts attached");
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

test("stored widths and pinned heights never survive into the rendered grid", async () => {
  const layout = {
    version: 3,
    rows: [{
      id: "legacy-row",
      height: 900,
      weights: [0.8, 0.08, 0.08],
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
  assert.deepEqual(spans, [[1, 281], [281, 561], [561, 841]],
    "a lopsided stored row is redrawn as equal thirds");
  assert.equal(root.style.gridTemplateRows, "repeat(1, minmax(200px, 1fr))",
    "a pinned pixel height is discarded with the widths");
});

test("rows always share the canvas height and no separator exists to change that", async () => {
  const root = registry.get("#canvasRoot");
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  layout = addCanvasPane(layout, paneFor("s-two", "/tmp/two.jsonl"), "pane-s-one", "column");
  controller.setLayout({ ...layout, focusedPaneId: null });
  await controller.activate();

  assert.equal(root.style.gridTemplateRows, "repeat(2, minmax(200px, 1fr))", "every row gets the same height");
  assert.equal(root.children.filter((element) => element.classNames === "canvas-row-resize").length, 0);
  assert.ok(root.children.filter((element) => element.tagName === "section")
    .every((pane) => pane.children.every((child) => child.classNames !== "canvas-resize")),
    "no pane carries a width handle");
  // A single pane per row still spans the whole width, leaving nothing empty.
  for (const pane of listCanvasPanes(layout)) {
    const element = root.children.find((candidate) => candidate.dataset.paneId === pane.id);
    assert.equal(element.style.gridColumn, "1 / 841");
  }
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

test("organize lays every pane out as an even grid", async () => {
  const root = registry.get("#canvasRoot");
  let layout = addCanvasPane(emptyCanvasLayout(), paneFor("s-one", "/tmp/one.jsonl"));
  layout = addCanvasPane(layout, paneFor("s-two", "/tmp/two.jsonl"), "pane-s-one", "column");
  layout = addCanvasPane(layout, paneFor("s-three", "/tmp/three.jsonl"), "pane-s-two", "column");
  controller.setLayout({ ...layout, focusedPaneId: null });
  await controller.activate();

  const before = [];
  walk2(root, before);
  registry.get("#canvasOrganizeButton").dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(saved.at(-1).rows.map((row) => row.panes.length), [2, 1], "three panes become a two-column grid");
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
  layout = addCanvasPane(layout, paneFor("s-two", "/tmp/two.jsonl"), "pane-s-one", "row");
  storedShortcuts = [{ binding: "5", projectId: "p-one", engine: "pi", sessionId: "s-two" }];
  controller.setLayout({ ...layout, focusedPaneId: "pane-s-one" });
  await controller.activate();

  const pane = root.children.find((element) => element.dataset.paneId === "pane-s-two");
  const frame = [];
  walk2(pane, frame);
  const posted = [];
  frame[0].contentWindow = { postMessage: (message) => posted.push(message) };

  windowListeners.get("keydown")({ code: "Digit5", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false, preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(saved.at(-1).focusedPaneId, "pane-s-two", "focus moves to the pane the key names, instead of revealing a hidden one");
  assert.ok(posted.some((message) => message.type === "canvasFocusComposer"));
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
