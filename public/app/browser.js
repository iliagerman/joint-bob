import { api } from "./api.js";
import "./browser-profile-access.js";
import { claimBrowserPanel, releaseBrowserPanel } from "./browser-panel.js";
import { createBrowserViewer } from "./browser-viewer.js";
import { elements } from "./elements.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";

let viewer = null, viewerKey = null, panel;

// IDs come from the pane's live conversation state, never a transcript path.
function browserIdentity() {
  const conversationId = state.activeConversationId || state.activeSessionId;
  const appNodeId = state.conversationLock?.nodeId || state.activeNodeId;
  const projectId = state.activeConversationProjectId || state.activeProjectId;
  if (!projectId || !conversationId || !appNodeId) return null;
  return { projectId, engine: state.engine, conversationId, appNodeId };
}
function identityKey(identity) {
  return identity ? JSON.stringify([identity.projectId, identity.engine, identity.conversationId, identity.appNodeId]) : null;
}
function disposeViewer() {
  viewer?.dispose(); viewer = null; viewerKey = null; panel = null;
  elements.openBrowserButton?.setAttribute("aria-expanded", "false");
}
function closeViewer() {
  if (!viewer) { disposeViewer(); return; }
  releaseBrowserPanel();
}
export function syncBrowserButton() {
  const identity = browserIdentity();
  elements.openBrowserButton.disabled = !identity;
  elements.openBrowserButton.title = identity ? "View this conversation's browser. Closing the viewer leaves it running." : "Send a message or open an existing conversation before starting its browser.";
  if (viewer && viewerKey !== identityKey(identity)) {
    if (viewer.session?.owner === "human") toast("Browser viewer hidden. Previous conversation's browser is still under human control; reopen it to resume the agent.", 8000);
    closeViewer();
  }
}
function openBrowser() {
  const identity = browserIdentity();
  if (!identity) { toast("Open an existing conversation or send its first message before starting a browser."); return; }
  if (viewer && viewerKey === identityKey(identity)) { panel.querySelector("button")?.focus(); return; }
  closeViewer();
  panel = claimBrowserPanel(disposeViewer);
  panel.setAttribute("aria-label", "Conversation browser");
  viewerKey = identityKey(identity);
  viewer = createBrowserViewer(panel, { api, identity, confirm: confirmAction, onClose: () => { closeViewer(); elements.openBrowserButton.focus(); } });
  elements.openBrowserButton.setAttribute("aria-expanded", "true");
  panel.querySelector('[data-testid="browser-close-viewer"]').focus();
}
elements.openBrowserButton.addEventListener("click", openBrowser);
// The viewer is bound to the open conversation. Searching the conversation list
// means navigating away from it, so close the viewer instead of leaving it
// hovering over an unrelated search result.
elements.sessionSearchInput?.addEventListener("input", () => {
  if (viewer && elements.sessionSearchInput.value.trim()) hideForNavigation();
});
function hideForNavigation() {
  if (viewer?.session?.owner === "human") toast("Viewer hidden. Browser remains under human control; reopen it to resume the agent.", 8000);
  closeViewer();
}
new MutationObserver(() => {
  if (viewer && (document.body.classList.contains("view-board") || document.body.classList.contains("view-canvas"))) hideForNavigation();
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });
window.addEventListener("pagehide", closeViewer);

