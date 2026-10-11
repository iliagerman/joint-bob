import { api } from "./api.js";
import { loadClusterDirectory } from "./cluster-filters.js";
import { MAP_PAGE_SIZE, clusterProjectCounts, nodeAvatar, renderClusterMap, renderNodeStrip, searchClusters, visibleClusters } from "./cluster-canvas.js";
import { renderClusterSharing } from "./cluster-sharing.js";
import { activeTwin, badge, declareLost, memberTwinControls, refreshTwinInventory, refreshTwins, renderTwinLink, renderTwinRequests, renderTwinSection, syncLabel, twinName, twinNodeIds, twinSyncProblem, twins, unpair } from "./cluster-twins.js";
import { elements } from "./elements.js";
import { refreshProjectsQuietly } from "./project-selection.js";
import { displayNodeUrl } from "./relay-ui.js";
import { confirmAction, toast } from "./shell.js";

/**
 * Settings > Cluster: a map with this node in the middle, its twins above it and a page of
 * clusters around it, and an inspector beside it (below it on narrow screens) for whatever is
 * selected on the map. A cluster shows its nodes, what this node gets from it, what it shares
 * with it, and its invitation link; a node shows the clusters it is in and its twin actions;
 * this machine shows its name and URL, its twins and the browser machine defaults.
 */

const panel = document.getElementById("settingsPanel-cluster");
const content = document.getElementById("clusterContent");
const loading = document.getElementById("clusterLoading");
const loadMessage = document.getElementById("clusterLoadMessage");
const retry = document.getElementById("clusterRetry");
const search = document.getElementById("clusterSearchInput");
const searchStatus = document.getElementById("clusterSearchStatus");
const requestsBanner = document.getElementById("clusterTwinRequests");
const received = document.getElementById("clusterReceived");
const membersPanel = document.getElementById("clusterMembersPanel");
const createForm = document.getElementById("clusterCreateForm");
const newButton = document.getElementById("clusterNewButton");
const joinForm = document.getElementById("clusterJoinDetails");
const joinReveal = document.getElementById("clusterJoinReveal");
const twinLink = document.getElementById("clusterTwinLink");
const mapPager = document.getElementById("clusterMapPager");
const mapPageLabel = document.getElementById("clusterMapPage");
const detailPane = document.getElementById("clusterDetailPane");
const nodeView = document.getElementById("clusterNodeView");
const machineView = document.getElementById("clusterMachineView");
const machineHead = document.getElementById("clusterMachineHead");
const clusterTabs = document.getElementById("clusterTabs");
const machineTabs = document.getElementById("clusterMachineTabs");

let data = { clusters: [], projects: [], localNodeId: null, localNode: { name: "", url: "" } };
let selectedClusterId = null;
/** What the inspector shows: `{ kind: "cluster" }`, `{ kind: "machine" }` or `{ kind: "node", id }`. */
let view = { kind: "cluster" };
let clusterTab = "nodes";
let machineTab = "machine";
let mapPage = 0;
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
  if (nodeId === data.localNodeId) return data.localNode.name || nodeId;
  return twinName(nodeId, data.clusters);
}
function nodeUrl(nodeId) {
  for (const cluster of data.clusters) {
    const member = cluster.members.find((candidate) => candidate.nodeId === nodeId);
    if (member?.url) return member.url;
  }
  return twins.inventory?.remote.find((item) => item.peerId === nodeId)?.url || "";
}
function reachability(nodeId) {
  const reach = twins.inventory?.remote.find((item) => item.peerId === nodeId);
  return !reach ? "checking" : reach.reachable ? "online" : "offline";
}

function clearGeneratedLink() {
  invitationRequestId += 1;
  elements.clusterInviteLink.value = "";
  elements.copyClusterInviteButton.disabled = true;
}

/** Another cluster's invitation must not stay on screen, so a switch also leaves the Invite tab. */
function forgetInvitation() {
  clearGeneratedLink();
  if (clusterTab === "invite") clusterTab = "nodes";
}

