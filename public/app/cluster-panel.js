import { api } from "./api.js";
import { loadClusterDirectory } from "./cluster-filters.js";
import { clusterProjectCounts, nodeAvatar, renderClusterList, renderNodeStrip, searchClusters } from "./cluster-canvas.js";
import { renderClusterSharing } from "./cluster-sharing.js";
import { badge, memberTwinControls, refreshTwinInventory, refreshTwins, renderTwinLink, renderTwinRequests, renderTwinSection, twinNodeIds, twins } from "./cluster-twins.js";
import { elements } from "./elements.js";
import { refreshProjectsQuietly } from "./project-selection.js";
import { confirmAction, toast } from "./shell.js";

/**
 * Settings > Cluster: the clusters this node belongs to on the left, the selected one on the
 * right. The right side draws its nodes, lists them oldest first with their twin actions, and
 * splits the projects into what this node gets from the cluster and what it shares with it.
 */

const panel = document.getElementById("settingsPanel-cluster");
const content = document.getElementById("clusterContent");
const loading = document.getElementById("clusterLoading");
const loadMessage = document.getElementById("clusterLoadMessage");
const retry = document.getElementById("clusterRetry");
const search = document.getElementById("clusterSearchInput");
const searchStatus = document.getElementById("clusterSearchStatus");
const requestsBanner = document.getElementById("clusterTwinRequests");
const columns = document.getElementById("clusterColumns");
const received = document.getElementById("clusterReceived");
const invite = document.getElementById("clusterInviteDetails");
const createForm = document.getElementById("clusterCreateForm");
const newButton = document.getElementById("clusterNewButton");
const joinForm = document.getElementById("clusterJoinDetails");
const joinReveal = document.getElementById("clusterJoinReveal");
const twinLink = document.getElementById("clusterTwinLink");

let data = { clusters: [], projects: [], localNodeId: null };
let selectedClusterId = null;
let pendingJoin = { link: "", requestId: "" };
let invitationRequestId = 0;
let panelRequestId = 0;
let pollTimer;
let twinSignature = "";
let machineLoaded = false;

function text(tag, value, className) {
  const node = document.createElement(tag); node.textContent = value;
  if (className) node.className = className;
  return node;
}
function selectedCluster() { return data.clusters.find((cluster) => cluster.id === selectedClusterId) || null; }
function nodeName(nodeId) {
  for (const cluster of data.clusters) {
    const member = cluster.members.find((candidate) => candidate.nodeId === nodeId);
    if (member?.name) return member.name;
  }
  return nodeId;
}

function clearGeneratedLink() {
  invitationRequestId += 1;
  elements.clusterInviteLink.value = "";
  elements.copyClusterInviteButton.disabled = true;
}

function showForm(form, trigger, show) {
  form.hidden = !show;
  trigger.setAttribute("aria-expanded", String(show));
  if (show) form.querySelector("input").focus();
}

// ---- rendering ----

function renderList() {
  const query = search.value.trim();
  const found = searchClusters(data.clusters, query);
  renderClusterList(elements.clusterCanvas, data.clusters, { projects: data.projects, localNodeId: data.localNodeId,
    twinNodeIds: twinNodeIds(), selectedClusterId, matches: found, onSelect: selectCluster });
  if (!query) { searchStatus.textContent = ""; return found; }
  const nodes = new Set([...found.values()].flatMap((match) => match.nodes)).size;
  searchStatus.textContent = found.size
    ? `${found.size} cluster${found.size === 1 ? "" : "s"} · ${nodes} node${nodes === 1 ? "" : "s"} match “${query}”`
    : `Nothing matches “${query}”`;
  return found;
}

function memberRow(cluster, member, matched, onChange) {
  const local = member.nodeId === data.localNodeId, manager = member.nodeId === cluster.managerNodeId;
  const row = document.createElement("div"); row.className = "cluster-member"; row.dataset.testid = "cluster-member";
  row.dataset.sharingNodeId = member.nodeId;
  if (matched) row.dataset.match = "true";
  const { badges, actions } = memberTwinControls(cluster, member, onChange);
  if (manager) badges.prepend(badge("Manager", "manager"));
  if (local) badges.prepend(badge("You", "you"));
  const who = document.createElement("div"); who.className = "cluster-member-who";
  const name = text("strong", member.name || member.nodeId); name.append(badges);
  who.append(name, text("small", member.url || member.nodeId));
  row.append(nodeAvatar(member, { local, manager, twin: twinNodeIds().includes(member.nodeId) }), who, actions);
  return row;
}

