import { fuzzyMatch } from "./fuzzy.js";

/**
 * The cluster map and the node strip. The map puts this node in the middle, its twins above it
 * on dashed wires, and a page of clusters around it; each cluster shows its members' faces and
 * what this node shares into it and gets from it. Typing in the search box narrows the map to
 * clusters whose name, or one of whose nodes, fuzzily matches. On a narrow screen the same
 * buttons flow into a grid and the wires are hidden. The strip draws the selected cluster's
 * nodes in a row: this node first and filled in, the manager with a star, and a dashed line
 * to each twin.
 */

function text(tag, value, className) {
  const node = document.createElement(tag); node.textContent = value;
  if (className) node.className = className;
  return node;
}

function initials(name) {
  const words = String(name || "?").replace(/'s\b/g, "").trim().split(/[\s._-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2)).toUpperCase();
}

export function nodeAvatar(member, { local, manager, twin, small = false }) {
  const avatar = text("span", initials(member.name || member.nodeId), "cluster-avatar");
  if (local) avatar.dataset.local = "true";
  if (twin) avatar.dataset.twin = "true";
  if (small) avatar.dataset.small = "true";
  if (manager) avatar.append(text("span", "★", "cluster-avatar-manager"));
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}

export function clusterProjectCounts(cluster, projects) {
  const inCluster = projects.filter((project) => project.clusterIds?.includes(cluster.id));
  return {
    shared: inCluster.filter((project) => project.locallyOwned !== false).length,
    received: inCluster.filter((project) => project.locallyOwned === false).length,
  };
}

/** Which clusters and nodes match `query`, best cluster first. An empty query matches everything. */
export function searchClusters(clusters, query) {
  const results = new Map();
  for (const cluster of clusters) {
    const clusterScore = query ? fuzzyMatch(query, cluster.name) : 0;
    const nodes = query ? cluster.members.filter((member) => fuzzyMatch(query, member.name, member.url) !== null).map((member) => member.nodeId) : [];
    const nodeScore = Math.max(...cluster.members.map((member) => fuzzyMatch(query, member.name, member.url) ?? -Infinity));
    const score = clusterScore ?? (nodes.length ? nodeScore : null);
    if (score !== null) results.set(cluster.id, { score, nodes });
  }
  return results;
}

const SVG = "http://www.w3.org/2000/svg";
export const MAP_PAGE_SIZE = 6;

/** Points on an ellipse around the map's centre, in percent of its width and height. */
function ring(angles) {
  return angles.map((degrees) => {
    const radians = (degrees * Math.PI) / 180;
    return { x: 50 + 34 * Math.cos(radians), y: 50 + 34 * Math.sin(radians) };
  });
}
// Clusters fan out over the lower 240 degrees; the top is kept for twins.
const clusterAngles = (count) => (count === 1 ? [90] : Array.from({ length: count }, (_, index) => -30 + (index * 240) / (count - 1)));
const twinAngles = (count) => Array.from({ length: count }, (_, index) => -90 + (index - (count - 1) / 2) * 26);

function place(element, point) {
  element.style.setProperty("--x", `${point.x}%`);
  element.style.setProperty("--y", `${point.y}%`);
}

function wire(point, kind) {
  const line = document.createElementNS(SVG, "line");
  for (const [name, value] of Object.entries({ x1: 50, y1: 50, x2: point.x, y2: point.y })) line.setAttribute(name, String(value));
  line.setAttribute("vector-effect", "non-scaling-stroke");
  line.dataset.kind = kind;
  return line;
}

/** The clusters matching the search, best first, then by name. */
export function visibleClusters(clusters, matches) {
  return clusters.filter((cluster) => matches.has(cluster.id))
    .sort((left, right) => matches.get(right.id).score - matches.get(left.id).score || left.name.localeCompare(right.name));
}

function clusterButton(cluster, { projects, localNodeId, twinNodeIds, selected, matched, onSelect }) {
  const item = document.createElement("button");
  item.type = "button"; item.className = "cluster-item cluster-map-node";
  item.dataset.testid = "cluster-item"; item.dataset.clusterId = cluster.id;
  item.setAttribute("aria-pressed", String(selected));
  const counts = clusterProjectCounts(cluster, projects);
  const top = document.createElement("span"); top.className = "cluster-item-top";
  top.append(text("strong", cluster.name), text("span", `${cluster.members.length} node${cluster.members.length === 1 ? "" : "s"}`));
  const faces = document.createElement("span"); faces.className = "cluster-faces";
  for (const member of [...cluster.members].sort((left, right) => left.joinSequence - right.joinSequence)) {
    const avatar = nodeAvatar(member, { local: member.nodeId === localNodeId, manager: member.nodeId === cluster.managerNodeId, twin: twinNodeIds.includes(member.nodeId), small: true });
    if (matched.includes(member.nodeId)) avatar.dataset.match = "true";
    faces.append(avatar);
  }
  const names = matched.map((nodeId) => cluster.members.find((member) => member.nodeId === nodeId)?.name).filter(Boolean);
  const summary = text("span", `↑ you share ${counts.shared} · ↓ you get ${counts.received}${names.length ? ` · matches ${names.join(", ")}` : ""}`, "cluster-item-counts");
  summary.dataset.testid = "cluster-item-counts";
  item.append(top, faces, summary);
  item.setAttribute("aria-label", `${cluster.name}, ${cluster.members.length} nodes, you share ${counts.shared}, you get ${counts.received}`);
  item.addEventListener("click", () => onSelect(cluster.id));
  return item;
}

function nodeButton({ member, kind, caption, state, pressed, onClick }) {
  const button = document.createElement("button");
  button.type = "button"; button.className = `cluster-map-node cluster-map-${kind}`;
  button.dataset.testid = `cluster-map-${kind}`; button.dataset.nodeId = member.nodeId;
  if (state) button.dataset.state = state;
  button.setAttribute("aria-pressed", String(pressed));
  const label = document.createElement("span"); label.className = "cluster-map-label";
  label.append(text("strong", member.name || member.nodeId), text("small", caption));
  button.append(nodeAvatar(member, { local: kind === "local", twin: kind === "twin" }), label);
  button.addEventListener("click", onClick);
  return button;
}

/**
 * Draws one page of the map into `container`. `twins` are `{ nodeId, name, caption, state }`;
 * `selected` is `{ kind: "cluster" | "machine" | "node", id }`.
 */
export function renderClusterMap(container, clusters, { projects, local, twins, selected, matches, page, query, onSelectCluster, onSelectNode, onSelectMachine }) {
  container.replaceChildren();
  const wires = document.createElementNS(SVG, "svg");
  wires.setAttribute("class", "cluster-map-wires");
  wires.setAttribute("viewBox", "0 0 100 100");
  wires.setAttribute("preserveAspectRatio", "none");
  wires.setAttribute("aria-hidden", "true");
  const localButton = nodeButton({ member: local, kind: "local", caption: "This machine", pressed: selected.kind === "machine", onClick: onSelectMachine });
  place(localButton, { x: 50, y: 50 });
  const twinNodeIds = twins.map((twin) => twin.nodeId);
  const twinButtons = ring(twinAngles(twins.length)).map((point, index) => {
    const twin = twins[index];
    wires.append(wire(point, "twin"));
    const button = nodeButton({ member: twin, kind: "twin", caption: twin.caption, state: twin.state, pressed: selected.kind === "node" && selected.id === twin.nodeId, onClick: () => onSelectNode(twin.nodeId) });
    place(button, point);
    return button;
  });
  const visible = visibleClusters(clusters, matches);
  const shown = visible.slice(page * MAP_PAGE_SIZE, (page + 1) * MAP_PAGE_SIZE);
  const clusterButtons = ring(clusterAngles(shown.length)).map((point, index) => {
    const cluster = shown[index];
    const isSelected = selected.kind === "cluster" && selected.id === cluster.id;
    const line = wire(point, "cluster");
    if (isSelected) line.dataset.selected = "true";
    wires.append(line);
    const button = clusterButton(cluster, { projects, localNodeId: local.nodeId, twinNodeIds, selected: isSelected, matched: matches.get(cluster.id).nodes, onSelect: onSelectCluster });
    place(button, point);
    return button;
  });
  container.append(wires, localButton, ...twinButtons, ...clusterButtons);
  let note = null;
  if (!clusters.length) {
    note = text("p", "You are not in a cluster yet. Create one, or join one with a link from another node. Membership alone shares nothing.", "cluster-list-empty");
    note.dataset.testid = "cluster-list-empty";
  } else if (!visible.length) {
    note = text("p", `No cluster or node matches “${query}”.`, "cluster-list-empty");
    note.dataset.testid = "cluster-list-no-match";
  }
  if (note) { note.classList.add("cluster-map-note"); container.append(note); }
  container.dataset.empty = String(!shown.length);
  return { pages: Math.max(1, Math.ceil(visible.length / MAP_PAGE_SIZE)) };
}

/** The selected cluster's nodes in a row, this node first and then its twins, joined by wires. */
export function renderNodeStrip(cluster, { localNodeId, twinNodeIds }) {
  const strip = document.createElement("div"); strip.className = "cluster-strip"; strip.dataset.testid = "cluster-strip";
  strip.setAttribute("aria-hidden", "true");
  const rank = (member) => member.nodeId === localNodeId ? 0 : twinNodeIds.includes(member.nodeId) ? 1 : 2;
  const members = [...cluster.members].sort((left, right) => rank(left) - rank(right) || left.joinSequence - right.joinSequence);
  const localPresent = members.some((member) => member.nodeId === localNodeId);
  members.forEach((member, index) => {
    const twin = twinNodeIds.includes(member.nodeId);
    if (index) {
      const wire = document.createElement("span"); wire.className = "cluster-wire";
      if (twin && localPresent) wire.dataset.twin = "true";
      strip.append(wire);
    }
    const stop = document.createElement("span"); stop.className = "cluster-stop";
    const local = member.nodeId === localNodeId;
    stop.append(nodeAvatar(member, { local, manager: member.nodeId === cluster.managerNodeId, twin }),
      text("span", local ? `${member.name || member.nodeId} (you)` : member.name || member.nodeId, "cluster-stop-label"));
    strip.append(stop);
  });
  return strip;
}