function showForm(form, trigger, show) {
  form.hidden = !show;
  trigger.setAttribute("aria-expanded", String(show));
  if (show) form.querySelector("input").focus();
}

function selectTab(tabs, attribute, value) {
  for (const tab of tabs.querySelectorAll(`[${attribute}]`)) tab.setAttribute("aria-selected", String(tab.getAttribute(attribute) === value));
}
function showClusterTab(name) {
  clusterTab = name;
  selectTab(clusterTabs, "data-cluster-tab", name);
  for (const section of detailPane.querySelectorAll("[data-cluster-panel]")) section.hidden = section.dataset.clusterPanel !== name;
}
function showMachineTab(name) {
  machineTab = name;
  selectTab(machineTabs, "data-machine-tab", name);
  for (const section of machineView.querySelectorAll("[data-machine-panel]")) section.hidden = section.dataset.machinePanel !== name;
}
function setTabCount(tabs, attribute, name, value) {
  tabs.querySelector(`[${attribute}="${name}"] .cluster-tab-count`).textContent = value === null ? "" : String(value);
}

// ---- rendering ----

function twinMapNodes() {
  return twins.relationships.filter((item) => item.status === "active").map((relationship) => {
    const nodeId = relationship.peer.nodeId, state = reachability(nodeId);
    const caption = state === "offline" ? "Twin · not connected" : `Twin · ${syncLabel(twins.status.get(relationship.relationshipId)).toLowerCase()}`;
    return { nodeId, name: nodeName(nodeId), caption, state };
  });
}

/** Keeps keyboard focus on the same map node across a redraw. */
function focusedMapNode() {
  const active = document.activeElement;
  if (!active || !elements.clusterCanvas.contains(active)) return null;
  return active.dataset.clusterId ? `[data-cluster-id="${active.dataset.clusterId}"]` : active.dataset.nodeId ? `[data-node-id="${active.dataset.nodeId}"]` : null;
}

/** On a narrow screen the inspector sits below the map, so a choice on the map scrolls to it. */
function fromMap(select) {
  return (id) => {
    select(id);
    const layout = document.getElementById("fieldsetClusters");
    if (getComputedStyle(layout).gridTemplateColumns.split(" ").length > 1) return;
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById("clusterInspector").scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
  };
}

function renderMap(found) {
  const query = search.value.trim();
  const pages = Math.max(1, Math.ceil(visibleClusters(data.clusters, found).length / MAP_PAGE_SIZE));
  mapPage = Math.min(mapPage, pages - 1);
  const refocus = focusedMapNode();
  const selected = view.kind === "cluster" ? { kind: "cluster", id: selectedClusterId } : view;
  renderClusterMap(elements.clusterCanvas, data.clusters, {
    projects: data.projects, local: { nodeId: data.localNodeId, name: data.localNode.name || "This machine" }, twins: twinMapNodes(),
    selected, matches: found, page: mapPage, query,
    onSelectCluster: fromMap(selectCluster), onSelectNode: fromMap(selectNode), onSelectMachine: fromMap(selectMachine),
  });
  if (refocus) elements.clusterCanvas.querySelector(refocus)?.focus();
  mapPager.hidden = pages <= 1;
  mapPageLabel.textContent = `${mapPage + 1} of ${pages}`;
  mapPager.querySelector('[data-page-step="-1"]').disabled = mapPage === 0;
  mapPager.querySelector('[data-page-step="1"]').disabled = mapPage >= pages - 1;
  if (!query) { searchStatus.textContent = ""; return; }
  const nodes = new Set([...found.values()].flatMap((match) => match.nodes)).size;
  searchStatus.textContent = found.size
    ? `${found.size} cluster${found.size === 1 ? "" : "s"} · ${nodes} node${nodes === 1 ? "" : "s"} match “${query}”`
    : `Nothing matches “${query}”`;
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
  const open = text("button", member.name || member.nodeId, "cluster-member-open");
  open.type = "button"; open.dataset.testid = `cluster-member-open-${member.nodeId}`;
  open.addEventListener("click", () => (local ? selectMachine() : selectNode(member.nodeId)));
  const name = document.createElement("strong"); name.append(open, badges);
  who.append(name, text("small", displayNodeUrl(member.url) || member.nodeId));
  row.append(nodeAvatar(member, { local, manager, twin: twinNodeIds().includes(member.nodeId) }), who, actions);
  const relationship = activeTwin(member.nodeId);
  if (relationship) row.append(twinSyncProblem(twins.status.get(relationship.relationshipId), onChange));
  return row;
}

