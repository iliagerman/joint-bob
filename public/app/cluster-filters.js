import { api } from "./api.js";
import { createMultiSelect } from "./multi-select.js";
import { state } from "./state.js";

/**
 * Cluster filters above the project and conversation lists. A project belongs to the
 * clusters it is shared through, "local" when it is this node's own and shared nowhere,
 * and "twin" when a twin owns it. A conversation belongs to "local" when its agent runs
 * here, and to a cluster when it runs on another member of that cluster. Choosing several
 * shows everything that matches any of them.
 */

const projectFilter = createMultiSelect({ id: "projectClusterFilter", testid: "project-cluster-filter", label: "Clusters", prompt: "All clusters", placeholder: "Search clusters" });
const sessionFilter = createMultiSelect({ id: "conversationClusterFilter", testid: "conversation-cluster-filter", label: "Clusters", prompt: "All clusters", placeholder: "Search clusters" });
document.querySelector("#projectFilterRow").append(projectFilter.root);
document.querySelector("#conversationFilterRow").append(sessionFilter.root);

function changed(list) { window.dispatchEvent(new CustomEvent("cluster-filters-changed", { detail: { list } })); }
projectFilter.onChange((values) => { state.projectClusterFilters = values; changed("projects"); });
sessionFilter.onChange((values) => { state.sessionClusterFilters = values; changed("sessions"); });

function memberNames(cluster) {
  return cluster.members.filter((member) => member.nodeId !== state.localNodeId).map((member) => member.name || member.nodeId);
}

function syncOptions() {
  const clusters = [...state.clusters].sort((left, right) => left.name.localeCompare(right.name));
  projectFilter.setOptions([
    { value: "local", label: "Only on this node", detail: "Your projects not shared with any cluster" },
    ...(state.twinNodeIds.length ? [{ value: "twin", label: "From twins", detail: "Projects your twin nodes own" }] : []),
    ...clusters.map((cluster) => ({ value: cluster.id, label: cluster.name, detail: `Shared with ${memberNames(cluster).join(", ") || "no other nodes yet"}` })),
  ]);
  sessionFilter.setOptions([
    { value: "local", label: "This node", detail: "Conversations running here" },
    ...clusters.map((cluster) => ({ value: cluster.id, label: cluster.name, detail: `Running on ${memberNames(cluster).join(", ") || "no other nodes yet"}` })),
  ]);
  // The filters only mean something once this node belongs to a cluster or has a twin.
  const relevant = clusters.length > 0 || state.twinNodeIds.length > 0;
  document.querySelector("#projectFilterRow").hidden = !relevant;
  sessionFilter.root.hidden = !relevant;
}

/** Loads memberships and twins for the filters. A cluster that is gone drops out of the filters. */
export async function loadClusterDirectory() {
  const [{ node }, { clusters }, { relationships }] = await Promise.all([api("/api/cluster/node"), api("/api/clusters"), api("/api/twins")]);
  state.localNodeId = node.id;
  state.clusters = clusters;
  state.twinNodeIds = relationships.filter((relationship) => relationship.status === "active").map((relationship) => relationship.peer.nodeId);
  const known = (value) => value === "local" || (value === "twin" && state.twinNodeIds.length) || clusters.some((cluster) => cluster.id === value);
  for (const [filter, key] of [[projectFilter, "projectClusterFilters"], [sessionFilter, "sessionClusterFilters"]]) {
    const kept = new Set([...state[key]].filter(known));
    if (kept.size !== state[key].size) { state[key] = kept; filter.setValues(kept); }
  }
  syncOptions();
  changed("projects"); changed("sessions");
}

export function projectMatchesClusters(project) {
  const filters = state.projectClusterFilters;
  if (!filters.size) return true;
  const clusterIds = project.clusterIds || [];
  const owned = project.locallyOwned !== false;
  return (filters.has("local") && owned && !clusterIds.length)
    || (filters.has("twin") && state.twinNodeIds.includes(project.ownerNodeId))
    || clusterIds.some((id) => filters.has(id));
}

export function sessionMatchesClusters(session) {
  const filters = state.sessionClusterFilters;
  if (!filters.size) return true;
  const nodeId = session.executionNodeId;
  if (!nodeId || nodeId === state.localNodeId) return filters.has("local");
  return state.clusters.some((cluster) => filters.has(cluster.id) && cluster.members.some((member) => member.nodeId === nodeId));
}
