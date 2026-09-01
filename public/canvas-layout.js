// Pure Canvas layout operations. Panes reference existing conversations by identity;
// nothing here clones, copies, or creates a conversation.

export function canonicalSessionPath(sessionPath) {
  return sessionPath.replace(/\.sync-conflict-[^/\\]+(?=\.jsonl$)/, "");
}

export function emptyCanvasLayout() {
  return { version: 1, root: null, focusedPaneId: null };
}

export function listCanvasPanes(layout) {
  const panes = [];
  const visit = (node) => {
    if (!node) return;
    if (node.kind === "pane") panes.push(node);
    else { visit(node.first); visit(node.second); }
  };
  visit(layout.root);
  return panes;
}

function clone(node) {
  return node.kind === "pane" ? { ...node } : { ...node, first: clone(node.first), second: clone(node.second) };
}

function find(node, id) {
  if (!node || node.id === id) return node;
  return node.kind === "split" ? find(node.first, id) || find(node.second, id) : null;
}

function assertPaneKnown(layout, paneId) {
  const pane = find(layout.root, paneId);
  if (!pane || pane.kind !== "pane") throw new Error("Unknown canvas pane");
  return pane;
}

function assertIdentityFree(layout, pane, ignoredPaneId = null) {
  for (const candidate of listCanvasPanes(layout)) {
    if (candidate.id === ignoredPaneId) continue;
    const sameSession = candidate.projectId === pane.projectId && candidate.sessionId === pane.sessionId;
    const samePath = candidate.projectId === pane.projectId
      && canonicalSessionPath(candidate.sessionPath) === canonicalSessionPath(pane.sessionPath);
    if (sameSession || samePath) throw new Error("Conversation is already on the canvas");
  }
}

function replaceNode(node, id, replacement) {
  if (node.id === id) return replacement;
  if (node.kind === "pane") return node;
  return { ...node, first: replaceNode(node.first, id, replacement), second: replaceNode(node.second, id, replacement) };
}

function withRoot(layout, root, focusedPaneId = layout.focusedPaneId) {
  return { ...layout, root, focusedPaneId };
}

export function addCanvasPane(layout, pane, targetPaneId, axis) {
  if (listCanvasPanes(layout).length >= 8) throw new Error("The canvas holds at most eight conversations");
  assertIdentityFree(layout, pane);
  if (!layout.root) return withRoot(layout, clone(pane));
  if (axis !== "row" && axis !== "column") throw new Error("Unknown split axis");
  assertPaneKnown(layout, targetPaneId);
  const split = { kind: "split", id: crypto.randomUUID(), axis, ratio: 0.5, first: clone(find(layout.root, targetPaneId)), second: clone(pane) };
  return withRoot(layout, replaceNode(layout.root, targetPaneId, split));
}

export function replaceCanvasPane(layout, paneId, pane) {
  assertPaneKnown(layout, paneId);
  assertIdentityFree(layout, pane, paneId);
  return withRoot(layout, replaceNode(layout.root, paneId, clone({ ...pane, id: paneId })));
}

export function removeCanvasPane(layout, paneId) {
  assertPaneKnown(layout, paneId);
  const remove = (node) => {
    if (node.kind === "pane") return node.id === paneId ? null : node;
    const first = remove(node.first);
    const second = remove(node.second);
    // A split with one child collapses to that child so no orphan track remains.
    if (!first) return second;
    if (!second) return first;
    return { ...node, first, second };
  };
  return withRoot(layout, remove(layout.root), layout.focusedPaneId === paneId ? null : layout.focusedPaneId);
}

export function swapCanvasPanes(layout, firstPaneId, secondPaneId) {
  if (firstPaneId === secondPaneId) throw new Error("Cannot swap a pane with itself");
  const first = assertPaneKnown(layout, firstPaneId);
  const second = assertPaneKnown(layout, secondPaneId);
  const exchange = (node) => {
    if (node.kind !== "pane") return { ...node, first: exchange(node.first), second: exchange(node.second) };
    if (node.id === firstPaneId) return clone({ ...second, id: firstPaneId });
    if (node.id === secondPaneId) return clone({ ...first, id: secondPaneId });
    return node;
  };
  return withRoot(layout, exchange(layout.root));
}

export function setCanvasSplitRatio(layout, splitId, ratio) {
  const split = find(layout.root, splitId);
  if (!split || split.kind !== "split") throw new Error("Unknown canvas split");
  const clamped = Math.min(0.85, Math.max(0.15, ratio));
  return withRoot(layout, replaceNode(layout.root, splitId, { ...split, ratio: clamped }));
}

export function toggleCanvasFocus(layout, paneId) {
  assertPaneKnown(layout, paneId);
  return withRoot(layout, layout.root, layout.focusedPaneId === paneId ? null : paneId);
}
