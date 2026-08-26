import { renderMarkdown } from "./markdown.js";
import { renderBoard } from "./board.js";

const state = {
  projects: [],
  sessions: [],
  skills: [],
  skillsLoading: false,
  pinnedProjectIds: [],
  pinnedSessionPaths: [],
  projectsLoading: true,
  projectsRefreshing: false,
  sessionsLoading: false,
  sessionsRefreshing: false,
  projectSyncTimer: null,
  tasks: [],
  editingTaskId: null,
  githubProjectId: null,
  mappingProjectId: null,
  pendingProjectImports: [],
  activeProjectImport: null,
  projectImportBrowserPath: null,
  projectImportParentPath: null,
  folderPickerPath: null,
  folderPickerParentPath: null,
  folderPickerApiPath: "/api/filesystem/directories",
  folderPickerTarget: null,
  projectDefaultBase: null,
  projectAutofilledPath: null,
  syncthingEndpoint: "",
  engine: "pi",
  safeguardsEnabled: true,
  sessionBusy: false,
  harnesses: [],
  sessionNodes: [],
  activeNodeId: null,
  activeSessionId: null,
  chatFilter: "all",
  watchSocket: null,
  watchReconnectTimer: null,
  watchPingTimer: null,
  activeProjectId: null,
  activeSessionPath: null,
  activeTaskId: null,
  socket: null,
  reconnectTimer: null,
  heartbeatTimer: null,
  lastPongAt: 0,
  assistantBubble: null,
  thinkingBubble: null,
  toolBubbles: new Map(),
  models: [],
  activeModelKey: "",
  activeModelLabel: "",
  thinkingLevel: "off",
  availableThinkingLevels: [],
  claudeEffort: "default",
  attachments: [],
  terminalSocket: null,
  terminalHistory: [],
  terminalHistoryIndex: 0,
  installPromptEvent: null,
  installDismissed: false,
  notificationsEnabled: false,
  completionSound: "chime",
  authenticated: false,
  username: "",
  setupRequired: false,
  mustChangePassword: false,
  lastTurnStartedAt: 0,
  stickToBottom: true,
  csrfToken: "",
  preferencesLoaded: false,
  initialProjectId: new URLSearchParams(location.search).get("projectId"),
  initialSessionPath: new URLSearchParams(location.search).get("sessionPath"),
};

const BOOT_MINIMUM_MS = 700;
const bootStartedAt = performance.now();
let bootRevealTimer = null;

const LEGACY_PREFERENCE_KEYS = [
  "piWebTheme",
  "piWebNotifications",
  "piWebInstallDismissed",
  "piWebActiveView",
  "piWebActiveProjectId",
  "piWebActiveSessionPath",
];

const elements = {
  projectList: document.querySelector("#projectList"),
  sessionList: document.querySelector("#sessionList"),
  projectsLoading: document.querySelector("#projectsLoading"),
  sessionsLoading: document.querySelector("#sessionsLoading"),
  projectSearchInput: document.querySelector("#projectSearchInput"),
  sessionSearchInput: document.querySelector("#sessionSearchInput"),
  projectName: document.querySelector("#projectName"),
  projectPath: document.querySelector("#projectPath"),
  sessionTitle: document.querySelector("#sessionTitle"),
  connectionStatus: document.querySelector("#connectionStatus"),
  messages: document.querySelector("#messages"),
  jumpLatestButton: document.querySelector("#jumpLatestButton"),
  composer: document.querySelector("#composer"),
  attachmentList: document.querySelector("#attachmentList"),
  attachmentInput: document.querySelector("#attachmentInput"),
  attachButton: document.querySelector("#attachButton"),
  messageInput: document.querySelector("#messageInput"),
  sendButton: document.querySelector("#sendButton"),
  miniStatus: document.querySelector("#miniStatus"),
  reconnectBanner: document.querySelector("#reconnectBanner"),
  reconnectBannerText: document.querySelector("#reconnectBannerText"),
  modelButton: document.querySelector("#modelButton"),
  safeguardsButton: document.querySelector("#safeguardsButton"),
  transferSessionButton: document.querySelector("#transferSessionButton"),
  openTerminalButton: document.querySelector("#openTerminalButton"),
  terminalDialog: document.querySelector("#terminalDialog"),
  terminalStatus: document.querySelector("#terminalStatus"),
  terminalOutput: document.querySelector("#terminalOutput"),
  terminalForm: document.querySelector("#terminalForm"),
  terminalInput: document.querySelector("#terminalInput"),
  terminalRunButton: document.querySelector("#terminalRunButton"),
  clearTerminalButton: document.querySelector("#clearTerminalButton"),
  closeTerminalButton: document.querySelector("#closeTerminalButton"),
  sessionTransferDialog: document.querySelector("#sessionTransferDialog"),
  sessionTransferForm: document.querySelector("#sessionTransferForm"),
  sessionTransferNodeSelect: document.querySelector("#sessionTransferNodeSelect"),
  cancelSessionTransferButton: document.querySelector("#cancelSessionTransferButton"),
  projectsPanel: document.querySelector("#projectsPanel"),
  chatsPanel: document.querySelector("#chatsPanel"),
  collapseProjectsButton: document.querySelector("#collapseProjectsButton"),
  expandProjectsButton: document.querySelector("#expandProjectsButton"),
  collapseChatsButton: document.querySelector("#collapseChatsButton"),
  expandChatsButton: document.querySelector("#expandChatsButton"),
  skillsDialog: document.querySelector("#skillsDialog"),
  skillsDialogList: document.querySelector("#skillsDialogList"),
  skillsDialogSearchInput: document.querySelector("#skillsDialogSearchInput"),
  closeSkillsDialogButton: document.querySelector("#closeSkillsDialogButton"),
  projectColorSwatches: document.querySelector("#projectColorSwatches"),
  modelDialog: document.querySelector("#modelDialog"),
  modelDialogTitle: document.querySelector("#modelDialogTitle"),
  modelDialogList: document.querySelector("#modelDialogList"),
  modelDialogReasoning: document.querySelector("#modelDialogReasoning"),
  modelDialogReasoningLabel: document.querySelector("#modelDialogReasoningLabel"),
  reasoningLevelSelect: document.querySelector("#reasoningLevelSelect"),
  closeModelDialogButton: document.querySelector("#closeModelDialogButton"),
  installAppButton: document.querySelector("#installAppButton"),
  notifyButton: document.querySelector("#notifyButton"),
  notificationToggleButton: document.querySelector("#notificationToggleButton"),
  completionSoundSelect: document.querySelector("#completionSoundSelect"),
  previewSoundButton: document.querySelector("#previewSoundButton"),
  renameSessionButton: document.querySelector("#renameSessionButton"),
  projectRenameDialog: document.querySelector("#projectRenameDialog"),
  projectRenameForm: document.querySelector("#projectRenameForm"),
  projectRenameInput: document.querySelector("#projectRenameInput"),
  projectGroupInput: document.querySelector("#projectGroupInput"),
  cancelProjectRenameButton: document.querySelector("#cancelProjectRenameButton"),
  abortButton: document.querySelector("#abortButton"),
  newProjectButton: document.querySelector("#newProjectButton"),
  themeToggleButton: document.querySelector("#themeToggleButton"),
  settingsButton: document.querySelector("#settingsButton"),
  settingsDialog: document.querySelector("#settingsDialog"),
  settingsForm: document.querySelector("#settingsForm"),
  cancelSettingsButton: document.querySelector("#cancelSettingsButton"),
  settingsUsername: document.querySelector("#settingsUsername"),
  settingsSessionList: document.querySelector("#settingsSessionList"),
  settingsLogoutButton: document.querySelector("#settingsLogoutButton"),
  settingsTabs: Array.from(document.querySelectorAll("[data-settings-tab]")),
  settingsPanels: Array.from(document.querySelectorAll(".settings-panel")),
  settingsRestartMessage: document.querySelector("#settingsRestartMessage"),
  settingsProjectHome: document.querySelector("#settingsProjectHome"),
  settingsProjectHomeBrowseButton: document.querySelector("#settingsProjectHomeBrowseButton"),
  settingsPiExecutable: document.querySelector("#settingsPiExecutable"),
  settingsPiConfigPath: document.querySelector("#settingsPiConfigPath"),
  settingsPiSessionPath: document.querySelector("#settingsPiSessionPath"),
  settingsClaudeExecutable: document.querySelector("#settingsClaudeExecutable"),
  settingsClaudeConfigPath: document.querySelector("#settingsClaudeConfigPath"),
  settingsClaudeSessionPath: document.querySelector("#settingsClaudeSessionPath"),
  clusterSaveButton: document.querySelector("#clusterSaveButton"),
  clusterInventory: document.querySelector("#clusterInventory"),
  clusterNodeNameInput: document.querySelector("#clusterNodeNameInput"),
  clusterNodeUrlInput: document.querySelector("#clusterNodeUrlInput"),
  clusterLocalToken: document.querySelector("#clusterLocalToken"),
  copyClusterLocalTokenButton: document.querySelector("#copyClusterLocalTokenButton"),
  clusterPeerUrlInput: document.querySelector("#clusterPeerUrlInput"),
  clusterPeerTokenInput: document.querySelector("#clusterPeerTokenInput"),
  projectImportDialog: document.querySelector("#projectImportDialog"),
  projectImportForm: document.querySelector("#projectImportForm"),
  projectImportTitle: document.querySelector("#projectImportTitle"),
  projectImportRemotePath: document.querySelector("#projectImportRemotePath"),
  projectImportPathInput: document.querySelector("#projectImportPathInput"),
  projectImportBrowseButton: document.querySelector("#projectImportBrowseButton"),
  projectImportBrowser: document.querySelector("#projectImportBrowser"),
  projectImportParentButton: document.querySelector("#projectImportParentButton"),
  projectImportCurrentPath: document.querySelector("#projectImportCurrentPath"),
  projectImportDirectoryList: document.querySelector("#projectImportDirectoryList"),
  projectImportUseFolderButton: document.querySelector("#projectImportUseFolderButton"),
  cancelProjectImportButton: document.querySelector("#cancelProjectImportButton"),
  skipProjectImportButton: document.querySelector("#skipProjectImportButton"),
  githubGroupList: document.querySelector("#githubGroupList"),
  githubGroupAddButton: document.querySelector("#githubGroupAddButton"),
  githubGroupDialog: document.querySelector("#githubGroupDialog"),
  githubGroupForm: document.querySelector("#githubGroupForm"),
  githubGroupTitle: document.querySelector("#githubGroupTitle"),
  githubGroupLabelInput: document.querySelector("#githubGroupLabelInput"),
  githubGroupTokenInput: document.querySelector("#githubGroupTokenInput"),
  githubGroupTokenState: document.querySelector("#githubGroupTokenState"),
  githubGroupDefaultInput: document.querySelector("#githubGroupDefaultInput"),
  cancelGithubGroupButton: document.querySelector("#cancelGithubGroupButton"),
  projectGithubDialog: document.querySelector("#projectGithubDialog"),
  projectGithubForm: document.querySelector("#projectGithubForm"),
  projectGithubTitle: document.querySelector("#projectGithubTitle"),
  projectGithubGroupInput: document.querySelector("#projectGithubGroupInput"),
  projectTypeList: document.querySelector("#projectTypeList"),
  projectTypeNameInput: document.querySelector("#projectTypeNameInput"),
  projectTypeAddButton: document.querySelector("#projectTypeAddButton"),
  projectGithubTokenInput: document.querySelector("#projectGithubTokenInput"),
  projectTokenState: document.querySelector("#projectTokenState"),
  clearProjectGithubTokenInput: document.querySelector("#clearProjectGithubTokenInput"),
  projectGithubSummary: document.querySelector("#projectGithubSummary"),
  cancelProjectGithubButton: document.querySelector("#cancelProjectGithubButton"),
  projectPathDialog: document.querySelector("#projectPathDialog"),
  projectPathForm: document.querySelector("#projectPathForm"),
  projectPathTitle: document.querySelector("#projectPathTitle"),
  projectHomeserverPathInput: document.querySelector("#projectHomeserverPathInput"),
  projectMacPathInput: document.querySelector("#projectMacPathInput"),
  cancelProjectPathButton: document.querySelector("#cancelProjectPathButton"),
  newSessionButton: document.querySelector("#newSessionButton"),
  projectDialog: document.querySelector("#projectDialog"),
  projectForm: document.querySelector("#projectForm"),
  cancelProjectButton: document.querySelector("#cancelProjectButton"),
  projectTypeInput: document.querySelector("#projectTypeInput"),
  projectNameInput: document.querySelector("#projectNameInput"),
  projectSourcePathInput: document.querySelector("#projectSourcePathInput"),
  projectSourceBrowseButton: document.querySelector("#projectSourceBrowseButton"),
  projectImportModeLabel: document.querySelector("#projectImportModeLabel"),
  projectImportModeInput: document.querySelector("#projectImportModeInput"),
  projectBasePathInput: document.querySelector("#projectBasePathInput"),
  projectMacBasePathInput: document.querySelector("#projectMacBasePathInput"),
  projectSaveButton: document.querySelector("#projectForm [data-testid='project-form-save-button']"),
  renameDialog: document.querySelector("#renameDialog"),
  renameForm: document.querySelector("#renameForm"),
  sessionNameInput: document.querySelector("#sessionNameInput"),
  cancelRenameButton: document.querySelector("#cancelRenameButton"),
  installBanner: document.querySelector("#installBanner"),
  installBannerButton: document.querySelector("#installBannerButton"),
  dismissInstallButton: document.querySelector("#dismissInstallButton"),
  navProjectsButton: document.querySelector("#navProjectsButton"),
  navSessionsButton: document.querySelector("#navSessionsButton"),
  navBoardButton: document.querySelector("#navBoardButton"),
  navChatButton: document.querySelector("#navChatButton"),
  backToProjectsButton: document.querySelector("#backToProjectsButton"),
  backToChatsButton: document.querySelector("#backToChatsButton"),
  backToSessionsButton: document.querySelector("#backToSessionsButton"),
  taskBacklinkButton: document.querySelector("#taskBacklinkButton"),
  openBoardButton: document.querySelector("#openBoardButton"),
  chatToolbar: document.querySelector("#chatToolbar"),
  chatMoreMenu: document.querySelector("#chatMoreMenu"),
  chatNodeSelect: document.querySelector("#chatNodeSelect"),
  chatHarnessSelect: document.querySelector("#chatHarnessSelect"),
  newClaudeSessionButton: document.querySelector("#newClaudeSessionButton"),
  chatsLiveDot: document.querySelector("#chatsLiveDot"),
  boardColumns: document.querySelector("#boardColumns"),
  boardProjectName: document.querySelector("#boardProjectName"),
  newTaskButton: document.querySelector("#newTaskButton"),
  taskDialog: document.querySelector("#taskDialog"),
  taskForm: document.querySelector("#taskForm"),
  taskDialogTitle: document.querySelector("#taskDialogTitle"),
  taskTitleInput: document.querySelector("#taskTitleInput"),
  taskDescriptionInput: document.querySelector("#taskDescriptionInput"),
  taskStatusInput: document.querySelector("#taskStatusInput"),
  taskEngineInput: document.querySelector("#taskEngineInput"),
  taskPlanModeInput: document.querySelector("#taskPlanModeInput"),
  taskReviewModeInput: document.querySelector("#taskReviewModeInput"),
  taskPlanningModelInput: document.querySelector("#taskPlanningModelInput"),
  taskImplementationModelInput: document.querySelector("#taskImplementationModelInput"),
  taskReviewModelInput: document.querySelector("#taskReviewModelInput"),
  chatFilters: document.querySelector("#chatFilters"),
  folderPickerDialog: document.querySelector("#folderPickerDialog"),
  folderPickerTitle: document.querySelector("#folderPickerTitle"),
  folderPickerParentButton: document.querySelector("#folderPickerParentButton"),
  folderPickerCurrentPath: document.querySelector("#folderPickerCurrentPath"),
  folderPickerDirectoryList: document.querySelector("#folderPickerDirectoryList"),
  folderPickerCancelButton: document.querySelector("#folderPickerCancelButton"),
  folderPickerUseButton: document.querySelector("#folderPickerUseButton"),
  deleteTaskButton: document.querySelector("#deleteTaskButton"),
  cancelTaskButton: document.querySelector("#cancelTaskButton"),
  loginDialog: document.querySelector("#loginDialog"),
  loginForm: document.querySelector("#loginForm"),
  loginMessage: document.querySelector("#loginMessage"),
  loginError: document.querySelector("#loginError"),
  loginUsernameInput: document.querySelector("#loginUsernameInput"),
  loginPasswordLabel: document.querySelector("#loginPasswordLabel"),
  loginPasswordInput: document.querySelector("#loginPasswordInput"),
  newPasswordLabel: document.querySelector("#newPasswordLabel"),
  newPasswordInput: document.querySelector("#newPasswordInput"),
  loginSubmitButton: document.querySelector("#loginSubmitButton"),
};

