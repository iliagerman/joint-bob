import { api } from "./api.js";
import { elements } from "./elements.js";
import { openProjectImportMapping } from "./project-forms.js";
import { loadProjects } from "./project-selection.js";
import { toast } from "./shell.js";

function clusterNodeRow({ name, url, state, status }) {
  const row = document.createElement("div");
  row.className = "cluster-node";
  row.dataset.state = state;
  row.dataset.testid = "cluster-node-row";
  const dot = document.createElement("span");
  dot.className = "cluster-node-dot";
  dot.setAttribute("aria-hidden", "true");
  const identity = document.createElement("div");
  identity.className = "cluster-node-identity";
  const title = document.createElement("strong");
  title.textContent = name;
  identity.append(title);
  if (url) {
    const address = document.createElement("span");
    address.className = "cluster-node-url";
    address.textContent = url;
    identity.append(address);
  }
  const label = document.createElement("span");
  label.className = "cluster-node-status";
  label.dataset.testid = "cluster-node-status";
  label.textContent = status;
  row.append(dot, identity, label);
  return row;
}

/**
 * One row per node, each saying whether this machine can currently reach it. An
 * unreachable peer keeps the name and address it was paired under, so the list still
 * says which machine is missing rather than showing an opaque id.
 */
function renderClusterInventory(inventory) {
  elements.clusterInventory.replaceChildren();
  const local = clusterNodeRow({ name: inventory.local.name, url: inventory.local.url, state: "local", status: "This node" });
  elements.clusterInventory.append(local);
  for (const entry of inventory.remote) {
    const name = entry.name || entry.inventory?.node?.name || entry.peerId;
    const url = entry.url || entry.inventory?.node?.url || "";
    const status = entry.reachable ? "Connected" : `Not connected — ${entry.error}`;
    const row = clusterNodeRow({ name, url, state: entry.reachable ? "online" : "offline", status });
    if (entry.reachable) {
      const importButton = document.createElement("button");
      importButton.type = "button";
      importButton.className = "ghost compact";
      importButton.textContent = "Import projects";
      importButton.dataset.testid = "cluster-import-projects-button";
      importButton.addEventListener("click", async () => {
        try {
          const result = await api("/api/cluster/projects/import", { method: "POST", body: JSON.stringify({ peerId: entry.peerId }) });
          toast(`Imported ${result.imported.length} projects${result.pending.length ? `; ${result.pending.length} need a local folder` : ""}${result.skipped.length ? `; skipped ${result.skipped.length}` : ""}`);
          await loadProjects();
          renderClusterInventory(await api("/api/cluster/inventory"));
          if (result.pending.length) {
            elements.settingsDialog.close();
            openProjectImportMapping(result.pending);
          }
        } catch (error) {
          toast(error.message);
        }
      });
      row.append(importButton);
    }
    elements.clusterInventory.append(row);
  }
}

export async function loadClusterPanel() {
  const inventory = await api("/api/cluster/inventory");
  elements.clusterNodeNameInput.value = inventory.local.name;
  elements.clusterNodeUrlInput.value = inventory.local.url;
  elements.clusterInviteLink.value = "";
  elements.copyClusterInviteButton.disabled = true;
  elements.clusterJoinLinkInput.value = "";
  renderClusterInventory(inventory);
}

function clusterNodePayload() {
  return { name: elements.clusterNodeNameInput.value.trim(), url: elements.clusterNodeUrlInput.value.trim() };
}

async function saveClusterNode() {
  await api("/api/cluster/node", { method: "PUT", body: JSON.stringify(clusterNodePayload()) });
  renderClusterInventory(await api("/api/cluster/inventory"));
  toast("Node saved");
}

async function generateClusterInvitation() {
  await api("/api/cluster/node", { method: "PUT", body: JSON.stringify(clusterNodePayload()) });
  const invitation = await api("/api/cluster/invitations", { method: "POST" });
  elements.clusterInviteLink.value = invitation.link;
  elements.copyClusterInviteButton.disabled = false;
  toast("One-time join link generated");
}

async function joinCluster() {
  const link = elements.clusterJoinLinkInput.value.trim();
  if (!link) throw new Error("Join link is required");
  await api("/api/cluster/join", {
    method: "POST",
    body: JSON.stringify({ ...clusterNodePayload(), link }),
  });
  await loadClusterPanel();
  toast("Joined cluster");
}

/** Lists paired nodes with a checkbox each so the user can push replicating accounts to some or all of them. */
async function openSecretSyncDialog() {
  const { peers } = await api("/api/cluster/peers");
  elements.secretSyncNodeList.replaceChildren();
  elements.secretSyncAllInput.checked = false;
  if (!peers.length) {
    const empty = document.createElement("p");
    empty.className = "github-group-empty";
    empty.textContent = "No paired nodes yet. Add one in the Cluster tab first.";
    elements.secretSyncNodeList.append(empty);
  }
  for (const peer of peers) {
    const row = document.createElement("label");
    row.className = "checkbox-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = peer.id;
    input.dataset.testid = "secret-sync-node-input";
    input.addEventListener("change", () => {
      elements.secretSyncAllInput.checked = secretSyncSelectedIds().length === peers.length;
    });
    row.append(input, document.createTextNode(` ${peer.name}${peer.online ? "" : " (offline)"}`));
    elements.secretSyncNodeList.append(row);
  }
  elements.secretSyncDialog.showModal();
}

function secretSyncSelectedIds() {
  return [...elements.secretSyncNodeList.querySelectorAll("input[type=checkbox]")].filter((input) => input.checked).map((input) => input.value);
}

async function submitSecretSync() {
  const peerIds = secretSyncSelectedIds();
  if (!peerIds.length) {
    toast("Pick at least one node");
    return;
  }
  const { results } = await api("/api/secrets/sync", { method: "POST", body: JSON.stringify({ peerIds }) });
  const failed = results.filter((result) => result.error);
  elements.secretSyncDialog.close();
  toast(failed.length ? `Synced ${results.length - failed.length} of ${results.length} nodes; ${failed[0].name}: ${failed[0].error}` : `Synced accounts to ${results.length} ${results.length === 1 ? "node" : "nodes"}`);
}
elements.clusterSaveButton.addEventListener("click", () => saveClusterNode().catch((error) => toast(error.message)));
elements.clusterGenerateInviteButton.addEventListener("click", () => generateClusterInvitation().catch((error) => toast(error.message)));
elements.clusterJoinButton.addEventListener("click", () => joinCluster().catch((error) => toast(error.message)));
elements.secretSyncButton.addEventListener("click", () => openSecretSyncDialog().catch((error) => toast(error.message)));
elements.cancelSecretSyncButton.addEventListener("click", () => elements.secretSyncDialog.close());
elements.secretSyncAllInput.addEventListener("change", () => {
  for (const input of elements.secretSyncNodeList.querySelectorAll("input[type=checkbox]")) input.checked = elements.secretSyncAllInput.checked;
});
elements.secretSyncForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitSecretSync().catch((error) => toast(error.message));
});
elements.copyClusterInviteButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.clusterInviteLink.value);
    toast("One-time join link copied");
  } catch (error) {
    toast(error.message || "Could not copy join link");
  }
});
