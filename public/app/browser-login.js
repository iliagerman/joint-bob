import { api } from "./api.js";
import { createBrowserViewer } from "./browser-viewer.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";

const dismissed = new Set();
let popup = null, discovering = false, timer = null;

function identity() {
  const conversationId = state.activeConversationId || state.activeSessionId;
  const appNodeId = state.conversationLock?.nodeId || state.activeNodeId;
  if (!state.authenticated || !state.activeProjectId || !state.engine || !conversationId || !appNodeId) return null;
  return { projectId: state.activeProjectId, engine: state.engine, conversationId, appNodeId };
}
const identityKey = value => value && JSON.stringify([value.projectId, value.engine, value.conversationId, value.appNodeId]);
const requestKey = session => `${session.nodeId}:${session.id}:${session.loginRequest.id}`;

function removePopup(current, markDismissed = false) {
  if (!current || current.closed) return;
  current.closed = true;
  if (markDismissed) dismissed.add(current.requestKey);
  current.viewer?.dispose();
  current.dialog.removeEventListener("keydown", current.escape, true);
  if (current.dialog.open) current.dialog.close();
  current.dialog.remove();
  if (popup === current) popup = null;
  if (current.focus?.isConnected && typeof current.focus.focus === "function") current.focus.focus();
  if (markDismissed) toast("Browser remains paused. Reopen Browser to finish signing in.", 8000);
}

function mount(session, currentIdentity) {
  const key = requestKey(session);
  const dialog = document.createElement("dialog");
  dialog.className = "browser-login-dialog";
  dialog.dataset.testid = "browser-login-dialog";
  dialog.setAttribute("aria-label", "Browser sign-in");
  const root = document.createElement("div");
  dialog.append(root); document.body.append(dialog);
  const current = { dialog, root, requestKey: key, requestId: session.loginRequest.id, identityKey: identityKey(currentIdentity), sessionId: session.id, nodeId: session.nodeId, focus: document.activeElement, viewer: null, closed: false };
  popup = current;
  const dismiss = () => removePopup(current, true);
  current.escape = event => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); dismiss(); } };
  dialog.addEventListener("keydown", current.escape, true);
  dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener("close", () => { if (!current.closed) dismiss(); });
  current.viewer = createBrowserViewer(root, {
    api, identity: currentIdentity, sessionId: session.id, nodeId: session.nodeId,
    confirm: confirmAction, loginMode: true, onClose: dismiss,
    isCurrent: () => popup === current && !current.closed && identityKey(identity()) === current.identityKey && dialog.open && !document.hidden,
    onSession(next) {
      if (popup !== current || current.closed) return;
      if (identityKey(identity()) !== current.identityKey) { removePopup(current, false); return; }
      if (next?.id !== current.sessionId || next?.nodeId !== current.nodeId) return;
      if (next.state !== "running" || !next.loginRequest) {
        dismissed.add(current.requestKey);
        removePopup(current, false);
      } else if (next.loginRequest.id !== current.requestId) {
        removePopup(current, false);
        queueMicrotask(schedule);
      }
    },
  });
  dialog.showModal();
  dialog.querySelector('[data-testid="browser-close-viewer"]')?.focus();
}

async function discover() {
  const currentIdentity = identity();
  const currentIdentityKey = identityKey(currentIdentity);
  if (popup && popup.identityKey !== currentIdentityKey) removePopup(popup, false);
  if (discovering || popup || !currentIdentity || document.hidden) return;
  if (!state.canvasPaneMode && (document.body.classList.contains("view-board") || document.body.classList.contains("view-canvas"))) return;
  discovering = true;
  try {
    const query = new URLSearchParams(currentIdentity); query.delete("appNodeId");
    const result = await api(`/api/browser/sessions?${query}`);
    if (identityKey(identity()) !== currentIdentityKey || popup || document.hidden) return;
    const session = result.sessions?.find(row => row.projectId === currentIdentity.projectId && row.conversationId === currentIdentity.conversationId && row.state === "running" && row.loginRequest && row.id && row.nodeId && !dismissed.has(requestKey(row)));
    if (session && identityKey(identity()) === currentIdentityKey) mount(session, currentIdentity);
  } catch { /* Polling is quiet; the manual Browser panel remains available. */ }
  finally { discovering = false; }
}

function schedule() { void discover(); }
document.addEventListener("browserSessionsChanged", schedule);
window.addEventListener("focus", schedule);
document.addEventListener("visibilitychange", schedule);
timer = setInterval(schedule, 2000);
window.addEventListener("pagehide", () => {
  clearInterval(timer); timer = null;
  document.removeEventListener("browserSessionsChanged", schedule);
  window.removeEventListener("focus", schedule);
  document.removeEventListener("visibilitychange", schedule);
  removePopup(popup, false);
}, { once: true });
