import { renderMarkdown } from "./markdown.js";
import { renderBoard } from "./board.js";

const state = {
  projects: [],
  sessions: [],
  skills: [],
  skillsLoading: false,
  skillsProjectId: null,
  commands: [],
  commandsLoading: false,
  commandsKey: null,
  commandSuggestions: [],
  commandAutocompleteIndex: 0,
  pinnedProjectIds: [],
  pinnedSessionPaths: [],
  recentSessions: [],
  pendingReviews: [],
  pendingReviewsTimer: null,
  renameSessionId: null,
  renameSessionEngine: "pi",
  newSessionDraft: null,
  pendingSessionTitle: null,
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
  appMenuLoaded: false,
  activeNodeId: null,
  activeSessionId: null,
  chatFilter: "all",
  watchSocket: null,
  watchReconnectTimer: null,
  watchPingTimer: null,
  activeProjectId: null,
  activeSessionPath: null,
  activeTaskId: null,
  conversationLock: null,
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
  drafts: new Map(),
  promptHistory: new Map(),
  historyIndex: -1,
  historyDraft: "",
  durationTicker: 0,
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
  fileEditor: { path: null, version: null, original: "", loading: false, saving: false },
};

const TAKE_OWNERSHIP_WAIT_SECONDS = 5;
let ownershipWait = null;
let ownershipTaking = false;
const BOOT_MINIMUM_MS = 700;
const BOOT_REQUEST_TIMEOUT_MS = 8_000;
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
  chatProjectName: document.querySelector("#chatProjectName"),
  sessionTitle: document.querySelector("#sessionTitle"),
  connectionStatus: document.querySelector("#connectionStatus"),
  messages: document.querySelector("#messages"),
  jumpLatestButton: document.querySelector("#jumpLatestButton"),
  composer: document.querySelector("#composer"),
  commandStrip: document.querySelector("#commandStrip"),
  conversationLock: document.querySelector("#conversationLock"),
  conversationLockDetail: document.querySelector("#conversationLockDetail"),
  conversationLockStatus: document.querySelector("#conversationLockStatus"),
  conversationLockTakeButton: document.querySelector("#conversationLockTakeButton"),
  attachmentList: document.querySelector("#attachmentList"),
  attachmentInput: document.querySelector("#attachmentInput"),
  attachButton: document.querySelector("#attachButton"),
  messageInput: document.querySelector("#messageInput"),
  commandAutocomplete: document.querySelector("#commandAutocomplete"),
  sendButton: document.querySelector("#sendButton"),
  miniStatus: document.querySelector("#miniStatus"),
  turnTimer: document.querySelector("#turnTimer"),
  reconnectBanner: document.querySelector("#reconnectBanner"),
  reconnectBannerText: document.querySelector("#reconnectBannerText"),
  modelButton: document.querySelector("#modelButton"),
  modelButtonName: document.querySelector("#modelButtonName"),
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
  sessionTakeOwnershipButton: document.querySelector("#sessionTakeOwnershipButton"),
  sessionTransferProgress: document.querySelector("#sessionTransferProgress"),
  sessionTransferStatus: document.querySelector("#sessionTransferStatus"),
  sessionTransferWaitProgress: document.querySelector("#sessionTransferWaitProgress"),
  skipSessionTransferWaitButton: document.querySelector("#skipSessionTransferWaitButton"),
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
  chatModeControl: document.querySelector("#chatModeControl"),
  chatModeLabel: document.querySelector("#chatModeLabel"),
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
  recentSessionsDialog: document.querySelector("#recentSessionsDialog"),
  recentSessionsList: document.querySelector("#recentSessionsList"),
  recentSessionsSearchInput: document.querySelector("#recentSessionsSearchInput"),
  rowMenu: document.querySelector("#rowMenu"),
  closeRecentSessionsButton: document.querySelector("#closeRecentSessionsButton"),
  pendingReviewsBadge: document.querySelector("#pendingReviewsBadge"),
  navPendingReviewsBadge: document.querySelector("#navPendingReviewsBadge"),
  pendingReviewsDialog: document.querySelector("#pendingReviewsDialog"),
  pendingReviewsList: document.querySelector("#pendingReviewsList"),
  markAllPendingReviewedButton: document.querySelector("#markAllPendingReviewedButton"),
  closePendingReviewsButton: document.querySelector("#closePendingReviewsButton"),
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
  githubSyncButton: document.querySelector("#githubSyncButton"),
  githubSyncDialog: document.querySelector("#githubSyncDialog"),
  githubSyncForm: document.querySelector("#githubSyncForm"),
  githubSyncAllInput: document.querySelector("#githubSyncAllInput"),
  githubSyncNodeList: document.querySelector("#githubSyncNodeList"),
  cancelGithubSyncButton: document.querySelector("#cancelGithubSyncButton"),
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
  newSessionNameDialog: document.querySelector("#newSessionNameDialog"),
  newSessionNameForm: document.querySelector("#newSessionNameForm"),
  newSessionNameInput: document.querySelector("#newSessionNameInput"),
  cancelNewSessionNameButton: document.querySelector("#cancelNewSessionNameButton"),
  installBanner: document.querySelector("#installBanner"),
  installBannerButton: document.querySelector("#installBannerButton"),
  dismissInstallButton: document.querySelector("#dismissInstallButton"),
  navProjectsButton: document.querySelector("#navProjectsButton"),
  navSessionsButton: document.querySelector("#navSessionsButton"),
  navBoardButton: document.querySelector("#navBoardButton"),
  navChatButton: document.querySelector("#navChatButton"),
  appMenu: document.querySelector("#appMenu"),
  appMenuNode: document.querySelector("#appMenuNode"),
  appMenuVersion: document.querySelector("#appMenuVersion"),
  appMenuSettingsButton: document.querySelector("#appMenuSettingsButton"),
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
  markAllReviewedButton: document.querySelector("#markAllReviewedButton"),
  boardColumns: document.querySelector("#boardColumns"),
  boardProjectName: document.querySelector("#boardProjectName"),
  newTaskButton: document.querySelector("#newTaskButton"),
  chatPanel: document.querySelector("#chatPanel"),
  taskDialog: document.querySelector("#taskDialog"),
  taskChatHost: document.querySelector("#taskChatHost"),
  taskTabs: Array.from(document.querySelectorAll("[data-task-tab]")),
  taskForm: document.querySelector("#taskForm"),
  taskDialogTitle: document.querySelector("#taskDialogTitle"),
  taskTitleInput: document.querySelector("#taskTitleInput"),
  taskDescriptionInput: document.querySelector("#taskDescriptionInput"),
  taskStatusInput: document.querySelector("#taskStatusInput"),
  taskEngineInput: document.querySelector("#taskEngineInput"),
  taskPlanModeInput: document.querySelector("#taskPlanModeInput"),
  taskReviewModeInput: document.querySelector("#taskReviewModeInput"),
  taskSaveButton: document.querySelector("#taskForm [data-testid='task-form-save-button']"),
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
  secretAccountList: document.querySelector("#secretAccountList"),
  secretAccountAddButton: document.querySelector("#secretAccountAddButton"),
  secretAccountDialog: document.querySelector("#secretAccountDialog"),
  secretAccountForm: document.querySelector("#secretAccountForm"),
  secretAccountTitle: document.querySelector("#secretAccountTitle"),
  secretAccountLabelInput: document.querySelector("#secretAccountLabelInput"),
  secretAccountProviderInput: document.querySelector("#secretAccountProviderInput"),
  secretVariableRows: document.querySelector("#secretVariableRows"),
  secretVariableAddButton: document.querySelector("#secretVariableAddButton"),
  secretAccountCancelButton: document.querySelector("#secretAccountCancelButton"),
  secretScopeDialog: document.querySelector("#secretScopeDialog"),
  secretScopeForm: document.querySelector("#secretScopeForm"),
  secretScopeTitle: document.querySelector("#secretScopeTitle"),
  secretScopeList: document.querySelector("#secretScopeList"),
  secretScopeCancelButton: document.querySelector("#secretScopeCancelButton"),
  fileActionDialog: document.querySelector("#fileActionDialog"),
  fileActionPath: document.querySelector("#fileActionPath"),
  fileActionView: document.querySelector("#fileActionView"),
  fileActionDownloadLink: document.querySelector("#fileActionDownloadLink"),
  fileActionCancelButton: document.querySelector("#fileActionCancelButton"),
  fileActionEditButton: document.querySelector("#fileActionEditButton"),
  fileEditorView: document.querySelector("#fileEditorView"),
  fileEditorTextarea: document.querySelector("#fileEditorTextarea"),
  fileEditorCancelButton: document.querySelector("#fileEditorCancelButton"),
  fileEditorSaveButton: document.querySelector("#fileEditorSaveButton"),
  fileEditorStatus: document.querySelector("#fileEditorStatus"),
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
  let preferences = await api("/api/preferences", { signal: AbortSignal.timeout(BOOT_REQUEST_TIMEOUT_MS) });
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
  state.recentSessions = preferences.recentSessions || [];
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
  const [settings, authSessions] = await Promise.all([api("/api/settings"), api("/api/auth/sessions"), loadSecretAccounts()]);
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
  const text = document.createElement("span");
  text.className = "toast-message";
  text.textContent = message;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss");
  close.setAttribute("data-testid", "toast-close-button");
  const timer = setTimeout(() => node.remove(), duration);
  close.addEventListener("click", () => {
    clearTimeout(timer);
    node.remove();
  });
  node.append(text, close);
  const openDialog = document.querySelector("dialog[open]");
  (openDialog || document.body).append(node);
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
  elements.notifyButton.title = enabled ? "Notifications on — tap to turn off" : "Notify when a conversation needs review";
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