function headers() {
  return state.csrfToken ? { "X-CSRF-Token": state.csrfToken, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    if (response.status === 401 && path !== "/api/auth/status" && path !== "/api/auth/login") showSignedOut();
    throw new Error(body.error || response.statusText);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function savePreferences(partial) {
  return api("/api/preferences", { method: "PUT", body: JSON.stringify(partial) });
}

function savePreferencesInBackground(partial) {
  void savePreferences(partial).catch((error) => console.warn("Could not save preferences", error));
}

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

function showSignedOut() {
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

function revealApplication() {
  if (!document.body.classList.contains("booting") || bootRevealTimer) return;
  const delay = Math.max(0, BOOT_MINIMUM_MS - (performance.now() - bootStartedAt));
  if (delay) {
    bootRevealTimer = setTimeout(() => {
      bootRevealTimer = null;
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

async function initializeApplication() {
  const status = await api("/api/auth/status");
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
  let preferences = await api("/api/preferences");
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
  setPanelCollapsed("projects", Boolean(preferences.projectsPanelCollapsed));
  setPanelCollapsed("chats", Boolean(preferences.chatsPanelCollapsed));
  syncNotifyButton();
  updateInstallButton();
  setMobileView(preferences.mobileView);
  revealApplication();
  await loadProjectTypes();
  await loadProjects();
  void api("/api/cluster/projects/discover", { method: "POST" })
    .then(async (discovery) => {
      await loadProjectTypes();
      await refreshProjectsQuietly();
      if (discovery.pending.length) openProjectImportMapping(discovery.pending);
    })
    .catch((error) => console.warn("Could not discover peer projects", error));
  setMobileView(preferences.mobileView);
  state.preferencesLoaded = true;
  if (state.initialProjectId || state.initialSessionPath) {
    savePreferencesInBackground({ activeProjectId: state.activeProjectId, activeSessionPath: state.activeSessionPath, activeSessionId: state.activeSessionId });
  }
  if (state.authenticated) startProjectSyncPolling();
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

function renderLoginSessions(authSessions) {
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

/** Shows one settings panel and hides the rest, keeping the tablist's roving tabindex correct. */
function selectSettingsTab(name) {
  elements.settingsForm.dataset.tab = name;
  for (const tab of elements.settingsTabs) {
    const selected = tab.dataset.settingsTab === name;
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of elements.settingsPanels) panel.hidden = panel.id !== `settingsPanel-${name}`;
}

async function openSettings(tab = "account") {
  const [settings, authSessions] = await Promise.all([api("/api/settings"), api("/api/auth/sessions")]);
  elements.settingsUsername.textContent = state.username;
  selectSettingsTab(tab);
  await Promise.all([loadGithubGroups(), loadClusterPanel()]);
  await loadProjectTypes();
  renderLoginSessions(authSessions);
  elements.settingsRestartMessage.hidden = true;
  elements.settingsRestartMessage.textContent = "";
  elements.settingsProjectHome.value = settings.projects.homePath;
  elements.settingsPiExecutable.value = settings.pi.executable;
  elements.settingsPiConfigPath.value = settings.pi.configPath;
  elements.settingsPiSessionPath.value = settings.pi.sessionPath;
  elements.settingsClaudeExecutable.value = settings.claude.executable;
  elements.settingsClaudeConfigPath.value = settings.claude.configPath;
  elements.settingsClaudeSessionPath.value = settings.claude.sessionPath;
  state.syncthingEndpoint = settings.syncthing.endpoint;
  elements.completionSoundSelect.value = state.completionSound;
  syncNotifyButton();
  if (!elements.settingsDialog.open) elements.settingsDialog.showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  const saved = await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({
      pi: { executable: elements.settingsPiExecutable.value.trim(), configPath: elements.settingsPiConfigPath.value.trim(), sessionPath: elements.settingsPiSessionPath.value.trim() },
      claude: { executable: elements.settingsClaudeExecutable.value.trim(), configPath: elements.settingsClaudeConfigPath.value.trim(), sessionPath: elements.settingsClaudeSessionPath.value.trim() },
      syncthing: { endpoint: state.syncthingEndpoint },
      projects: { homePath: elements.settingsProjectHome.value.trim() },
    }),
  });
  const restartRequired = [
    ...(saved.restartRequired.pi ? ["Pi configuration"] : []),
    ...(saved.restartRequired.claude ? ["Claude configuration"] : []),
  ];
  elements.settingsRestartMessage.hidden = restartRequired.length === 0;
  elements.settingsRestartMessage.textContent = restartRequired.length ? `Restart required for ${restartRequired.join(" and ")} changes.` : "";
  if (!restartRequired.length) elements.settingsDialog.close();
  toast("Settings saved");
}

function toast(message, duration = 3200) {
  const node = document.createElement("div");
  node.className = "toast";
  node.setAttribute("role", "alert");
  node.setAttribute("aria-live", "assertive");
  node.textContent = message;
  const openDialog = document.querySelector("dialog[open]");
  (openDialog || document.body).append(node);
  setTimeout(() => node.remove(), duration);
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  if (state.preferencesLoaded) savePreferencesInBackground({ theme });

  const isDark = theme === "dark";
  elements.themeToggleButton.textContent = isDark ? "☀ Switch to light theme" : "☾ Switch to dark theme";
  elements.themeToggleButton.setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} theme`);
  elements.themeToggleButton.title = elements.themeToggleButton.getAttribute("aria-label");
  document.querySelector('meta[name="theme-color"]').content = isDark ? "#0d0e10" : "#f2f2f0";
}

function notificationsSupported() {
  return typeof Notification !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

function base64UrlToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function notificationPermissionGranted() {
  return notificationsSupported() && Notification.permission === "granted";
}

function syncNotifyButton() {
  const enabled = state.notificationsEnabled && notificationPermissionGranted();
  elements.notifyButton.setAttribute("aria-pressed", enabled ? "true" : "false");
  elements.notifyButton.title = enabled ? "Notifications on — tap to turn off" : "Notify when an agent finishes";
  elements.notifyButton.classList.toggle("active", enabled);
  elements.notificationToggleButton.setAttribute("aria-pressed", enabled ? "true" : "false");
  elements.notificationToggleButton.textContent = enabled ? "Browser notifications enabled" : state.notificationsEnabled ? "Enable notifications on this device" : "Enable browser notifications";
  elements.notificationToggleButton.classList.toggle("active", enabled);
}

async function enableNotifications() {
  if (!notificationsSupported()) {
    toast("Push notifications are not supported on this browser");
    return;
  }
  if (Notification.permission !== "granted") {
    if (Notification.permission === "denied") {
      toast("Notifications are blocked. Enable them in your browser settings.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toast("Notification permission was not granted");
      return;
    }
  }
  state.notificationsEnabled = true;
  if (state.preferencesLoaded) savePreferencesInBackground({ notificationsEnabled: true });

  syncNotifyButton();
  await subscribeToPush();
}

async function subscribeToPush() {
  if (!state.notificationsEnabled || !notificationPermissionGranted() || !state.activeProjectId) return;
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array((await api("/api/push/vapid-public-key")).publicKey),
  });
  await api("/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      projectId: state.activeProjectId,
      sessionPath: "*",
      title: "Joint Bob",
    }),
  });
}

async function disableNotifications() {
  state.notificationsEnabled = false;
  if (state.preferencesLoaded) savePreferencesInBackground({ notificationsEnabled: false });

  syncNotifyButton();
  if (!notificationsSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: subscription.endpoint }) });
  await subscription.unsubscribe();
}

async function maybeNotifyTurnComplete() {
  if (state.notificationsEnabled) await subscribeToPush();
}

async function playCompletionSound(sound = state.completionSound) {
  if (sound === "off" || typeof AudioContext === "undefined") return;
  const context = new AudioContext();
  await context.resume();
  const frequencies = sound === "bell" ? [523, 1046] : [659, 880];
  frequencies.forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const startsAt = context.currentTime + index * 0.12;
    oscillator.frequency.value = frequency;
    oscillator.type = sound === "bell" ? "sine" : "triangle";
    gain.gain.setValueAtTime(0.0001, startsAt);
    gain.gain.exponentialRampToValueAtTime(0.16, startsAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + 0.45);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(startsAt);
    oscillator.stop(startsAt + 0.46);
  });
  setTimeout(() => context.close(), 800);
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function updateInstallButton() {
  const canInstall = Boolean(state.installPromptEvent);
  elements.installAppButton.hidden = !canInstall;
  const dismissed = state.installDismissed === true;
  elements.installBanner.hidden = !canInstall || dismissed || isStandalone();
}

function setStatus(text, live = false, connecting = false) {
  elements.connectionStatus.textContent = text;
  elements.connectionStatus.classList.toggle("live", live);
  elements.connectionStatus.classList.toggle("connecting", connecting);
}

// One reusable strip under the transcript. Reconnect attempts repeat, so the
// indicator has to be a single toggled element rather than an appended block.
function setConnecting(active, text = "Connecting…") {
  elements.reconnectBannerText.textContent = text;
  elements.reconnectBanner.hidden = !active;
}

function setListLoading(listName, loading) {
  state[`${listName}Loading`] = loading;
  elements[`${listName}Loading`].hidden = !loading;
}

function formatDate(value) {
  if (!value) return "recent";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function shortSessionTitle(session) {
  const title = session?.title || "Pi session";
  if (!session?.path) return title;
  if (title && !title.endsWith(".jsonl") && title !== "Untitled Pi session") return title;
  return `Pi session • ${formatDate(session.updatedAt || session.createdAt)}`;
}

/**
 * Desktop-only: the mobile layout already shows a single panel at a time, so the
 * body class simply narrows one grid column down to the rail width.
 */
function setPanelCollapsed(panel, collapsed) {
  const panelElement = panel === "projects" ? elements.projectsPanel : elements.chatsPanel;
  document.body.classList.toggle(`${panel}-collapsed`, collapsed);
  panelElement.classList.toggle("collapsed", collapsed);
  if (!state.preferencesLoaded) return;
  if (panel === "projects") savePreferencesInBackground({ projectsPanelCollapsed: collapsed });
  else savePreferencesInBackground({ chatsPanelCollapsed: collapsed });
}

function setMobileView(view, updateHistory = true) {
  const currentView = history.state?.mobileView;
  if (state.preferencesLoaded) savePreferencesInBackground({ mobileView: view });

  document.body.classList.remove("view-projects", "view-sessions", "view-board", "view-chat");
  document.body.classList.add(`view-${view}`);
  for (const [name, button] of [
    ["projects", elements.navProjectsButton],
    ["sessions", elements.navSessionsButton],
    ["board", elements.navBoardButton],
    ["chat", elements.navChatButton],
  ]) {
    button.classList.toggle("active", name === view);
  }
  if (updateHistory && currentView !== view) history.pushState({ ...history.state, mobileView: view }, "");
}

history.replaceState({ ...history.state, mobileView: "projects" }, "");
window.addEventListener("popstate", (event) => {
  if (event.state?.mobileView) setMobileView(event.state.mobileView, false);
});

function selectedProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || null;
}

function normalizedQuery(value) {
  return value.trim().toLowerCase();
}

function sessionChatState(session) {
  if (session.running || session.reviewState === "running") return "active";
  if (session.reviewState === "needs_review") return "review";
  return "done";
}

function updateChatFilterCounts() {
  const counts = { all: state.sessions.length, active: 0, review: 0, done: 0 };
  for (const session of state.sessions) counts[sessionChatState(session)] += 1;
  for (const count of elements.chatFilters.querySelectorAll("[data-filter-count]")) {
    count.textContent = counts[count.dataset.filterCount];
  }
}

function filteredSessions() {
  const query = normalizedQuery(elements.sessionSearchInput.value || "");
  return state.sessions.filter((session) => {
    const searchableText = `${shortSessionTitle(session)}\n${session.firstMessage || ""}\n${session.path || ""}`.toLowerCase();
    if (query && !searchableText.includes(query)) return false;
    return state.chatFilter === "all" || sessionChatState(session) === state.chatFilter;
  });
}

function filteredProjects() {
  const query = normalizedQuery(elements.projectSearchInput.value || "");
  if (!query) return state.projects;
  return state.projects.filter((project) => `${project.name}\n${project.path}`.toLowerCase().includes(query));
}

function isTextAttachment(file) {
  return file.type.startsWith("text/") || /\.(txt|md|markdown|json|ya?ml|csv|tsv|log|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|css|scss|html|xml|sh|env)$/i.test(file.name);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(`${reader.result || ""}`);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function fileToText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(`${reader.result || ""}`);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}

function resetAttachmentInput() {
  elements.attachmentInput.value = "";
}

function renderAttachments() {
  elements.attachmentList.replaceChildren();
  for (const attachment of state.attachments) {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    const label = document.createElement("span");
    label.textContent = attachment.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${attachment.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.attachments = state.attachments.filter((item) => item.id !== attachment.id);
      renderAttachments();
    });
    chip.append(label, remove);
    elements.attachmentList.append(chip);
  }
}

async function addAttachments(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const nextAttachments = [];
  for (const file of files) {
    if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name} is too large. Keep files under 4MB.`);
    if (file.type.startsWith("image/")) {
      const dataUrl = await fileToDataUrl(file);
      const [, data = ""] = dataUrl.split(",", 2);
      nextAttachments.push({ id: crypto.randomUUID(), kind: "image", name: file.name, mimeType: file.type || "image/png", data });
      continue;
    }
    if (isTextAttachment(file)) {
      const content = await fileToText(file);
      nextAttachments.push({ id: crypto.randomUUID(), kind: "text", name: file.name, mimeType: file.type || "text/plain", content: content.slice(0, 120000) });
      continue;
    }
    throw new Error(`${file.name} is not supported yet. Attach images or text/code files.`);
  }
  state.attachments = [...state.attachments, ...nextAttachments];
  renderAttachments();
  resetAttachmentInput();
}

function clearAttachments() {
  state.attachments = [];
  renderAttachments();
  resetAttachmentInput();
}

function showNextProjectImport() {
  state.activeProjectImport = state.pendingProjectImports.shift() || null;
  if (!state.activeProjectImport) {
    elements.projectImportDialog.close();
    toast("Project mappings saved");
    return;
  }
  const pending = state.activeProjectImport;
  elements.projectImportTitle.textContent = `Map ${pending.name} on this node`;
  elements.projectImportRemotePath.textContent = `Remote folder: ${pending.remotePath}`;
  elements.projectImportPathInput.value = pending.suggestedPath;
  elements.projectImportBrowser.hidden = true;
  if (!elements.projectImportDialog.open) elements.projectImportDialog.showModal();
}

function openProjectImportMapping(pendingProjects) {
  state.pendingProjectImports = [...pendingProjects];
  showNextProjectImport();
}

async function loadFolderPickerDirectory(requestedPath) {
  const query = requestedPath ? `?path=${encodeURIComponent(requestedPath)}` : "";
  const listing = await api(`${state.folderPickerApiPath}${query}`);
  state.folderPickerPath = listing.currentPath;
  state.folderPickerParentPath = listing.parentPath;
  elements.folderPickerCurrentPath.textContent = listing.currentPath;
  elements.folderPickerParentButton.disabled = !listing.parentPath;
  elements.folderPickerDirectoryList.replaceChildren();
  for (const directory of listing.directories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "folder-browser-entry";
    button.dataset.testid = "folder-picker-directory-button";
    button.textContent = directory.name;
    button.addEventListener("click", () => loadFolderPickerDirectory(directory.path).catch((error) => toast(error.message, 8000)));
    elements.folderPickerDirectoryList.append(button);
  }
}

async function openFolderPicker(target, title, apiPath = "/api/filesystem/directories") {
  state.folderPickerTarget = target;
  state.folderPickerApiPath = apiPath;
  elements.folderPickerTitle.textContent = title;
  try {
    await loadFolderPickerDirectory(target.value.trim());
  } catch {
    const parentPath = target.value.trim().replace(/\/[^/]+\/?$/, "");
    try { await loadFolderPickerDirectory(parentPath); }
    catch { await loadFolderPickerDirectory(); }
  }
  elements.folderPickerDialog.showModal();
}

async function loadProjectImportDirectory(requestedPath) {
  const query = requestedPath ? `?path=${encodeURIComponent(requestedPath)}` : "";
  const listing = await api(`/api/filesystem/directories${query}`);
  state.projectImportBrowserPath = listing.currentPath;
  state.projectImportParentPath = listing.parentPath;
  elements.projectImportCurrentPath.textContent = listing.currentPath;
  elements.projectImportParentButton.disabled = !listing.parentPath;
  elements.projectImportDirectoryList.replaceChildren();
  for (const directory of listing.directories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "folder-browser-entry";
    button.dataset.testid = "project-import-directory-button";
    button.textContent = directory.name;
    button.addEventListener("click", () => loadProjectImportDirectory(directory.path).catch((error) => toast(error.message, 8000)));
    elements.projectImportDirectoryList.append(button);
  }
  elements.projectImportBrowser.hidden = false;
}

function renderClusterInventory(inventory) {
  elements.clusterInventory.replaceChildren();
  const nodes = [
    { node: inventory.local, status: "Local" },
    ...inventory.remote.map((entry) => ({
      node: entry.inventory?.node || { name: entry.peerId },
      status: entry.reachable ? "Online" : `Offline — ${entry.error}`,
      peerId: entry.peerId,
      reachable: entry.reachable,
    })),
  ];
  for (const item of nodes) {
    const row = document.createElement("div");
    row.className = "cluster-node";
    const name = document.createElement("strong");
    name.textContent = item.node.name;
    const status = document.createElement("span");
    status.textContent = item.status;
    row.append(name, status);
    if (item.peerId && item.reachable) {
      const importButton = document.createElement("button");
      importButton.type = "button";
      importButton.className = "ghost compact";
      importButton.textContent = "Import projects";
      importButton.addEventListener("click", async () => {
        try {
          const result = await api("/api/cluster/projects/import", { method: "POST", body: JSON.stringify({ peerId: item.peerId }) });
          toast(`Imported ${result.imported.length} projects${result.pending.length ? `; ${result.pending.length} need a local folder` : ""}${result.skipped.length ? `; skipped ${result.skipped.length}` : ""}`);
          await loadProjects();
          renderClusterInventory(await api("/api/cluster/inventory"));
          if (result.pending.length) {
            elements.settingsDialog.close();
            openProjectImportMapping(result.pending);
          }
        } catch (error) {
          toast(error.message);
        }
      });
      row.append(importButton);
    }
    elements.clusterInventory.append(row);
  }
}

async function loadClusterPanel() {
  const [inventory, invite] = await Promise.all([api("/api/cluster/inventory"), api("/api/cluster/invite")]);
  elements.clusterNodeNameInput.value = inventory.local.name;
  elements.clusterNodeUrlInput.value = inventory.local.url;
  elements.clusterLocalToken.value = invite.token;
  elements.clusterPeerUrlInput.value = "";
  elements.clusterPeerTokenInput.value = "";
  renderClusterInventory(inventory);
}

async function saveClusterNode() {
  await api("/api/cluster/node", {
    method: "PUT",
    body: JSON.stringify({ name: elements.clusterNodeNameInput.value.trim(), url: elements.clusterNodeUrlInput.value.trim() }),
  });
  const peerUrl = elements.clusterPeerUrlInput.value.trim();
  const peerToken = elements.clusterPeerTokenInput.value.trim();
  if (peerUrl || peerToken) {
    if (!peerUrl) throw new Error("Peer URL is required");
    await api("/api/cluster/peers", { method: "POST", body: JSON.stringify({ name: peerUrl, url: peerUrl, token: peerToken }) });
  }
  await loadClusterPanel();
  toast(peerUrl ? "Node saved and peer paired" : "Node saved");
}

let githubGroups = [];

async function loadGithubGroups() {
  githubGroups = (await api("/api/github-auth")).groups;
  renderGithubGroups();
}

function renderGithubGroups() {
  elements.githubGroupList.replaceChildren();
  if (!githubGroups.length) {
    const empty = document.createElement("p");
    empty.className = "github-group-empty";
    empty.textContent = "No groups yet. Add one to give projects a GitHub token.";
    elements.githubGroupList.append(empty);
    return;
  }
  for (const group of githubGroups) {
    const row = document.createElement("div");
    row.className = "github-group-row";
    row.dataset.testid = "github-group-row";

    const name = document.createElement("strong");
    name.textContent = group.label;
    row.append(name);

    if (group.isDefault) {
      const badge = document.createElement("span");
      badge.className = "github-group-default";
      badge.textContent = "Default";
      row.append(badge);
    }

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "ghost compact";
    edit.textContent = "Edit";
    edit.dataset.testid = "github-group-edit-button";
    edit.addEventListener("click", () => openGithubGroupDialog(group));
    row.append(edit);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost compact danger";
    remove.textContent = "Delete";
    remove.dataset.testid = "github-group-delete-button";
    remove.addEventListener("click", async () => {
      if (!confirm(`Delete "${group.label}"? Projects using it lose GitHub access until you reassign them.`)) return;
      try {
        await api(`/api/github-auth/groups/${encodeURIComponent(group.id)}`, { method: "DELETE" });
        await loadGithubGroups();
        toast(`Deleted ${group.label}`);
      } catch (error) {
        toast(error.message);
      }
    });
    row.append(remove);

    elements.githubGroupList.append(row);
  }
}

let projectTypes = [];

async function loadProjectTypes() {
  projectTypes = (await api("/api/project-types")).types;
  renderProjectTypes();
  fillProjectTypeSelect();
}

/** Keeps the create-project picker in step with the types configured in Settings. */
function fillProjectTypeSelect() {
  const previous = elements.projectTypeInput.value;
  elements.projectTypeInput.replaceChildren();
  for (const type of projectTypes) {
    const option = document.createElement("option");
    option.value = type.id;
    option.textContent = type.label;
    elements.projectTypeInput.append(option);
  }
  elements.projectTypeInput.value = projectTypes.some((type) => type.id === previous) ? previous : projectTypes[0]?.id ?? "";
}

function projectTypeGroupPicker(type) {
  const picker = document.createElement("select");
  picker.dataset.testid = "project-type-group-select";
  picker.setAttribute("aria-label", `GitHub group for ${type.label}`);
  const fallback = document.createElement("option");
  fallback.value = "";
  fallback.textContent = "Default group";
  picker.append(fallback);
  for (const group of githubGroups) {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = group.label;
    picker.append(option);
  }
  picker.value = type.githubGroup || "";
  picker.addEventListener("change", async () => {
    try {
      await api("/api/project-types", {
        method: "PUT",
        body: JSON.stringify({ id: type.id, label: type.label, githubGroup: picker.value || null }),
      });
      await loadProjectTypes();
    } catch (error) {
      toast(error.message);
    }
  });
  return picker;
}

function renderProjectTypes() {
  elements.projectTypeList.replaceChildren();
  if (!projectTypes.length) {
    const empty = document.createElement("p");
    empty.className = "project-type-empty";
    empty.textContent = "No project types yet. Add one to choose where new projects land.";
    elements.projectTypeList.append(empty);
    return;
  }
  for (const type of projectTypes) {
    const row = document.createElement("div");
    row.className = "project-type-row";
    row.dataset.testid = "project-type-row";

    const name = document.createElement("strong");
    name.textContent = type.label;
    row.append(name);

    const folder = document.createElement("code");
    folder.textContent = `/${type.id}`;
    row.append(folder);

    row.append(projectTypeGroupPicker(type));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost compact danger";
    remove.textContent = "Delete";
    remove.dataset.testid = "project-type-delete-button";
    remove.addEventListener("click", async () => {
      if (!confirm(`Delete the "${type.label}" project type? Its folder stays on disk.`)) return;
      try {
        await api(`/api/project-types/${encodeURIComponent(type.id)}`, { method: "DELETE" });
        await loadProjectTypes();
        toast(`Deleted ${type.label}`);
      } catch (error) {
        toast(error.message);
      }
    });
    row.append(remove);

    elements.projectTypeList.append(row);
  }
}

async function addProjectType() {
  const label = elements.projectTypeNameInput.value.trim();
  if (!label) return;
  await api("/api/project-types", { method: "PUT", body: JSON.stringify({ label }) });
  elements.projectTypeNameInput.value = "";
  await loadProjectTypes();
  toast(`Added ${label}`);
}

let editingGithubGroup = null;

function openGithubGroupDialog(group = null) {
  editingGithubGroup = group;
  elements.githubGroupTitle.textContent = group ? `Edit ${group.label}` : "Add GitHub group";
  elements.githubGroupLabelInput.value = group?.label || "";
  elements.githubGroupTokenInput.value = "";
  elements.githubGroupTokenInput.placeholder = group ? "Leave blank to keep current token" : "Paste a GitHub token";
  elements.githubGroupTokenState.textContent = group ? "Token saved" : "";
  elements.githubGroupDefaultInput.checked = group ? Boolean(group.isDefault) : !githubGroups.length;
  elements.githubGroupDialog.showModal();
  elements.githubGroupLabelInput.focus();
}

function openProjectPathMapping(project) {
  state.mappingProjectId = project.id;
  elements.projectPathTitle.textContent = `${project.name} session paths`;
  elements.projectHomeserverPathInput.value = project.path;
  elements.projectMacPathInput.value = project.macPath || "";
  elements.projectPathDialog.showModal();
}

async function openProjectGithubSettings(project) {
  const [status] = await Promise.all([api(`/api/projects/${encodeURIComponent(project.id)}/github-auth`), loadGithubGroups()]);
  state.githubProjectId = project.id;
  elements.projectGithubTitle.textContent = `${project.name} GitHub access`;
  elements.projectGithubGroupInput.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "Inherit from the project type";
  elements.projectGithubGroupInput.append(none);
  for (const group of githubGroups) {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = group.isDefault ? `${group.label} (default)` : group.label;
    elements.projectGithubGroupInput.append(option);
  }
  elements.projectGithubGroupInput.value = status.project.group || "";
  elements.projectGithubTokenInput.value = "";
  elements.clearProjectGithubTokenInput.checked = false;
  elements.projectTokenState.textContent = status.project.hasOverride ? "Override saved" : "Inherited token";
  elements.projectGithubSummary.textContent = status.project.configured ? "GitHub access configured." : "No token resolves for this project yet.";
  elements.projectGithubDialog.showModal();
}

let projectPendingRename = null;

function renderProjectColorSwatches(selected) {
  elements.projectColorSwatches.replaceChildren();
  for (const color of [null, ...PROJECT_COLORS]) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = `color-swatch${color ? "" : " color-swatch-none"}${selected === color ? " selected" : ""}`;
    swatch.dataset.testid = "project-color-swatch";
    swatch.dataset.colorValue = color || "";
    swatch.setAttribute("role", "radio");
    swatch.setAttribute("aria-checked", String(selected === color));
    swatch.setAttribute("aria-label", color || "No colour");
    swatch.title = color || "No colour";
    if (color) swatch.dataset.color = color;
    swatch.addEventListener("click", () => renderProjectColorSwatches(color));
    elements.projectColorSwatches.append(swatch);
  }
}

function selectedProjectColor() {
  const selected = elements.projectColorSwatches.querySelector(".color-swatch.selected");
  return selected?.dataset.colorValue || null;
}

function openProjectRename(project) {
  projectPendingRename = project;
  elements.projectRenameInput.value = project.name;
  renderProjectColorSwatches(project.color || null);
  elements.projectGroupInput.replaceChildren();
  for (const type of projectTypes) {
    const option = document.createElement("option");
    option.value = type.id;
    option.textContent = type.label;
    elements.projectGroupInput.append(option);
  }
  elements.projectGroupInput.value = project.type;
  elements.projectRenameDialog.showModal();
}

async function renameActiveSession(title) {
  const sessionPath = state.activeSessionPath;
  if (!state.activeProjectId || !sessionPath) return;
  await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions/title`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionPath, title }),
  });
  // Pi keeps its own live session name, so mirror it while the socket is open.
  if (!sessionPath.startsWith("claude:") && title) sendSocket({ type: "rename", name: title });
  await loadSessions();
}

/** The fixed palette mirrors PROJECT_COLORS in src/types.ts. */
const PROJECT_COLORS = ["slate", "teal", "blue", "violet", "magenta", "amber", "green", "red"];

function isProjectPinned(projectId) {
  return state.pinnedProjectIds.includes(projectId);
}

function isSessionPinned(sessionPath) {
  return state.pinnedSessionPaths.includes(sessionPath);
}

/** Stable within each side of the split, so pinning never reshuffles the rest of the list. */
function sortPinnedFirst(items, isPinned) {
  return [...items.filter(isPinned), ...items.filter((item) => !isPinned(item))];
}

function togglePinnedProject(projectId) {
  state.pinnedProjectIds = isProjectPinned(projectId)
    ? state.pinnedProjectIds.filter((id) => id !== projectId)
    : [...state.pinnedProjectIds, projectId];
  if (state.preferencesLoaded) savePreferencesInBackground({ pinnedProjectIds: state.pinnedProjectIds });
  renderProjects();
}

function togglePinnedSession(sessionPath) {
  state.pinnedSessionPaths = isSessionPinned(sessionPath)
    ? state.pinnedSessionPaths.filter((path) => path !== sessionPath)
    : [...state.pinnedSessionPaths, sessionPath];
  if (state.preferencesLoaded) savePreferencesInBackground({ pinnedSessionPaths: state.pinnedSessionPaths });
  renderSessions();
}

function pinButton({ pinned, label, testid, onToggle }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `ghost icon-button row-action-button pin-button${pinned ? " pinned" : ""}`;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(pinned));
  button.title = label;
  button.textContent = "\u{1F4CC}";
  button.dataset.testid = testid;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onToggle();
  });
  return button;
}

function renderProjects() {
  const projects = filteredProjects();
  elements.projectList.replaceChildren();
  if (state.projectsLoading) return;
  if (state.projects.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No projects yet.";
    elements.projectList.append(empty);
    return;
  }
  if (projects.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No matching projects.";
    elements.projectList.append(empty);
    return;
  }

  for (const group of groupedProjects(projects)) {
    elements.projectList.append(projectGroupElement(group));
  }
}

/** Remembered for this page view only — preferences live on the server and Web Storage is banned here. */
const collapsedProjectGroups = new Set();

/** Groups follow the order types are configured in Settings; anything unknown sorts last. */
function groupedProjects(projects) {
  const byType = new Map();
  for (const project of projects) {
    const typeId = project.type || "personal";
    if (!byType.has(typeId)) byType.set(typeId, []);
    byType.get(typeId).push(project);
  }
  const configured = projectTypes.map((type) => type.id).filter((typeId) => byType.has(typeId));
  const unknown = [...byType.keys()].filter((typeId) => !configured.includes(typeId)).sort();
  return [...configured, ...unknown].map((typeId) => ({
    id: typeId,
    label: projectTypes.find((type) => type.id === typeId)?.label || typeId,
    projects: sortPinnedFirst(byType.get(typeId), (project) => isProjectPinned(project.id)),
  }));
}

/** A native <details> so collapsing, keyboard support, and accessibility come for free. */
function projectGroupElement(group) {
  const details = document.createElement("details");
  details.className = "project-group";
  details.dataset.testid = "project-group";
  details.dataset.projectType = group.id;
  details.open = !collapsedProjectGroups.has(group.id);
  details.addEventListener("toggle", () => {
    if (details.open) collapsedProjectGroups.delete(group.id);
    else collapsedProjectGroups.add(group.id);
  });

  const summary = document.createElement("summary");
  summary.className = "project-group-summary";
  summary.dataset.testid = "project-group-toggle";
  const label = document.createElement("span");
  label.textContent = group.label;
  const count = document.createElement("span");
  count.className = "project-group-count";
  count.textContent = String(group.projects.length);
  summary.append(label, count);
  details.append(summary);

  for (const project of group.projects) details.append(projectRow(project));
  return details;
}

function projectRescanButton(project) {
  const rescanButton = document.createElement("button");
  rescanButton.type = "button";
  rescanButton.className = "ghost icon-button row-action-button rescan-button";
  rescanButton.setAttribute("aria-label", `Rescan ${project.name}`);
  rescanButton.title = project.syncFolderId ? "Rescan project with Syncthing" : "Project is not synchronized with Syncthing";
  rescanButton.textContent = "↻";
  rescanButton.disabled = !project.syncFolderId;
  rescanButton.dataset.testid = "project-rescan-button";
  rescanButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!project.syncFolderId) return;
    rescanButton.disabled = true;
    rescanButton.textContent = "…";
    toast(`Rescanning ${project.name}`);
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}/sync/rescan`, { method: "POST" });
      await refreshProjectsQuietly();
      toast(`Rescan complete for ${project.name}`);
    } catch (error) {
      toast(error.message, 8000);
    } finally {
      rescanButton.textContent = "↻";
      rescanButton.disabled = !project.syncFolderId;
    }
  });
  return rescanButton;
}

