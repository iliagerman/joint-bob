import { api } from "./api.js";
import { renderClusterCanvas } from "./cluster-canvas.js";
import { elements } from "./elements.js";
import { loadProjects } from "./project-selection.js";
import { confirmAction, toast } from "./shell.js";

let selectedClusterId = null;
let panelState = null;
let pendingJoin = { link: "", requestId: "" };
let invitationRequestId = 0;

function renderLegacyInventory(inventory) {
  elements.clusterInventory.replaceChildren();
  const nodes = [{ ...inventory.local, status: "This node", state: "local" }, ...inventory.remote.map((entry) => ({
    name: entry.name || entry.inventory?.node?.name || entry.peerId,
    url: entry.url || entry.inventory?.node?.url,
    status: entry.reachable ? "Connected" : `Not connected — ${entry.error}`,
    state: entry.reachable ? "online" : "offline",
  }))];
  for (const node of nodes) {
    const row = document.createElement("div"); row.className = "cluster-node"; row.dataset.testid = "cluster-node-row"; row.dataset.state = node.state;
    const name = document.createElement("strong"); name.textContent = node.name;
    const url = document.createElement("span"); url.textContent = node.url || "";
    const status = document.createElement("span"); status.className = "cluster-node-status"; status.dataset.testid = "cluster-node-status"; status.textContent = node.status;
    row.append(name, url, status); elements.clusterInventory.append(row);
  }
}

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
  const blocked = panelState.migrationRequired;
  const controls = [elements.clusterCreateButton, elements.clusterJoinButton, elements.clusterGenerateInviteButton,
    elements.clusterAutoShareInput, elements.clusterShareAllButton, elements.clusterLeaveButton];
  for (const control of controls) control.disabled = blocked;
  if (!cluster || blocked) {
    for (const control of [elements.clusterGenerateInviteButton, elements.clusterAutoShareInput, elements.clusterShareAllButton, elements.clusterLeaveButton]) control.disabled = true;
  }
  if (!cluster) return;
  elements.clusterAutoShareInput.checked = cluster.autoShareProjects;
  const localIsManager = cluster.managerNodeId === panelState.localNodeId;
  if (localIsManager && cluster.members.length > 1) {
    elements.clusterLeaveButton.disabled = true;
    elements.clusterLeaveButton.title = "Transfer cluster membership management before leaving";
  } else elements.clusterLeaveButton.title = "";
}

function selectCluster(clusterId) {
  if (selectedClusterId !== clusterId) clearGeneratedLink();
  selectedClusterId = clusterId;
  syncControls();
}

function renderPanel(inventory, clusterData, projects) {
  const memberships = clusterData.clusters;
  if (!memberships.some((cluster) => cluster.id === selectedClusterId)) selectedClusterId = memberships[0]?.id || null;
  panelState = { ...clusterData, projects, localNodeId: inventory.local.id };
  elements.clusterMigrationMessage.hidden = !clusterData.migrationRequired;
  elements.clusterMigrationMessage.textContent = clusterData.migrationRequired ? "Migration required. Existing legacy pairing is read-only until migration is available." : "";
  elements.clusterInventory.hidden = !clusterData.migrationRequired;
  if (clusterData.migrationRequired) renderLegacyInventory(inventory);
  renderClusterCanvas({ canvas: elements.clusterCanvas, details: elements.clusterDetails, clusters: memberships,
    projects, localNodeId: inventory.local.id, selectedClusterId, onSelect: selectCluster });
  elements.secretSyncButton.disabled = clusterData.mode === "selective";
  elements.secretSyncButton.title = clusterData.mode === "selective" ? "Legacy node-wide secret sync is unavailable with selective cluster memberships" : "";
  syncControls();
}

export async function loadClusterPanel(preferredClusterId = selectedClusterId) {
  clearGeneratedLink();
  const [inventory, clusterData, projectData] = await Promise.all([
    api("/api/cluster/inventory"), api("/api/clusters"), api("/api/projects?syncStatus=false"),
  ]);
  selectedClusterId = preferredClusterId;
  elements.clusterNodeNameInput.value = inventory.local.name;
  elements.clusterNodeUrlInput.value = inventory.local.url;
  renderPanel(inventory, clusterData, projectData.projects);
  return inventory;
}

async function refreshAfterError(error) {
  toast(error.message);
  try { await loadClusterPanel(); } catch (refreshError) { toast(refreshError.message); }
}

async function saveClusterNode() {
  const body = { name: elements.clusterNodeNameInput.value.trim(), url: elements.clusterNodeUrlInput.value.trim() };
  await api("/api/cluster/node", { method: "PUT", body: JSON.stringify(body) });
  await loadClusterPanel(); toast("Node saved");
}

async function createCluster() {
  const name = elements.clusterCreateNameInput.value.trim();
  if (!name) throw new Error("Cluster name is required");
  const result = await api("/api/clusters", { method: "POST", body: JSON.stringify({ name }) });
  elements.clusterCreateNameInput.value = "";
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
  const result = await api("/api/clusters/join", { method: "POST", body: JSON.stringify(pendingJoin) });
  pendingJoin = { link: "", requestId: "" };
  await loadClusterPanel(result.snapshot.body.clusterId); toast("Cluster membership added");
}