function renderReceived(cluster) {
  const got = data.projects.filter((project) => project.clusterIds?.includes(cluster.id) && project.locallyOwned === false);
  const heading = document.createElement("h4"); heading.className = "cluster-section-title";
  heading.append(text("span", `You get from ${cluster.name}`), text("span", String(got.length)));
  heading.dataset.testid = "cluster-received-summary";
  received.replaceChildren(heading);
  if (!got.length) {
    received.append(text("p", `No projects shared with you in ${cluster.name}.`, "cluster-muted"));
    void renderReceivedSecrets(cluster.id);
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
  void renderReceivedSecrets(cluster.id);
}
async function renderReceivedSecrets(clusterId) {
  try {
    const { received: secrets } = await api(`/api/clusters/${clusterId}/secrets`);
    if (selectedClusterId !== clusterId || !secrets.length) return;
    const section = document.createElement("div"); section.className = "cluster-owner-group";
    section.append(text("p", `Secrets shared with me · ${secrets.length}`));
    const chips = document.createElement("ul"); chips.className = "cluster-chips";
    for (const secret of secrets) chips.append(text("li", `${secret.label} · from ${nodeName(secret.ownerNodeId)} · read-only`, "cluster-chip"));
    section.append(chips); received.append(section);
  } catch { /* Secret inventory can be unavailable while the cluster reconnects. */ }
}

function headerActions(cluster) {
  const actions = document.createElement("div"); actions.className = "cluster-detail-actions";
  const inviteButton = text("button", "Invite a node", "ghost compact"); inviteButton.type = "button";
  inviteButton.dataset.testid = "cluster-invite-reveal"; inviteButton.setAttribute("aria-controls", "clusterInviteDetails");
  inviteButton.addEventListener("click", () => { showClusterTab("invite"); elements.clusterGenerateInviteButton.focus(); });
  const leave = text("button", cluster.members.length === 1 ? "Close cluster" : "Leave", "ghost compact danger"); leave.type = "button";
  leave.dataset.testid = "cluster-leave-button"; leave.id = "clusterLeaveButton";
  if (cluster.managerNodeId === data.localNodeId && cluster.members.length > 1) {
    leave.disabled = true; leave.title = "You manage this cluster. Hand management to another member before leaving.";
  }
  leave.addEventListener("click", () => leaveCluster().catch((error) => toast(error.message)));
  actions.append(inviteButton, leave);
  if (cluster.originalNodeId === data.localNodeId && cluster.members.length > 1) {
    const close = text("button", "Delete cluster", "ghost compact danger"); close.type = "button";
    close.dataset.testid = "cluster-delete-button";
    close.addEventListener("click", () => closeCluster().catch((error) => toast(error.message)));
    actions.append(close);
  }
  return actions;
}

/** The selected cluster. `sharing` also rebuilds the share selection, which a twin refresh must not reset. */
function renderDetail(cluster, { sharing, found }) {
  const counts = clusterProjectCounts(cluster, data.projects);
  const manager = cluster.members.find((member) => member.nodeId === cluster.managerNodeId);
  const head = document.createElement("header"); head.className = "cluster-detail-head";
  const title = document.createElement("div");
  title.append(text("h3", cluster.name), text("p", `${cluster.members.length} node${cluster.members.length === 1 ? "" : "s"} · managed by ${manager?.nodeId === data.localNodeId ? "you" : manager?.name || "an unknown node"} · you share ${counts.shared}, you get ${counts.received}`, "cluster-muted"));
  head.append(title, headerActions(cluster));
  elements.clusterDetails.replaceChildren(head, renderNodeStrip(cluster, { localNodeId: data.localNodeId, twinNodeIds: twinNodeIds() }));
  const nodesTitle = document.createElement("h4"); nodesTitle.className = "cluster-section-title";
  nodesTitle.append(text("span", "Nodes"), text("span", "oldest first"));
  const nodes = document.createElement("div"); nodes.className = "cluster-members"; nodes.dataset.testid = "cluster-members";
  const matched = found.get(cluster.id)?.nodes || [];
  for (const member of [...cluster.members].sort((left, right) => left.joinSequence - right.joinSequence)) {
    nodes.append(memberRow(cluster, member, matched.includes(member.nodeId), onTwinChange));
  }
  membersPanel.replaceChildren(nodesTitle, nodes);
  setTabCount(clusterTabs, "data-cluster-tab", "nodes", cluster.members.length);
  setTabCount(clusterTabs, "data-cluster-tab", "received", counts.received);
  setTabCount(clusterTabs, "data-cluster-tab", "sharing", counts.shared);
  renderReceived(cluster);
  if (sharing) void renderClusterSharing(cluster, { localNodeId: data.localNodeId, onSaved: afterMembershipChange });
  showClusterTab(clusterTab);
}

/** A node from the map or a member list: the clusters it is in and what you can do with it as a twin. */
function renderNodeView(nodeId) {
  const name = nodeName(nodeId), relationship = activeTwin(nodeId);
  const shared = data.clusters.filter((cluster) => cluster.members.some((member) => member.nodeId === nodeId));
  const back = text("button", "← Back", "ghost compact cluster-node-back"); back.type = "button"; back.dataset.testid = "cluster-node-back";
  back.addEventListener("click", () => (selectedCluster() ? selectCluster(selectedClusterId) : selectMachine()));
  const head = document.createElement("header"); head.className = "cluster-machine-head";
  const avatar = nodeAvatar({ nodeId, name }, { twin: Boolean(relationship) }); avatar.dataset.large = "true";
  const identity = document.createElement("div"); identity.className = "cluster-member-who";
  const title = text("h3", name);
  const state = reachability(nodeId);
  identity.append(title, text("small", displayNodeUrl(nodeUrl(nodeId)) || nodeId));
  if (relationship) {
    const status = twins.status.get(relationship.relationshipId);
    const badges = document.createElement("span"); badges.className = "cluster-badges";
    badges.append(badge("Twin", "twin"), badge(syncLabel(status), syncLabel(status) === "Error" ? "error" : syncLabel(status) === "Up to date" ? "ok" : ""));
    identity.append(badges, text("p", `${state === "offline" ? "Not connected" : state === "online" ? "Connected" : "Checking…"} · ${status?.projectCount ?? 0} twin-shared projects`, "cluster-muted"));
  }
  head.append(avatar, identity);
  const clustersTitle = document.createElement("h4"); clustersTitle.className = "cluster-section-title";
  clustersTitle.append(text("span", "Clusters with this node"), text("span", String(shared.length)));
  const list = document.createElement("div"); list.className = "cluster-node-clusters";
  for (const cluster of shared) {
    const open = document.createElement("button"); open.type = "button"; open.className = "cluster-node-cluster";
    open.dataset.testid = "cluster-node-cluster";
    open.append(text("strong", cluster.name), text("span", `${cluster.managerNodeId === nodeId ? "Manager" : "Member"} · ${cluster.members.length} node${cluster.members.length === 1 ? "" : "s"}`));
    open.addEventListener("click", () => selectCluster(cluster.id));
    list.append(open);
  }
  if (!shared.length) list.append(text("p", "Not in any of your clusters. Twins paired by link share everything without a cluster.", "cluster-muted"));
  const actions = document.createElement("div"); actions.className = "cluster-node-actions";
  if (relationship) {
    for (const [label, testid, className, action] of [["Unpair", "cluster-node-unpair", "ghost compact", unpair], ["Machine lost…", "cluster-node-lost", "ghost compact danger", declareLost]]) {
      const control = text("button", label, className); control.type = "button"; control.dataset.testid = testid;
      control.addEventListener("click", async () => {
        control.disabled = true;
        try { await action(relationship, name, onTwinChange); } catch (error) { toast(error.message); } finally { control.disabled = false; }
      });
      actions.append(control);
    }
  } else if (shared.length) {
    const member = shared[0].members.find((candidate) => candidate.nodeId === nodeId);
    const controls = memberTwinControls(shared[0], member, onTwinChange).actions;
    // The member list keeps its own copies of these controls; these get distinct test ids.
    for (const control of controls.querySelectorAll("[data-testid]")) control.dataset.testid = `cluster-node-${control.dataset.testid}`;
    actions.append(...controls.childNodes);
  }
  const twinTitle = document.createElement("h4"); twinTitle.className = "cluster-section-title";
  twinTitle.append(text("span", "Twin"));
  const twinNote = text("p", relationship ? "Twins copy everything they own to each other." : "Twins copy everything they own to each other, including credentials. Pair only machines you own.", "cluster-muted");
  nodeView.replaceChildren(back, head, twinSyncProblem(relationship && twins.status.get(relationship.relationshipId), onTwinChange), clustersTitle, list, twinTitle, twinNote, actions);
}

function renderMachineHead() {
  const avatar = nodeAvatar({ nodeId: data.localNodeId, name: data.localNode.name }, { local: true }); avatar.dataset.large = "true";
  const identity = document.createElement("div"); identity.className = "cluster-member-who";
  identity.append(text("h3", data.localNode.name || "This machine"), text("small", displayNodeUrl(data.localNode.url) || data.localNodeId || ""), badge("This machine", "you"));
  machineHead.replaceChildren(avatar, identity);
  setTabCount(machineTabs, "data-machine-tab", "twins", twinNodeIds().length);
}

function renderInspector({ sharing, found }) {
  if (view.kind === "node" && view.id !== data.localNodeId && !activeTwin(view.id) && !data.clusters.some((cluster) => cluster.members.some((member) => member.nodeId === view.id))) view = { kind: "cluster" };
  const cluster = selectedCluster();
  if (view.kind === "cluster" && !cluster) view = { kind: "machine" };
  detailPane.hidden = view.kind !== "cluster";
  nodeView.hidden = view.kind !== "node";
  machineView.hidden = view.kind !== "machine";
  if (cluster) renderDetail(cluster, { sharing, found });
  else { clearGeneratedLink(); void renderClusterSharing(null, {}); }
  if (view.kind === "node") renderNodeView(view.id);
  renderMachineHead();
  showMachineTab(machineTab);
}

function renderTwinParts() {
  renderTwinRequests(requestsBanner, data.clusters, onTwinChange);
  renderTwinSection(elements.clusterNodes, data.clusters, onTwinChange);
  renderTwinLink(twinLink, onTwinChange);
}

function render({ sharing = true } = {}) {
  const found = searchClusters(data.clusters, search.value.trim());
  renderInspector({ sharing, found });
  renderMap(found);
  renderTwinParts();
}

/** Opens the page of the map that holds `clusterId`. */
function showOnMap(clusterId) {
  const index = visibleClusters(data.clusters, searchClusters(data.clusters, search.value.trim())).findIndex((cluster) => cluster.id === clusterId);
  if (index >= 0) mapPage = Math.floor(index / MAP_PAGE_SIZE);
}

function selectCluster(clusterId) {
  // Choosing the open cluster again keeps its unsaved share selection.
  const changed = selectedClusterId !== clusterId;
  if (changed) forgetInvitation();
  selectedClusterId = clusterId;
  view = { kind: "cluster" };
  showOnMap(clusterId);
  render({ sharing: changed });
}
function selectNode(nodeId) {
  view = nodeId === data.localNodeId ? { kind: "machine" } : { kind: "node", id: nodeId };
  render({ sharing: false });
}
function selectMachine() {
  view = { kind: "machine" };
  render({ sharing: false });
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
    data = { clusters: clusterData.clusters, projects: projectData.projects, localNodeId: node.id, localNode: { name: node.name, url: node.url } };
    const nextClusterId = data.clusters.some((cluster) => cluster.id === preferredClusterId) ? preferredClusterId : data.clusters[0]?.id || null;
    // Another cluster's invite link must not stay on screen for the one now open.
    if (nextClusterId !== selectedClusterId) forgetInvitation();
    if (nextClusterId && (nextClusterId !== selectedClusterId || !selectedClusterId)) view = { kind: "cluster" };
    selectedClusterId = nextClusterId;
    if (selectedClusterId) showOnMap(selectedClusterId);
    if (!machineLoaded) {
      elements.clusterNodeNameInput.value = node.name;
      elements.clusterNodeUrlInput.value = node.url;
      machineLoaded = true;
    }
    render();
    content.hidden = false;
    content.inert = false;
    loading.hidden = true;
    refreshTwinInventory().then(() => { if (requestId === panelRequestId) render({ sharing: false }); })
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

async function closeCluster() {
  const cluster = selectedCluster();
  if (!await confirmAction({ eyebrow: "Delete cluster", title: `Delete ${cluster.name}?`,
    message: `All ${cluster.members.length} nodes leave this cluster. Shared resources stop syncing; local copies remain. This cannot be undone.`,
    confirmLabel: "Delete cluster", destructive: true })) return;
  if (selectedClusterId !== cluster.id) return;
  await api(`/api/clusters/${cluster.id}/close`, { method: "POST", body: JSON.stringify({ expectedEpoch: cluster.managerEpoch }) });
  selectedClusterId = null;
  await afterMembershipChange(null);
  toast("Cluster deleted");
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
  mapPage = 0;
  const found = searchClusters(data.clusters, search.value.trim());
  // Follow the search: when the open cluster no longer matches, open the best match.
  if (search.value.trim() && found.size && (!found.has(selectedClusterId) || view.kind !== "cluster")) {
    const best = [...found].sort((left, right) => right[1].score - left[1].score)[0][0];
    if (best !== selectedClusterId) forgetInvitation();
    const changed = best !== selectedClusterId;
    selectedClusterId = best; view = { kind: "cluster" };
    render({ sharing: changed });
  } else {
    render({ sharing: false });
  }
});
search.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && search.value) { event.preventDefault(); event.stopPropagation(); search.value = ""; mapPage = 0; showOnMap(selectedClusterId); render({ sharing: false }); }
});
elements.clusterJoinLinkInput.addEventListener("input", () => { if (elements.clusterJoinLinkInput.value.trim() !== pendingJoin.link) pendingJoin = { link: "", requestId: "" }; });
elements.copyClusterInviteButton.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(elements.clusterInviteLink.value); toast("One-time join link copied"); }
  catch (error) { toast(error.message || "Could not copy join link"); }
});
mapPager.addEventListener("click", (event) => {
  const step = Number(event.target.closest("[data-page-step]")?.dataset.pageStep || 0);
  if (!step) return;
  mapPage += step;
  renderMap(searchClusters(data.clusters, search.value.trim()));
});
clusterTabs.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-cluster-tab]");
  if (tab) showClusterTab(tab.dataset.clusterTab);
});
machineTabs.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-machine-tab]");
  if (tab) showMachineTab(tab.dataset.machineTab);
});
