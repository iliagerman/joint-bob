import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The smallest DOM `board.js` needs, so the board can be rendered and clicked in
 * a plain Node test. The source-text tests around it prove the code says the
 * right thing; this one proves the rendered card does the right thing.
 */
class StubNode {
  tagName: string;
  children: StubNode[] = [];
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  className = "";
  textContent = "";
  title = "";
  type = "";
  disabled = false;
  draggable = false;
  classList = { add: () => {}, remove: () => {}, toggle: () => {} };

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  append(...nodes: StubNode[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: StubNode[]): void {
    this.children = nodes;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(handler);
  }

  click(): void {
    for (const handler of this.listeners.click ?? []) handler({ stopPropagation: () => {} });
  }
}

function testid(node: StubNode): string | undefined {
  return node.dataset.testid ?? node.attributes["data-testid"];
}

function descendants(node: StubNode): StubNode[] {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function findAll(root: StubNode, id: string): StubNode[] {
  return descendants(root).filter((node) => testid(node) === id);
}

function taskCards(root: StubNode): StubNode[] {
  return findAll(root, "board-task-card");
}

interface StubTask {
  id: string;
  title: string;
  description: string;
  status: string;
  engine: string;
  planMode: boolean;
  sessionPath: string | null;
  worktreeBranch: string | null;
  worktreePath: string | null;
  mergedAt: string | null;
  currentNodeId: string;
  executionState: string;
  updatedAt: string;
}

function stubTask(overrides: Partial<StubTask>): StubTask {
  return {
    id: "t1",
    title: "Fix login flow",
    description: "",
    status: "in_progress",
    engine: "pi",
    planMode: false,
    sessionPath: null,
    worktreeBranch: null,
    worktreePath: null,
    mergedAt: null,
    currentNodeId: "node-abcdef12",
    executionState: "running",
    updatedAt: "2026-08-30T10:00:00.000Z",
    ...overrides,
  };
}

async function loadBoard(): Promise<{ renderBoard: (container: unknown, tasks: unknown[], handlers: unknown) => void }> {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new StubNode(tag),
    createElementNS: (_ns: string, tag: string) => new StubNode(tag),
  };
  return import("../public/board.js") as never;
}

function noopHandlers(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const noop = () => {};
  return {
    onEdit: noop,
    onMove: noop,
    onAdd: noop,
    onOpenChat: noop,
    onMerge: noop,
    onHandoff: noop,
    onArchive: noop,
    onDelete: noop,
    onSettings: noop,
    onMenu: noop,
    ...overrides,
  };
}

test("a ticket with a conversation renders a button that opens that conversation", async () => {
  const { renderBoard } = await loadBoard();
  const container = new StubNode("div");
  const task = stubTask({ sessionPath: "/Users/me/.pi/agent/sessions/abc.jsonl" });

  const opened: unknown[] = [];
  renderBoard(container, [task], noopHandlers({ onOpenChat: (candidate: unknown) => opened.push(candidate) }));

  const [button] = findAll(container, "board-task-open-chat-button");
  assert.ok(button, "a ticket with a conversation has no open-chat button");
  assert.equal(button.attributes["aria-label"], "Open chat for Fix login flow");

  button.click();
  assert.deepEqual(opened, [task], "clicking the button did not open the ticket's conversation");
});

test("a ticket with no conversation has no open-chat button", async () => {
  const { renderBoard } = await loadBoard();
  const container = new StubNode("div");

  renderBoard(container, [stubTask({ sessionPath: null })], noopHandlers());

  assert.equal(findAll(container, "board-task-open-chat-button").length, 0);
});

test("the open-chat button appears as soon as a ticket gains a conversation", async () => {
  const { renderBoard } = await loadBoard();
  const container = new StubNode("div");
  const task = stubTask({ sessionPath: null });

  renderBoard(container, [task], noopHandlers());
  assert.equal(findAll(container, "board-task-open-chat-button").length, 0);

  // This is the re-render a "tasksChanged" broadcast triggers while a ticket is
  // running. Before the watch socket followed the active project it never ran,
  // and the button only turned up after a full page reload.
  renderBoard(container, [{ ...task, sessionPath: "/Users/me/.pi/agent/sessions/abc.jsonl" }], noopHandlers());
  assert.equal(findAll(container, "board-task-open-chat-button").length, 1);
});

test("the action row stays on one line: five controls at most", async () => {
  const { renderBoard } = await loadBoard();
  const container = new StubNode("div");

  renderBoard(container, [stubTask({ sessionPath: "/tmp/a.jsonl" })], noopHandlers());

  const [card] = taskCards(container);
  const actions = descendants(card).filter((node) => (node.className || "").includes("task-action"));
  assert.equal(actions.length, 5, "the card action row grew past one line of controls");
});

test("every icon a card asks for is drawn, and the icons share one size", async () => {
  const board = await readFile("public/board.js", "utf8");
  const styles = await readFile("public/styles.css", "utf8");

  const defined = board.slice(board.indexOf("const cardIconPaths = {"), board.indexOf("function cardIcon(name)"));
  // Only the action row draws with cardIconPaths; the overflow menu items are
  // drawn by app.js from its own icon set.
  const actions = board.slice(board.indexOf("function taskCardActions("), board.indexOf("function taskCard("));
  for (const match of actions.matchAll(/"([a-z]+)"(?= : "| \? ")|icon: "([a-z]+)"/g)) {
    for (const name of match.slice(1).filter(Boolean)) {
      assert.ok(defined.includes(`${name}:`), `cardIconPaths is missing "${name}"`);
    }
  }

  assert.match(styles, /\.task-card-icon \{[^}]*width: 17px;[^}]*height: 17px;/);
  assert.match(styles, /\.task-card-actions \{[^}]*flex-wrap: nowrap;/);
});