function renderReceived(cluster) {
  const got = data.projects.filter((project) => project.clusterIds?.includes(cluster.id) && project.locallyOwned === false);
  const heading = document.createElement("h4"); heading.className = "cluster-section-title";
  heading.append(text("span", `You get from ${cluster.name}`), text("span", String(got.length)));
  heading.dataset.testid = "cluster-received-summary";
  received.replaceChildren(heading);
  if (!got.length) {
    received.append(text("p", `Nothing yet. The other nodes have not shared projects with ${cluster.name}.`, "cluster-muted"));
    return;
  }
  const byOwner = new Map();
  for (const project of got) {
    if (!byOwner.has(project.ownerNodeId)) byOwner.set(project.ownerNodeId, []);
    byOwner.get(project.ownerNodeId).push(project);
  }
  const list = document.createElement("div"); list.className = "cluster-owner-groups"; list.dataset.testid = "cluster-received-list";
  for (const [ownerNodeId, projects] of byOwner) {
    const group = document.createElement("div"); group.className = "cluster-owner-group"; group.dataset.testid = "cluster-owner-group";
    const from = text("p", "from ");
    from.append(text("strong", nodeName(ownerNodeId)));
    if (twinNodeIds().includes(ownerNodeId)) from.append(document.createTextNode(" (your twin)"));
    const chips = document.createElement("ul"); chips.className = "cluster-chips";
    for (const project of projects.sort((left, right) => left.name.localeCompare(right.name))) chips.append(text("li", project.name, "cluster-chip"));
    group.append(from, chips);
    list.append(group);
  }
  received.append(list);
}

function headerActions(cluster) {
  const actions = document.createElement("div"); actions.className = "cluster-detail-actions";
  const inviteButton = text("button", "Invite a node", "ghost compact"); inviteButton.type = "button";
  inviteButton.dataset.testid = "cluster-invite-reveal"; inviteButton.setAttribute("aria-controls", invite.id);
  inviteButton.setAttribute("aria-expanded", String(!invite.hidden));
  inviteButton.addEventListener("click", () => {
    invite.hidden = !invite.hidden; inviteButton.setAttribute("aria-expanded", String(!invite.hidden));
    if (!invite.hidden) elements.clusterGenerateInviteButton.focus();
  });
  const leave = text("button", cluster.members.length === 1 ? "Close cluster" : "Leave", "ghost compact danger"); leave.type = "button";
  leave.dataset.testid = "cluster-leave-button"; leave.id = "clusterLeaveButton";
  if (cluster.managerNodeId === data.localNodeId && cluster.members.length > 1) {
    leave.disabled = true; leave.title = "You manage this cluster. Hand management to another member before leaving.";
  }
  leave.addEventListener("click", () => leaveCluster().catch((error) => toast(error.message)));
  actions.append(inviteButton, leave);
  return actions;
}

/** The right-hand side. `sharing` also rebuilds the share selection, which a twin refresh must not reset. */
function renderDetail({ sharing = true, found = searchClusters(data.clusters, search.value.trim()) } = {}) {
  const cluster = selectedCluster();
  const container = elements.clusterDetails;
  container.replaceChildren();
  columns.hidden = !cluster;
  if (!cluster) {
    invite.hidden = true;
    container.append(text("p", data.clusters.length ? "Choose a cluster." : "A cluster is a group of your nodes that can share projects with each other. Membership alone shares nothing.", "cluster-muted"));
    void renderClusterSharing(null, {});
    return;
  }
  const counts = clusterProjectCounts(cluster, data.projects);
  const manager = cluster.members.find((member) => member.nodeId === cluster.managerNodeId);
  const head = document.createElement("header"); head.className = "cluster-detail-head";
  const title = document.createElement("div");
  title.append(text("h3", cluster.name), text("p", `${cluster.members.length} node${cluster.members.length === 1 ? "" : "s"} · managed by ${manager?.nodeId === data.localNodeId ? "you" : manager?.name || "an unknown node"} · you share ${counts.shared}, you get ${counts.received}`, "cluster-muted"));
  head.append(title, headerActions(cluster));
  const nodesTitle = document.createElement("h4"); nodesTitle.className = "cluster-section-title";
  nodesTitle.append(text("span", "Nodes"), text("span", "oldest first"));
  const nodes = document.createElement("div"); nodes.className = "cluster-members"; nodes.dataset.testid = "cluster-members";
  const matched = found.get(cluster.id)?.nodes || [];
  for (const member of [...cluster.members].sort((left, right) => left.joinSequence - right.joinSequence)) {
    nodes.append(memberRow(cluster, member, matched.includes(member.nodeId), onTwinChange));
  }
  container.append(head, renderNodeStrip(cluster, { localNodeId: data.localNodeId, twinNodeIds: twinNodeIds() }), nodesTitle, nodes);
  renderReceived(cluster);
  if (sharing) void renderClusterSharing(cluster, { localNodeId: data.localNodeId, onSaved: afterMembershipChange });
}

