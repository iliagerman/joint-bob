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
  setAttribute(name, value) { this[`attr:${name}`] = value; }
  getBoundingClientRect() { return { width: 400, height: 300 }; }
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
const controller = createConversationCanvas({
  api: async (path) => {
    if (path.includes("/sessions")) return { sessions };
    if (path.includes("/harnesses")) return { harnesses };
    return {};
  },
  getProjects: () => [{ id: "p-one", name: "Project One" }],
  saveLayout: (next) => saved.push(next),
  showMessage: () => {},
});

const paneFor = (sessionId, sessionPath) => ({ kind: "pane", id: `pane-${sessionId}`, projectId: "p-one", sessionPath, sessionId, executionNodeId: null });
const textOf = (element) => element.children.map((child) => child.text || textOf(child)).join(" ");

test("the canvas renders panes, refreshes headers, and resizes without rebuilding frames", async () => {
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

  // A metadata re-render reuses the exact same frame elements.
  await controller.activate();
  const framesAfter = [];
  walk2(root, framesAfter);
  assert.deepEqual(framesAfter, frames);
});

function walk2(node, sink) {
  if (node instanceof FakeElement) {
    if (node.tagName === "iframe") sink.push(node);
    node.children.forEach((child) => walk2(child, sink));
  }
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
  assert.equal(saved.length, 1);
  assert.equal(saved[0].root.kind, "split");
  // The add split the first pane: root.first is the new split, second pane is new.
  assert.equal(saved[0].root.first.kind, "split");
  assert.equal(saved[0].root.first.second.sessionId, "s-three");

  const root = registry.get("#canvasRoot");
  const frames = [];
  walk2(root, frames);
  assert.equal(frames.length, 3);
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
