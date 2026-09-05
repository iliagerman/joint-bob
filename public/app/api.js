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
  const response = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    if (response.status === 401 && path !== "/api/auth/status" && path !== "/api/auth/login") showSignedOut();
    throw new Error(body.error || response.statusText);
  }
  if (response.status === 204) return null;
  return response.json();
}

export async function savePreferences(partial) {
  return api("/api/preferences", { method: "PUT", body: JSON.stringify(partial) });
}

export async function loadPins() {
  const pins = await api("/api/pins");
  state.replicatedPinnedProjectIds = pins.projectIds || [];
  state.pinnedConversations = pins.conversations || [];
  renderProjects();
  renderSessions();
  if (elements.recentSessionsDialog.open) renderRecentSessionsDialog();
}

export function savePreferencesInBackground(partial) {
  if (state.canvasPaneMode) return;
  void savePreferences(partial).catch((error) => console.warn("Could not save preferences", error));
}