function projectRow(project) {
    const pinned = isProjectPinned(project.id);
    const row = document.createElement("div");
    row.className = `list-row${project.id === state.activeProjectId ? " active" : ""}`;
    if (project.color) row.dataset.color = project.color;

    const button = document.createElement("button");
    button.type = "button";
    button.className = `project-card${project.id === state.activeProjectId ? " active" : ""}${pinned ? " pinned" : ""}`;
    if (project.color) button.dataset.color = project.color;
    const name = document.createElement("strong");
    name.textContent = project.name;
    const projectPath = document.createElement("span");
    projectPath.textContent = project.path;
    // The sync status is a sibling of the path, not a child: the path truncates,
    // and a truncated path used to swallow the status entirely.
    const syncStatus = document.createElement("em");
    const status = project.syncStatus || { state: "unavailable", message: "Syncthing status is unavailable" };
    const syncLabels = { synced: "Synced", syncing: "Syncing", paused: "Paused", error: "Error", unavailable: "Unavailable" };
    syncStatus.className = `project-sync-status project-sync-status-${status.state}`;
    syncStatus.dataset.testid = "project-sync-status";
    syncStatus.textContent = status.state === "error" && status.message ? `Error: ${status.message}` : syncLabels[status.state] || syncLabels.unavailable;
    syncStatus.title = status.message || "";
    button.append(name, projectPath, syncStatus);
    button.addEventListener("click", () => selectProject(project.id));

    const pinToggle = pinButton({
      pinned,
      label: pinned ? `Unpin ${project.name}` : `Pin ${project.name}`,
      testid: "project-pin-button",
      onToggle: () => togglePinnedProject(project.id),
    });

    const rescanButton = projectRescanButton(project);

    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.className = "ghost icon-button row-action-button rename-button";
    renameButton.setAttribute("aria-label", `Edit ${project.name}`);
    renameButton.title = "Edit project";
    renameButton.textContent = "✎";
    renameButton.dataset.testid = "project-rename-button";
    renameButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openProjectRename(project);
    });

    const mappingButton = document.createElement("button");
    mappingButton.type = "button";
    mappingButton.className = "ghost icon-button row-action-button mapping-button";
    mappingButton.setAttribute("aria-label", `View session paths for ${project.name}`);
    mappingButton.title = "Session path mappings";
    mappingButton.textContent = "↔";
    mappingButton.dataset.testid = "project-path-mapping-button";
    mappingButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openProjectPathMapping(project);
    });

    const authButton = document.createElement("button");
    authButton.type = "button";
    authButton.className = "ghost icon-button row-action-button credential-button";
    authButton.setAttribute("aria-label", `Configure GitHub access for ${project.name}`);
    authButton.title = "GitHub access";
    authButton.textContent = "GH";
    authButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      await openProjectGithubSettings(project);
    });

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "ghost danger icon-button row-action-button";
    removeButton.setAttribute("aria-label", `Remove ${project.name}`);
    removeButton.title = "Remove project";
    removeButton.textContent = "✕";
    removeButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!confirm(`Remove ${project.name} from Joint Bob? Files are not deleted.`)) return;
      await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
      if (state.activeProjectId === project.id) {
        state.activeProjectId = null;
        state.activeSessionPath = null;
        state.activeSessionId = null;
        state.activeTaskId = null;
        if (state.preferencesLoaded) savePreferencesInBackground({ activeProjectId: null, activeSessionPath: null, activeSessionId: null });
        state.sessions = [];
        state.tasks = [];
        closeWatchSocket();
        renderBoardView();
      }
      await loadProjects();
    });

    row.append(button, pinToggle, rescanButton, renameButton, mappingButton, authButton, removeButton);
    return row;
}

