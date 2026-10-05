import { h, s } from "./git-story-dom.js";

export const KIND_LABEL = { action: "You or the UI", decision: "Decision", process: "Server step", model: "AI model", store: "Storage", source: "Read-only source", error: "Error" };
const KIND_COLOR = { action: "var(--accent)", decision: "var(--amber)", process: "var(--muted)", model: "var(--claude)", store: "var(--gs-info)", source: "var(--muted)", error: "var(--danger)" };
const edgeId = (edge) => `${edge.from}>${edge.to}`;
const fit = (text, chars) => text.length > chars ? `${text.slice(0, Math.max(1, chars - 1))}…` : text;

// Columns follow the longest path from a start step. A read-only source sits in the
// column of the step it feeds, so its arrow drops straight down.
export function layoutDiagram(diagram) {
  const nodes = new Map(diagram.nodes.map((node) => [node.id, { ...node, col: 0 }]));
  const indegree = new Map(diagram.nodes.map((node) => [node.id, 0]));
  for (const edge of diagram.edges) indegree.set(edge.to, indegree.get(edge.to) + 1);
  const queue = diagram.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  while (queue.length) {
    const id = queue.shift();
    for (const edge of diagram.edges.filter((item) => item.from === id)) {
      const from = nodes.get(id);
      const to = nodes.get(edge.to);
      if (from.kind !== "source") to.col = Math.max(to.col, from.col + 1);
      indegree.set(edge.to, indegree.get(edge.to) - 1);
      if (indegree.get(edge.to) === 0) queue.push(edge.to);
    }
  }
  for (const node of nodes.values()) {
    if (node.kind !== "source") continue;
    const feeds = diagram.edges.find((edge) => edge.from === node.id);
    if (feeds) node.col = nodes.get(feeds.to).col;
  }
  // Two steps cannot share a cell; the later one moves right.
  const taken = new Set();
  for (const node of [...nodes.values()].sort((left, right) => left.col - right.col)) {
    while (taken.has(`${node.lane}:${node.col}`)) node.col += 1;
    taken.add(`${node.lane}:${node.col}`);
  }
  return { nodes, columns: Math.max(...[...nodes.values()].map((node) => node.col)) + 1 };
}