function renderTwinParts() {
  renderTwinRequests(requestsBanner, data.clusters, onTwinChange);
  renderTwinSection(elements.clusterNodes, data.clusters, onTwinChange);
  renderTwinLink(twinLink, onTwinChange);
}

function render({ sharing = true } = {}) {
  const found = renderList();
  renderDetail({ sharing, found });
  renderTwinParts();
}

function selectCluster(clusterId) {
  // Choosing the open cluster again keeps its unsaved share selection.
  const changed = selectedClusterId !== clusterId;
  if (changed) { clearGeneratedLink(); invite.hidden = true; }
  selectedClusterId = clusterId;
  render({ sharing: changed });
}

// ---- loading ----

export async function loadClusterPanel(preferredClusterId = selectedClusterId, { background = false } = {}) {
  const requestId = ++panelRequestId;
  clearTimeout(pollTimer);
  panel.setAttribute("aria-busy", "true");
  content.hidden = !background || !data.localNodeId;
  content.inert = true;
  loading.hidden = false;
  loading.classList.add("is-loading");
  loadMessage.textContent = background ? "Refreshing clusters…" : "Loading clusters…";
  retry.hidden = true;
  try {
    const [{ node }, clusterData, projectData] = await Promise.all([
      api("/api/cluster/node"), api("/api/clusters"), api("/api/projects?syncStatus=false"),
    ]);
    if (requestId !== panelRequestId) return;
    twins.localNodeId = node.id;
    try { twinSignature = await refreshTwins(); } catch (error) { toast(`Could not load twins: ${error.message}`); }
    if (requestId !== panelRequestId) return;
    data = { clusters: clusterData.clusters, projects: projectData.projects, localNodeId: node.id };
    const nextClusterId = data.clusters.some((cluster) => cluster.id === preferredClusterId) ? preferredClusterId : data.clusters[0]?.id || null;
    // Another cluster's invite link must not stay on screen for the one now open.
    if (nextClusterId !== selectedClusterId) { clearGeneratedLink(); invite.hidden = true; }
    selectedClusterId = nextClusterId;
    if (!machineLoaded) {
      elements.clusterNodeNameInput.value = node.name;
      elements.clusterNodeUrlInput.value = node.url;
      machineLoaded = true;
    }
    render();
    content.hidden = false;
    content.inert = false;
    loading.hidden = true;
    refreshTwinInventory().then(() => { if (requestId === panelRequestId) renderTwinSection(elements.clusterNodes, data.clusters, onTwinChange); })
      .catch((error) => toast(error.message));
    schedulePoll();
  } catch (error) {
    if (requestId !== panelRequestId) return;
    loadMessage.textContent = `Could not load clusters: ${error.message}`;
    retry.hidden = false;
    throw error;
  } finally {
    if (requestId === panelRequestId) {
      panel.removeAttribute("aria-busy");
      loading.classList.remove("is-loading");
    }
  }
}

retry.addEventListener("click", () => { void loadClusterPanel().catch((error) => toast(error.message)); });

/** Twin requests and sync state change on other machines, so they are polled while Settings is open. */
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!panel.closest("dialog")?.open) return;
    if (panel.checkVisibility() && !panel.hasAttribute("aria-busy")) {
      const requestId = panelRequestId;
      try {
        const signature = await refreshTwins();
        if (requestId === panelRequestId && signature !== twinSignature) { twinSignature = signature; render({ sharing: false }); }
      } catch (error) { console.warn("Could not refresh twins", error); }
    }
    schedulePoll();
  }, 3000);
}

/** Refreshes the main project list and its cluster filters after membership or sharing changes. */
async function afterMembershipChange(clusterId = selectedClusterId) {
  await loadClusterPanel(clusterId, { background: true });
  await Promise.all([loadClusterDirectory(), refreshProjectsQuietly()]).catch((error) => console.warn("Could not refresh the project list", error));
}

async function onTwinChange({ projects = false } = {}) {
  if (projects) { await afterMembershipChange(); return; }
  twinSignature = await refreshTwins();
  render({ sharing: false });
}

// ---- actions ----

async function saveClusterNode() {
  const body = { name: elements.clusterNodeNameInput.value.trim(), url: elements.clusterNodeUrlInput.value.trim() };
  await api("/api/cluster/node", { method: "PUT", body: JSON.stringify(body) });
  machineLoaded = false;
  await loadClusterPanel(); toast("Node saved");
}

async function createCluster() {
  const name = elements.clusterCreateNameInput.value.trim();
  if (!name) throw new Error("Cluster name is required");
  const current = panelRequestId;
  const result = await api("/api/clusters", { method: "POST", body: JSON.stringify({ name }) });
  if (current !== panelRequestId) return;
  elements.clusterCreateNameInput.value = "";
  showForm(createForm, newButton, false);
  await afterMembershipChange(result.snapshot.body.clusterId); toast("Cluster created");
}