// Conversations enter review in every project, not only the open one, so a device subscribes once
// for all of them and stays subscribed before any project is selected.
async function subscribeToPush() {
  if (!state.notificationsEnabled || !notificationPermissionGranted()) return;
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
      projectId: "*",
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

// The pill renders as a 12px traffic light, so the state has to reach the user
// through the tooltip and the accessible name rather than visible text.
function setStatus(text, live = false, connecting = false) {
  elements.connectionStatus.textContent = text;
  elements.connectionStatus.title = text;
  elements.connectionStatus.classList.toggle("live", live);
  elements.connectionStatus.classList.toggle("connecting", connecting);
}

// The node name and release cannot change while this tab is open, so one lazy
// fetch on first open is enough.
async function loadAppMenuDetails() {
  if (state.appMenuLoaded) return;
  state.appMenuLoaded = true;
  const [{ node }, health] = await Promise.all([api("/api/cluster/node"), api("/api/health")]);
  elements.appMenuNode.textContent = node.name;
  elements.appMenuVersion.textContent = `Version ${/^[0-9a-f]{40}$/i.test(health.release) ? health.release.slice(0, 7) : health.release}`;
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

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(`${reader.result || ""}`);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
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
    const dataUrl = await fileToDataUrl(file);
    const [, data = ""] = dataUrl.split(",", 2);
    nextAttachments.push({ id: crypto.randomUUID(), kind: "file", name: file.name, mimeType: file.type || "application/octet-stream", data });
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

/** Lists paired nodes with a checkbox each so the user can push credentials to some or all of them. */
async function openGithubSyncDialog() {
  const { peers } = await api("/api/cluster/peers");
  elements.githubSyncNodeList.replaceChildren();
  elements.githubSyncAllInput.checked = false;
  if (!peers.length) {
    const empty = document.createElement("p");
    empty.className = "github-group-empty";
    empty.textContent = "No paired nodes yet. Add one in the Cluster tab first.";
    elements.githubSyncNodeList.append(empty);
  }
  for (const peer of peers) {
    const row = document.createElement("label");
    row.className = "checkbox-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = peer.id;
    input.dataset.testid = "github-sync-node-input";
    input.addEventListener("change", () => {
      elements.githubSyncAllInput.checked = githubSyncSelectedIds().length === peers.length;
    });
    row.append(input, document.createTextNode(` ${peer.name}${peer.online ? "" : " (offline)"}`));
    elements.githubSyncNodeList.append(row);
  }
  elements.githubSyncDialog.showModal();
}

function githubSyncSelectedIds() {
  return [...elements.githubSyncNodeList.querySelectorAll("input[type=checkbox]")].filter((input) => input.checked).map((input) => input.value);
}

async function submitGithubSync() {
  const peerIds = githubSyncSelectedIds();
  if (!peerIds.length) {
    toast("Pick at least one node");
    return;
  }
  const { results } = await api("/api/github-auth/sync", { method: "POST", body: JSON.stringify({ peerIds }) });
  const failed = results.filter((result) => result.error);
  elements.githubSyncDialog.close();
  toast(failed.length ? `Synced ${results.length - failed.length} of ${results.length} nodes; ${failed[0].name}: ${failed[0].error}` : `Synced credentials to ${results.length} ${results.length === 1 ? "node" : "nodes"}`);
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

    const secrets = document.createElement("button");
    secrets.type = "button";
    secrets.className = "ghost compact";
    secrets.textContent = "Secrets";
    secrets.dataset.testid = "project-type-secrets-button";
    secrets.addEventListener("click", () => openSecretScope("project_type", type.id, type.label).catch((error) => toast(error.message)));
    row.append(secrets);

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

/**
 * Names are keyed by conversation id, so a conversation can be named before it
 * has written a transcript.
 */
async function saveSessionTitle(sessionId, engine, title) {
  if (!state.activeProjectId || !sessionId) return;
  await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions/title`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, engine, title }),
  });
}

async function renameSession(sessionId, engine, title) {
  await saveSessionTitle(sessionId, engine, title);
  // Pi keeps its own live session name, so mirror it while the socket is open. Only the
  // open conversation has a socket, so a renamed row elsewhere just reloads the list.
  if (sessionId === state.activeSessionId && engine === "pi" && title) {
    sendSocket({ type: "rename", name: title });
  }
  await loadSessions();
}

/** The dialog is shared, so it remembers which conversation it was opened for. */
function openRenameDialog(sessionId, engine, currentTitle) {
  state.renameSessionId = sessionId;
  state.renameSessionEngine = engine;
  elements.sessionNameInput.value = currentTitle || "";
  elements.renameDialog.showModal();
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

/**
 * Row menu icons, in the same stroked 24px style as the nav bar. Paths only, so the
 * builder below stays a single loop.
 */
const rowMenuIconPaths = {
  pin: [
    "M12 17v5",
    "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
  ],
  pencil: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"],
  lock: [
    "M5 11h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z",
    "M8 11V7a4 4 0 0 1 8 0v4",
  ],
  folder: ["M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"],
  github: [
    "M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4",
    "M9 18c-4.51 2-5-2-7-2",
  ],
  key: [
    "M2.6 17.4A2 2 0 0 0 2 18.8V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.2a2 2 0 0 0 1.4-.6l.8-.8a6.5 6.5 0 1 0-4-4z",
    "M16.5 7.5h.01",
  ],
  refresh: ["M3 12a9 9 0 1 0 2.6-6.4", "M3 4v4h4"],
  merge: [
    "M7 4v9a5 5 0 0 0 5 5h5",
    "M7 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
    "M17 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  ],
  sliders: ["M4 8h10", "M18 8h2", "M4 16h4", "M12 16h8", "M16 6v4", "M10 14v4"],
  archive: [
    "M3.5 4.5h17a1 1 0 0 1 1 1V8a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1z",
    "M4.5 9v10a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V9",
    "M10 13h4",
  ],
  copy: [
    "M9.5 9.5h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z",
    "M5.5 14.5h-1a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1",
  ],
  check: ["M4.5 12.5l5 5 10-10"],
  transfer: ["M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5", "M10 8l4 4-4 4", "M14 12H4"],
  trash: [
    "M4 7h16",
    "M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13",
    "M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2",
    "M10 11v6",
    "M14 11v6",
  ],
};

/** Decorative: the button's own text already names the action. */
function menuIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "row-menu-icon");
  for (const d of rowMenuIconPaths[name]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/**
 * One shared menu serves every row: building a popup per row would clip it inside the
 * list's own scroll box. `popover` puts it in the top layer and handles Escape and
 * click-outside for us, so this only has to place it.
 */
function openRowMenu(anchor, items) {
  const menu = elements.rowMenu;
  menu.replaceChildren(...items.map((item) => {
    const entry = document.createElement("button");
    entry.type = "button";
    entry.className = item.danger ? "danger" : "";
    const label = document.createElement("span");
    label.textContent = item.label;
    entry.append(menuIcon(item.icon), label);
    entry.disabled = Boolean(item.disabled);
    if (item.title) entry.title = item.title;
    entry.dataset.testid = item.testid;
    entry.addEventListener("click", () => {
      menu.hidePopover();
      item.onSelect();
    });
    return entry;
  }));
  menu.showPopover();
  placeRowMenu(anchor);
  menu.querySelector("button:not(:disabled)")?.focus();
}

/** Anchor positioning is not in every browser yet, so the coordinates are measured here. */
function placeRowMenu(anchor) {
  const menu = elements.rowMenu;
  const button = anchor.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  const left = Math.min(Math.max(8, button.right - width), innerWidth - width - 8);
  const below = button.bottom + 6;
  const top = below + height > innerHeight - 8 ? Math.max(8, button.top - height - 6) : below;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
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
  // A background refresh must not leave a menu floating over rows that just moved.
  elements.rowMenu.togglePopover(false);
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
    const reviewCount = pendingReviewCountForProject(project.id);
    if (reviewCount) {
      const reviewBadge = document.createElement("em");
      reviewBadge.className = "project-review-badge";
      reviewBadge.dataset.testid = "project-review-badge";
      reviewBadge.textContent = `${reviewCount > 99 ? "99+" : reviewCount} to review`;
      reviewBadge.setAttribute("aria-label", `${reviewCount} conversations need review in ${project.name}`);
      button.append(reviewBadge);
    }
    if (project.lock) {
      const lockBadge = document.createElement("em");
      lockBadge.className = `project-lock-badge${project.lockedElsewhere ? " foreign" : ""}`;
      lockBadge.dataset.testid = "project-lock-badge";
      lockBadge.textContent = project.lockedElsewhere ? `\u{1F512} Locked by ${project.lock.nodeName}` : "\u{1F512} Locked to this node";
      button.append(lockBadge);
    }
    button.addEventListener("click", () => selectProject(project.id));

    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.className = "ghost icon-button row-action-button row-menu-button";
    menuButton.setAttribute("aria-label", `Actions for ${project.name}`);
    menuButton.setAttribute("aria-haspopup", "true");
    menuButton.title = "Project actions";
    menuButton.textContent = "\u22EE";
    menuButton.dataset.testid = "project-menu-button";
    menuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openRowMenu(menuButton, projectMenuItems(project));
    });

    row.append(button, menuButton);
    return row;
}

/** Seven inline buttons crowded the row off the screen; they all live in the menu now. */
function projectMenuItems(project) {
  const pinned = isProjectPinned(project.id);
  return [
    {
      label: pinned ? "Unpin from top" : "Pin to top",
      icon: "pin",
      testid: "project-pin-button",
      onSelect: () => togglePinnedProject(project.id),
    },
    {
      label: "Edit project",
      icon: "pencil",
      testid: "project-rename-button",
      onSelect: () => openProjectRename(project),
    },
    {
      label: project.lock ? "Unlock from this node" : "Lock to this node",
      icon: "lock",
      testid: "project-lock-button",
      title: project.lockedElsewhere ? `Locked by ${project.lock.nodeName} — select to unlock` : "",
      onSelect: () => toggleProjectLock(project).catch((error) => toast(error.message, 6000)),
    },
    {
      label: "Session path mappings",
      icon: "folder",
      testid: "project-path-mapping-button",
      onSelect: () => openProjectPathMapping(project),
    },
    {
      label: "GitHub access",
      icon: "github",
      testid: "project-github-button",
      onSelect: () => openProjectGithubSettings(project).catch((error) => toast(error.message)),
    },
    {
      label: "Secret accounts",
      icon: "key",
      testid: "project-secrets-button",
      onSelect: () => openSecretScope("project", project.id, project.name).catch((error) => toast(error.message)),
    },
    {
      label: "Rescan with Syncthing",
      icon: "refresh",
      testid: "project-rescan-button",
      disabled: !project.syncFolderId,
      title: project.syncFolderId ? "Rescan project with Syncthing" : "Project is not synchronized with Syncthing",
      onSelect: () => rescanProject(project).catch((error) => toast(error.message, 8000)),
    },
    {
      label: "Remove",
      icon: "trash",
      testid: "project-remove-button",
      danger: true,
      onSelect: () => removeProject(project).catch((error) => toast(error.message)),
    },
  ];
}

async function toggleProjectLock(project) {
  await api(`/api/projects/${encodeURIComponent(project.id)}/lock`, { method: "PUT", body: JSON.stringify({ locked: !project.lock }) });
  await refreshProjectsQuietly();
}

async function rescanProject(project) {
  toast(`Rescanning ${project.name}`);
  await api(`/api/projects/${encodeURIComponent(project.id)}/sync/rescan`, { method: "POST" });
  await refreshProjectsQuietly();
  toast(`Rescan complete for ${project.name}`);
}

async function removeProject(project) {
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
}

function markSessionReviewed(session) {
  if (session.reviewState !== "needs_review" || session.running) return;
  session.reviewState = "reviewed";
  renderSessions();
  void api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions/reviewed`, {
    method: "PUT",
    body: JSON.stringify({ sessionPath: session.path, updatedAt: session.updatedAt }),
  }).catch((error) => {
    session.reviewState = "needs_review";
    renderSessions();
    toast(error.message);
  });
}

function reviewableSessions() {
  return state.sessions.filter((session) => session.reviewState === "needs_review" && !session.running);
}

async function markAllSessionsReviewed() {
  const targets = reviewableSessions();
  if (!state.activeProjectId || !targets.length) return;
  const sessions = targets.map((session) => ({ sessionPath: session.path, updatedAt: session.updatedAt }));
  for (const session of targets) session.reviewState = "reviewed";
  renderSessions();
  try {
    await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions/reviewed-all`, {
      method: "PUT",
      body: JSON.stringify({ sessions }),
    });
  } catch (error) {
    for (const session of targets) session.reviewState = "needs_review";
    renderSessions();
    toast(error.message);
  }
}

/**
 * The review inbox spans every project, so the badge and the dialog read one server snapshot
 * rather than the active project's in-memory conversations.
 */
async function refreshPendingReviews() {
  const body = await api("/api/reviews/pending");
  state.pendingReviews = body.projects;
  renderPendingReviewsBadge();
  renderProjects();
}

/** Reviews pile up in projects you are not looking at, so the row carries the count. */
function pendingReviewCountForProject(projectId) {
  return state.pendingReviews.find((group) => group.projectId === projectId)?.sessions.length ?? 0;
}

function pendingReviewCount() {
  return state.pendingReviews.reduce((total, group) => total + group.sessions.length, 0);
}

function renderPendingReviewsBadge() {
  const count = pendingReviewCount();
  for (const badge of [elements.pendingReviewsBadge, elements.navPendingReviewsBadge]) {
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.hidden = count === 0;
  }
  elements.markAllPendingReviewedButton.disabled = count === 0;
}

function renderPendingReviewsDialog() {
  elements.pendingReviewsList.replaceChildren();
  if (!pendingReviewCount()) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Nothing is waiting for review.";
    elements.pendingReviewsList.append(empty);
    return;
  }
  for (const group of state.pendingReviews) {
    const heading = document.createElement("div");
    heading.className = "pending-reviews-group";
    heading.dataset.testid = "pending-reviews-group";
    heading.textContent = group.projectName;
    elements.pendingReviewsList.append(heading);
    for (const entry of group.sessions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "session-card";
      button.dataset.testid = "pending-review-option";
      // Rows are single-line, so the full title lives in the tooltip.
      button.title = entry.title;
      const title = document.createElement("strong");
      title.textContent = entry.title;
      const meta = document.createElement("span");
      meta.textContent = `${entry.agentLabel} · ${formatDate(entry.updatedAt)}`;
      button.append(title, meta);
      button.addEventListener("click", () => openPendingReview(group, entry).catch((error) => toast(error.message)));
      elements.pendingReviewsList.append(button);
    }
  }
}

/**
 * The snapshot can outlive the conversation it points at, so a stale row is dropped on the
 * click that discovers it rather than checked up front.
 */
async function openPendingReview(group, entry) {
  elements.pendingReviewsDialog.close();
  if (state.activeProjectId !== group.projectId) await selectProject(group.projectId);
  const session = state.sessions.find((candidate) => candidate.path === entry.path);
  if (!session) {
    toast("That conversation is no longer available");
    await refreshPendingReviews();
    return;
  }
  openListedSession(session);
  await refreshPendingReviews();
}

async function markAllPendingReviewed() {
  const groups = state.pendingReviews;
  if (!groups.length) return;
  for (const group of groups) {
    await api(`/api/projects/${encodeURIComponent(group.projectId)}/sessions/reviewed-all`, {
      method: "PUT",
      body: JSON.stringify({ sessions: group.sessions.map((entry) => ({ sessionPath: entry.path, updatedAt: entry.updatedAt })) }),
    });
  }
  // The open conversation list holds its own copy of the state the server just cleared.
  for (const session of state.sessions) {
    if (session.reviewState === "needs_review") session.reviewState = "reviewed";
  }
  renderSessions();
  await refreshPendingReviews();
  renderPendingReviewsDialog();
  toast("All conversations marked as read");
}

function openPendingReviewsDialog() {
  renderPendingReviewsDialog();
  elements.pendingReviewsDialog.showModal();
  // The badge may be up to a minute stale, and mark-all sends these exact watermarks.
  refreshPendingReviews()
    .then(renderPendingReviewsDialog)
    .catch((error) => toast(error.message));
}

function openListedSession(session) {
  markSessionReviewed(session);
  rememberRecentSession(session);
  state.activeSessionId = session.id;
  state.activeTaskId = session.taskId || null;
  openSession(session.path, shortSessionTitle(session), false, Boolean(state.activeTaskId));
}

/** Newest first; the cap keeps the dialog and the stored preference small. */
const RECENT_SESSIONS_LIMIT = 20;

function canonicalSessionPath(sessionPath) {
  return sessionPath.replace(/\.sync-conflict-[^/\\]+(?=\.jsonl$)/, "");
}

function rememberRecentSession(session) {
  const entry = {
    projectId: state.activeProjectId,
    sessionPath: canonicalSessionPath(session.path),
    title: shortSessionTitle(session),
    openedAt: new Date().toISOString(),
    updatedAt: session.updatedAt ?? session.createdAt ?? null,
  };
  const others = state.recentSessions.filter((candidate) =>
    candidate.projectId !== entry.projectId || canonicalSessionPath(candidate.sessionPath) !== entry.sessionPath);
  state.recentSessions = [entry, ...others].slice(0, RECENT_SESSIONS_LIMIT);
  if (state.preferencesLoaded) savePreferencesInBackground({ recentSessions: state.recentSessions });
}

/** When the conversation last moved, not when this browser last opened it. */
function recentSessionActivityAt(entry) {
  return entry.updatedAt || entry.openedAt;
}

/**
 * Conversations keep moving while the recents dialog is closed — a ticket run, or
 * another node writing through Syncthing — so every session-list render refreshes
 * the stored activity time for the project it just listed.
 */
function syncRecentSessionActivity() {
  let changed = false;
  state.recentSessions = state.recentSessions.map((entry) => {
    if (entry.projectId !== state.activeProjectId) return entry;
    const session = state.sessions.find((candidate) => canonicalSessionPath(candidate.path) === entry.sessionPath);
    const updatedAt = session?.updatedAt ?? session?.createdAt ?? null;
    if (!updatedAt || updatedAt === entry.updatedAt) return entry;
    changed = true;
    return { ...entry, updatedAt };
  });
  if (changed && state.preferencesLoaded) savePreferencesInBackground({ recentSessions: state.recentSessions });
}

/** Searching covers the project name too, since the same title repeats across projects. */
function recentSessionSearchText(entry) {
  const project = state.projects.find((candidate) => candidate.id === entry.projectId);
  return `${entry.title}\n${project ? project.name : ""}`.toLowerCase();
}

function forgetRecentSession(entry) {
  state.recentSessions = state.recentSessions.filter((candidate) =>
    candidate.projectId !== entry.projectId || candidate.sessionPath !== entry.sessionPath);
  if (state.preferencesLoaded) savePreferencesInBackground({ recentSessions: state.recentSessions });
  renderRecentSessionsDialog();
}

/**
 * The recents list can outlive the conversation or the project it points at, so a stale
 * entry is dropped on the click that discovers it rather than checked up front.
 */
async function openRecentSession(entry) {
  elements.recentSessionsDialog.close();
  if (state.activeProjectId !== entry.projectId) await selectProject(entry.projectId);
  const session = state.sessions.find((candidate) => candidate.path === entry.sessionPath);
  if (!session) {
    forgetRecentSession(entry);
    toast("That conversation is no longer available");
    return;
  }
  openListedSession(session);
}

/** Rows 1-10 carry a digit shortcut; the list is renumbered whenever the search narrows it. */
const RECENT_SESSION_SHORTCUT_LIMIT = 10;
let recentSessionShortcuts = [];

function renderRecentSessionsDialog() {
  elements.recentSessionsList.replaceChildren();
  recentSessionShortcuts = [];

  const query = normalizedQuery(elements.recentSessionsSearchInput.value || "");
  const byActivity = [...state.recentSessions].sort((left, right) =>
    recentSessionActivityAt(right).localeCompare(recentSessionActivityAt(left)));
  const ordered = sortPinnedFirst(byActivity, (entry) => isSessionPinned(entry.sessionPath));
  const matches = ordered.filter((entry) => !query || recentSessionSearchText(entry).includes(query));

  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = query ? "No conversations match that search." : "No conversations opened yet.";
    elements.recentSessionsList.append(empty);
    return;
  }

  for (const entry of matches) {
    const pinned = isSessionPinned(entry.sessionPath);
    const row = document.createElement("div");
    row.className = "list-row";

    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-card${pinned ? " pinned" : ""}`;
    button.dataset.testid = "recent-session-option";
    // Rows are single-line, so the full title lives in the tooltip.
    button.title = entry.title;
    if (recentSessionShortcuts.length < RECENT_SESSION_SHORTCUT_LIMIT) {
      recentSessionShortcuts.push(entry);
      const index = document.createElement("span");
      index.className = "recent-session-index";
      index.dataset.testid = "recent-session-index";
      index.textContent = recentSessionShortcuts.length === 10 ? "0" : String(recentSessionShortcuts.length);
      button.append(index);
    }
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const meta = document.createElement("span");
    const project = state.projects.find((candidate) => candidate.id === entry.projectId);
    meta.textContent = `${project ? project.name : "Unknown project"} · ${formatDate(recentSessionActivityAt(entry))}`;
    button.append(title, meta);
    button.addEventListener("click", () => openRecentSession(entry).catch((error) => toast(error.message)));

    const pinToggle = pinButton({
      pinned,
      label: pinned ? `Unpin ${entry.title}` : `Pin ${entry.title}`,
      testid: "recent-session-pin-button",
      onToggle: () => {
        togglePinnedSession(entry.sessionPath);
        renderRecentSessionsDialog();
      },
    });

    row.append(button, pinToggle);
    elements.recentSessionsList.append(row);
  }
}

function renderSessions() {
  syncRecentSessionActivity();
  // A background refresh must not leave a menu floating over rows that just moved.
  elements.rowMenu.togglePopover(false);
  elements.sessionList.replaceChildren();
  renderChatSessionControls();
  const project = selectedProject();
  elements.projectName.textContent = project?.name || "No project selected";
  elements.projectPath.textContent = project?.path || "Create or select a local folder.";
  elements.chatProjectName.textContent = project?.name || "No project selected";
  elements.chatProjectName.title = project?.name || "";
  elements.newSessionButton.disabled = !project || !state.sessionNodes.length;
  elements.newClaudeSessionButton.disabled = !project || !state.sessionNodes.length;
  updateChatFilterCounts();
  elements.markAllReviewedButton.disabled = !project || !reviewableSessions().length;

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

    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.className = "ghost icon-button row-action-button row-menu-button";
    menuButton.setAttribute("aria-label", `Actions for ${shortSessionTitle(session)}`);
    menuButton.setAttribute("aria-haspopup", "true");
    menuButton.title = "Conversation actions";
    menuButton.textContent = "\u22EE";
    menuButton.dataset.testid = "session-menu-button";
    menuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openRowMenu(menuButton, sessionMenuItems(session, sessionActive));
    });

    row.append(button, menuButton);
    elements.sessionList.append(row);
  }
}

