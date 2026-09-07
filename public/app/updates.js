import { api } from "./api.js";
import { elements } from "./elements.js";
import { confirmAction, toast } from "./shell.js";

let pollTimer = null;
let inventoryCache = null;

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function maybeStartPolling(status) {
  const busy = status.activeJob || status.fleet?.state === "running";
  if (!busy || pollTimer) return;
  pollTimer = setInterval(() => {
    if (!elements.settingsDialog.open || elements.settingsForm.dataset.tab !== "updates") {
      stopPolling();
      return;
    }
    // A node restarting mid-update refuses connections for a while; keep polling
    // so the panel picks up the moment the new version answers, and stop once the
    // work reaches a terminal state instead of ticking until the dialog closes.
    void refreshUpdateStatus()
      .then((latest) => {
        if (!latest.activeJob && latest.fleet?.state !== "running") stopPolling();
      })
      .catch(() => undefined);
  }, 4000);
}

function formatCheckedAt(checkedAt) {
  if (!checkedAt) return "never checked";
  return `checked ${new Date(checkedAt).toLocaleTimeString()}`;
}

function renderVersionLine(status) {
  const parts = [`Running ${status.currentVersion}`];
  if (status.release) parts.push(`commit ${status.release.slice(0, 8)}`);
  if (!status.supported) parts.push("(development checkout: manual updates only)");
  if (status.latest.release) {
    parts.push(`Latest ${status.latest.release.version}, ${formatCheckedAt(status.latest.checkedAt)}`);
  } else if (status.latest.error) {
    parts.push(`Latest unknown (${status.latest.error}), ${formatCheckedAt(status.latest.checkedAt)}`);
  } else {
    parts.push(`Latest unknown, ${formatCheckedAt(status.latest.checkedAt)}`);
  }
  elements.updatesVersionLine.textContent = parts.join(" · ");
}

function renderStateLine(status) {
  const lines = [];
  if (status.activeJob) {
    lines.push(`Updating to ${status.activeJob.targetVersion} — ${status.activeJob.state}. This page reconnects when the node restarts.`);
  }
  const failed = status.recentJobs.find((job) => job.state === "failed");
  if (failed && failed !== status.activeJob) lines.push(`Last update to ${failed.targetVersion} failed: ${failed.error ?? "unknown error"}`);
  elements.updatesStateLine.textContent = lines.join(" ");
}

function nodeRow({ name, url, version, state, detail }) {
  const row = document.createElement("div");
  row.className = "updates-node";
  const title = document.createElement("strong");
  title.className = "updates-node-name";
  title.textContent = name;
  if (url) {
    const address = document.createElement("span");
    address.className = "updates-node-url";
    address.textContent = url;
    row.append(title, address);
  } else {
    row.append(title);
  }
  const versionLabel = document.createElement("span");
  versionLabel.className = "updates-node-version";
  versionLabel.textContent = version;
  const stateLabel = document.createElement("span");
  stateLabel.className = "updates-node-state";
  stateLabel.dataset.state = state;
  stateLabel.textContent = detail;
  row.append(versionLabel, stateLabel);
  return row;
}

function fleetStateFor(fleet, nodeId) {
  if (!fleet) return null;
  return fleet.entries.find((entry) => entry.nodeId === nodeId) ?? null;
}

function versionIsBehind(version, latestVersion) {
  const current = String(version).split(".").map(Number);
  const latest = String(latestVersion).split(".").map(Number);
  if (current.length !== 3 || latest.length !== 3 || [...current, ...latest].some(Number.isNaN)) return false;
  return latest.some((part, index) => part !== current[index] && latest.slice(0, index).every((prior, priorIndex) => prior === current[priorIndex]) && part > current[index]);
}

function idleDetail(version, status) {
  return status.latest.release && versionIsBehind(version, status.latest.release.version) ? "update available" : "up to date";
}

