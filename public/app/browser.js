import { api } from "./api.js";
import { createBrowserViewer } from "./browser-viewer.js";
import { elements } from "./elements.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";

let viewer = null, viewerKey = null, panel;

// IDs come from the pane's live conversation state, never a transcript path.
function browserIdentity() {
  const conversationId = state.activeConversationId || state.activeSessionId;
  const appNodeId = state.conversationLock?.nodeId || state.activeNodeId;
  if (!state.activeProjectId || !conversationId || !appNodeId) return null;
  return { projectId: state.activeProjectId, engine: state.engine, conversationId, appNodeId };
}
function identityKey(identity) {
  return identity ? JSON.stringify([identity.projectId, identity.engine, identity.conversationId, identity.appNodeId]) : null;
}
function closeViewer() {
  viewer?.dispose(); viewer = null; viewerKey = null;
  panel?.remove(); panel = null;
  document.body.classList.remove("browser-visible");
  elements.openBrowserButton?.setAttribute("aria-expanded", "false");
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
  panel = document.createElement("aside"); panel.id = "browserPanel";
  panel.className = "panel"; panel.setAttribute("aria-label", "Conversation browser");
  elements.chatPanel.after(panel);
  document.body.classList.add("browser-visible");
  viewerKey = identityKey(identity);
  viewer = createBrowserViewer(panel, { api, identity, confirm: confirmAction, onClose: () => { closeViewer(); elements.openBrowserButton.focus(); } });
  elements.openBrowserButton.setAttribute("aria-expanded", "true");
  panel.querySelector('[data-testid="browser-close-viewer"]').focus();
}
elements.openBrowserButton.addEventListener("click", openBrowser);
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
    const { config, nodes } = await api("/api/browser/status");
    const options = nodes.map((node) => {
      const option = new Option(`${node.name}${node.available && node.reachable ? "" : ` · ${node.reason || "Unavailable"}`}`, node.id);
      option.disabled = !node.available || !node.reachable;
      return option;
    });
    if (config.executorNodeId && !nodes.some((node) => node.id === config.executorNodeId)) {
      const option = new Option(`${config.executorNodeId} · Unavailable`, config.executorNodeId); option.disabled = true; options.push(option);
    }
    select.replaceChildren(new Option("Not configured", ""), ...options);
    select.value = config.executorNodeId || ""; select.disabled = false;
    status.textContent = nodes.map((node) => `${node.name}: ${node.available && node.reachable ? "Ready" : node.reason || "Unavailable"}. ${node.runningCount} running.`).join(" ");
  } catch (error) { status.textContent = `Browser status unavailable: ${error.message}. Try Check status again.`; }
  finally { statusLoading = false; check.disabled = false; }
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
    toast("Default browser machine saved. Existing accounts are unchanged.");
  } catch (error) { toast(error.message); }
  finally { statusLoading = false; }
  await loadBrowserStatus();
});
