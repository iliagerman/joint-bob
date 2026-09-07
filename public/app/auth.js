import { DEFAULT_CANVAS_KEYMAP, emptyCanvasLayout, normalizeCanvasKeymap } from "../canvas-layout.js";
import { api, savePreferences, savePreferencesInBackground } from "./api.js";
import { clearAttachments } from "./attachments.js";
import { setComposerEnabled } from "./chat-controls.js";
import { clearChat } from "./chat-transcript.js";
import { elements } from "./elements.js";
import { setMobileView, setPanelCollapsed } from "./layout.js";
import { openProjectImportMapping } from "./project-forms.js";
import { renderProjects } from "./project-list.js";
import { loadProjects, refreshProjectsQuietly, startProjectSyncPolling } from "./project-selection.js";
import { renderSessions } from "./session-list.js";
import { showWhatsNew } from "./settings.js";
import { formatDate, setTheme, syncNotifyButton, toast, updateInstallButton } from "./shell.js";
import { closeSocket, closeWatchSocket } from "./socket.js";
import { BOOT_MINIMUM_MS, BOOT_REQUEST_TIMEOUT_MS, bootStartedAt, LEGACY_PREFERENCE_KEYS, shared, state } from "./state.js";
import { renderBoardView } from "./tasks.js";
import { loadWorkspaces } from "./workspaces.js";

async function migrateLegacyPreferences(preferences) {
  if (preferences.legacyMigrated) return preferences;
  let legacy;
  try {
    legacy = Object.fromEntries(LEGACY_PREFERENCE_KEYS.map((key) => [key, localStorage.getItem(key) ?? sessionStorage.getItem(key)]));
  } catch (error) {
    await savePreferences({ legacyMigrated: true });
    throw error;
  }

  const partial = { legacyMigrated: true };
  if (["light", "dark"].includes(legacy.piWebTheme)) partial.theme = legacy.piWebTheme;
  if (["1", "true", "0", "false"].includes(legacy.piWebNotifications)) partial.notificationsEnabled = ["1", "true"].includes(legacy.piWebNotifications);
  if (["1", "true", "0", "false"].includes(legacy.piWebInstallDismissed)) partial.installDismissed = ["1", "true"].includes(legacy.piWebInstallDismissed);
  if (["projects", "sessions", "board", "chat"].includes(legacy.piWebActiveView)) partial.mobileView = legacy.piWebActiveView;
  if (legacy.piWebActiveProjectId?.trim() && legacy.piWebActiveProjectId.length <= 120) partial.activeProjectId = legacy.piWebActiveProjectId;
  if (legacy.piWebActiveSessionPath?.trim() && legacy.piWebActiveSessionPath.length <= 2000) partial.activeSessionPath = legacy.piWebActiveSessionPath;

  const migrated = await savePreferences(partial);
  for (const key of LEGACY_PREFERENCE_KEYS) {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  }
  return migrated;
}

function loginError(message = "") {
  elements.loginError.hidden = !message;
  elements.loginError.textContent = message;
}

function showLogin() {
  if (!elements.loginDialog.open) elements.loginDialog.showModal();
}

export function showSignedOut() {
  if (state.projectSyncTimer) clearInterval(state.projectSyncTimer);
  state.projectSyncTimer = null;
  state.authenticated = false;
  state.preferencesLoaded = false;
  state.username = "";
  state.csrfToken = "";
  state.mustChangePassword = false;
  state.activeProjectId = null;
  state.activeSessionPath = null;
  state.activeSessionId = null;
  state.activeTaskId = null;
  state.projects = [];
  state.sessions = [];
  state.tasks = [];
  closeSocket();
  closeWatchSocket();
  clearChat();
  clearAttachments();
  setComposerEnabled(false);
  elements.sessionTitle.textContent = "Select a conversation";
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  renderProjects();
  renderSessions();
  renderBoardView();
  setMobileView("projects");
  showLogin();
}

export function revealApplication() {
  if (!document.body.classList.contains("booting") || shared.bootRevealTimer) return;
  const delay = Math.max(0, BOOT_MINIMUM_MS - (performance.now() - bootStartedAt));
  if (delay) {
    shared.bootRevealTimer = setTimeout(() => {
      shared.bootRevealTimer = null;
      document.body.classList.remove("booting");
    }, delay);
    return;
  }
  document.body.classList.remove("booting");
}

function applyAuthStatus(status) {
  state.authenticated = status.authenticated;
  state.username = status.username || "";
  state.setupRequired = status.setupRequired === true;
  state.mustChangePassword = status.mustChangePassword === true;
  state.csrfToken = status.csrfToken || "";
  elements.loginPasswordLabel.hidden = state.setupRequired;
  elements.loginPasswordInput.required = !state.setupRequired;
  elements.newPasswordLabel.hidden = !(state.mustChangePassword || state.setupRequired);
  elements.newPasswordInput.required = state.mustChangePassword || state.setupRequired;
  elements.loginSubmitButton.textContent = state.setupRequired ? "Create administrator" : state.mustChangePassword ? "Change password" : "Sign in";
  elements.loginMessage.textContent = state.setupRequired ? "Create this node's administrator." : state.mustChangePassword ? "Change the generated initial password before using this node." : "Sign in to this node.";
}