function renderNodeList(status, inventory) {
  elements.updatesNodeList.replaceChildren();
  const fleet = status.fleet;
  const localState = fleetStateFor(fleet, inventory?.local?.id);
  const localJob = status.activeJob;
  elements.updatesNodeList.append(nodeRow({
    name: inventory?.local?.name ?? "This node",
    url: "",
    version: status.currentVersion,
    state: localState?.state ?? (localJob ? "updating" : "idle"),
    detail: localState
      ? `fleet: ${localState.state}${localState.error ? ` — ${localState.error}` : ""}`
      : localJob ? `${localJob.state} → ${localJob.targetVersion}` : idleDetail(status.currentVersion, status),
  }));
  for (const entry of inventory?.remote ?? []) {
    const nodeState = fleetStateFor(fleet, entry.peerId);
    const version = entry.inventory?.version;
    const reachable = entry.reachable;
    const detail = nodeState
      ? `fleet: ${nodeState.state}${nodeState.error ? ` — ${nodeState.error}` : ""}`
      : reachable ? (entry.inventory?.updates?.activeJob ? `${entry.inventory.updates.activeJob.state} → ${entry.inventory.updates.activeJob.targetVersion}` : idleDetail(version, status))
        : `unreachable — ${entry.error ?? ""}`;
    elements.updatesNodeList.append(nodeRow({
      name: entry.name,
      url: entry.url,
      version: version ?? "?",
      state: nodeState?.state ?? (reachable ? "idle" : "offline"),
      detail,
    }));
  }
}

function renderControls(status) {
  const fleetBusy = status.fleet?.state === "running";
  const installable = status.supported && status.updateAvailable && !status.activeJob && !fleetBusy;
  elements.updatesInstallButton.disabled = !installable;
  elements.updatesInstallButton.textContent = status.activeJob ? `Updating to ${status.activeJob.targetVersion}…` : `Update this node${status.latest.release ? ` to ${status.latest.release.version}` : ""}`;
  elements.updatesAutoInput.disabled = !status.supported;
  elements.updatesInstallAllButton.disabled = !installable;
  elements.updatesInstallAllButton.textContent = fleetBusy ? `Updating cluster to ${status.fleet.target}…` : "Update all nodes";
  elements.updatesAutoInput.checked = status.autoUpdate;
}

async function refreshUpdateStatus() {
  const status = await api("/api/update/status");
  renderVersionLine(status);
  renderStateLine(status);
  renderControls(status);
  renderNodeList(status, inventoryCache);
  maybeStartPolling(status);
  return status;
}

async function reloadInventory() {
  try {
    inventoryCache = await api("/api/cluster/inventory");
  } catch {
    inventoryCache = null;
  }
}

export async function loadUpdatesPanel(inventory) {
  stopPolling();
  inventoryCache = inventory;
  if (!inventoryCache) await reloadInventory();
  await refreshUpdateStatus();
}

elements.updatesCheckButton.addEventListener("click", () => {
  elements.updatesCheckButton.disabled = true;
  api("/api/update/check", { method: "POST" })
    .then((status) => {
      renderVersionLine(status);
      renderStateLine(status);
      renderControls(status);
      toast(status.latest.release ? `Latest release is ${status.latest.release.version}` : "No release found");
    })
    .catch((error) => toast(error.message))
    .finally(() => { elements.updatesCheckButton.disabled = false; });
});

elements.updatesAutoInput.addEventListener("change", async () => {
  try {
    const status = await api("/api/update/settings", { method: "PUT", body: JSON.stringify({ autoUpdate: elements.updatesAutoInput.checked }) });
    renderControls(status);
    toast(status.autoUpdate ? "Automatic updates enabled" : "Automatic updates disabled");
  } catch (error) {
    elements.updatesAutoInput.checked = !elements.updatesAutoInput.checked;
    toast(error.message);
  }
});

elements.updatesInstallButton.addEventListener("click", async () => {
  const label = elements.updatesInstallButton.textContent;
  if (!await confirmAction({
    eyebrow: "Update node",
    title: `${label}?`,
    message: "Active work on this node restarts and resumes automatically.",
    confirmLabel: "Update",
  })) return;
  api("/api/update/install", { method: "POST", body: JSON.stringify({}) })
    .then((result) => {
      toast(`Updating to ${result.job.targetVersion}; this page reconnects when the node restarts`);
      maybeStartPolling(result.status);
    })
    .catch((error) => toast(error.message));
});

elements.updatesInstallAllButton.addEventListener("click", async () => {
  const label = elements.updatesInstallAllButton.textContent;
  if (!await confirmAction({
    eyebrow: "Update cluster",
    title: `${label}?`,
    message: "Nodes update one at a time. Active work on each node restarts automatically.",
    confirmLabel: "Update all nodes",
  })) return;
  api("/api/update/install-all", { method: "POST" })
    .then(async () => {
      toast("Rolling out to cluster nodes");
      await reloadInventory();
      await refreshUpdateStatus();
    })
    .catch((error) => toast(error.message));
});

elements.settingsDialog.addEventListener("close", stopPolling);