let statusLoading = false;
export async function loadBrowserStatus() {
  if (statusLoading) return;
  const status = document.querySelector("#browserStatus");
  const check = document.querySelector("#browserStatusCheck");
  statusLoading = true; check.disabled = true;
  const select = document.querySelector("#settingsBrowserExecutor");
  select.disabled = true;
  status.textContent = "Checking browser machines…";
  try {
    const { config, nodes, clusters = [] } = await api("/api/browser/status");
    const machineOption = (node) => {
      const option = new Option(`${node.name}${node.available && node.reachable ? "" : ` · ${node.reason || "Unavailable"}`}`, node.id);
      option.disabled = !node.available || !node.reachable;
      return option;
    };
    const machineName = (id) => nodes.find((node) => node.id === id)?.name ?? id;
    const choices = (candidates, selected) => {
      const options = candidates.map(machineOption);
      if (selected && !candidates.some((node) => node.id === selected)) { const option = new Option(`${machineName(selected)} · Unavailable`, selected); option.disabled = true; options.push(option); }
      return options;
    };
    select.replaceChildren(new Option("No default", ""), ...choices(nodes, config.executorNodeId));
    select.value = config.executorNodeId || ""; select.disabled = false;
    const members = (cluster) => nodes.filter((node) => cluster.memberNodeIds.includes(node.id));
    renderClusterChoices("#settingsBrowserClusterDefaults", clusters, {
      label: (cluster) => `Default for cluster “${cluster.name}”`,
      testid: "settings-browser-cluster-default", path: "cluster-defaults", value: (cluster) => cluster.executorNodeId,
      options: (cluster) => [new Option("No cluster default", ""), ...choices(members(cluster), cluster.executorNodeId)],
      saved: (cluster) => `Default browser machine for ${cluster.name} saved for every member.`,
    });
    renderClusterChoices("#settingsBrowserClusterOverrides", clusters, {
      label: (cluster) => `Projects in cluster “${cluster.name}”`,
      testid: "settings-browser-cluster-override", path: "cluster-overrides", value: (cluster) => cluster.overrideNodeId,
      options: (cluster) => [new Option(`Use cluster default · ${cluster.executorNodeId ? machineName(cluster.executorNodeId) : "none, uses the default below"}`, ""), ...choices(members(cluster), cluster.overrideNodeId)],
      saved: (cluster) => `Browser machine for ${cluster.name} saved on this machine only.`,
    });
    status.textContent = nodes.map((node) => `${node.name}: ${node.available && node.reachable ? "Ready" : node.reason || "Unavailable"}. ${node.runningCount} running.`).join(" ");
  } catch (error) { status.textContent = `Browser status unavailable: ${error.message}. Try Check status again.`; }
  finally { statusLoading = false; check.disabled = false; }
}
function renderClusterChoices(selector, clusters, spec) {
  const container = document.querySelector(selector);
  if (!clusters.length) { container.textContent = "This machine is not a member of any cluster."; return; }
  container.replaceChildren(...clusters.map((cluster) => {
    const label = document.createElement("label");
    label.textContent = spec.label(cluster);
    const choice = document.createElement("select");
    choice.dataset.testid = spec.testid;
    choice.dataset.clusterId = cluster.id;
    choice.replaceChildren(...spec.options(cluster));
    choice.value = spec.value(cluster) || "";
    choice.addEventListener("change", async () => {
      if (statusLoading) return;
      statusLoading = true; choice.disabled = true;
      try {
        await api(`/api/browser/${spec.path}/${encodeURIComponent(cluster.id)}`, { method: "PUT", body: JSON.stringify({ executorNodeId: choice.value || null }) });
        toast(spec.saved(cluster));
      } catch (error) { toast(error.message); }
      finally { statusLoading = false; }
      await loadBrowserStatus();
    });
    label.append(choice);
    return label;
  }));
}
document.querySelector("#browserStatusCheck").addEventListener("click", loadBrowserStatus);
document.querySelector("#settingsBrowserExecutor").addEventListener("change", async (event) => {
  if (statusLoading) return;
  statusLoading = true;
  const select = event.currentTarget;
  select.disabled = true;
  document.querySelector("#browserStatusCheck").disabled = true;
  try {
    await api("/api/browser/config", { method: "PUT", body: JSON.stringify({ executorNodeId: select.value || null }) });
    toast("Default browser machine saved on this machine only. Existing accounts are unchanged.");
  } catch (error) { toast(error.message); }
  finally { statusLoading = false; }
  await loadBrowserStatus();
});
