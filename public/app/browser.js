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
  return identity ? JSON.stringify([identity.projectId, identity.engine, identity.conversationId]) : null;
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
// Opening navigation gives its space back without ending the remote browser.
function hideForNavigation() {
  if (viewer?.session?.owner === "human") toast("Viewer hidden. Browser remains under human control; reopen it to resume the agent.", 8000);
  closeViewer();
}
for (const button of [elements.expandProjectsButton, elements.expandChatsButton]) button.addEventListener("click", () => { if (viewer) hideForNavigation(); });
new MutationObserver(() => {
  if (viewer && (document.body.classList.contains("view-board") || document.body.classList.contains("view-canvas"))) hideForNavigation();
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });
window.addEventListener("pagehide", closeViewer);

let statusLoading = false;
export async function loadBrowserExecutorSettings() {
  if (statusLoading) return;
  const select = document.querySelector("#browserExecutorSelect");
  const status = document.querySelector("#browserExecutorStatus");
  const save = document.querySelector("#browserExecutorSave");
  statusLoading = true; select.disabled = save.disabled = true;
  status.textContent = "Checking browser executors…";
  try {
    const result = await api("/api/browser/status");
    select.replaceChildren(new Option("No browser executor", ""), ...result.nodes.map((node) => {
      const option = new Option(`${node.name} · ${node.available ? "Ready" : node.reason || "Unavailable"}`, node.id);
      option.disabled = !node.supported;
      return option;
    }));
    const configured = result.config.executorNodeId;
    if (configured && !result.nodes.some((node) => node.id === configured)) {
      const missing = new Option("Configured node unavailable", configured); missing.disabled = true; select.append(missing);
    }
    select.value = configured || "";
    const node = result.nodes.find((node) => node.id === configured);
    status.textContent = configured
      ? node?.available ? `Ready on ${node.name}. ${node.executable || ""}` : `Executor unavailable: ${node?.reason || "node not found"}. Existing browser sessions are unchanged.`
      : "Select an Ubuntu node to run browsers. No executor configured.";
    select.disabled = save.disabled = false;
  } catch (error) { status.textContent = `Browser status unavailable: ${error.message}. Try Check status again.`; }
  finally { statusLoading = false; }
}
document.querySelector("#browserExecutorCheck").addEventListener("click", loadBrowserExecutorSettings);
document.querySelector("#browserExecutorSave").addEventListener("click", async () => {
  const save = document.querySelector("#browserExecutorSave"), select = document.querySelector("#browserExecutorSelect"), status = document.querySelector("#browserExecutorStatus");
  save.disabled = select.disabled = true;
  try {
    await api("/api/browser/config", { method: "PUT", body: JSON.stringify({ executorNodeId: select.value || null }) });
    status.textContent = "Browser executor saved. Existing browser sessions are unchanged.";
  } catch (error) { status.textContent = `Could not save browser executor: ${error.message}`; }
  finally { save.disabled = select.disabled = false; }
});