/** Every row action lives in the overflow menu, so the row itself stays one tap target. */
function sessionMenuItems(session, sessionActive) {
  const name = shortSessionTitle(session);
  const pinned = isSessionPinned(session.path);
  const isClaude = session.path.startsWith("claude:");
  return [
    {
      label: pinned ? "Unpin from top" : "Pin to top",
      icon: "pin",
      testid: "session-pin-button",
      onSelect: () => togglePinnedSession(session.path),
    },
    {
      label: "Rename",
      icon: "pencil",
      testid: "session-rename-button",
      onSelect: () => openRenameDialog(session.id, isClaude ? "claude" : "pi", name),
    },
    {
      label: "Continue on another node",
      icon: "transfer",
      testid: "session-transfer-button",
      disabled: isClaude,
      title: isClaude ? "Claude transfer is not available yet" : "Transfer this idle Pi session",
      onSelect: () => transferSessionFromRow(session).catch((error) => toast(error.message)),
    },
    {
      label: "Remove",
      icon: "trash",
      testid: "session-remove-button",
      danger: true,
      onSelect: () => removeSessionFromRow(session, sessionActive).catch((error) => toast(error.message)),
    },
  ];
}

async function transferSessionFromRow(session) {
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
}

async function removeSessionFromRow(session, sessionActive) {
  if (!confirm(`Remove session "${shortSessionTitle(session)}"?`)) return;
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

// Durations read as "3.4s" under ten seconds, whole seconds up to a minute,
// then "1m 08s" and "1h 04m", so a glance is enough to compare two runs.
function formatDuration(ms) {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function messageTimestamp() {
  const stamp = document.createElement("time");
  stamp.className = "message-time";
  stamp.dataset.testid = "message-timestamp";
  const now = new Date();
  stamp.dateTime = now.toISOString();
  stamp.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return stamp;
}

// One shared tick drives every "still running" label. A timer per bubble would
// outlive the bubble on a conversation switch and keep the tab awake for nothing.
function startDurationTicker() {
  if (!state.durationTicker) state.durationTicker = setInterval(tickDurations, 1000);
}

function tickDurations() {
  for (const bubble of state.toolBubbles.values()) {
    if (bubble._startedAt) bubble.querySelector(".tool-status").textContent = `Running ${formatDuration(Date.now() - bubble._startedAt)}`;
  }
  if (state.lastTurnStartedAt) {
    elements.turnTimer.hidden = false;
    elements.turnTimer.textContent = `Working ${formatDuration(Date.now() - state.lastTurnStartedAt)}`;
  }
  if (!state.toolBubbles.size && !state.lastTurnStartedAt) {
    clearInterval(state.durationTicker);
    state.durationTicker = 0;
  }
}

// The finished turn's total belongs next to the answer it produced; the header
// timer keeps it too, for a turn that ended with tool output and no prose.
function finishTurnTimer() {
  const elapsed = Date.now() - state.lastTurnStartedAt;
  const stamps = elements.messages.querySelectorAll(".message.assistant .message-time");
  const stamp = stamps[stamps.length - 1];
  if (stamp && !stamp.dataset.turnDuration) {
    stamp.dataset.turnDuration = "true";
    stamp.append(` · took ${formatDuration(elapsed)}`);
  }
  elements.turnTimer.hidden = false;
  elements.turnTimer.textContent = `Took ${formatDuration(elapsed)}`;
}

function clearChat() {
  elements.messages.replaceChildren(elements.jumpLatestButton);
  elements.turnTimer.hidden = true;
  elements.turnTimer.textContent = "";
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

function projectFileUrl(filePath, download = false) {
  if (!state.activeProjectId || !filePath) return null;
  const url = projectFileApiUrl("file", filePath);
  if (download) url.searchParams.set("download", "1");
  return `${url.pathname}${url.search}`;
}

function projectFileApiUrl(route, filePath) {
  const url = new URL(`/api/projects/${encodeURIComponent(state.activeProjectId)}/${route}`, location.origin);
  url.searchParams.set("path", filePath);
  if (state.activeNodeId) url.searchParams.set("nodeId", state.activeNodeId);
  return url;
}

function projectFileContentUrl(filePath) {
  const url = projectFileApiUrl("file-content", filePath);
  return `${url.pathname}${url.search}`;
}

function resetFileEditor() {
  state.fileEditor = { path: null, version: null, original: "", loading: false, saving: false };
  elements.fileActionView.hidden = false;
  elements.fileEditorView.hidden = true;
  elements.fileEditorTextarea.value = "";
  elements.fileEditorStatus.textContent = "";
}

function openFileAction(path) {
  if (!state.activeProjectId || !path) return;
  resetFileEditor();
  state.fileEditor.path = path;
  elements.fileActionPath.textContent = path;
  elements.fileActionDownloadLink.href = projectFileUrl(path, true);
  elements.fileActionDialog.showModal();
}

async function editProjectFile() {
  const path = state.fileEditor.path;
  if (!path) return;
  state.fileEditor.loading = true;
  elements.fileActionEditButton.disabled = true;
  elements.fileEditorStatus.textContent = "Loading…";
  try {
    const body = await api(projectFileContentUrl(path));
    state.fileEditor.version = body.version;
    state.fileEditor.original = body.content;
    elements.fileEditorTextarea.value = body.content;
    elements.fileActionView.hidden = true;
    elements.fileEditorView.hidden = false;
    elements.fileEditorStatus.textContent = "";
    elements.fileEditorTextarea.focus();
  } catch (error) { toast(error.message, 8000); elements.fileEditorStatus.textContent = error.message; }
  finally { state.fileEditor.loading = false; elements.fileActionEditButton.disabled = false; }
}

function attemptCloseFileEditor() {
  if (state.fileEditor.saving) return;
  if (!elements.fileEditorView.hidden && elements.fileEditorTextarea.value !== state.fileEditor.original && !confirm("Discard unsaved changes?")) return;
  elements.fileActionDialog.close();
  resetFileEditor();
}

async function saveProjectFile() {
  const { path, version } = state.fileEditor;
  if (!path || !version) return;
  const session = activeChatSession();
  if (!session?.id) { toast("Open a persisted conversation before editing files"); return; }
  state.fileEditor.saving = true;
  elements.fileEditorSaveButton.disabled = true;
  try {
    await api(projectFileContentUrl(path), { method: "PUT", body: JSON.stringify({ content: elements.fileEditorTextarea.value, version, sessionId: session.id }) });
    elements.fileActionDialog.close();
    resetFileEditor();
    toast("File saved");
  } catch (error) { toast(error.message, 8000); }
  finally { state.fileEditor.saving = false; elements.fileEditorSaveButton.disabled = false; }
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
    const href = projectFileUrl(candidate, true);
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

// Coalesce bursts to one paint per frame. Assistant deltas stay plain text while
// streaming so markdown parsing cannot block the composer; the final event formats once.
function renderBubbleContent(bubble, text, flush = false) {
  bubble._raw = text;
  const content = bubble.querySelector(".message-content") || bubble;
  if (bubble.dataset.role === "assistant" && text && !flush && !bubble._hasRenderedText) {
    if (bubble._renderRaf) cancelAnimationFrame(bubble._renderRaf);
    bubble._renderRaf = 0;
    bubble._renderFinal = false;
    bubble._hasRenderedText = true;
    content.textContent = text;
    stickyScroll();
    return;
  }
  bubble._renderFinal = bubble._renderFinal || flush;
  if (bubble._renderRaf) return;
  bubble._renderRaf = requestAnimationFrame(() => {
    bubble._renderRaf = 0;
    const role = bubble.dataset.role;
    if (role === "assistant" && !bubble._renderFinal) content.textContent = bubble._raw;
    else if (role === "assistant" || role === "user") {
      renderMarkdown(content, bubble._raw, { resolveFileUrl: role === "assistant" ? projectFileUrl : undefined });
    }
    else if (role === "tool-output") renderToolContent(content, bubble._raw);
    else content.textContent = prettyText(bubble._raw);
    bubble._renderFinal = false;
    stickyScroll();
  });
}

// The Claude harness streams text deltas with no completion event, so a bubble
// left in plain-text mode never gets its markdown pass and shows raw "##" and
// backticks until the transcript is reloaded. Flush it whenever the stream
// moves on from the current assistant bubble.
function finalizeAssistantBubble() {
  if (state.assistantBubble) renderBubbleContent(state.assistantBubble, state.assistantBubble._raw, true);
  state.assistantBubble = null;
}

function copyGlyph(name) {
  const icon = menuIcon(name);
  icon.setAttribute("class", "message-copy-icon");
  return icon;
}

// The button reads bubble._raw when clicked rather than when built, so copying a
// streamed assistant message yields its finished text and not its first delta.
function appendCopyButton(bubble) {
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-copy";
  button.title = "Copy message";
  button.setAttribute("aria-label", "Copy message");
  button.dataset.testid = "message-copy-button";
  button.append(copyGlyph("copy"));
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(bubble._raw);
      button.classList.add("copied");
      button.replaceChildren(copyGlyph("check"));
      setTimeout(() => {
        button.classList.remove("copied");
        button.replaceChildren(copyGlyph("copy"));
      }, 1500);
    } catch (error) {
      toast(error.message || "Could not copy message");
    }
  });
  actions.append(button);
  bubble.after(actions);
}

// A replayed transcript carries no recorded times, so it opts out of the stamp
// rather than labelling week-old messages with the moment they were re-rendered.
function appendMessage(role, text, timestamped = true) {
  elements.messages.querySelector(".empty-state")?.remove();
  const bubble = document.createElement("article");
  bubble.className = `message ${role}`;
  bubble.dataset.role = role;
  const isMarkdown = role === "assistant" || role === "user";
  const content = document.createElement(isMarkdown ? "div" : "pre");
  content.className = `message-content${isMarkdown ? " md" : ""}`;
  bubble.append(content);
  if (timestamped && (role === "user" || role === "assistant")) bubble.append(messageTimestamp());
  renderBubbleContent(bubble, text, true);
  elements.messages.insertBefore(bubble, elements.jumpLatestButton);
  if (isMarkdown) appendCopyButton(bubble);
  stickyScroll();
  return bubble;
}

// startedAt is 0 for a replayed transcript entry: it already finished, at a
// time this client never saw, so it gets no elapsed label.
function appendToolMessage(toolName, toolCallId, startedAt = Date.now()) {
  const bubble = document.createElement("details");
  bubble.className = "message tool-output";
  bubble.dataset.role = "tool-output";
  bubble._startedAt = startedAt;

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
  const elapsed = bubble._startedAt ? formatDuration(Date.now() - bubble._startedAt) : "";
  const label = !elapsed ? status : status === "Running" ? `${status} ${elapsed}` : `${status} in ${elapsed}`;
  bubble.querySelector(".tool-status").textContent = label;
  renderBubbleContent(bubble, text);
}

// A saved transcript interleaves chat text with tool results. Rendering every
// non-user entry as assistant markdown reflowed file dumps into prose, so each
// role gets the same bubble the live stream would have produced.
function appendTranscript(messages) {
  for (const message of messages || []) {
    if (message.role === "toolResult" || message.role === "toolCall") {
      const bubble = appendToolMessage(message.toolName || "tool", `history-${message.id}`, 0);
      updateToolMessage(bubble, message.text, "Done");
      continue;
    }
    appendMessage(message.role === "user" ? "user" : "assistant", message.text, false);
  }
  // Bubbles render their markdown on the next animation frame, so the height
  // during the loop above is not final and the scroll events it fires can clear
  // stickToBottom. Pin to the bottom after that frame so an opened conversation
  // starts on the newest message.
  requestAnimationFrame(() => stickyScroll(true));
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
    label = active?.label || state.activeModelLabel || "Model";
  } else {
    const active = state.models.find((model) => `${model.provider}/${model.id}` === state.activeModelKey);
    label = active?.label || state.activeModelLabel || "Model";
  }
  elements.modelButtonName.textContent = label;
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

async function loadSkills(force = false) {
  const projectId = state.activeProjectId;
  if (!projectId) {
    state.skills = [];
    state.skillsProjectId = null;
    return;
  }
  if ((!force && state.skillsProjectId === projectId) || state.skillsLoading) return;
  state.skillsLoading = true;
  renderSkillsDialog();
  try {
    const body = await api(`/api/projects/${encodeURIComponent(projectId)}/skills`);
    if (state.activeProjectId !== projectId) return;
    state.skills = body.skills;
    state.skillsProjectId = projectId;
  } catch (error) {
    if (state.activeProjectId === projectId) {
      state.skills = [];
      state.skillsProjectId = projectId;
      toast(error.message);
    }
  } finally {
    if (state.activeProjectId === projectId) {
      state.skillsLoading = false;
      renderSkillsDialog();
      renderCommandAutocomplete();
    }
  }
}

async function openSkillsDialog() {
  elements.skillsDialogSearchInput.value = "";
  elements.skillsDialog.showModal();
  renderSkillsDialog();
  await loadSkills(true);
  if (elements.skillsDialog.open) elements.skillsDialogSearchInput.focus();
}

const LOCAL_COMMANDS = [
  { name: "skill", description: "Browse installed skills", invocation: "/skill ", kind: "builtin" },
  { name: "model", description: "Choose the session model", invocation: "/model ", kind: "builtin" },
  { name: "tools", description: "Configure available tools", invocation: "/tools ", kind: "builtin" },
  { name: "compact", description: "Compact conversation context", invocation: "/compact ", kind: "builtin" },
];

function commandSourceKey() {
  return `${state.activeProjectId}:${state.engine}`;
}

async function loadCommands() {
  const projectId = state.activeProjectId;
  const harness = state.engine;
  const key = commandSourceKey();
  if (!projectId || state.commandsLoading || state.commandsKey === key) return;
  state.commandsLoading = true;
  try {
    const body = await api(`/api/projects/${encodeURIComponent(projectId)}/commands?harness=${encodeURIComponent(harness)}`);
    if (commandSourceKey() !== key) return;
    state.commands = body.commands;
    state.commandsKey = key;
  } catch (error) {
    if (commandSourceKey() === key) {
      state.commands = [];
      state.commandsKey = key;
      toast(error.message);
    }
  } finally {
    if (commandSourceKey() === key) {
      state.commandsLoading = false;
      renderCommandAutocomplete();
    }
  }
}

function slashCommandQuery() {
  const { selectionStart, selectionEnd, value } = elements.messageInput;
  if (selectionStart !== selectionEnd || selectionEnd !== value.length) return null;
  const match = /^\/([^\s]*)$/.exec(value);
  return match ? match[1].toLowerCase() : null;
}

function commandMatchesQuery(command, query) {
  return !query || `${command.name}\n${command.description}`.toLowerCase().includes(query);
}

function hideCommandAutocomplete() {
  state.commandSuggestions = [];
  state.commandAutocompleteIndex = 0;
  elements.commandAutocomplete.hidden = true;
  elements.messageInput.setAttribute("aria-expanded", "false");
  elements.messageInput.removeAttribute("aria-activedescendant");
}

function commandAutocompleteOpen() {
  return !elements.commandAutocomplete.hidden && state.commandSuggestions.length > 0;
}

function selectCommandSuggestion(index = state.commandAutocompleteIndex) {
  const suggestion = state.commandSuggestions[index];
  if (!suggestion) return;
  setInputValue(suggestion.invocation);
  hideCommandAutocomplete();
  elements.messageInput.focus();
}

function renderCommandAutocomplete() {
  const query = slashCommandQuery();
  if (query === null || elements.messageInput.disabled) {
    hideCommandAutocomplete();
    return;
  }
  if (state.activeProjectId && state.commandsKey !== commandSourceKey()) void loadCommands();

  const commands = state.commandsKey === commandSourceKey()
    ? state.commands
    : LOCAL_COMMANDS.map((command) => ({ ...command, harness: state.engine }));
  state.commandSuggestions = commands
    .filter((command) => command.harness === state.engine)
    .filter((command) => commandMatchesQuery(command, query))
    .slice(0, 10);
  if (!state.commandSuggestions.length) {
    hideCommandAutocomplete();
    return;
  }

  state.commandAutocompleteIndex = Math.min(state.commandAutocompleteIndex, state.commandSuggestions.length - 1);
  elements.commandAutocomplete.replaceChildren();
  state.commandSuggestions.forEach((suggestion, index) => {
    const option = document.createElement("button");
    option.type = "button";
    option.id = `command-autocomplete-option-${index}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(index === state.commandAutocompleteIndex));
    option.dataset.testid = "chat-command-autocomplete-option";
    const name = document.createElement("span");
    name.className = "command-autocomplete-name";
    name.textContent = suggestion.invocation.trim();
    const description = document.createElement("span");
    description.className = "command-autocomplete-description";
    description.textContent = suggestion.description;
    option.append(name, description);
    option.addEventListener("pointerdown", (event) => event.preventDefault());
    option.addEventListener("click", () => selectCommandSuggestion(index));
    elements.commandAutocomplete.append(option);
  });
  elements.commandAutocomplete.hidden = false;
  elements.messageInput.setAttribute("aria-expanded", "true");
  elements.messageInput.setAttribute("aria-activedescendant", `command-autocomplete-option-${state.commandAutocompleteIndex}`);
  elements.commandAutocomplete.children[state.commandAutocompleteIndex]?.scrollIntoView({ block: "nearest" });
}

function renderReasoningOptions() {
  const hasLevels = state.availableThinkingLevels.length > 0;
  elements.chatModeLabel.textContent = state.engine === "claude" ? "Effort" : "Thinking";
  elements.reasoningLevelSelect.replaceChildren();
  for (const level of state.availableThinkingLevels) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = level;
    elements.reasoningLevelSelect.append(option);
  }
  elements.reasoningLevelSelect.value = state.thinkingLevel;
  elements.chatModeControl.hidden = !hasLevels;
}

function changeReasoningLevel(event) {
  const level = event.currentTarget.value;
  const payload = state.engine === "claude"
    ? { type: "setEffort", effort: level }
    : { type: "setThinking", level };
  if (!sendSocket(payload)) toast("Not connected");
}

function renderModelDialog() {
  const isClaude = state.engine === "claude";
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
  // A conversation owned elsewhere fences every write on the owner node, so the
  // composer stays dead no matter how healthy this node's socket looks.
  const allowed = enabled && !state.conversationLock;
  elements.messageInput.disabled = !allowed;
  elements.sendButton.disabled = !allowed;
  elements.attachButton.disabled = !allowed;
  elements.attachmentInput.disabled = !allowed;
  elements.renameSessionButton.disabled = !allowed;
  elements.modelButton.disabled = !allowed;
  elements.reasoningLevelSelect.disabled = !allowed;
  if (!allowed) hideCommandAutocomplete();
  syncSafeguardsButton();
}

function renderConversationLock() {
  const lock = state.conversationLock;
  elements.conversationLock.hidden = !lock;
  elements.composer.hidden = Boolean(lock);
  elements.commandStrip.hidden = Boolean(lock);
  if (!lock) {
    elements.conversationLockStatus.textContent = "";
    return;
  }
  const takeable = !state.activeTaskId;
  elements.conversationLockDetail.textContent = lock.status === "conflict"
    ? `Ownership is conflicted between this node and ${lock.nodeName}. Writes stay fenced until one node takes ownership.`
    : takeable
      ? `This conversation is owned by ${lock.nodeName}. Anything you send from here is rejected until you take ownership.`
      : `This conversation is owned by ${lock.nodeName}. Open it there to continue \u2014 a ticket conversation stays on its node.`;
  elements.conversationLockTakeButton.hidden = !takeable;
  elements.conversationLockTakeButton.disabled = !takeable || ownershipTaking || Boolean(ownershipWait);
  elements.conversationLockTakeButton.title = takeable ? `Move ownership to this node from ${lock.nodeName}` : "";
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
  renderReasoningOptions();
  syncModelButton();
  syncSafeguardsButton();
}

function syncReasoningControls(status) {
  state.thinkingLevel = status.thinkingLevel || (state.engine === "claude" ? "default" : "off");
  Object.assign(state, { availableThinkingLevels: status.availableThinkingLevels || [] });
  if (state.engine === "claude") state.claudeEffort = state.thinkingLevel;
  renderReasoningOptions();
}

function updateStatus(status) {
  if (!status) return;
  if (!status.isStreaming) clearThinkingBubble();
  state.sessionBusy = Boolean(status.isStreaming || status.isBashRunning || status.isCompacting || status.isRetrying);
  if (typeof status.safeguardsEnabled === "boolean") state.safeguardsEnabled = status.safeguardsEnabled;
  const busy = status.isStreaming ? "working" : "ready";
  const queue = status.pendingMessageCount ? ` • ${status.pendingMessageCount} queued` : "";
  const node = state.sessionNodes.find((candidate) => candidate.id === state.activeNodeId);
  elements.miniStatus.textContent = `${node?.name || "Node"} • thinking ${status.thinkingLevel} • ${status.messageCount} msgs • ${status.activeTools.length} tools • ${busy}${queue}`;
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
  // Scanning every project's transcripts is far heavier than a project list refresh,
  // so the review badge runs on its own, slower clock.
  if (state.pendingReviewsTimer) clearInterval(state.pendingReviewsTimer);
  state.pendingReviewsTimer = setInterval(() => {
    refreshPendingReviews().catch((error) => console.warn("Could not refresh pending reviews", error));
  }, 60_000);
  refreshPendingReviews().catch((error) => console.warn("Could not load pending reviews", error));
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
  state.skills = [];
  state.skillsLoading = false;
  state.skillsProjectId = null;
  state.commands = [];
  state.commandsLoading = false;
  state.commandsKey = null;
  hideCommandAutocomplete();
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
  state.sessions = [];
  setListLoading("sessions", true);
  renderSessions();
  setMobileView("sessions");
  void loadSessionNodes(projectId).catch((error) => toast(error.message, 8000));
  let body;
  try {
    body = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
  } finally {
    if (state.activeProjectId === projectId) setListLoading("sessions", false);
  }
  // A newer switch can land while this request is in flight; a late response
  // must never paint one project's conversations under another.
  if (state.activeProjectId !== projectId) return;
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
  rememberDraft();
  // A turn left running on the conversation being left must not keep counting
  // up in the header of the one being opened.
  state.lastTurnStartedAt = 0;
  if (!preserveTask) state.activeTaskId = null;
  if (state.activeTaskId) {
    const task = state.tasks.find((candidate) => candidate.id === state.activeTaskId);
    if (task) state.activeNodeId = task.currentNodeId;
  }
  closeSocket();
  if (!preserveChat) {
    state.pendingSessionTitle = null;
    clearChat();
    clearAttachments();
    const node = state.sessionNodes.find((candidate) => candidate.id === state.activeNodeId);
    showChatEmptyState("Connecting…", `Opening this conversation on ${node?.name || "the selected node"}.`);
  }
  state.activeSessionPath = sessionPath || "new";
  restoreDraft();
  state.conversationLock = null;
  renderConversationLock();
  if (state.preferencesLoaded) savePreferencesInBackground({ activeSessionPath: state.activeSessionPath, activeSessionId: state.activeSessionId });
  state.engine = state.activeSessionPath.startsWith("claude:") ? "claude" : "pi";
  elements.sessionTitle.textContent = title;
  renderSessions();
  // A reconnect reuses this function. Switching panels there would yank the user
  // off the board (or any other view) every time a socket blips.
  if (!preserveChat) setMobileView("chat");
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
  socket.addEventListener("message", (event) => handleSocketPayload(JSON.parse(event.data)));
}

function handleSocketPayload(payload) {
  if (payload.type === "updatePreparing") {
    const message = payload.message || "Updating... Work will resume automatically.";
    setConnecting(true, message);
    elements.miniStatus.textContent = message;
    setComposerEnabled(false);
    return;
  }
  if (payload.type === "pong") {
    state.lastPongAt = Date.now();
    return;
  }
  if (payload.type === "ready") {
    const openingDraft = ["new", "claude:new"].includes(state.activeSessionPath);
    state.conversationLock = payload.ownership ?? null;
    state.engine = payload.engine || "pi";
    setComposerEnabled(true);
    renderConversationLock();
    state.activeSessionId = payload.sessionId || state.activeSessionId;
    syncEngineUI();
    if (payload.sessionFile) {
      setActiveSessionPath(payload.sessionFile);
      if (state.preferencesLoaded) savePreferencesInBackground({ activeSessionPath: payload.sessionFile, activeSessionId: state.activeSessionId });
    }
    // The conversation now has an id, so a name typed before it existed can be
    // saved straight away instead of riding on the first turn finishing.
    const pendingTitle = state.pendingSessionTitle;
    if (pendingTitle && payload.sessionId) {
      state.pendingSessionTitle = null;
      saveSessionTitle(payload.sessionId, state.engine, pendingTitle)
        .then(() => loadSessions())
        .catch((error) => toast(error.message, 8000));
    }
    const matchingSession = state.sessions.find((session) => session.path === payload.sessionFile);
    elements.sessionTitle.textContent = pendingTitle
      ? pendingTitle
      : matchingSession
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
  if (payload.type === "ownership") {
    state.conversationLock = payload.ownership ?? null;
    setComposerEnabled(socketOpen());
    renderConversationLock();
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
      setActiveSessionPath(payload.sessionFile);
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
    finalizeAssistantBubble();
    appendMessage("user", payload.text);
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
    else renderBubbleContent(state.assistantBubble, payload.text, true);
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
    finalizeAssistantBubble();
    const bubble = appendToolMessage(payload.toolName, payload.toolCallId);
    state.toolBubbles.set(payload.toolCallId, bubble);
    startDurationTicker();
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
    finalizeAssistantBubble();
    appendMessage("tool", `${state.engine === "claude" ? "Claude" : "Pi"} error: ${payload.error}`);
  }
  if (payload.type === "agent_start") {
    setStatus(`${state.engine === "claude" ? "Claude" : "Pi"} is working`, true);
    state.lastTurnStartedAt = Date.now();
    state.sessionBusy = true;
    startDurationTicker();
    syncSafeguardsButton();
  }
  if (payload.type === "agent_end") {
    clearThinkingBubble();
    finalizeAssistantBubble();
    setStatus("Connected", true);
    state.sessionBusy = false;
    syncSafeguardsButton();
    if (state.lastTurnStartedAt) {
      finishTurnTimer();
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
  if (payload.type === "error") toast(payload.error, 6000);
}

async function refreshSessionsQuietly() {
  const projectId = state.activeProjectId;
  if (!projectId || state.sessionsRefreshing) return;
  state.sessionsRefreshing = true;
  const previousStates = new Map(state.sessions.map((session) => [session.path, session.reviewState]));
  try {
    const body = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
    // The active project can change mid-request; a late response must not
    // overwrite the newly selected project's conversations.
    if (state.activeProjectId !== projectId) return;
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
  elements.rowMenu.togglePopover(false);
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
    onMenu: (anchor, items) => openRowMenu(anchor, items),
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
  const projectId = state.activeProjectId;
  if (!projectId) {
    state.tasks = [];
    renderBoardView();
    return;
  }
  try {
    const body = await api(`/api/projects/${encodeURIComponent(projectId)}/tasks`);
    // The active project can change mid-request; a late response must not
    // show one project's tasks on another project's board.
    if (state.activeProjectId !== projectId) return;
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

/**
 * The five live chat nodes, in the order they sit inside the chat panel. They are
 * moved into the ticket dialog rather than copied, so streaming, tool bubbles,
 * attachments and every existing `elements.*` reference keep working untouched.
 */
function taskChatNodes() {
  return [
    elements.messages,
    elements.reconnectBanner,
    elements.commandStrip,
    elements.conversationLock,
    elements.composer,
  ];
}

function attachChatToTaskDialog() {
  for (const node of taskChatNodes()) elements.taskChatHost.append(node);
}

function detachChatFromTaskDialog() {
  for (const node of taskChatNodes()) elements.chatPanel.append(node);
}

function setTaskDialogTab(tab) {
  for (const button of elements.taskTabs) {
    const selected = button.dataset.taskTab === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  elements.taskForm.hidden = tab !== "ticket";
  elements.taskChatHost.hidden = tab !== "conversation";
  if (tab === "conversation") stickyScroll(true);
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

  const conversationTab = elements.taskTabs.find((button) => button.dataset.taskTab === "conversation");
  conversationTab.disabled = !task.sessionPath;
  attachChatToTaskDialog();
  // Reading the ticket's own conversation is the common reason to open this, so
  // it wins the default tab whenever there is one to read.
  setTaskDialogTab(task.sessionPath ? "conversation" : "ticket");
  elements.taskDialog.showModal();
  if (task.sessionPath && task.sessionPath !== state.activeSessionPath) {
    state.activeTaskId = task.id;
    // openSession switches the visible panel to the chat; the user opened this
    // from the board and expects to land back there when the dialog closes.
    const returnView = history.state?.mobileView ?? "board";
    openSession(task.sessionPath, task.title, false, true);
    setMobileView(returnView, false);
  }
}

/** Puts the chat back in its panel before the dialog goes away with it inside. */
function closeTaskDialog() {
  detachChatFromTaskDialog();
  elements.taskDialog.close();
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
elements.markAllReviewedButton.addEventListener("click", () => { void markAllSessionsReviewed(); });
elements.cancelTaskButton.addEventListener("click", () => closeTaskDialog());
// Esc and the backdrop close the dialog without touching a button.
elements.taskDialog.addEventListener("close", () => {
  if (elements.taskChatHost.firstChild) detachChatFromTaskDialog();
  elements.taskChatHost.hidden = true;
  elements.taskForm.hidden = false;
});

for (const tab of elements.taskTabs) {
  tab.addEventListener("click", () => setTaskDialogTab(tab.dataset.taskTab));
}

elements.taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const creating = !state.editingTaskId;
  elements.taskSaveButton.disabled = true;
  elements.taskSaveButton.textContent = creating ? "Creating ticket…" : "Saving…";
  elements.taskForm.setAttribute("aria-busy", "true");
  try {
    await saveTaskFromDialog();
    closeTaskDialog();
  } catch (error) {
    toast(error.message, 8000);
  } finally {
    elements.taskSaveButton.disabled = false;
    elements.taskSaveButton.textContent = "Save task";
    elements.taskForm.removeAttribute("aria-busy");
  }
});
elements.deleteTaskButton.addEventListener("click", async () => {
  if (!confirm("Delete this task?")) return;
  try {
    await deleteEditingTask();
    closeTaskDialog();
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
elements.githubSyncButton.addEventListener("click", () => openGithubSyncDialog().catch((error) => toast(error.message)));
elements.cancelGithubSyncButton.addEventListener("click", () => elements.githubSyncDialog.close());
elements.githubSyncAllInput.addEventListener("change", () => {
  for (const input of elements.githubSyncNodeList.querySelectorAll("input[type=checkbox]")) input.checked = elements.githubSyncAllInput.checked;
});
elements.githubSyncForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitGithubSync().catch((error) => toast(error.message));
});
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

elements.messages.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-file-path]");
  if (!link) return;
  event.preventDefault();
  openFileAction(link.dataset.filePath);
});
elements.fileActionEditButton.addEventListener("click", () => editProjectFile());
elements.fileActionCancelButton.addEventListener("click", attemptCloseFileEditor);
elements.fileEditorSaveButton.addEventListener("click", () => saveProjectFile());
elements.fileEditorCancelButton.addEventListener("click", attemptCloseFileEditor);
elements.fileActionDialog.addEventListener("cancel", (event) => { event.preventDefault(); attemptCloseFileEditor(); });
elements.fileActionDownloadLink.addEventListener("click", () => setTimeout(() => {
  elements.fileActionDialog.close();
  resetFileEditor();
}));
elements.loginForm.addEventListener("submit", submitLogin);
/** A conversation is named up front so the list shows the user's own label from the first turn. */
function openNewSessionNameDialog(sessionPath, defaultTitle) {
  state.newSessionDraft = { sessionPath, defaultTitle };
  elements.newSessionNameInput.value = "";
  elements.newSessionNameDialog.showModal();
}
elements.newSessionButton.addEventListener("click", () => openNewSessionNameDialog(null, "New Pi conversation"));
elements.newClaudeSessionButton.addEventListener("click", () => openNewSessionNameDialog("claude:new", "New Claude conversation"));
elements.cancelNewSessionNameButton.addEventListener("click", () => elements.newSessionNameDialog.close());
elements.newSessionNameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const draft = state.newSessionDraft;
  const title = elements.newSessionNameInput.value.trim();
  elements.newSessionNameDialog.close();
  state.newSessionDraft = null;
  state.activeSessionId = null;
  openSession(draft.sessionPath, title || draft.defaultTitle);
  state.pendingSessionTitle = title || null;
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
  state.commands = [];
  state.commandsLoading = false;
  state.commandsKey = null;
  state.commandAutocompleteIndex = 0;
  renderCommandAutocomplete();
  if (!sendSocket({ type: "setEngine", engine: harness.id })) {
    openSession(harness.newSessionPath, `New ${harness.label} conversation`);
  }
});
elements.reasoningLevelSelect.addEventListener("change", changeReasoningLevel);
elements.collapseProjectsButton.addEventListener("click", () => setPanelCollapsed("projects", true));
/** One dialog, several triggers: the projects header, the conversations header, and the chat menu. */
function openRecentSessionsDialog() {
  elements.recentSessionsSearchInput.value = "";
  renderRecentSessionsDialog();
  elements.recentSessionsDialog.showModal();
  // Digits are shortcuts, so focus must start on the list rather than in the search field.
  elements.recentSessionsList.focus();
}
for (const trigger of document.querySelectorAll("[data-recent-sessions-open]")) {
  trigger.addEventListener("click", openRecentSessionsDialog);
}
elements.recentSessionsSearchInput.addEventListener("input", () => renderRecentSessionsDialog());
elements.recentSessionsDialog.addEventListener("keydown", (event) => {
  if (event.target === elements.recentSessionsSearchInput) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const position = event.key === "0" ? 10 : Number(event.key);
  if (!Number.isInteger(position) || position < 1 || position > RECENT_SESSION_SHORTCUT_LIMIT) return;
  const entry = recentSessionShortcuts[position - 1];
  if (!entry) return;
  event.preventDefault();
  openRecentSession(entry).catch((error) => toast(error.message));
});
/** Ctrl/Cmd+K reaches the recents list from any view, including mid-conversation. */
document.addEventListener("keydown", (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey) return;
  if (event.key.toLowerCase() !== "k") return;
  event.preventDefault();
  if (elements.recentSessionsDialog.open) {
    elements.recentSessionsDialog.close();
    return;
  }
  openRecentSessionsDialog();
});
elements.closeRecentSessionsButton.addEventListener("click", () => elements.recentSessionsDialog.close());

for (const trigger of document.querySelectorAll("[data-pending-reviews-open]")) {
  trigger.addEventListener("click", openPendingReviewsDialog);
}
elements.markAllPendingReviewedButton.addEventListener("click", () => {
  markAllPendingReviewed().catch((error) => toast(error.message));
});
elements.closePendingReviewsButton.addEventListener("click", () => elements.pendingReviewsDialog.close());

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
function setOwnershipTransferControls(disabled) {
  elements.sessionTransferNodeSelect.disabled = disabled;
  elements.sessionTransferForm.querySelector('[type="submit"]').disabled = disabled;
  elements.sessionTakeOwnershipButton.disabled = disabled;
}

function resetOwnershipWait() {
  if (ownershipWait) ownershipWait.resolve(false);
  ownershipWait = null;
  ownershipTaking = false;
  elements.sessionTransferProgress.hidden = true;
  elements.sessionTransferWaitProgress.value = TAKE_OWNERSHIP_WAIT_SECONDS;
  elements.sessionTransferStatus.textContent = "Waiting for Syncthing…";
  elements.skipSessionTransferWaitButton.disabled = false;
  setOwnershipTransferControls(false);
  elements.conversationLockStatus.textContent = "";
  renderConversationLock();
}

// Syncthing may still be copying the owner node's transcript, so both takeover
// entry points count the same grace period down before fencing the owner.
function countdownOwnershipWait(report) {
  if (ownershipWait) return ownershipWait.promise;
  let seconds = TAKE_OWNERSHIP_WAIT_SECONDS;
  report(`Waiting ${seconds}s for Syncthing to finish…`, seconds);
  const wait = { promise: null, resolve: null, settled: false };
  const promise = new Promise((resolve) => {
    const finish = (value) => {
      if (wait.settled) return;
      wait.settled = true;
      clearInterval(interval);
      resolve(value);
    };
    const interval = setInterval(() => {
      seconds -= 1;
      report(seconds ? `Waiting ${seconds}s for Syncthing to finish…` : "Syncthing wait finished.", seconds);
      if (!seconds) finish(true);
    }, 1000);
    wait.resolve = finish;
  });
  wait.promise = promise;
  ownershipWait = wait;
  return promise;
}

function waitForOwnershipSync() {
  elements.sessionTransferProgress.hidden = false;
  setOwnershipTransferControls(true);
  return countdownOwnershipWait((text, seconds) => {
    elements.sessionTransferStatus.textContent = text;
    elements.sessionTransferWaitProgress.value = seconds;
  });
}

function waitForLockOwnershipSync() {
  elements.conversationLockTakeButton.disabled = true;
  return countdownOwnershipWait((text) => { elements.conversationLockStatus.textContent = text; });
}

function skipOwnershipWait() {
  ownershipWait?.resolve(true);
}

async function takeSessionOwnership(destination, wait, report) {
  const session = activeChatSession();
  if (ownershipWait || ownershipTaking || state.activeTaskId || !state.activeProjectId || !session) return;
  if (!destination?.mapped) throw new Error("Map project first on the destination node");
  const proceed = await wait();
  if (!proceed) return;
  ownershipTaking = true;
  report("Taking ownership…");
  try {
    const result = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions/take-ownership`, {
      method: "POST", body: JSON.stringify({ peerId: destination.id, sessionId: session.id, sessionPath: session.path, sessionName: shortSessionTitle(session) }),
    });
    state.activeNodeId = destination.id;
    state.activeSessionId = null;
    if (state.preferencesLoaded) savePreferencesInBackground({ activeNodeId: destination.id, activeSessionId: null });
    elements.sessionTransferDialog.close();
    openSession(result.sessionPath, shortSessionTitle(session));
    toast(result.pendingPeerIds?.length ? "Ownership taken; offline nodes will update when they return" : "Ownership taken");
  } catch (error) { resetOwnershipWait(); throw error; }
}

function takeActiveSessionOwnership() {
  const destination = state.sessionNodes.find((node) => node.id === elements.sessionTransferNodeSelect.value);
  return takeSessionOwnership(destination, waitForOwnershipSync, (text) => { elements.sessionTransferStatus.textContent = text; });
}

// The locked-conversation notice always takes ownership onto the node the user
// is already looking at, so there is no destination to pick.
function takeLockedConversationOwnership() {
  const destination = state.sessionNodes.find((node) => node.id === state.activeNodeId);
  return takeSessionOwnership(destination, waitForLockOwnershipSync, (text) => { elements.conversationLockStatus.textContent = text; });
}

elements.transferSessionButton.addEventListener("click", () => {
  elements.sessionTakeOwnershipButton.hidden = Boolean(state.activeTaskId);
  resetOwnershipWait();
});
elements.cancelSessionTransferButton.addEventListener("click", () => { resetOwnershipWait(); elements.sessionTransferDialog.close(); });
elements.sessionTransferDialog.addEventListener("close", resetOwnershipWait);
elements.sessionTakeOwnershipButton.addEventListener("click", () => takeActiveSessionOwnership().catch((error) => toast(error.message, 8000)));
elements.conversationLockTakeButton.addEventListener("click", () => takeLockedConversationOwnership().catch((error) => { resetOwnershipWait(); toast(error.message, 8000); }));
elements.skipSessionTransferWaitButton.addEventListener("click", skipOwnershipWait);
elements.sessionTransferForm.addEventListener("submit", transferActiveSession);
elements.closeModelDialogButton.addEventListener("click", () => elements.modelDialog.close());
elements.chatMoreMenu.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("button")) elements.chatMoreMenu.removeAttribute("open");
});
document.addEventListener("click", (event) => {
  if (event.target instanceof Node && !elements.chatMoreMenu.contains(event.target)) elements.chatMoreMenu.removeAttribute("open");
});
elements.appMenu.addEventListener("toggle", () => {
  if (elements.appMenu.open) loadAppMenuDetails().catch((error) => toast(error.message));
});
elements.appMenuSettingsButton.addEventListener("click", () => {
  elements.appMenu.removeAttribute("open");
  openSettings().catch((error) => toast(error.message));
});
document.addEventListener("click", (event) => {
  if (event.target instanceof Node && !elements.appMenu.contains(event.target)) elements.appMenu.removeAttribute("open");
});
elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  hideCommandAutocomplete();
  const message = elements.messageInput.value.trim();
  if (!message && state.attachments.length === 0) return;
  const payload = {
    type: "prompt",
    message,
    images: state.attachments.filter((attachment) => attachment.kind === "image").map(({ name, mimeType, data }) => ({ name, mimeType, data })),
    files: state.attachments.filter((attachment) => attachment.kind === "file").map(({ name, mimeType, data }) => ({ name, mimeType, data })),
  };
  if (!sendSocket(payload)) {
    toast("Conversation is not connected yet");
    return;
  }
  state.lastTurnStartedAt = Date.now();
  startDurationTicker();
  if (message) rememberPrompt(message);
  state.historyIndex = -1;
  state.historyDraft = "";
  state.drafts.delete(state.activeSessionPath);
  elements.messageInput.value = "";
  elements.messageInput.style.height = "auto";
  clearAttachments();
  stickyScroll(true);
});

