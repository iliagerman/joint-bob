import { api } from "./api.js";
import { createBrowserViewer } from "./browser-viewer.js";
import { elements } from "./elements.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";

const dismissed = new Set(), announced = new Set();
let popup = null, discovering = false, discoveryOutage = false, timer = null;

function identity() {
  const conversationId = state.activeConversationId || state.activeSessionId;
  const appNodeId = state.conversationLock?.nodeId || state.activeNodeId;
  if (!state.authenticated || !state.activeProjectId || !state.engine || !conversationId || !appNodeId) return null;
  return { projectId: state.activeProjectId, engine: state.engine, conversationId, appNodeId };
}
const identityKey = value => value && JSON.stringify([value.projectId, value.engine, value.conversationId, value.appNodeId]);
const requestKey = session => `${session.nodeId}:${session.id}:${session.loginRequest.id}`;
const sessionIdentity = session => ({ projectId: session.projectId, engine: session.engine, conversationId: session.conversationId, appNodeId: session.appNodeId });

function close(current, markDismissed = false) {
  if (!current || current.closed) return;
  current.closed = true;
  if (markDismissed) dismissed.add(current.requestKey);
  current.viewer?.dispose();
  document.removeEventListener("keydown", current.escape, true);
  current.host.remove();
  if (popup === current) popup = null;
  if (current.focus?.isConnected && typeof current.focus.focus === "function") current.focus.focus();
  if (markDismissed) toast("Browser remains paused. Reopen this conversation's Browser panel to finish signing in.", 8000);
}

// The sign-in belongs to the conversation that asked for it, so it renders in that
// conversation, directly above its composer, and leaves with it.
function mount(session) {
  const current = {
    requestKey: requestKey(session), requestId: session.loginRequest.id, identityKey: identityKey(sessionIdentity(session)),
    sessionId: session.id, nodeId: session.nodeId, focus: document.activeElement, viewer: null, closed: false, host: null,
  };
  const host = document.createElement("section");
  host.className = "browser-login-inline";
  host.dataset.testid = "browser-login-panel";
  host.setAttribute("aria-label", "Browser sign-in");
  elements.composer.before(host);
  current.host = host;
  popup = current;
  const dismiss = () => close(current, true);
  // A modeless block inside the conversation has to claim Escape on the document.
  current.escape = event => {
    if (event.key !== "Escape") return;
    event.preventDefault(); event.stopImmediatePropagation();
    // Full screen is a view state: Escape backs out of it before dismissing the
    // sign-in. A phone has no inline state to back out to, so Escape dismisses.
    const expand = host.querySelector('[data-testid="browser-login-expand"]');
    if (host.classList.contains("browser-login-fullscreen") && expand?.offsetParent) { expand.click(); return; }
    dismiss();
  };
  document.addEventListener("keydown", current.escape, true);
  current.viewer = createBrowserViewer(host, {
    api, identity: sessionIdentity(session), sessionId: session.id, nodeId: session.nodeId,
    confirm: confirmAction, loginMode: true, onClose: dismiss,
    isCurrent: () => state.authenticated && popup === current && !current.closed && identityKey(identity()) === current.identityKey && host.isConnected && !document.hidden,
    onSession(next) {
      if (popup !== current || current.closed) return;
      if (!state.authenticated) { close(current, false); return; }
      if (identityKey(identity()) !== current.identityKey) { close(current, false); return; }
      if (next?.id !== current.sessionId || next?.nodeId !== current.nodeId) return;
      if (next.state !== "running" || !next.loginRequest) {
        dismissed.add(current.requestKey);
        close(current, false);
      } else if (next.loginRequest.id !== current.requestId) {
        close(current, false);
        queueMicrotask(schedule);
      }
    },
  });
  // A phone keyboard leaves little room above it; full screen drops the app
  // chrome so the remote page keeps every remaining pixel while typing. The
  // panel reparents to <body>: an ancestor's containment would otherwise pin
  // position:fixed to the chat column instead of the screen.
  const expandButton = host.querySelector('[data-testid="browser-login-expand"]');
  expandButton.addEventListener("click", () => {
    const on = host.classList.toggle("browser-login-fullscreen");
    expandButton.textContent = on ? "Exit full screen" : "Full screen";
    expandButton.setAttribute("aria-pressed", String(on));
    if (on) document.body.append(host);
    else elements.composer.before(host);
  });
  // On a phone the embedded strip shrinks to almost nothing once the keyboard
  // opens; start straight in the full-screen popup so only the page shows.
  if (window.innerWidth < 700) expandButton.click();
  host.querySelector('[data-testid="browser-login-done"]')?.focus();
}

async function discover() {
  const currentIdentityKey = identityKey(identity());
  if (popup && (!state.authenticated || popup.identityKey !== currentIdentityKey)) close(popup, false);
  if (discovering || popup || !state.authenticated || window.top !== window || document.hidden) return;
  discovering = true;
  try {
    const result = await api("/api/browser/sessions");
    discoveryOutage = false;
    if (!state.authenticated) return;
    if (identityKey(identity()) !== currentIdentityKey || popup || document.hidden) return;
    const pending = (result.sessions || []).filter(row => row.projectId && row.engine && row.conversationId && row.appNodeId
      && row.state === "running" && row.loginRequest && row.id && row.nodeId && !dismissed.has(requestKey(row)));
    const mine = currentIdentityKey && pending.find(row => identityKey(sessionIdentity(row)) === currentIdentityKey);
    if (mine) { mount(mine); return; }
    // Another conversation's sign-in stays there; announce it once instead of taking over this screen.
    for (const row of pending) {
      const key = requestKey(row);
      if (announced.has(key)) continue;
      announced.add(key);
      toast(`${row.profileLabel || "A browser"} needs you to sign in. Open that conversation to finish.`, 8000);
    }
  } catch {
    if (!discoveryOutage) toast("Could not check for browser sign-in requests. Check your connection.", 8000);
    discoveryOutage = true;
  }
  finally { discovering = false; }
}

function schedule() { void discover(); }
// Selecting another conversation must take its sign-in away immediately, not on the next poll.
// The signal arrives as a DOM event so chat rendering never has to import this module.
function syncBrowserLogin() {
  if (popup && identityKey(identity()) !== popup.identityKey) close(popup, false);
  schedule();
}
document.addEventListener("activeConversationChanged", syncBrowserLogin);
document.addEventListener("browserSessionsChanged", schedule);
window.addEventListener("focus", schedule);
document.addEventListener("visibilitychange", schedule);
timer = setInterval(schedule, 2000);
window.addEventListener("pagehide", () => {
  clearInterval(timer); timer = null;
  document.removeEventListener("activeConversationChanged", syncBrowserLogin);
  document.removeEventListener("browserSessionsChanged", schedule);
  window.removeEventListener("focus", schedule);
  document.removeEventListener("visibilitychange", schedule);
  close(popup, false);
}, { once: true });
