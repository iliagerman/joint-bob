import { api } from "./api.js";
import { elements } from "./elements.js";
import { openProjectImportMapping } from "./project-forms.js";
import { loadProjects } from "./project-selection.js";
import { toast } from "./shell.js";

function renderClusterInventory(inventory) {
  elements.clusterInventory.replaceChildren();
  const nodes = [
    { node: inventory.local, status: "Local" },
    ...inventory.remote.map((entry) => ({
      node: entry.inventory?.node || { name: entry.peerId },
      status: entry.reachable ? "Online" : `Offline — ${entry.error}`,
      peerId: entry.peerId,
      reachable: entry.reachable,
    })),
  ];
  for (const item of nodes) {
    const row = document.createElement("div");
    row.className = "cluster-node";
    const name = document.createElement("strong");
    name.textContent = item.node.name;
    const status = document.createElement("span");
    status.textContent = item.status;
    row.append(name, status);
    if (item.peerId && item.reachable) {
      const importButton = document.createElement("button");
      importButton.type = "button";
      importButton.className = "ghost compact";
      importButton.textContent = "Import projects";
      importButton.addEventListener("click", async () => {
        try {
          const result = await api("/api/cluster/projects/import", { method: "POST", body: JSON.stringify({ peerId: item.peerId }) });
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