elements.renameSessionButton.addEventListener("click", () => {
  openRenameDialog(state.activeSessionId, state.engine, elements.sessionTitle.textContent);
});
elements.cancelRenameButton.addEventListener("click", () => elements.renameDialog.close());
elements.renameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = elements.sessionNameInput.value.trim();
  elements.renameDialog.close();
  try {
    await renameSession(state.renameSessionId, state.renameSessionEngine, title);
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

function hasModifier(event) {
  return event.shiftKey || event.altKey || event.metaKey || event.ctrlKey;
}

function autoGrowInput() {
  elements.messageInput.style.height = "auto";
  const maxHeight = matchMedia("(min-width: 1024px)").matches ? Math.min(innerHeight * 0.4, 360) : 160;
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, maxHeight)}px`;
}

function setInputValue(text) {
  elements.messageInput.value = text;
  autoGrowInput();
  elements.messageInput.setSelectionRange(text.length, text.length);
}

// An unsent line belongs to the conversation it was typed in, so switching chats
// parks it here and switching back hands it straight back.
function rememberDraft() {
  if (!state.activeSessionPath) return;
  const text = elements.messageInput.value;
  if (text.trim()) state.drafts.set(state.activeSessionPath, text);
  else state.drafts.delete(state.activeSessionPath);
}

function restoreDraft() {
  state.historyIndex = -1;
  state.historyDraft = "";
  setInputValue(state.drafts.get(state.activeSessionPath) || "");
}

// A brand-new conversation is keyed "new" until the server names its session
// file. Carry the draft and the recalled prompts across to the real key.
function setActiveSessionPath(nextPath) {
  const previous = state.activeSessionPath;
  state.activeSessionPath = nextPath;
  if (!previous || previous === nextPath) return;
  const draft = state.drafts.get(previous);
  if (draft !== undefined) {
    state.drafts.delete(previous);
    state.drafts.set(nextPath, draft);
  }
  const history = state.promptHistory.get(previous);
  if (history) {
    state.promptHistory.delete(previous);
    state.promptHistory.set(nextPath, history);
  }
}

function sessionHistory() {
  const key = state.activeSessionPath || "new";
  if (!state.promptHistory.has(key)) state.promptHistory.set(key, []);
  return state.promptHistory.get(key);
}

function rememberPrompt(message) {
  const history = sessionHistory();
  if (history[history.length - 1] === message) return;
  history.push(message);
  if (history.length > 100) history.shift();
}

/**
 * Terminal-style recall. step is -1 for older and +1 for newer. Entering the
 * history stashes the half-typed line so walking back past the newest entry
 * returns it instead of losing it. Returns true when the arrow was consumed.
 */
function recallHistory(step) {
  const history = sessionHistory();
  if (!history.length) return false;
  if (state.historyIndex === -1) {
    if (step > 0) return false;
    state.historyDraft = elements.messageInput.value;
    state.historyIndex = history.length;
  }
  const next = state.historyIndex + step;
  if (next < 0) return true;
  if (next >= history.length) {
    state.historyIndex = -1;
    setInputValue(state.historyDraft);
    return true;
  }
  state.historyIndex = next;
  setInputValue(history[next]);
  return true;
}

/**
 * Pointer capability, not viewport width: a narrow desktop window still has a keyboard,
 * and a phone's return key has to keep inserting newlines because it is the only one.
 */
function enterKeySends() {
  return matchMedia("(hover: hover) and (pointer: fine)").matches;
}

elements.messageInput.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (commandAutocompleteOpen()) {
    if (["ArrowUp", "ArrowDown"].includes(event.key) && !hasModifier(event)) {
      event.preventDefault();
      const offset = event.key === "ArrowUp" ? -1 : 1;
      state.commandAutocompleteIndex = (state.commandAutocompleteIndex + offset + state.commandSuggestions.length) % state.commandSuggestions.length;
      renderCommandAutocomplete();
      return;
    }
    if (event.key === "Tab" || event.key === "Enter") {
      event.preventDefault();
      selectCommandSuggestion();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      hideCommandAutocomplete();
      return;
    }
  }
  if (["ArrowUp", "ArrowDown"].includes(event.key) && !hasModifier(event)) {
    // A multi-line draft keeps its own line navigation: the arrow only reaches the
    // history once the caret has nowhere left to go. Once recalling has started,
    // the arrows stay on the history until the message is sent, as a shell does.
    const { selectionStart, selectionEnd, value } = elements.messageInput;
    const atStart = selectionStart === 0 && selectionEnd === 0;
    const atEnd = selectionStart === value.length && selectionEnd === value.length;
    const reachedTheEdge = event.key === "ArrowUp" ? atStart : atEnd;
    if ((state.historyIndex !== -1 || reachedTheEdge) && recallHistory(event.key === "ArrowUp" ? -1 : 1)) event.preventDefault();
    return;
  }
  if (event.key !== "Enter") return;
  if (event.shiftKey || !enterKeySends()) return;
  event.preventDefault();
  elements.composer.requestSubmit();
});

elements.messageInput.addEventListener("paste", async (event) => {
  const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
  if (!images.length) return;
  if (!event.clipboardData.getData("text/plain")) event.preventDefault();
  try {
    await addAttachments(images);
  } catch (error) {
    toast(error.message);
  }
});

elements.composer.addEventListener("dragover", (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  elements.composer.classList.add("dragging");
});

elements.composer.addEventListener("dragleave", (event) => {
  if (elements.composer.contains(event.relatedTarget)) return;
  elements.composer.classList.remove("dragging");
});

elements.composer.addEventListener("drop", async (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  elements.composer.classList.remove("dragging");
  if (elements.attachmentInput.disabled) return;
  try {
    await addAttachments(event.dataTransfer.files);
  } catch (error) {
    toast(error.message);
  }
});

elements.messageInput.addEventListener("input", () => {
  autoGrowInput();
  state.commandAutocompleteIndex = 0;
  renderCommandAutocomplete();
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

// Generic secret accounts are deliberately node-local; only metadata is ever rendered.
const secretAccounts = [];
let editingSecretAccountId = null;
let secretScopeTarget = null;

function secretRow(variable = { name: "", kind: "value", configured: false }) {
  const row = document.createElement("div");
  row.className = "secret-variable-row";
  const name = document.createElement("input");
  name.placeholder = "ENV_NAME";
  name.value = variable.name;
  name.setAttribute("aria-label", "Environment variable name");
  name.dataset.secretName = "";
  name.dataset.testid = "secret-variable-name-input";
  const kind = document.createElement("select");
  kind.setAttribute("aria-label", "Secret kind");
  kind.dataset.secretKind = "";
  kind.dataset.testid = "secret-variable-kind-select";
  for (const value of ["value", "file"]) { const option = document.createElement("option"); option.value = value; option.textContent = value === "file" ? "File content" : "Value"; kind.append(option); }
  kind.value = variable.kind;
  const value = document.createElement("textarea");
  value.setAttribute("aria-label", "Secret value");
  value.placeholder = variable.configured ? "Leave blank to keep saved value" : "Secret value";
  value.dataset.secretValue = "";
  value.dataset.testid = "secret-variable-value-input";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ghost compact";
  remove.textContent = "Remove";
  remove.dataset.testid = "secret-variable-remove-button";
  remove.addEventListener("click", () => row.remove());
  row.append(name, kind, value, remove);
  elements.secretVariableRows.append(row);
}

function renderSecretAccounts() {
  elements.secretAccountList.replaceChildren();
  if (!secretAccounts.length) { elements.secretAccountList.textContent = "No node-local secret accounts."; return; }
  for (const account of secretAccounts) {
    const row = document.createElement("div"); row.className = "secret-account-row";
    const meta = document.createElement("span"); meta.className = "secret-account-meta";
    meta.textContent = `${account.label} (${account.provider}): ${account.variables.map((item) => `${item.name}${item.kind === "file" ? " (file)" : ""}`).join(", ")}`;
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "ghost compact"; edit.textContent = "Edit"; edit.dataset.testid = "secret-account-edit-button";
    edit.addEventListener("click", () => openSecretAccount(account));
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "ghost compact danger"; remove.textContent = "Delete"; remove.dataset.testid = "secret-account-delete-button";
    remove.addEventListener("click", () => deleteSecretAccount(account));
    row.append(meta, edit, remove); elements.secretAccountList.append(row);
  }
}

async function loadSecretAccounts() {
  const payload = await api("/api/secrets");
  secretAccounts.splice(0, secretAccounts.length, ...payload.accounts);
  renderSecretAccounts();
}

async function deleteSecretAccount(account) {
  if (!confirm(`Delete ${account.label}?`)) return;
  await api(`/api/secrets/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
  await loadSecretAccounts();
  toast("Secret account deleted");
}

