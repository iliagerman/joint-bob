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
for (const selector of ["#canvasRoot", "#canvasConversationDialog", "#canvasProjectSelect", "#canvasSessionSearch", "#canvasSplitPosition", "#canvasSessionOptions", "#canvasPickerStatus", "#canvasPickerCancelButton", "#canvasAddButton"]) {
  registry.set(selector, new FakeElement(selector.slice(1)));
}
registry.get("#canvasSplitPosition").value = "right";
globalThis.document = document;
globalThis.location = { origin: "http://canvas.test" };
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
const controller = createConversationCanvas({
  api: async (path) => {
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

  const secondPane = root.children.find((element) => element.dataset.paneId === "pane-s-two");
  secondPane.children[0].dispatch("keydown", { key: "ArrowRight", preventDefault() {} });
  assertFramesUnchanged("resize keeps browsing contexts attached");

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
  assert.equal(added.version, 2);
  assert.deepEqual(listCanvasPanes(added).map((pane) => pane.sessionId).sort(), ["s-one", "s-three", "s-two"]);

  const root = registry.get("#canvasRoot");
  const frames = [];
  walk2(root, frames);
  assert.equal(frames.length, 3);
  assert.ok(originalFrames.every((frame) => frames.includes(frame)), "adding a pane keeps every existing iframe alive");
  const thirdPane = root.children.find((element) => textOf(element).includes("Project One · Three"));
  const thirdIndex = added.rows[0].panes.findIndex((pane) => pane.id === thirdPane.dataset.paneId);
  const pair = added.rows[0].weights[thirdIndex - 1] + added.rows[0].weights[thirdIndex];
  const announced = Math.round((added.rows[0].weights[thirdIndex - 1] / pair) * 100);
  assert.equal(thirdPane.children[0]["attr:aria-valuenow"], String(announced), "a separator announces its adjacent pair ratio");

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

test("extreme legal weights reserve grid width for every pane", async () => {
  const layout = {
    version: 2,
    rows: [{
      id: "extreme-row",
      weights: [1e9, 1, 1],
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
  for (const pane of layout.rows[0].panes) {
    const element = root.children.find((candidate) => candidate.dataset.paneId === pane.id);
    const [start, end] = element.style.gridColumn.split(" / ").map(Number);
    assert.ok(end > start, `${pane.id} keeps at least one grid track`);
  }
});