function markSessionReviewed(session) {
  if (session.reviewState !== "needs_review" || session.running) return;
  session.reviewState = "reviewed";
  renderSessions();
  void api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions/reviewed`, {
    method: "PUT",
    body: JSON.stringify({ sessionPath: session.path }),
  }).catch((error) => {
    session.reviewState = "needs_review";
    renderSessions();
    toast(error.message);
  });
}

function openListedSession(session) {
  markSessionReviewed(session);
  state.activeSessionId = session.id;
  state.activeTaskId = session.taskId || null;
  openSession(session.path, shortSessionTitle(session), false, Boolean(state.activeTaskId));
}

function renderSessions() {
  elements.sessionList.replaceChildren();
  renderChatSessionControls();
  const project = selectedProject();
  elements.projectName.textContent = project?.name || "No project selected";
  elements.projectPath.textContent = project?.path || "Create or select a local folder.";
  elements.newSessionButton.disabled = !project || !state.sessionNodes.length;
  elements.newClaudeSessionButton.disabled = !project || !state.sessionNodes.length;
  updateChatFilterCounts();

  if (!project || state.sessionsLoading) return;
  const sessions = filteredSessions();
  if (state.sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No conversations yet. Start a Pi or Claude chat above.";
    elements.sessionList.append(empty);
    return;
  }
  if (sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = normalizedQuery(elements.sessionSearchInput.value || "")
      ? "No matching conversations."
      : `No ${state.chatFilter} conversations.`;
    elements.sessionList.append(empty);
    return;
  }

  for (const session of sortPinnedFirst(sessions, (candidate) => isSessionPinned(candidate.path))) {
    const sessionPinned = isSessionPinned(session.path);
    const row = document.createElement("div");
    const sessionActive = state.activeSessionId ? session.id === state.activeSessionId : session.path === state.activeSessionPath;
    row.className = `list-row${sessionActive ? " active" : ""}`;

    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-card${sessionActive ? " active" : ""}${sessionPinned ? " pinned" : ""}`;
    const sessionName = document.createElement("strong");
    sessionName.textContent = shortSessionTitle(session);
    const meta = document.createElement("span");
    meta.textContent = formatDate(session.updatedAt || session.createdAt);
    const agent = document.createElement("em");
    agent.className = "session-agent-label";
    agent.dataset.testid = "session-agent-label";
    agent.textContent = `${session.agentLabel}${session.agentModel ? ` · ${session.agentModel}` : ""}`;
    meta.append(" ", agent);
    button.append(sessionName, meta);
    const chatState = sessionChatState(session);
    const badge = document.createElement("em");
    badge.className = `chat-badge chat-badge-${chatState}`;
    const dot = document.createElement("i");
    dot.className = "chat-status-dot";
    dot.setAttribute("aria-hidden", "true");
    const statusLabel = document.createElement("b");
    statusLabel.textContent = chatState === "active" ? "Running" : chatState === "review" ? "Needs review" : "Reviewed";
    badge.append(dot, statusLabel);
    meta.append(" ", badge);
    button.addEventListener("click", () => openListedSession(session));

    const pinToggle = pinButton({
      pinned: sessionPinned,
      label: sessionPinned ? `Unpin ${shortSessionTitle(session)}` : `Pin ${shortSessionTitle(session)}`,
      testid: "session-pin-button",
      onToggle: () => togglePinnedSession(session.path),
    });

    const transferButton = document.createElement("button");
    transferButton.type = "button";
    transferButton.className = "ghost icon-button row-action-button transfer-button";
    transferButton.setAttribute("aria-label", `Transfer ${shortSessionTitle(session)}`);
    transferButton.title = session.path.startsWith("claude:") ? "Claude transfer is not available yet" : "Transfer this idle Pi session";
    transferButton.textContent = "↗";
    transferButton.disabled = session.path.startsWith("claude:");
    transferButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        const peers = (await api("/api/cluster/peers")).peers;
        if (!peers.length) throw new Error("Pair a destination node first");
        const peer = peers.length === 1
          ? peers[0]
          : peers.find((candidate) => candidate.id === prompt(`Destination node ID:\n${peers.map((candidate) => `${candidate.name}: ${candidate.id}`).join("\n")}`));
        if (!peer) return;
        if (!confirm(`Transfer this idle Pi session to ${peer.name}?`)) return;
        const result = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions/transfer`, {
          method: "POST",
          body: JSON.stringify({ peerId: peer.id, sessionPath: session.path, sessionName: shortSessionTitle(session) }),
        });
        toast(`Transferred to ${peer.name}: ${result.sessionPath || "ready"}`);
      } catch (error) {
        toast(error.message);
      }
    });

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "ghost danger icon-button row-action-button";
    removeButton.setAttribute("aria-label", `Remove ${shortSessionTitle(session)}`);
    removeButton.title = "Remove session";
    removeButton.textContent = "✕";
    removeButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!confirm(`Remove session \"${shortSessionTitle(session)}\"?`)) return;
      await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions?sessionPath=${encodeURIComponent(session.path)}`, { method: "DELETE" });
      if (sessionActive) {
        state.activeTaskId = null;
        closeSocket();
        clearChat();
        clearAttachments();
        state.activeSessionPath = null;
        state.activeSessionId = null;
        if (state.preferencesLoaded) savePreferencesInBackground({ activeSessionPath: null, activeSessionId: null });
        elements.sessionTitle.textContent = "Select a conversation";
        setComposerEnabled(false);
        setMobileView("sessions");
      }
      await refreshSessionsQuietly();
    });

    row.append(button, pinToggle, transferButton, removeButton);
    elements.sessionList.append(row);
  }
}

function clearThinkingBubble() {
  if (state.thinkingBubble) {
    state.thinkingBubble.remove();
    state.thinkingBubble = null;
  }
}

function showChatEmptyState(title, copy) {
  elements.messages.querySelector(".empty-state")?.remove();
  const empty = document.createElement("div");
  empty.className = "empty-state";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const description = document.createElement("p");
  description.textContent = copy;
  empty.append(heading, description);
  elements.messages.insertBefore(empty, elements.jumpLatestButton);
}

function clearChat() {
  elements.messages.replaceChildren(elements.jumpLatestButton);
  state.assistantBubble = null;
  state.thinkingBubble = null;
  state.toolBubbles.clear();
  state.stickToBottom = true;
  syncJumpButton();
}

function prettyText(text) {
  const normalized = `${text || ""}`;
  const trimmed = normalized.trim();
  if (!trimmed) return normalized;

  const prettyJson = (value) => {
    try {
      return `${JSON.stringify(JSON.parse(value), null, 2)}\n`;
    } catch {
      return "";
    }
  };

  if (["{", "["].includes(trimmed[0])) {
    return prettyJson(trimmed) || normalized;
  }

  const newlineIndex = normalized.indexOf("\n");
  if (newlineIndex === -1) return normalized;
  const header = normalized.slice(0, newlineIndex);
  const body = normalized.slice(newlineIndex + 1).trim();
  if (!["{", "["].includes(body[0] || "")) return normalized;
  return `${header}\n${prettyJson(body) || body}`;
}

function isNearBottom() {
  const node = elements.messages;
  return node.scrollHeight - node.scrollTop - node.clientHeight < 120;
}

function syncJumpButton() {
  elements.jumpLatestButton.hidden = state.stickToBottom;
}

// Follow the stream only while the user is at (or near) the bottom, so
// scrolling up to read is never hijacked by incoming deltas.
function stickyScroll(force = false) {
  if (force) state.stickToBottom = true;
  syncJumpButton();
  if (!state.stickToBottom) return;
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function toolDownloadUrl(filePath) {
  if (!state.activeProjectId || !filePath) return null;
  const url = `/api/projects/${encodeURIComponent(state.activeProjectId)}/file?path=${encodeURIComponent(filePath)}`;
  return url;
}

const FILE_PATH_RE = /(^|[\s()\[\]{}'"])((?:\.\/?|\.\.\/|(?:\/|[A-Z]:\\)?(?:[\w.-]+\/)+)[\w.-]+\.[A-Za-z0-9]{1,8})/g;
const TOOL_OUTPUT_DISPLAY_LIMIT = 20000;

function renderToolContent(container, text) {
  let source = String(text ?? "");
  if (source.length > TOOL_OUTPUT_DISPLAY_LIMIT) {
    source = `… showing last ${TOOL_OUTPUT_DISPLAY_LIMIT} characters …\n${source.slice(-TOOL_OUTPUT_DISPLAY_LIMIT)}`;
  }
  FILE_PATH_RE.lastIndex = 0;
  let last = 0;
  let match;
  const nodes = [];
  while ((match = FILE_PATH_RE.exec(source))) {
    const [full, prefix, candidate] = match;
    // Skip things that look like version numbers or URLs (contains :// ).
    if (candidate.includes("://") || /^\d+(\.\d+)+$/.test(candidate)) {
      nodes.push(document.createTextNode(source.slice(last, match.index + full.length)));
      last = match.index + full.length;
      continue;
    }
    if (match.index > last) nodes.push(document.createTextNode(source.slice(last, match.index)));
    if (prefix) nodes.push(document.createTextNode(prefix));
    const href = toolDownloadUrl(candidate);
    if (href) {
      const anchor = document.createElement("a");
      anchor.className = "tool-download";
      anchor.href = href;
      anchor.download = "";
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = candidate;
      nodes.push(anchor);
      nodes.push(document.createTextNode(" "));
      const open = document.createElement("a");
      open.className = "tool-download-open";
      open.textContent = "↓";
      open.title = `Download ${candidate}`;
      open.href = href;
      open.download = "";
      nodes.push(open);
    } else {
      nodes.push(document.createTextNode(candidate));
    }
    last = match.index + full.length;
  }
  if (last < source.length) nodes.push(document.createTextNode(source.slice(last)));
  container.replaceChildren(...nodes);
}

// Renders are coalesced with requestAnimationFrame so a burst of streaming
// deltas costs at most one re-render per frame, regardless of bubble type.
function renderBubbleContent(bubble, text) {
  bubble._raw = text;
  if (bubble._renderRaf) return;
  bubble._renderRaf = requestAnimationFrame(() => {
    bubble._renderRaf = 0;
    const content = bubble.querySelector(".message-content") || bubble;
    const role = bubble.dataset.role;
    if (role === "assistant" || role === "user") renderMarkdown(content, bubble._raw);
    else if (role === "tool-output") renderToolContent(content, bubble._raw);
    else content.textContent = prettyText(bubble._raw);
    stickyScroll();
  });
}

function appendMessage(role, text) {
  elements.messages.querySelector(".empty-state")?.remove();
  const bubble = document.createElement("article");
  bubble.className = `message ${role}`;
  bubble.dataset.role = role;
  const isMarkdown = role === "assistant" || role === "user";
  const content = document.createElement(isMarkdown ? "div" : "pre");
  content.className = `message-content${isMarkdown ? " md" : ""}`;
  bubble.append(content);
  renderBubbleContent(bubble, text);
  elements.messages.insertBefore(bubble, elements.jumpLatestButton);
  stickyScroll();
  return bubble;
}

function appendToolMessage(toolName, toolCallId) {
  const bubble = document.createElement("details");
  bubble.className = "message tool-output";
  bubble.dataset.role = "tool-output";

  const summary = document.createElement("summary");
  summary.dataset.testid = `tool-output-toggle-${toolCallId.replace(/[^a-z0-9-]+/gi, "-")}`;
  const indicator = document.createElement("span");
  indicator.className = "tool-indicator";
  indicator.setAttribute("aria-hidden", "true");
  const label = document.createElement("strong");
  label.className = "tool-name";
  label.textContent = toolName;
  const status = document.createElement("span");
  status.className = "tool-status";
  status.textContent = "Running";
  const chevron = document.createElement("span");
  chevron.className = "tool-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "›";
  summary.append(indicator, label, status, chevron);

  const content = document.createElement("pre");
  content.className = "message-content";
  bubble.append(summary, content);
  elements.messages.insertBefore(bubble, elements.jumpLatestButton);
  stickyScroll();
  return bubble;
}

function updateToolMessage(bubble, text, status, isError = false) {
  bubble.dataset.status = isError ? "error" : status.toLowerCase();
  bubble.querySelector(".tool-status").textContent = status;
  renderBubbleContent(bubble, text);
}

// A saved transcript interleaves chat text with tool results. Rendering every
// non-user entry as assistant markdown reflowed file dumps into prose, so each
// role gets the same bubble the live stream would have produced.
function appendTranscript(messages) {
  for (const message of messages || []) {
    if (message.role === "toolResult" || message.role === "toolCall") {
      const bubble = appendToolMessage(message.toolName || "tool", `history-${message.id}`);
      updateToolMessage(bubble, message.text, "Done");
      continue;
    }
    appendMessage(message.role === "user" ? "user" : "assistant", message.text);
  }
}

// Opus is pinned to the explicit Opus 5 id so the CLI's "opus" alias cannot
// drift to an older release.
const CLAUDE_MODEL_OPTIONS = [
  { id: "fable", label: "Fable" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku 4.5" },
];
// Pi harness offers the GPT (openai-codex) and GLM (zai) models; Claude harness offers Fable/Opus/Sonnet.
const PI_MODEL_PROVIDERS = [
  { provider: "openai-codex", groupLabel: "GPT (OpenAI Codex)" },
  { provider: "zai", groupLabel: "GLM (Z.ai)" },
];

function syncModelButton() {
  const isClaude = state.engine === "claude";
  let label = "Model";
  if (isClaude) {
    const active = CLAUDE_MODEL_OPTIONS.find((option) => state.activeModelKey === `claude/${option.id}`);
    const name = active ? active.label : state.activeModelLabel;
    const effort = state.claudeEffort && state.claudeEffort !== "default" ? ` · ${state.claudeEffort}` : "";
    if (name) label = `${name}${effort}`;
  } else {
    const active = state.models.find((model) => `${model.provider}/${model.id}` === state.activeModelKey);
    const name = active ? active.label : state.activeModelLabel || "Model";
    label = state.thinkingLevel !== "off" ? `${name} · ${state.thinkingLevel}` : name;
  }
  elements.modelButton.textContent = label;
  elements.modelButton.classList.toggle("claude", isClaude);
  if (elements.modelDialog.open) renderModelDialog();
}

function modelOptionButton({ key, label, active, onSelect }) {
  const option = document.createElement("button");
  option.type = "button";
  option.className = "model-option";
  option.dataset.modelKey = key;
  option.dataset.testid = `model-option-${key.replace(/[^a-z0-9.-]+/gi, "-")}`;
  option.textContent = label;
  option.classList.toggle("active", active);
  option.addEventListener("click", () => {
    onSelect();
    elements.modelDialog.close();
  });
  return option;
}

/** Pi runs a skill as /skill:<name>; Claude runs it as a bare slash command. */
function skillInvocation(skill) {
  return skill.harness === "pi" ? `/skill:${skill.name} ` : `/${skill.name} `;
}

function renderSkillsDialog() {
  elements.skillsDialogList.replaceChildren();
  if (state.skillsLoading) {
    const loading = document.createElement("span");
    loading.className = "model-shortcuts-empty";
    loading.textContent = "Loading skills…";
    elements.skillsDialogList.append(loading);
    return;
  }

  const query = normalizedQuery(elements.skillsDialogSearchInput.value || "");
  const matches = state.skills
    .filter((skill) => skill.harness === state.engine)
    .filter((skill) => !query || `${skill.name}\n${skill.description}`.toLowerCase().includes(query));

  if (!matches.length) {
    const empty = document.createElement("span");
    empty.className = "model-shortcuts-empty";
    empty.textContent = query ? "No matching skills." : "No skills installed for this agent.";
    elements.skillsDialogList.append(empty);
    return;
  }

  for (const skill of matches) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "skill-option";
    option.dataset.testid = "skill-option";
    const name = document.createElement("strong");
    name.textContent = skill.name;
    if (skill.scope === "project") {
      const scope = document.createElement("em");
      scope.className = "skill-option-scope";
      scope.textContent = "project";
      name.append(" ", scope);
    }
    const description = document.createElement("span");
    description.className = "skill-option-description";
    description.textContent = skill.description;
    option.append(name, description);
    option.addEventListener("click", () => {
      const invocation = skillInvocation(skill);
      elements.skillsDialog.close();
      elements.messageInput.value = invocation;
      elements.messageInput.focus();
      elements.messageInput.setSelectionRange(invocation.length, invocation.length);
    });
    elements.skillsDialogList.append(option);
  }
}

async function openSkillsDialog() {
  elements.skillsDialogSearchInput.value = "";
  elements.skillsDialog.showModal();
  if (!state.activeProjectId) {
    state.skills = [];
    renderSkillsDialog();
    return;
  }
  state.skillsLoading = true;
  renderSkillsDialog();
  try {
    state.skills = (await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/skills`)).skills;
  } catch (error) {
    state.skills = [];
    toast(error.message);
  } finally {
    state.skillsLoading = false;
    renderSkillsDialog();
    elements.skillsDialogSearchInput.focus();
  }
}

