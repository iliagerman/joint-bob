import { DEFAULT_KEYMAP } from "../keymap.js";

/** Mutable app-wide values shared by several modules. */
export const shared = {
  ownershipWait: null,
  ownershipTaking: false,
  handoffWaitController: null,
  handoffFinalizing: false,
  bootRevealTimer: null,
  workspaces: [],
};

const bootParams = new URLSearchParams(location.search);
export const state = {
  byTheWayToken: bootParams.get("byTheWayToken"),
  // Follow mode: the pane tracks the newest message while the reader sits at
  // the bottom, and releases the moment they scroll away. It resumes when they
  // return. Scroll events are the only input. They see every user-driven
  // scroll, and programmatic pins land at the bottom, so the listener simply
  // follows the scroll position.
  followChat: true,
  initialAction: bootParams.get("action"),
  initialSessionId: bootParams.get("sessionId"),
  initialNodeId: bootParams.get("nodeId"),
  keymap: DEFAULT_KEYMAP,
  // The view the control center was opened from, so the toggle key puts the user back where
  // they were rather than always in the conversation list.
  viewBeforeControl: null,
  // True while a conversation opens over the control center: choosing its project and the conversation do not leave the board.
  keepControlView: false,
  controlCenter: { colors: {}, filter: [], chatRight: false, chatWidth: 400 },
  projects: [],
  sessions: [],
  // The project whose list `sessions` holds; null while none has loaded.
  sessionsProjectId: null,
  // Each project's list as it was when the user left it, shown at once when it opens again.
  keptSessionLists: new Map(),
  quickNotes: [],
  skills: [],
  skillsLoading: false,
  skillsProjectId: null,
  skillsConversationId: null,
  tools: [],
  toolsLoading: false,
  commands: [],
  commandsLoading: false,
  commandsKey: null,
  commandSuggestions: [],
  commandAutocompleteIndex: 0,
  pinnedProjectIds: [],
  pinnedSessionPaths: [],
  // Per conversation, the newest message time (epoch ms) the reader has viewed.
  // Mirrors the server-side preference so read marks follow the account.
  conversationLastRead: {},
  gitReviewer: null,
  replicatedPinnedProjectIds: [],
  pinnedConversations: [],
  recentSessions: [],
  pendingReviews: [],
  pendingReviewsTimer: null,
  pendingReviewsRefreshTimer: null,
  renameSessionId: null,
  renameSessionEngine: "pi",
  newSessionDraft: null,
  spinOffSourceTaskId: null,
  // The Joint Bob worktree a new conversation should run in; null runs it in the project folder.
  newSessionWorktreeId: null,
  worktrees: [],
  worktreeCleanupReasons: {},
  // Worktree sub-sections the user folded in the conversation list.
  collapsedWorktreeIds: new Set(),
  // Accounts picked in the new-conversation dialog; the server persists them once the engine reports an id.
  newSessionSecretAccountIds: [],
  pendingSessionTitle: null,
  pendingSessionColor: null,
  pendingQuickNoteConversion: null,
  colorSessionId: null,
  colorSessionEngine: "pi",
  projectsLoading: true,
  projectsRefreshing: false,
  sessionsLoading: false,
  sessionsRefreshing: false,
  agentRunPollTimer: null,
  // Parent conversation paths whose sub-agent children are shown; collapsed by default.
  expandedSessionParents: new Set(),
  // Conversation paths whose sub-agent run lines are opened; folded away by default.
  expandedAgentRuns: new Set(),
  projectSyncTimer: null,
  tasks: [],
  editingTaskId: null,
  mappingProjectId: null,
  folderPickerPath: null,
  folderPickerParentPath: null,
  folderPickerApiPath: "/api/filesystem/directories",
  folderPickerTarget: null,
  folderPickerApply: null,
  projectDefaultBase: null,
  projectAutofilledPath: null,
  syncthingEndpoint: "",
  engine: "pi",
  sessionBusy: false,
  // The agent's own turn, from its status; the conversation is also busy while auto respond decides.
  harnessBusy: false,
  backgroundRunning: false,
  autoRespondDecision: null,
  harnesses: [],
  sessionNodes: [],
  appMenuLoaded: false,
  activeNodeId: null,
  activeSessionId: null,
  activeConversationId: null,
  // The project the open conversation belongs to, which the sidebar selection need not match.
  activeConversationProjectId: null,
  conversationSegments: null,
  // Previous review watermark for the conversation currently being opened.
  reviewHighlightAfter: null,
  // Chosen status chips; none chosen shows every status.
  chatFilters: new Set(),
  // Chosen conversation labels ("label:<name>" or "unclassified"); none chosen shows all.
  classificationFilters: new Set(),
  // Chosen clusters for each list: a cluster ID, "local" for this node, or "twin" (projects only).
  projectClusterFilters: new Set(),
  sessionClusterFilters: new Set(),
  // Memberships and active twins, loaded with the project list for the cluster filters.
  clusters: [],
  localNodeId: null,
  twinNodeIds: [],
  // Conversations the user has closed out are hidden until this is switched on.
  showDoneConversations: false,
  showScheduledConversations: false,
  projectConversationVisibility: {},
  hiddenCronTaskIds: new Set(),
  knownCronTaskIds: new Set(),
  conversationLabels: [],
  conversationLabelIcons: {},
  conversationCommands: null,
  watchSocket: null,
  watchProjectId: null,
  rowMenuAnchor: null,
  rowMenuAnchorSelector: null,
  watchReconnectTimer: null,
  watchPingTimer: null,
  activeProjectId: null,
  activeSessionPath: null,
  activeTaskId: null,
  conversationLock: null,
  conversationReadOnly: false,
  // Why the open conversation is read-only ("doneTicket", "transcript", "runnerAccess"), and the machine it runs on.
  conversationReadOnlyReason: null,
  conversationNodeName: null,
  scheduledTurn: false,
  scheduledAssistantText: "",
  assistantRawText: "",
  socket: null,
  reconnectTimer: null,
  heartbeatTimer: null,
  lastPongAt: 0,
  assistantBubble: null,
  thinkingBubble: null,
  toolBubbles: new Map(),
  models: [],
  routing: null,
  routingClassifiers: null,
  activeModelKey: "",
  // The pool and profile the running turn uses; live replies show them until the turn ends.
  turnConnection: null,
  activeModelLabel: "",
  thinkingLevel: "off",
  availableThinkingLevels: [],
  claudeEffort: "default",
  attachments: [],
  taskAttachments: [],
  drafts: new Map(),
  promptHistory: new Map(),
  historyIndex: -1,
  historyDraft: "",
  durationTicker: 0,
  terminalSocket: null,
  terminalOrientation: "horizontal",
  terminalDockSizes: { horizontal: 320, vertical: 440 },
  terminalResize: null,
  terminalEmulator: null,
  terminalFit: null,
  terminalObserver: null,
  installPromptEvent: null,
  installDismissed: false,
  notificationsEnabled: false,
  completionSound: "chime",
  authenticated: false,
  username: "",
  email: "",
  role: null,
  needsEmail: false,
  isRemoteLogin: false,
  setupRequired: false,
  mustChangePassword: false,
  lastTurnStartedAt: 0,
  conversationDurationMs: 0,
  conversationStartedAt: null,
  csrfToken: "",
  preferencesLoaded: false,
  initialProjectId: bootParams.get("projectId"),
  initialSessionPath: bootParams.get("sessionPath"),
  fileEditor: { requestedPath: null, path: null, viewUrl: null, downloadUrl: null, contentUrl: null, version: null, original: "", loading: false, saving: false },
  fileExplorer: { dir: "", clipboard: null, loading: false },
};

export const TAKE_OWNERSHIP_WAIT_SECONDS = 5;
export const BOOT_MINIMUM_MS = 700;
export const BOOT_REQUEST_TIMEOUT_MS = 8_000;
export const bootStartedAt = performance.now();

export const LEGACY_PREFERENCE_KEYS = [
  "piWebTheme",
  "piWebNotifications",
  "piWebInstallDismissed",
  "piWebActiveView",
  "piWebActiveProjectId",
  "piWebActiveSessionPath",
];