function openSecretAccount(account = null) {
  editingSecretAccountId = account?.id ?? null;
  elements.secretAccountTitle.textContent = account ? "Edit secret account" : "Add secret account";
  elements.secretAccountLabelInput.value = account?.label ?? "";
  elements.secretAccountProviderInput.value = account?.provider ?? "custom";
  elements.secretVariableRows.replaceChildren();
  (account?.variables ?? [{ name: "", kind: "value" }]).forEach((item) => secretRow(item));
  elements.secretAccountDialog.showModal();
}

async function openSecretScope(scopeType, scopeId, label) {
  await loadSecretAccounts();
  const { accountIds } = await api(`/api/secrets/scopes/${encodeURIComponent(scopeType)}/${encodeURIComponent(scopeId)}`);
  secretScopeTarget = { scopeType, scopeId };
  elements.secretScopeTitle.textContent = `Secret accounts: ${label}`;
  elements.secretScopeList.replaceChildren();
  if (!secretAccounts.length) elements.secretScopeList.textContent = "No node-local secret accounts. Add one in Settings.";
  for (const account of secretAccounts) {
    const item = document.createElement("label"); item.className = "checkbox-row";
    const input = document.createElement("input"); input.type = "checkbox"; input.value = account.id; input.checked = accountIds.includes(account.id); input.dataset.testid = "secret-scope-account-checkbox";
    item.append(input, document.createTextNode(` ${account.label} (${account.provider})`)); elements.secretScopeList.append(item);
  }
  elements.secretScopeDialog.showModal();
}

