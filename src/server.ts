import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, appendFile, lstat, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import { ensureSessionTitle, projectNameOverrides, setProjectName, setSessionColor, setSessionTitle } from "./names.js";
import { getProjectLock, projectLocks, setProjectLock } from "./project-locks.js";
import { addProject, deleteWorkspace, getProject, importProject, listProjects, listWorkspaces, projectAliasIds, registerProjectAliases, removeProject, renameProject, saveWorkspace, touchProject, updateProjectColor, updateProjectMacPath, updateProjectSyncFolderId, updateProjectWorkspaceAndPath, WorkspaceError } from "./store.js";
import { clusterInvitationStatus, consumeClusterInvitation, createClusterInvitation, createClusterPeer, dueMembershipDeliveries, getClusterMachineToken, getClusterMembership, getClusterNode, getClusterPeer, listClusterPeers, markClusterPeerSeen, mergeClusterMembership, recordMembershipDelivered, recordMembershipFailure, removeClusterPeer, saveClusterPeer, updateClusterNode, type ClusterPeer } from "./cluster.js";
import { eventsForPeer, receiveReplicationBatch, recordPeerFailure, recordPeerReceipt, type ReplicationBatch } from "./replication.js";
import { enqueueSecretCredentialSync, receiveSecretCredentialEvents, recordSecretCredentialFailure, recordSecretCredentialReceipt, secretCredentialEventsForPeer, type SecretCredentialEvent } from "./secret-replication.js";
import { agentCredentialContext, agentEnvironment, deleteSecretAccount, getScopeSecretAccounts, listSecretAccounts, persistConversationSecretAccounts, saveSecretAccount, setScopeSecretAccounts, type SecretAccount } from "./secrets.js";
import {
  createPiSession,
  eventPayload,
  getSessionStatus,
  listAvailableModels,
  promptIdlePiSession,
  reloadPiAuth,
  sessionIsBusy,
  setSessionModel,
  simplifyMessages,
} from "./pi-service.js";
import { deletePushSubscription, getVapidPublicKey, listPushSubscriberUserIds, notifyConversationReview, savePushSubscription } from "./push.js";
import { abortOutgoingTaskHandoff, abortPreparedTaskHandoff, acknowledgeIncomingTaskHandoff, acknowledgeOutgoingTaskHandoff, assertTaskCanBeDeleted, beginOutgoingTaskHandoff, claimTaskLease, commitPreparedTaskHandoff, completeTaskHandoff, completeTaskLease, createTask, deleteTask, getTaskHandoff, isTaskHandoffRejected, listTasks, listUnfinishedOutgoingTaskHandoffs, markOutgoingTaskHandoff, prepareTaskHandoff, rejectTaskHandoff, releaseTaskLease, reserveTaskHandoff, taskHandoffDeletion, updateTask, updateTaskSessionPath, type TaskHandoffRecord } from "./tasks.js";
import { assertTaskWorktreeTransferable, exportTaskBranchBundle, mergeTaskWorktree, prepareTaskWorktreeFromBundle, removePreparedTaskWorktree, TaskWorktreeError, validateTaskRepository, type PreparedTaskWorktree } from "./worktrees.js";
import { assertSyncthingFolderReady, CLAUDE_ENGINE_SYNC_FOLDER_ID, ensureSyncthingDevice, ensureSyncthingFolder, ensureTicketWorkspaceFolder, pauseEngineSyncFolders, PI_ENGINE_SYNC_FOLDER_ID, reconcileSyncthingProjectFolders, rescanSyncthingFolder, syncthingDeviceId, syncthingFolderIdForPath, syncthingFolderStatuses, syncthingPathForFolderId } from "./syncthing.js";
import { assertTaskWorkspaceReady, removeTaskWorkspace, taskWorkspaceKey, TaskWorkspaceError, TICKET_WORKSPACE_FOLDER_ID, ticketWorkspaceRoot } from "./task-workspaces.js";
import { SessionWatcher } from "./watcher.js";
import { appendLiveEvent, buildHandoffContext, claudeRunIdFromSessionPath, claudeSessionContextUsage, claudeSessionFilePath, ensureLocalClaudeTranscript, loadClaudeMessages, runClaudePrompt, type ClaudeRunHandle, type ClaudeRunResult } from "./claude-service.js";
import { isClaudeSessionRunning, listRunningClaudeSessions } from "./claude-runtime.js";
import { listHarnesses, listHarnessSessions, refreshHarnessSessions } from "./harnesses.js";
import { deleteConversationRecord, ensureConversationRecord, getConversationRecord, parseConversationDraftPath } from "./conversation-records.js";
import { agentRunDescriptor, refreshAgentRun, type AgentRunDescriptor } from "./agent-run-monitor.js";
import { listHarnessCommands } from "./commands.js";
import { listSkills } from "./skills.js";
import { authenticate, authenticationStatus, changePassword, clearSessionCookieValue, createAdministrator, listLoginSessions, revokeSession, revokeUserSession, sessionCookieName, sessionCookieValue, sessionForId, usernameForUser, type AuthSession } from "./auth.js";
import { getSettings, updateSettings } from "./settings.js";
import { ensureManagedHome, managedProjectPath, managedProjectRelocationPath } from "./managed-home.js";
import { importProjectDirectory, ProjectDirectoryImportError, relocateProjectDirectory } from "./project-directory-import.js";
import { listAuditEvents } from "./audit.js";
import { clearCanvasShortcut, listCanvasShortcuts, releaseCanvasShortcuts, setCanvasShortcut } from "./canvas-shortcuts.js";
import {
  getUserPreferences,
  migrateLegacyCanvasLayout, updateUserPreferences, type UserPreferences,
} from "./preferences.js";
import { appVersion, readChangelog } from "./changelog.js";
import { applyRuntimeLeaseSnapshot, conversationLeaseRunning, conversationRuntimeDatabase, sweepExpiredRuntimeLeases, type RuntimeLeaseInput } from "./conversation-runtime.js";
import { claimReviewNotifications, markConversationReviewed, markConversationsReviewed, syncConversationReviewStates } from "./conversation-reviews.js";
import { resetSyncthingConnection } from "./syncthing.js";
import { PROJECT_COLORS } from "./types.js";
import type { AgentRunSummary, ChatMessage, ContextUsage, ProjectRecord, ProjectSyncStatus, ProjectView, SessionStatus, SessionSummary, TaskPhase, TaskPhaseConfig, TaskRecord } from "./types.js";
import { webSocketCloseReason } from "./websocket.js";
import { capturePiRecoverySnapshot, recoverPiSessionDirectory, resolveLocalSessionPath } from "./session-paths.js";
import { beginConversationRecovery, compareAndSetConversationOwnership, ConversationOwnershipError, finalizeConversationClaim, finishConversationRecovery, getConversationOwnership, sameConversationOwnership, takeConversationOwnership, type ConversationEngine, type ConversationOwnership, type ConversationOwnershipStatus, type OwnershipApplyResult } from "./conversation-ownership.js";
import { attachTerminalSession } from "./terminal-session.js";
import { claimQueuedPrompt, enqueuePrompt, listQueuedPrompts, rekeyQueuedPrompts } from "./prompt-queue.js";
import { completeUpdateRecovery, failUpdateRecovery, listPendingUpdateRecoveries, saveUpdateRecoveries, type UpdateRecoveryRecord } from "./update-recovery.js";

type PiSessionHandle = Awaited<ReturnType<typeof createPiSession>>;

interface SharedPiSession {
  handle: PiSessionHandle;
  unsubscribe: () => void;
  clients: Set<WebSocket>;
  key: string;
  projectId: string;
  cwd: string;
  idleTimer: NodeJS.Timeout | null;
  lastLocalEventAt: number;
  agentRuns: Map<string, { descriptor: AgentRunDescriptor; summary: AgentRunSummary }>;
  // Turns routed through this node that have started and not finished, including
  // stubbed test turns the engine itself never reports as streaming.
  turnInFlight: number;
}

type ChatEngine = "pi" | "claude";

interface ClaudeQueuedPrompt {
  id: number;
  promptText: string;
  displayText: string;
  acknowledged: boolean;
}

interface ClaudeChatState {
  sessionId: string | null;
  sessionName: string | null;
  filePath: string | null;
  child: ClaudeRunHandle["child"] | null;
  promptQueue: ClaudeQueuedPrompt[];
  transcript: ChatMessage[];
  lastRunEndedAt: number;
  model: string | null;
  effort: string | null;
  // Built-in tools the CLI last reported in its init record; empty until a turn has run.
  availableTools: string[];
  // Restricted tool set for upcoming turns; null means the CLI default set.
  enabledTools: string[] | null;
  compacting: boolean;
  // Turn events already streamed to the client, replayed verbatim when a socket
  // drops mid-turn and the browser reconnects.
  liveEvents: Record<string, unknown>[];
  contextUsage: ContextUsage | null;
}

// "opus" is pinned to the explicit Opus 5 id so the CLI alias cannot drift.
const CLAUDE_MODEL_LABELS = new Map([
  ["fable", "Claude Fable"],
  ["claude-opus-5", "Claude Opus 5"],
  ["sonnet", "Claude Sonnet"],
  ["haiku", "Claude Haiku 4.5"],
]);
const CLAUDE_MODELS = [...CLAUDE_MODEL_LABELS.keys()];
// A new chat starts on Opus 5 rather than the CLI default, so the toolbar
// always names the model that is actually running.
const CLAUDE_DEFAULT_MODEL = "claude-opus-5";

interface ChatConnection {
  socket: WebSocket;
  project: ProjectRecord;
  taskId: string | null;
  cwd: string;
  engine: ChatEngine;
  shared: SharedPiSession | null;
  claude: ClaudeChatState;
  // Transcript summary prepended to the next prompt after an engine switch.
  handoffContext: string | null;
  // Accounts picked in the new-conversation dialog, before the engine reported a session id.
  secretAccountIds: string[];
}

const port = Number(process.env.PORT ?? 8790);
const machineRoutes = new Set([
  "GET /cluster/node",
  "GET /cluster/local-inventory",
  "POST /cluster/peers/accept",
  "POST /cluster/membership/sync",
  "POST /cluster/projects/import",
  "POST /cluster/projects/map",
  "GET /cluster/filesystem/directories",
  "GET /cluster/project-file",
  "GET /cluster/project-file-resolution",
  "GET /cluster/project-file-content",
  "PUT /cluster/project-file-content",
  "POST /cluster/sync/share",
  "DELETE /cluster/sessions/delete",
  "POST /cluster/sessions/take-ownership",
  "GET /cluster/sessions/ownership",
  "POST /cluster/sessions/ownership/claim",
  "POST /cluster/sessions/ownership/claim/cas",
  "POST /cluster/sessions/ownership/claim/commit",
  "POST /cluster/sessions/ownership/apply",
  "POST /cluster/sessions/runtime-snapshot",
  "POST /cluster/events",
  "POST /cluster/github/events",
  "POST /cluster/secrets/events",
  "POST /cluster/tasks/eligibility",
  "POST /cluster/tasks/status",
  "POST /cluster/tasks/prepare",
  "POST /cluster/tasks/commit",
  "POST /cluster/tasks/settle",
  "POST /cluster/tasks/abort",
  "PATCH /cluster/tasks/update",
  "DELETE /cluster/tasks/delete",
  "POST /cluster/tasks/archive",
  "POST /cluster/tasks/merge",
  "POST /cluster/tasks/handoff",
  "POST /update/prepare",
]);
export const app = express();
export function createApp(): express.Express {
  return app;
}
export const server = createServer(app);
const webSocketServer = new WebSocketServer({ server, path: "/ws" });
const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../public");
const codemirrorDir = path.resolve(dirname, "../node_modules/codemirror");
const sharedSessions = new Map<string, SharedPiSession>();
server.on("close", () => {
  for (const session of new Set(sharedSessions.values())) disposeSharedSession(session);
});
const execFileAsync = promisify(execFile);
const idleSessionTimeoutMs = 30 * 60 * 1000;
// A session file change within this window of local agent activity is our own
// write, not an external Syncthing sync.
const localWriteGraceMs = 15_000;
const watchClients = new Map<string, Set<WebSocket>>();
const claudeClients = new Map<WebSocket, ChatConnection>();
const activeClaudeConnections = new Map<string, ChatConnection>();
// Interactive Claude turns run on a socket connection, not in `sharedSessions`,
// so the conversation list needs its own record of which files are streaming.
const runningClaudeSessionPaths = new Set<string>();
interface RecoveredClaudeChat {
  claude: ClaudeChatState;
  connection: ChatConnection | null;
}

const recoveredClaudeChats = new Map<string, RecoveredClaudeChat>();
let updatePreparing = false;
let updatePreparation: Promise<number> | null = null;
const updateContinuationPrompt = "A service update interrupted this turn. Inspect the transcript and working tree, continue unfinished work, and do not repeat completed side effects.";
let replicationFlushInProgress = false;
let secretCredentialFlushInProgress = false;
let membershipFlushInProgress = false;
let taskHandoffReconciliationInProgress = false;
let ticketWorkspaceSyncInProgress = false;
let projectDiscoveryInProgress = false;
let ticketWorkspaceSyncRetryAt = 0;
const configuredTicketWorkspacePeers = new Set<string>();
let startupReady = true;
let startupError: Error | undefined;
let startupReadinessInProgress = false;

const absolutePathSchema = z.string().trim().min(1).max(1000).refine(path.isAbsolute, "Path must be absolute");
const projectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.string().trim().min(1).max(40).optional().default("personal"),
  path: absolutePathSchema.optional(),
  sourcePath: absolutePathSchema.optional(),
  importMode: z.enum(["copy", "move", "move-link"]).optional(),
  synced: z.boolean().optional(),
  macPath: absolutePathSchema.optional(),
  color: z.enum(PROJECT_COLORS).nullable().optional(),
})
  .refine((payload) => !(payload.path && payload.sourcePath), "Project path and import source cannot both be set")
  .refine((payload) => !payload.sourcePath || payload.importMode, { message: "Choose how to import the project", path: ["importMode"] });
const projectPathMappingSchema = z.object({
  macPath: absolutePathSchema,
});
const projectListQuerySchema = z.object({
  syncStatus: z.enum(["true", "false"]).optional().default("true"),
});
const clusterUrlSchema = z.string().url().max(500)
  .refine(isClusterOriginUrl, "Cluster URLs must be an HTTPS origin, except loopback HTTP")
  .transform(canonicalClusterUrl);
const clusterNodeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: clusterUrlSchema,
});
const clusterPeerSchema = z.object({
  url: clusterUrlSchema,
  token: z.string().trim().min(1).max(500),
});
const clusterMembershipMemberSchema = clusterNodeSchema.extend({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  token: z.string().trim().min(1).max(500),
});
const clusterMemberTombstoneSchema = z.object({
  id: z.string().uuid(),
  removedAt: z.string().datetime(),
  originNodeId: z.string().uuid(),
});
const clusterMembershipSnapshotSchema = z.object({
  members: z.array(clusterMembershipMemberSchema).min(1),
  removed: z.array(clusterMemberTombstoneSchema).max(100).optional().default([]),
});
const clusterInvitationRedeemSchema = z.object({
  invitationId: z.string().uuid(),
  secret: z.string().trim().min(1).max(500),
  member: clusterMembershipMemberSchema,
});
const clusterJoinSchema = clusterNodeSchema.extend({
  link: z.string().trim().url().max(1200),
});
const clusterInvitationRedemptionSchema = z.object({
  inviterNodeId: z.string().uuid(),
  membership: clusterMembershipSnapshotSchema,
});
const clusterProjectImportSchema = z.object({
  peerId: z.string().uuid(),
});
const clusterProjectMapSchema = clusterProjectImportSchema.extend({
  projectId: z.string().min(1).max(120),
  localPath: absolutePathSchema,
});
const clusterSyncShareSchema = z.object({
  folderId: z.string().min(1).max(120),
  deviceId: z.string().min(1).max(120),
  deviceName: z.string().trim().min(1).max(80).optional(),
});
const replicationEventSchema = z.object({
  id: z.string().uuid(),
  originNodeId: z.string().uuid(),
  entityType: z.string().min(1).max(80),
  entityKey: z.string().min(1).max(300),
  operation: z.enum(["upsert", "delete"]),
  payload: z.unknown(),
  createdAt: z.string().datetime(),
});
const replicationBatchSchema = z.object({ events: z.array(replicationEventSchema).max(100) });
const replicationReceiptSchema = z.object({ received: z.array(z.string().uuid()).max(100) });
const runtimeLeaseSchema = z.object({
  engine: z.enum(["pi", "claude"]),
  sessionId: z.string().min(1).max(200),
  ownershipEpoch: z.number().int().positive(),
  runId: z.string().min(1).max(200),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
const runtimeSnapshotSchema = z.object({
  nodeId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  leases: z.array(runtimeLeaseSchema).max(500),
});
const directoryBrowseSchema = z.object({
  path: absolutePathSchema.optional(),
});
const TEXT_FILE_LIMIT = 1_048_576;
const projectFileUpdateSchema = z.object({
  content: z.string().max(TEXT_FILE_LIMIT),
  version: z.string().regex(/^[0-9a-f]{64}$/),
  sessionId: z.string().min(1).max(240),
}).strict();
const sessionTakeOwnershipSchema = z.object({
  peerId: z.string().uuid(),
  sessionId: z.string().min(1).max(240).optional(),
  sessionPath: z.string().min(1),
  sessionName: z.string().trim().max(120).optional(),
});
const routedSessionTakeOwnershipSchema = sessionTakeOwnershipSchema.extend({ projectId: z.string().min(1) });
const ownershipSchema = z.object({
  engine: z.enum(["pi", "claude"]), sessionId: z.string().min(1).max(240), ownerNodeId: z.string().uuid(),
  epoch: z.number().int().positive(), status: z.enum(["claiming", "owned", "recovering", "transferring", "conflict"]), transferToNodeId: z.string().uuid().nullable(),
});
const nullableOwnershipSchema = ownershipSchema.nullable();
const ownershipClaimSchema = z.object({ engine: z.enum(["pi", "claude"]), sessionId: z.string().min(1).max(240), ownerNodeId: z.string().uuid() });
const ownershipCasSchema = z.object({ expected: nullableOwnershipSchema, proposed: ownershipSchema, originNodeId: z.string().uuid() });
const sessionRecoverySchema = z.object({ engine: z.literal("pi"), sessionId: z.string().min(1).max(240), sessionPath: z.string().min(1).max(2000) });
const secretCredentialEventSchema = z.object({
  id: z.string().uuid(),
  entityKey: z.string().uuid(),
  operation: z.literal("upsert"),
  value: z.object({
    label: z.string().trim().min(1).max(64),
    provider: z.enum(["aws", "google", "github", "custom"]),
    variables: z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), kind: z.enum(["value", "file"]), value: z.string().max(100000) }).strict()).min(1).max(20),
  }).strict(),
  updatedAt: z.string().datetime(),
  originNodeId: z.string().uuid(),
  createdAt: z.string().datetime(),
}).strict();
const secretCredentialBatchSchema = z.object({ events: z.array(secretCredentialEventSchema).max(100) });
const secretCredentialSyncSchema = z.object({ peerIds: z.array(z.string().uuid()).min(1).max(50) });
const socketSecretAccountIdsSchema = z.array(z.string().uuid()).max(100);
const secretVariableSchema = z.object({ name: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), kind: z.enum(["value", "file"]), value: z.string().max(100000).optional() }).strict();
const secretAccountSchema = z.object({ id: z.string().uuid().optional(), label: z.string().trim().min(1).max(64).refine((value) => !/[\x00-\x1f\x7f]/.test(value), "Secret account label cannot contain control characters"), provider: z.enum(["aws", "google", "github", "custom"]), replicate: z.boolean().optional(), variables: z.array(secretVariableSchema).min(1).max(20) }).strict();
const secretScopeParamsSchema = z.object({ scopeType: z.enum(["workspace", "project", "conversation"]), scopeId: z.string().trim().min(1).max(300) });
const secretScopeSchema = z.object({ accountIds: z.array(z.string().uuid()).max(100) }).strict();
const taskStatusSchema = z.enum(["backlog", "planning", "in_progress", "review", "done"]);
const taskEngineSchema = z.enum(["pi", "claude"]);
const taskPhaseConfigSchema = z.object({
  engine: taskEngineSchema,
  provider: z.string().max(80).optional().default(""),
  modelId: z.string().max(200).optional().default(""),
  effort: z.enum(["default", "low", "medium", "high", "xhigh", "max"]).optional().default("default"),
});
const taskPhaseConfigMapSchema = z.object({
  planning: taskPhaseConfigSchema.optional(),
  in_progress: taskPhaseConfigSchema.optional(),
  review: taskPhaseConfigSchema.optional(),
}).optional();
const projectUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  type: z.string().trim().min(1).max(40).optional(),
  color: z.enum(PROJECT_COLORS).nullable().optional(),
}).refine(
  (payload) => payload.name !== undefined || payload.type !== undefined || payload.color !== undefined,
  "Provide a project name, type, or color",
);
const projectLockSchema = z.object({ locked: z.boolean() });
const sessionTitleSchema = z.object({
  sessionId: z.string().min(1),
  engine: z.enum(["pi", "claude"]),
  title: z.string().trim().max(200),
});
const sessionColorSchema = z.object({
  sessionId: z.string().min(1),
  engine: z.enum(["pi", "claude"]),
  color: z.enum(PROJECT_COLORS).nullable(),
});
const sessionDeleteSchema = z.object({ projectId: z.string().min(1), engine: z.enum(["pi", "claude"]), sessionId: z.string().uuid() });
const taskCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(20_000),
  status: taskStatusSchema.optional(),
  engine: taskEngineSchema.optional(),
  planMode: z.boolean().optional(),
  reviewMode: z.boolean().optional(),
  phaseConfig: taskPhaseConfigMapSchema,
});
const taskHandoffSchema = z.object({ peerId: z.string().uuid() });
const taskBranchBundleSchema = z.object({ data: z.string().min(1).max(12_000_000), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const preparedTaskSchema = z.object({ projectId: z.string().min(1), task: z.unknown(), handoffId: z.string().uuid(), handoffContext: z.string().max(500_000), handoffVersion: z.string().datetime(), bundle: taskBranchBundleSchema.nullable() });
const taskEligibilitySchema = z.object({ projectId: z.string().min(1), task: z.unknown() });
const taskHandoffActionSchema = z.object({ handoffId: z.string().uuid() });
const taskHandoffDeletionSchema = z.object({ updatedAt: z.string().datetime(), originNodeId: z.string().uuid() });
const taskHandoffStatusSchema = taskHandoffActionSchema;
const routedTaskUpdateSchema = z.object({ projectId: z.string().min(1), taskId: z.string().min(1), update: z.unknown() });
const routedTaskSchema = z.object({ projectId: z.string().min(1), taskId: z.string().min(1) });
const routedTaskHandoffSchema = routedTaskSchema.extend({ peerId: z.string().uuid() });
const socketTaskIdSchema = z.string().trim().min(1).max(120);
const taskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(20_000).optional(),
  status: taskStatusSchema.optional(),
  engine: taskEngineSchema.optional(),
  planMode: z.boolean().optional(),
  reviewMode: z.boolean().optional(),
  phaseConfig: taskPhaseConfigMapSchema,
});
const imageAttachmentSchema = z.object({
  name: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(120),
  data: z.string().min(1).max(6_000_000),
});
const fileAttachmentSchema = z.object({
  name: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(120),
  data: z.string().min(1).max(6_000_000),
});
const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
const pushSubscribeSchema = z.object({
  subscription: pushSubscriptionSchema,
  projectId: z.string().min(1),
  sessionPath: z.string().min(1),
  title: z.string().trim().max(120).optional(),
});
const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url(),
});
const sessionReviewedSchema = z.object({
  sessionPath: z.string().trim().min(1).max(2000),
  updatedAt: z.string().datetime(),
}).strict();
const sessionsReviewedSchema = z.object({
  sessions: z.array(sessionReviewedSchema).min(1).max(500),
}).strict();
const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200),
});
const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});
const runtimeSettingsSchema = z.object({
  executable: z.string().max(1000),
  configPath: z.string().max(1000),
  sessionPath: z.string().max(1000),
});
const settingsSchema = z.object({
  pi: runtimeSettingsSchema,
  claude: runtimeSettingsSchema,
  syncthing: z.object({ endpoint: z.string().max(500), apiKey: z.string().max(500).nullable().optional() }),
  projects: z.object({
    homePath: z.string().max(1000).optional(),
    rootPath: z.string().max(1000).optional(),
    personalRootPath: z.string().max(1000).optional(),
    workRootPath: z.string().max(1000).optional(),
  }).optional(),
});
const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
});
const canvasPanePreferenceSchema = z.object({
  kind: z.literal("pane"),
  id: z.string().min(1).max(200),
  projectId: z.string().trim().min(1).max(120),
  sessionPath: z.string().trim().min(1).max(2000),
  sessionId: z.string().trim().min(1).max(200),
  executionNodeId: z.string().uuid().nullable(),
}).strict();
// A grid row carries only its panes. `height` and `weights` are the geometry older
// clients still send; they are accepted so a stale tab is not rejected, then dropped
// on read - the grid spaces every row and every pane evenly.
const canvasRowPreferenceSchema = z.object({
  id: z.string().min(1).max(200),
  height: z.number().finite().nullable().optional(),
  weights: z.array(z.number().finite().positive()).min(1).max(8).optional(),
  panes: z.array(canvasPanePreferenceSchema).min(1).max(8),
}).strict();
interface CanvasSplitInput {
  kind: "split";
  id: string;
  axis: "row" | "column";
  ratio: number;
  first: z.infer<typeof canvasPanePreferenceSchema> | CanvasSplitInput;
  second: z.infer<typeof canvasPanePreferenceSchema> | CanvasSplitInput;
}
const canvasNodePreferenceSchema: z.ZodType<z.infer<typeof canvasPanePreferenceSchema> | CanvasSplitInput> = z.lazy(() => z.union([
  canvasPanePreferenceSchema,
  z.object({
    kind: z.literal("split"),
    id: z.string().min(1).max(200),
    axis: z.enum(["row", "column"]),
    ratio: z.number().finite().min(0.15).max(0.85),
    first: canvasNodePreferenceSchema,
    second: canvasNodePreferenceSchema,
  }).strict(),
]));
const canvasLayoutV1Schema = z.object({
  version: z.literal(1),
  root: canvasNodePreferenceSchema.nullable(),
  focusedPaneId: z.string().min(1).max(200).nullable(),
}).strict();
const canvasLayoutPreferenceSchema = z.union([
  canvasLayoutV1Schema,
  z.object({
    version: z.union([z.literal(2), z.literal(3), z.literal(4)]),
    rows: z.array(canvasRowPreferenceSchema).max(10),
    focusedPaneId: z.string().min(1).max(200).nullable(),
  }).strict(),
]).superRefine((layout, context) => {
  const ids = new Set<string>();
  const sessionIdentities = new Set<string>();
  const pathIdentities = new Set<string>();
  const paneIds = new Set<string>();
  const pane = (node: { id: string; kind: string; projectId?: string; sessionId?: string; sessionPath?: string }) => {
    if (ids.has(node.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Canvas ids must be unique" });
    ids.add(node.id);
    if (node.kind !== "pane") return;
    paneIds.add(node.id);
    const identity = `${node.projectId}\0${node.sessionId}`;
    const pathIdentity = `${node.projectId}\0${node.sessionPath!.replace(/\.sync-conflict-[^/\\]+(?=\.jsonl$)/, "")}`;
    if (sessionIdentities.has(identity) || pathIdentities.has(pathIdentity)) context.addIssue({ code: z.ZodIssueCode.custom, message: "A conversation can appear on the canvas only once" });
    sessionIdentities.add(identity);
    pathIdentities.add(pathIdentity);
  };
  const walk = (node: z.infer<typeof canvasPanePreferenceSchema> | CanvasSplitInput, depth: number): void => {
    pane(node);
    if (node.kind === "split") {
      if (depth >= 8) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Canvas splits cannot nest deeper than eight levels" });
        return;
      }
      walk(node.first, depth + 1);
      walk(node.second, depth + 1);
    }
  };
  if (layout.version === 1 && layout.root) walk(layout.root, 1);
  if (layout.version !== 1) for (const row of layout.rows) {
    if (ids.has(row.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Canvas ids must be unique" });
    ids.add(row.id);
    for (const item of row.panes) pane(item);
  }
  if (layout.focusedPaneId && !paneIds.has(layout.focusedPaneId)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Focused canvas pane is unknown" });
});
const userPreferencesSchema = z.object({
  theme: z.enum(["light", "dark"]).nullable().optional(),
  notificationsEnabled: z.boolean().optional(),
  completionSound: z.enum(["off", "chime", "bell"]).optional(),
  installDismissed: z.boolean().optional(),
  mobileView: z.enum(["projects", "sessions", "board", "chat", "canvas"]).optional(),
  activeProjectId: z.string().trim().min(1).max(120).nullable().optional(),
  activeSessionPath: z.string().trim().min(1).max(2000).nullable().optional(),
  activeSessionId: z.string().trim().min(1).max(200).nullable().optional(),
  activeNodeId: z.string().uuid().nullable().optional(),
  legacyMigrated: z.boolean().optional(),
  pinnedProjectIds: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
  pinnedSessionPaths: z.array(z.string().trim().min(1).max(2000)).max(200).optional(),
  projectsPanelCollapsed: z.boolean().optional(),
  chatsPanelCollapsed: z.boolean().optional(),
  lastSeenVersion: z.string().trim().regex(/^\d+\.\d+\.\d+$/).nullable().optional(),
  recentSessions: z.array(z.object({
    projectId: z.string().trim().min(1).max(120),
    sessionPath: z.string().trim().min(1).max(2000),
    title: z.string().max(300),
    openedAt: z.string().max(40),
    updatedAt: z.string().max(40).nullable().default(null),
  })).max(50).optional(),
  canvasLayout: canvasLayoutPreferenceSchema.optional(),
}).strict();
const socketMessageSchema = z.object({
  type: z.string().max(40),
  message: z.string().max(100_000).optional(),
  name: z.string().trim().max(120).optional(),
  provider: z.string().max(80).optional(),
  modelId: z.string().max(200).optional(),
  level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  engine: z.enum(["pi", "claude"]).optional(),
  effort: z.enum(["default", "low", "medium", "high", "xhigh", "max"]).optional(),
  images: z.array(imageAttachmentSchema).max(4).optional(),
  files: z.array(fileAttachmentSchema).max(6).optional(),
  safeguardsEnabled: z.boolean().optional(),
  toolNames: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
});

function sendError(response: Response, statusCode: number, message: string): void {
  response.status(statusCode).json({ error: message });
}

function isSecureClusterUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

function canonicalClusterUrl(value: string): string {
  return new URL(value).origin;
}

function isClusterOriginUrl(value: string): boolean {
  const url = new URL(value);
  return isSecureClusterUrl(value) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
}

function parseClusterInvitationLink(link: string): { inviterUrl: string; invitationId: string; secret: string } {
  const invitationUrl = new URL(link);
  if (!isSecureClusterUrl(invitationUrl.href) || invitationUrl.username || invitationUrl.password) throw new Error("Cluster invitation link is invalid");
  const [invitationId, secret, extra] = invitationUrl.hash.slice(1).split(".");
  if (invitationUrl.pathname !== "/join" || invitationUrl.search || extra || !secret) throw new Error("Cluster invitation link is invalid");
  return {
    inviterUrl: invitationUrl.origin,
    invitationId: z.string().uuid().parse(invitationId),
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(secret),
  };
}

function clusterInvitationConflict(member: z.infer<typeof clusterMembershipMemberSchema>, localNode: Awaited<ReturnType<typeof getClusterNode>>, peers: ClusterPeer[], retry: boolean): string | undefined {
  const normalizedUrl = canonicalClusterUrl(member.url);
  if (member.id === localNode.id || (localNode.url && normalizedUrl === canonicalClusterUrl(localNode.url))) return "A node cannot join itself";
  const idPeer = peers.find((peer) => peer.id === member.id);
  const urlPeer = peers.find((peer) => canonicalClusterUrl(peer.url) === normalizedUrl);
  const samePeer = idPeer && canonicalClusterUrl(idPeer.url) === normalizedUrl && idPeer.token === member.token && (!urlPeer || urlPeer.id === member.id);
  if (retry && samePeer) return undefined;
  if (idPeer || urlPeer) return "A cluster member already uses this identity or URL";
  return undefined;
}

function prospectiveClusterNode(node: Awaited<ReturnType<typeof getClusterNode>>, name: string, url: string): Awaited<ReturnType<typeof getClusterNode>> {
  return node.name === name && node.url === url ? node : { ...node, name, url, updatedAt: new Date().toISOString() };
}

function securityHeaders(request: Request, response: Response, next: NextFunction): void {
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  // The canvas embeds the normal chat surface in a same-origin iframe; every other
  // document stays unframeable.
  response.setHeader("X-Frame-Options", request.path === "/" && request.query.canvasPane === "1" ? "SAMEORIGIN" : "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}

function bearerToken(request: Request): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(request.header("authorization") ?? "");
  return match?.[1];
}

function machineTokenMatches(candidate: string, expected: string): boolean {
  const actual = Buffer.from(candidate);
  const expectedToken = Buffer.from(expected);
  return actual.length === expectedToken.length && timingSafeEqual(actual, expectedToken);
}

function requestCookie(request: Request, name: string): string | undefined {
  const prefix = `${name}=`;
  return request.header("cookie")?.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

async function machineCredentialNodeId(token: string): Promise<string | undefined> {
  const [local, localToken, peers] = await Promise.all([getClusterNode(), getClusterMachineToken(), listClusterPeers()]);
  if (machineTokenMatches(token, localToken)) return local.id;
  return peers.find((peer) => machineTokenMatches(token, peer.token))?.id;
}

async function requireHttpAuth(request: Request, response: Response, next: NextFunction): Promise<void> {
  const token = bearerToken(request);
  const machineNodeId = machineRoutes.has(`${request.method} ${request.path}`) && token
    ? await machineCredentialNodeId(token)
    : undefined;
  if (machineNodeId) {
    response.locals.machineAuth = true;
    response.locals.machineNodeId = machineNodeId;
    next();
    return;
  }
  const session = sessionForId(requestCookie(request, sessionCookieName));
  if (!session) {
    sendError(response, 401, "Unauthorized");
    return;
  }
  response.locals.authSession = session;
  if (session.mustChangePassword && !["/auth/change-password", "/auth/logout"].includes(request.path)) {
    sendError(response, 403, "Change the initial password before using the application");
    return;
  }
  next();
}

function requireCsrf(request: Request, response: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method) || response.locals.machineAuth) {
    next();
    return;
  }
  const session = response.locals.authSession as AuthSession | undefined;
  if (session && request.header("x-csrf-token") === session.csrfToken) {
    next();
    return;
  }
  sendError(response, 403, "Invalid CSRF token");
}

interface PeerInventory {
  node: Awaited<ReturnType<typeof getClusterNode>>;
  syncDeviceId?: string;
  projectRoot?: string;
  projects: Array<{ project: ProjectRecord; aliases?: string[] }>;
}

function publicClusterPeer(peer: ClusterPeer): Omit<ClusterPeer, "token"> & { tokenConfigured: boolean; online: boolean } {
  const { token, ...publicPeer } = peer;
  return { ...publicPeer, tokenConfigured: Boolean(token), online: Boolean(peer.lastSeenAt && Date.now() - Date.parse(peer.lastSeenAt) <= 90_000) };
}

async function runtimeAvailable(engine: TaskRecord["engine"]): Promise<string[]> {
  const settings = getSettings();
  if (engine === "pi") {
    if (settings.pi.configPath) {
      try { await access(settings.pi.configPath); } catch { return ["Pi config path is not available on this node"]; }
    }
    return [];
  }
  const executable = settings.claude.executable || "claude";
  try {
    if (path.isAbsolute(executable)) await access(executable, fsConstants.X_OK);
    else await execFileAsync("sh", ["-lc", "command -v -- \"$1\"", "sh", executable]);
    if (settings.claude.configPath) await access(settings.claude.configPath);
    return [];
  } catch {
    return [`Claude runtime ${executable} is not available on this node`];
  }
}

async function abortPeerTaskHandoff(peer: ClusterPeer, handoffId: string): Promise<boolean> {
  try {
    const response = await fetch(`${peer.url}/api/cluster/tasks/abort`, { method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ handoffId }), signal: AbortSignal.timeout(30_000) });
    if (response.ok) return true;
    console.warn(`Handoff abort failed: ${response.status}`);
  } catch (error) {
    console.warn("Handoff abort request failed", error);
  }
  return false;
}

async function assertTaskSessionReady(sessionPath: string): Promise<void> {
  const session = resolveLocalSessionPath(sessionPath);
  const label = session.engine === "claude" ? "Claude" : "Pi";
  const filePath = session.engine === "claude" ? session.path.slice("claude:".length) : session.path;
  try {
    await assertSyncthingFolderReady(session.engine === "claude" ? CLAUDE_ENGINE_SYNC_FOLDER_ID : PI_ENGINE_SYNC_FOLDER_ID);
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Conversation is not a regular file");
  } catch {
    throw new Error(`${label} conversation is not synchronized on this node`);
  }
}

async function assertTaskFilesReady(project: ProjectRecord, task: TaskRecord): Promise<void> {
  if (task.worktreePath && !task.worktreeBranch) {
    await assertSyncthingFolderReady(TICKET_WORKSPACE_FOLDER_ID);
    await assertTaskWorkspaceReady(taskWorkspaceKey(task.worktreePath, task.id), task.id);
  } else if (project.syncFolderId) await assertSyncthingFolderReady(project.syncFolderId);
  if (task.worktreeBranch) await validateTaskRepository(project.path);
  if (task.sessionPath) await assertTaskSessionReady(task.sessionPath);
}

async function taskHandoffEligibility(projectId: string, task: TaskRecord): Promise<string[]> {
  const project = await getProject(projectId);
  if (!project) return ["Project is not mapped on this node"];
  try {
    if (!(await stat(project.path)).isDirectory()) return ["Mapped project path is not a directory"];
  } catch {
    return ["Mapped project path is not available on this node"];
  }
  const reasons = await runtimeAvailable(task.engine);
  try { await assertTaskFilesReady(project, task); }
  catch (error) { reasons.push(error instanceof Error ? error.message : "Ticket files are not ready on this node"); }
  return reasons;
}

function projectWithLocalLocation(project: ProjectRecord, nodeId: string): ProjectRecord {
  const locations = new Map((project.locations ?? []).map((location) => [location.nodeId, location]));
  locations.set(nodeId, { nodeId, path: project.path });
  return { ...project, locations: [...locations.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId)) };
}

async function fetchPeerInventory(peer: ClusterPeer, timeoutMs = 10_000): Promise<PeerInventory> {
  const response = await fetch(`${peer.url}/api/cluster/local-inventory`, {
    headers: peer.token ? { Authorization: `Bearer ${peer.token}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Peer returned ${response.status}`);
  const inventory = await response.json() as PeerInventory;
  await markClusterPeerSeen(peer.id);
  return inventory;
}

type ProjectImportResult = {
  imported: string[];
  skipped: string[];
  pending: Array<{ peerId: string; projectId: string; name: string; remotePath: string; syncFolderId?: string; suggestedPath: string }>;
};

async function importProjectsFromPeer(peer: ClusterPeer, missingOnly = false): Promise<ProjectImportResult> {
  const inventory = await fetchPeerInventory(peer);
  const imported: string[] = [];
  const skipped: string[] = [];
  const localProjects = await listProjects();
  const pending: ProjectImportResult["pending"] = [];
  for (const entry of inventory.projects) {
    const remoteProject = entry.project;
    const localWorkspace = await localWorkspaceId(remoteProject.type);
    const existing = await getProject(remoteProject.id) ?? localProjects.find((project) => remoteProject.syncFolderId !== undefined && project.syncFolderId === remoteProject.syncFolderId);
    if (existing && missingOnly) {
      skipped.push(remoteProject.name);
      continue;
    }
    let localPath = existing?.path;
    if (existing && existing.type !== localWorkspace) {
      localPath = (await relocateProjectWorkspace(existing, localWorkspace)).path;
    }
    if (!localPath && remoteProject.syncFolderId) {
      try {
        localPath = await syncthingPathForFolderId(remoteProject.syncFolderId);
      } catch {
        localPath = undefined;
      }
    }
    if (!existing && !localPath) {
      localPath = managedProjectPath(getSettings().projects.homePath, localWorkspace, remoteProject.name);
    }
    if (!existing && !localPath) {
      pending.push({
        peerId: peer.id,
        projectId: remoteProject.id,
        name: remoteProject.name,
        remotePath: remoteProject.path,
        ...(remoteProject.syncFolderId ? { syncFolderId: remoteProject.syncFolderId } : {}),
        suggestedPath: managedProjectPath(getSettings().projects.homePath, localWorkspace, remoteProject.name),
      });
      continue;
    }
    const importedProject = !existing && localPath
      ? await mapProjectFromPeer(peer, inventory, entry, localPath)
      : await importProject({ ...remoteProject, type: localWorkspace }, localPath, inventory.node.id);
    await registerProjectAliases(importedProject.id, [remoteProject.id, ...(entry.aliases ?? [])]);
    imported.push(remoteProject.name);
  }
  return { imported, skipped, pending };
}

async function syncPairedProjects(peer: ClusterPeer, localNodeId: string): Promise<ProjectImportResult> {
  const localImport = await importProjectsFromPeer(peer);
  const response = await fetch(`${peer.url}/api/cluster/projects/import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ peerId: localNodeId }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Peer project import failed: ${peer.url} returned ${response.status}`);
  return localImport;
}

async function discoverMissingPeerProjects(): Promise<void> {
  if (!startupReady || projectDiscoveryInProgress) return;
  projectDiscoveryInProgress = true;
  try {
    for (const peer of await listClusterPeers()) {
      try {
        await importProjectsFromPeer(peer, true);
      } catch (error) {
        console.warn(`Project discovery from ${peer.id} failed`, error);
      }
    }
  } finally {
    projectDiscoveryInProgress = false;
  }
}

function requirePathInsideHome(candidate: string, homeDirectory: string): void {
  const relative = path.relative(homeDirectory, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Folder must be inside this node's home directory");
}

/** A peer can carry a workspace this node never defined; fall back to a local one rather than inventing a folder. */
async function localWorkspaceId(candidate: string | undefined): Promise<string> {
  const workspaces = await listWorkspaces();
  if (candidate && workspaces.some((workspace) => workspace.id === candidate)) return candidate;
  return workspaces[0]?.id ?? "personal";
}

async function assertManagedHomeChangeAllowed(nextHomePath: string): Promise<void> {
  const currentHomePath = getSettings().projects.homePath;
  if (path.resolve(currentHomePath) === path.resolve(nextHomePath)) return;
  for (const project of await listProjects()) {
    if ((await listTasks(project.id)).some((task) => task.worktreePath && !task.worktreeBranch)) {
      throw new TaskWorkspaceError("Archive or delete board cards before changing the Joint Bob home folder");
    }
  }
}

async function mappedPathInsideHome(candidate: string): Promise<string> {
  const homeDirectory = await realpath(os.homedir());
  const resolved = path.resolve(candidate);
  let existing = resolved;
  while (true) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  requirePathInsideHome(existing, homeDirectory);
  return resolved;
}

async function mapProjectFromPeer(peer: ClusterPeer, inventory: PeerInventory, entry: PeerInventory["projects"][number], requestedPath: string): Promise<ProjectRecord> {
  const remoteProject = entry.project;
  const localPath = await mappedPathInsideHome(requestedPath);
  if (remoteProject.syncFolderId) {
    if (inventory.syncDeviceId) await ensureSyncthingDevice(inventory.syncDeviceId, inventory.node.name);
    await ensureSyncthingFolder(remoteProject.syncFolderId, remoteProject.name, localPath, inventory.syncDeviceId);
    const localDeviceId = await syncthingDeviceId();
    if (localDeviceId) {
      const shareResponse = await fetch(`${peer.url}/api/cluster/sync/share`, {
        method: "POST",
        headers: { ...(peer.token ? { Authorization: `Bearer ${peer.token}` } : {}), "Content-Type": "application/json" },
        body: JSON.stringify({ folderId: remoteProject.syncFolderId, deviceId: localDeviceId, deviceName: (await getClusterNode()).name }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!shareResponse.ok) throw new Error(`Peer Syncthing share failed: ${shareResponse.status}`);
    }
  }
  const project = await importProject({ ...remoteProject, type: await localWorkspaceId(remoteProject.type) }, localPath, inventory.node.id);
  await registerProjectAliases(project.id, [remoteProject.id, ...(entry.aliases ?? [])]);
  sessionWatcher.ensureProject(project);
  return project;
}

app.use(securityHeaders);
app.set("trust proxy", 1);
// Browsers request /favicon.ico regardless of the <link rel="icon"> tags; without
// this the path falls through to the SPA and the tab gets HTML instead of an image.
app.get("/favicon.ico", (_request, response) => {
  response.type("image/png").sendFile(path.join(publicDir, "icon-192.png"));
});
app.use("/vendor/codemirror", express.static(codemirrorDir, { index: false }));
app.use(express.static(publicDir));
app.use(express.json({ limit: "12mb" }));

app.get("/api/auth/status", (request, response) => {
  response.json(authenticationStatus(sessionForId(requestCookie(request, sessionCookieName))));
});

app.get("/api/health", (_request, response) => {
  // The semantic version is what the user sees; the commit stays for diagnostics.
  const version = appVersion();
  const release = process.env.JOINT_BOB_RELEASE ?? process.env.MASTER_BOB_RELEASE ?? "development";
  if (!startupReady) {
    response.status(503).json({ status: "starting", version, release });
    return;
  }
  response.json({ status: "ok", version, release });
});

app.post("/api/auth/setup", (request, response, next) => {
  try {
    const payload = loginSchema.parse(request.body);
    if (!authenticationStatus().setupRequired) {
      sendError(response, 409, "Administrator already exists");
      return;
    }
    createAdministrator(payload.username, payload.password, false);
    const session = authenticate(payload.username, payload.password);
    response.setHeader("Set-Cookie", sessionCookieValue(session));
    response.status(201).json({ mustChangePassword: false, csrfToken: session.csrfToken, username: session.username });
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
      return;
    }
    next(error);
  }
});

app.post("/api/auth/login", (request, response, next) => {
  try {
    const payload = loginSchema.parse(request.body);
    const session = authenticate(payload.username, payload.password);
    response.setHeader("Set-Cookie", sessionCookieValue(session));
    response.json({ mustChangePassword: session.mustChangePassword, csrfToken: session.csrfToken, username: session.username });
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
      return;
    }
    if (error instanceof Error && ["Invalid username or password", "Too many login attempts. Try again in 15 minutes"].includes(error.message)) {
      sendError(response, 401, error.message);
      return;
    }
    next(error);
  }
});

app.post("/api/cluster/invitations/redeem", async (request, response, next) => {
  try {
    const payload = clusterInvitationRedeemSchema.parse(request.body);
    const invitationResult = await clusterInvitationStatus(payload.invitationId, payload.secret, payload.member.id);
    if (invitationResult === "invalid") { sendError(response, 401, "Invalid cluster invitation"); return; }
    if (invitationResult === "expired") { sendError(response, 410, "Cluster invitation has expired"); return; }
    if (invitationResult === "used") { sendError(response, 410, "Cluster invitation has already been used"); return; }
    const [localNode, peers] = await Promise.all([getClusterNode(), listClusterPeers()]);
    const conflict = clusterInvitationConflict(payload.member, localNode, peers, invitationResult === "retry");
    if (conflict) { sendError(response, 409, conflict); return; }
    const existing = peers.find((peer) => peer.id === payload.member.id);
    if (!existing && peers.length >= 4) { sendError(response, 409, "A cluster supports at most five nodes"); return; }
    const claimed = await consumeClusterInvitation(payload.invitationId, payload.secret, payload.member.id);
    if (claimed === "invalid") { sendError(response, 401, "Invalid cluster invitation"); return; }
    if (claimed === "expired") { sendError(response, 410, "Cluster invitation has expired"); return; }
    if (claimed === "used") { sendError(response, 410, "Cluster invitation has already been used"); return; }
    if (!existing) {
      const { token, ...node } = payload.member;
      await saveClusterPeer(createClusterPeer(node, token));
    }
    response.status(201).json({ inviterNodeId: localNode.id, membership: await getClusterMembership() });
  } catch (error) {
    next(error);
  }
});

app.use("/api", requireHttpAuth, requireCsrf);
app.use("/api", (request, response, next) => {
  if (updatePreparing && !["GET", "HEAD", "OPTIONS"].includes(request.method) && request.path !== "/update/prepare") {
    response.status(503).json({ error: "Server update in progress" });
    return;
  }
  next();
});

app.post("/api/auth/change-password", (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const payload = passwordChangeSchema.parse(request.body);
    changePassword(session, payload.currentPassword, payload.newPassword);
    response.status(204).send();
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
      return;
    }
    if (error instanceof Error && error.message === "Current password is incorrect") {
      sendError(response, 400, error.message);
      return;
    }
    next(error);
  }
});

app.post("/api/auth/logout", (_request, response) => {
  const session = response.locals.authSession as AuthSession;
  revokeSession(session.id);
  response.setHeader("Set-Cookie", clearSessionCookieValue());
  response.status(204).send();
});

app.get("/api/auth/sessions", (_request, response) => {
  const session = response.locals.authSession as AuthSession;
  response.json({ currentSessionId: session.id, sessions: listLoginSessions(session.userId) });
});

app.delete("/api/auth/sessions/:sessionId", (request, response) => {
  const session = response.locals.authSession as AuthSession;
  if (!revokeUserSession(session.userId, request.params.sessionId)) {
    sendError(response, 404, "Login session not found");
    return;
  }
  if (request.params.sessionId === session.id) response.setHeader("Set-Cookie", clearSessionCookieValue());
  response.status(204).send();
});

app.get("/api/preferences", (_request, response) => {
  const session = response.locals.authSession as AuthSession;
  response.json(getUserPreferences(session.userId));
});

/* Canvas keyboard bindings belong to the account, not the node, so every route keys
   on the signed-in username and the store replicates the change to the cluster. */
const canvasShortcutTargetSchema = z.object({
  projectId: z.string().trim().min(1).max(120),
  engine: z.enum(["pi", "claude"]),
  sessionId: z.string().trim().min(1).max(200),
}).strict();

app.get("/api/canvas/shortcuts", (_request, response) => {
  const session = response.locals.authSession as AuthSession;
  response.json({ shortcuts: listCanvasShortcuts(session.username) });
});

app.put("/api/canvas/shortcuts/:binding", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const target = canvasShortcutTargetSchema.parse(request.body);
    const local = await getClusterNode();
    response.json({ shortcuts: setCanvasShortcut(session.username, request.params.binding, target, local.id) });
  } catch (error) {
    if (error instanceof Error && /canvas binding/i.test(error.message)) {
      sendError(response, 400, error.message);
      return;
    }
    next(error);
  }
});

/* Closing a conversation releases the key it holds right now. Deleting the binding the
   page last saw would take a key another node has since moved to a different pane. */
app.post("/api/canvas/shortcuts/release", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const target = canvasShortcutTargetSchema.parse(request.body);
    const local = await getClusterNode();
    response.json({ shortcuts: releaseCanvasShortcuts(session.username, [target], local.id) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/canvas/shortcuts/:binding", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const local = await getClusterNode();
    response.json({ shortcuts: clearCanvasShortcut(session.username, request.params.binding, local.id) });
  } catch (error) {
    if (error instanceof Error && /canvas binding/i.test(error.message)) {
      sendError(response, 400, error.message);
      return;
    }
    next(error);
  }
});

/** Iterative bound checked before the recursive Zod schema, so a pathologically
 * nested layout is rejected as a 400 instead of exhausting the parse stack. */
function canvasLayoutExceedsLimits(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const layout = value as { root?: unknown; rows?: unknown };
  if (Array.isArray(layout.rows)) {
    if (layout.rows.length > 10) return true;
    // 10 rows x 8 panes bounds a row payload; anything beyond is malformed.
    const oversizedRow = layout.rows.some((row) => !row || typeof row !== "object"
      || !Array.isArray((row as { panes?: unknown }).panes) || (row as { panes: unknown[] }).panes.length > 8);
    if (oversizedRow) return true;
  }
  // Inspect a root even when a malicious payload also supplies rows; otherwise
  // the extra property could bypass this iterative guard before Zod sees it.
  const root = layout.root;
  if (!root || typeof root !== "object") return false;
  const stack: Array<[unknown, number]> = [[root, 0]];
  let nodes = 0;
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (!node || typeof node !== "object") continue;
    if (++nodes > 80 || depth > 8) return true;
    // Descend regardless of kind: a malformed kind must not reach the recursive
    // schema parser and blow the stack before validation can reject it.
    const item = node as { first?: unknown; second?: unknown };
    stack.push([item.first, depth + 1], [item.second, depth + 1]);
  }
  return false;
}

app.put("/api/preferences", (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    if (canvasLayoutExceedsLimits((request.body as { canvasLayout?: unknown }).canvasLayout)) {
      sendError(response, 400, "Canvas layout is too large or too deep");
      return;
    }
    const parsed = userPreferencesSchema.parse(request.body);
    const { canvasLayout, ...preferences } = parsed;
    const update: Partial<UserPreferences> = preferences;
    // Older clients still send per-pane widths and pinned row heights. The grid has
    // no room for either, so they are dropped on the way in.
    if (canvasLayout) update.canvasLayout = canvasLayout.version === 1
      ? migrateLegacyCanvasLayout(canvasLayout)
      : { version: 4, rows: canvasLayout.rows.map((row) => ({ id: row.id, panes: row.panes })), focusedPaneId: canvasLayout.focusedPaneId };
    response.json(updateUserPreferences(session.userId, update));
  } catch (error) {
    next(error);
  }
});

app.get("/api/audit", async (request, response, next) => {
  try {
    const { limit } = auditQuerySchema.parse(request.query);
    response.json({ events: await listAuditEvents(limit) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
      return;
    }
    next(error);
  }
});

app.get("/api/settings", (_request, response) => {
  response.json(getSettings());
});

app.put("/api/settings", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const payload = settingsSchema.parse(request.body);
    const homePath = payload.projects?.homePath ?? getSettings().projects.homePath;
    if (!homePath.trim() || !path.isAbsolute(homePath)) throw new Error("Joint Bob home folder must be absolute");
    await assertManagedHomeChangeAllowed(homePath);
    await ensureManagedHome(homePath, (await listWorkspaces()).map((workspace) => workspace.id));
    const settings = updateSettings(payload, session.userId);
    resetSyncthingConnection();
    response.json(settings);
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
      return;
    }
    if (error instanceof Error && (
      error.message === "Syncthing endpoint must use a loopback host" ||
      error.message === "Joint Bob home folder must be absolute" ||
      /^(Pi|Claude) (config path|session path) must be blank or absolute$/.test(error.message) ||
      /^(Pi|Claude) executable must be a command name or absolute path$/.test(error.message)
    )) {
      sendError(response, 400, error.message);
      return;
    }
    next(error);
  }
});