function renderReasoningOptions() {
  const isClaude = state.engine === "claude";
  elements.modelDialogReasoningLabel.textContent = isClaude ? "Reasoning effort" : "Thinking level";
  elements.reasoningLevelSelect.replaceChildren();
  for (const level of state.availableThinkingLevels) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = `${isClaude ? "Effort" : "Thinking"}: ${level}`;
    elements.reasoningLevelSelect.append(option);
  }
  elements.reasoningLevelSelect.value = state.thinkingLevel;
  elements.modelDialogReasoning.hidden = state.availableThinkingLevels.length === 0;
}

function renderModelDialog() {
  const isClaude = state.engine === "claude";
  renderReasoningOptions();
  elements.modelDialogTitle.textContent = isClaude ? "Claude model" : "Pi model";
  elements.modelDialogList.classList.toggle("claude", isClaude);
  elements.modelDialogList.replaceChildren();
  if (isClaude) {
    for (const option of CLAUDE_MODEL_OPTIONS) {
      elements.modelDialogList.append(
        modelOptionButton({
          key: `claude/${option.id}`,
          label: option.label,
          active: state.activeModelKey === `claude/${option.id}`,
          onSelect: () => {
            if (!sendSocket({ type: "setModel", provider: "claude", modelId: option.id })) toast("Not connected");
          },
        }),
      );
    }
    return;
  }
  if (!state.models.length) {
    const empty = document.createElement("span");
    empty.className = "model-shortcuts-empty";
    empty.textContent = "No configured models";
    elements.modelDialogList.append(empty);
    return;
  }
  for (const { provider, groupLabel } of PI_MODEL_PROVIDERS) {
    const group = state.models.filter((model) => model.provider === provider);
    if (!group.length) continue;
    const heading = document.createElement("div");
    heading.className = "model-dialog-group";
    heading.textContent = groupLabel;
    elements.modelDialogList.append(heading);
    for (const model of group) {
      elements.modelDialogList.append(
        modelOptionButton({
          key: `${model.provider}/${model.id}`,
          label: model.label,
          active: state.activeModelKey === `${model.provider}/${model.id}`,
          onSelect: () => {
            if (!sendSocket({ type: "setModel", provider: model.provider, modelId: model.id })) toast("Not connected");
          },
        }),
      );
    }
  }
}

function setComposerEnabled(enabled) {
  elements.messageInput.disabled = !enabled;
  elements.sendButton.disabled = !enabled;
  elements.attachButton.disabled = !enabled;
  elements.attachmentInput.disabled = !enabled;
  elements.renameSessionButton.disabled = !enabled;
  elements.modelButton.disabled = !enabled;
  elements.reasoningLevelSelect.disabled = !enabled;
  syncSafeguardsButton();
}

function syncSafeguardsButton() {
  const isPi = state.engine === "pi";
  elements.safeguardsButton.hidden = !isPi;
  elements.safeguardsButton.setAttribute("aria-pressed", state.safeguardsEnabled ? "true" : "false");
  elements.safeguardsButton.textContent = state.safeguardsEnabled ? "Safeguards on" : "Unsafe mode";
  elements.safeguardsButton.classList.toggle("unsafe", !state.safeguardsEnabled);
  elements.safeguardsButton.title = state.safeguardsEnabled
    ? "Safe Guard checks are active for this Pi session"
    : "Unsafe mode: Safe Guard checks are disabled for this Pi session";
  elements.safeguardsButton.disabled = !isPi || elements.messageInput.disabled || state.sessionBusy;
}

function sendSocket(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
  state.socket.send(JSON.stringify(payload));
  return true;
}

function renderTaskBacklink() {
  const task = state.activeTaskId ? state.tasks.find((candidate) => candidate.id === state.activeTaskId) : null;
  elements.taskBacklinkButton.hidden = !task;
  if (!task) return;
  elements.taskBacklinkButton.textContent = `◂ ${task.title}`;
  elements.taskBacklinkButton.title = `Back to ticket: ${task.title}`;
  elements.taskBacklinkButton.setAttribute("aria-label", `Back to ticket ${task.title}`);
}

function renderChatSessionControls() {
  elements.chatNodeSelect.replaceChildren();
  for (const node of state.sessionNodes) {
    const option = document.createElement("option");
    option.value = node.id;
    option.textContent = `${node.name}${node.local ? " · local" : ""}${!node.online ? " · offline" : !node.mapped ? " · map required" : ""}`;
    option.disabled = !node.online || !node.mapped;
    elements.chatNodeSelect.append(option);
  }
  elements.chatNodeSelect.value = state.activeNodeId || "";
  elements.chatNodeSelect.disabled = !state.activeProjectId || !state.sessionNodes.length;

  elements.chatHarnessSelect.replaceChildren();
  for (const harness of state.harnesses) {
    const option = document.createElement("option");
    option.value = harness.id;
    option.textContent = harness.label;
    elements.chatHarnessSelect.append(option);
  }
  elements.chatHarnessSelect.value = state.engine;
  elements.chatHarnessSelect.disabled = !state.activeProjectId || !state.harnesses.length;

  // Conversations are picked in the conversations panel; the toolbar no longer duplicates it.
  const selectedSession = state.sessions.find((session) => session.id === state.activeSessionId);

  const activeTask = state.activeTaskId ? state.tasks.find((task) => task.id === state.activeTaskId) : null;
  const ticketDestinations = activeTask && state.sessionNodes.filter((node) => node.id !== activeTask.currentNodeId);
  const destinations = state.sessionNodes.filter((node) => node.id !== state.activeNodeId && node.online);
  const transferable = activeTask
    ? Boolean(activeTask.sessionPath && activeTask.executionState === "idle" && ticketDestinations?.length)
    : Boolean(selectedSession && state.engine === "pi" && socketOpen() && destinations.length);
  elements.transferSessionButton.disabled = !transferable;
  const terminalNode = state.sessionNodes.find((node) => node.id === state.activeNodeId);
  elements.openTerminalButton.disabled = !state.activeProjectId || !terminalNode?.online || !terminalNode.mapped;
  elements.openTerminalButton.title = terminalNode
    ? `Open the project folder in Terminal on ${terminalNode.name}`
    : "Select an execution node first";
  elements.transferSessionButton.title = activeTask
    ? !activeTask.sessionPath
      ? "Send a message first, then continue this ticket on another node"
      : activeTask.executionState !== "idle"
        ? "Wait for the ticket agent to finish before continuing on another node"
        : transferable ? "Move this ticket conversation to another node" : "No other node is available for this ticket"
    : transferable
      ? destinations.some((node) => node.mapped)
        ? "Copy this conversation and continue it on another node"
        : "Map this project, then continue the conversation on another node"
      : state.engine === "claude"
        ? "Claude conversation transfer is not available yet"
        : selectedSession ? "No other online node is available" : "Send a message first, then continue this conversation on another node";
  renderTaskBacklink();
}

function syncEngineUI() {
  elements.chatHarnessSelect.value = state.engine;
  renderChatSessionControls();
  syncModelButton();
  syncSafeguardsButton();
}

function syncReasoningControls(status) {
  state.thinkingLevel = status.thinkingLevel || (state.engine === "claude" ? "default" : "off");
  Object.assign(state, { availableThinkingLevels: status.availableThinkingLevels || [] });
  if (state.engine === "claude") state.claudeEffort = state.thinkingLevel;
  if (elements.modelDialog.open) renderReasoningOptions();
}

function updateStatus(status) {
  if (!status) return;
  if (!status.isStreaming) clearThinkingBubble();
  state.sessionBusy = Boolean(status.isStreaming || status.isBashRunning || status.isCompacting || status.isRetrying);
  if (typeof status.safeguardsEnabled === "boolean") state.safeguardsEnabled = status.safeguardsEnabled;
  const model = status.model ? `${status.model.provider}/${status.model.label}` : "No model";
  const busy = status.isStreaming ? "working" : "ready";
  const queue = status.pendingMessageCount ? ` • ${status.pendingMessageCount} queued` : "";
  const node = state.sessionNodes.find((candidate) => candidate.id === state.activeNodeId);
  elements.miniStatus.textContent = `${node?.name || "Node"} • ${model} • thinking ${status.thinkingLevel} • ${status.messageCount} msgs • ${status.activeTools.length} tools • ${busy}${queue}`;
  elements.abortButton.disabled = !status.isStreaming && !status.isBashRunning && !status.isCompacting && !status.isRetrying;
  if (status.sessionName) elements.sessionTitle.textContent = status.sessionName;
  state.activeModelKey = status.model ? `${status.model.provider}/${status.model.id}` : "";
  state.activeModelLabel = status.model ? status.model.label : "";
  syncReasoningControls(status);
  syncModelButton();
  syncSafeguardsButton();
}

function piUiModels(models) {
  const ordered = [];
  for (const { provider } of PI_MODEL_PROVIDERS) {
    ordered.push(...models.filter((model) => model.provider === provider));
  }
  return ordered;
}

function setModels(models) {
  state.models = piUiModels(models);
  syncModelButton();
}

async function loadModels() {
  const body = await api("/api/models");
  setModels(body.models || []);
}

async function loadHarnesses() {
  const body = await api("/api/harnesses");
  state.harnesses = body.harnesses || [];
  renderChatSessionControls();
}

async function loadSessionNodes(projectId) {
  const body = await api(`/api/projects/${encodeURIComponent(projectId)}/session-nodes`);
  if (state.activeProjectId !== projectId) return;
  state.sessionNodes = body.nodes;
  const previousNodeId = state.activeNodeId;
  const selected = state.sessionNodes.find((node) => node.id === state.activeNodeId && node.online && node.mapped)
    || state.sessionNodes.find((node) => node.local);
  state.activeNodeId = selected?.id || null;
  if (state.preferencesLoaded && state.activeNodeId !== previousNodeId) savePreferencesInBackground({ activeNodeId: state.activeNodeId });
  renderSessions();
}

async function refreshProjectsQuietly() {
  if (state.projectsRefreshing) return;
  state.projectsRefreshing = true;
  try {
    state.projects = (await api("/api/projects")).projects;
    renderProjects();
  } catch (error) {
    console.warn("Could not refresh project sync status", error);
  } finally {
    state.projectsRefreshing = false;
  }
}

function startProjectSyncPolling() {
  if (state.projectSyncTimer) clearInterval(state.projectSyncTimer);
  state.projectSyncTimer = setInterval(() => refreshProjectsQuietly(), 10_000);
}

async function loadProjects() {
  setListLoading("projects", true);
  try {
    const body = await api("/api/projects?syncStatus=false");
    state.projects = body.projects;
  } finally {
    setListLoading("projects", false);
  }
  void loadHarnesses().catch((error) => console.warn("Could not load harnesses", error));

  if (state.initialProjectId) state.activeProjectId = state.initialProjectId;
  if (state.initialSessionPath) state.activeSessionPath = state.initialSessionPath;

  if (state.activeProjectId && !state.projects.some((project) => project.id === state.activeProjectId)) {
    state.activeProjectId = null;
    state.activeSessionPath = null;
    state.activeSessionId = null;
    if (state.preferencesLoaded) savePreferencesInBackground({ activeProjectId: null, activeSessionPath: null, activeSessionId: null });
  }

  renderProjects();
  void refreshProjectsQuietly();
  if (!state.activeProjectId) {
    setMobileView("projects");
    return;
  }

  await selectProject(state.activeProjectId, false, !state.initialProjectId || Boolean(state.initialSessionPath));
  const activeSession = state.sessions.find((session) => state.activeSessionId ? session.id === state.activeSessionId : session.path === state.activeSessionPath);
  if (state.activeSessionPath && activeSession) {
    openListedSession(activeSession);
    return;
  }
  if (state.activeSessionPath) {
    state.activeSessionPath = null;
    state.activeSessionId = null;
    if (state.preferencesLoaded) savePreferencesInBackground({ activeSessionPath: null, activeSessionId: null });
  }

  setMobileView("sessions");
}

async function selectProject(projectId, shouldRender = true, preserveSession = false) {
  state.activeProjectId = projectId;
  if (!preserveSession) {
    state.activeSessionPath = null;
    state.activeSessionId = null;
    state.activeTaskId = null;
  }
  if (state.preferencesLoaded) savePreferencesInBackground({ activeProjectId: projectId, activeSessionPath: state.activeSessionPath, activeSessionId: state.activeSessionId });
  closeSocket();
  clearChat();
  clearAttachments();
  setComposerEnabled(false);
  elements.sessionTitle.textContent = "Select a conversation";
  state.sessionNodes = [];
  setListLoading("sessions", true);
  renderSessions();
  setMobileView("sessions");
  void loadSessionNodes(projectId).catch((error) => toast(error.message, 8000));
  let body;
  try {
    body = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
  } finally {
    setListLoading("sessions", false);
  }
  state.sessions = body.sessions;
  if (shouldRender) renderProjects();
  renderSessions();
  ensureWatchSocket();
  subscribeToPush().catch((error) => console.warn("Push subscription failed", error));
  loadTasks().catch((error) => console.warn(error));
}

function socketOpen() {
  return Boolean(state.socket && state.socket.readyState === WebSocket.OPEN);
}

function closeSocket() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  stopHeartbeat();
  const socket = state.socket;
  state.socket = null;
  if (socket) socket.close();
  setStatus("Idle");
  setConnecting(false);
}

function scheduleReconnect(sessionPath, delay = 1500) {
  if (!state.activeProjectId || !sessionPath) return;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    openSession(sessionPath, elements.sessionTitle.textContent || "Pi session", true, Boolean(state.activeTaskId));
  }, delay);
}

function startHeartbeat() {
  stopHeartbeat();
  state.lastPongAt = Date.now();
  state.heartbeatTimer = setInterval(() => {
    if (!state.socket) return;
    if (state.socket.readyState === WebSocket.OPEN) {
      if (Date.now() - state.lastPongAt > 45000) {
        // Connection looks dead (no pong in 3+ intervals). Force a reconnect.
        resumeConnection(true);
        return;
      }
      state.socket.send(JSON.stringify({ type: "ping" }));
    } else if (state.socket.readyState === WebSocket.CLOSING || state.socket.readyState === WebSocket.CLOSED) {
      resumeConnection(true);
    }
  }, 15000);
}

function stopHeartbeat() {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
}

// Proactively restore the session connection. Mobile browsers freeze JS timers
// and kill sockets when the app is backgrounded or the screen locks, so the
// WebSocket "close" event often only fires after the user returns. This is
// called on visibilitychange / pageshow / online and from the heartbeat.
function resumeConnection(force = false) {
  if (!state.activeProjectId || !state.activeSessionPath) return;
  const fresh = Date.now() - state.lastPongAt < 40000;
  if (!force && socketOpen() && fresh) {
    // Looks healthy — probe anyway so we notice zombies quickly.
    sendSocket({ type: "ping" });
    return;
  }
  if (state.socket) {
    const stale = state.socket;
    state.socket = null;
    try {
      stale.close();
    } catch {
      /* ignore */
    }
  }
  setStatus("Connecting…", false, true);
  elements.miniStatus.textContent = "Connecting…";
  setConnecting(true, "Connecting…");
  setComposerEnabled(false);
  scheduleReconnect(state.activeSessionPath, 250);
}