async function generateInvitation() {
  const cluster = selectedCluster();
  if (!cluster) throw new Error("Select a cluster first");
  clearGeneratedLink();
  const requestId = invitationRequestId;
  const invitation = await api(`/api/clusters/${cluster.id}/invitations`, { method: "POST", body: JSON.stringify({ expectedEpoch: cluster.managerEpoch }) });
  if (requestId !== invitationRequestId || selectedClusterId !== cluster.id) return;
  elements.clusterInviteLink.value = invitation.link; elements.copyClusterInviteButton.disabled = false;
  toast("One-time membership link generated");
}

async function joinCluster() {
  const link = elements.clusterJoinLinkInput.value.trim();
  if (!link) throw new Error("Join link is required");
  if (pendingJoin.link !== link) pendingJoin = { link, requestId: crypto.randomUUID() };
  const current = panelRequestId;
  const result = await api("/api/clusters/join", { method: "POST", body: JSON.stringify(pendingJoin) });
  if (current !== panelRequestId) return;
  pendingJoin = { link: "", requestId: "" };
  elements.clusterJoinLinkInput.value = "";
  showForm(joinForm, joinReveal, false);
  await afterMembershipChange(result.snapshot.body.clusterId); toast("Cluster membership added");
}

async function leaveCluster() {
  const cluster = selectedCluster();
  const last = cluster.members.length === 1;
  if (!await confirmAction({ eyebrow: "Leave cluster", title: last ? `Close ${cluster.name}?` : `Leave ${cluster.name}?`,
    message: last ? "You are the last member. Leaving closes this cluster." : `Projects shared through ${cluster.name} stop arriving. Your other clusters and twins are unchanged.`,
    confirmLabel: last ? "Close cluster" : "Leave cluster", destructive: true })) return;
  if (selectedClusterId !== cluster.id) return;
  await api(`/api/clusters/${cluster.id}/leave`, { method: "POST", body: JSON.stringify({ expectedEpoch: cluster.managerEpoch }) });
  selectedClusterId = null;
  await afterMembershipChange(null);
  toast(last ? "Cluster closed" : `Left ${cluster.name}`);
}

function mutation(button, action) { button.addEventListener("click", () => action().catch((error) => toast(error.message))); }
mutation(elements.clusterSaveButton, saveClusterNode); mutation(elements.clusterCreateButton, createCluster);
mutation(elements.clusterGenerateInviteButton, generateInvitation); mutation(elements.clusterJoinButton, joinCluster);

newButton.addEventListener("click", () => { showForm(joinForm, joinReveal, false); showForm(createForm, newButton, createForm.hidden); });
joinReveal.addEventListener("click", () => { showForm(createForm, newButton, false); showForm(joinForm, joinReveal, joinForm.hidden); });
document.getElementById("clusterCreateCancel").addEventListener("click", () => { elements.clusterCreateNameInput.value = ""; showForm(createForm, newButton, false); newButton.focus(); });
document.getElementById("clusterJoinCancel").addEventListener("click", () => { showForm(joinForm, joinReveal, false); joinReveal.focus(); });
for (const [form, trigger, submit] of [[createForm, newButton, elements.clusterCreateButton], [joinForm, joinReveal, elements.clusterJoinButton]]) {
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); showForm(form, trigger, false); trigger.focus(); }
    if (event.key === "Enter" && event.target.matches("input")) { event.preventDefault(); submit.click(); }
  });
}
panel.addEventListener("keydown", (event) => {
  // Enter in a Settings field would submit the whole Settings form.
  if (event.key === "Enter" && event.target.matches("input, select")) event.preventDefault();
});
search.addEventListener("input", () => {
  const found = searchClusters(data.clusters, search.value.trim());
  // Follow the search: when the open cluster no longer matches, open the best match.
  if (search.value.trim() && found.size && !found.has(selectedClusterId)) {
    selectedClusterId = [...found].sort((left, right) => right[1].score - left[1].score)[0][0];
    clearGeneratedLink(); invite.hidden = true;
    render();
  } else {
    render({ sharing: false });
  }
});
search.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && search.value) { event.preventDefault(); event.stopPropagation(); search.value = ""; render({ sharing: false }); }
});
elements.clusterJoinLinkInput.addEventListener("input", () => { if (elements.clusterJoinLinkInput.value.trim() !== pendingJoin.link) pendingJoin = { link: "", requestId: "" }; });
elements.copyClusterInviteButton.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(elements.clusterInviteLink.value); toast("One-time join link copied"); }
  catch (error) { toast(error.message || "Could not copy join link"); }
});