app.post("/api/cluster/invitations", async (_request, response, next) => {
  try {
    const node = await getClusterNode();
    if (!node.url) { sendError(response, 409, "Configure this node's public Tailscale URL before generating an invitation"); return; }
    if ((await listClusterPeers()).length >= 4) { sendError(response, 409, "A cluster supports at most five nodes"); return; }
    const invitation = await createClusterInvitation();
    const link = new URL("/join", `${node.url}/`);
    link.hash = `${invitation.id}.${invitation.secret}`;
    response.status(201).json({ link: link.href });
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/join", async (request, response, next) => {
  try {
    const payload = clusterJoinSchema.parse(request.body);
    let invitation: ReturnType<typeof parseClusterInvitationLink>;
    try {
      invitation = parseClusterInvitationLink(payload.link);
    } catch {
      sendError(response, 400, "Cluster invitation link is invalid");
      return;
    }
    const [currentNode, peers, machineToken] = await Promise.all([getClusterNode(), listClusterPeers(), getClusterMachineToken()]);
    if (peers.length && !peers.some((peer) => canonicalClusterUrl(peer.url) === invitation.inviterUrl)) {
      sendError(response, 409, "This node already belongs to a different cluster");
      return;
    }
    const member = { ...prospectiveClusterNode(currentNode, payload.name, payload.url), token: machineToken };
    const redeemResponse = await fetch(`${invitation.inviterUrl}/api/cluster/invitations/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationId: invitation.invitationId, secret: invitation.secret, member }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!redeemResponse.ok) {
      const body = await redeemResponse.json().catch(() => ({})) as { error?: string };
      sendError(response, redeemResponse.status, body.error ?? `Inviting node returned ${redeemResponse.status}`);
      return;
    }
    const redemption = clusterInvitationRedemptionSchema.parse(await redeemResponse.json());
    const localNode = await updateClusterNode(payload.name, payload.url);
    await mergeClusterMembership(redemption.membership, redemption.inviterNodeId);
    const inviter = await getClusterPeer(redemption.inviterNodeId);
    if (!inviter) throw new Error("Inviting node was not added to cluster membership");
    const confirmation = await fetch(`${inviter.url}/api/cluster/membership/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${inviter.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(await getClusterMembership()),
      signal: AbortSignal.timeout(5_000),
    });
    if (!confirmation.ok) throw new Error(`Cluster membership confirmation failed: inviting node returned ${confirmation.status}`);
    const localImport = await syncPairedProjects(inviter, localNode.id);
    response.status(201).json({ peers: (await listClusterPeers()).map(publicClusterPeer), pending: localImport.pending });
  } catch (error) {
    next(error);
  }
});

app.get("/api/cluster/invite", async (_request, response, next) => {
  try {
    response.json({ token: await getClusterMachineToken() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/cluster/node", async (_request, response, next) => {
  try {
    response.json({ node: await getClusterNode() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/cluster/node", async (request, response, next) => {
  try {
    const payload = clusterNodeSchema.parse(request.body);
    response.json({ node: await updateClusterNode(payload.name, payload.url) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/cluster/local-inventory", async (_request, response, next) => {
  try {
    const node = await getClusterNode();
    const projects = await listProjects();
    let syncDeviceId: string | undefined;
    let syncError: string | undefined;
    try {
      syncDeviceId = await syncthingDeviceId();
      for (const project of projects) {
        if (project.syncFolderId) continue;
        const folderId = await syncthingFolderIdForPath(project.path);
        if (folderId) Object.assign(project, await updateProjectSyncFolderId(project.id, folderId));
      }
    } catch (error) {
      syncError = error instanceof Error ? error.message : "Syncthing unavailable";
    }
    const inventory = await Promise.all(projects.map(async (project) => ({
      project: projectWithLocalLocation(project, node.id),
      aliases: await projectAliasIds(project.id),
      tasks: await listTasks(project.id),
    })));
    response.json({ node, syncDeviceId, syncError, projectRoot: getSettings().projects.homePath, projects: inventory, generatedAt: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/cluster/inventory", async (_request, response, next) => {
  try {
    const local = await getClusterNode();
    const peers = await listClusterPeers();
    const remote = await Promise.all(peers.map(async (peer) => {
      try {
        const peerResponse = await fetch(`${peer.url}/api/cluster/local-inventory`, {
          headers: { Authorization: `Bearer ${peer.token}` },
          signal: AbortSignal.timeout(3_000),
        });
        if (!peerResponse.ok) throw new Error(`Peer returned ${peerResponse.status}`);
        const inventory = await peerResponse.json();
        await markClusterPeerSeen(peer.id);
        return { peerId: peer.id, reachable: true, inventory };
      } catch (error) {
        return { peerId: peer.id, reachable: false, error: error instanceof Error ? error.message : "Peer unavailable" };
      }
    }));
    response.json({ local, remote, generatedAt: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/cluster/peers", async (_request, response, next) => {
  try {
    response.json({ peers: (await listClusterPeers()).map(publicClusterPeer) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/peers", async (request, response, next) => {
  try {
    const payload = clusterPeerSchema.parse(request.body);
    const peerUrl = payload.url.replace(/\/$/, "");
    const nodeResponse = await fetch(`${peerUrl}/api/cluster/node`, {
      headers: { Authorization: `Bearer ${payload.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!nodeResponse.ok) throw new Error(`Peer ${peerUrl} returned ${nodeResponse.status}`);
    const peerNode = clusterMembershipMemberSchema.omit({ token: true }).parse((await nodeResponse.json()).node);
    const localNode = await getClusterNode();
    if (!localNode.url) throw new Error("Configure this node's public Tailscale URL before pairing");
    await saveClusterPeer(createClusterPeer(peerNode, payload.token));
    const acceptResponse = await fetch(`${peerUrl}/api/cluster/peers/accept`, {
      method: "POST",
      headers: { Authorization: `Bearer ${payload.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(await getClusterMembership()),
      signal: AbortSignal.timeout(5_000),
    });
    if (!acceptResponse.ok) throw new Error(`Peer pairing failed: ${peerUrl} returned ${acceptResponse.status}`);
    const remoteSnapshot = clusterMembershipSnapshotSchema.parse(await acceptResponse.json());
    await mergeClusterMembership(remoteSnapshot, peerNode.id);
    const peer = await getClusterPeer(peerNode.id);
    if (!peer) throw new Error("Paired peer was not added to cluster membership");
    const confirmation = await fetch(`${peerUrl}/api/cluster/membership/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(await getClusterMembership()),
      signal: AbortSignal.timeout(5_000),
    });
    if (!confirmation.ok) throw new Error(`Peer membership confirmation failed: ${peerUrl} returned ${confirmation.status}`);
    const localImport = await syncPairedProjects(peer, localNode.id);
    response.status(201).json({ peer: publicClusterPeer(peer), pending: localImport.pending });
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/peers/accept", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const snapshot = clusterMembershipSnapshotSchema.parse(request.body);
    await mergeClusterMembership(snapshot, response.locals.machineNodeId as string | undefined);
    response.status(201).json(await getClusterMembership());
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/membership/sync", async (request, response, next) => {
  try {
    const snapshot = clusterMembershipSnapshotSchema.parse(request.body);
    await mergeClusterMembership(snapshot, response.locals.machineNodeId as string | undefined);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/events", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const batch = replicationBatchSchema.parse(request.body) as ReplicationBatch;
    const received = await receiveReplicationBatch(batch);
    // A replicated review watermark changes what every project list shows, so every
    // watcher hears about it rather than waiting for the next poll.
    if (batch.events.some((event) => event.entityType === "conversation.review")) broadcastSessionsChangedToAllProjects();
    response.json({ received });
  } catch (error) {
    next(error);
  }
});

/** A peer's current conversation running set; see conversation-runtime.ts for the lease rules. */
app.post("/api/cluster/sessions/runtime-snapshot", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const snapshot = runtimeSnapshotSchema.parse(request.body);
    // The authenticated machine identity, not the payload, says whose leases these are.
    if (snapshot.nodeId !== response.locals.machineNodeId) {
      sendError(response, 403, "Runtime snapshot nodeId does not match the authenticated peer");
      return;
    }
    const ownerships = new Map(await Promise.all([...new Set(snapshot.leases.map((lease) => `${lease.engine}\n${lease.sessionId}`))]
      .map(async (key) => [key, await getConversationOwnership(key.slice(0, key.indexOf("\n")) as "pi" | "claude", key.slice(key.indexOf("\n") + 1))] as const)));
    // Authoritative ownership beats stale heartbeats: keep a lease only when the
    // ownership table is absent, older than the lease's epoch, or agrees with it.
    const leases: RuntimeLeaseInput[] = snapshot.leases.flatMap((lease) => {
      const ownership = ownerships.get(`${lease.engine}\n${lease.sessionId}`);
      const allowed = !ownership
        || ownership.epoch < lease.ownershipEpoch
        || (ownership.epoch === lease.ownershipEpoch && ownership.ownerNodeId === snapshot.nodeId);
      return allowed ? [{ ...lease, ownerNodeId: snapshot.nodeId }] : [];
    });
    const changed = applyRuntimeLeaseSnapshot(conversationRuntimeDatabase(), snapshot.nodeId, snapshot.generatedAt, leases);
    if (changed.length) broadcastSessionsChangedToAllProjects();
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Kept for one release as a clean refusal: a peer on an older build gets 410 rather than a
// half-applied write into tables this build no longer has.
app.post("/api/cluster/github/events", (request, response) => {
  if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
  sendError(response, 410, "GitHub credential groups were replaced by secret accounts; upgrade this peer");
});

app.post("/api/cluster/secrets/events", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = secretCredentialBatchSchema.parse(request.body);
    response.json({ received: await receiveSecretCredentialEvents(payload.events as SecretCredentialEvent[]) });
  } catch (error) { next(error); }
});

app.post("/api/cluster/tasks/eligibility", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = taskEligibilitySchema.parse(request.body);
    const reasons = await taskHandoffEligibility(payload.projectId, payload.task as TaskRecord);
    response.json({ eligible: reasons.length === 0, reasons });
  } catch (error) { next(error); }
});

app.post("/api/cluster/tasks/status", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = taskHandoffStatusSchema.parse(request.body);
    const record = await getTaskHandoff(payload.handoffId);
    if (!record) { sendError(response, 404, "Handoff not found"); return; }
    response.json({ status: record.status, taskId: record.taskId, projectId: record.protocolProjectId, sourceNodeId: record.sourceNodeId, destinationNodeId: record.destinationNodeId });
  } catch (error) { next(error); }
});

app.post("/api/cluster/tasks/prepare", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = preparedTaskSchema.parse(request.body);
    if (await isTaskHandoffRejected(payload.handoffId)) { sendError(response, 409, `Handoff ${payload.handoffId} is rejected`); return; }
    const task = payload.task as TaskRecord;
    const source = await getClusterPeer(task.currentNodeId);
    if (!source) { sendError(response, 403, "Task owner is not a known peer"); return; }
    const reasons = await taskHandoffEligibility(payload.projectId, task);
    if (reasons.length) { sendError(response, 409, reasons.join("; ")); return; }
    if (task.worktreeBranch && !payload.bundle) { sendError(response, 400, "Task worktree handoff requires a branch bundle"); return; }
    if (!task.worktreeBranch && payload.bundle) { sendError(response, 400, "Task has no worktree branch for this bundle"); return; }
    const project = await getProject(payload.projectId);
    if (!project) throw new Error("Eligible project disappeared");
    const local = await getClusterNode();
    await assertTaskFilesReady(project, task);
    const reservation = await reserveTaskHandoff(payload.handoffId, project.id, payload.projectId, task, local.id, payload.handoffContext, payload.handoffVersion);
    if (reservation.status === "prepared" || reservation.status === "committed") {
      response.status(201).json({ task: (await listTasks(project.id)).find((candidate) => candidate.id === task.id) });
      return;
    }
    let worktree: PreparedTaskWorktree | null = null;
    try {
      worktree = task.worktreeBranch && payload.bundle ? await prepareTaskWorktreeFromBundle(project.path, task.id, task.worktreeBranch, payload.bundle) : null;
      const prepared = await prepareTaskHandoff(payload.handoffId, project.id, payload.projectId, task, local.id, worktree, payload.handoffContext, payload.handoffVersion);
      broadcastToProject(project.id, { type: "tasksChanged" });
      response.status(201).json({ task: prepared });
    } catch (error) {
      try { await abortPreparedTaskHandoff(payload.handoffId, local.id); }
      catch (abortError) { console.warn(`Prepared handoff abort failed for ${payload.handoffId}`, abortError); }
      if (worktree?.created) {
        try { await removePreparedTaskWorktree(project.path, worktree.path, worktree.branch); }
        catch (cleanupError) { console.warn(`Prepared worktree cleanup failed for ${payload.handoffId}`, cleanupError); }
      }
      throw error;
    }
  } catch (error) { next(error); }
});

app.post("/api/cluster/tasks/commit", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = taskHandoffActionSchema.parse(request.body);
    const record = await getTaskHandoff(payload.handoffId);
    if (!record) { sendError(response, 404, "Prepared handoff not found"); return; }
    const project = await getProject(record.projectId);
    if (!project) throw new Error("Prepared handoff project is not mapped on this node");
    await assertTaskFilesReady(project, record.task);
    const local = await getClusterNode();
    const task = await commitPreparedTaskHandoff(payload.handoffId, local.id);
    broadcastToProject(record.projectId, { type: "tasksChanged" });
    response.json(task ? { task } : { task: null, deleted: await taskHandoffDeletion(payload.handoffId) });
  } catch (error) { next(error); }
});

app.post("/api/cluster/tasks/settle", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = taskHandoffActionSchema.parse(request.body);
    const local = await getClusterNode();
    await acknowledgeIncomingTaskHandoff(payload.handoffId, local.id);
    response.json({ ok: true });
  } catch (error) { next(error); }
});

app.post("/api/cluster/tasks/abort", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = taskHandoffActionSchema.parse(request.body);
    const record = await getTaskHandoff(payload.handoffId);
    if (!record) {
      await rejectTaskHandoff(payload.handoffId);
      response.json({ task: null });
      return;
    }
    const local = await getClusterNode();
    const restored = await abortPreparedTaskHandoff(payload.handoffId, local.id);
    if (record.worktreeCreated && record.worktreePath && record.worktreeBranch) {
      const project = await getProject(record.projectId);
      if (!project) throw new Error("Prepared task project is not mapped on this node");
      try { await removePreparedTaskWorktree(project.path, record.worktreePath, record.worktreeBranch); } catch (error) { console.warn(`Prepared worktree cleanup failed for ${payload.handoffId}`, error); }
    }
    if (record) broadcastToProject(record.projectId, { type: "tasksChanged" });
    response.json({ task: restored ?? null });
  } catch (error) { next(error); }
});

async function ownerPeer(task: TaskRecord, localId: string): Promise<ClusterPeer | undefined> {
  return task.currentNodeId === localId ? undefined : getClusterPeer(task.currentNodeId);
}

function assertTaskNotHandoffPending(task: TaskRecord): void {
  if (task.executionState === "handoff_pending") throw new TaskWorktreeError("Task handoff is awaiting destination commit");
}

async function mergeOwnedTask(project: ProjectRecord, task: TaskRecord): Promise<TaskRecord> {
  assertTaskNotHandoffPending(task);
  if (task.status !== "done") throw new TaskWorktreeError("Move the ticket to Done before merging");
  if (taskRunActive(task.id)) throw new TaskWorktreeError("Wait for the ticket agent to finish before merging");
  if (!task.worktreePath || !task.worktreeBranch) throw new TaskWorktreeError("This ticket has no isolated worktree");
  if (task.mergedAt) throw new TaskWorktreeError("Ticket is already merged");
  await mergeTaskWorktree(project.path, task.worktreePath, task.worktreeBranch, task.title);
  const merged = await updateTask(project.id, task.id, { mergedAt: new Date().toISOString() });
  broadcastToProject(project.id, { type: "tasksChanged" });
  return merged;
}

function assertTaskWorkspaceCanClose(task: TaskRecord): void {
  assertTaskNotHandoffPending(task);
  if (taskRunActive(task.id)) throw new TaskWorkspaceError("Wait for task agent to finish before closing its workspace");
  assertTaskCanBeDeleted(task);
}

async function archiveOwnedTask(project: ProjectRecord, task: TaskRecord): Promise<TaskRecord> {
  assertTaskWorkspaceCanClose(task);
  const synchronizedWorkspace = !task.worktreeBranch;
  const workspaceKey = task.worktreePath ? taskWorkspaceKey(task.worktreePath, task.id) : project.id;
  const archived = await updateTask(project.id, task.id, {
    status: "done",
    ...(synchronizedWorkspace ? { worktreePath: null } : {}),
  });
  if (synchronizedWorkspace) await removeTaskWorkspace(workspaceKey, task.id);
  broadcastToProject(project.id, { type: "tasksChanged" });
  return archived;
}

async function deleteOwnedTask(project: ProjectRecord, task: TaskRecord): Promise<void> {
  assertTaskWorkspaceCanClose(task);
  const workspaceKey = task.worktreePath ? taskWorkspaceKey(task.worktreePath, task.id) : project.id;
  await deleteTask(project.id, task.id);
  if (!task.worktreeBranch) await removeTaskWorkspace(workspaceKey, task.id);
  broadcastToProject(project.id, { type: "tasksChanged" });
}

type RemoteHandoffStatus = "pending" | "prepared" | "committed" | "aborted" | "missing";

async function remoteHandoffStatus(record: TaskHandoffRecord, peer: ClusterPeer): Promise<RemoteHandoffStatus> {
  const response = await fetch(`${peer.url}/api/cluster/tasks/status`, { method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ handoffId: record.handoffId }), signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) return "missing";
  if (!response.ok) throw new Error(`Peer handoff status failed: ${response.status}`);
  const remote = z.object({ status: z.enum(["pending", "prepared", "committed", "aborted"]), taskId: z.string(), projectId: z.string(), sourceNodeId: z.string().uuid(), destinationNodeId: z.string().uuid() }).parse(await response.json());
  if (remote.taskId !== record.taskId || remote.projectId !== record.projectId || remote.sourceNodeId !== record.sourceNodeId || remote.destinationNodeId !== record.destinationNodeId) throw new Error("Peer returned an invalid handoff status");
  return remote.status;
}

async function settlePeerTaskHandoff(peer: ClusterPeer, handoffId: string): Promise<boolean> {
  try {
    const response = await fetch(`${peer.url}/api/cluster/tasks/settle`, { method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ handoffId }), signal: AbortSignal.timeout(30_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function commitOutgoingTaskHandoff(record: TaskHandoffRecord): Promise<TaskRecord | null> {
  const peer = await getClusterPeer(record.destinationNodeId);
  if (!peer) throw new Error("Peer not found");
  const project = await getProject(record.projectId);
  if (!project) throw new Error("Handoff project is not mapped on this node");
  await assertTaskFilesReady(project, record.task);
  const response = await fetch(`${peer.url}/api/cluster/tasks/commit`, { method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ handoffId: record.handoffId }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Peer handoff commit failed: ${response.status}`);
  const committed = z.object({ task: z.object({ id: z.string(), currentNodeId: z.string().uuid(), executionState: z.literal("idle"), sessionPath: z.string().nullable() }).passthrough().nullable(), deleted: taskHandoffDeletionSchema.optional() }).parse(await response.json());
  if (committed.task === null) {
    if (!committed.deleted) throw new Error("Peer returned a deleted task without a deletion version");
    const task = await completeTaskHandoff(record.handoffId, record.projectId, record.taskId, record.sourceNodeId, record.destinationNodeId, committed.deleted);
    await markOutgoingTaskHandoff(record.handoffId, "committed");
    if (await settlePeerTaskHandoff(peer, record.handoffId)) await acknowledgeOutgoingTaskHandoff(record.handoffId);
    broadcastToProject(record.projectId, { type: "tasksChanged" });
    broadcastToProject(record.projectId, { type: "sessionsChanged" });
    return task;
  }
  if (committed.task.id !== record.taskId || committed.task.currentNodeId !== record.destinationNodeId) throw new Error("Peer returned an invalid committed task");
  await completeTaskHandoff(record.handoffId, record.projectId, record.taskId, record.sourceNodeId, record.destinationNodeId);
  await markOutgoingTaskHandoff(record.handoffId, "committed");
  if (await settlePeerTaskHandoff(peer, record.handoffId)) await acknowledgeOutgoingTaskHandoff(record.handoffId);
  broadcastToProject(record.projectId, { type: "tasksChanged" });
  broadcastToProject(record.projectId, { type: "sessionsChanged" });
  return committed.task as unknown as TaskRecord;
}

async function resumeRemotePendingHandoff(record: TaskHandoffRecord, peer: ClusterPeer): Promise<TaskRecord | null | undefined> {
  const project = await getProject(record.projectId);
  if (!project) throw new Error("Handoff project is not mapped on this node");
  const task = record.task;
  let bundle: Awaited<ReturnType<typeof exportTaskBranchBundle>> | null = null;
  if (task.worktreeBranch) {
    if (!task.worktreePath) throw new TaskWorktreeError("Task worktree metadata is incomplete.");
    await assertTaskWorktreeTransferable(project.path, task.worktreePath, task.worktreeBranch);
    bundle = await exportTaskBranchBundle(project.path, task.worktreePath, task.worktreeBranch);
  }
  const handoffContext = await taskHandoffContext(project, task);
  await assertTaskFilesReady(project, task);
  const response = await fetch(`${peer.url}/api/cluster/tasks/prepare`, { method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: record.projectId, task, handoffId: record.handoffId, handoffContext, handoffVersion: record.createdAt, bundle }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return undefined;
  await markOutgoingTaskHandoff(record.handoffId, "prepared");
  return commitOutgoingTaskHandoff(record);
}

async function reconcileOutgoingTaskHandoff(record: TaskHandoffRecord, peer: ClusterPeer): Promise<TaskRecord | null | undefined> {
  if (record.status === "pending") {
    const remoteStatus = await remoteHandoffStatus(record, peer);
    if (remoteStatus === "pending") return resumeRemotePendingHandoff(record, peer);
    if (["prepared", "committed"].includes(remoteStatus)) {
      await markOutgoingTaskHandoff(record.handoffId, "prepared");
      return commitOutgoingTaskHandoff(record);
    }
    if (remoteStatus === "aborted") {
      await abortOutgoingTaskHandoff(record.handoffId);
      return undefined;
    }
    if (remoteStatus === "missing" && await abortPeerTaskHandoff(peer, record.handoffId)) {
      await abortOutgoingTaskHandoff(record.handoffId);
      return undefined;
    }
    return undefined;
  }
  if (record.status === "committed") {
    if (!(await settlePeerTaskHandoff(peer, record.handoffId))) return undefined;
    await acknowledgeOutgoingTaskHandoff(record.handoffId);
    const task = (await listTasks(record.projectId)).find((candidate) => candidate.id === record.taskId);
    return task ?? null;
  }
  return commitOutgoingTaskHandoff(record);
}

async function pendingHandoffResponse(task: TaskRecord, peer: ClusterPeer): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: 202, body: { task, destination: publicClusterPeer(peer), handoffPendingCommit: true, message: "Handoff prepared; ownership remains on this node until destination commit is confirmed." } };
}

async function handoffOwnedTask(project: ProjectRecord, task: TaskRecord, peerId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const local = await getClusterNode();
  if (peerId === local.id) throw new TaskWorktreeError("Task is already owned by this node");
  if (task.executionState === "handoff_pending") {
    const record = (await listUnfinishedOutgoingTaskHandoffs()).find((candidate) => candidate.projectId === project.id && candidate.taskId === task.id);
    if (!record || record.destinationNodeId !== peerId) throw new TaskWorktreeError("Task handoff is awaiting destination commit");
    const peer = await getClusterPeer(peerId);
    if (!peer) throw new Error("Peer not found");
    try {
      const reconciled = await reconcileOutgoingTaskHandoff(record, peer);
      if (reconciled !== undefined) return { status: 200, body: { task: reconciled, destination: publicClusterPeer(peer) } };
      return pendingHandoffResponse(task, peer);
    } catch {
      return pendingHandoffResponse(task, peer);
    }
  }
  if (taskRunActive(task.id) || (task.leaseExpiresAt && Date.parse(task.leaseExpiresAt) > Date.now())) throw new TaskWorktreeError("Task has an active run or lease");
  const peer = await getClusterPeer(peerId);
  if (!peer) throw new Error("Peer not found");
  const eligibility = await fetch(`${peer.url}/api/cluster/tasks/eligibility`, { method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, task }), signal: AbortSignal.timeout(3_000) });
  if (!eligibility.ok) throw new Error(`Peer eligibility check failed: ${eligibility.status}`);
  const eligibilityResult = z.object({ eligible: z.boolean(), reasons: z.array(z.string()) }).parse(await eligibility.json());
  if (!eligibilityResult.eligible) throw new TaskWorktreeError(eligibilityResult.reasons.join("; "));
  const previous = (await listUnfinishedOutgoingTaskHandoffs()).find((candidate) => candidate.projectId === project.id && candidate.taskId === task.id && candidate.destinationNodeId === peer.id);
  await assertTaskFilesReady(project, task);
  let outgoing = await beginOutgoingTaskHandoff(project.id, task, local.id, peer.id);
  let outgoingWasNew = !previous;
  if (previous?.status === "pending") {
    try {
      const reconciled = await reconcileOutgoingTaskHandoff(outgoing, peer);
      if (reconciled !== undefined) return { status: 200, body: { task: reconciled, destination: publicClusterPeer(peer) } };
      if ((await getTaskHandoff(outgoing.handoffId))?.status !== "aborted") return pendingHandoffResponse(task, peer);
      outgoing = await beginOutgoingTaskHandoff(project.id, task, local.id, peer.id);
      outgoingWasNew = true;
    } catch {
      return pendingHandoffResponse(task, peer);
    }
  }
  if (previous?.status === "prepared") {
    try { return { status: 200, body: { task: await commitOutgoingTaskHandoff(outgoing), destination: publicClusterPeer(peer) } }; }
    catch { return pendingHandoffResponse(task, peer); }
  }
  let bundle: Awaited<ReturnType<typeof exportTaskBranchBundle>> | null;
  let handoffContext: string;
  try {
    if (task.worktreeBranch) {
      if (!task.worktreePath) throw new TaskWorktreeError("Task worktree metadata is incomplete.");
      await assertTaskWorktreeTransferable(project.path, task.worktreePath, task.worktreeBranch);
    }
    bundle = task.worktreePath && task.worktreeBranch ? await exportTaskBranchBundle(project.path, task.worktreePath, task.worktreeBranch) : null;
    handoffContext = await taskHandoffContext(project, task);
  } catch (error) {
    if (outgoingWasNew) await abortOutgoingTaskHandoff(outgoing.handoffId);
    throw error;
  }
  try {
    await assertTaskFilesReady(project, task);
    const prepared = await fetch(`${peer.url}/api/cluster/tasks/prepare`, { method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, task: outgoing.task, handoffId: outgoing.handoffId, handoffContext, handoffVersion: outgoing.createdAt, bundle }), signal: AbortSignal.timeout(30_000) });
    if (!prepared.ok) return pendingHandoffResponse((await listTasks(project.id)).find((candidate) => candidate.id === task.id) as TaskRecord, peer);
  } catch {
    return pendingHandoffResponse((await listTasks(project.id)).find((candidate) => candidate.id === task.id) as TaskRecord, peer);
  }
  try { await markOutgoingTaskHandoff(outgoing.handoffId, "prepared"); }
  catch { return pendingHandoffResponse((await listTasks(project.id)).find((candidate) => candidate.id === task.id) as TaskRecord, peer); }
  try { return { status: 200, body: { task: await commitOutgoingTaskHandoff(await getTaskHandoff(outgoing.handoffId) as TaskHandoffRecord), destination: publicClusterPeer(peer) } }; }
  catch { return pendingHandoffResponse((await listTasks(project.id)).find((candidate) => candidate.id === task.id) as TaskRecord, peer); }
}

function mirrorTaskResponse(response: Response, routed: globalThis.Response): Promise<void> {
  return routed.text().then((body) => {
    const contentType = routed.headers.get("content-type");
    if (contentType) response.setHeader("Content-Type", contentType);
    response.status(routed.status).send(body);
  });
}

app.patch("/api/cluster/tasks/update", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const routed = routedTaskUpdateSchema.parse(request.body);
    const project = await getProject(routed.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const update = taskUpdateSchema.parse(routed.update);
    const existing = (await listTasks(project.id)).find((task) => task.id === routed.taskId);
    const local = await getClusterNode();
    if (!existing) { sendError(response, 404, "Task not found"); return; }
    if (existing.currentNodeId !== local.id) { sendError(response, 409, "Task is not owned by this node"); return; }
    assertTaskNotHandoffPending(existing);
    if (update.status === "planning" && !(update.planMode ?? existing.planMode)) { sendError(response, 400, "Planning status requires plan mode"); return; }
    const task = await updateTask(project.id, existing.id, update);
    const active = update.status !== undefined && update.status !== existing.status && (update.status === "planning" || update.status === "in_progress" || (update.status === "review" && task.reviewMode));
    if (active && !taskRunActive(task.id)) startTaskRun(project, task).catch((error) => console.warn("Task start failed", error));
    broadcastToProject(project.id, { type: "tasksChanged" });
    response.json({ task });
  } catch (error) { next(error); }
});

app.delete("/api/cluster/tasks/delete", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = routedTaskSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === payload.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task is not owned by this node"); return; }
    await deleteOwnedTask(project, task);
    response.status(204).send();
  } catch (error) {
    if (error instanceof TaskWorkspaceError || (error instanceof Error && error.message === "Wait for task agent to finish before deleting")) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

app.post("/api/cluster/tasks/archive", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = routedTaskSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === payload.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task is not owned by this node"); return; }
    response.json({ task: await archiveOwnedTask(project, task) });
  } catch (error) {
    if (error instanceof TaskWorkspaceError || (error instanceof Error && error.message === "Wait for task agent to finish before deleting")) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

app.post("/api/cluster/tasks/merge", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = routedTaskSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === payload.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task is not owned by this node"); return; }
    assertTaskNotHandoffPending(task);
    response.json({ task: await mergeOwnedTask(project, task) });
  } catch (error) {
    if (error instanceof TaskWorktreeError) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

app.post("/api/cluster/tasks/handoff", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = routedTaskHandoffSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === payload.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task is not owned by this node"); return; }
    const result = await handoffOwnedTask(project, task, payload.peerId);
    response.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof TaskWorktreeError || (error instanceof Error && error.message === "Wait for incoming task handoff settlement before handing off again")) { sendError(response, 409, error.message); return; }
    if (error instanceof Error && error.message === "Peer not found") { sendError(response, 404, error.message); return; }
    next(error);
  }
});

app.post("/api/cluster/projects/import", async (request, response, next) => {
  try {
    const payload = clusterProjectImportSchema.parse(request.body);
    const peer = await getClusterPeer(payload.peerId);
    if (!peer) {
      sendError(response, 404, "Peer not found");
      return;
    }
    response.json(await importProjectsFromPeer(peer));
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/projects/map", async (request, response, next) => {
  try {
    const payload = clusterProjectMapSchema.parse(request.body);
    const peer = await getClusterPeer(payload.peerId);
    if (!peer) { sendError(response, 404, "Peer not found"); return; }
    const inventory = await fetchPeerInventory(peer);
    const entry = inventory.projects.find((candidate) => candidate.project.id === payload.projectId || candidate.aliases?.includes(payload.projectId));
    if (!entry) { sendError(response, 404, "Remote project not found"); return; }
    response.status(201).json({ project: await mapProjectFromPeer(peer, inventory, entry, payload.localPath) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/projects/discover", async (_request, response, next) => {
  try {
    const result: ProjectImportResult = { imported: [], skipped: [], pending: [] };
    for (const peer of await listClusterPeers()) {
      try {
        const peerResult = await importProjectsFromPeer(peer);
        result.imported.push(...peerResult.imported);
        result.skipped.push(...peerResult.skipped);
        result.pending.push(...peerResult.pending);
      } catch (error) {
        result.skipped.push(`${peer.name}: ${error instanceof Error ? error.message : "unavailable"}`);
      }
    }
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/peers/:peerId/projects/:projectId/map", async (request, response, next) => {
  try {
    const peer = await getClusterPeer(request.params.peerId);
    if (!peer) { sendError(response, 404, "Peer not found"); return; }
    const localPath = absolutePathSchema.parse(request.body?.localPath);
    const local = await getClusterNode();
    const peerResponse = await fetch(`${peer.url}/api/cluster/projects/map`, {
      method: "POST",
      headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ peerId: local.id, projectId: request.params.projectId, localPath }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await peerResponse.json();
    response.status(peerResponse.status).json(body);
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/sync/share", async (request, response, next) => {
  try {
    const payload = clusterSyncShareSchema.parse(request.body);
    if (payload.folderId === TICKET_WORKSPACE_FOLDER_ID) {
      await ensureTicketWorkspaceFolder(ticketWorkspaceRoot(), payload.deviceId, payload.deviceName);
      response.json({ ok: true });
      return;
    }
    if (payload.folderId === PI_ENGINE_SYNC_FOLDER_ID || payload.folderId === CLAUDE_ENGINE_SYNC_FOLDER_ID) {
      await pauseEngineSyncFolders();
      response.json({ ok: true });
      return;
    }
    const folderPath = await syncthingPathForFolderId(payload.folderId);
    if (!folderPath) { sendError(response, 404, "Syncthing folder not found"); return; }
    await ensureSyncthingDevice(payload.deviceId, payload.deviceName ?? payload.deviceId);
    await ensureSyncthingFolder(payload.folderId, payload.folderId, folderPath, payload.deviceId);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

async function directoryListing(requestedPath: unknown): Promise<{ currentPath: string; parentPath: string | null; directories: Array<{ name: string; path: string }> }> {
  const payload = directoryBrowseSchema.parse({ path: requestedPath });
  const homeDirectory = await realpath(os.homedir());
  const currentPath = await realpath(payload.path ?? homeDirectory);
  requirePathInsideHome(currentPath, homeDirectory);
  const info = await stat(currentPath);
  if (!info.isDirectory()) throw new Error("Selected path is not a directory");
  const entries = await readdir(currentPath, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: path.join(currentPath, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { currentPath, parentPath: currentPath === homeDirectory ? null : path.dirname(currentPath), directories };
}

for (const route of ["/api/filesystem/directories", "/api/cluster/filesystem/directories"]) {
  app.get(route, async (request, response, next) => {
    try { response.json(await directoryListing(request.query.path)); }
    catch (error) { next(error); }
  });
}

app.get("/api/cluster/peers/:peerId/filesystem/directories", async (request, response, next) => {
  try {
    const peer = await getClusterPeer(request.params.peerId);
    if (!peer) { sendError(response, 404, "Peer not found"); return; }
    const peerUrl = new URL("/api/cluster/filesystem/directories", peer.url);
    if (typeof request.query.path === "string") peerUrl.searchParams.set("path", request.query.path);
    const peerResponse = await fetch(peerUrl, { headers: { Authorization: `Bearer ${peer.token}` }, signal: AbortSignal.timeout(10_000) });
    const body = await peerResponse.json();
    response.status(peerResponse.status).json(body);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/cluster/peers/:peerId", async (request, response, next) => {
  try {
    await removeClusterPeer(request.params.peerId);
    response.status(204).send();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Transfer owned tasks and settle handoffs")) {
      sendError(response, 409, error.message);
      return;
    }
    next(error);
  }
});

app.get("/api/push/vapid-public-key", async (_request, response, next) => {
  try {
    response.json({ publicKey: await getVapidPublicKey() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/push/subscribe", async (request, response, next) => {
  try {
    const payload = pushSubscribeSchema.parse(request.body);
    const authSession = response.locals.authSession as AuthSession;
    await savePushSubscription(payload.subscription, authSession.userId, payload.projectId, payload.sessionPath, payload.title || "Pi");
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.post("/api/push/unsubscribe", async (request, response, next) => {
  try {
    const payload = pushUnsubscribeSchema.parse(request.body);
    await deletePushSubscription(payload.endpoint);
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.get("/api/harnesses", (_request, response) => {
  response.json({ harnesses: listHarnesses().map(({ id, label, paths }) => ({ id, label, newSessionPath: paths.newSession })) });
});

app.get("/api/models", async (_request, response, next) => {
  try {
    response.json({ models: await listAvailableModels() });
  } catch (error) {
    next(error);
  }
});

function unavailableProjectStatus(message = "No Syncthing folder is configured"): ProjectSyncStatus {
  return { state: "unavailable", remainingFiles: 0, remainingBytes: 0, message };
}

async function projectsWithSharedNames(includeSyncStatus = true): Promise<ProjectView[]> {
  const [projects, overrides, locks, local] = await Promise.all([listProjects(), projectNameOverrides(), projectLocks(), getClusterNode()]);
  const statuses = includeSyncStatus
    ? await syncthingFolderStatuses(projects.flatMap((project) => project.syncFolderId ? [project.syncFolderId] : []))
    : {};
  return projects.map((project) => {
    const lock = locks[project.id];
    return {
      ...project,
      name: overrides[project.id] ?? project.name,
      syncStatus: project.syncFolderId
        ? statuses[project.syncFolderId] ?? unavailableProjectStatus("Loading sync status")
        : unavailableProjectStatus(),
      ...(lock ? { lock, lockedElsewhere: lock.nodeId !== local.id } : {}),
    };
  });
}

/** A project locked to a peer node must not be edited here. This prevents accidental parallel
    edits across nodes; any node may clear the lock, so it is not a security boundary. */
class ProjectLockedError extends Error {}

async function assertProjectEditable(project: ProjectRecord): Promise<void> {
  const lock = await getProjectLock(project.id);
  if (!lock) return;
  const local = await getClusterNode();
  if (lock.nodeId === local.id) return;
  throw new ProjectLockedError(`${project.name} is locked by ${lock.nodeName}. Unlock it to edit from this node.`);
}

async function projectView(project: ProjectRecord): Promise<ProjectView> {
  const views = await projectsWithSharedNames();
  return views.find((view) => view.id === project.id)!;
}

async function assertProjectRelocationIdle(project: ProjectRecord): Promise<void> {
  if ((await listTasks(project.id)).some((task) => task.executionState === "running")) {
    throw new ProjectDirectoryImportError("Wait for this project's task to finish before changing its type");
  }
  for (const session of new Set(sharedSessions.values())) {
    if (session.projectId === project.id && (session.clients.size || session.handle.session.isStreaming)) {
      throw new ProjectDirectoryImportError("Close or finish this project's Pi conversations before changing its type");
    }
  }
  if ([...claudeClients.values()].some((client) => client.project.id === project.id)) {
    throw new ProjectDirectoryImportError("Close this project's Claude conversations before changing its type");
  }
  if ([...piTaskRuns.values()].some((run) => run.projectId === project.id) || [...claudeTaskRuns.values()].some((run) => run.projectId === project.id)) {
    throw new ProjectDirectoryImportError("Wait for this project's task run to finish before changing its workspace");
  }
}

async function relocateProjectWorkspace(project: ProjectRecord, nextWorkspaceId: string): Promise<ProjectRecord> {
  const destination = managedProjectRelocationPath(getSettings().projects.homePath, project.type ?? "personal", project.path, nextWorkspaceId);
  if (!destination || path.resolve(destination) === path.resolve(project.path)) return updateProjectWorkspaceAndPath(project.id, nextWorkspaceId, project.path);
  await assertProjectRelocationIdle(project);
  let moved = false;
  let syncthingAttempted = false;
  try {
    await relocateProjectDirectory(project.path, destination, project.macPath);
    moved = true;
    if (project.syncFolderId) {
      syncthingAttempted = true;
      await ensureSyncthingFolder(project.syncFolderId, project.name, destination);
    }
    const updated = await updateProjectWorkspaceAndPath(project.id, nextWorkspaceId, destination);
    sessionWatcher.ensureProject(updated);
    return updated;
  } catch (error) {
    if (!moved) throw error;
    const rollbackFailures: unknown[] = [];
    try { await relocateProjectDirectory(destination, project.path, project.macPath); }
    catch (rollbackError) { rollbackFailures.push(rollbackError); }
    if (syncthingAttempted && project.syncFolderId) {
      try { await ensureSyncthingFolder(project.syncFolderId, project.name, project.path); }
      catch (rollbackError) { rollbackFailures.push(rollbackError); }
    }
    if (rollbackFailures.length) throw new AggregateError([error, ...rollbackFailures], "Project relocation rollback failed");
    throw error;
  }
}

async function notifyPeersOfProjectInventory(): Promise<void> {
  const [local, peers] = await Promise.all([getClusterNode(), listClusterPeers()]);
  await Promise.all(peers.map(async (peer) => {
    try {
      const response = await fetch(`${peer.url}/api/cluster/projects/import`, {
        method: "POST",
        headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ peerId: local.id }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Peer returned ${response.status}`);
    } catch (error) {
      console.warn(`Project inventory notification to ${peer.id} failed`, error);
    }
  }));
}

const workspaceSchema = z.object({
  id: z.string().trim().max(40).optional(),
  label: z.string().trim().min(1).max(40),
}).strict();

app.get("/api/secrets", async (_request, response, next) => {
  try { response.json({ accounts: await listSecretAccounts() }); } catch (error) { next(error); }
});
app.post("/api/secrets/accounts", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const account = await saveSecretAccount(secretAccountSchema.omit({ id: true }).parse(request.body));
    const syncResults = await replicateSecretAccount(account, session.userId);
    response.status(201).json({ accounts: await listSecretAccounts(), account, ...(syncResults ? { syncResults } : {}) });
  } catch (error) { next(error); }
});
app.put("/api/secrets/accounts/:accountId", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const account = await saveSecretAccount({ ...secretAccountSchema.omit({ id: true }).parse(request.body), id: z.string().uuid().parse(request.params.accountId) });
    const syncResults = await replicateSecretAccount(account, session.userId);
    response.json({ accounts: await listSecretAccounts(), account, ...(syncResults ? { syncResults } : {}) });
  } catch (error) { next(error); }
});
app.delete("/api/secrets/accounts/:accountId", async (request, response, next) => {
  try { await deleteSecretAccount(z.string().uuid().parse(request.params.accountId)); response.json({ accounts: await listSecretAccounts() }); } catch (error) { next(error); }
});
app.get("/api/secrets/scopes/:scopeType/:scopeId", async (request, response, next) => {
  try { const scope = secretScopeParamsSchema.parse(request.params); response.json(await getScopeSecretAccounts(scope.scopeType, scope.scopeId)); } catch (error) { next(error); }
});
app.put("/api/secrets/scopes/:scopeType/:scopeId", async (request, response, next) => {
  try { const scope = secretScopeParamsSchema.parse(request.params); const payload = secretScopeSchema.parse(request.body); await setScopeSecretAccounts(scope.scopeType, scope.scopeId, payload.accountIds); response.json(await getScopeSecretAccounts(scope.scopeType, scope.scopeId)); } catch (error) { next(error); }
});

app.get("/api/workspaces", async (_request, response, next) => {
  try {
    response.json({ workspaces: await listWorkspaces() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/workspaces", async (request, response, next) => {
  try {
    const payload = workspaceSchema.parse(request.body);
    const workspace = await saveWorkspace(payload);
    await ensureManagedHome(getSettings().projects.homePath, (await listWorkspaces()).map((entry) => entry.id));
    response.json({ workspace });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/workspaces/:workspaceId", async (request, response, next) => {
  try {
    await deleteWorkspace(request.params.workspaceId);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

// Replaces POST /api/github-auth/sync: replication is now a per-account opt-in, so a sync
// pushes exactly the accounts the user marked to replicate.
app.post("/api/secrets/sync", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const { peerIds } = secretCredentialSyncSchema.parse(request.body);
    const peers = await listClusterPeers();
    const selected = peerIds.map((peerId) => peers.find((peer) => peer.id === peerId));
    const missing = peerIds.filter((_, index) => !selected[index]);
    if (missing.length) {
      sendError(response, 404, `Unknown node: ${missing.join(", ")}`);
      return;
    }
    await enqueueSecretCredentialSync(peerIds, session.userId);
    const results = await Promise.all((selected as ClusterPeer[]).map(async (peer) => {
      const outcome = await pushSecretCredentialsToPeer(peer);
      return { peerId: peer.id, name: peer.name, delivered: outcome.delivered, ...(outcome.error ? { error: outcome.error } : {}) };
    }));
    response.json({ results });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects", async (request, response, next) => {
  try {
    const query = projectListQuerySchema.parse(request.query);
    response.json({ projects: await projectsWithSharedNames(query.syncStatus === "true") });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:projectId", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    response.json({ project: await projectView(project) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/sync/rescan", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    if (!project.syncFolderId) {
      sendError(response, 409, "Project is not synchronized with Syncthing");
      return;
    }
    await rescanSyncthingFolder(project.syncFolderId);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects", async (request, response, next) => {
  try {
    const payload = projectSchema.parse(request.body);
    const homePath = getSettings().projects.homePath;
    const workspaces = await listWorkspaces();
    if (!workspaces.some((workspace) => workspace.id === payload.type)) {
      throw new WorkspaceError(`Unknown workspace "${payload.type}"`);
    }
    const projectPath = payload.path ?? managedProjectPath(homePath, payload.type, payload.name);
    if (!payload.path) await ensureManagedHome(homePath, workspaces.map((workspace) => workspace.id));
    if (payload.sourcePath) {
      if (!payload.importMode) throw new ProjectDirectoryImportError("Choose how to import the project");
      const projects = await listProjects();
      if (projects.some((project) => path.resolve(project.path) === path.resolve(projectPath))) {
        throw new ProjectDirectoryImportError("Managed project folder is already registered");
      }
      const sourcePath = await mappedPathInsideHome(payload.sourcePath);
      if (projects.some((project) => path.resolve(project.path) === sourcePath)) {
        throw new ProjectDirectoryImportError("Source project folder is already registered");
      }
      await importProjectDirectory(sourcePath, projectPath, payload.importMode);
    }
    const project = await addProject(payload.name, projectPath, {
      synced: payload.synced,
      macPath: payload.macPath ?? payload.sourcePath,
      type: payload.type,
      color: payload.color ?? undefined,
      writeInstructions: !payload.sourcePath,
    });
    if (payload.synced && project.syncFolderId) {
      await ensureSyncthingFolder(project.syncFolderId, project.name, project.path);
    }
    sessionWatcher.ensureProject(project);
    response.status(201).json({ project: await projectView(project) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/projects/:projectId/path-mapping", async (request, response, next) => {
  try {
    const existing = await getProject(request.params.projectId);
    if (!existing) {
      sendError(response, 404, "Project not found");
      return;
    }
    await assertProjectEditable(existing);
    const payload = projectPathMappingSchema.parse(request.body);
    const project = await updateProjectMacPath(existing.id, payload.macPath);
    sessionWatcher.ensureProject(project);
    broadcastToProject(project.id, { type: "sessionsChanged" });
    response.json({ project });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/projects/:projectId", async (request, response, next) => {
  try {
    const existing = await getProject(request.params.projectId);
    if (!existing) {
      sendError(response, 404, "Project not found");
      return;
    }
    await assertProjectEditable(existing);
    const payload = projectUpdateSchema.parse(request.body);
    if (payload.type && !(await listWorkspaces()).some((workspace) => workspace.id === payload.type)) {
      throw new WorkspaceError(`Unknown workspace "${payload.type}"`);
    }
    let project = existing;
    const typeChanged = Boolean(payload.type && payload.type !== existing.type);
    if (typeChanged && payload.type) project = await relocateProjectWorkspace(project, payload.type);
    if (payload.name !== undefined) {
      project = await renameProject(project.id, payload.name);
      await setProjectName(project.id, payload.name);
    }
    const colorChanged = payload.color !== undefined && payload.color !== (existing.color ?? null);
    if (payload.color !== undefined) project = await updateProjectColor(project.id, payload.color);
    if (typeChanged || colorChanged) await notifyPeersOfProjectInventory();
    response.json({ project: await projectView(project) });
  } catch (error) {
    next(error);
  }
});

// Any node may lock or unlock. The lock only stops accidental edits from a second node.
app.put("/api/projects/:projectId/lock", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const payload = projectLockSchema.parse(request.body);
    await setProjectLock(project.id, payload.locked);
    response.json({ project: await projectView(project) });
  } catch (error) {
    next(error);
  }
});

// Rename a conversation. Works for both engines; an empty title clears the override.
app.put("/api/projects/:projectId/sessions/title", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const payload = sessionTitleSchema.parse(request.body);
    // No conversation-list lookup: a conversation named at creation has no
    // transcript on disk yet, and the list is where that name matters most.
    await setSessionTitle(payload.sessionId, payload.title);
    broadcastToProject(project.id, { type: "sessionsChanged" });
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.put("/api/projects/:projectId/sessions/color", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const payload = sessionColorSchema.parse(request.body);
    await setSessionColor(payload.sessionId, payload.color);
    broadcastToProject(project.id, { type: "sessionsChanged" });
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:projectId", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    await assertProjectEditable(project);
    await removeProject(project.id);
    sessionWatcher.removeProject(project.id);
    response.status(204).send();
  } catch (error) {
    if (error instanceof Error && ["Settle task handoffs before deleting project", "Wait for task handoff settlement before deleting project", "Wait for task agents to finish before deleting project"].includes(error.message)) {
      sendError(response, 409, error.message);
      return;
    }
    next(error);
  }
});

app.get("/api/projects/:projectId/session-nodes", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const local = await getClusterNode();
    const peerNodes = await Promise.all((await listClusterPeers()).map(async (peer) => {
      try {
        const inventory = await fetchPeerInventory(peer, 3_000);
        const mapped = inventory.projects.some((entry) => entry.project.id === project.id || entry.aliases?.includes(project.id) || Boolean(project.syncFolderId && entry.project.syncFolderId === project.syncFolderId));
        return { id: peer.id, name: peer.name, local: false, online: true, mapped };
      } catch {
        return { id: peer.id, name: peer.name, local: false, online: false, mapped: false };
      }
    }));
    response.json({ nodes: [{ id: local.id, name: local.name, local: true, online: true, mapped: true }, ...peerNodes] });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:projectId/skills", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    response.json({ skills: await listSkills(project.path) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:projectId/commands", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const harness = z.enum(["pi", "claude"]).parse(request.query.harness);
    response.json({ commands: await listHarnessCommands(project.path, harness) });
  } catch (error) {
    next(error);
  }
});

/**
 * Shared by the per-project conversation list and the cross-project review inbox, so both
 * see the same running detection and the same persisted review watermarks. Running is
 * local runtime state or a live lease replicated from the node executing the turn.
 */
async function listProjectSessionsWithReviewState(project: ProjectRecord, userId: string, username: string): Promise<SessionSummary[]> {
  const tasks = await listTasks(project.id);
  const pinnedSessionPaths = getUserPreferences(userId).pinnedSessionPaths;
  const sessions = await listHarnessSessions({
    ...project,
    additionalPaths: tasks.flatMap((task) => task.worktreePath ? [task.worktreePath] : []),
  }, pinnedSessionPaths);
  const tasksBySessionPath = new Map(tasks.filter((task) => task.sessionPath).map((task) => [task.sessionPath, task]));
  const projectSharedSessions = [...new Set(sharedSessions.values())].filter((shared) => shared.projectId === project.id);
  await Promise.all(projectSharedSessions.map(async (shared) => {
    for (const run of shared.agentRuns.values()) {
      try { run.summary = await refreshAgentRun(run.descriptor); }
      catch (error) { console.warn(`Could not refresh agent run ${run.descriptor.runId}`, error); }
    }
  }));
  const listedSessions = sessions.map((session) => {
    const task = tasksBySessionPath.get(session.path);
    const shared = sharedSessions.get(sessionKey(task ? taskCwd(project, task) : project.path, session.path))
      ?? projectSharedSessions.find((candidate) => candidate.handle.session.sessionId === session.id);
    const config = task?.executionState === "running" ? taskConfig(task, taskPhase(task)) : undefined;
    const agentLabel = config ? (config.engine === "pi" ? "Pi" : "Claude") : session.agentLabel;
    const agentId = config ? config.engine : session.harnessId;
    const livePiModel = (!config || config.engine === "pi") && shared
      ? getSessionStatus(shared.handle.session, shared.handle.safeguardsEnabled).model?.label
      : undefined;
    const agentModel = config?.modelId || livePiModel;
    return {
      ...session,
      agentId,
      agentLabel,
      ...(agentModel ? { agentModel } : {}),
      taskStatus: task?.status,
      taskId: task?.id,
      agentRuns: shared ? [...shared.agentRuns.values()].map((run) => run.summary).sort((left, right) => left.runId.localeCompare(right.runId)) : undefined,
      running: Boolean(
        shared?.handle.session.isStreaming
        || (shared?.turnInFlight ?? 0) > 0
        || [...(shared?.agentRuns.values() ?? [])].some((run) => run.summary.status === "running")
        || task?.executionState === "running"
        || runningClaudeSessionPaths.has(claudeRunKey(project.id, session.path))
        || (session.harnessId === "claude" && isClaudeSessionRunning(session.path))
        || conversationLeaseRunning(session.harnessId, session.id)
      ),
      engine: session.harnessId,
      sessionId: session.id,
    };
  });
  const reviewStates = syncConversationReviewStates(userId, username, project.id, listedSessions);
  const ownership = await Promise.all(listedSessions.map((session) => getConversationOwnership(session.path.startsWith("claude:") || session.path.startsWith("draft:claude:") ? "claude" : "pi", session.id)));
  return listedSessions.map((session, index) => {
    const { engine: _engine, sessionId: _sessionId, ...summary } = session;
    return { ...summary, reviewState: reviewStates.get(session.path), executionNodeId: ownership[index]?.ownerNodeId };
  });
}

app.get("/api/projects/:projectId/sessions", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    await touchProject(project.id);
    const authSession = response.locals.authSession as AuthSession;
    response.json({ sessions: await listProjectSessionsWithReviewState(project, authSession.userId, authSession.username) });
  } catch (error) {
    next(error);
  }
});

function ownershipEvent(record: ConversationOwnership, originNodeId: string) {
  return {
    id: randomUUID(), originNodeId, entityType: "conversation.ownership", entityKey: `${record.engine}:${record.sessionId}`,
    operation: "upsert", payload: { ...record, originNodeId }, createdAt: new Date().toISOString(),
  };
}

class OwnershipAcknowledgementError extends Error {}

async function applyOwnershipToPeer(peer: ClusterPeer, record: ConversationOwnership, originNodeId: string): Promise<OwnershipApplyResult> {
  const token = await getClusterMachineToken();
  const response = await fetch(`${peer.url}/api/cluster/sessions/ownership/apply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ record, originNodeId }), signal: AbortSignal.timeout(3_000),
  });
  const result = await response.json() as OwnershipApplyResult & { error?: string };
  if (!response.ok) throw new OwnershipAcknowledgementError(result.error || `Ownership acknowledgement failed from ${peer.name}`);
  return result;
}

async function ownershipFromPeer(peer: ClusterPeer, engine: ConversationEngine, sessionId: string): Promise<ConversationOwnership | null> {
  const url = new URL("/api/cluster/sessions/ownership", peer.url);
  url.searchParams.set("engine", engine);
  url.searchParams.set("sessionId", sessionId);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${peer.token}` }, signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Ownership read failed from ${peer.name}`);
  return (await response.json() as { ownership: ConversationOwnership | null }).ownership;
}

async function claimCasOnPeer(peer: ClusterPeer, expected: ConversationOwnership | null, proposed: ConversationOwnership, originNodeId: string): Promise<OwnershipApplyResult> {
  const response = await fetch(`${peer.url}/api/cluster/sessions/ownership/claim/cas`, {
    method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expected, proposed, originNodeId }), signal: AbortSignal.timeout(3_000),
  });
  const result = await response.json() as OwnershipApplyResult & { error?: string };
  if (!response.ok) throw new Error(result.error || `Ownership compare-and-set failed on ${peer.name}`);
  return result;
}

function assertClaimAccepted(results: OwnershipApplyResult[], proposed: ConversationOwnership): void {
  const rejected = results.find((result) => !result.accepted || !sameConversationOwnership(result.current ?? undefined, proposed));
  if (rejected) throw new Error(`Ownership claim rejected; current state: ${JSON.stringify(rejected.current)}`);
}

async function finalizeClaimOnOwner(ownerNodeId: string, peers: ClusterPeer[], proposed: ConversationOwnership): Promise<ConversationOwnership> {
  const local = await getClusterNode();
  if (ownerNodeId === local.id) return finalizeConversationClaim(proposed, ownerNodeId);
  const peer = peers.find((candidate) => candidate.id === ownerNodeId);
  if (!peer) throw new Error("Ownership claimant left the captured membership");
  const response = await fetch(`${peer.url}/api/cluster/sessions/ownership/claim/commit`, {
    method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ proposed }), signal: AbortSignal.timeout(3_000),
  });
  const result = await response.json() as { ownership?: ConversationOwnership; error?: string };
  if (!response.ok || !result.ownership) throw new Error(result.error || "Ownership claim commit failed");
  return result.ownership;
}

function claimStateMatches(record: ConversationOwnership | null, proposed: ConversationOwnership): boolean {
  if (!record) return true;
  if (sameConversationOwnership(record, proposed)) return true;
  return record.status === "owned" && sameConversationOwnership(record, { ...proposed, status: "owned" });
}

async function commitPreparedClaim(localId: string, peers: ClusterPeer[], proposed: ConversationOwnership): Promise<ConversationOwnership> {
  const owned = { ...proposed, status: "owned" as const };
  const nonOwnerResults: OwnershipApplyResult[] = [];
  if (localId !== proposed.ownerNodeId) nonOwnerResults.push(await compareAndSetConversationOwnership(proposed, owned, proposed.ownerNodeId));
  const remoteResults = await Promise.all(peers.filter((peer) => peer.id !== proposed.ownerNodeId)
    .map((peer) => claimCasOnPeer(peer, proposed, owned, proposed.ownerNodeId)));
  assertClaimAccepted([...nonOwnerResults, ...remoteResults], owned);
  return finalizeClaimOnOwner(proposed.ownerNodeId, peers, proposed);
}

async function coordinateOwnershipClaim(engine: ConversationEngine, sessionId: string, ownerNodeId: string): Promise<ConversationOwnership> {
  const local = await getClusterNode();
  const peers = await listClusterPeers();
  const memberIds = [local.id, ...peers.map((peer) => peer.id)].sort();
  if (memberIds[0] !== local.id) throw new Error("Ownership claim reached a non-coordinator node");
  if (!memberIds.includes(ownerNodeId)) throw new Error("Ownership claimant is not a captured cluster member");
  const currents = await Promise.all([getConversationOwnership(engine, sessionId).then((value) => value ?? null), ...peers.map((peer) => ownershipFromPeer(peer, engine, sessionId))]);
  const retry = currents.find((record) => record?.status === "claiming" || record?.status === "owned");
  const proposed = retry ? { ...retry, status: "claiming" as const } : { engine, sessionId, ownerNodeId, epoch: 1, status: "claiming" as const, transferToNodeId: null };
  if (proposed.ownerNodeId !== ownerNodeId) throw new ConversationOwnershipError(retry!);
  if (currents.some((record) => !claimStateMatches(record, proposed))) throw new Error("Ownership claim states differ across captured members");
  if (currents.every((record) => record?.status === "owned")) return { ...proposed, status: "owned" };
  const localPrepare = currents[0]?.status === "owned"
    ? Promise.resolve({ accepted: true, current: proposed })
    : compareAndSetConversationOwnership(currents[0] ?? undefined, proposed, local.id);
  const remotePrepare = peers.map((peer, index) => currents[index + 1]?.status === "owned"
    ? Promise.resolve({ accepted: true, current: proposed })
    : claimCasOnPeer(peer, currents[index + 1], proposed, local.id));
  const prepareResults = await Promise.all([localPrepare, ...remotePrepare]);
  assertClaimAccepted(prepareResults, proposed);
  return commitPreparedClaim(local.id, peers, proposed);
}

async function claimConversationAcrossCluster(engine: ConversationEngine, sessionId: string, localNodeId: string): Promise<ConversationOwnership> {
  const current = await getConversationOwnership(engine, sessionId);
  if (current?.ownerNodeId === localNodeId && current.status === "owned") return current;
  if (current && current.status !== "claiming") throw new ConversationOwnershipError(current);
  const peers = await listClusterPeers();
  const coordinatorId = [localNodeId, ...peers.map((peer) => peer.id)].sort()[0];
  if (coordinatorId === localNodeId) return coordinateOwnershipClaim(engine, sessionId, localNodeId);
  const coordinator = peers.find((peer) => peer.id === coordinatorId)!;
  const response = await fetch(`${coordinator.url}/api/cluster/sessions/ownership/claim`, {
    method: "POST", headers: { Authorization: `Bearer ${coordinator.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ engine, sessionId, ownerNodeId: localNodeId }), signal: AbortSignal.timeout(5_000),
  });
  const result = await response.json() as { ownership?: ConversationOwnership; error?: string };
  if (!response.ok || !result.ownership || result.ownership.status !== "owned") throw new Error(result.error || "Ownership claim failed");
  return result.ownership;
}

async function assertLocalConversationOwner(engine: ConversationEngine, sessionId: string): Promise<void> {
  const local = await getClusterNode();
  const ownership = await getConversationOwnership(engine, sessionId);
  if (!ownership) throw new Error("Conversation ownership is not established");
  if (ownership.ownerNodeId !== local.id || ownership.status !== "owned") throw new ConversationOwnershipError(ownership);
}

interface ForeignConversationOwner { nodeId: string; nodeName: string; status: ConversationOwnershipStatus }

// The browser locks its composer on this, so a conversation owned elsewhere is
// reported by name instead of letting the user type a prompt that node rejects.
async function describeConversationOwner(ownership: ConversationOwnership, localId: string): Promise<ForeignConversationOwner | null> {
  if (ownership.ownerNodeId === localId) return null;
  const peer = await getClusterPeer(ownership.ownerNodeId);
  return { nodeId: ownership.ownerNodeId, nodeName: peer?.name ?? "another node", status: ownership.status };
}

async function foreignConversationOwner(engine: ConversationEngine, sessionId: string, localId: string): Promise<ForeignConversationOwner | null> {
  const ownership = await getConversationOwnership(engine, sessionId);
  return ownership ? describeConversationOwner(ownership, localId) : null;
}

// Opening a conversation is what establishes its owner. Claiming only on the
// first prompt left every unprompted conversation ownerless, so a second node
// had nothing to report and its composer stayed open.
async function openConversationOwnership(engine: ConversationEngine, sessionId: string, localId: string): Promise<ForeignConversationOwner | null> {
  const foreign = await foreignConversationOwner(engine, sessionId, localId);
  if (foreign) return foreign;
  if (await getConversationOwnership(engine, sessionId)) return null;
  try {
    await claimConversationAcrossCluster(engine, sessionId, localId);
    return null;
  } catch (error) {
    if (!(error instanceof ConversationOwnershipError)) throw error;
    return describeConversationOwner(error.ownership, localId);
  }
}

async function requireLocalConversationOwner(engine: ConversationEngine, sessionId: string): Promise<void> {
  const local = await getClusterNode();
  if (!await getConversationOwnership(engine, sessionId)) await claimConversationAcrossCluster(engine, sessionId, local.id);
  await assertLocalConversationOwner(engine, sessionId);
}

app.get("/api/cluster/sessions/ownership", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const engine = z.enum(["pi", "claude"]).parse(request.query.engine);
    const sessionId = z.string().min(1).max(240).parse(request.query.sessionId);
    response.json({ ownership: await getConversationOwnership(engine, sessionId) ?? null });
  } catch (error) { next(error); }
});

app.post("/api/cluster/sessions/ownership/claim", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = ownershipClaimSchema.parse(request.body);
    response.json({ ownership: await coordinateOwnershipClaim(payload.engine, payload.sessionId, payload.ownerNodeId) });
  } catch (error) { next(error); }
});

app.post("/api/cluster/sessions/ownership/claim/cas", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = ownershipCasSchema.parse(request.body);
    response.json(await compareAndSetConversationOwnership(payload.expected ?? undefined, payload.proposed, payload.originNodeId));
  } catch (error) { next(error); }
});

app.post("/api/cluster/sessions/ownership/claim/commit", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const { proposed } = z.object({ proposed: ownershipSchema }).parse(request.body);
    const local = await getClusterNode();
    response.json({ ownership: await finalizeConversationClaim(proposed, local.id) });
  } catch (error) { next(error); }
});

app.post("/api/cluster/sessions/ownership/apply", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = z.object({ record: ownershipSchema, originNodeId: z.string().uuid() }).parse(request.body);
    const originNodeId = response.locals.machineNodeId as string;
    if (payload.originNodeId !== originNodeId) { sendError(response, 403, "Ownership origin does not match authenticated peer"); return; }
    await receiveReplicationBatch({ events: [ownershipEvent(payload.record, originNodeId)] });
    const current = await getConversationOwnership(payload.record.engine, payload.record.sessionId) ?? null;
    response.json({ accepted: sameConversationOwnership(current ?? undefined, payload.record), current });
  } catch (error) { next(error); }
});

function conversationIsActive(projectId: string, engine: ConversationEngine, sessionId: string, sessionPath: string): boolean {
  if (engine === "claude") return Boolean(activeClaudeConnections.get(claudeConnectionKey(projectId, sessionId))?.claude.child);
  const active = [...new Set(sharedSessions.values())].find((session) => session.projectId === projectId && session.handle.session.sessionFile === sessionPath);
  return Boolean(active?.handle.session.isStreaming);
}

function conversationSessionIsOpen(projectId: string, engine: ConversationEngine, sessionId: string, sessionPath: string): boolean {
  if (engine === "claude") return activeClaudeConnections.has(claudeConnectionKey(projectId, sessionId));
  return [...new Set(sharedSessions.values())].some((session) => session.projectId === projectId && session.handle.session.sessionFile === sessionPath);
}

async function replicateExactOwnership(peers: ClusterPeer[], record: ConversationOwnership, originNodeId: string): Promise<void> {
  const results = await Promise.all(peers.map((peer) => applyOwnershipToPeer(peer, record, originNodeId)));
  const rejected = results.find((result) => !result.accepted || !sameConversationOwnership(result.current ?? undefined, record));
  if (rejected) throw new Error(`Peer rejected ownership state: ${JSON.stringify(rejected.current)}`);
}

async function takeLocalSessionOwnership(project: ProjectRecord, payload: z.infer<typeof routedSessionTakeOwnershipSchema>): Promise<{ sessionPath: string; ownership: ConversationOwnership; pendingPeerIds: string[] }> {
  const [local, sessions, peers] = await Promise.all([getClusterNode(), listHarnessSessions(project), listClusterPeers()]);
  if (payload.peerId !== local.id) throw new Error("Takeover destination is not this node");
  const matching = payload.sessionId ? sessions.find((session) => session.id === payload.sessionId) : sessions.find((session) => session.path === payload.sessionPath);
  if (!matching) throw new TaskWorktreeError("Conversation was not found on the destination node");
  if (matching.draft) throw new TaskWorktreeError("Wait for the conversation transcript to synchronize to this node before taking ownership");
  const engine: ConversationEngine = matching.path.startsWith("claude:") ? "claude" : "pi";
  const sessionId = matching.id;
  if (conversationIsActive(project.id, engine, sessionId, matching.path)) throw new TaskWorktreeError("Wait for the current turn to finish before taking ownership");
  const ownership = await takeConversationOwnership(engine, sessionId, local.id);
  const settled = await Promise.allSettled(peers.map((peer) => applyOwnershipToPeer(peer, ownership, local.id)));
  const pendingPeerIds: string[] = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === "rejected") {
      const error = result.reason;
      if (error instanceof TypeError || error instanceof DOMException && error.name === "TimeoutError") { pendingPeerIds.push(peers[index].id); continue; }
      throw error;
    }
    if (!result.value.accepted || !sameConversationOwnership(result.value.current ?? undefined, ownership)) {
      throw new Error(`Peer rejected ownership state: ${JSON.stringify(result.value.current)}`);
    }
  }
  return { sessionPath: matching.path, ownership, pendingPeerIds };
}

app.put("/api/projects/:projectId/sessions/reviewed", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const submitted = sessionReviewedSchema.parse(request.body);
    const tasks = await listTasks(project.id);
    const sessions = await listHarnessSessions({
      ...project,
      additionalPaths: tasks.flatMap((task) => task.worktreePath ? [task.worktreePath] : []),
    });
    const session = sessions.find((candidate) => candidate.path === submitted.sessionPath);
    if (!session) { sendError(response, 404, "Conversation not found"); return; }
    if (!session.updatedAt || submitted.updatedAt > session.updatedAt) { sendError(response, 409, "Conversation review watermark is newer than current activity"); return; }
    const authSession = response.locals.authSession as AuthSession;
    const local = await getClusterNode();
    markConversationReviewed(authSession.userId, authSession.username, project.id, { path: session.path, engine: session.harnessId, sessionId: session.id, updatedAt: submitted.updatedAt }, local.id);
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.put("/api/projects/:projectId/sessions/reviewed-all", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const { sessions: submitted } = sessionsReviewedSchema.parse(request.body);
    const tasks = await listTasks(project.id);
    const sessions = await listHarnessSessions({
      ...project,
      additionalPaths: tasks.flatMap((task) => task.worktreePath ? [task.worktreePath] : []),
    });
    const currentByPath = new Map(sessions.map((session) => [session.path, session]));
    const invalid = submitted.find((watermark) => {
      const current = currentByPath.get(watermark.sessionPath);
      return !current || !current.updatedAt || watermark.updatedAt > current.updatedAt;
    });
    if (invalid) { sendError(response, 409, `Conversation review watermark is stale or missing: ${invalid.sessionPath}`); return; }
    const authSession = response.locals.authSession as AuthSession;
    const local = await getClusterNode();
    markConversationsReviewed(authSession.userId, authSession.username, project.id, submitted.flatMap((watermark) => {
      const current = currentByPath.get(watermark.sessionPath)!;
      return [{ path: watermark.sessionPath, engine: current.harnessId, sessionId: current.id, updatedAt: watermark.updatedAt }];
    }), local.id);
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

/**
 * The review inbox spans every project, so it scans them all. Sessions without an `updatedAt`
 * carry no watermark and could never be marked reviewed, so they are left out.
 */
app.get("/api/reviews/pending", async (_request, response, next) => {
  try {
    const authSession = response.locals.authSession as AuthSession;
    const projects = await projectsWithSharedNames(false);
    const groups = await Promise.all(projects.map(async (project) => {
      const sessions = await listProjectSessionsWithReviewState(project, authSession.userId, authSession.username);
      return {
        projectId: project.id,
        projectName: project.name,
        sessions: sessions
          .filter((session) => session.reviewState === "needs_review" && !session.running && session.updatedAt)
          .map((session) => ({
            id: session.id,
            path: session.path,
            title: session.title,
            agentId: session.agentId,
            agentLabel: session.agentLabel,
            updatedAt: session.updatedAt,
          })),
      };
    }));
    response.json({ projects: groups.filter((group) => group.sessions.length > 0) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/sessions/take-ownership", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = routedSessionTakeOwnershipSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    response.json(await takeLocalSessionOwnership(project, payload));
  } catch (error) {
    if (error instanceof TaskWorktreeError) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

app.post("/api/projects/:projectId/sessions/take-ownership", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const payload = sessionTakeOwnershipSchema.parse(request.body);
    const local = await getClusterNode();
    if (payload.peerId === local.id) { response.json(await takeLocalSessionOwnership(project, { ...payload, projectId: project.id })); return; }
    const peer = await getClusterPeer(payload.peerId);
    if (!peer) { sendError(response, 404, "Peer not found"); return; }
    const routed = await fetch(`${peer.url}/api/cluster/sessions/take-ownership`, {
      method: "POST", headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, projectId: project.id }), signal: AbortSignal.timeout(35_000),
    });
    response.status(routed.status).json(await routed.json());
  } catch (error) { next(error); }
});

app.post("/api/projects/:projectId/sessions/recover", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const payload = sessionRecoverySchema.parse(request.body);
    const local = await getClusterNode();
    const mapped = resolveLocalSessionPath(payload.sessionPath);
    if (mapped.engine !== "pi") throw new Error("Only Pi transcripts support conflict recovery");
    if (conversationSessionIsOpen(project.id, "pi", payload.sessionId, mapped.path)) throw new Error("Close the local conversation before recovery");
    await requireLocalConversationOwner("pi", payload.sessionId);
    const peers = await listClusterPeers();
    const fenced = await beginConversationRecovery("pi", payload.sessionId, local.id);
    await replicateExactOwnership(peers, fenced, local.id);
    if (conversationSessionIsOpen(project.id, "pi", payload.sessionId, mapped.path)) throw new Error("Conversation opened during recovery fencing");
    const snapshot = await capturePiRecoverySnapshot(mapped.path);
    const names = await readdir(path.dirname(mapped.path));
    await recoverPiSessionDirectory(path.dirname(mapped.path), names, snapshot, project.path);
    const owned = await finishConversationRecovery("pi", payload.sessionId, local.id);
    await replicateExactOwnership(peers, owned, local.id);
    response.json({ ownership: owned, sessionPath: mapped.path });
  } catch (error) { next(error); }
});

class ConversationDeleteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function deleteLocalConversation(project: ProjectRecord, engine: ConversationEngine, sessionId: string): Promise<void> {
  await assertProjectEditable(project);
  const tasks = await listTasks(project.id);
  const sessions = await listHarnessSessions({ ...project, additionalPaths: tasks.flatMap((task) => task.worktreePath ? [task.worktreePath] : []) });
  const session = sessions.find((candidate) => candidate.id === sessionId && (candidate.path.startsWith("draft:claude:") || candidate.path.startsWith("claude:") ? "claude" : "pi") === engine);
  if (!session) throw new ConversationDeleteError(404, "Session not found");
  await requireLocalConversationOwner(engine, sessionId);
  const local = await getClusterNode();
  if (session.draft) {
    await deleteConversationRecord(project.id, engine, sessionId, local.id);
  } else {
    const filePath = session.path.startsWith("claude:") ? session.path.slice("claude:".length) : session.path;
    try {
      const fileStats = await lstat(filePath);
      if (!fileStats.isFile() || fileStats.isSymbolicLink()) throw new ConversationDeleteError(400, "Session path is not a regular file");
      await unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ConversationDeleteError(404, "Session not found");
      throw error;
    }
    await deleteConversationRecord(project.id, engine, sessionId, local.id);
  }
  broadcastToProject(project.id, { type: "sessionsChanged" });
}

app.delete("/api/projects/:projectId/sessions", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const payload = sessionDeleteSchema.parse({ projectId: project.id, engine: request.query.engine, sessionId: request.query.sessionId });
    const local = await getClusterNode();
    const ownership = await getConversationOwnership(payload.engine, payload.sessionId);
    if (ownership && ownership.ownerNodeId !== local.id) {
      const peer = await getClusterPeer(ownership.ownerNodeId);
      if (!peer) throw new ConversationDeleteError(409, "Conversation owner is unavailable");
      const routed = await fetch(`${peer.url}/api/cluster/sessions/delete`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000),
      });
      if (routed.status === 204) { response.status(204).send(); return; }
      const body = await routed.json().catch(() => null) as { error?: unknown } | null;
      sendError(response, routed.status, typeof body?.error === "string" ? body.error : "Conversation owner delete failed");
      return;
    }
    await deleteLocalConversation(project, payload.engine, payload.sessionId);
    response.status(204).send();
  } catch (error) {
    if (error instanceof ConversationDeleteError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.delete("/api/cluster/sessions/delete", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = sessionDeleteSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await deleteLocalConversation(project, payload.engine, payload.sessionId);
    response.status(204).send();
  } catch (error) {
    if (error instanceof ConversationDeleteError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.get("/api/projects/:projectId/tasks", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    response.json({ tasks: await listTasks(project.id) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:projectId/tasks/:taskId/eligibility", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === request.params.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    const nodes = [] as Array<{ node: { id: string; name: string; local?: boolean; online: boolean }; eligible: boolean; reasons: string[] }>;
    if (task.currentNodeId !== local.id) {
      const reasons = await taskHandoffEligibility(project.id, task);
      nodes.push({ node: { id: local.id, name: local.name, local: true, online: true }, eligible: reasons.length === 0, reasons });
    }
    const peerNodes = await Promise.all((await listClusterPeers()).filter((peer) => peer.id !== task.currentNodeId).map(async (peer) => {
      const node = publicClusterPeer(peer);
      try {
        const remote = await fetch(`${peer.url}/api/cluster/tasks/eligibility`, {
          method: "POST",
          headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: project.id, task }),
          signal: AbortSignal.timeout(3_000),
        });
        if (!remote.ok) throw new Error(`Peer returned ${remote.status}`);
        const result = z.object({ eligible: z.boolean(), reasons: z.array(z.string()) }).parse(await remote.json());
        await markClusterPeerSeen(peer.id);
        return { node: { ...node, online: true }, ...result };
      } catch (error) {
        return { node: { ...node, online: false }, eligible: false, reasons: [error instanceof Error ? `Peer unreachable: ${error.message}` : "Peer unreachable"] };
      }
    }));
    response.json({ nodes: [...nodes, ...peerNodes] });
  } catch (error) { next(error); }
});

app.post("/api/projects/:projectId/tasks", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    await assertProjectEditable(project);
    const payload = taskCreateSchema.parse(request.body);
    await ensureTicketWorkspaceFolder();
    const engine = payload.engine ?? "pi";
    const planMode = payload.planMode === true;
    if (payload.status === "planning" && !planMode) {
      sendError(response, 400, "Planning status requires plan mode");
      return;
    }
    const task = await createTask(project.id, project.path, payload.title, payload.description, payload.status ?? "backlog", engine, planMode, payload.reviewMode === true, payload.phaseConfig ?? {});
    if (task.status === "planning" || task.status === "in_progress" || (task.status === "review" && task.reviewMode)) {
      startTaskRun(project, task).catch((error) => console.warn("Task start failed", error));
    }
    broadcastToProject(project.id, { type: "tasksChanged" });
    response.status(201).json({ task });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/projects/:projectId/tasks/:taskId", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await assertProjectEditable(project);
    const payload = taskUpdateSchema.parse(request.body);
    const existing = (await listTasks(project.id)).find((task) => task.id === request.params.taskId);
    if (!existing) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    const peer = await ownerPeer(existing, local.id);
    if (peer) {
      const routed = await fetch(`${peer.url}/api/cluster/tasks/update`, { method: "PATCH", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, taskId: existing.id, update: payload }), signal: AbortSignal.timeout(30_000) });
      await mirrorTaskResponse(response, routed);
      return;
    }
    if (existing.currentNodeId !== local.id) { sendError(response, 409, "Task owner is unavailable"); return; }
    assertTaskNotHandoffPending(existing);
    if (payload.status === "planning" && !(payload.planMode ?? existing.planMode)) { sendError(response, 400, "Planning status requires plan mode"); return; }
    const task = await updateTask(project.id, existing.id, payload);
    const active = payload.status !== undefined && payload.status !== existing.status && (payload.status === "planning" || payload.status === "in_progress" || (payload.status === "review" && task.reviewMode));
    if (active && !taskRunActive(task.id)) startTaskRun(project, task).catch((error) => console.warn("Task start failed", error));
    broadcastToProject(project.id, { type: "tasksChanged" });
    response.json({ task });
  } catch (error) { next(error); }
});

app.post("/api/projects/:projectId/tasks/:taskId/handoff", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await assertProjectEditable(project);
    const payload = taskHandoffSchema.parse(request.body);
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === request.params.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    const peer = await ownerPeer(task, local.id);
    if (peer) {
      const routed = await fetch(`${peer.url}/api/cluster/tasks/handoff`, { method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, taskId: task.id, peerId: payload.peerId }), signal: AbortSignal.timeout(30_000) });
      await mirrorTaskResponse(response, routed);
      return;
    }
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task owner is unavailable"); return; }
    const result = await handoffOwnedTask(project, task, payload.peerId);
    response.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof TaskWorktreeError || (error instanceof Error && error.message === "Wait for incoming task handoff settlement before handing off again")) { sendError(response, 409, error.message); return; }
    if (error instanceof Error && error.message === "Peer not found") { sendError(response, 404, error.message); return; }
    next(error);
  }
});

app.post("/api/projects/:projectId/tasks/:taskId/archive", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await assertProjectEditable(project);
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === request.params.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    const peer = await ownerPeer(task, local.id);
    if (peer) {
      const routed = await fetch(`${peer.url}/api/cluster/tasks/archive`, { method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, taskId: task.id }), signal: AbortSignal.timeout(30_000) });
      await mirrorTaskResponse(response, routed);
      return;
    }
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task owner is unavailable"); return; }
    response.json({ task: await archiveOwnedTask(project, task) });
  } catch (error) {
    if (error instanceof TaskWorkspaceError || (error instanceof Error && error.message === "Wait for task agent to finish before deleting")) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

app.post("/api/projects/:projectId/tasks/:taskId/merge", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await assertProjectEditable(project);
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === request.params.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    const peer = await ownerPeer(task, local.id);
    if (peer) {
      const routed = await fetch(`${peer.url}/api/cluster/tasks/merge`, { method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, taskId: task.id }), signal: AbortSignal.timeout(30_000) });
      await mirrorTaskResponse(response, routed);
      return;
    }
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task owner is unavailable"); return; }
    response.json({ task: await mergeOwnedTask(project, task) });
  } catch (error) {
    if (error instanceof TaskWorktreeError) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

app.delete("/api/projects/:projectId/tasks/:taskId", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await assertProjectEditable(project);
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === request.params.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    const peer = await ownerPeer(task, local.id);
    if (peer) {
      const routed = await fetch(`${peer.url}/api/cluster/tasks/delete`, { method: "DELETE", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, taskId: task.id }), signal: AbortSignal.timeout(30_000) });
      await mirrorTaskResponse(response, routed);
      return;
    }
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task owner is unavailable"); return; }
    await deleteOwnedTask(project, task);
    response.status(204).send();
  } catch (error) {
    if (error instanceof TaskWorkspaceError || (error instanceof Error && error.message === "Wait for task agent to finish before deleting")) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

class ProjectFileError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

interface ProjectFileResolution {
  path: string;
  viewUrl: string;
  downloadUrl: string;
  contentUrl: string;
}

function projectPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function portablePathParts(value: string): string[] {
  return value.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
}

function matchingPathSuffix(candidateParts: string[], requestedParts: string[]): number {
  let matched = 0;
  while (matched < candidateParts.length && matched < requestedParts.length && candidateParts[candidateParts.length - matched - 1] === requestedParts[requestedParts.length - matched - 1]) matched += 1;
  return matched;
}

async function verifiedProjectFile(projectRoot: string, candidate: string): Promise<{ resolved: string; info: Awaited<ReturnType<typeof stat>> } | null> {
  let resolved: string;
  try { resolved = await realpath(candidate); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
  if (!projectPathInside(projectRoot, resolved)) throw new ProjectFileError(403, "File is outside the project directory");
  const info = await stat(resolved);
  if (!info.isFile()) throw new ProjectFileError(400, "Path is not a file");
  return { resolved, info };
}

async function searchProjectFile(projectRoot: string, requestedPath: string): Promise<{ resolved: string; relativePath: string; info: Awaited<ReturnType<typeof stat>> }> {
  const requestedParts = portablePathParts(requestedPath);
  const basename = requestedParts.at(-1);
  const entries = await readdir(projectRoot, { recursive: true, withFileTypes: true });
  const matches: Array<{ resolved: string; relativePath: string; info: Awaited<ReturnType<typeof stat>>; score: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name !== basename) continue;
    const candidate = path.join(entry.parentPath, entry.name);
    const verified = await verifiedProjectFile(projectRoot, candidate);
    if (!verified) continue;
    const relativePath = path.relative(projectRoot, verified.resolved).split(path.sep).join("/");
    matches.push({ ...verified, relativePath, score: matchingPathSuffix(portablePathParts(relativePath), requestedParts) });
  }
  if (!matches.length) throw new ProjectFileError(404, "File not found");
  const score = Math.max(...matches.map((match) => match.score));
  const best = matches.filter((match) => match.score === score).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (best.length > 1) throw new ProjectFileError(409, `File reference is ambiguous: ${best.slice(0, 5).map((match) => match.relativePath).join(", ")}`);
  return best[0];
}

async function resolveProjectFile(projectId: string, requestedPath: string): Promise<{ project: ProjectRecord; resolved: string; relativePath: string; info: Awaited<ReturnType<typeof stat>> }> {
  const project = await getProject(projectId);
  if (!project) throw new ProjectFileError(404, "Project not found");
  const pathValue = requestedPath.trim();
  if (!pathValue) throw new ProjectFileError(400, "File path is required");
  if (pathValue.length > 2000) throw new ProjectFileError(400, "File path is too long");
  if (portablePathParts(pathValue).includes("..")) throw new ProjectFileError(403, "File is outside the project directory");
  const projectRoot = await realpath(project.path);
  const directPath = pathValue.replace(/\\/g, path.sep);
  const candidate = path.isAbsolute(directPath) ? path.resolve(directPath) : path.resolve(projectRoot, directPath);
  const direct = path.isAbsolute(directPath) && !projectPathInside(projectRoot, candidate)
    ? null
    : await verifiedProjectFile(projectRoot, candidate);
  if (direct) {
    const relativePath = path.relative(projectRoot, direct.resolved).split(path.sep).join("/");
    return { project, resolved: direct.resolved, relativePath, info: direct.info };
  }
  const match = await searchProjectFile(projectRoot, pathValue);
  return { project, resolved: match.resolved, relativePath: match.relativePath, info: match.info };
}

async function projectFileResolution(projectId: string, requestedPath: string): Promise<{ path: string }> {
  return { path: (await resolveProjectFile(projectId, requestedPath)).relativePath };
}

function projectFileLinks(projectId: string, relativePath: string, nodeId?: string): ProjectFileResolution {
  const makeUrl = (route: string, download = false): string => {
    const url = new URL(`/api/projects/${encodeURIComponent(projectId)}/${route}`, "http://joint-bob.local");
    url.searchParams.set("path", relativePath);
    if (nodeId) url.searchParams.set("nodeId", nodeId);
    if (download) url.searchParams.set("download", "1");
    return `${url.pathname}${url.search}`;
  };
  return { path: relativePath, viewUrl: makeUrl("file"), downloadUrl: makeUrl("file", true), contentUrl: makeUrl("file-content") };
}

function fileVersion(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

/** The file's text, or null when it is not UTF-8 text and can only be handed over raw. */
function readableText(bytes: Buffer): string | null {
  try { return textFile(bytes); } catch { return null; }
}

function textFile(bytes: Buffer): string {
  if (bytes.includes(0)) throw new ProjectFileError(415, "File is not valid UTF-8 text");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ProjectFileError(415, "File is not valid UTF-8 text"); }
}

// Browsers refuse to render a response whose Content-Type is wrong because every response
// carries `X-Content-Type-Options: nosniff`, so a bad guess shows an empty page. Extension
// lookup is no help for source code: `.ts` maps to video/mp2t and `.py` maps to nothing at
// all. Only the types a browser genuinely displays keep their own type; everything else is
// served as plain text so the View link shows the file.
const INLINE_PROJECT_FILE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};

function projectFileContentType(resolved: string): string {
  return INLINE_PROJECT_FILE_TYPES[path.extname(resolved).toLowerCase()] ?? "text/plain; charset=utf-8";
}

// A text file served as text/plain is browser-default black-on-white with none of the
// app's typography or theme, and markdown is additionally a wall of raw syntax. The View
// link instead serves a page that renders the file with the same renderer the chat uses:
// markdown as prose, anything else as a highlighted code block. `script-src 'self'`
// forbids an inline script, so the source travels inside a hidden <pre> and
// /file-view.js renders it.
const MARKDOWN_FILE_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd", ".mkdn"]);

// The language label a rendered code block carries. An extension that is not listed
// still renders as a code block, just without a language name.
const VIEW_LANGUAGES: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx", ".mjs": "javascript",
  ".cjs": "javascript", ".json": "json", ".py": "python", ".rb": "ruby", ".go": "go",
  ".rs": "rust", ".java": "java", ".kt": "kotlin", ".swift": "swift", ".c": "c", ".h": "c",
  ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp", ".php": "php", ".sh": "bash", ".bash": "bash",
  ".zsh": "bash", ".fish": "fish", ".sql": "sql", ".html": "html", ".css": "css",
  ".scss": "scss", ".yml": "yaml", ".yaml": "yaml", ".toml": "toml", ".ini": "ini",
  ".xml": "xml", ".tf": "terraform", ".lua": "lua", ".pl": "perl", ".r": "r",
  ".dockerfile": "dockerfile", ".gradle": "gradle", ".makefile": "makefile",
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The page renders "markdown" as prose and every other language as a code block. An
 * unrecognised extension is still a code block, just without a language name. */
function fileViewLanguage(resolved: string): string {
  const extension = path.extname(resolved).toLowerCase();
  if (MARKDOWN_FILE_EXTENSIONS.has(extension)) return "markdown";
  return VIEW_LANGUAGES[extension] ?? VIEW_LANGUAGES[`.${path.basename(resolved).toLowerCase()}`] ?? "";
}

function fileViewPage(fileName: string, language: string, source: string): string {
  const title = escapeHtml(fileName);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>${title}</title>
    <meta name="theme-color" content="#f2f2f0" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <script src="/boot.js"></script>
    <link rel="stylesheet" href="/styles.css" />
    <script type="module" src="/file-view.js"></script>
  </head>
  <body class="file-view">
    <main class="file-view-page">
      <p class="file-view-path" data-testid="file-view-path">${title}</p>
      <pre id="fileViewSource" data-language="${escapeHtml(language)}" hidden>${escapeHtml(source)}</pre>
      <div id="fileViewBody" class="message-content md" data-testid="file-view-markdown"></div>
    </main>
  </body>
</html>
`;
}

async function sendProjectFile(response: Response, projectId: string, requestedPath: string, download: boolean): Promise<void> {
  try {
    const { resolved, info } = await resolveProjectFile(projectId, requestedPath);
    const fileName = path.basename(resolved).replace(/["\r\n]/g, "");
    // Only text renders on the page. A binary or oversized file falls through to the
    // byte stream below, which is what an image or a PDF needs anyway.
    const viewable = !download && !INLINE_PROJECT_FILE_TYPES[path.extname(resolved).toLowerCase()] && info.size <= TEXT_FILE_LIMIT;
    const source = viewable ? readableText(await readFile(resolved)) : null;
    if (source !== null) {
      const page = fileViewPage(fileName, fileViewLanguage(resolved), source);
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Content-Length", String(Buffer.byteLength(page)));
      response.end(page);
      return;
    }
    response.setHeader("Content-Type", projectFileContentType(resolved));
    response.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${fileName}"`);
    response.setHeader("Content-Length", String(info.size));
    createReadStream(resolved).pipe(response);
  } catch (error) {
    if (error instanceof ProjectFileError) { sendError(response, error.status, error.message); return; }
    throw error;
  }
}

async function projectFileContent(projectId: string, requestedPath: string): Promise<{ path: string; content: string; version: string }> {
  const { resolved, relativePath, info } = await resolveProjectFile(projectId, requestedPath);
  if (info.size > TEXT_FILE_LIMIT) throw new ProjectFileError(413, "File is too large to edit");
  const bytes = await readFile(resolved);
  return { path: relativePath, content: textFile(bytes), version: fileVersion(bytes) };
}

async function assertProjectFileConversationOwner(project: ProjectRecord, sessionId: string): Promise<void> {
  const session = (await listHarnessSessions(project)).find((candidate) => candidate.id === sessionId);
  if (!session) throw new ProjectFileError(409, "Conversation was not found on this node");
  try {
    await requireLocalConversationOwner(session.path.startsWith("claude:") ? "claude" : "pi", session.id);
  } catch (error) {
    if (error instanceof ConversationOwnershipError) throw new ProjectFileError(409, error.message);
    throw error;
  }
}

async function updateProjectFileContent(projectId: string, requestedPath: string, payload: z.infer<typeof projectFileUpdateSchema>): Promise<{ path: string; version: string }> {
  const { project, resolved, relativePath, info } = await resolveProjectFile(projectId, requestedPath);
  await assertProjectEditable(project);
  await assertProjectFileConversationOwner(project, payload.sessionId);
  const nextBytes = Buffer.from(payload.content, "utf8");
  if (nextBytes.length > TEXT_FILE_LIMIT) throw new ProjectFileError(413, "File is too large to edit");
  const current = await readFile(resolved);
  if (fileVersion(current) !== payload.version) throw new ProjectFileError(409, "File changed since it was opened");
  textFile(current);
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${randomUUID()}.tmp`);
  try { await writeFile(temporary, nextBytes, { mode: Number(info.mode) }); await rename(temporary, resolved); }
  catch (error) {
    try { await unlink(temporary); }
    catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
  return { path: relativePath, version: fileVersion(nextBytes) };
}

async function proxyProjectFileResolution(peer: ClusterPeer, projectId: string, requestedPath: string): Promise<{ path: string }> {
  const url = new URL("/api/cluster/project-file-resolution", peer.url);
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("path", requestedPath);
  const routed = await fetch(url, { headers: { Authorization: `Bearer ${peer.token}` }, signal: AbortSignal.timeout(30_000) });
  const body = await routed.json().catch(() => null) as { path?: unknown; error?: unknown } | null;
  if (!routed.ok) {
    if (typeof body?.error === "string") throw new ProjectFileError(routed.status, body.error);
    throw new ProjectFileError(502, "File node returned an invalid response");
  }
  if (!body || typeof body.path !== "string") throw new ProjectFileError(502, "File node returned an invalid response");
  return { path: body.path };
}

async function proxyProjectFile(response: Response, peer: ClusterPeer, projectId: string, requestedPath: string, download: boolean): Promise<void> {
  const url = new URL("/api/cluster/project-file", peer.url);
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("path", requestedPath);
  if (download) url.searchParams.set("download", "1");
  const routed = await fetch(url, { headers: { Authorization: `Bearer ${peer.token}` }, signal: AbortSignal.timeout(30_000) });
  for (const header of ["content-type", "content-disposition", "content-length"] as const) {
    const value = routed.headers.get(header);
    if (value) response.setHeader(header, value);
  }
  response.status(routed.status);
  if (!routed.body) { response.end(); return; }
  Readable.fromWeb(routed.body as unknown as import("node:stream/web").ReadableStream).pipe(response);
}

app.get("/api/cluster/project-file-resolution", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const projectId = typeof request.query.projectId === "string" ? request.query.projectId : "";
    const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
    response.json(await projectFileResolution(projectId, requestedPath));
  } catch (error) {
    if (error instanceof ProjectFileError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.get("/api/cluster/project-file", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const projectId = typeof request.query.projectId === "string" ? request.query.projectId : "";
    const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
    await sendProjectFile(response, projectId, requestedPath, request.query.download === "1");
  } catch (error) { next(error); }
});

app.get("/api/projects/:projectId/file-resolution", async (request, response, next) => {
  try {
    const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
    const requestedNodeId = typeof request.query.nodeId === "string" ? request.query.nodeId : "";
    const local = await getClusterNode();
    if (requestedNodeId && requestedNodeId !== local.id) {
      const peer = await getClusterPeer(requestedNodeId);
      if (!peer) { sendError(response, 404, "File node not found"); return; }
      const resolution = await proxyProjectFileResolution(peer, request.params.projectId, requestedPath);
      response.json(projectFileLinks(request.params.projectId, resolution.path, requestedNodeId));
      return;
    }
    const resolution = await projectFileResolution(request.params.projectId, requestedPath);
    response.json(projectFileLinks(request.params.projectId, resolution.path));
  } catch (error) {
    if (error instanceof ProjectFileError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.get("/api/projects/:projectId/file", async (request, response, next) => {
  try {
    const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
    const requestedNodeId = typeof request.query.nodeId === "string" ? request.query.nodeId : "";
    const local = await getClusterNode();
    if (requestedNodeId && requestedNodeId !== local.id) {
      const peer = await getClusterPeer(requestedNodeId);
      if (!peer) { sendError(response, 404, "File node not found"); return; }
      await proxyProjectFile(response, peer, request.params.projectId, requestedPath, request.query.download === "1");
      return;
    }
    await sendProjectFile(response, request.params.projectId, requestedPath, request.query.download === "1");
  } catch (error) { next(error); }
});

async function proxyProjectFileContent(response: Response, peer: ClusterPeer, projectId: string, requestedPath: string, request?: Request): Promise<void> {
  const url = new URL("/api/cluster/project-file-content", peer.url);
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("path", requestedPath);
  const routed = await fetch(url, {
    method: request?.method ?? "GET",
    headers: { Authorization: `Bearer ${peer.token}`, ...(request ? { "Content-Type": "application/json" } : {}) },
    ...(request ? { body: JSON.stringify(request.body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const contentType = routed.headers.get("content-type");
  if (contentType) response.setHeader("Content-Type", contentType);
  response.status(routed.status).send(await routed.text());
}

async function sendProjectFileContent(response: Response, projectId: string, requestedPath: string, payload?: z.infer<typeof projectFileUpdateSchema>): Promise<void> {
  try { response.json(payload ? await updateProjectFileContent(projectId, requestedPath, payload) : await projectFileContent(projectId, requestedPath)); }
  catch (error) {
    if (error instanceof ProjectFileError) { sendError(response, error.status, error.message); return; }
    throw error;
  }
}

app.get("/api/cluster/project-file-content", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    await sendProjectFileContent(response, String(request.query.projectId ?? ""), String(request.query.path ?? ""));
  } catch (error) { next(error); }
});

app.put("/api/cluster/project-file-content", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    await sendProjectFileContent(response, String(request.query.projectId ?? ""), String(request.query.path ?? ""), projectFileUpdateSchema.parse(request.body));
  } catch (error) { next(error); }
});

for (const method of ["get", "put"] as const) {
  app[method]("/api/projects/:projectId/file-content", async (request, response, next) => {
    try {
      const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
      const nodeId = typeof request.query.nodeId === "string" ? request.query.nodeId : "";
      const local = await getClusterNode();
      if (nodeId && nodeId !== local.id) {
        const peer = await getClusterPeer(nodeId);
        if (!peer) { sendError(response, 404, "File node not found"); return; }
        await proxyProjectFileContent(response, peer, request.params.projectId, requestedPath, method === "put" ? request : undefined);
        return;
      }
      await sendProjectFileContent(response, request.params.projectId, requestedPath, method === "put" ? projectFileUpdateSchema.parse(request.body) : undefined);
    } catch (error) { next(error); }
  });
}

app.get("/api/changelog", (_request, response) => {
  response.json({ version: appVersion(), entries: readChangelog() });
});

app.post("/api/update/prepare", async (_request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const recoveryCount = await prepareForUpdate();
    response.json({ ready: true, recoveryCount });
  } catch (error) { next(error); }
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
    return;
  }
  const message = error instanceof Error ? error.message : "Unexpected server error";
  if (error instanceof WorkspaceError) {
    sendError(response, 400, message);
    return;
  }
  sendError(response, error instanceof TaskWorktreeError || error instanceof TaskWorkspaceError || error instanceof ProjectDirectoryImportError || error instanceof ProjectLockedError ? 409 : 500, message);
});

/** The Pi SDK reports a busy session in SDK terms; the chat surface needs a sentence the user can act on. */
function chatErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Command failed";
  if (/already processing/i.test(message)) {
    return "Pi is still working on your previous message. Wait for it to finish or press Stop, then send again.";
  }
  return message;
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

function broadcast(session: SharedPiSession, payload: unknown): void {
  for (const client of session.clients) send(client, payload);
}

function parseSessionPath(value: string | null): string | undefined {
  if (!value || value === "new" || value === "claude:new") return undefined;
  return value;
}

function sendStatus(socket: WebSocket, handle: PiSessionHandle): void {
  send(socket, { type: "status", status: getSessionStatus(handle.session, handle.safeguardsEnabled) });
}

function broadcastStatus(session: SharedPiSession): void {
  broadcast(session, { type: "status", status: getSessionStatus(session.handle.session, session.handle.safeguardsEnabled) });
}

function piTools(handle: PiSessionHandle): Array<{ name: string; description: string; active: boolean }> {
  const active = new Set(handle.session.getActiveToolNames());
  return handle.session.getAllTools()
    .map((tool) => ({ name: tool.name, description: tool.description, active: active.has(tool.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function broadcastTools(session: SharedPiSession): void {
  broadcast(session, { type: "tools", supported: true, tools: piTools(session.handle) });
}

async function setSharedSessionSafeguards(session: SharedPiSession, enabled: boolean): Promise<void> {
  const previous = session.handle;
  if (previous.safeguardsEnabled === enabled) {
    broadcastStatus(session);
    return;
  }
  if (sessionIsBusy(previous)) throw new Error("Wait for the Pi session to finish before changing safeguards");

  session.lastLocalEventAt = Date.now();
  previous.session.sessionManager.appendCustomEntry("joint-bob:safeguards", { enabled });
  let replacement: PiSessionHandle;
  try {
    replacement = await createPiSession({
      cwd: session.cwd,
      projectId: session.projectId,
      sessionPath: previous.session.sessionFile,
      safeguardsEnabled: enabled,
    });
  } catch (error) {
    session.lastLocalEventAt = Date.now();
    previous.session.sessionManager.appendCustomEntry("joint-bob:safeguards", { enabled: previous.safeguardsEnabled });
    throw error;
  }

  const unsubscribe = session.unsubscribe;
  session.handle = replacement;
  session.unsubscribe = subscribeSharedSession(session);
  unsubscribe();
  previous.dispose();
  if (replacement.session.sessionFile) sharedSessions.set(sessionKey(session.cwd, replacement.session.sessionFile), session);
  broadcastStatus(session);
}

function sessionKey(cwd: string, sessionPath: string | undefined): string {
  return `${cwd}\n${sessionPath ?? "new"}`;
}

function clearIdleTimer(session: SharedPiSession): void {
  if (!session.idleTimer) return;
  clearTimeout(session.idleTimer);
  session.idleTimer = null;
}

function disposeSharedSession(session: SharedPiSession): void {
  session.unsubscribe();
  session.handle.dispose();
  for (const [key, value] of sharedSessions.entries()) {
    if (value === session) sharedSessions.delete(key);
  }
}

function scheduleIdleDispose(session: SharedPiSession): void {
  clearIdleTimer(session);
  if (session.handle.session.isStreaming) return;
  session.idleTimer = setTimeout(() => {
    if (session.clients.size || session.handle.session.isStreaming) {
      scheduleIdleDispose(session);
      return;
    }
    disposeSharedSession(session);
  }, idleSessionTimeoutMs);
  session.idleTimer.unref();
}

function broadcastToProject(projectId: string, payload: unknown): void {
  for (const client of watchClients.get(projectId) ?? []) send(client, payload);
  for (const session of new Set(sharedSessions.values())) {
    if (session.projectId === projectId) broadcast(session, payload);
  }
  for (const connection of claudeClients.values()) {
    if (connection.project.id === projectId) send(connection.socket, payload);
  }
}

/** Lease and review-watermark updates arrive without a project context, so every watcher re-lists. */
function broadcastSessionsChangedToAllProjects(): void {
  for (const projectId of watchClients.keys()) broadcastToProject(projectId, { type: "sessionsChanged" });
}

async function reloadClaudeClients(projectId: string, changedFiles: string[]): Promise<void> {
  for (const connection of claudeClients.values()) {
    if (connection.project.id !== projectId) continue;
    if (!connection.claude.filePath) continue;
    // Skip while this socket itself is driving Claude, and right after its own
    // run finished writing the session file.
    if (connection.claude.child) continue;
    if (Date.now() - connection.claude.lastRunEndedAt < localWriteGraceMs) continue;
    if (changedFiles.length && !changedFiles.includes(connection.claude.filePath)) continue;
    try {
      const messages = await loadClaudeMessages(`claude:${connection.claude.filePath}`);
      connection.claude.transcript = messages;
      connection.claude.contextUsage = await claudeSessionContextUsage(`claude:${connection.claude.filePath}`) ?? null;
      const listed = (await listHarnessSessions(connection.project)).find((session) => session.path === `claude:${connection.claude.filePath}`);
      if (listed) connection.claude.sessionName = listed.title;
      send(connection.socket, { type: "messages", messages });
      sendClaudeStatus(connection);
    } catch (error) {
      console.warn("Could not reload Claude transcript", error);
    }
  }
}

function invalidateExternallyChangedSessions(projectId: string, changedFiles: string[]): void {
  for (const session of new Set(sharedSessions.values())) {
    if (session.projectId !== projectId) continue;
    const sessionFile = session.handle.session.sessionFile;
    if (!sessionFile) continue;
    if (changedFiles.length && !changedFiles.includes(sessionFile)) continue;
    if (session.handle.session.isStreaming) continue;
    if (Date.now() - session.lastLocalEventAt < localWriteGraceMs) continue;
    const clients = [...session.clients];
    disposeSharedSession(session);
    // Clients reconnect and get a fresh handle that reads the synced file.
    for (const client of clients) send(client, { type: "sessionFileChanged" });
  }
}

/**
 * Conversations enter review both when an agent finishes here and when another node's transcript
 * lands via Syncthing, so notifications are driven off the review state itself rather than off the
 * local agent lifecycle. The quiet period lets a transcript that is still being written settle, so a
 * conversation buzzes the phone when it stops moving instead of on every intermediate write.
 */
const REVIEW_NOTIFICATION_QUIET_MS = 10_000;
const reviewNotificationTimers = new Map<string, NodeJS.Timeout>();

async function notifyPendingReviews(projectId: string): Promise<void> {
  const userIds = await listPushSubscriberUserIds(projectId);
  if (!userIds.length) return;
  const project = await getProject(projectId);
  if (!project) return;
  for (const userId of userIds) {
    const username = usernameForUser(userId);
    if (!username) continue;
    const sessions = await listProjectSessionsWithReviewState(project, userId, username);
    const pending = new Map(sessions
      .filter((session) => session.reviewState === "needs_review" && !session.running)
      .map((session) => [session.path, session]));
    for (const sessionPath of claimReviewNotifications(userId, projectId, [...pending.keys()])) {
      const session = pending.get(sessionPath);
      if (!session) continue;
      await notifyConversationReview(userId, projectId, sessionPath, session.title || project.name);
    }
  }
}

function scheduleReviewNotifications(projectId: string): void {
  const pending = reviewNotificationTimers.get(projectId);
  if (pending) clearTimeout(pending);
  const timer = setTimeout(() => {
    reviewNotificationTimers.delete(projectId);
    notifyPendingReviews(projectId).catch((error) => console.warn("Review notification failed", error));
  }, REVIEW_NOTIFICATION_QUIET_MS);
  timer.unref();
  reviewNotificationTimers.set(projectId, timer);
}

function handleSessionChange(projectId: string, changedFiles: string[]): void {
  refreshHarnessSessions(projectId, changedFiles)
    .then(() => broadcastToProject(projectId, { type: "sessionsChanged" }))
    .catch((error) => console.warn("Conversation catalog refresh failed", error));
  scheduleReviewNotifications(projectId);
  invalidateExternallyChangedSessions(projectId, changedFiles);
  reloadClaudeClients(projectId, changedFiles).catch((error) => console.warn("Claude reload failed", error));
}

async function abortPiForUpdate(session: SharedPiSession): Promise<void> {
  const agent = session.handle.session;
  agent.abortRetry();
  agent.abortCompaction();
  agent.abortBranchSummary();
  agent.abortBash();
  await agent.abort();
}

async function terminateClaudeForUpdate(child: ClaudeRunHandle["child"]): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      child.off("close", onClose);
      child.off("error", onError);
    };
    const onClose = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    child.once("close", onClose);
    child.once("error", onError);
    child.kill("SIGTERM");
  });
}

function updateRecoveryRecord(values: Omit<UpdateRecoveryRecord, "id" | "createdAt">): UpdateRecoveryRecord {
  if (!values.sessionId || !values.sessionPath) throw new Error("Active run has no durable session identity");
  return { ...values, id: randomUUID(), createdAt: new Date().toISOString() };
}

function activeUpdateRecoveries(): UpdateRecoveryRecord[] {
  const records: UpdateRecoveryRecord[] = [];
  for (const shared of new Set(sharedSessions.values())) {
    if (piTaskRuns.has(shared) || !sessionIsBusy(shared.handle)) continue;
    const session = shared.handle.session;
    records.push(updateRecoveryRecord({ kind: "chat", engine: "pi", projectId: shared.projectId, cwd: shared.cwd, sessionId: session.sessionId, sessionPath: session.sessionFile ?? "", taskId: null, phase: null, queuedPrompts: [...session.getSteeringMessages(), ...session.getFollowUpMessages()], model: null, effort: null }));
  }
  for (const connection of new Set(activeClaudeConnections.values())) {
    if (!connection.claude.child) continue;
    // Queued prompts stay in the durable queue and drain after the update. Copying
    // them here too would run them twice if the node died between the two writes.
    records.push(updateRecoveryRecord({ kind: "chat", engine: "claude", projectId: connection.project.id, cwd: connection.cwd, sessionId: connection.claude.sessionId ?? "", sessionPath: connection.claude.filePath ? `claude:${connection.claude.filePath}` : "", taskId: null, phase: null, queuedPrompts: [], model: connection.claude.model, effort: connection.claude.effort }));
  }
  for (const [shared, run] of piTaskRuns) {
    const session = shared.handle.session;
    records.push(updateRecoveryRecord({ kind: "task", engine: "pi", projectId: run.projectId, cwd: shared.cwd, sessionId: session.sessionId, sessionPath: session.sessionFile ?? run.sessionPath ?? "", taskId: run.taskId, phase: run.phase, queuedPrompts: [...session.getSteeringMessages(), ...session.getFollowUpMessages()], model: null, effort: null }));
  }
  for (const run of claudeTaskRuns.values()) records.push(updateRecoveryRecord({ kind: "task", engine: "claude", projectId: run.projectId, cwd: run.cwd, sessionId: run.sessionId, sessionPath: run.sessionPath, taskId: run.taskId, phase: run.phase, queuedPrompts: [], model: run.model, effort: run.effort }));
  return records;
}

function broadcastUpdatePreparing(): void {
  for (const client of webSocketServer.clients) send(client, { type: "updatePreparing", message: "Updating... Work will resume automatically." });
}

function prepareForUpdate(): Promise<number> {
  if (!updatePreparation) updatePreparation = performUpdatePreparation();
  return updatePreparation;
}

async function performUpdatePreparation(): Promise<number> {
  updatePreparing = true;
  broadcastUpdatePreparing();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const records = activeUpdateRecoveries();
  await saveUpdateRecoveries(records);
  for (const shared of new Set(sharedSessions.values())) shared.handle.session.clearQueue();
  // Only the in-memory copy is dropped: the rows outlive the restart and drain
  // when a client comes back to the conversation.
  for (const connection of new Set(activeClaudeConnections.values())) connection.claude.promptQueue.splice(0);
  const pi = [...new Set(sharedSessions.values())].filter((shared) => sessionIsBusy(shared.handle)).map(abortPiForUpdate);
  const children = [...activeClaudeConnections.values()].map((connection) => connection.claude.child).filter((child): child is ClaudeRunHandle["child"] => Boolean(child));
  const claude = [...new Set([...children, ...[...claudeTaskRuns.values()].map((run) => run.child)])].map(terminateClaudeForUpdate);
  await Promise.all([...pi, ...claude]);
  return records.length;
}

// ---- Kanban task runs: moving a task to "in progress" starts its agent ----

interface PiTaskRun {
  projectId: string;
  taskId: string;
  title: string;
  conversationId: string;
  leaseToken: string;
  phase: TaskPhase;
  sessionPath: string | null;
}

interface ClaudeTaskRun {
  child: ClaudeRunHandle["child"];
  projectId: string;
  taskId: string;
  leaseToken: string;
  phase: TaskPhase;
  cwd: string;
  sessionId: string;
  sessionPath: string;
  model: string | null;
  effort: string | null;
}

const piTaskRuns = new Map<SharedPiSession, PiTaskRun>();
const claudeTaskRuns = new Map<string, ClaudeTaskRun>();

/**
 * Links a ticket to the conversation its run owns, as soon as the run owns one.
 * The board's "Open chat" control reads that link, so waiting for the run to
 * finish would leave a running ticket with no way back to its conversation.
 */
async function persistTaskSessionPath(projectId: string, taskId: string, leaseToken: string, sessionPath: string, conversationId: string, title: string): Promise<void> {
  const local = await getClusterNode();
  const task = await updateTaskSessionPath(projectId, taskId, local.id, leaseToken, sessionPath);
  if (!task) return;
  // The prompt opens with the workspace preamble, so the harness would otherwise
  // name the conversation after a file path.
  await ensureSessionTitle(conversationId, title);
  broadcastToProject(projectId, { type: "tasksChanged" });
  broadcastToProject(projectId, { type: "sessionsChanged" });
}

async function persistPiTaskSession(session: SharedPiSession): Promise<void> {
  const run = piTaskRuns.get(session);
  const sessionPath = session.handle.session.sessionFile;
  if (!run || !sessionPath || run.sessionPath === sessionPath) return;
  run.sessionPath = sessionPath;
  await persistTaskSessionPath(run.projectId, run.taskId, run.leaseToken, sessionPath, run.conversationId, run.title);
}

function taskRunActive(taskId: string): boolean {
  if (claudeTaskRuns.has(taskId)) return true;
  for (const run of piTaskRuns.values()) {
    if (run.taskId === taskId) return true;
  }
  return false;
}

const planInstructions = `Plan mode instructions:
- Do not edit files or run implementation commands.
- Inspect the codebase as needed and produce a concise implementation plan.
- Include key files, risks, and validation steps.
- Wait for explicit approval or for the ticket to move to In progress before implementing.`;

const reviewInstructions = `Review mode instructions:
- Verify the completed implementation against the ticket.
- Inspect changed files and run focused validation when useful.
- Produce a concise code review with bugs, risks, missing tests, and final verdict.
- Do not implement fixes unless explicitly asked.`;

function taskPhase(task: TaskRecord): TaskPhase {
  if (task.status === "planning") return "planning";
  if (task.status === "review") return "review";
  return "in_progress";
}

function taskConfig(task: TaskRecord, phase: TaskPhase): TaskPhaseConfig {
  return task.phaseConfig[phase] ?? { engine: task.engine, provider: "", modelId: "", effort: "default" };
}

function taskCwd(project: ProjectRecord, task: TaskRecord): string {
  return task.worktreePath ?? project.path;
}

async function taskHandoffContext(project: ProjectRecord, task: TaskRecord): Promise<string> {
  if (!task.sessionPath) return "";
  if (task.sessionPath.startsWith("claude:")) return buildHandoffContext(await loadClaudeMessages(task.sessionPath));
  const handle = await createPiSession({ cwd: taskCwd(project, task), projectId: project.id, sessionPath: task.sessionPath });
  const transcript = simplifyMessages(handle.session.messages as unknown[]);
  handle.dispose();
  return buildHandoffContext(transcript);
}

async function taskPromptText(project: ProjectRecord, task: TaskRecord, phase: TaskPhase, engine: ChatEngine): Promise<string> {
  const prompt = [task.title, task.description].filter(Boolean).join("\n\n");
  const instruction = phase === "planning" && task.planMode ? planInstructions : phase === "review" ? reviewInstructions : "";
  const workspaceInstruction = !task.worktreePath
    ? ""
    : task.worktreeBranch
      ? `Ticket Git worktree: ${task.worktreePath}\nTicket branch: ${task.worktreeBranch}\nWork only in this worktree.${phase === "in_progress" ? " Before finishing, commit all ticket changes to this branch using a Conventional Commit message." : ""}`
      : `Ticket synchronized workspace: ${task.worktreePath}\nWork only in this workspace. Git is optional; Syncthing transfers these files between nodes.`;
  const handoff = phase === "planning" ? "" : task.handoffContext ?? await taskHandoffContext(project, task);
  return [instruction, workspaceInstruction, handoff, prompt].filter(Boolean).join("\n\n");
}

async function finishTaskPhase(project: ProjectRecord, task: TaskRecord, phase: TaskPhase, sessionPath: string | null, leaseToken: string): Promise<void> {
  const update = phase === "planning"
    ? { sessionPath }
    : phase === "review"
      ? { status: "done" as const, ...(sessionPath ? { sessionPath } : {}) }
      : { status: "review" as const, ...(sessionPath ? { sessionPath } : {}) };
  const local = await getClusterNode();
  const completed = await completeTaskLease(project.id, task.id, local.id, leaseToken, update);
  if (phase === "in_progress" && completed.reviewMode) startTaskRun(project, completed, "review").catch((error) => console.warn("Review start failed", error));
  broadcastToProject(project.id, { type: "tasksChanged" });
  broadcastToProject(project.id, { type: "sessionsChanged" });
}

interface TaskRunRecovery { recoveryId: string; prompt: string; }

async function failTaskRunRecovery(projectId: string, taskId: string, nodeId: string, leaseToken: string, recovery: TaskRunRecovery | undefined, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : "Task run failed";
  try {
    await releaseTaskLease(projectId, taskId, nodeId, leaseToken, "failed");
  } catch (releaseError) {
    console.warn("Could not release task lease", releaseError);
  }
  if (!recovery) return;
  try {
    await failUpdateRecovery(recovery.recoveryId, message);
  } catch (recoveryError) {
    console.warn("Could not mark update recovery failed", recoveryError);
  }
}

async function startTaskRun(project: ProjectRecord, task: TaskRecord, requestedPhase?: TaskPhase, recovery?: TaskRunRecovery): Promise<void> {
  const local = await getClusterNode();
  if (task.currentNodeId !== local.id) return;
  const { task: claimed, leaseToken } = await claimTaskLease(project.id, task.id, local.id);
  broadcastToProject(project.id, { type: "tasksChanged" });
  let shared: SharedPiSession | undefined;
  try {
    const phase = requestedPhase ?? taskPhase(claimed);
    const config = taskConfig(claimed, phase);
    const cwd = taskCwd(project, claimed);
    const prompt = recovery ? recovery.prompt : await taskPromptText(project, claimed, phase, config.engine);
    if (config.engine === "claude") {
      const resumeSessionId = task.sessionPath?.startsWith("claude:") ? path.basename(task.sessionPath.replace(/^claude:/, ""), ".jsonl") : undefined;
      const sessionId = resumeSessionId ?? randomUUID();
      await claimConversationAcrossCluster("claude", sessionId, local.id);
      const claudePrompt = resumeSessionId ? prompt : [agentCredentialContext(project.id, { engine: "claude", sessionId }), prompt].filter(Boolean).join("\n\n");
      const run = runClaudePrompt({
        cwd,
        prompt: claudePrompt,
        env: agentEnvironment(project.id, { engine: "claude", sessionId }),
        resumeSessionId,
        sessionId: resumeSessionId ? undefined : sessionId,
        model: config.modelId || undefined,
        effort: config.effort && config.effort !== "default" ? config.effort : undefined,
        onEvent: () => undefined,
      });
      const claudeSessionPath = resumeSessionId ? task.sessionPath! : `claude:${claudeSessionFilePath(cwd, sessionId)}`;
      claudeTaskRuns.set(task.id, { child: run.child, projectId: project.id, taskId: claimed.id, leaseToken, phase, cwd, sessionId, sessionPath: claudeSessionPath, model: config.modelId || null, effort: config.effort || null });
      await persistTaskSessionPath(project.id, claimed.id, leaseToken, claudeSessionPath, resumeSessionId ?? sessionId, claimed.title);
      run.done
        .then(async (result) => {
          if (claudeTaskRuns.get(task.id)?.leaseToken !== leaseToken) {
            console.warn("Ignoring stale Claude task callback", task.id);
            return;
          }
          if (!result.ok) throw new Error("Claude task run failed");
          const sessionPath = result.sessionId ? `claude:${claudeSessionFilePath(cwd, result.sessionId)}` : null;
          await finishTaskPhase(project, claimed, phase, sessionPath, leaseToken);
          if (recovery) await completeUpdateRecovery(recovery.recoveryId);
          if (claudeTaskRuns.get(task.id)?.leaseToken === leaseToken) claudeTaskRuns.delete(task.id);
        })
        .catch(async (error) => {
          if (claudeTaskRuns.get(task.id)?.leaseToken !== leaseToken) {
            console.warn("Ignoring stale Claude task callback", task.id);
            return;
          }
          claudeTaskRuns.delete(task.id);
          console.warn("Claude task run failed", error);
          await failTaskRunRecovery(project.id, claimed.id, local.id, leaseToken, recovery, error);
        });
      return;
    }

    const samePiSession = claimed.sessionPath && !claimed.sessionPath.startsWith("claude:") ? claimed.sessionPath : undefined;
    const newSessionId = samePiSession ? undefined : randomUUID();
    let conversationId: string | undefined = newSessionId;
    if (samePiSession) {
      const listed = (await listHarnessSessions({ ...project, additionalPaths: [cwd] })).find((session) => session.path === samePiSession);
      if (!listed) throw new Error("Task conversation was not found");
      conversationId = listed.id;
      await claimConversationAcrossCluster("pi", listed.id, local.id);
    } else await claimConversationAcrossCluster("pi", newSessionId!, local.id);
    shared = await getSharedSession(project.id, cwd, samePiSession, newSessionId);
    if (config.provider && config.modelId) await setSessionModel(shared.handle.session, config.provider, config.modelId);
    piTaskRuns.set(shared, { projectId: project.id, taskId: claimed.id, title: claimed.title, conversationId: conversationId!, leaseToken, phase, sessionPath: null });
    await persistPiTaskSession(shared);
    promptIdlePiSession(shared.handle, prompt)
      .then(async () => {
        if (piTaskRuns.get(shared!)?.leaseToken !== leaseToken) {
          console.warn("Ignoring stale Pi task callback", claimed.id);
          return;
        }
        await finishPiTaskRun({ projectId: project.id, taskId: claimed.id, title: claimed.title, conversationId: conversationId!, leaseToken, phase, sessionPath: null }, shared!.handle.session.sessionFile ?? null);
        if (recovery) await completeUpdateRecovery(recovery.recoveryId);
        if (piTaskRuns.get(shared!)?.leaseToken === leaseToken) piTaskRuns.delete(shared!);
      })
      .catch(async (error) => {
        if (piTaskRuns.get(shared!)?.leaseToken !== leaseToken) {
          console.warn("Ignoring stale Pi task callback", claimed.id);
          return;
        }
        console.warn("Pi task run failed", error);
        piTaskRuns.delete(shared!);
        await failTaskRunRecovery(project.id, claimed.id, local.id, leaseToken, recovery, error);
      });
  } catch (error) {
    if (shared && piTaskRuns.get(shared)?.leaseToken === leaseToken) piTaskRuns.delete(shared);
    if (claudeTaskRuns.get(task.id)?.leaseToken === leaseToken) claudeTaskRuns.delete(task.id);
    await failTaskRunRecovery(project.id, claimed.id, local.id, leaseToken, recovery, error);
    throw error;
  }
}

async function runRecoveredClaudePrompt(record: UpdateRecoveryRecord, entry: RecoveredClaudeChat, prompt: string): Promise<void> {
  const state = entry.claude;
  state.liveEvents = [];
  const onEvent = (payload: Record<string, unknown>): void => {
    appendLiveEvent(state.liveEvents, payload);
    if (entry.connection) send(entry.connection.socket, payload);
  };
  onEvent({ type: "agent_start" });
  const run = runClaudePrompt({
    cwd: record.cwd, prompt, resumeSessionId: record.sessionId,
    model: state.model ?? undefined, effort: state.effort ?? undefined,
    env: agentEnvironment(record.projectId, { engine: "claude", sessionId: record.sessionId }), onEvent,
  });
  state.child = run.child;
  if (entry.connection) sendClaudeStatus(entry.connection);
  try {
    const result = await run.done;
    if (!result.ok) throw new Error("Claude recovery run failed");
    if (result.assistantText) state.transcript.push({ id: `${state.transcript.length}`, role: "assistant", text: result.assistantText });
  } finally {
    state.child = null;
    state.lastRunEndedAt = Date.now();
    onEvent({ type: "agent_end" });
    if (entry.connection) sendClaudeStatus(entry.connection);
  }
}

async function recoverChat(record: UpdateRecoveryRecord): Promise<void> {
  if (record.engine === "pi") {
    const shared = await getSharedSession(record.projectId, record.cwd, record.sessionPath, record.sessionId);
    await shared.handle.session.prompt(updateContinuationPrompt);
    for (const prompt of record.queuedPrompts) await shared.handle.session.prompt(prompt);
    await completeUpdateRecovery(record.id);
    return;
  }
  const key = claudeRunKey(record.projectId, record.sessionPath);
  const claude = emptyClaudeState(record.sessionId);
  claude.filePath = path.resolve(record.sessionPath.replace(/^claude:/, ""));
  claude.transcript = await loadClaudeMessages(record.sessionPath);
  if (record.model) claude.model = record.model;
  if (record.effort) claude.effort = record.effort;
  const recovered: RecoveredClaudeChat = { claude, connection: null };
  recoveredClaudeChats.set(key, recovered);
  runningClaudeSessionPaths.add(key);
  try {
    for (const prompt of [updateContinuationPrompt, ...record.queuedPrompts]) {
      await runRecoveredClaudePrompt(record, recovered, prompt);
    }
    await completeUpdateRecovery(record.id);
  } finally {
    recoveredClaudeChats.delete(key);
    runningClaudeSessionPaths.delete(key);
    broadcastToProject(record.projectId, { type: "sessionsChanged" });
    if (recovered.connection) await drainClaudePromptQueue(recovered.connection);
  }
}

async function recoverTask(record: UpdateRecoveryRecord): Promise<void> {
  const project = await getProject(record.projectId);
  if (!project) throw new Error("Recovery project not found");
  const task = (await listTasks(record.projectId)).find((candidate) => candidate.id === record.taskId);
  if (!task) throw new Error("Recovery task not found");
  const recovered = task.sessionPath === record.sessionPath ? task : await updateTask(record.projectId, task.id, { sessionPath: record.sessionPath });
  if (!record.phase) throw new Error("Recovery task phase is missing");
  await startTaskRun(project, recovered, record.phase, { recoveryId: record.id, prompt: updateContinuationPrompt });
}

async function recoverPendingUpdateRuns(): Promise<void> {
  for (const record of await listPendingUpdateRecoveries()) {
    try {
      if (record.kind === "chat") await recoverChat(record);
      else await recoverTask(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Update recovery failed";
      console.warn("Update recovery failed", error);
      await failUpdateRecovery(record.id, message);
    }
  }
}

const sessionWatcher = new SessionWatcher(handleSessionChange);
listProjects()
  .then((projects) => {
    for (const project of projects) sessionWatcher.ensureProject(project);
  })
  .catch((error) => console.warn("Could not start session watchers", error));

function subscribeSharedSession(session: SharedPiSession): () => void {
  const handle = session.handle;
  return handle.session.subscribe((event) => {
    session.lastLocalEventAt = Date.now();
    const run = agentRunDescriptor(event);
    if (run && !session.agentRuns.has(run.runId)) {
      session.agentRuns.set(run.runId, { descriptor: run, summary: run.summary });
      broadcastToProject(session.projectId, { type: "sessionsChanged" });
    }
    // New sessions get their file lazily; register the file-keyed entry as soon
    // as it exists so later connects attach to this live session.
    if (handle.session.sessionFile && !sharedSessions.has(sessionKey(session.cwd, handle.session.sessionFile))) {
      sharedSessions.set(sessionKey(session.cwd, handle.session.sessionFile), session);
    }
    broadcast(session, eventPayload(event));
    persistPiTaskSession(session).catch((error) => console.warn("Could not save Pi task session", error));
    if (event.type === "message_end" || event.type === "turn_end" || event.type === "agent_end") {
      broadcast(session, { type: "status", status: getSessionStatus(handle.session, handle.safeguardsEnabled) });
      // Notify only when the whole task finished, not on every intermediate
      // assistant message within a turn.
      const finishedSessionPath = handle.session.sessionFile;
      if (event.type === "agent_end" && finishedSessionPath) {
        scheduleReviewNotifications(session.projectId);
        broadcastToProject(session.projectId, { type: "sessionsChanged" });
      }
      if (!session.clients.size) scheduleIdleDispose(session);
    }
  });
}

async function getSharedSession(projectId: string, cwd: string, sessionPath: string | undefined, sessionId?: string, secretAccountIds: string[] = []): Promise<SharedPiSession> {
  if (sessionPath) {
    const existing = sharedSessions.get(sessionKey(cwd, sessionPath));
    if (existing) {
      clearIdleTimer(existing);
      return existing;
    }
  }

  const handle = await createPiSession({ cwd, projectId, sessionPath, sessionId, conversation: { engine: "pi", ...(sessionId ? { sessionId } : {}), accountIds: secretAccountIds } });
  // The id the engine settled on is the one the attachments belong to (FR9.4).
  await persistConversationSecretAccounts("pi", handle.session.sessionId, secretAccountIds);
  const key = sessionKey(cwd, sessionPath ?? handle.session.sessionFile ?? `new:${Date.now()}:${Math.random()}`);
  const session: SharedPiSession = {
    handle,
    unsubscribe: () => undefined,
    clients: new Set(),
    key,
    projectId,
    cwd,
    idleTimer: null,
    // Loading an existing session is not a local write. Start at zero so an
    // immediate Syncthing update can invalidate and reload this transcript.
    lastLocalEventAt: 0,
    agentRuns: new Map(),
    turnInFlight: 0,
  };
  session.unsubscribe = subscribeSharedSession(session);
  sharedSessions.set(key, session);
  if (handle.session.sessionFile) sharedSessions.set(sessionKey(cwd, handle.session.sessionFile), session);
  return session;
}

async function finishPiTaskRun(taskRun: PiTaskRun, sessionPath: string | null): Promise<void> {
  const project = await getProject(taskRun.projectId);
  const task = (await listTasks(taskRun.projectId)).find((candidate) => candidate.id === taskRun.taskId);
  if (!project || !task) throw new Error("Task run target missing");
  await finishTaskPhase(project, task, taskRun.phase, sessionPath, taskRun.leaseToken);
}

function promptDisplayText(message: string, imageNames: string[], fileNames: string[]): string {
  const body = message.trim();
  const attachmentNames = [...imageNames, ...fileNames];
  if (!attachmentNames.length) return body;
  const suffix = `Attached: ${attachmentNames.join(", ")}`;
  return body ? `${body}\n\n${suffix}` : suffix;
}

function promptTextWithAttachments(message: string, imageAttachments: Array<{ name: string; path: string }>, fileAttachments: Array<{ name: string; path: string }>): string {
  const parts: string[] = [];
  const body = message.trim();
  if (body) parts.push(body);
  if (imageAttachments.length) {
    parts.push(`Image attachments:\n${imageAttachments.map((image) => `- ${image.name}: ${image.path}`).join("\n")}\nAnalyze them alongside the request. Use these paths when a tool needs the original image file.`);
  }
  if (fileAttachments.length) {
    parts.push(`File attachments:\n${fileAttachments.map((file) => `- ${file.name}: ${file.path}`).join("\n")}\nOpen these files from their paths when needed.`);
  }
  return parts.join("\n\n").trim();
}

function safeAttachmentName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function persistImageAttachments(cwd: string, images: Array<{ name: string; data: string }>): Promise<Array<{ name: string; path: string }>> {
  if (!images.length) return [];
  const attachmentDir = path.join(cwd, ".joint-bob-attachments");
  await mkdir(attachmentDir, { recursive: true });
  const savedImages: Array<{ name: string; path: string }> = [];
  for (const image of images) {
    const filePath = path.join(attachmentDir, `${Date.now()}-${randomUUID()}-${safeAttachmentName(image.name)}`);
    await writeFile(filePath, Buffer.from(image.data, "base64"));
    savedImages.push({ name: image.name, path: filePath });
  }
  return savedImages;
}

async function persistFileAttachments(cwd: string, files: Array<{ name: string; data: string }>): Promise<Array<{ name: string; path: string }>> {
  if (!files.length) return [];
  const attachmentDir = path.join(cwd, ".joint-bob-attachments");
  await mkdir(attachmentDir, { recursive: true });
  const savedFiles: Array<{ name: string; path: string }> = [];
  for (const file of files) {
    const filePath = path.join(attachmentDir, `${Date.now()}-${randomUUID()}-${safeAttachmentName(file.name)}`);
    await writeFile(filePath, Buffer.from(file.data, "base64"));
    savedFiles.push({ name: file.name, path: filePath });
  }
  return savedFiles;
}

type SocketPayload = z.infer<typeof socketMessageSchema>;

async function resumeReviewedTask(connection: ChatConnection): Promise<void> {
  if (!connection.taskId) return;
  const task = (await listTasks(connection.project.id)).find((candidate) => candidate.id === connection.taskId);
  if (!task || task.status !== "review") return;
  const local = await getClusterNode();
  if (task.currentNodeId !== local.id) throw new Error("Task owner changed");
  await updateTask(connection.project.id, task.id, { status: "in_progress" });
  broadcastToProject(connection.project.id, { type: "tasksChanged" });
}

function claudeStatus(connection: ChatConnection): SessionStatus {
  return {
    sessionFile: connection.claude.filePath ? `claude:${connection.claude.filePath}` : undefined,
    sessionId: connection.claude.sessionId ?? "claude:new",
    sessionName: connection.claude.sessionName ?? undefined,
    model: {
      provider: "claude",
      id: connection.claude.model ?? CLAUDE_DEFAULT_MODEL,
      label: CLAUDE_MODEL_LABELS.get(connection.claude.model ?? CLAUDE_DEFAULT_MODEL)!,
    },
    thinkingLevel: connection.claude.effort ?? "default",
    availableThinkingLevels: ["default", "low", "medium", "high", "xhigh", "max"],
    isStreaming: Boolean(connection.claude.child),
    isCompacting: connection.claude.compacting,
    isRetrying: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    messageCount: connection.claude.transcript.length,
    activeTools: connection.claude.enabledTools ?? connection.claude.availableTools,
    promptTemplates: [],
    contextUsage: connection.claude.contextUsage ?? undefined,
  };
}

function sendClaudeStatus(connection: ChatConnection): void {
  send(connection.socket, { type: "status", status: claudeStatus(connection) });
}

function emptyClaudeState(sessionId: string | null = null): ClaudeChatState {
  return { sessionId, sessionName: null, filePath: null, child: null, promptQueue: [], transcript: [], lastRunEndedAt: 0, model: CLAUDE_DEFAULT_MODEL, effort: null, availableTools: [], enabledTools: null, compacting: false, liveEvents: [], contextUsage: null };
}

function pushTranscript(connection: ChatConnection, role: string, text: string): void {
  connection.claude.transcript.push({ id: `${connection.claude.transcript.length}`, role, text });
}

function claudeConnectionKey(projectId: string, sessionId: string | null): string {
  return `${projectId}:${sessionId ?? "claude:new"}`;
}

/** Where this conversation's pending prompts are stored. */
function claudeQueueKey(connection: ChatConnection): string {
  return claudeConnectionKey(connection.project.id, connection.claude.sessionId);
}

function claudeRunKey(projectId: string, sessionPath: string): string {
  return `${projectId}\n${sessionPath}`;
}

async function waitForTestEngineRelease(engine: ChatEngine): Promise<void> {
  const holdDir = process.env.NODE_ENV === "test" ? process.env.JOINT_BOB_TEST_ENGINE_HOLD_DIR : undefined;
  if (!holdDir) return;
  const releasePath = path.join(holdDir, `${engine}.release`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await access(releasePath); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Stubbed ${engine} turn release timed out`);
}

async function logStubbedEngineInvocation(engine: ChatEngine): Promise<boolean> {
  const invocationLog = process.env.NODE_ENV === "test" ? process.env.JOINT_BOB_TEST_ENGINE_LOG : undefined;
  if (!invocationLog) return false;
  await appendFile(invocationLog, `${engine}:${(await getClusterNode()).id}\n`);
  await waitForTestEngineRelease(engine);
  return true;
}

async function runStubbedClaudePrompt(connection: ChatConnection, promptText: string, onEvent: (payload: Record<string, unknown>) => void): Promise<ClaudeRunResult | undefined> {
  if (!await logStubbedEngineInvocation("claude")) return undefined;
  if (!connection.claude.filePath || !connection.claude.sessionId) throw new Error("Stubbed Claude session has no transcript path");
  const timestamp = new Date().toISOString();
  const records = [
    { type: "user", sessionId: connection.claude.sessionId, cwd: connection.cwd, timestamp, message: { role: "user", content: promptText } },
    { type: "assistant", sessionId: connection.claude.sessionId, cwd: connection.cwd, timestamp, message: { role: "assistant", content: [{ type: "text", text: "stubbed response" }] } },
  ];
  await appendFile(connection.claude.filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  onEvent({ type: "textDelta", delta: "stubbed response" });
  return { ok: true, sessionId: connection.claude.sessionId, sawOutput: true, assistantText: "stubbed response", tools: ["Bash", "Read", "Edit"] };
}

async function runClaudeTurn(connection: ChatConnection, promptText: string, displayText: string, showUserMessage = true): Promise<void> {
  if (connection.claude.child) throw new Error("Claude is still working — stop it first or wait");
  if (!connection.claude.sessionId) throw new Error("Conversation has no ownership identity");
  await requireLocalConversationOwner("claude", connection.claude.sessionId);
  // A conversation taken over from a node whose checkout sits at a different
  // absolute path still carries that node's encoded transcript directory, and
  // `claude --resume` only looks under the directory this node's cwd encodes
  // to. Put the transcript there first, or the resume silently starts over.
  const localTranscript = claudeSessionFilePath(connection.cwd, connection.claude.sessionId);
  if (connection.claude.filePath && path.resolve(connection.claude.filePath) !== path.resolve(localTranscript)) {
    connection.claude.filePath = await ensureLocalClaudeTranscript(connection.cwd, connection.claude.sessionId);
  }
  if (showUserMessage) send(connection.socket, { type: "userMessage", text: displayText });
  pushTranscript(connection, "user", promptText);
  // Buffer every turn event so a browser that reconnects mid-turn can replay it.
  connection.claude.liveEvents = [];
  const onEvent = (payload: Record<string, unknown>): void => {
    if (payload.type === "contextUsage") {
      connection.claude.contextUsage = payload.usage as ContextUsage;
      sendClaudeStatus(connection);
      return;
    }
    appendLiveEvent(connection.claude.liveEvents, payload);
    send(connection.socket, payload);
  };
  onEvent({ type: "agent_start" });
  const basePrompt = connection.handoffContext ? `${connection.handoffContext}${promptText}` : promptText;
  const conversationScope = { engine: "claude" as const, ...(connection.claude.sessionId ? { sessionId: connection.claude.sessionId } : {}), accountIds: connection.secretAccountIds };
  const fullPrompt = connection.claude.filePath ? basePrompt : [agentCredentialContext(connection.project.id, conversationScope), basePrompt].filter(Boolean).join("\n\n");
  connection.handoffContext = null;

  const runningKeys = new Set<string>();
  const markClaudeRunning = (sessionFilePath: string): void => {
    const key = claudeRunKey(connection.project.id, `claude:${sessionFilePath}`);
    if (runningClaudeSessionPaths.has(key)) return;
    runningClaudeSessionPaths.add(key);
    runningKeys.add(key);
    broadcastToProject(connection.project.id, { type: "sessionsChanged" });
  };

  let activeKey = claudeConnectionKey(connection.project.id, connection.claude.sessionId);
  activeClaudeConnections.set(activeKey, connection);

  // A new conversation only learns its real id part-way through the turn. Re-key
  // the live run right away, otherwise tapping the conversation as it appears in
  // the list opens a fresh connection and orphans this run.
  const adoptSessionId = (sessionId: string): void => {
    if (connection.claude.sessionId === sessionId) {
      if (!connection.claude.filePath) {
        connection.claude.filePath = claudeSessionFilePath(connection.cwd, sessionId);
        activeClaudeConnections.set(activeKey, connection);
        send(connection.socket, { type: "sessionFile", sessionId, sessionFile: `claude:${connection.claude.filePath}` });
      }
      return;
    }
    if (activeClaudeConnections.get(activeKey) === connection) activeClaudeConnections.delete(activeKey);
    const previousQueueKey = claudeQueueKey(connection);
    connection.claude.sessionId = sessionId;
    connection.claude.filePath = claudeSessionFilePath(connection.cwd, sessionId);
    activeKey = claudeConnectionKey(connection.project.id, sessionId);
    rekeyQueuedPrompts(previousQueueKey, claudeQueueKey(connection));
    activeClaudeConnections.set(activeKey, connection);
    send(connection.socket, { type: "sessionFile", sessionId, sessionFile: `claude:${connection.claude.filePath}` });
  };
  const onSessionId = (sessionId: string): void => {
    markClaudeRunning(claudeSessionFilePath(connection.cwd, sessionId));
    adoptSessionId(sessionId);
    // The attachments belong to the id the engine settled on, not the one guessed at connect.
    persistConversationSecretAccounts("claude", sessionId, connection.secretAccountIds)
      .catch((error) => console.warn("Could not save conversation secret accounts", error));
  };
  if (connection.claude.filePath) markClaudeRunning(connection.claude.filePath);

  const runOptions = {
    model: connection.claude.model ?? undefined,
    effort: connection.claude.effort ?? undefined,
    tools: connection.claude.enabledTools ?? undefined,
  };
  try {
    let result = await runStubbedClaudePrompt(connection, fullPrompt, onEvent);
    if (!result) {
      const run = runClaudePrompt({
        cwd: connection.cwd,
        prompt: fullPrompt,
        env: agentEnvironment(connection.project.id, conversationScope),
        resumeSessionId: connection.claude.filePath ? connection.claude.sessionId ?? undefined : undefined,
        sessionId: connection.claude.filePath ? undefined : connection.claude.sessionId ?? undefined,
        ...runOptions,
        onEvent,
        onSessionId,
      });
      connection.claude.child = run.child;
      sendClaudeStatus(connection);
      result = await run.done;
    }

    if (!result.ok && !result.sawOutput) throw new Error("Claude turn failed before producing output");

    connection.claude.child = null;
    connection.claude.lastRunEndedAt = Date.now();
    if (result.tools) connection.claude.availableTools = [...result.tools].sort();
    if (result.sessionId) {
      connection.claude.sessionId = result.sessionId;
      connection.claude.filePath = claudeSessionFilePath(connection.cwd, result.sessionId);
      send(connection.socket, { type: "sessionFile", sessionId: connection.claude.sessionId, sessionFile: `claude:${connection.claude.filePath}` });
    }
    if (result.assistantText) pushTranscript(connection, "assistant", result.assistantText);
    send(connection.socket, { type: "agent_end" });
    sendClaudeStatus(connection);
  } finally {
    connection.claude.child = null;
    if (activeClaudeConnections.get(activeKey) === connection) activeClaudeConnections.delete(activeKey);
    connection.claude.liveEvents = [];
    for (const key of runningKeys) runningClaudeSessionPaths.delete(key);
  }
  broadcastToProject(connection.project.id, { type: "sessionsChanged" });
  scheduleReviewNotifications(connection.project.id);
}

const drainingClaudeQueues = new Set<string>();

async function drainClaudePromptQueue(connection: ChatConnection): Promise<void> {
  if (updatePreparing) return;
  // Two clients watching one conversation each hold their own connection, so the
  // drain, not the connection, is what has to be single.
  const queueKey = claudeQueueKey(connection);
  if (drainingClaudeQueues.has(queueKey)) return;
  drainingClaudeQueues.add(queueKey);
  try {
    await drainClaudePrompts(connection);
  } finally {
    drainingClaudeQueues.delete(queueKey);
  }
}

async function drainClaudePrompts(connection: ChatConnection): Promise<void> {
  while (!connection.claude.child && connection.claude.promptQueue.length) {
    const queued = connection.claude.promptQueue.shift()!;
    // Handing it to the agent ends its pending life: the transcript records it
    // from here, so a replay must not offer it a second time.
    if (!claimQueuedPrompt(queued.id)) continue;
    send(connection.socket, { type: "queueUpdate", pending: connection.claude.promptQueue.length });
    send(connection.socket, { type: "promptStarted", queueId: queued.id });
    await runClaudeTurn(connection, queued.promptText, queued.displayText, !queued.acknowledged);
  }
}

async function handleClaudeCommand(connection: ChatConnection, payload: SocketPayload): Promise<void> {
  if (payload.type === "abort") {
    connection.claude.child?.kill("SIGTERM");
    return;
  }
  if (payload.type === "prompt") {
    const imageAttachments = await persistImageAttachments(connection.cwd, payload.images ?? []);
    const fileAttachments = await persistFileAttachments(connection.cwd, payload.files ?? []);
    const promptText = promptTextWithAttachments(payload.message ?? "", imageAttachments, fileAttachments);
    if (!promptText) return;
    await resumeReviewedTask(connection);
    const displayText = promptDisplayText(payload.message ?? "", imageAttachments.map((image) => image.name), fileAttachments.map((file) => file.name));
    const acknowledged = Boolean(connection.claude.child || connection.claude.promptQueue.length);
    const stored = enqueuePrompt(claudeQueueKey(connection), promptText, displayText);
    if (acknowledged) send(connection.socket, { type: "userMessage", text: displayText, queued: true, queueId: stored.id });
    connection.claude.promptQueue.push({ ...stored, acknowledged });
    send(connection.socket, { type: "queueUpdate", pending: connection.claude.promptQueue.length });
    await drainClaudePromptQueue(connection);
    return;
  }
  if (connection.claude.child) throw new Error(`Cannot ${payload.type} while Claude is working`);
  if (payload.type === "setModel") {
    if (!payload.modelId || !CLAUDE_MODELS.includes(payload.modelId)) throw new Error(`Claude model must be one of: ${CLAUDE_MODELS.join(", ")}`);
    connection.claude.model = payload.modelId;
    sendClaudeStatus(connection);
    return;
  }
  if (payload.type === "setEffort") {
    if (!payload.effort) throw new Error("Missing effort level");
    connection.claude.effort = payload.effort === "default" ? null : payload.effort;
    sendClaudeStatus(connection);
    return;
  }
  if (payload.type === "models") {
    send(connection.socket, { type: "models", models: await listAvailableModels() });
    return;
  }
  if (payload.type === "tools") {
    send(connection.socket, { type: "tools", supported: true, tools: claudeTools(connection) });
    return;
  }
  if (payload.type === "setTools") {
    if (!payload.toolNames) throw new Error("Missing tool selection");
    if (!connection.claude.availableTools.length) throw new Error("Claude has not reported its tools yet — send a message first");
    const available = new Set(connection.claude.availableTools);
    const unknown = payload.toolNames.find((name) => !available.has(name));
    if (unknown) throw new Error(`Unknown tool: ${unknown}`);
    connection.claude.enabledTools = payload.toolNames;
    send(connection.socket, { type: "tools", supported: true, tools: claudeTools(connection) });
    return;
  }
  if (payload.type === "compact") {
    // Claude has no out-of-band compaction API in print mode; the CLI's own
    // /compact command drives it, streamed through the same turn machinery.
    const message = payload.message?.trim();
    const display = ["/compact", message].filter(Boolean).join(" ");
    connection.claude.compacting = true;
    sendClaudeStatus(connection);
    try {
      await runClaudeTurn(connection, display, display);
    } finally {
      connection.claude.compacting = false;
      sendClaudeStatus(connection);
    }
    send(connection.socket, { type: "sessionsChanged" });
    return;
  }
  // Thinking/rename commands only apply to the Pi engine.
}

function claudeTools(connection: ChatConnection): Array<{ name: string; description: string; active: boolean }> {
  const enabled = connection.claude.enabledTools;
  return connection.claude.availableTools
    .map((name) => ({ name, description: "", active: enabled ? enabled.includes(name) : true }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function switchEngine(connection: ChatConnection, engine: ChatEngine): Promise<void> {
  if (engine === connection.engine) return;

  if (engine === "claude") {
    const transcript = connection.shared ? simplifyMessages(connection.shared.handle.session.messages as unknown[]) : [];
    if (connection.shared) {
      connection.shared.clients.delete(connection.socket);
      scheduleIdleDispose(connection.shared);
      connection.shared = null;
    }
    const local = await getClusterNode();
    const sessionId = randomUUID();
    await claimConversationAcrossCluster("claude", sessionId, local.id);
    await ensureConversationRecord(connection.project.id, "claude", sessionId, local.id);
    connection.engine = "claude";
    connection.claude = { ...emptyClaudeState(sessionId), transcript };
    connection.handoffContext = transcript.length ? buildHandoffContext(transcript) : null;
    claudeClients.set(connection.socket, connection);
    send(connection.socket, { type: "engineChanged", engine: "claude" });
    sendClaudeStatus(connection);
    return;
  }

  connection.claude.child?.kill("SIGTERM");
  activeClaudeConnections.delete(claudeConnectionKey(connection.project.id, connection.claude.sessionId));
  claudeClients.delete(connection.socket);
  const transcript = connection.claude.transcript;
  connection.handoffContext = transcript.length ? buildHandoffContext(transcript) : null;
  const local = await getClusterNode();
  const sessionId = randomUUID();
  await claimConversationAcrossCluster("pi", sessionId, local.id);
  await ensureConversationRecord(connection.project.id, "pi", sessionId, local.id);
  const sharedSession = await getSharedSession(connection.project.id, connection.cwd, undefined, sessionId, connection.secretAccountIds);
  sharedSession.clients.add(connection.socket);
  connection.shared = sharedSession;
  connection.engine = "pi";
  send(connection.socket, { type: "engineChanged", engine: "pi" });
  send(connection.socket, { type: "sessionFile", sessionId: sharedSession.handle.session.sessionId, sessionFile: sharedSession.handle.session.sessionFile ?? null });
  sendStatus(connection.socket, sharedSession.handle);
}

async function handleChatMessage(connection: ChatConnection, raw: Buffer): Promise<void> {
  const payload = socketMessageSchema.parse(JSON.parse(raw.toString()));

  if (payload.type === "ping") {
    send(connection.socket, { type: "pong" });
    return;
  }

  if (updatePreparing) throw new Error("Server update in progress");

  if (payload.type === "setEngine") {
    if (!payload.engine) throw new Error("Missing engine");
    await switchEngine(connection, payload.engine);
    return;
  }

  if (payload.type !== "models") {
    const sessionId = connection.engine === "claude" ? connection.claude.sessionId : connection.shared?.handle.session.sessionId;
    if (!sessionId) throw new Error("Conversation has no ownership identity");
    await requireLocalConversationOwner(connection.engine, sessionId);
  }
  if (connection.engine === "claude") {
    await handleClaudeCommand(connection, payload);
    return;
  }

  const shared = connection.shared;
  if (!shared) throw new Error("No active Pi session");
  await handlePiCommand(connection, shared, payload);
}

async function runStubbedPiPrompt(shared: SharedPiSession, promptText: string): Promise<boolean> {
  if (!await logStubbedEngineInvocation("pi")) return false;
  const sessionFile = shared.handle.session.sessionFile;
  if (!sessionFile) throw new Error("Stubbed Pi session has no transcript path");
  const timestamp = new Date().toISOString();
  const userId = randomUUID();
  const records = [
    { type: "message", id: userId, parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.parse(timestamp) } },
    { type: "message", id: randomUUID(), parentId: userId, timestamp, message: { role: "assistant", content: [{ type: "text", text: "stubbed response" }], timestamp: Date.parse(timestamp) } },
  ];
  await appendFile(sessionFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  broadcast(shared, { type: "textDelta", delta: "stubbed response" });
  broadcast(shared, { type: "agent_end" });
  return true;
}

async function handlePiCommand(connection: ChatConnection, shared: SharedPiSession, payload: SocketPayload): Promise<void> {
  const handle = shared.handle;
  const socket = connection.socket;
  const cwd = connection.cwd;

  if (payload.type === "prompt") {
    await reloadPiAuth();
    const imageAttachments = await persistImageAttachments(cwd, payload.images ?? []);
    const fileAttachments = await persistFileAttachments(cwd, payload.files ?? []);
    let promptText = promptTextWithAttachments(payload.message ?? "", imageAttachments, fileAttachments);
    if (!promptText) return;
    await resumeReviewedTask(connection);
    if (connection.handoffContext) {
      promptText = `${connection.handoffContext}${promptText}`;
      connection.handoffContext = null;
    }
    send(socket, { type: "userMessage", text: promptDisplayText(payload.message ?? "", imageAttachments.map((image) => image.name), fileAttachments.map((file) => file.name)) });
    const options = {
      ...(handle.session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
      ...(payload.images?.length
        ? {
            images: payload.images.map((image) => ({
              type: "image" as const,
              data: image.data,
              mimeType: image.mimeType,
            })),
          }
        : {}),
    };
    if (handle.session.isStreaming) send(socket, { type: "queueUpdate", pending: handle.session.pendingMessageCount + 1 });
    // The engine only reports streaming for real turns; the wrapper also covers stubbed
    // test turns, and gives the runtime lease loop an honest in-flight marker.
    shared.turnInFlight += 1;
    broadcastToProject(connection.project.id, { type: "sessionsChanged" });
    try {
      if (!await runStubbedPiPrompt(shared, promptText)) await handle.session.prompt(promptText, options);
    } finally {
      shared.turnInFlight -= 1;
      broadcastToProject(connection.project.id, { type: "sessionsChanged" });
    }
    send(socket, { type: "sessionsChanged" });
    sendStatus(socket, handle);
    return;
  }

  if (payload.type === "tools") {
    send(socket, { type: "tools", supported: true, tools: piTools(handle) });
    return;
  }

  if (payload.type === "setTools") {
    if (!payload.toolNames) throw new Error("Missing tool selection");
    if (sessionIsBusy(handle)) throw new Error("Wait for the Pi session to finish before changing tools");
    const available = new Set(handle.session.getAllTools().map((tool) => tool.name));
    const unknown = payload.toolNames.find((name) => !available.has(name));
    if (unknown) throw new Error(`Unknown tool: ${unknown}`);
    shared.lastLocalEventAt = Date.now();
    handle.session.sessionManager.appendCustomEntry("joint-bob:tools", { enabledTools: payload.toolNames });
    handle.session.setActiveToolsByName(payload.toolNames);
    broadcastTools(shared);
    broadcastStatus(shared);
    return;
  }

  if (payload.type === "compact") {
    if (sessionIsBusy(handle)) throw new Error("Wait for the Pi session to finish before compacting");
    const compaction = handle.session.compact(payload.message?.trim() || undefined);
    broadcastStatus(shared);
    await compaction;
    send(socket, { type: "sessionsChanged" });
    broadcastStatus(shared);
    return;
  }

  if (payload.type === "setSafeguards") {
    if (typeof payload.safeguardsEnabled !== "boolean") throw new Error("Missing safeguards state");
    await setSharedSessionSafeguards(shared, payload.safeguardsEnabled);
    return;
  }

  if (payload.type === "rename") {
    handle.session.setSessionName(payload.name?.trim() ?? "");
    sendStatus(socket, handle);
    send(socket, { type: "sessionsChanged" });
    return;
  }

  if (payload.type === "models") {
    send(socket, { type: "models", models: await listAvailableModels() });
    return;
  }

  if (payload.type === "setModel") {
    if (!payload.provider || !payload.modelId) throw new Error("Missing model selection");
    await setSessionModel(handle.session, payload.provider, payload.modelId);
    sendStatus(socket, handle);
    return;
  }

  if (payload.type === "cycleModel") {
    await handle.session.cycleModel();
    sendStatus(socket, handle);
    return;
  }

  if (payload.type === "setThinking") {
    if (!payload.level) throw new Error("Missing thinking level");
    handle.session.setThinkingLevel(payload.level);
    sendStatus(socket, handle);
    return;
  }

  if (payload.type === "cycleThinking") {
    handle.session.cycleThinkingLevel();
    sendStatus(socket, handle);
    return;
  }

  if (payload.type === "abort") {
    handle.session.abortRetry();
    handle.session.abortCompaction();
    handle.session.abortBranchSummary();
    handle.session.abortBash();
    await handle.session.abort();
    sendStatus(socket, handle);
  }
}

function closeProxiedSocket(socket: WebSocket, code: number, reason: Buffer): void {
  if ([1005, 1006].includes(code)) socket.close();
  else socket.close(code, webSocketCloseReason(reason.toString()));
}

function proxySocket(socket: WebSocket, upstream: WebSocket): void {
  let closing = false;
  const connectionTimeout = setTimeout(() => fail("Execution node connection timed out"), 10_000).unref();
  const fail = (reason: string): void => {
    if (closing) return;
    closing = true;
    clearTimeout(connectionTimeout);
    upstream.terminate();
    socket.close(1011, webSocketCloseReason(reason));
  };
  upstream.once("open", () => clearTimeout(connectionTimeout));
  upstream.on("message", (raw, isBinary) => {
    if (socket.readyState === socket.OPEN) socket.send(raw, { binary: isBinary });
  });
  socket.on("message", (raw, isBinary) => {
    if (upstream.readyState === upstream.OPEN) upstream.send(raw, { binary: isBinary });
  });
  upstream.once("close", (code, reason) => {
    if (closing) return;
    closing = true;
    clearTimeout(connectionTimeout);
    closeProxiedSocket(socket, code, reason);
  });
  socket.once("close", (code, reason) => {
    if (closing) return;
    closing = true;
    clearTimeout(connectionTimeout);
    closeProxiedSocket(upstream, code, reason);
  });
  upstream.once("unexpected-response", (_request, response) => fail(`Execution node rejected connection (${response.statusCode})`));
  upstream.on("error", () => fail("Execution node connection failed"));
}

webSocketServer.on("connection", async (socket, request) => {
  const host = request.headers.host;
  const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : "";
  const machineBearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  const machineAuthenticated = Boolean(machineBearer && machineTokenMatches(machineBearer, await getClusterMachineToken()));
  const origin = request.headers.origin;
  const cookiePrefix = `${sessionCookieName}=`;
  const session = sessionForId(request.headers.cookie?.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(cookiePrefix))?.slice(cookiePrefix.length));
  let browserAuthenticated = false;
  try {
    browserAuthenticated = Boolean(host && typeof origin === "string" && new URL(origin).host === host && session && !session.mustChangePassword);
  } catch {
    browserAuthenticated = false;
  }
  if (!machineAuthenticated && !browserAuthenticated) {
    socket.close(1008, "Unauthorized");
    return;
  }

  const url = new URL(request.url ?? "/", `http://${host || "localhost"}`);
  const projectId = url.searchParams.get("projectId") ?? "";
  const project = await getProject(projectId);
  if (!project) {
    socket.close(1008, "Project not found");
    return;
  }
  const taskIdResult = socketTaskIdSchema.safeParse(url.searchParams.get("taskId"));
  if (url.searchParams.has("taskId") && !taskIdResult.success) {
    socket.close(1008, "Invalid task ID");
    return;
  }
  const taskId = taskIdResult.success ? taskIdResult.data : undefined;
  const rawSessionPathFromUrl = url.searchParams.get("sessionPath");
  const canMatchTaskSession = rawSessionPathFromUrl && !["new", "watch", "claude:new"].includes(rawSessionPathFromUrl);
  const tasks = taskId || canMatchTaskSession ? await listTasks(project.id) : [];
  const task = taskId
    ? tasks.find((candidate) => candidate.id === taskId)
    : tasks.find((candidate) => candidate.sessionPath === rawSessionPathFromUrl);
  if (taskId && !task) {
    socket.close(1008, "Task not found");
    return;
  }
  const local = await getClusterNode();
  if (task?.executionState === "handoff_pending") {
    socket.close(1008, "Task handoff is awaiting destination commit");
    return;
  }
  if (task && task.currentNodeId !== local.id) {
    const peer = await ownerPeer(task, local.id);
    if (!peer) {
      socket.close(1011, "Task owner is unavailable");
      return;
    }
    const ownerUrl = new URL("/ws", peer.url);
    ownerUrl.protocol = ownerUrl.protocol === "https:" ? "wss:" : "ws:";
    ownerUrl.searchParams.set("projectId", project.id);
    ownerUrl.searchParams.set("sessionPath", rawSessionPathFromUrl ?? "new");
    ownerUrl.searchParams.set("taskId", task.id);
    // A terminal socket must stay a terminal socket on the owner, not become a session.
    if (url.searchParams.get("mode") === "terminal") ownerUrl.searchParams.set("mode", "terminal");
    proxySocket(socket, new WebSocket(ownerUrl, { headers: { Authorization: `Bearer ${peer.token}` } }));
    return;
  }
  const requestedNodeId = url.searchParams.get("nodeId");
  const requestedSessionId = url.searchParams.get("sessionId");
  const routingDraft = parseConversationDraftPath(rawSessionPathFromUrl);
  const routingEngine: ConversationEngine = routingDraft?.engine ?? (rawSessionPathFromUrl?.startsWith("claude:") ? "claude" : "pi");
  if (browserAuthenticated && !task) {
    const ownership = requestedSessionId ? await getConversationOwnership(routingEngine, requestedSessionId) : undefined;
    const targetNodeId = ownership?.ownerNodeId ?? requestedNodeId;
    if (targetNodeId && targetNodeId !== local.id) {
      const peer = await getClusterPeer(targetNodeId);
      if (!peer) { socket.close(1011, "Execution node is unavailable"); return; }
      const ownerUrl = new URL("/ws", peer.url);
      ownerUrl.protocol = ownerUrl.protocol === "https:" ? "wss:" : "ws:";
      for (const [key, value] of url.searchParams) ownerUrl.searchParams.set(key, value);
      if (!requestedSessionId && ["new", "claude:new"].includes(rawSessionPathFromUrl ?? "")) {
        const sessionId = randomUUID();
        await ensureConversationRecord(project.id, routingEngine, sessionId, local.id);
        ownerUrl.searchParams.set("sessionId", sessionId);
      }
      ownerUrl.searchParams.delete("nodeId");
      ownerUrl.searchParams.set("nodeSession", "1");
      proxySocket(socket, new WebSocket(ownerUrl, { headers: { Authorization: `Bearer ${peer.token}` } }));
      return;
    }
  }
  if (machineAuthenticated) {
    const routedSession = url.searchParams.get("nodeSession") === "1";
    if (!task && !routedSession) {
      socket.close(1008, "Unauthorized");
      return;
    }
  }
  // Only a browser sitting on this node is blocked. A socket routed here by a peer already
  // passed that peer's check, and the read-only `watch` socket below is never blocked.
  const heldLock = browserAuthenticated ? await getProjectLock(project.id) : undefined;
  const lockedByPeer = heldLock && heldLock.nodeId !== local.id ? heldLock : undefined;

  if (url.searchParams.get("mode") === "terminal") {
    if (lockedByPeer) {
      socket.close(1008, `Project is locked by ${lockedByPeer.nodeName}`);
      return;
    }
    attachTerminalSession(socket, task ? taskCwd(project, task) : project.path, local.id);
    return;
  }

  let rawSessionPath = rawSessionPathFromUrl;
  const sessionSearchProject = { ...project, additionalPaths: tasks.flatMap((candidate) => candidate.worktreePath ? [candidate.worktreePath] : []) };
  let listedSessions: SessionSummary[] | undefined;
  // Chosen in the new-conversation dialog; a conversation has no id yet at this point, so the
  // accounts travel with the connection until the engine reports one (FR9.4).
  const secretAccountIds = socketSecretAccountIdsSchema.parse((url.searchParams.get("secretAccountIds") ?? "").split(",").filter(Boolean));
  if (requestedSessionId && rawSessionPath !== "watch") {
    listedSessions = await listHarnessSessions(sessionSearchProject);
    const matching = listedSessions.find((candidate) => candidate.id === requestedSessionId);
    if (matching) rawSessionPath = matching.path;
  }
  if (rawSessionPath === "watch") {
    // Session dirs may have appeared since startup (first session, new sync).
    sessionWatcher.ensureProject(project);
    const clients = watchClients.get(project.id) ?? new Set<WebSocket>();
    clients.add(socket);
    watchClients.set(project.id, clients);
    send(socket, { type: "watchReady" });
    socket.on("message", (raw) => {
      const payload = JSON.parse((raw as Buffer).toString()) as { type?: string };
      if (payload.type === "ping") send(socket, { type: "pong" });
    });
    socket.on("close", () => clients.delete(socket));
    return;
  }

  if (lockedByPeer) {
    socket.close(1008, `Project is locked by ${lockedByPeer.nodeName}`);
    return;
  }

  const draft = parseConversationDraftPath(rawSessionPath);
  const requestedEngine: ConversationEngine = draft?.engine ?? (rawSessionPath?.startsWith("claude:") ? "claude" : "pi");
  const requestedSessionPath = draft ? undefined : parseSessionPath(rawSessionPath);
  const recovered = requestedSessionPath ? recoveredClaudeChats.get(claudeRunKey(project.id, requestedSessionPath)) : undefined;
  const requestedTask = requestedSessionPath ? tasks.find((candidate) => candidate.sessionPath === requestedSessionPath) : undefined;
  const cwd = requestedTask ? taskCwd(project, requestedTask) : project.path;
  // Ticket conversations live in the ticket workspace, not the project directory,
  // so this must search the same paths the conversation list searches.
  if ((requestedSessionPath || draft) && !listedSessions) listedSessions = await listHarnessSessions(sessionSearchProject);
  const listedSession = listedSessions?.find((candidate) => candidate.path === (draft ? rawSessionPath : requestedSessionPath));
  if ((requestedSessionPath || draft) && !listedSession) {
    socket.close(1008, "Conversation not found");
    return;
  }
  if (draft && (!listedSession?.draft || listedSession.id !== draft.sessionId || !await getConversationRecord(project.id, draft.engine, draft.sessionId))) {
    socket.close(1008, "Conversation not found");
    return;
  }
  const validRequestedSessionId = requestedSessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedSessionId) ? requestedSessionId : undefined;
  const ownershipSessionId = listedSession && !listedSession.draft ? listedSession.id : draft?.sessionId ?? validRequestedSessionId ?? randomUUID();
  let foreignOwner: ForeignConversationOwner | null = null;
  try {
    foreignOwner = await openConversationOwnership(requestedEngine, ownershipSessionId, local.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Conversation ownership claim failed";
    // A new conversation with no owner is unusable, but an existing one still
    // reads fine: the send-time fence catches whatever the claim could not.
    if (!listedSession) {
      socket.close(1008, webSocketCloseReason(message));
      return;
    }
    console.warn("Conversation ownership claim failed on open", error);
  }
  if (!listedSession || listedSession.draft) {
    try {
      await ensureConversationRecord(project.id, requestedEngine, ownershipSessionId, local.id);
    } catch (error) {
      // A browser still naming a conversation that was deleted (here or on a peer)
      // must get a close, not an unhandled rejection that kills the node.
      if (error instanceof Error && error.message === "Conversation record was deleted") {
        socket.close(1008, webSocketCloseReason("Conversation not found"));
        return;
      }
      throw error;
    }
  }
  let connection: ChatConnection = {
    socket, project, taskId: task?.id ?? null, cwd, engine: "pi", shared: null,
    claude: emptyClaudeState(ownershipSessionId), handoffContext: null, secretAccountIds,
  };

  if (requestedEngine === "claude") {
    // The client sends the conversation-list summary id (`claude:<id>.jsonl`),
    // which never matches the bare run id, so resolve the id from the path.
    const requestedClaudeId = requestedSessionPath ? claudeRunIdFromSessionPath(requestedSessionPath) : ownershipSessionId;
    const active = activeClaudeConnections.get(claudeConnectionKey(project.id, requestedClaudeId));
    if (recovered) {
      connection = {
        socket, project, taskId: task?.id ?? null, cwd, engine: "claude", shared: null,
        claude: recovered.claude, handoffContext: null, secretAccountIds,
      };
      connection.claude.sessionName = listedSession?.title ?? null;
      recovered.connection = connection;
    } else if (active?.claude.child) {
      active.socket = socket;
      connection = active;
    } else {
      connection.engine = "claude";
      if (requestedSessionPath) {
        try {
          connection.claude.transcript = await loadClaudeMessages(requestedSessionPath);
          connection.claude.contextUsage = await claudeSessionContextUsage(requestedSessionPath) ?? null;
          connection.claude.filePath = path.resolve(requestedSessionPath.replace(/^claude:/, ""));
          connection.claude.sessionId = path.basename(connection.claude.filePath, ".jsonl");
          connection.claude.sessionName = listedSession?.title ?? null;
        } catch (error) {
          send(socket, { type: "error", error: error instanceof Error ? error.message : "Could not load Claude session" });
        }
      }
    }
    claudeClients.set(socket, connection);
    send(socket, {
      type: "ready",
      project,
      engine: "claude",
      sessionId: connection.claude.sessionId ?? "claude:new",
      sessionFile: connection.claude.filePath ? `claude:${connection.claude.filePath}` : null,
      messages: connection.claude.transcript,
      status: claudeStatus(connection),
      ownership: foreignOwner,
      executionNodeId: local.id,
    });
    // Replay the in-flight turn so a reconnecting client sees the text and tool
    // calls that streamed while its socket was down.
    for (const event of connection.claude.liveEvents) send(socket, event);
    // The queue belongs to the conversation, not to the socket that typed into
    // it, so a reconnect sees what is still pending and a node that restarted
    // with prompts on disk picks them up here.
    if (!connection.claude.promptQueue.length) {
      connection.claude.promptQueue = listQueuedPrompts(claudeQueueKey(connection)).map((prompt) => ({ ...prompt, acknowledged: true }));
    }
    send(socket, { type: "queuedPrompts", prompts: connection.claude.promptQueue.map(({ id, displayText }) => ({ id, text: displayText })) });
    if (!foreignOwner) void drainClaudePromptQueue(connection).catch((error) => send(socket, { type: "error", error: chatErrorMessage(error) }));
  } else {
    let sharedSession: SharedPiSession;
    try {
      sharedSession = await getSharedSession(project.id, cwd, requestedSessionPath, ownershipSessionId, secretAccountIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start Pi session";
      send(socket, { type: "error", error: message });
      socket.close(1011, webSocketCloseReason(message));
      return;
    }

    connection.shared = sharedSession;
    sharedSession.clients.add(socket);
    send(socket, {
      type: "ready",
      project,
      engine: "pi",
      sessionId: sharedSession.handle.session.sessionId,
      sessionFile: sharedSession.handle.session.sessionFile,
      messages: simplifyMessages(sharedSession.handle.session.messages as unknown[]),
      status: getSessionStatus(sharedSession.handle.session, sharedSession.handle.safeguardsEnabled),
      ownership: foreignOwner,
      executionNodeId: local.id,
    });
  }

  socket.on("message", async (raw) => {
    try {
      await handleChatMessage(connection, raw as Buffer);
    } catch (error) {
      const message = chatErrorMessage(error);
      send(socket, { type: "error", error: message });
      if (error instanceof ConversationOwnershipError) {
        send(socket, { type: "ownership", ownership: await describeConversationOwner(error.ownership, local.id) });
      }
      if (connection.engine === "pi" && connection.shared) sendStatus(socket, connection.shared.handle);
    }
  });

  socket.on("close", () => {
    if (connection.shared) {
      connection.shared.clients.delete(socket);
      scheduleIdleDispose(connection.shared);
    }
    // Claude owns its child process on this execution node. Browser and proxy
    // disconnects must not cancel an in-flight turn.
    claudeClients.delete(socket);
    if (recovered && recovered.connection === connection) recovered.connection = null;
  });
});

/* Syncthing is often still binding its API port when the node boots beside it. A
   single failed attempt used to leave the node "starting" for its whole lifetime,
   which silently disables peer project discovery, so the attempt repeats from the
   maintenance interval until it succeeds. Repeats of the same failure stay quiet;
   the completion line is what says the node recovered. */
async function initializeStartupReadiness(): Promise<void> {
  if (startupReady || startupReadinessInProgress) return;
  startupReadinessInProgress = true;
  try {
    const projects = await listProjects();
    await reconcileSyncthingProjectFolders(projects);
    startupReady = true;
    startupError = undefined;
    console.log("Startup reconciliation completed.");
  } catch (error) {
    const failure = error instanceof Error ? error : new Error("Startup reconciliation failed");
    if (startupError?.message !== failure.message) console.warn("Startup reconciliation failed, retrying", failure);
    startupError = failure;
  } finally {
    startupReadinessInProgress = false;
  }
}

async function configureTicketWorkspacePeer(peer: ClusterPeer, localDeviceId: string, localDeviceName: string): Promise<void> {
  const inventory = await fetchPeerInventory(peer);
  if (!inventory.syncDeviceId) throw new Error("Peer Syncthing device ID is unavailable");
  await ensureTicketWorkspaceFolder(ticketWorkspaceRoot(), inventory.syncDeviceId, inventory.node.name);
  for (const folderId of [TICKET_WORKSPACE_FOLDER_ID]) {
    const response = await fetch(`${peer.url}/api/cluster/sync/share`, {
      method: "POST",
      headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ folderId, deviceId: localDeviceId, deviceName: localDeviceName }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Peer managed folder share failed: ${response.status}`);
  }
}

async function reconcileTicketWorkspaceSync(): Promise<void> {
  if (ticketWorkspaceSyncInProgress || Date.now() < ticketWorkspaceSyncRetryAt) return;
  ticketWorkspaceSyncInProgress = true;
  let failed = false;
  try {
    const peers = await listClusterPeers();
    const localDeviceId = await syncthingDeviceId();
    if (!localDeviceId) return;
    await pauseEngineSyncFolders();
    await ensureTicketWorkspaceFolder();
    if (!peers.length) return;
    const localNode = await getClusterNode();
    for (const peer of peers) {
      if (configuredTicketWorkspacePeers.has(peer.id)) continue;
      try {
        await configureTicketWorkspacePeer(peer, localDeviceId, localNode.name);
        configuredTicketWorkspacePeers.add(peer.id);
      } catch (error) {
        failed = true;
        console.warn(`Ticket workspace sync to ${peer.id} failed`, error);
      }
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (failed) ticketWorkspaceSyncRetryAt = Date.now() + 60_000;
    ticketWorkspaceSyncInProgress = false;
  }
}

async function flushMembershipOutbox(): Promise<void> {
  if (membershipFlushInProgress) return;
  membershipFlushInProgress = true;
  try {
    for (const delivery of await dueMembershipDeliveries()) {
      const peer = await getClusterPeer(delivery.peerId);
      if (!peer) continue;
      try {
        const response = await fetch(`${peer.url}/api/cluster/membership/sync`, {
          method: "POST",
          headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(await getClusterMembership()),
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`Peer returned ${response.status}`);
        await recordMembershipDelivered(peer.id, delivery.generation);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Peer membership sync failed";
        await recordMembershipFailure(peer.id, delivery.generation, message);
        console.warn(`Membership sync to ${peer.id} failed: ${message}`);
      }
    }
  } finally {
    membershipFlushInProgress = false;
  }
}

async function reconcileTaskHandoffs(): Promise<void> {
  if (taskHandoffReconciliationInProgress) return;
  taskHandoffReconciliationInProgress = true;
  try {
    for (const record of await listUnfinishedOutgoingTaskHandoffs()) {
      const peer = await getClusterPeer(record.destinationNodeId);
      if (!peer) {
        console.warn(`Task handoff ${record.handoffId} reconciliation failed: peer not found`);
        continue;
      }
      try { await reconcileOutgoingTaskHandoff(record, peer); }
      catch (error) { console.warn(`Task handoff ${record.handoffId} reconciliation failed`, error); }
    }
  } finally {
    taskHandoffReconciliationInProgress = false;
  }
}

/** Pushes everything currently enrolled for this peer, one 100-event batch at a time,
    until the peer has acknowledged all of it or a batch fails. */
async function pushSecretCredentialsToPeer(peer: ClusterPeer): Promise<{ delivered: number; error?: string }> {
  let delivered = 0;
  for (;;) {
    const events = await secretCredentialEventsForPeer(peer.id);
    if (!events.length) return { delivered };
    try {
      const response = await fetch(`${peer.url}/api/cluster/secrets/events`, {
        method: "POST",
        headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Peer returned ${response.status}`);
      const receipt = replicationReceiptSchema.parse(await response.json());
      // A peer that acknowledges nothing would loop forever on the same batch.
      if (!receipt.received.length) throw new Error("Peer acknowledged no events");
      await recordSecretCredentialReceipt(peer.id, receipt.received);
      delivered += receipt.received.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Peer secret credential replication failed";
      await recordSecretCredentialFailure(peer.id, events.map((event) => event.id), message);
      console.warn(`Secret credential replication to ${peer.id} failed: ${message}`);
      return { delivered, error: message };
    }
  }
}

/** Retries deliveries an enrolled event still owes a peer, whether a save or a manual sync
    enrolled it. */
async function flushSecretCredentialOutbox(): Promise<void> {
  if (secretCredentialFlushInProgress) return;
  secretCredentialFlushInProgress = true;
  try {
    for (const peer of await listClusterPeers()) await pushSecretCredentialsToPeer(peer);
  } finally {
    secretCredentialFlushInProgress = false;
  }
}

/** A saved account marked to replicate leaves for every paired node right away, so the
    checkbox means what it says. The manual "Sync to nodes" action remains for retries and
    for nodes paired after the save. */
async function replicateSecretAccount(account: SecretAccount, actorId: string): Promise<Array<{ peerId: string; name: string; delivered: number; error?: string }> | undefined> {
  if (!account.replicate) return undefined;
  const peers = await listClusterPeers();
  if (!peers.length) return [];
  await enqueueSecretCredentialSync(peers.map((peer) => peer.id), actorId);
  const results: Array<{ peerId: string; name: string; delivered: number; error?: string }> = [];
  for (const peer of peers) {
    const outcome = await pushSecretCredentialsToPeer(peer);
    results.push({ peerId: peer.id, name: peer.name, delivered: outcome.delivered, ...(outcome.error ? { error: outcome.error } : {}) });
  }
  return results;
}

/** A peer's current conversation running set. See conversation-runtime.ts for the lease rules. */
const RUNTIME_LEASE_TTL_MS = 15_000;

async function buildRuntimeLeaseSnapshot(localNodeId: string): Promise<RuntimeLeaseInput[]> {
  const now = new Date();
  const updatedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + RUNTIME_LEASE_TTL_MS).toISOString();
  const entries = new Map<string, RuntimeLeaseInput>();
  // Advertise only conversations this node is allowed to run: a stale in-flight
  // turn must not borrow the new owner's epoch after a transfer.
  const epochFor = async (engine: "pi" | "claude", sessionId: string): Promise<number | null> => {
    const ownership = await getConversationOwnership(engine, sessionId);
    if (ownership && ownership.ownerNodeId !== localNodeId) return null;
    return ownership?.epoch ?? 1;
  };
  for (const shared of new Set(sharedSessions.values())) {
    const runningAgentRun = [...shared.agentRuns.values()].find((run) => run.summary.status === "running");
    if (!shared.handle.session.isStreaming && shared.turnInFlight === 0 && !runningAgentRun) continue;
    const sessionId = shared.handle.session.sessionId;
    const key = `pi\n${sessionId}`;
    if (entries.has(key)) continue;
    const ownershipEpoch = await epochFor("pi", sessionId);
    if (ownershipEpoch === null) continue;
    entries.set(key, {
      engine: "pi", sessionId, ownerNodeId: localNodeId,
      ownershipEpoch,
      runId: runningAgentRun?.descriptor.runId ?? sessionId, updatedAt, expiresAt,
    });
  }
  for (const connection of claudeClients.values()) {
    const claude = connection.claude;
    if (!claude.sessionId) continue;
    const runningKey = claudeRunKey(connection.project.id, `claude:${claude.filePath ?? ""}`);
    if (!claude.child && !(claude.filePath && runningClaudeSessionPaths.has(runningKey))) continue;
    const key = `claude\n${claude.sessionId}`;
    if (entries.has(key)) continue;
    const ownershipEpoch = await epochFor("claude", claude.sessionId);
    if (ownershipEpoch === null) continue;
    entries.set(key, {
      engine: "claude", sessionId: claude.sessionId, ownerNodeId: localNodeId,
      ownershipEpoch,
      runId: claude.sessionId, updatedAt, expiresAt,
    });
  }
  for (const recovered of recoveredClaudeChats.values()) {
    if (!recovered.claude.sessionId) continue;
    const key = `claude\n${recovered.claude.sessionId}`;
    if (entries.has(key)) continue;
    const ownershipEpoch = await epochFor("claude", recovered.claude.sessionId);
    if (ownershipEpoch === null) continue;
    entries.set(key, {
      engine: "claude", sessionId: recovered.claude.sessionId, ownerNodeId: localNodeId,
      ownershipEpoch,
      runId: recovered.claude.sessionId, updatedAt, expiresAt,
    });
  }
  for (const hook of listRunningClaudeSessions()) {
    const key = `claude\n${hook.sessionId}`;
    if (entries.has(key)) continue;
    const ownershipEpoch = await epochFor("claude", hook.sessionId);
    if (ownershipEpoch === null) continue;
    entries.set(key, {
      engine: "claude", sessionId: hook.sessionId, ownerNodeId: localNodeId,
      ownershipEpoch,
      runId: hook.sessionId, updatedAt, expiresAt,
    });
  }
  return [...entries.values()];
}

let runtimeLeasePushInProgress = false;

async function pushRuntimeLeaseSnapshots(): Promise<void> {
  // Snapshots must be applied in generation order; a push still in flight when the
  // interval fires again is skipped rather than overlapped.
  if (runtimeLeasePushInProgress) return;
  runtimeLeasePushInProgress = true;
  try {
    const peers = await listClusterPeers();
    if (!peers.length) return;
    const local = await getClusterNode();
    const leases = await buildRuntimeLeaseSnapshot(local.id);
    const generatedAt = leases.length ? leases[0].updatedAt : new Date().toISOString();
    // One slow peer must not delay the others past the lease TTL.
    await Promise.all(peers.map(async (peer) => {
      try {
        const response = await fetch(`${peer.url}/api/cluster/sessions/runtime-snapshot`, {
          method: "POST",
          // Our own machine token, so the receiving peer can bind the snapshot to
          // this node's identity instead of trusting the declared nodeId.
          headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ nodeId: local.id, generatedAt, leases }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`Peer returned ${response.status}`);
      } catch (error) {
        console.warn(`Runtime lease push to ${peer.id} failed: ${error instanceof Error ? error.message : "lease replication failed"}`);
      }
    }));
  } finally {
    runtimeLeasePushInProgress = false;
  }
}

/** A crashed peer's leases die silently unless something sweeps them. */
function sweepRuntimeLeases(): void {
  const expired = sweepExpiredRuntimeLeases(conversationRuntimeDatabase());
  if (expired.length) broadcastSessionsChangedToAllProjects();
}

async function flushReplicationOutbox(): Promise<void> {
  if (replicationFlushInProgress) return;
  replicationFlushInProgress = true;
  try {
    for (const peer of await listClusterPeers()) {
      const events = await eventsForPeer(peer.id);
      if (!events.length) continue;
      try {
        const response = await fetch(`${peer.url}/api/cluster/events`, {
          method: "POST",
          headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ events }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Peer returned ${response.status}`);
        const receipt = replicationReceiptSchema.parse(await response.json());
        await recordPeerReceipt(peer.id, receipt.received);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Peer replication failed";
        await recordPeerFailure(peer.id, events.map((event) => event.id), message);
        console.warn(`Replication to ${peer.id} failed: ${message}`);
      }
    }
  } finally {
    replicationFlushInProgress = false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startupReady = false;
  startupError = undefined;
  server.listen(port, "0.0.0.0", () => {
    const address = server.address();
    const listeningPort = typeof address === "object" && address ? address.port : port;
    console.log(`Joint Bob listening on http://0.0.0.0:${listeningPort}`);
    initializeStartupReadiness()
      .then(async () => { await recoverPendingUpdateRuns(); await reconcileTicketWorkspaceSync(); })
      .catch((error) => console.warn("Ticket workspace sync failed", error));
    flushMembershipOutbox().catch((error) => console.warn("Membership flush failed", error));
    flushReplicationOutbox().catch((error) => console.warn("Replication flush failed", error));
    pushRuntimeLeaseSnapshots().catch((error) => console.warn("Runtime lease push failed", error));
    flushSecretCredentialOutbox().catch((error) => console.warn("Secret credential flush failed", error));
    reconcileTaskHandoffs().catch((error) => console.warn("Task handoff reconciliation failed", error));
    discoverMissingPeerProjects().catch((error) => console.warn("Project discovery failed", error));
    setInterval(() => discoverMissingPeerProjects().catch((error) => console.warn("Project discovery failed", error)), 10_000).unref();
    setInterval(() => {
      void initializeStartupReadiness();
      reconcileTicketWorkspaceSync().catch((error) => console.warn("Ticket workspace sync failed", error));
      flushMembershipOutbox().catch((error) => console.warn("Membership flush failed", error));
      flushReplicationOutbox().catch((error) => console.warn("Replication flush failed", error));
      pushRuntimeLeaseSnapshots().catch((error) => console.warn("Runtime lease push failed", error));
      sweepRuntimeLeases();
      flushSecretCredentialOutbox().catch((error) => console.warn("Secret credential flush failed", error));
      reconcileTaskHandoffs().catch((error) => console.warn("Task handoff reconciliation failed", error));
    }, 2_000).unref();
  });
}
