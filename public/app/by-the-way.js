import { api } from "./api.js";
import { elements } from "./elements.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

let temporary = null;
let creating = false;
let closeRequested = false;

function closePayload() {
  if (!temporary) return null;
  return {
    engine: temporary.session.harnessId,
    sessionId: temporary.session.id,
    token: temporary.token,
    nodeId: temporary.session.executionNodeId,
  };
}

function temporaryUrl(session, token) {
  const url = new URL("/", location.origin);
  url.searchParams.set("canvasPane", "1");
  url.searchParams.set("projectId", state.activeProjectId);
  url.searchParams.set("sessionPath", session.path);
  url.searchParams.set("sessionId", session.id);
  url.searchParams.set("byTheWayToken", token);
  if (session.executionNodeId) url.searchParams.set("nodeId", session.executionNodeId);
  return url.href;
}

function showConversation(session, token) {
  const frame = document.createElement("iframe");
  frame.src = temporaryUrl(session, token);
  frame.title = "By the Way conversation";
  frame.dataset.testid = "by-the-way-frame";
  frame.addEventListener("load", () => {
    frame.contentWindow.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void closeByTheWay();
    }, { capture: true });
  });
  elements.byTheWayFrame.replaceChildren(frame);
  elements.byTheWayStatus.hidden = true;
}

async function destroyTemporary() {
  const payload = closePayload();
  if (!payload) return;
  await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions/by-the-way/close`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  temporary = null;
}

export async function closeByTheWay() {
  closeRequested = true;
  elements.byTheWayFrame.replaceChildren();
  elements.byTheWayStatus.textContent = creating ? "Finishing temporary conversation…" : "Deleting temporary conversation…";
  elements.byTheWayStatus.hidden = false;
  elements.closeByTheWayButton.disabled = true;
  if (creating) return;
  try {
    await destroyTemporary();
    elements.byTheWayDialog.close();
  } catch (error) {
    closeRequested = false;
    elements.byTheWayStatus.textContent = error.message;
    elements.closeByTheWayButton.disabled = false;
    toast(error.message);
  }
}

export async function openByTheWay() {
  if (elements.byTheWayDialog.open) return;
  if (!state.activeProjectId || !state.activeSessionId || !state.activeSessionPath) {
    toast("Open a conversation before using /bob-btw");
    return;
  }
  closeRequested = false;
  creating = true;
  elements.byTheWayStatus.textContent = "Cloning conversation…";
  elements.byTheWayStatus.hidden = false;
  elements.byTheWayFrame.replaceChildren();
  elements.closeByTheWayButton.disabled = false;
  elements.byTheWayDialog.showModal();
  try {
    temporary = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions/by-the-way`, {
      method: "POST",
      body: JSON.stringify({ engine: state.engine, sessionId: state.activeSessionId }),
    });
    creating = false;
    if (closeRequested) {
      await closeByTheWay();
      return;
    }
    showConversation(temporary.session, temporary.token);
  } catch (error) {
    creating = false;
    elements.byTheWayStatus.textContent = error.message;
    elements.closeByTheWayButton.disabled = false;
    toast(error.message);
  }
}

elements.closeByTheWayButton.addEventListener("click", () => { void closeByTheWay(); });
elements.byTheWayDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  void closeByTheWay();
});
elements.byTheWayDialog.addEventListener("click", (event) => {
  if (event.target === elements.byTheWayDialog) void closeByTheWay();
});

window.addEventListener("pagehide", () => {
  const payload = closePayload();
  if (!payload) return;
  void fetch(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions/by-the-way/close`, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrfToken },
    body: JSON.stringify(payload),
  }).catch(() => undefined);
});
