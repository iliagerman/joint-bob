import { api } from "./api.js";
import { renderClusterSharing } from "./cluster-sharing.js";
import { renderClusterCanvas } from "./cluster-canvas.js";
import { elements } from "./elements.js";
import { loadProjects } from "./project-selection.js";
import { confirmAction, toast } from "./shell.js";

let selectedClusterId = null;
let panelState = null;
let pendingJoin = { link: "", requestId: "" };
let invitationRequestId = 0;
let panelRequestId = 0;
const createForm = document.getElementById("clusterCreateForm");
const newButton = document.getElementById("clusterNewButton");
document.getElementById("settingsPanel-cluster").addEventListener("keydown", event => {
  if (event.key === "Enter" && event.target.matches("input, select")) event.preventDefault();
});
function showCreate(show) {
  createForm.hidden = !show;
  newButton.setAttribute("aria-expanded", String(show));
  if (show) elements.clusterCreateNameInput.focus();
  else newButton.focus();
}
newButton.addEventListener("click", () => showCreate(true));
createForm.addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); showCreate(false); }
  if (event.key === "Enter" && event.target === elements.clusterCreateNameInput) { event.preventDefault(); elements.clusterCreateButton.click(); }
});
document.getElementById("clusterCreateCancel").addEventListener("click", () => { elements.clusterCreateNameInput.value = ""; showCreate(false); });
document.getElementById("clusterJoinReveal").addEventListener("click", () => {
  document.getElementById("clusterJoinDetails").open = true;
  elements.clusterJoinLinkInput.focus();
});
function selectedCluster() {
  return panelState?.clusters.find((cluster) => cluster.id === selectedClusterId) || null;
}

function clearGeneratedLink() {
  invitationRequestId += 1;
  elements.clusterInviteLink.value = "";
  elements.copyClusterInviteButton.disabled = true;
}

function syncControls() {
  const cluster = selectedCluster();
  document.querySelector("#clusterInviteDetails summary").textContent = cluster ? `Invite a node to ${cluster.name}` : "Invite a node to selected cluster";
  for (const control of [elements.clusterGenerateInviteButton, elements.clusterAutoShareInput, elements.clusterShareAllButton, elements.clusterLeaveButton]) control.disabled = !cluster;
  if (!cluster) return;
  elements.clusterAutoShareInput.checked = cluster.autoShareProjects;
  const localIsManager = cluster.managerNodeId === panelState.localNodeId;
  if (localIsManager && cluster.members.length > 1) {
    elements.clusterLeaveButton.disabled = true;
    elements.clusterLeaveButton.title = "Transfer cluster membership management before leaving";
  } else elements.clusterLeaveButton.title = "";
}

function selectCluster(clusterId) {
  if (selectedClusterId !== clusterId) { clearGeneratedLink(); panelRequestId += 1; }
  selectedClusterId = clusterId;
  syncControls();
  void renderClusterSharing(selectedCluster(), panelState.localNodeId);
}

function renderPanel(localNode, clusterData, projects) {
  const memberships = clusterData.clusters;
  if (!memberships.some((cluster) => cluster.id === selectedClusterId)) selectedClusterId = memberships[0]?.id || null;
  panelState = { ...clusterData, projects, localNodeId: localNode.id };
  renderClusterCanvas({ canvas: elements.clusterCanvas, details: elements.clusterDetails, clusters: memberships,
    projects, localNodeId: localNode.id, selectedClusterId, onSelect: selectCluster });
  syncControls();
  void renderClusterSharing(selectedCluster(), panelState.localNodeId);
}

export async function loadClusterPanel(preferredClusterId = selectedClusterId) {
  const requestId = ++panelRequestId;
  const [{ node: localNode }, clusterData, projectData] = await Promise.all([
    api("/api/cluster/node"), api("/api/clusters"), api("/api/projects?syncStatus=false"),
  ]);
  const access = await Promise.all(clusterData.clusters.map(async cluster => {
    const data = await api(`/api/clusters/${cluster.id}/sharing`);
    return [cluster.id, data.projectAccess];
  }));
  const nodes = clusterData.clusters.flatMap(cluster => cluster.members);
  for (const project of projectData.projects) {
    project.ownerName = nodes.find(node => node.nodeId === project.ownerNodeId)?.name;
    project.accessByCluster = Object.fromEntries(access.map(([id, projects]) =>
      [id, projects.find(item => item.id === project.id)]));
  }
  if (requestId !== panelRequestId) return;
  if (preferredClusterId !== selectedClusterId) clearGeneratedLink();
  selectedClusterId = preferredClusterId;
  if (!panelState) {
    elements.clusterNodeNameInput.value = localNode.name;
    elements.clusterNodeUrlInput.value = localNode.url;
  }
  renderPanel(localNode, clusterData, projectData.projects);
  loadNodeStatus().catch((error) => toast(error.message));
}