function drawDiagram(canvas, diagram, options) {
  canvas.replaceChildren();
  const { nodes, columns } = layoutDiagram(diagram);
  const shownW = canvas.clientWidth;
  const shownH = canvas.clientHeight;
  if (!shownW || !shownH) return null;
  // Below the design width the drawing scales down instead of overlapping.
  const width = Math.max(shownW, 120 * columns + 110);
  const scale = shownW / width;
  const height = shownH / scale;
  const lanes = diagram.lanes;
  const labelW = 96;
  const top = 4;
  const laneH = (height - top - 2) / lanes.length;
  const compact = laneH < 46;
  const colW = (width - labelW - 6) / columns;
  const nodeW = Math.min(170, colW - 24);
  const nodeH = Math.max(20, Math.min(46, laneH - (compact ? 8 : 16)));
  const laneIndex = new Map(lanes.map((lane, index) => [lane.id, index]));
  const laneTop = (index) => top + laneH * index;
  const placed = new Map();
  for (const node of nodes.values()) {
    const lane = laneIndex.get(node.lane);
    placed.set(node.id, { ...node, lane, cx: labelW + colW * (node.col + 0.5), cy: top + laneH * (lane + 0.5) });
  }
  const trace = options.trace;
  const traced = (id, kind) => !trace ? "" : trace.current[kind].has(id) ? " is-current" : trace.visited[kind].has(id) ? " is-visited" : "";
  const key = `gs${Math.random().toString(36).slice(2, 8)}`;
  const marker = (id, className) => s("marker", { id: `${key}-${id}`, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "9", markerHeight: "9", markerUnits: "userSpaceOnUse", orient: "auto" }, s("path", { d: "M0,0 L10,5 L0,10 z", class: className }));
  const svg = s("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `Flow diagram with ${diagram.nodes.length} steps across ${lanes.length} lanes`, class: trace ? "is-tracing" : "" },
    s("defs", {}, marker("arrow", "gs-arrow"), marker("bad", "gs-arrow is-bad"), marker("lit", "gs-arrow is-lit")));
  lanes.forEach((lane, index) => {
    svg.append(
      s("rect", { class: `gs-lane${index % 2 ? " is-odd" : ""}`, x: 0, y: laneTop(index), width, height: laneH }),
      s("text", { class: "gs-lane-label", x: 12, y: laneTop(index) + laneH / 2 + 3.5, text: fit(lane.label, 12) }));
    if (index) svg.append(s("line", { class: "gs-lane-line", x1: 0, x2: width, y1: laneTop(index), y2: laneTop(index) }));
  });
  // Orthogonal routes: straight, one elbow in the gap after the source column, or a bus
  // along the target lane's edge when another step sits in the way.
  const route = (edge) => {
    const a = placed.get(edge.from);
    const b = placed.get(edge.to);
    const aRight = a.cx + nodeW / 2;
    const bLeft = b.cx - nodeW / 2;
    if (a.col === b.col) {
      const down = b.lane > a.lane;
      const y1 = down ? a.cy + nodeH / 2 : a.cy - nodeH / 2;
      const y2 = down ? b.cy - nodeH / 2 : b.cy + nodeH / 2;
      return { d: `M${a.cx},${y1} V${y2}`, x: a.cx, y: (y1 + y2) / 2 };
    }
    const blocked = [...placed.values()].some((node) => node.lane === b.lane && node.col > Math.min(a.col, b.col) && node.col < Math.max(a.col, b.col));
    if (!blocked && a.lane === b.lane) return { d: `M${aRight},${a.cy} H${bLeft}`, x: (aRight + bLeft) / 2, y: a.cy };
    if (!blocked) {
      const x = labelW + colW * (a.col + 1);
      return { d: `M${aRight},${a.cy} H${x} V${b.cy} H${bLeft}`, x, y: laneTop(b.lane > a.lane ? a.lane + 1 : a.lane) };
    }
    const up = b.lane <= a.lane;
    const busY = up ? laneTop(b.lane) + 4 : laneTop(b.lane + 1) - 4;
    const y1 = up ? a.cy - nodeH / 2 : a.cy + nodeH / 2;
    const y2 = up ? b.cy - nodeH / 2 : b.cy + nodeH / 2;
    return { d: `M${a.cx},${y1} V${busY} H${b.cx} V${y2}`, x: a.cx + colW / 2, y: busY };
  };
  const labels = [];
  for (const edge of diagram.edges) {
    const path = route(edge);
    const state = traced(edgeId(edge), "edges");
    const head = state ? "lit" : edge.style === "bad" ? "bad" : "arrow";
    svg.append(s("path", { class: `gs-edge${edge.style === "dashed" ? " is-dashed" : ""}${edge.style === "bad" ? " is-bad" : ""}${state}`, d: path.d, "marker-end": `url(#${key}-${head})` }));
    if (edge.label && !compact) {
      const textW = edge.label.length * 6.3 + 12;
      labels.push(s("g", { class: `gs-edge-label${edge.style === "bad" ? " is-bad" : ""}${state}` },
        s("rect", { x: path.x - textW / 2, y: path.y - 8, width: textW, height: 16, rx: 8 }),
        s("text", { x: path.x, y: path.y + 3.5, "text-anchor": "middle", text: edge.label })));
    }
  }
  svg.append(...labels);
  const labelChars = Math.floor((nodeW - 20) / (compact ? 6.4 : 7));
  for (const node of placed.values()) {
    const x = node.cx - nodeW / 2;
    const y = node.cy - nodeH / 2;
    const showSub = node.sub && nodeH >= 34;
    svg.append(s("g", {
      class: `gs-node k-${node.kind}${traced(node.id, "nodes")}${options.openId === node.id ? " is-open" : ""}`,
      tabindex: "0", role: "button", "data-node": node.id, "aria-label": `${node.label}, ${lanes[node.lane].label}. ${node.text}`,
      onclick: () => options.onPick?.(node.id),
      onkeydown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); options.onPick?.(node.id); } },
    },
      s("title", { text: node.label }),
      s("rect", { class: "box", x, y, width: nodeW, height: nodeH, rx: 8 }),
      s("rect", { class: "bar", x: x + 4, y: y + 5, width: 3, height: nodeH - 10, rx: 1.5 }),
      s("text", { class: "t", x: x + 14, y: showSub ? node.cy - 2 : node.cy + 4, text: fit(node.label, labelChars), style: compact ? "font-size:11px" : null }),
      showSub ? s("text", { class: "s", x: x + 14, y: node.cy + 12, text: fit(node.sub, Math.floor((nodeW - 20) / 6.1)) }) : null));
  }
  canvas.append(svg);
  return { position: (id) => { const node = placed.get(id); return { x: node.cx * scale, y: node.cy * scale, w: nodeW * scale, h: nodeH * scale }; } };
}