elements.secretScopeCancelButton.addEventListener("click", () => elements.secretScopeDialog.close());
elements.secretScopeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!secretScopeTarget) throw new Error("Secret scope target is missing");
  const accountIds = [...elements.secretScopeList.querySelectorAll("input:checked")].map((input) => input.value);
  await api(`/api/secrets/scopes/${encodeURIComponent(secretScopeTarget.scopeType)}/${encodeURIComponent(secretScopeTarget.scopeId)}`, { method: "PUT", body: JSON.stringify({ accountIds }) });
  elements.secretScopeDialog.close(); toast("Secret accounts saved");
});
elements.secretAccountAddButton.addEventListener("click", () => openSecretAccount());
elements.secretVariableAddButton.addEventListener("click", () => secretRow());
elements.secretAccountCancelButton.addEventListener("click", () => elements.secretAccountDialog.close());
elements.secretAccountProviderInput.addEventListener("change", () => {
  if (editingSecretAccountId || elements.secretVariableRows.children.length > 1 || elements.secretVariableRows.querySelector("[data-secret-name]").value) return;
  elements.secretVariableRows.replaceChildren();
  const presets = elements.secretAccountProviderInput.value === "aws" ? [{ name: "AWS_ACCESS_KEY_ID", kind: "value" }, { name: "AWS_SECRET_ACCESS_KEY", kind: "value" }]
    : elements.secretAccountProviderInput.value === "google" ? [{ name: "GOOGLE_APPLICATION_CREDENTIALS", kind: "file" }]
      : [{ name: "", kind: "value" }];
  presets.forEach((item) => secretRow(item));
});
elements.secretAccountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const variables = [...elements.secretVariableRows.children].map((row) => {
    const name = row.querySelector("[data-secret-name]").value.trim();
    const kind = row.querySelector("[data-secret-kind]").value;
    const value = row.querySelector("[data-secret-value]").value;
    return { name, kind, ...(value === "" ? {} : { value }) };
  });
  if (!variables.every((item) => item.name) || new Set(variables.map((item) => item.name)).size !== variables.length || (!editingSecretAccountId && variables.some((item) => item.value === undefined))) throw new Error("Enter unique variable names and values");
  const payload = { label: elements.secretAccountLabelInput.value.trim(), provider: elements.secretAccountProviderInput.value, variables };
  await api(editingSecretAccountId ? `/api/secrets/accounts/${encodeURIComponent(editingSecretAccountId)}` : "/api/secrets/accounts", { method: editingSecretAccountId ? "PUT" : "POST", body: JSON.stringify(payload) });
  elements.secretAccountDialog.close(); await loadSecretAccounts(); toast("Secret account saved");
});