// This node and its twins, with whether each twin answers right now.
async function loadNodeStatus() {
  const inventory = await api("/api/cluster/inventory");
  const nodes = [{ name: inventory.local.name, url: inventory.local.url, status: "This node", state: "local" },
    ...inventory.remote.map((twin) => ({ name: twin.name, url: twin.url,
      status: twin.reachable ? "Connected" : `Not connected — ${twin.error}`, state: twin.reachable ? "online" : "offline" }))];
  elements.clusterNodes.replaceChildren(...nodes.map((node) => {
    const row = document.createElement("div"); row.className = "cluster-node"; row.dataset.testid = "cluster-node-row"; row.dataset.state = node.state;
    const name = document.createElement("strong"); name.textContent = node.name;
    const url = document.createElement("span"); url.textContent = node.url;
    const status = document.createElement("span"); status.className = "cluster-node-status"; status.dataset.testid = "cluster-node-status"; status.textContent = node.status;
    row.append(name, url, status);
    return row;
  }));
}

function refreshAfterError(error) {
  toast(error.message);
}

async function saveClusterNode() {
  const body = { name: elements.clusterNodeNameInput.value.trim(), url: elements.clusterNodeUrlInput.value.trim() };
  await api("/api/cluster/node", { method: "PUT", body: JSON.stringify(body) });
  await loadClusterPanel(); toast("Node saved");
}

async function createCluster() {
  const name = elements.clusterCreateNameInput.value.trim();
  if (!name) throw new Error("Cluster name is required");
  const current = panelRequestId;
  const result = await api("/api/clusters", { method: "POST", body: JSON.stringify({ name }) });
  if (current !== panelRequestId) return;
  elements.clusterCreateNameInput.value = "";
  showCreate(false);
  await loadClusterPanel(result.snapshot.body.clusterId); toast("Cluster created");
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
  await loadClusterPanel(result.snapshot.body.clusterId); toast("Cluster membership added");
}

async function setAutoShare() {
  const cluster = selectedCluster();
  if (!cluster) throw new Error("Select a cluster first");
  await api(`/api/clusters/${cluster.id}/membership`, { method: "PATCH", body: JSON.stringify({ autoShareProjects: elements.clusterAutoShareInput.checked }) });
  if (selectedClusterId === cluster.id) await loadClusterPanel();
  toast("Future project sharing updated");
}

async function shareAllProjects() {
  const cluster = selectedCluster();
  if (!cluster) throw new Error("Select a cluster first");
  if (!await confirmAction({ title: "Share existing projects?", message: `Share every existing project owned by this node with ${cluster.name}?`, confirmLabel: "Share projects" })) return;
  if (selectedClusterId !== cluster.id) return;
  await api(`/api/clusters/${cluster.id}/share-all-projects`, { method: "POST", body: JSON.stringify({}) });
  if (selectedClusterId === cluster.id) await loadClusterPanel();
  toast("Existing owned projects shared");
}

async function leaveCluster() {
  const cluster = selectedCluster();
  const last = cluster.members.length === 1;
  if (!await confirmAction({ eyebrow: "Leave cluster", title: last ? "Close this cluster?" : "Leave this cluster?",
    message: last ? "You are the last member. Leaving closes this cluster." : `Leave ${cluster.name}? Other memberships are unchanged.`,
    confirmLabel: last ? "Close cluster" : "Leave cluster", destructive: true })) return;
  if (selectedClusterId !== cluster.id) return;
  await api(`/api/clusters/${cluster.id}/leave`, { method: "POST", body: JSON.stringify({ expectedEpoch: cluster.managerEpoch }) });
  if (selectedClusterId === cluster.id) { selectedClusterId = null; await loadClusterPanel(); }
  await loadProjects(); toast(last ? "Cluster closed" : "Left cluster");
}

function mutation(button, action) { button.addEventListener("click", () => action().catch(refreshAfterError)); }
mutation(elements.clusterSaveButton, saveClusterNode); mutation(elements.clusterCreateButton, createCluster);
mutation(elements.clusterGenerateInviteButton, generateInvitation); mutation(elements.clusterJoinButton, joinCluster);
mutation(elements.clusterAutoShareInput, setAutoShare); mutation(elements.clusterShareAllButton, shareAllProjects);
mutation(elements.clusterLeaveButton, leaveCluster);
elements.clusterJoinLinkInput.addEventListener("input", () => { if (elements.clusterJoinLinkInput.value.trim() !== pendingJoin.link) pendingJoin = { link: "", requestId: "" }; });
elements.copyClusterInviteButton.addEventListener("click", async () => { try { await navigator.clipboard.writeText(elements.clusterInviteLink.value); toast("One-time join link copied"); } catch (error) { toast(error.message || "Could not copy join link"); } });