export function diagramLegend(diagram) {
  const used = Object.keys(KIND_LABEL).filter((kind) => diagram.nodes.some((node) => node.kind === kind));
  return h("div", { class: "gs-legend", "aria-hidden": "true" },
    used.map((kind) => h("span", { class: kind === "source" ? "is-dashed" : "", style: `color:${KIND_COLOR[kind]}` }, h("i"), h("span", {}, KIND_LABEL[kind]))));
}

/**
 * Draws the diagram into `canvas` (inside `wrap`). Clicking a step opens a card with what it
 * does and its changed files; `fileLine(path)` renders each file row.
 */
export function mountStoryDiagram(wrap, canvas, diagram, { trace = null, fileLine } = {}) {
  let openId = null;
  const draw = () => {
    const placed = drawDiagram(canvas, diagram, { trace, openId, onPick: (id) => { openId = openId === id ? null : id; draw(); } });
    wrap.querySelector(".gs-pop")?.remove();
    if (!openId || !placed) return;
    const node = diagram.nodes.find((item) => item.id === openId);
    const lane = diagram.lanes.find((item) => item.id === node.lane);
    const close = () => { openId = null; draw(); canvas.querySelector(`[data-node="${CSS.escape(node.id)}"]`)?.focus(); };
    const pop = h("div", { class: "gs-pop", role: "dialog", "aria-label": node.label, "data-testid": "git-story-step-card" },
      h("header", {},
        h("div", {}, h("p", { class: "gs-label", style: `color:${KIND_COLOR[node.kind]}` }, `${lane.label} · ${KIND_LABEL[node.kind]}`), h("h5", {}, node.label)),
        h("button", { class: "ghost icon-button gs-pop-close", type: "button", "aria-label": "Close", onclick: close }, "×")),
      h("p", {}, node.text),
      node.files.length
        ? [h("p", { class: "gs-label" }, `Changed files · ${node.files.length}`), node.files.map((path) => fileLine(path))]
        : h("p", { class: "gs-muted" }, "No changed files. This step uses existing code as it is."));
    pop.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } });
    wrap.append(pop);
    // Beside the step, never over it, and clamped inside the diagram.
    const at = placed.position(openId);
    const right = at.x + at.w / 2 + 10;
    const left = right + pop.offsetWidth <= wrap.clientWidth - 8 ? right : Math.max(8, at.x - at.w / 2 - 10 - pop.offsetWidth);
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.min(Math.max(8, at.y - pop.offsetHeight / 2), Math.max(8, wrap.clientHeight - pop.offsetHeight - 8))}px`;
    pop.querySelector(".gs-pop-close").focus();
  };
  draw();
}
