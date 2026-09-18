import { api } from "./api.js";
import { claimBrowserPanel, releaseBrowserPanel } from "./browser-panel.js";
import { createBrowserViewer } from "./browser-viewer.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";

const dismissed = new Set();
let popup = null, discovering = false, discoveryOutage = false, timer = null;

function identity() {
  const conversationId = state.activeConversationId || state.activeSessionId;
  const appNodeId = state.conversationLock?.nodeId || state.activeNodeId;
  if (!state.authenticated || !state.activeProjectId || !state.engine || !conversationId || !appNodeId) return null;
  return { projectId: state.activeProjectId, engine: state.engine, conversationId, appNodeId };
}
const identityKey = value => value && JSON.stringify([value.projectId, value.engine, value.conversationId, value.appNodeId]);
const requestKey = session => `${session.nodeId}:${session.id}:${session.loginRequest.id}`;

// Called both when the sign-in closes itself and when the manual viewer evicts it from the slot.
function removePopup(current, markDismissed = false) {
  if (!current || current.closed) return;
  current.closed = true;
  if (markDismissed) dismissed.add(current.requestKey);
  current.viewer?.dispose();
  document.removeEventListener("keydown", current.escape, true);
  if (popup === current) popup = null;
  if (current.focus?.isConnected && typeof current.focus.focus === "function") current.focus.focus();
  if (markDismissed) toast("Browser remains paused. Reopen the requesting conversation's Browser panel to finish signing in.", 8000);
}

function closePopup(current, markDismissed = false) {
  removePopup(current, markDismissed);
  releaseBrowserPanel();
}

function mount(session, currentScreenIdentity) {
  const key = requestKey(session);
  const current = { root: null, requestKey: key, requestId: session.loginRequest.id, identityKey: identityKey(currentScreenIdentity), sessionId: session.id, nodeId: session.nodeId, focus: document.activeElement, viewer: null, closed: false };
  // Taking the slot back for the manual viewer counts as dismissal, otherwise discovery would
  // re-claim it two seconds later and the two panels would flip-flop.
  const panel = claimBrowserPanel(() => removePopup(current, true));
  panel.classList.add("browser-login-panel");
  panel.dataset.testid = "browser-login-panel";
  panel.setAttribute("aria-label", "Browser sign-in");
  const root = document.createElement("div");
  panel.append(root);
  current.root = root;
  popup = current;
  const dismiss = () => closePopup(current, true);
  // The modal dialog used to own Escape outright; a modeless panel has to claim it on the document to keep that.
  current.escape = event => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); dismiss(); } };
  document.addEventListener("keydown", current.escape, true);
  const sessionIdentity = { projectId: session.projectId, engine: session.engine, conversationId: session.conversationId, appNodeId: session.appNodeId };
  current.viewer = createBrowserViewer(root, {
    api, identity: sessionIdentity, sessionId: session.id, nodeId: session.nodeId,
    confirm: confirmAction, loginMode: true, onClose: dismiss,
    isCurrent: () => state.authenticated && popup === current && !current.closed && identityKey(identity()) === current.identityKey && root.isConnected && !document.hidden,
    onSession(next) {
      if (popup !== current || current.closed) return;
      if (!state.authenticated) { closePopup(current, false); return; }
      if (identityKey(identity()) !== current.identityKey) { closePopup(current, false); return; }
      if (next?.id !== current.sessionId || next?.nodeId !== current.nodeId) return;
      if (next.state !== "running" || !next.loginRequest) {
        dismissed.add(current.requestKey);
        closePopup(current, false);
      } else if (next.loginRequest.id !== current.requestId) {
        closePopup(current, false);
        queueMicrotask(schedule);
      }
    },
  });
  panel.querySelector('[data-testid="browser-close-viewer"]')?.focus();
}

async function discover() {
  const currentIdentity = identity();
  const currentIdentityKey = identityKey(currentIdentity);
  if (popup && (!state.authenticated || popup.identityKey !== currentIdentityKey)) closePopup(popup, false);
  if (discovering || popup || !state.authenticated || window.top !== window || document.hidden) return;
  discovering = true;
  try {
    const result = await api("/api/browser/sessions");
    discoveryOutage = false;
    if (!state.authenticated) return;
    if (identityKey(identity()) !== currentIdentityKey || popup || document.hidden) return;
    const session = result.sessions?.find(row => row.projectId && row.engine && row.conversationId && row.appNodeId && row.state === "running" && row.loginRequest && row.id && row.nodeId && !dismissed.has(requestKey(row)));
    if (session && state.authenticated && identityKey(identity()) === currentIdentityKey) mount(session, currentIdentity);
  } catch {
    if (!discoveryOutage) toast("Could not check for browser sign-in requests. Check your connection.", 8000);
    discoveryOutage = true;
  }
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
  closePopup(popup, false);
}, { once: true });