async function setAutoShare() {
  const cluster = selectedCluster();
  if (!cluster) throw new Error("Select a cluster first");
  await api(`/api/clusters/${cluster.id}/membership`, { method: "PATCH", body: JSON.stringify({ autoShareProjects: elements.clusterAutoShareInput.checked }) });
  await loadClusterPanel(cluster.id); toast("Future project sharing updated");
}

async function shareAllProjects() {
  const cluster = selectedCluster();
  if (!cluster) throw new Error("Select a cluster first");
  if (!await confirmAction({ title: "Share existing projects?", message: `Share every existing project owned by this node with ${cluster.name}?`, confirmLabel: "Share projects" })) return;
  await api(`/api/clusters/${cluster.id}/share-all-projects`, { method: "POST", body: JSON.stringify({}) });
  await loadClusterPanel(cluster.id); toast("Existing owned projects shared");
}

async function leaveCluster() {
  const cluster = selectedCluster();
  const last = cluster.members.length === 1;
  if (!await confirmAction({ eyebrow: "Leave cluster", title: last ? "Close this cluster?" : "Leave this cluster?",
    message: last ? "You are the last member. Leaving closes this cluster." : `Leave ${cluster.name}? Other memberships are unchanged.`,
    confirmLabel: last ? "Close cluster" : "Leave cluster", destructive: true })) return;
  await api(`/api/clusters/${cluster.id}/leave`, { method: "POST", body: JSON.stringify({ expectedEpoch: cluster.managerEpoch }) });
  selectedClusterId = null; await loadClusterPanel(); await loadProjects(); toast(last ? "Cluster closed" : "Left cluster");
}

async function openSecretSyncDialog() {
  const { peers } = await api("/api/cluster/peers");
  elements.secretSyncNodeList.replaceChildren(); elements.secretSyncAllInput.checked = false;
  if (!peers.length) {
    const empty = document.createElement("p"); empty.className = "github-group-empty";
    empty.textContent = "No paired nodes yet. Add one in the Cluster tab first."; elements.secretSyncNodeList.append(empty);
  }
  for (const peer of peers) {
    const row = document.createElement("label"); row.className = "checkbox-row";
    const input = document.createElement("input"); input.type = "checkbox"; input.value = peer.id; input.dataset.testid = "secret-sync-node-input";
    input.addEventListener("change", () => { elements.secretSyncAllInput.checked = secretSyncSelectedIds().length === peers.length; });
    row.append(input, document.createTextNode(` ${peer.name}${peer.online ? "" : " (offline)"}`)); elements.secretSyncNodeList.append(row);
  }
  elements.secretSyncDialog.showModal();
}
function secretSyncSelectedIds() { return [...elements.secretSyncNodeList.querySelectorAll("input[type=checkbox]")].filter((input) => input.checked).map((input) => input.value); }
async function submitSecretSync() {
  const peerIds = secretSyncSelectedIds(); if (!peerIds.length) throw new Error("Pick at least one node");
  const { results } = await api("/api/secrets/sync", { method: "POST", body: JSON.stringify({ peerIds }) });
  const failed = results.filter((result) => result.error);
  elements.secretSyncDialog.close();
  toast(failed.length ? `Synced ${results.length - failed.length} of ${results.length} nodes; ${failed[0].name}: ${failed[0].error}` : `Synced accounts to ${results.length} ${results.length === 1 ? "node" : "nodes"}`);
}

function mutation(button, action) { button.addEventListener("click", () => action().catch(refreshAfterError)); }
mutation(elements.clusterSaveButton, saveClusterNode); mutation(elements.clusterCreateButton, createCluster);
mutation(elements.clusterGenerateInviteButton, generateInvitation); mutation(elements.clusterJoinButton, joinCluster);
mutation(elements.clusterAutoShareInput, setAutoShare); mutation(elements.clusterShareAllButton, shareAllProjects);
mutation(elements.clusterLeaveButton, leaveCluster);
elements.clusterJoinLinkInput.addEventListener("input", () => { if (elements.clusterJoinLinkInput.value.trim() !== pendingJoin.link) pendingJoin = { link: "", requestId: "" }; });
elements.secretSyncButton.addEventListener("click", () => openSecretSyncDialog().catch((error) => toast(error.message)));
elements.cancelSecretSyncButton.addEventListener("click", () => elements.secretSyncDialog.close());
elements.secretSyncAllInput.addEventListener("change", () => { for (const input of elements.secretSyncNodeList.querySelectorAll("input")) input.checked = elements.secretSyncAllInput.checked; });
elements.secretSyncForm.addEventListener("submit", (event) => { event.preventDefault(); submitSecretSync().catch((error) => toast(error.message)); });
elements.copyClusterInviteButton.addEventListener("click", async () => { try { await navigator.clipboard.writeText(elements.clusterInviteLink.value); toast("One-time join link copied"); } catch (error) { toast(error.message || "Could not copy join link"); } });