export async function initializeApplication() {
  const status = await api("/api/auth/status", { signal: AbortSignal.timeout(BOOT_REQUEST_TIMEOUT_MS) });
  applyAuthStatus(status);
  if (!status.authenticated) {
    revealApplication();
    showLogin();
    return;
  }
  if (status.mustChangePassword) {
    revealApplication();
    showLogin();
    return;
  }
  let [preferences, pins, recents] = await Promise.all([
    api("/api/preferences", { signal: AbortSignal.timeout(BOOT_REQUEST_TIMEOUT_MS) }),
    api("/api/pins", { signal: AbortSignal.timeout(BOOT_REQUEST_TIMEOUT_MS) }),
    api("/api/recents", { signal: AbortSignal.timeout(BOOT_REQUEST_TIMEOUT_MS) }),
  ]);
  preferences = await migrateLegacyPreferences(preferences);
  state.preferencesLoaded = false;
  setTheme(preferences.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  state.installDismissed = preferences.installDismissed;
  state.notificationsEnabled = preferences.notificationsEnabled;
  state.completionSound = preferences.completionSound;
  state.activeProjectId = preferences.activeProjectId;
  state.activeSessionPath = preferences.activeSessionPath;
  state.activeSessionId = preferences.activeSessionId;
  state.activeNodeId = preferences.activeNodeId;
  state.pinnedProjectIds = preferences.pinnedProjectIds || [];
  state.pinnedSessionPaths = preferences.pinnedSessionPaths || [];
  state.replicatedPinnedProjectIds = pins.projectIds || [];
  state.pinnedConversations = pins.conversations || [];
  state.recentSessions = recents.recentSessions || [];
  setPanelCollapsed("projects", Boolean(preferences.projectsPanelCollapsed));
  setPanelCollapsed("chats", Boolean(preferences.chatsPanelCollapsed));
  syncNotifyButton();
  updateInstallButton();
  state.canvasLayout = preferences.canvasLayout || emptyCanvasLayout();
  // The node normalizes on the way out; normalizing again costs nothing and keeps a
  // stale shape (or an older node) from reaching the dispatcher unvalidated.
  state.canvasKeymap = normalizeCanvasKeymap(preferences.canvasKeymap || DEFAULT_CANVAS_KEYMAP);
  if (!state.canvasPaneMode) {
    state.canvasController?.setKeymap(state.canvasKeymap);
    state.canvasController?.setLayout(state.canvasLayout);
    setMobileView(preferences.mobileView);
  }
  if (state.canvasPaneMode) {
    if (state.initialProjectId) state.activeProjectId = state.initialProjectId;
    if (state.initialSessionPath) state.activeSessionPath = state.initialSessionPath;
    if (state.initialSessionId) state.activeSessionId = state.initialSessionId;
    if (state.initialNodeId) state.activeNodeId = state.initialNodeId;
    setMobileView("chat", false);
  }
  revealApplication();
  await loadWorkspaces();
  await loadProjects();
  if (!state.canvasPaneMode) {
    void api("/api/cluster/projects/discover", { method: "POST" })
      .then(async (discovery) => {
        await loadWorkspaces();
        await refreshProjectsQuietly();
        if (discovery.pending.length) openProjectImportMapping(discovery.pending);
      })
      .catch((error) => console.warn("Could not discover peer projects", error));
  }
  if (!state.canvasPaneMode) setMobileView(preferences.mobileView);
  state.preferencesLoaded = true;
  if (!state.canvasPaneMode) {
    void showWhatsNew(preferences.lastSeenVersion).catch((error) => console.warn("Could not load the changelog", error));
  }
  if (state.initialProjectId || state.initialSessionPath) {
    savePreferencesInBackground({ activeProjectId: state.activeProjectId, activeSessionPath: state.activeSessionPath, activeSessionId: state.activeSessionId });
  }
  if (state.authenticated && !state.canvasPaneMode) startProjectSyncPolling();
}

async function submitLogin(event) {
  event.preventDefault();
  loginError();
  elements.loginSubmitButton.disabled = true;
  try {
    if (state.setupRequired) {
      const response = await api("/api/auth/setup", {
        method: "POST",
        body: JSON.stringify({ username: elements.loginUsernameInput.value.trim(), password: elements.newPasswordInput.value }),
      });
      applyAuthStatus({ authenticated: true, setupRequired: false, ...response });
      elements.newPasswordInput.value = "";
      elements.loginDialog.close();
      await initializeApplication();
      return;
    }
    if (state.mustChangePassword) {
      const changed = await api("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: elements.loginPasswordInput.value,
          newPassword: elements.newPasswordInput.value,
        }),
      });
      void changed;
      state.mustChangePassword = false;
      elements.newPasswordInput.value = "";
      elements.loginDialog.close();
      await initializeApplication();
      return;
    }
    const response = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: elements.loginUsernameInput.value.trim(), password: elements.loginPasswordInput.value }),
    });
    applyAuthStatus({ authenticated: true, setupRequired: false, ...response });
    if (state.mustChangePassword) return;
    elements.loginPasswordInput.value = "";
    elements.loginDialog.close();
    await initializeApplication();
  } catch (error) {
    loginError(error.message);
  } finally {
    elements.loginSubmitButton.disabled = false;
  }
}

export function renderLoginSessions(authSessions) {
  elements.settingsSessionList.replaceChildren();
  for (const session of authSessions.sessions) {
    const row = document.createElement("div");
    row.className = "settings-session-row";
    const details = document.createElement("span");
    details.textContent = `${session.id === authSessions.currentSessionId ? "Current session" : "Login session"} · ${formatDate(session.createdAt)}`;
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "ghost compact danger";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", async () => {
      try {
        await api(`/api/auth/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
        if (session.id === authSessions.currentSessionId) {
          showSignedOut();
          return;
        }
        renderLoginSessions(await api("/api/auth/sessions"));
      } catch (error) {
        toast(error.message);
      }
    });
    row.append(details, revoke);
    elements.settingsSessionList.append(row);
  }
}
elements.loginForm.addEventListener("submit", submitLogin);