function websocketUrl(sessionPath) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/ws`);
  url.searchParams.set("projectId", state.activeProjectId);
  url.searchParams.set("sessionPath", sessionPath || "new");
  if (state.activeSessionId) url.searchParams.set("sessionId", state.activeSessionId);
  if (state.activeNodeId && !state.activeTaskId) url.searchParams.set("nodeId", state.activeNodeId);
  if (state.activeTaskId) url.searchParams.set("taskId", state.activeTaskId);
  return url.toString();
}

function openSession(sessionPath, title = "New Pi conversation", preserveChat = false, preserveTask = false) {
  if (!preserveTask) state.activeTaskId = null;
  if (state.activeTaskId) {
    const task = state.tasks.find((candidate) => candidate.id === state.activeTaskId);
    if (task) state.activeNodeId = task.currentNodeId;
  }
  closeSocket();
  if (!preserveChat) {
    clearChat();
    clearAttachments();
    const node = state.sessionNodes.find((candidate) => candidate.id === state.activeNodeId);
    showChatEmptyState("Connecting…", `Opening this conversation on ${node?.name || "the selected node"}.`);
  }
  state.activeSessionPath = sessionPath || "new";
  if (state.preferencesLoaded) savePreferencesInBackground({ activeSessionPath: state.activeSessionPath, activeSessionId: state.activeSessionId });
  state.engine = state.activeSessionPath.startsWith("claude:") ? "claude" : "pi";
  elements.sessionTitle.textContent = title;
  renderSessions();
  setMobileView("chat");
  setStatus("Connecting…", false, true);
  setComposerEnabled(false);

  const socket = new WebSocket(websocketUrl(sessionPath));
  state.socket = socket;

  socket.addEventListener("open", () => {
    setStatus("Connected", true);
    setConnecting(false);
    startHeartbeat();
    loadModels().catch((error) => toast(error.message));
    sendSocket({ type: "models" });
  });
  socket.addEventListener("close", (event) => {
    if (state.socket !== socket) return;
    stopHeartbeat();
    const reason = event.reason || "Execution node disconnected";
    setStatus("Connecting…", false, true);
    elements.miniStatus.textContent = reason;
    setConnecting(true, "Connecting…");
    setComposerEnabled(false);
    scheduleReconnect(state.activeSessionPath);
  });
  // The connecting banner already shows this state, and reconnect attempts
  // repeat, so a toast per attempt is pure noise.
  socket.addEventListener("error", () => console.warn("WebSocket connection failed"));
  socket.addEventListener("message", (event) => handleSocketMessage(JSON.parse(event.data)));
}

function handleSocketMessage(payload) {
  if (payload.type === "pong") {
    state.lastPongAt = Date.now();
    return;
  }
  if (payload.type === "ready") {
    const openingDraft = ["new", "claude:new"].includes(state.activeSessionPath);
    setComposerEnabled(true);
    state.engine = payload.engine || "pi";
    state.activeSessionId = payload.sessionId || state.activeSessionId;
    syncEngineUI();
    if (payload.sessionFile) {
      state.activeSessionPath = payload.sessionFile;
      if (state.preferencesLoaded) savePreferencesInBackground({ activeSessionPath: payload.sessionFile, activeSessionId: state.activeSessionId });
    }
    const matchingSession = state.sessions.find((session) => session.path === payload.sessionFile);
    elements.sessionTitle.textContent = matchingSession
      ? shortSessionTitle(matchingSession)
      : openingDraft
        ? `New ${state.engine === "claude" ? "Claude" : "Pi"} conversation`
        : state.engine === "claude" ? "Claude conversation" : "Pi conversation";
    clearChat();
    appendTranscript(payload.messages);
    if (!payload.messages?.length) {
      const node = state.sessionNodes.find((candidate) => candidate.id === state.activeNodeId);
      showChatEmptyState("Ready for your first message", `${state.engine === "claude" ? "Claude" : "Pi"} will run on ${node?.name || "the selected node"}. The conversation is created when you send.`);
    }
    renderChatSessionControls();
    if (payload.models) setModels(payload.models);
    updateStatus(payload.status);
    subscribeToPush().catch((error) => console.warn("Push subscription failed", error));
    refreshSessionsQuietly();
    return;
  }
  if (payload.type === "engineChanged") {
    state.engine = payload.engine || "pi";
    state.activeSessionId = null;
    syncEngineUI();
    toast(state.engine === "claude" ? "Switched to Claude — context carries over on your next message" : "Switched to Pi — context carries over on your next message");
    return;
  }
  if (payload.type === "sessionFile") {
    if (payload.sessionId) state.activeSessionId = payload.sessionId;
    if (payload.sessionFile) {
      state.activeSessionPath = payload.sessionFile;
      if (state.preferencesLoaded) savePreferencesInBackground({ activeSessionPath: payload.sessionFile, activeSessionId: state.activeSessionId });
    }
    return;
  }
  if (payload.type === "models") {
    setModels(payload.models || []);
    return;
  }
  if (payload.type === "status") {
    updateStatus(payload.status);
    return;
  }
  if (payload.type === "userMessage") {
    appendMessage("user", payload.text);
    state.assistantBubble = null;
    state.thinkingBubble = null;
    return;
  }
  if (payload.type === "textDelta") {
    clearThinkingBubble();
    if (!state.assistantBubble) state.assistantBubble = appendMessage("assistant", "");
    const currentText = state.assistantBubble._raw || "";
    renderBubbleContent(state.assistantBubble, `${currentText}${payload.text}`);
    return;
  }
  if (payload.type === "assistantFinal") {
    clearThinkingBubble();
    if (!state.assistantBubble) appendMessage("assistant", payload.text);
    else renderBubbleContent(state.assistantBubble, payload.text);
    state.assistantBubble = null;
    return;
  }
  if (payload.type === "thinkingStart") {
    state.thinkingBubble = appendMessage("thinking", "Thinking…\n");
    return;
  }
  if (payload.type === "thinkingDelta") {
    if (!state.thinkingBubble) state.thinkingBubble = appendMessage("thinking", "Thinking…\n");
    const currentText = state.thinkingBubble._raw || "";
    renderBubbleContent(state.thinkingBubble, `${currentText}${payload.text}`);
    return;
  }
  if (payload.type === "thinkingEnd") {
    clearThinkingBubble();
    return;
  }
  if (payload.type === "toolStart") {
    clearThinkingBubble();
    state.assistantBubble = null;
    const bubble = appendToolMessage(payload.toolName, payload.toolCallId);
    state.toolBubbles.set(payload.toolCallId, bubble);
    return;
  }
  if (payload.type === "toolUpdate") {
    const bubble = state.toolBubbles.get(payload.toolCallId) || appendToolMessage(payload.toolName, payload.toolCallId);
    state.toolBubbles.set(payload.toolCallId, bubble);
    updateToolMessage(bubble, payload.text || "", "Running");
    return;
  }
  if (payload.type === "toolEnd") {
    const bubble = state.toolBubbles.get(payload.toolCallId) || appendToolMessage(payload.toolName, payload.toolCallId);
    updateToolMessage(bubble, payload.text || "", payload.isError ? "Failed" : "Done", payload.isError);
    state.toolBubbles.delete(payload.toolCallId);
    return;
  }
  if (payload.type === "assistantError") {
    clearThinkingBubble();
    appendMessage("tool", `Pi error: ${payload.error}`);
  }
  if (payload.type === "agent_start") {
    setStatus("Pi is working", true);
    state.lastTurnStartedAt = Date.now();
    state.sessionBusy = true;
    syncSafeguardsButton();
  }
  if (payload.type === "agent_end") {
    clearThinkingBubble();
    setStatus("Connected", true);
    state.sessionBusy = false;
    syncSafeguardsButton();
    if (state.lastTurnStartedAt) {
      maybeNotifyTurnComplete().catch((error) => console.warn("Notification failed", error));
      state.lastTurnStartedAt = 0;
    }
  }
  if (payload.type === "queueUpdate") elements.miniStatus.textContent = `${payload.pending || 0} queued messages`;
  if (payload.type === "sessionInfoChanged" && payload.name) elements.sessionTitle.textContent = payload.name;
  if (payload.type === "thinkingLevelChanged") elements.miniStatus.textContent = `Thinking ${payload.level}`;
  if (payload.type === "sessionsChanged") refreshSessionsQuietly();
  if (payload.type === "tasksChanged") {
    loadTasks().catch((error) => console.warn(error));
    return;
  }
  if (payload.type === "messages") {
    // Read-only Claude transcript synchronized from another node: re-render in place.
    clearChat();
    appendTranscript(payload.messages);
    return;
  }
  if (payload.type === "sessionFileChanged") {
    // The session file changed on disk after synchronization. Reconnect so the
    // server loads the updated conversation; "ready" re-renders the messages.
    openSession(state.activeSessionPath, elements.sessionTitle.textContent || "Pi session", true, Boolean(state.activeTaskId));
    return;
  }
  if (payload.type === "error") toast(payload.error);
}

async function refreshSessionsQuietly() {
  if (!state.activeProjectId || state.sessionsRefreshing) return;
  state.sessionsRefreshing = true;
  const previousStates = new Map(state.sessions.map((session) => [session.path, session.reviewState]));
  try {
    const body = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions`);
    const newlyNeedsReview = body.sessions.some((session) => session.reviewState === "needs_review" && previousStates.get(session.path) !== "needs_review");
    state.sessions = body.sessions;
    if (newlyNeedsReview) playCompletionSound().catch((error) => console.warn("Completion sound failed", error));
    const activeNode = state.sessionNodes.find((node) => node.id === state.activeNodeId);
    const activeSessionExists = state.sessions.some((session) => state.activeSessionId ? session.id === state.activeSessionId : session.path === state.activeSessionPath);
    if (activeNode?.local && state.activeSessionPath && !["new", "claude:new"].includes(state.activeSessionPath) && !socketOpen() && !activeSessionExists) {
      state.activeTaskId = null;
      closeSocket();
      clearChat();
      clearAttachments();
      state.activeSessionPath = null;
      state.activeSessionId = null;
      if (state.preferencesLoaded) savePreferencesInBackground({ activeSessionPath: null, activeSessionId: null });
      elements.sessionTitle.textContent = "Select a conversation";
      setComposerEnabled(false);
      setMobileView("sessions");
    }
    renderSessions();
  } catch (error) {
    console.warn(error);
  } finally {
    state.sessionsRefreshing = false;
  }
}

// ---- Kanban board ----

function renderBoardView() {
  const project = selectedProject();
  elements.boardProjectName.textContent = project ? `${project.name} board` : "Board";
  elements.newTaskButton.disabled = !project;
  if (!project) {
    elements.boardColumns.replaceChildren();
    return;
  }
  renderBoard(elements.boardColumns, state.tasks, {
    onEdit: openEditTaskDialog,
    onMove: moveTask,
    onAdd: openNewTaskDialog,
    onOpenChat: (task) => {
      state.activeTaskId = task.id;
      openSession(task.sessionPath, task.title, false, true);
    },
    onMerge: mergeTask,
    onHandoff: handoffTask,
    onArchive: archiveTask,
    onDelete: deleteTaskFromCard,
    onSettings: openEditTaskDialog,
  });
}

function focusTaskCard(taskId) {
  const card = elements.boardColumns.querySelector(`[data-task-id="${CSS.escape(taskId)}"]`);
  if (!card) return;
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  card.classList.remove("task-card-focus");
  void card.offsetWidth;
  card.classList.add("task-card-focus");
  setTimeout(() => card.classList.remove("task-card-focus"), 1600);
}

async function loadTasks() {
  if (!state.activeProjectId) {
    state.tasks = [];
    renderBoardView();
    return;
  }
  try {
    const body = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks`);
    state.tasks = body.tasks;
    const activeTask = state.tasks.find((task) => task.id === state.activeTaskId);
    if (activeTask) state.activeNodeId = activeTask.currentNodeId;
    renderBoardView();
    renderChatSessionControls();
  } catch (error) {
    console.warn(error);
  }
}

function phaseSelectFor(phase) {
  return {
    planning: elements.taskPlanningModelInput,
    in_progress: elements.taskImplementationModelInput,
    review: elements.taskReviewModelInput,
  }[phase];
}

function taskModelOptions(engine) {
  if (engine === "claude") return CLAUDE_MODEL_OPTIONS.map((model) => ({ value: `claude||${model.id}|default`, label: model.label }));
  return state.models.map((model) => ({ value: `pi|${model.provider}|${model.id}|default`, label: model.label }));
}

function defaultPhaseValue(phase, engine) {
  if (engine === "claude") return phase === "review" ? "claude||sonnet|default" : "claude||claude-opus-5|default";
  const firstPi = state.models[0];
  return firstPi ? `pi|${firstPi.provider}|${firstPi.id}|default` : "";
}

function populatePhaseModelInputs(task = null) {
  const engine = task?.engine || elements.taskEngineInput.value || "pi";
  const options = taskModelOptions(engine);
  for (const phase of ["planning", "in_progress", "review"]) {
    const select = phaseSelectFor(phase);
    select.replaceChildren();
    for (const option of options) {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      select.append(item);
    }
    const config = task?.phaseConfig?.[phase];
    select.value = config?.engine === engine ? `${config.engine}|${config.provider || ""}|${config.modelId || ""}|${config.effort || "default"}` : defaultPhaseValue(phase, engine);
    if (!select.value && select.options.length) select.selectedIndex = 0;
  }
}

function phaseConfigFromInputs() {
  const phaseConfig = {};
  for (const phase of ["planning", "in_progress", "review"]) {
    const [engine, provider, modelId, effort] = phaseSelectFor(phase).value.split("|");
    phaseConfig[phase] = { engine, provider, modelId, effort };
  }
  return phaseConfig;
}

function openNewTaskDialog(status = "backlog") {
  state.editingTaskId = null;
  elements.taskDialogTitle.textContent = "New task";
  elements.taskForm.reset();
  elements.taskStatusInput.value = status;
  elements.taskEngineInput.value = "pi";
  elements.taskPlanModeInput.checked = status === "planning";
  elements.taskReviewModeInput.checked = false;
  populatePhaseModelInputs();
  elements.deleteTaskButton.hidden = true;
  elements.taskDialog.showModal();
}

function openEditTaskDialog(task) {
  state.editingTaskId = task.id;
  elements.taskDialogTitle.textContent = "Edit task";
  elements.taskTitleInput.value = task.title;
  elements.taskDescriptionInput.value = task.description || "";
  elements.taskStatusInput.value = task.status;
  elements.taskEngineInput.value = task.engine || "pi";
  elements.taskPlanModeInput.checked = Boolean(task.planMode);
  elements.taskReviewModeInput.checked = Boolean(task.reviewMode);
  populatePhaseModelInputs(task);
  elements.deleteTaskButton.hidden = false;
  elements.taskDialog.showModal();
}

async function moveTask(task, nextStatus) {
  try {
    const body = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: nextStatus }),
    });
    state.tasks = state.tasks.map((item) => (item.id === task.id ? body.task : item));
    renderBoardView();
    if (nextStatus === "planning") toast(`Planning started for "${task.title}"`);
    if (nextStatus === "in_progress") toast(`${task.engine === "claude" ? "Claude" : "Pi"} started working on "${task.title}"`);
  } catch (error) {
    toast(error.message);
  }
}

async function handoffTaskToPeer(task, peer) {
  const body = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(task.id)}/handoff`, { method: "POST", body: JSON.stringify({ peerId: peer.id }) });
  state.tasks = state.tasks.map((item) => item.id === task.id ? body.task : item);
  renderBoardView();
  toast(body.handoffPendingCommit ? `${body.destination.name}: destination commit pending` : `Handed off to ${body.destination.name}`);
  return body;
}

async function handoffTask(task) {
  try {
    const eligibility = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(task.id)}/eligibility`);
    const candidates = eligibility.nodes.filter((entry) => entry.node.online);
    if (!candidates.length) throw new Error("No online destination nodes are available");
    const choices = candidates.map((entry, index) => `${index + 1}. ${entry.node.name}${entry.eligible ? "" : ` — ${entry.reasons.join(", ")}`}`).join("\n");
    const selected = candidates[Number(prompt(`Handoff "${task.title}" to:\n${choices}`, "1")) - 1];
    if (!selected) return;
    if (selected.reasons.includes("Project is not mapped on this node")) {
      const project = selectedProject();
      openProjectImportMapping([{ peerId: selected.node.id, projectId: project.id, name: project.name, remotePath: project.path, suggestedPath: "", mapOnPeer: true, handoffTaskId: task.id }]);
      return;
    }
    if (!selected.eligible) throw new Error(selected.reasons.join("; "));
    if (!confirm(`Handoff "${task.title}" to ${selected.node.name}?`)) return;
    await handoffTaskToPeer(task, selected.node);
  } catch (error) {
    toast(error.message);
  }
}

async function archiveTask(task) {
  if (!confirm(`Archive "${task.title}" and remove its synchronized workspace?`)) return;
  try {
    const body = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(task.id)}/archive`, { method: "POST" });
    state.tasks = state.tasks.map((item) => item.id === task.id ? body.task : item);
    renderBoardView();
    toast(`Archived "${task.title}"`);
  } catch (error) {
    toast(error.message);
  }
}

