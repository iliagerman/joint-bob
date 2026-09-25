import { showSignedOut } from "./auth.js";
import { elements } from "./elements.js";
import { renderProjects } from "./project-list.js";
import { renderRecentSessionsDialog } from "./recents.js";
import { renderSessions } from "./session-list.js";
import { state } from "./state.js";

function headers() {
  return state.csrfToken ? { "X-CSRF-Token": state.csrfToken, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

export async function api(path, options = {}) {
  const response = await fetch(path, { ...options, cache: "no-store", headers: { ...headers(), ...(options.headers || {}) } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    if (response.status === 401 && !["/api/auth/status", "/api/auth/login", "/api/auth/login/mfa"].includes(path)) showSignedOut();
    throw new Error(body.error || response.statusText);
  }
  if (response.status === 204) return null;
  return response.json();
}

export async function savePreferences(partial) {
  return api("/api/preferences", { method: "PUT", body: JSON.stringify(partial) });
}

let pinsReadVersion = 0;
let confirmedPins;
let pinWrites = Promise.resolve();
const pendingPins = new Map();
let pinsAuthToken;

function pinScope() {
  if (pinsAuthToken !== state.csrfToken) {
    pinsAuthToken = state.csrfToken;
    confirmedPins = undefined;
    pendingPins.clear();
    ++pinsReadVersion;
  }
  return pinsAuthToken;
}

function renderPins() {
  state.replicatedPinnedProjectIds = [...confirmedPins.projectIds];
  state.pinnedConversations = [...confirmedPins.conversations];
  for (const change of pendingPins.values()) {
    if (change.kind === "project") {
      state.replicatedPinnedProjectIds = state.replicatedPinnedProjectIds.filter((id) => id !== change.projectId);
      if (change.pinned) state.replicatedPinnedProjectIds.push(change.projectId);
    } else {
      state.pinnedConversations = state.pinnedConversations.filter((pin) => !(pin.projectId === change.projectId && pin.engine === change.engine && pin.sessionId === change.sessionId));
      if (change.pinned) state.pinnedConversations.push({ projectId: change.projectId, engine: change.engine, sessionId: change.sessionId });
    }
  }
  renderProjects();
  renderSessions();
  if (elements.recentSessionsDialog.open) renderRecentSessionsDialog();
}

export async function loadPins() {
  const token = pinScope();
  const version = ++pinsReadVersion;
  const pins = await api("/api/pins");
  if (version !== pinsReadVersion || token !== state.csrfToken) return;
  confirmedPins = pins;
  renderPins();
}

/** Preserve click order on the wire and overlay unacknowledged intent on snapshots. */
export function savePin(target, pinned) {
  const token = pinScope();
  confirmedPins ??= { projectIds: [...state.replicatedPinnedProjectIds], conversations: [...state.pinnedConversations] };
  const key = JSON.stringify([target.kind, target.projectId, target.engine, target.sessionId]);
  const change = { ...target, pinned };
  pendingPins.set(key, change);
  ++pinsReadVersion;
  renderPins();
  const write = pinWrites.then(() => {
    if (token !== state.csrfToken) throw new Error("Sign-in changed before pin could be saved");
    return api("/api/pins", { method: "PUT", body: JSON.stringify(change) });
  });
  pinWrites = write.catch(() => {});
  return write.then((pins) => { if (token === state.csrfToken) confirmedPins = pins; }).finally(() => {
    if (token !== state.csrfToken) return;
    ++pinsReadVersion;
    if (pendingPins.get(key) === change) pendingPins.delete(key);
    renderPins();
    // Also reconcile uncertain failures; never retry a mutation automatically.
    void loadPins().catch((error) => console.warn("Could not reconcile pins", error));
  });
}

export function savePreferencesInBackground(partial) {
  if (state.canvasPaneMode) return;
  void savePreferences(partial).catch((error) => console.warn("Could not save preferences", error));
}
