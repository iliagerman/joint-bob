import { fuzzyMatch } from "./fuzzy.js";

/**
 * The cluster list and the node strip. The list shows each cluster with its members' faces
 * and what this node shares into it and gets from it; typing in the search box narrows it to
 * clusters whose name, or one of whose nodes, fuzzily matches. The strip draws the selected
 * cluster's nodes in a row: this node first and filled in, the manager with a star, and a
 * dashed line to each twin.
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

export function renderClusterList(container, clusters, { projects, localNodeId, twinNodeIds, selectedClusterId, matches, onSelect }) {
  container.replaceChildren();
  if (!clusters.length) {
    const empty = text("p", "You are not in a cluster yet. Create one, or join one with a link from another node.", "cluster-list-empty");
    empty.dataset.testid = "cluster-list-empty";
    container.append(empty);
    return;
  }
  const visible = clusters.filter((cluster) => matches.has(cluster.id))
    .sort((left, right) => matches.get(right.id).score - matches.get(left.id).score || left.name.localeCompare(right.name));
  if (!visible.length) {
    const empty = text("p", "No cluster or node matches.", "cluster-list-empty");
    empty.dataset.testid = "cluster-list-no-match";
    container.append(empty);
    return;
  }
  for (const cluster of visible) {
    const item = document.createElement("button");
    item.type = "button"; item.className = "cluster-item"; item.role = "listitem";
    item.dataset.testid = "cluster-item"; item.dataset.clusterId = cluster.id;
    item.setAttribute("aria-pressed", String(cluster.id === selectedClusterId));
    const counts = clusterProjectCounts(cluster, projects);
    const top = document.createElement("span"); top.className = "cluster-item-top";
    top.append(text("strong", cluster.name), text("span", `${cluster.members.length} node${cluster.members.length === 1 ? "" : "s"}`));
    const faces = document.createElement("span"); faces.className = "cluster-faces";
    for (const member of [...cluster.members].sort((left, right) => left.joinSequence - right.joinSequence)) {
      const avatar = nodeAvatar(member, { local: member.nodeId === localNodeId, twin: twinNodeIds.includes(member.nodeId), small: true });
      if (matches.get(cluster.id).nodes.includes(member.nodeId)) avatar.dataset.match = "true";
      faces.append(avatar);
    }
    const matched = matches.get(cluster.id).nodes.map((nodeId) => cluster.members.find((member) => member.nodeId === nodeId)?.name).filter(Boolean);
    const summary = text("span", `↑ you share ${counts.shared} · ↓ you get ${counts.received}${matched.length ? ` · matches ${matched.join(", ")}` : ""}`, "cluster-item-counts");
    summary.dataset.testid = "cluster-item-counts";
    item.append(top, faces, summary);
    item.setAttribute("aria-label", `${cluster.name}, ${cluster.members.length} nodes, you share ${counts.shared}, you get ${counts.received}`);
    item.addEventListener("click", () => onSelect(cluster.id));
    container.append(item);
  }
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