async function mergeTask(task) {
  if (!confirm(`Merge committed changes from "${task.title}" into main?`)) return;
  try {
    const body = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(task.id)}/merge`, {
      method: "POST",
    });
    state.tasks = state.tasks.map((item) => (item.id === task.id ? body.task : item));
    renderBoardView();
    toast(`Merged "${task.title}" into main`);
  } catch (error) {
    toast(error.message);
  }
}

async function saveTaskFromDialog() {
  const payload = {
    title: elements.taskTitleInput.value.trim(),
    description: elements.taskDescriptionInput.value.trim(),
    status: elements.taskPlanModeInput.checked ? elements.taskStatusInput.value : (elements.taskStatusInput.value === "planning" ? "backlog" : elements.taskStatusInput.value),
    engine: elements.taskEngineInput.value,
    planMode: elements.taskPlanModeInput.checked,
    reviewMode: elements.taskReviewModeInput.checked,
    phaseConfig: phaseConfigFromInputs(),
  };
  if (!payload.title) throw new Error("Task title is required");
  const projectId = encodeURIComponent(state.activeProjectId);
  if (state.editingTaskId) {
    const body = await api(`/api/projects/${projectId}/tasks/${encodeURIComponent(state.editingTaskId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    state.tasks = state.tasks.map((item) => (item.id === state.editingTaskId ? body.task : item));
  } else {
    const body = await api(`/api/projects/${projectId}/tasks`, { method: "POST", body: JSON.stringify(payload) });
    state.tasks = [...state.tasks, body.task];
  }
  renderBoardView();
}

async function deleteTask(taskId) {
  await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
  state.tasks = state.tasks.filter((item) => item.id !== taskId);
  renderBoardView();
}

async function deleteEditingTask() {
  if (!state.editingTaskId) return;
  await deleteTask(state.editingTaskId);
}

async function deleteTaskFromCard(task) {
  if (!confirm(`Delete "${task.title}"?`)) return;
  try {
    await deleteTask(task.id);
  } catch (error) {
    toast(error.message);
  }
}

// ---- Project watch socket (live conversation refresh) ----
// A lightweight per-project WebSocket subscription. The server watches the Pi
// and Claude session directories on disk, so conversations synchronized from peers
// (via Syncthing) show up here without reopening the app.

function closeWatchSocket() {
  if (state.watchReconnectTimer) clearTimeout(state.watchReconnectTimer);
  state.watchReconnectTimer = null;
  if (state.watchPingTimer) clearInterval(state.watchPingTimer);
  state.watchPingTimer = null;
  const socket = state.watchSocket;
  state.watchSocket = null;
  if (socket) socket.close();
  elements.chatsLiveDot.hidden = true;
}

function ensureWatchSocket() {
  if (!state.activeProjectId) {
    closeWatchSocket();
    return;
  }
  if (state.watchSocket && (state.watchSocket.readyState === WebSocket.OPEN || state.watchSocket.readyState === WebSocket.CONNECTING)) return;
  closeWatchSocket();

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/ws`);
  url.searchParams.set("projectId", state.activeProjectId);
  url.searchParams.set("sessionPath", "watch");

  const socket = new WebSocket(url.toString());
  state.watchSocket = socket;
  socket.addEventListener("open", () => {
    elements.chatsLiveDot.hidden = false;
    state.watchPingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
    }, 25000);
  });
  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "sessionsChanged") refreshSessionsQuietly();
    if (payload.type === "tasksChanged") loadTasks().catch((error) => console.warn(error));
  });
  socket.addEventListener("close", () => {
    if (state.watchSocket !== socket) return;
    if (state.watchPingTimer) clearInterval(state.watchPingTimer);
    state.watchPingTimer = null;
    elements.chatsLiveDot.hidden = true;
    state.watchReconnectTimer = setTimeout(() => {
      state.watchReconnectTimer = null;
      ensureWatchSocket();
    }, 3000);
  });
}

elements.themeToggleButton.addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});
elements.navProjectsButton.addEventListener("click", () => setMobileView("projects"));
elements.navSessionsButton.addEventListener("click", () => setMobileView("sessions"));
elements.navBoardButton.addEventListener("click", () => {
  renderBoardView();
  setMobileView("board");
});
elements.navChatButton.addEventListener("click", () => setMobileView("chat"));
elements.backToProjectsButton.addEventListener("click", () => setMobileView("projects"));
elements.backToChatsButton.addEventListener("click", () => setMobileView("sessions"));
elements.backToSessionsButton.addEventListener("click", () => setMobileView("sessions"));
elements.taskBacklinkButton.addEventListener("click", () => {
  renderBoardView();
  setMobileView("board");
  focusTaskCard(state.activeTaskId);
});
elements.openBoardButton.addEventListener("click", () => {
  renderBoardView();
  setMobileView("board");
});
elements.cancelProjectRenameButton.addEventListener("click", () => elements.projectRenameDialog.close());
elements.projectRenameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const project = projectPendingRename;
  const name = elements.projectRenameInput.value.trim();
  const type = elements.projectGroupInput.value;
  const color = selectedProjectColor();
  elements.projectRenameDialog.close();
  if (!project || !name) return;
  if (name === project.name && type === project.type && color === (project.color || null)) return;
  try {
    await api(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, type, color }),
    });
    await loadProjects();
    toast("Project updated");
  } catch (error) {
    toast(error.message, 8000);
  }
});
elements.newTaskButton.addEventListener("click", () => openNewTaskDialog());
elements.taskEngineInput.addEventListener("change", () => populatePhaseModelInputs());
elements.taskPlanModeInput.addEventListener("change", () => {
  if (elements.taskPlanModeInput.checked && elements.taskStatusInput.value === "backlog") elements.taskStatusInput.value = "planning";
  if (!elements.taskPlanModeInput.checked && elements.taskStatusInput.value === "planning") elements.taskStatusInput.value = "backlog";
});
elements.taskStatusInput.addEventListener("change", () => {
  if (elements.taskStatusInput.value === "planning") elements.taskPlanModeInput.checked = true;
});
for (const button of elements.chatFilters.querySelectorAll("button[data-filter]")) {
  button.addEventListener("click", () => {
    state.chatFilter = button.dataset.filter;
    for (const chip of elements.chatFilters.querySelectorAll("button[data-filter]")) {
      chip.classList.toggle("active", chip === button);
    }
    renderSessions();
  });
}
elements.cancelTaskButton.addEventListener("click", () => elements.taskDialog.close());
elements.taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await saveTaskFromDialog();
    elements.taskDialog.close();
  } catch (error) {
    toast(error.message, 8000);
  }
});
elements.deleteTaskButton.addEventListener("click", async () => {
  if (!confirm("Delete this task?")) return;
  try {
    await deleteEditingTask();
    elements.taskDialog.close();
  } catch (error) {
    toast(error.message);
  }
});
/** Mirrors managedFolderName in src/managed-home.ts so the suggested path matches what the server creates. */
function projectFolderName(projectName) {
  return projectName.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "") || "project";
}

function joinProjectPath(basePath, projectName) {
  return `${basePath.replace(/\/+$/, "")}/${projectFolderName(projectName)}`;
}

async function fillProjectBases() {
  const settings = await api("/api/settings");
  state.projectDefaultBase = `${settings.projects.homePath.replace(/\/+$/, "")}/${elements.projectTypeInput.value}`;
  state.projectAutofilledPath = elements.projectNameInput.value.trim()
    ? joinProjectPath(state.projectDefaultBase, elements.projectNameInput.value)
    : state.projectDefaultBase;
  elements.projectBasePathInput.value = state.projectAutofilledPath;
  elements.projectMacBasePathInput.value = "";
}

function updateProjectImportControls() {
  const importing = Boolean(elements.projectSourcePathInput.value.trim());
  elements.projectImportModeLabel.hidden = !importing;
  elements.projectSaveButton.textContent = importing ? "Import project" : "Create project";
}

elements.settingsButton.addEventListener("click", () => openSettings().catch((error) => toast(error.message)));
for (const tab of elements.settingsTabs) {
  tab.addEventListener("click", () => selectSettingsTab(tab.dataset.settingsTab));
  tab.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = elements.settingsTabs.indexOf(tab);
    const next = elements.settingsTabs[(index + step + elements.settingsTabs.length) % elements.settingsTabs.length];
    selectSettingsTab(next.dataset.settingsTab);
    next.focus();
  });
}
elements.cancelSettingsButton.addEventListener("click", () => elements.settingsDialog.close());
elements.settingsLogoutButton.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
    showSignedOut();
  } catch (error) {
    toast(error.message);
  }
});
elements.settingsForm.addEventListener("submit", (event) => saveSettings(event).catch((error) => toast(error.message)));
elements.clusterSaveButton.addEventListener("click", () => saveClusterNode().catch((error) => toast(error.message)));
elements.githubGroupAddButton.addEventListener("click", () => openGithubGroupDialog());
elements.cancelGithubGroupButton.addEventListener("click", () => elements.githubGroupDialog.close());
elements.githubGroupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const label = elements.githubGroupLabelInput.value.trim();
  const token = elements.githubGroupTokenInput.value.trim();
  if (!editingGithubGroup && !token) {
    toast("A new group needs a token");
    return;
  }
  const body = JSON.stringify({ label, isDefault: elements.githubGroupDefaultInput.checked, ...(token ? { token } : {}) });
  try {
    if (editingGithubGroup) await api(`/api/github-auth/groups/${encodeURIComponent(editingGithubGroup.id)}`, { method: "PUT", body });
    else await api("/api/github-auth/groups", { method: "POST", body });
    elements.githubGroupDialog.close();
    await loadGithubGroups();
    toast(`Saved ${label}`);
  } catch (error) {
    toast(error.message);
  }
});
elements.copyClusterLocalTokenButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.clusterLocalToken.value);
    toast("Pairing token copied");
  } catch (error) {
    toast(error.message || "Could not copy pairing token");
  }
});
elements.folderPickerParentButton.addEventListener("click", () => {
  if (state.folderPickerParentPath) loadFolderPickerDirectory(state.folderPickerParentPath).catch((error) => toast(error.message, 8000));
});
elements.folderPickerCancelButton.addEventListener("click", () => elements.folderPickerDialog.close());
elements.folderPickerUseButton.addEventListener("click", () => {
  if (state.folderPickerTarget && state.folderPickerPath) {
    state.folderPickerTarget.value = state.folderPickerPath;
    state.folderPickerTarget.dispatchEvent(new Event("input", { bubbles: true }));
  }
  elements.folderPickerDialog.close();
  state.folderPickerTarget?.focus();
});
elements.settingsProjectHomeBrowseButton.addEventListener("click", () => openFolderPicker(elements.settingsProjectHome, "Choose Joint Bob home folder").catch((error) => toast(error.message, 8000)));
elements.projectImportBrowseButton.addEventListener("click", async () => {
  const pending = state.activeProjectImport;
  if (pending?.mapOnPeer) {
    const apiPath = `/api/cluster/peers/${encodeURIComponent(pending.peerId)}/filesystem/directories`;
    await openFolderPicker(elements.projectImportPathInput, `Choose folder on ${pending.name} destination`, apiPath).catch((error) => toast(error.message, 8000));
    return;
  }
  try {
    await loadProjectImportDirectory(elements.projectImportPathInput.value.trim());
  } catch {
    await loadProjectImportDirectory().catch((error) => toast(error.message, 8000));
  }
});
elements.projectImportParentButton.addEventListener("click", () => {
  if (state.projectImportParentPath) loadProjectImportDirectory(state.projectImportParentPath).catch((error) => toast(error.message, 8000));
});
elements.projectImportUseFolderButton.addEventListener("click", () => {
  elements.projectImportPathInput.value = state.projectImportBrowserPath;
  elements.projectImportBrowser.hidden = true;
  elements.projectImportPathInput.focus();
});
elements.cancelProjectImportButton.addEventListener("click", () => {
  state.pendingProjectImports = [];
  state.activeProjectImport = null;
  elements.projectImportDialog.close();
});
elements.skipProjectImportButton.addEventListener("click", showNextProjectImport);
elements.projectImportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const pending = state.activeProjectImport;
    if (!pending) throw new Error("No project is waiting for a local mapping");
    const route = pending.mapOnPeer
      ? `/api/cluster/peers/${encodeURIComponent(pending.peerId)}/projects/${encodeURIComponent(pending.projectId)}/map`
      : "/api/cluster/projects/map";
    const body = pending.mapOnPeer
      ? { localPath: elements.projectImportPathInput.value.trim() }
      : { peerId: pending.peerId, projectId: pending.projectId, localPath: elements.projectImportPathInput.value.trim() };
    await api(route, { method: "POST", body: JSON.stringify(body) });
    await loadProjects();
    if (pending.handoffTaskId) {
      const task = state.tasks.find((candidate) => candidate.id === pending.handoffTaskId);
      const node = state.sessionNodes.find((candidate) => candidate.id === pending.peerId);
      if (task && node && confirm(`Project mapped. Handoff "${task.title}" to ${node.name}?`)) await handoffTaskToPeer(task, node);
    }
    if (pending.transferSessionPath) {
      await loadSessionNodes(pending.projectId);
      const node = state.sessionNodes.find((candidate) => candidate.id === pending.peerId);
      if (node) await continueSessionOnNode({ id: pending.transferSessionId, path: pending.transferSessionPath, title: pending.transferSessionName }, node, pending.sourceNodeId);
    }
    showNextProjectImport();
  } catch (error) {
    toast(error.message, 8000);
  }
});
elements.cancelProjectGithubButton.addEventListener("click", () => elements.projectGithubDialog.close());
elements.cancelProjectPathButton.addEventListener("click", () => elements.projectPathDialog.close());
elements.projectPathForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const response = await api(`/api/projects/${encodeURIComponent(state.mappingProjectId)}/path-mapping`, {
      method: "PUT",
      body: JSON.stringify({ macPath: elements.projectMacPathInput.value.trim() }),
    });
    state.projects = state.projects.map((project) => project.id === response.project.id ? response.project : project);
    elements.projectPathDialog.close();
    renderProjects();
    await loadSessions();
    toast("Session paths mapped");
  } catch (error) {
    toast(error.message);
  }
});
elements.projectGithubForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = elements.clearProjectGithubTokenInput.checked ? null : elements.projectGithubTokenInput.value.trim() || undefined;
  try {
    await api(`/api/projects/${encodeURIComponent(state.githubProjectId)}/github-auth`, {
      method: "PUT",
      body: JSON.stringify({ group: elements.projectGithubGroupInput.value || null, token }),
    });
    elements.projectGithubDialog.close();
    toast("Project GitHub access saved. New agent sessions use it.");
  } catch (error) {
    toast(error.message);
  }
});

elements.newProjectButton.addEventListener("click", () => {
  elements.projectForm.reset();
  elements.projectImportModeInput.value = "move-link";
  updateProjectImportControls();
  elements.projectDialog.showModal();
  loadProjectTypes().then(() => fillProjectBases()).catch((error) => toast(error.message));
});
elements.projectTypeInput.addEventListener("change", () => fillProjectBases().catch((error) => toast(error.message)));
elements.projectTypeAddButton.addEventListener("click", () => addProjectType().catch((error) => toast(error.message)));
elements.projectTypeNameInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addProjectType().catch((error) => toast(error.message));
});
elements.projectSourcePathInput.addEventListener("input", updateProjectImportControls);
elements.projectSourceBrowseButton.addEventListener("click", () => openFolderPicker(elements.projectSourcePathInput, "Choose project folder to import").catch((error) => toast(error.message, 8000)));
elements.projectNameInput.addEventListener("input", () => {
  if (!state.projectDefaultBase || elements.projectBasePathInput.value !== state.projectAutofilledPath) return;
  state.projectAutofilledPath = elements.projectNameInput.value.trim()
    ? joinProjectPath(state.projectDefaultBase, elements.projectNameInput.value)
    : state.projectDefaultBase;
  elements.projectBasePathInput.value = state.projectAutofilledPath;
});
elements.cancelProjectButton.addEventListener("click", () => elements.projectDialog.close());
elements.projectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const name = elements.projectNameInput.value.trim();
    const sourcePath = elements.projectSourcePathInput.value.trim();
    const response = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name,
        type: elements.projectTypeInput.value,
        synced: true,
        ...(sourcePath ? { sourcePath, importMode: elements.projectImportModeInput.value } : {}),
      }),
    });
    elements.projectDialog.close();
    elements.projectForm.reset();
    elements.projectImportModeInput.value = "move-link";
    elements.projectSearchInput.value = "";
    state.projects = [response.project, ...state.projects.filter((project) => project.id !== response.project.id)];
    renderProjects();
    await selectProject(response.project.id);
  } catch (error) {
    toast(error.message);
  }
});

function activeChatSession() {
  return state.sessions.find((session) => state.activeSessionId ? session.id === state.activeSessionId : session.path === state.activeSessionPath);
}

const TERMINAL_OUTPUT_LIMIT = 200_000;

function appendTerminalOutput(text) {
  const output = `${elements.terminalOutput.textContent || ""}${text}`;
  elements.terminalOutput.textContent = output.slice(-TERMINAL_OUTPUT_LIMIT);
  elements.terminalOutput.scrollTop = elements.terminalOutput.scrollHeight;
}

function closeTerminalSocket() {
  const socket = state.terminalSocket;
  state.terminalSocket = null;
  if (socket) socket.close();
  elements.terminalInput.disabled = true;
  elements.terminalRunButton.disabled = true;
}

function terminalWebsocketUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/ws`);
  url.searchParams.set("mode", "terminal");
  url.searchParams.set("projectId", state.activeProjectId);
  url.searchParams.set("nodeId", state.activeNodeId);
  return url;
}

function openProjectTerminal() {
  if (!state.activeProjectId || !state.activeNodeId) throw new Error("Select a project and execution node first");
  const node = state.sessionNodes.find((candidate) => candidate.id === state.activeNodeId);
  closeTerminalSocket();
  elements.terminalOutput.textContent = "";
  elements.terminalInput.value = "";
  elements.terminalStatus.textContent = `Connecting to ${node?.name || "node"}…`;
  elements.terminalDialog.showModal();

  const socket = new WebSocket(terminalWebsocketUrl());
  state.terminalSocket = socket;
  socket.addEventListener("message", (event) => {
    if (state.terminalSocket !== socket) return;
    const payload = JSON.parse(event.data);
    if (payload.type === "terminalReady") {
      elements.terminalStatus.textContent = `${node?.name || "Node"} · ${payload.cwd}`;
      elements.terminalInput.disabled = false;
      elements.terminalRunButton.disabled = false;
      elements.terminalInput.focus();
    }
    if (payload.type === "terminalOutput") appendTerminalOutput(payload.data || "");
    if (payload.type === "terminalError") appendTerminalOutput(`\nError: ${payload.error}\n`);
    if (payload.type === "terminalExit") appendTerminalOutput(`\n[Shell exited${payload.code === null ? "" : ` with code ${payload.code}`}]\n`);
  });
  socket.addEventListener("close", () => {
    if (state.terminalSocket !== socket) return;
    state.terminalSocket = null;
    elements.terminalStatus.textContent = "Disconnected";
    elements.terminalInput.disabled = true;
    elements.terminalRunButton.disabled = true;
  });
  socket.addEventListener("error", () => {
    if (state.terminalSocket === socket) appendTerminalOutput("\nCould not connect to terminal.\n");
  });
}

async function openSessionTransferDialog() {
  const task = state.activeTaskId ? state.tasks.find((candidate) => candidate.id === state.activeTaskId) : null;
  if (state.activeTaskId && !task) throw new Error("Active ticket was not found");
  if (task) {
    if (!task.sessionPath) throw new Error("Send a message first, then continue this ticket on another node");
    if (task.executionState !== "idle") throw new Error("Wait for the ticket agent to finish before continuing on another node");
    const eligibility = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(task.id)}/eligibility`);
    elements.sessionTransferNodeSelect.replaceChildren(...eligibility.nodes.map((entry) => {
      const option = document.createElement("option");
      option.value = entry.node.id;
      option.disabled = !entry.eligible;
      option.textContent = `${entry.node.name}${entry.eligible ? "" : ` — ${entry.reasons.join("; ")}`}`;
      return option;
    }));
    if (!eligibility.nodes.length) throw new Error("No destination nodes are available");
    elements.sessionTransferDialog.showModal();
    return;
  }
  const session = activeChatSession();
  const destinations = state.sessionNodes.filter((node) => node.id !== state.activeNodeId && node.online);
  if (!session) { toast("Send the first message before continuing on another node"); return; }
  if (state.engine === "claude") { toast("Claude conversation transfer is not available yet"); return; }
  elements.sessionTransferNodeSelect.replaceChildren(...destinations.map((node) => {
    const option = document.createElement("option");
    option.value = node.id;
    option.textContent = `${node.name}${node.mapped ? "" : " · map project first"}`;
    return option;
  }));
  elements.sessionTransferDialog.showModal();
}

async function continueSessionOnNode(session, destination, sourceNodeId = state.activeNodeId) {
  const result = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions/transfer`, {
    method: "POST",
    body: JSON.stringify({ peerId: destination.id, sourceNodeId, sessionId: session.id, sessionPath: session.path, sessionName: shortSessionTitle(session) }),
  });
  state.activeNodeId = destination.id;
  state.activeSessionId = null;
  if (state.preferencesLoaded) savePreferencesInBackground({ activeNodeId: destination.id, activeSessionId: null });
  openSession(result.sessionPath, shortSessionTitle(session));
  toast(`Continuing on ${destination.name}`);
}

async function continueTaskOnNode(task, destination) {
  if (!task) throw new Error("Active ticket was not found");
  if (!task.sessionPath) throw new Error("Send a message first, then continue this ticket on another node");
  if (task.executionState !== "idle") throw new Error("Wait for the ticket agent to finish before continuing on another node");
  if (!destination) throw new Error("Destination node was not found");
  const body = await handoffTaskToPeer(task, destination);
  if (body.handoffPendingCommit) throw new Error(body.message);
  if (!body.task?.sessionPath) throw new Error("Ticket conversation is not available on the destination node");
  state.activeNodeId = destination.id;
  state.activeSessionId = null;
  if (state.preferencesLoaded) savePreferencesInBackground({ activeNodeId: destination.id, activeSessionId: null });
  openSession(body.task.sessionPath, task.title, false, true);
}

async function transferActiveSession(event) {
  event.preventDefault();
  const task = state.activeTaskId ? state.tasks.find((candidate) => candidate.id === state.activeTaskId) : null;
  const session = activeChatSession();
  const destination = state.sessionNodes.find((node) => node.id === elements.sessionTransferNodeSelect.value);
  const submit = elements.sessionTransferForm.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    if (!destination) throw new Error("Destination node was not found");
    if (state.activeTaskId) {
      if (!task) throw new Error("Active ticket was not found");
      await continueTaskOnNode(task, destination);
    } else {
      if (!session) throw new Error("Send the first message before continuing on another node");
      if (!destination.mapped) {
        elements.sessionTransferDialog.close();
        const project = selectedProject();
        openProjectImportMapping([{ peerId: destination.id, projectId: project.id, name: project.name, remotePath: project.path, suggestedPath: "", mapOnPeer: true, transferSessionId: session.id, transferSessionPath: session.path, transferSessionName: shortSessionTitle(session), sourceNodeId: state.activeNodeId }]);
        return;
      }
      await continueSessionOnNode(session, destination);
    }
    elements.sessionTransferDialog.close();
  } catch (error) {
    toast(error.message, 8000);
  } finally {
    submit.disabled = false;
  }
}

elements.loginForm.addEventListener("submit", submitLogin);
elements.newSessionButton.addEventListener("click", () => {
  state.activeSessionId = null;
  openSession(null, "New Pi conversation");
});
elements.newClaudeSessionButton.addEventListener("click", () => {
  state.activeSessionId = null;
  openSession("claude:new", "New Claude conversation");
});
elements.chatNodeSelect.addEventListener("change", async () => {
  const destination = state.sessionNodes.find((node) => node.id === elements.chatNodeSelect.value);
  const task = state.activeTaskId ? state.tasks.find((candidate) => candidate.id === state.activeTaskId) : null;
  if (state.activeTaskId) {
    if (!task || !destination) {
      toast(!task ? "Active ticket was not found" : "Destination node was not found");
      return;
    }
    const ownerId = task.currentNodeId;
    if (destination.id === ownerId) return;
    try {
      await continueTaskOnNode(task, destination);
    } catch (error) {
      state.activeNodeId = ownerId;
      elements.chatNodeSelect.value = ownerId;
      if (state.preferencesLoaded) savePreferencesInBackground({ activeNodeId: ownerId });
      toast(error.message, 8000);
    }
    return;
  }
  state.activeNodeId = elements.chatNodeSelect.value;
  if (state.preferencesLoaded) savePreferencesInBackground({ activeNodeId: state.activeNodeId });
  if (!activeChatSession()) {
    state.activeSessionId = null;
    const harness = state.harnesses.find((candidate) => candidate.id === state.engine);
    openSession(harness?.newSessionPath, `New ${harness?.label || "Pi"} conversation`);
    return;
  }
  openSession(state.activeSessionPath, elements.sessionTitle.textContent || "Conversation", false);
});
elements.chatHarnessSelect.addEventListener("change", () => {
  const harness = state.harnesses.find((candidate) => candidate.id === elements.chatHarnessSelect.value);
  if (!harness || harness.id === state.engine) return;
  state.activeTaskId = null;
  state.engine = harness.id;
  state.activeSessionPath = harness.newSessionPath;
  state.activeSessionId = null;
  if (state.preferencesLoaded) savePreferencesInBackground({ activeSessionPath: state.activeSessionPath, activeSessionId: null });
  syncEngineUI();
  if (!sendSocket({ type: "setEngine", engine: harness.id })) {
    openSession(harness.newSessionPath, `New ${harness.label} conversation`);
  }
});
elements.collapseProjectsButton.addEventListener("click", () => setPanelCollapsed("projects", true));
elements.expandProjectsButton.addEventListener("click", () => setPanelCollapsed("projects", false));
elements.collapseChatsButton.addEventListener("click", () => setPanelCollapsed("chats", true));
elements.expandChatsButton.addEventListener("click", () => setPanelCollapsed("chats", false));
elements.skillsDialogSearchInput.addEventListener("input", () => renderSkillsDialog());
elements.closeSkillsDialogButton.addEventListener("click", () => elements.skillsDialog.close());
elements.modelButton.addEventListener("click", () => {
  renderModelDialog();
  elements.modelDialog.showModal();
});
elements.safeguardsButton.addEventListener("click", () => {
  if (!socketOpen()) {
    toast("Conversation is not connected yet");
    return;
  }
  const safeguardsEnabled = !state.safeguardsEnabled;
  if (state.safeguardsEnabled && !confirm("Disable Safe Guard checks? Dangerous shell commands and protected-path writes can run without Safe Guard checks. Application security and Git branch restrictions remain active.")) return;
  if (!sendSocket({ type: "setSafeguards", safeguardsEnabled })) {
    toast("Conversation is not connected yet");
    return;
  }
  state.sessionBusy = true;
  syncSafeguardsButton();
});
elements.transferSessionButton.addEventListener("click", () => openSessionTransferDialog().catch((error) => toast(error.message, 8000)));
elements.openTerminalButton.addEventListener("click", () => {
  try { openProjectTerminal(); }
  catch (error) { toast(error.message, 8000); }
});
elements.terminalForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const command = elements.terminalInput.value;
  if (!command.trim() || state.terminalSocket?.readyState !== WebSocket.OPEN) return;
  appendTerminalOutput(`$ ${command}\n`);
  state.terminalHistory = [...state.terminalHistory, command].slice(-100);
  state.terminalHistoryIndex = state.terminalHistory.length;
  state.terminalSocket.send(JSON.stringify({ type: "terminalInput", data: `${command}\n` }));
  elements.terminalInput.value = "";
});
elements.terminalInput.addEventListener("keydown", (event) => {
  if (!state.terminalHistory.length || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const offset = event.key === "ArrowUp" ? -1 : 1;
  state.terminalHistoryIndex = Math.max(0, Math.min(state.terminalHistory.length, state.terminalHistoryIndex + offset));
  elements.terminalInput.value = state.terminalHistory[state.terminalHistoryIndex] || "";
});
elements.clearTerminalButton.addEventListener("click", () => { elements.terminalOutput.textContent = ""; });
elements.closeTerminalButton.addEventListener("click", () => elements.terminalDialog.close());
elements.terminalDialog.addEventListener("close", closeTerminalSocket);
elements.cancelSessionTransferButton.addEventListener("click", () => elements.sessionTransferDialog.close());
elements.sessionTransferForm.addEventListener("submit", transferActiveSession);
elements.closeModelDialogButton.addEventListener("click", () => elements.modelDialog.close());
elements.reasoningLevelSelect.addEventListener("change", () => {
  const selectedLevel = elements.reasoningLevelSelect.value;
  const sent = state.engine === "claude"
    ? sendSocket({ type: "setEffort", effort: selectedLevel })
    : sendSocket({ type: "setThinking", level: selectedLevel });
  if (!sent) toast("Not connected");
});
elements.chatMoreMenu.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("button")) elements.chatMoreMenu.removeAttribute("open");
});
document.addEventListener("click", (event) => {
  if (event.target instanceof Node && !elements.chatMoreMenu.contains(event.target)) elements.chatMoreMenu.removeAttribute("open");
});
elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = elements.messageInput.value.trim();
  if (!message && state.attachments.length === 0) return;
  const payload = {
    type: "prompt",
    message,
    images: state.attachments.filter((attachment) => attachment.kind === "image").map(({ name, mimeType, data }) => ({ name, mimeType, data })),
    textAttachments: state.attachments.filter((attachment) => attachment.kind === "text").map(({ name, mimeType, content }) => ({ name, mimeType, content })),
  };
  if (!sendSocket(payload)) {
    toast("Conversation is not connected yet");
    return;
  }
  state.lastTurnStartedAt = Date.now();
  elements.messageInput.value = "";
  elements.messageInput.style.height = "auto";
  clearAttachments();
  stickyScroll(true);
});

elements.renameSessionButton.addEventListener("click", () => {
  elements.sessionNameInput.value = elements.sessionTitle.textContent || "";
  elements.renameDialog.showModal();
});
elements.cancelRenameButton.addEventListener("click", () => elements.renameDialog.close());
elements.renameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = elements.sessionNameInput.value.trim();
  elements.renameDialog.close();
  try {
    await renameActiveSession(title);
    toast(title ? "Conversation renamed" : "Original title restored");
  } catch (error) {
    toast(error.message, 8000);
  }
});
function toggleNotifications() {
  if (state.notificationsEnabled && notificationPermissionGranted()) disableNotifications().catch((error) => toast(error.message));
  else enableNotifications().catch((error) => toast(error.message));
}

elements.notifyButton.addEventListener("click", toggleNotifications);
elements.notificationToggleButton.addEventListener("click", toggleNotifications);
elements.completionSoundSelect.addEventListener("change", () => {
  state.completionSound = elements.completionSoundSelect.value;
  if (state.preferencesLoaded) savePreferencesInBackground({ completionSound: state.completionSound });
});
elements.previewSoundButton.addEventListener("click", () => {
  playCompletionSound(elements.completionSoundSelect.value).catch((error) => toast(error.message));
});
elements.abortButton.addEventListener("click", () => sendSocket({ type: "abort" }));
elements.messages.addEventListener(
  "scroll",
  () => {
    state.stickToBottom = isNearBottom();
    syncJumpButton();
  },
  { passive: true },
);
elements.jumpLatestButton.addEventListener("click", () => stickyScroll(true));
async function promptInstall() {
  if (!state.installPromptEvent) return;
  const promptEvent = state.installPromptEvent;
  promptEvent.prompt();
  await promptEvent.userChoice.catch(() => null);
  state.installPromptEvent = null;
  updateInstallButton();
}

elements.installAppButton.addEventListener("click", promptInstall);
elements.installBannerButton.addEventListener("click", promptInstall);
elements.dismissInstallButton.addEventListener("click", () => {
  state.installDismissed = true;
  if (state.preferencesLoaded) savePreferencesInBackground({ installDismissed: true });
  updateInstallButton();
});
elements.projectSearchInput.addEventListener("input", () => renderProjects());
elements.sessionSearchInput.addEventListener("input", () => renderSessions());
elements.attachButton.addEventListener("click", () => elements.attachmentInput.click());
elements.attachmentInput.addEventListener("change", async (event) => {
  try {
    await addAttachments(event.target.files || []);
  } catch (error) {
    toast(error.message);
    resetAttachmentInput();
  }
});
document.querySelectorAll(".command-strip button[data-command]").forEach((button) => {
  button.addEventListener("click", () => {
    const command = button.dataset.command || "";
    if (command === "/skill") {
      void openSkillsDialog();
      return;
    }
    elements.messageInput.value = command;
    elements.messageInput.focus();
    elements.messageInput.setSelectionRange(command.length, command.length);
  });
});

elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !event.shiftKey) return;
  event.preventDefault();
  elements.composer.requestSubmit();
});

elements.messageInput.addEventListener("input", () => {
  elements.messageInput.style.height = "auto";
  const maxHeight = matchMedia("(min-width: 1024px)").matches ? Math.min(innerHeight * 0.4, 360) : 160;
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, maxHeight)}px`;
});
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPromptEvent = event;
  updateInstallButton();
});

window.addEventListener("appinstalled", () => {
  state.installPromptEvent = null;
  updateInstallButton();
  toast("App installed");
});

// Resume the WebSocket after the phone UI returns to the foreground, after a
// back/forward cache restore, or when the network comes back online. Without
// this the connection stays "dropped" until the user sends a follow-up message.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  resumeConnection();
  ensureWatchSocket();
  refreshSessionsQuietly();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    resumeConnection(true);
    ensureWatchSocket();
    refreshSessionsQuietly();
  }
});
window.addEventListener("online", () => {
  resumeConnection(true);
  ensureWatchSocket();
});
window.addEventListener("focus", () => resumeConnection());

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => console.warn("Service worker registration failed", error));
  });
}

setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
syncNotifyButton();
updateInstallButton();
initializeApplication()
  .catch((error) => toast(error.message))
  .finally(revealApplication);
