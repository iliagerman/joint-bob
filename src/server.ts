import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, lstat, mkdir, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import { projectNameOverrides, setProjectName, setSessionTitle } from "./names.js";
import { addProject, deleteProjectType, getProject, importProject, listProjects, listProjectTypes, projectAliasIds, ProjectTypeError, registerProjectAliases, removeProject, renameProject, saveProjectType, touchProject, updateProjectColor, updateProjectMacPath, updateProjectSyncFolderId, updateProjectTypeAndPath } from "./store.js";
import { createClusterPeer, dueMembershipDeliveries, getClusterMachineToken, getClusterMembership, getClusterNode, getClusterPeer, listClusterPeers, markClusterPeerSeen, mergeClusterMembership, recordMembershipDelivered, recordMembershipFailure, removeClusterPeer, saveClusterPeer, updateClusterNode, type ClusterPeer } from "./cluster.js";
import { eventsForPeer, receiveReplicationBatch, recordPeerFailure, recordPeerReceipt, type ReplicationBatch } from "./replication.js";
import { deleteGitHubGroup, ensureGitHubCredentialMigration, getGitHubAuthStatus, gitHubEnvironment, githubCredentialEventsForPeer, receiveGitHubCredentialEvents, recordGitHubCredentialFailure, recordGitHubCredentialReceipt, removeProjectGitHubAuth, saveGitHubGroup, updateProjectGitHubAuth, type GitHubCredentialEvent } from "./github-auth.js";
import {
  createPiSession,
  eventPayload,
  getSessionStatus,
  listAvailableModels,
  reloadPiAuth,
  setSessionModel,
  simplifyMessages,
} from "./pi-service.js";
import { deletePushSubscription, getVapidPublicKey, notifySessionFinished, savePushSubscription } from "./push.js";
import { abortOutgoingTaskHandoff, abortPreparedTaskHandoff, acknowledgeIncomingTaskHandoff, acknowledgeOutgoingTaskHandoff, assertTaskCanBeDeleted, beginOutgoingTaskHandoff, claimTaskLease, commitPreparedTaskHandoff, completeTaskHandoff, completeTaskLease, createTask, deleteTask, getTaskHandoff, isTaskHandoffRejected, listTasks, listUnfinishedOutgoingTaskHandoffs, markOutgoingTaskHandoff, prepareTaskHandoff, rejectTaskHandoff, releaseTaskLease, reserveTaskHandoff, taskHandoffDeletion, updateTask, type TaskHandoffRecord } from "./tasks.js";
import { assertTaskWorktreeTransferable, exportTaskBranchBundle, mergeTaskWorktree, prepareTaskWorktreeFromBundle, removePreparedTaskWorktree, TaskWorktreeError, validateTaskRepository, type PreparedTaskWorktree } from "./worktrees.js";
import { assertSyncthingFolderReady, CLAUDE_ENGINE_SYNC_FOLDER_ID, engineSyncFolders, ensureEngineSyncFolders, ensureSyncthingDevice, ensureSyncthingFolder, ensureTicketWorkspaceFolder, PI_ENGINE_SYNC_FOLDER_ID, reconcileSyncthingProjectFolders, rescanSyncthingFolder, syncthingDeviceId, syncthingFolderIdForPath, syncthingFolderStatuses, syncthingPathForFolderId } from "./syncthing.js";
import { assertTaskWorkspaceReady, removeTaskWorkspace, taskWorkspaceKey, TaskWorkspaceError, TICKET_WORKSPACE_FOLDER_ID, ticketWorkspaceRoot } from "./task-workspaces.js";
import { SessionWatcher } from "./watcher.js";
import { buildHandoffContext, claudeSessionFilePath, loadClaudeMessages, runClaudePrompt, type ClaudeRunHandle } from "./claude-service.js";
import { listHarnesses, listHarnessSessions } from "./harnesses.js";
import { listSkills } from "./skills.js";
import { authenticate, authenticationStatus, changePassword, clearSessionCookieValue, createAdministrator, listLoginSessions, revokeSession, revokeUserSession, sessionCookieValue, sessionForId, type AuthSession } from "./auth.js";
import { getSettings, updateSettings } from "./settings.js";
import { ensureManagedHome, managedProjectPath, managedProjectRelocationPath } from "./managed-home.js";
import { importProjectDirectory, ProjectDirectoryImportError, relocateProjectDirectory } from "./project-directory-import.js";
import { listAuditEvents } from "./audit.js";
import { getUserPreferences, updateUserPreferences } from "./preferences.js";
import { markConversationReviewed, syncConversationReviewStates } from "./conversation-reviews.js";
import { resetSyncthingConnection } from "./syncthing.js";
import { PROJECT_COLORS } from "./types.js";
import type { ChatMessage, ProjectRecord, ProjectSyncStatus, ProjectView, SessionStatus, TaskPhase, TaskPhaseConfig, TaskRecord } from "./types.js";
import { webSocketCloseReason } from "./websocket.js";
import { resolveLocalSessionPath } from "./session-paths.js";

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
}

type ChatEngine = "pi" | "claude";

interface ClaudeChatState {
  sessionId: string | null;
  filePath: string | null;
  child: ClaudeRunHandle["child"] | null;
  transcript: ChatMessage[];
  lastRunEndedAt: number;
  model: string | null;
  effort: string | null;
}

// "opus" is pinned to the explicit Opus 5 id so the CLI alias cannot drift.
const CLAUDE_MODEL_LABELS = new Map([
  ["fable", "Claude Fable"],
  ["claude-opus-5", "Claude Opus 5"],
  ["sonnet", "Claude Sonnet"],
  ["haiku", "Claude Haiku 4.5"],
]);
const CLAUDE_MODELS = [...CLAUDE_MODEL_LABELS.keys()];

interface ChatConnection {
  socket: WebSocket;
  project: ProjectRecord;
  cwd: string;
  engine: ChatEngine;
  shared: SharedPiSession | null;
  claude: ClaudeChatState;
  // Transcript summary prepended to the next prompt after an engine switch.
  handoffContext: string | null;
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
  "POST /cluster/sync/share",
  "POST /cluster/sessions/receive",
  "POST /cluster/sessions/transfer",
  "POST /cluster/events",
  "POST /cluster/github/events",
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
]);
export const app = express();
export function createApp(): express.Express {
  return app;
}
export const server = createServer(app);
const webSocketServer = new WebSocketServer({ server, path: "/ws" });
const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../public");
const sharedSessions = new Map<string, SharedPiSession>();
const execFileAsync = promisify(execFile);
const idleSessionTimeoutMs = 30 * 60 * 1000;
// A session file change within this window of local agent activity is our own
// write, not an external Syncthing sync.
const localWriteGraceMs = 15_000;
const watchClients = new Map<string, Set<WebSocket>>();
const claudeClients = new Map<WebSocket, ChatConnection>();
const activeClaudeConnections = new Map<string, ChatConnection>();
let replicationFlushInProgress = false;
let githubCredentialFlushInProgress = false;
let membershipFlushInProgress = false;
let taskHandoffReconciliationInProgress = false;
let ticketWorkspaceSyncInProgress = false;
let projectDiscoveryInProgress = false;
let ticketWorkspaceSyncRetryAt = 0;
const configuredTicketWorkspacePeers = new Set<string>();
let startupReady = true;
let startupError: Error | undefined;

const absolutePathSchema = z.string().trim().min(1).max(1000).refine(path.isAbsolute, "Path must be absolute");
const projectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.string().trim().min(1).max(40).optional().default("personal"),
  path: absolutePathSchema.optional(),
  sourcePath: absolutePathSchema.optional(),
  importMode: z.enum(["copy", "move", "move-link"]).optional(),
  synced: z.boolean().optional(),
  macPath: absolutePathSchema.optional(),
})
  .refine((payload) => !(payload.path && payload.sourcePath), "Project path and import source cannot both be set")
  .refine((payload) => !payload.sourcePath || payload.importMode, { message: "Choose how to import the project", path: ["importMode"] });
const projectPathMappingSchema = z.object({
  macPath: absolutePathSchema,
});
const clusterNodeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().url().max(500),
});
const clusterPeerSchema = z.object({
  url: z.string().url().max(500),
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
const githubGroupIdSchema = z.string().trim().min(1).max(64).regex(/^\S+$/, "GitHub group ID cannot contain spaces");
const githubGroupLabelSchema = z.string().trim().min(1).max(64);
const githubCredentialEventSchema = z.union([
  // `value` accepts the bare token string sent by peers still on the pre-groups build.
  z.object({ id: z.string().uuid(), entityType: z.literal("account"), key: githubGroupIdSchema, operation: z.literal("upsert"), value: z.union([z.string().min(1).max(5000), z.object({ label: githubGroupLabelSchema, token: z.string().min(1).max(5000), isDefault: z.boolean().optional() }).strict()]), updatedAt: z.string().datetime(), originNodeId: z.string().uuid(), createdAt: z.string().datetime() }).strict(),
  z.object({ id: z.string().uuid(), entityType: z.literal("project"), key: z.string().trim().min(1).max(300), operation: z.literal("upsert"), value: z.object({ account: z.string().max(64), token: z.string().min(1).max(5000).nullable() }).strict(), updatedAt: z.string().datetime(), originNodeId: z.string().uuid(), createdAt: z.string().datetime() }).strict(),
  z.object({ id: z.string().uuid(), entityType: z.enum(["account", "project"]), key: z.string().trim().min(1).max(300), operation: z.literal("delete"), updatedAt: z.string().datetime(), originNodeId: z.string().uuid(), createdAt: z.string().datetime() }).strict(),
]);
const githubCredentialBatchSchema = z.object({ events: z.array(githubCredentialEventSchema).max(100) });
const directoryBrowseSchema = z.object({
  path: absolutePathSchema.optional(),
});
const sessionTransferSchema = z.object({
  peerId: z.string().uuid(),
  sourceNodeId: z.string().uuid().optional(),
  sessionId: z.string().min(1).max(240).optional(),
  sessionPath: z.string().min(1),
  sessionName: z.string().trim().max(120).optional(),
});
const routedSessionTransferSchema = sessionTransferSchema.omit({ sourceNodeId: true }).extend({ projectId: z.string().min(1) });
const receivedSessionTransferSchema = z.object({
  projectId: z.string().min(1),
  sessionName: z.string().trim().max(120).optional(),
  messages: z.array(z.object({ id: z.string(), role: z.string(), text: z.string(), toolName: z.string().max(120).optional() })).min(1).max(200),
});
const githubGroupSaveSchema = z.object({
  label: githubGroupLabelSchema,
  token: z.string().trim().min(1).max(5000).optional(),
  isDefault: z.boolean().optional(),
});
const projectGitHubAuthSchema = z.object({
  group: githubGroupIdSchema.nullable(),
  token: z.string().trim().min(1).max(500).nullable().optional(),
});
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
const sessionTitleSchema = z.object({
  sessionPath: z.string().min(1),
  title: z.string().trim().max(200),
});
const taskCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000),
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
  description: z.string().trim().max(4000).optional(),
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
const textAttachmentSchema = z.object({
  name: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(120),
  content: z.string().max(120_000),
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
const userPreferencesSchema = z.object({
  theme: z.enum(["light", "dark"]).nullable().optional(),
  notificationsEnabled: z.boolean().optional(),
  completionSound: z.enum(["off", "chime", "bell"]).optional(),
  installDismissed: z.boolean().optional(),
  mobileView: z.enum(["projects", "sessions", "board", "chat"]).optional(),
  activeProjectId: z.string().trim().min(1).max(120).nullable().optional(),
  activeSessionPath: z.string().trim().min(1).max(2000).nullable().optional(),
  activeSessionId: z.string().trim().min(1).max(200).nullable().optional(),
  activeNodeId: z.string().uuid().nullable().optional(),
  legacyMigrated: z.boolean().optional(),
  pinnedProjectIds: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
  pinnedSessionPaths: z.array(z.string().trim().min(1).max(2000)).max(200).optional(),
  projectsPanelCollapsed: z.boolean().optional(),
  chatsPanelCollapsed: z.boolean().optional(),
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
  textAttachments: z.array(textAttachmentSchema).max(6).optional(),
  safeguardsEnabled: z.boolean().optional(),
});

function sendError(response: Response, statusCode: number, message: string): void {
  response.status(statusCode).json({ error: message });
}

function securityHeaders(_request: Request, response: Response, next: NextFunction): void {
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
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

async function requireHttpAuth(request: Request, response: Response, next: NextFunction): Promise<void> {
  const token = bearerToken(request);
  if (machineRoutes.has(`${request.method} ${request.path}`) && token && machineTokenMatches(token, await getClusterMachineToken())) {
    response.locals.machineAuth = true;
    next();
    return;
  }
  const session = sessionForId(requestCookie(request, "mb_session"));
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

async function fetchPeerInventory(peer: ClusterPeer): Promise<PeerInventory> {
  const response = await fetch(`${peer.url}/api/cluster/local-inventory`, {
    headers: peer.token ? { Authorization: `Bearer ${peer.token}` } : {},
    signal: AbortSignal.timeout(10_000),
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
    const localType = await localProjectTypeId(remoteProject.type);
    const existing = await getProject(remoteProject.id) ?? localProjects.find((project) => remoteProject.syncFolderId !== undefined && project.syncFolderId === remoteProject.syncFolderId);
    if (existing && missingOnly) {
      skipped.push(remoteProject.name);
      continue;
    }
    let localPath = existing?.path;
    if (existing && existing.type !== localType) {
      localPath = (await relocateProjectType(existing, localType)).path;
    }
    if (!localPath && remoteProject.syncFolderId) {
      try {
        localPath = await syncthingPathForFolderId(remoteProject.syncFolderId);
      } catch {
        localPath = undefined;
      }
    }
    if (!existing && !localPath) {
      localPath = managedProjectPath(getSettings().projects.homePath, localType, remoteProject.name);
    }
    if (!existing && !localPath) {
      pending.push({
        peerId: peer.id,
        projectId: remoteProject.id,
        name: remoteProject.name,
        remotePath: remoteProject.path,
        ...(remoteProject.syncFolderId ? { syncFolderId: remoteProject.syncFolderId } : {}),
        suggestedPath: managedProjectPath(getSettings().projects.homePath, localType, remoteProject.name),
      });
      continue;
    }
    const importedProject = !existing && localPath
      ? await mapProjectFromPeer(peer, inventory, entry, localPath)
      : await importProject({ ...remoteProject, type: localType }, localPath, inventory.node.id);
    await registerProjectAliases(importedProject.id, [remoteProject.id, ...(entry.aliases ?? [])]);
    imported.push(remoteProject.name);
  }
  return { imported, skipped, pending };
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

/** A peer can carry a type this node never defined; fall back to a local one rather than inventing a folder. */
async function localProjectTypeId(candidate: string | undefined): Promise<string> {
  const types = await listProjectTypes();
  if (candidate && types.some((type) => type.id === candidate)) return candidate;
  return types[0]?.id ?? "personal";
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
  const project = await importProject({ ...remoteProject, type: await localProjectTypeId(remoteProject.type) }, localPath, inventory.node.id);
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
app.use(express.static(publicDir));
app.use(express.json({ limit: "12mb" }));

app.get("/api/auth/status", (request, response) => {
  response.json(authenticationStatus(sessionForId(requestCookie(request, "mb_session"))));
});

app.get("/api/health", (_request, response) => {
  const release = process.env.JOINT_BOB_RELEASE ?? process.env.MASTER_BOB_RELEASE ?? "development";
  if (!startupReady) {
    response.status(503).json({ status: "starting", release });
    return;
  }
  response.json({ status: "ok", release });
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

app.use("/api", requireHttpAuth, requireCsrf);

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

app.put("/api/preferences", (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    response.json(updateUserPreferences(session.userId, userPreferencesSchema.parse(request.body)));
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
    await ensureManagedHome(homePath, (await listProjectTypes()).map((type) => type.id));
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
    await mergeClusterMembership(remoteSnapshot);
    const peer = await getClusterPeer(peerNode.id);
    if (!peer) throw new Error("Paired peer was not added to cluster membership");
    const confirmation = await fetch(`${peerUrl}/api/cluster/membership/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(await getClusterMembership()),
      signal: AbortSignal.timeout(5_000),
    });
    if (!confirmation.ok) throw new Error(`Peer membership confirmation failed: ${peerUrl} returned ${confirmation.status}`);
    const localImport = await importProjectsFromPeer(peer);
    const importResponse = await fetch(`${peerUrl}/api/cluster/projects/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ peerId: localNode.id }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!importResponse.ok) throw new Error(`Peer project import failed: ${peerUrl} returned ${importResponse.status}`);
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
    await mergeClusterMembership(snapshot);
    response.status(201).json(await getClusterMembership());
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/membership/sync", async (request, response, next) => {
  try {
    const snapshot = clusterMembershipSnapshotSchema.parse(request.body);
    await mergeClusterMembership(snapshot);
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
    response.json({ received: await receiveReplicationBatch(batch) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/github/events", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = githubCredentialBatchSchema.parse(request.body);
    response.json({ received: await receiveGitHubCredentialEvents(payload.events as GitHubCredentialEvent[]) });
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
    if (engineSyncFolders().some((folder) => folder.id === payload.folderId)) {
      await ensureEngineSyncFolders(undefined, payload.deviceId, payload.deviceName);
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
    await savePushSubscription(payload.subscription, payload.projectId, payload.sessionPath, payload.title || "Pi");
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
  response.json({ harnesses: listHarnesses().map(({ id, label, newSessionPath }) => ({ id, label, newSessionPath })) });
});

app.get("/api/models", async (_request, response, next) => {
  try {
    response.json({ models: await listAvailableModels() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/github-auth", async (_request, response, next) => {
  try {
    response.json(await getGitHubAuthStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/github-auth/groups", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    await saveGitHubGroup(githubGroupSaveSchema.parse(request.body), session.userId);
    response.status(201).json(await getGitHubAuthStatus());
  } catch (error) {
    next(error);
  }
});

app.put("/api/github-auth/groups/:groupId", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const payload = githubGroupSaveSchema.parse(request.body);
    await saveGitHubGroup({ id: githubGroupIdSchema.parse(request.params.groupId), ...payload }, session.userId);
    response.json(await getGitHubAuthStatus());
  } catch (error) {
    next(error);
  }
});

app.delete("/api/github-auth/groups/:groupId", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    await deleteGitHubGroup(githubGroupIdSchema.parse(request.params.groupId), session.userId);
    response.json(await getGitHubAuthStatus());
  } catch (error) {
    next(error);
  }
});

function unavailableProjectStatus(): ProjectSyncStatus {
  return { state: "unavailable", remainingFiles: 0, remainingBytes: 0, message: "No Syncthing folder is configured" };
}

async function projectsWithSharedNames(): Promise<ProjectView[]> {
  const [projects, overrides] = await Promise.all([listProjects(), projectNameOverrides()]);
  const statuses = await syncthingFolderStatuses(projects.flatMap((project) => project.syncFolderId ? [project.syncFolderId] : []));
  return projects.map((project) => ({
    ...project,
    name: overrides[project.id] ?? project.name,
    syncStatus: project.syncFolderId ? statuses[project.syncFolderId] ?? unavailableProjectStatus() : unavailableProjectStatus(),
  }));
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
    throw new ProjectDirectoryImportError("Wait for this project's task run to finish before changing its type");
  }
}

async function relocateProjectType(project: ProjectRecord, nextType: string): Promise<ProjectRecord> {
  const destination = managedProjectRelocationPath(getSettings().projects.homePath, project.type ?? "personal", project.path, nextType);
  if (!destination || path.resolve(destination) === path.resolve(project.path)) return updateProjectTypeAndPath(project.id, nextType, project.path);
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
    const updated = await updateProjectTypeAndPath(project.id, nextType, destination);
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

const projectTypeSchema = z.object({
  id: z.string().trim().max(40).optional(),
  label: z.string().trim().min(1).max(40),
  githubGroup: z.string().trim().max(64).nullable().optional(),
});

app.get("/api/project-types", async (_request, response, next) => {
  try {
    response.json({ types: await listProjectTypes() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/project-types", async (request, response, next) => {
  try {
    const payload = projectTypeSchema.parse(request.body);
    const type = await saveProjectType(payload);
    await ensureManagedHome(getSettings().projects.homePath, (await listProjectTypes()).map((entry) => entry.id));
    response.json({ type });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/project-types/:typeId", async (request, response, next) => {
  try {
    await deleteProjectType(request.params.typeId);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects", async (_request, response, next) => {
  try {
    response.json({ projects: await projectsWithSharedNames() });
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
    const projectTypes = await listProjectTypes();
    if (!projectTypes.some((type) => type.id === payload.type)) {
      throw new ProjectTypeError(`Unknown project type "${payload.type}"`);
    }
    const projectPath = payload.path ?? managedProjectPath(homePath, payload.type, payload.name);
    if (!payload.path) await ensureManagedHome(homePath, projectTypes.map((type) => type.id));
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
    const payload = projectPathMappingSchema.parse(request.body);
    const project = await updateProjectMacPath(existing.id, payload.macPath);
    sessionWatcher.ensureProject(project);
    broadcastToProject(project.id, { type: "sessionsChanged" });
    response.json({ project });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:projectId/github-auth", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    response.json(await getGitHubAuthStatus(project.id));
  } catch (error) {
    next(error);
  }
});

app.put("/api/projects/:projectId/github-auth", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const payload = projectGitHubAuthSchema.parse(request.body);
    const session = response.locals.authSession as AuthSession;
    await updateProjectGitHubAuth(project.id, payload.group, payload.token, session.userId);
    response.json(await getGitHubAuthStatus(project.id));
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
    const payload = projectUpdateSchema.parse(request.body);
    if (payload.type && !(await listProjectTypes()).some((type) => type.id === payload.type)) {
      throw new ProjectTypeError(`Unknown project type "${payload.type}"`);
    }
    let project = existing;
    const typeChanged = Boolean(payload.type && payload.type !== existing.type);
    if (typeChanged && payload.type) project = await relocateProjectType(project, payload.type);
    if (payload.name !== undefined) {
      project = await renameProject(project.id, payload.name);
      await setProjectName(project.id, payload.name);
    }
    if (payload.color !== undefined) project = await updateProjectColor(project.id, payload.color);
    if (typeChanged) await notifyPeersOfProjectInventory();
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
    await setSessionTitle(payload.sessionPath, payload.title);
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
    await removeProject(project.id);
    const session = response.locals.authSession as AuthSession;
    await removeProjectGitHubAuth(project.id, session.userId);
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
    const nodes: Array<{ id: string; name: string; local: boolean; online: boolean; mapped: boolean }> = [
      { id: local.id, name: local.name, local: true, online: true, mapped: true },
    ];
    for (const peer of await listClusterPeers()) {
      try {
        const inventory = await fetchPeerInventory(peer);
        const mapped = inventory.projects.some((entry) => entry.project.id === project.id || entry.aliases?.includes(project.id) || Boolean(project.syncFolderId && entry.project.syncFolderId === project.syncFolderId));
        nodes.push({ id: peer.id, name: peer.name, local: false, online: true, mapped });
      } catch {
        nodes.push({ id: peer.id, name: peer.name, local: false, online: false, mapped: false });
      }
    }
    response.json({ nodes });
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

app.get("/api/projects/:projectId/sessions", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    await touchProject(project.id);
    const tasks = await listTasks(project.id);
    const pinnedSessionPaths = getUserPreferences((response.locals.authSession as AuthSession).userId).pinnedSessionPaths;
    const sessions = await listHarnessSessions({
      ...project,
      additionalPaths: tasks.flatMap((task) => task.worktreePath ? [task.worktreePath] : []),
    }, pinnedSessionPaths);
    const tasksBySessionPath = new Map(tasks.filter((task) => task.sessionPath).map((task) => [task.sessionPath, task]));
    const listedSessions = sessions.map((session) => {
      const task = tasksBySessionPath.get(session.path);
      const shared = sharedSessions.get(sessionKey(task ? taskCwd(project, task) : project.path, session.path));
      const config = task?.executionState === "running" ? taskConfig(task, taskPhase(task)) : undefined;
      const agentLabel = config ? (config.engine === "pi" ? "Pi" : "Claude") : session.agentLabel;
      const livePiModel = (!config || config.engine === "pi") && shared
        ? getSessionStatus(shared.handle.session, shared.handle.safeguardsEnabled).model?.label
        : undefined;
      const agentModel = config?.modelId || livePiModel;
      return {
        ...session,
        agentLabel,
        ...(agentModel ? { agentModel } : {}),
        taskStatus: task?.status,
        taskId: task?.id,
        running: Boolean(shared?.handle.session.isStreaming || task?.executionState === "running"),
      };
    });
    const authSession = response.locals.authSession as AuthSession;
    const reviewStates = syncConversationReviewStates(authSession.userId, project.id, listedSessions);
    response.json({
      sessions: listedSessions.map((session) => ({ ...session, reviewState: reviewStates.get(session.path) })),
    });
  } catch (error) {
    next(error);
  }
});

async function transferLocalPiSession(project: ProjectRecord, payload: z.infer<typeof sessionTransferSchema>): Promise<unknown> {
  const sessions = await listHarnessSessions(project);
  const matching = payload.sessionId
    ? sessions.find((session) => session.id === payload.sessionId)
    : sessions.find((session) => session.path === payload.sessionPath);
  if (!matching) throw new TaskWorktreeError("Conversation was not found on the source node");
  if (matching.path.startsWith("claude:")) throw new TaskWorktreeError("Claude session transfer is not available yet");
  const sessionPath = matching.path;
  const active = [...new Set(sharedSessions.values())].find((session) => session.projectId === project.id && session.handle.session.sessionFile === sessionPath);
  if (active?.handle.session.isStreaming) throw new TaskWorktreeError("Wait for the current turn to finish before transferring");
  const peer = await getClusterPeer(payload.peerId);
  if (!peer) throw new Error("Peer not found");
  const source = await createPiSession({ cwd: project.path, projectId: project.id, sessionPath });
  const messages = simplifyMessages(source.session.messages as unknown[]);
  source.dispose();
  const peerResponse = await fetch(`${peer.url}/api/cluster/sessions/receive`, {
    method: "POST",
    headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: project.id, sessionName: payload.sessionName, messages }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await peerResponse.json() as { error?: string; sessionPath?: string };
  if (!peerResponse.ok) throw new TaskWorktreeError(result.error || `Peer transfer failed: ${peerResponse.status}`);
  return result;
}

app.put("/api/projects/:projectId/sessions/reviewed", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const { sessionPath } = sessionReviewedSchema.parse(request.body);
    const tasks = await listTasks(project.id);
    const sessions = await listHarnessSessions({
      ...project,
      additionalPaths: tasks.flatMap((task) => task.worktreePath ? [task.worktreePath] : []),
    });
    if (!sessions.some((session) => session.path === sessionPath)) {
      sendError(response, 404, "Conversation not found");
      return;
    }
    const authSession = response.locals.authSession as AuthSession;
    markConversationReviewed(authSession.userId, project.id, sessionPath);
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/sessions/transfer", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const payload = sessionTransferSchema.parse(request.body);
    const local = await getClusterNode();
    if (payload.sourceNodeId && payload.sourceNodeId !== local.id) {
      const source = await getClusterPeer(payload.sourceNodeId);
      if (!source) { sendError(response, 404, "Source node not found"); return; }
      const peerResponse = await fetch(`${source.url}/api/cluster/sessions/transfer`, {
        method: "POST",
        headers: { Authorization: `Bearer ${source.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, peerId: payload.peerId, sessionId: payload.sessionId, sessionPath: payload.sessionPath, sessionName: payload.sessionName }),
        signal: AbortSignal.timeout(35_000),
      });
      const result = await peerResponse.json() as { error?: string };
      if (!peerResponse.ok) { sendError(response, peerResponse.status, result.error || "Source node transfer failed"); return; }
      response.json(result);
      return;
    }
    response.json(await transferLocalPiSession(project, payload));
  } catch (error) {
    if (error instanceof TaskWorktreeError) { sendError(response, 409, error.message); return; }
    if (error instanceof Error && error.message === "Peer not found") { sendError(response, 404, error.message); return; }
    next(error);
  }
});

app.post("/api/cluster/sessions/transfer", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = routedSessionTransferSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    response.json(await transferLocalPiSession(project, payload));
  } catch (error) {
    if (error instanceof TaskWorktreeError) { sendError(response, 409, error.message); return; }
    if (error instanceof Error && error.message === "Peer not found") { sendError(response, 404, error.message); return; }
    next(error);
  }
});

app.post("/api/cluster/sessions/receive", async (request, response, next) => {
  try {
    const payload = receivedSessionTransferSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) {
      sendError(response, 404, "Project is not imported on this node");
      return;
    }
    const target = await createPiSession({ cwd: project.path, projectId: project.id });
    if (payload.sessionName) target.session.setSessionName(payload.sessionName);
    await target.session.prompt(`${buildHandoffContext(payload.messages)}The previous session has been transferred to this machine. Acknowledge the handoff and wait for the user's next instruction.`);
    const sessionPath = target.session.sessionFile;
    target.dispose();
    response.status(201).json({ sessionPath });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:projectId/sessions", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const sessionPath = typeof request.query.sessionPath === "string" ? request.query.sessionPath : "";
    if (!sessionPath || sessionPath === "new" || sessionPath === "claude:new") {
      sendError(response, 400, "Session path is required");
      return;
    }
    const tasks = await listTasks(project.id);
    const sessions = await listHarnessSessions({
      ...project,
      additionalPaths: tasks.flatMap((task) => task.worktreePath ? [task.worktreePath] : []),
    });
    const session = sessions.find((candidate) => candidate.path === sessionPath);
    if (!session) {
      sendError(response, 404, "Session not found");
      return;
    }
    const filePath = session.path.startsWith("claude:") ? session.path.slice("claude:".length) : session.path;
    try {
      const fileStats = await lstat(filePath);
      if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
        sendError(response, 400, "Session path is not a regular file");
        return;
      }
      await unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        sendError(response, 404, "Session not found");
        return;
      }
      throw error;
    }
    broadcastToProject(project.id, { type: "sessionsChanged" });
    response.status(204).send();
  } catch (error) {
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

app.get("/api/projects/:projectId/file", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
    if (!requestedPath.trim()) {
      sendError(response, 400, "File path is required");
      return;
    }
    const projectRoot = path.resolve(project.path);
    const resolved = path.resolve(projectRoot, requestedPath);
    const relative = path.relative(projectRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      sendError(response, 403, "File is outside the project directory");
      return;
    }
    let info;
    try {
      info = await stat(resolved);
    } catch {
      sendError(response, 404, "File not found");
      return;
    }
    if (!info.isFile()) {
      sendError(response, 400, "Path is not a file");
      return;
    }
    const fileName = path.basename(resolved);
    response.setHeader("Content-Disposition", `attachment; filename="${fileName.replace(/["\r\n]/g, "")}"`);
    response.setHeader("Content-Length", String(info.size));
    createReadStream(resolved).pipe(response);
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
    return;
  }
  const message = error instanceof Error ? error.message : "Unexpected server error";
  if (error instanceof ProjectTypeError) {
    sendError(response, 400, message);
    return;
  }
  sendError(response, error instanceof TaskWorktreeError || error instanceof TaskWorkspaceError || error instanceof ProjectDirectoryImportError ? 409 : 500, message);
});

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

function broadcast(session: SharedPiSession, payload: unknown): void {
  for (const client of session.clients) send(client, payload);
}

function parseSessionPath(value: string | null): string | undefined {
  if (!value || value === "new") return undefined;
  return value;
}

function sendStatus(socket: WebSocket, handle: PiSessionHandle): void {
  send(socket, { type: "status", status: getSessionStatus(handle.session, handle.safeguardsEnabled) });
}

function broadcastStatus(session: SharedPiSession): void {
  broadcast(session, { type: "status", status: getSessionStatus(session.handle.session, session.handle.safeguardsEnabled) });
}

function sessionIsBusy(handle: PiSessionHandle): boolean {
  return handle.session.isStreaming || handle.session.isBashRunning || handle.session.isCompacting || handle.session.isRetrying;
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
      send(connection.socket, { type: "messages", messages });
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

function handleSessionChange(projectId: string, changedFiles: string[]): void {
  broadcastToProject(projectId, { type: "sessionsChanged" });
  invalidateExternallyChangedSessions(projectId, changedFiles);
  reloadClaudeClients(projectId, changedFiles).catch((error) => console.warn("Claude reload failed", error));
}

// ---- Kanban task runs: moving a task to "in progress" starts its agent ----

interface PiTaskRun {
  projectId: string;
  taskId: string;
  leaseToken: string;
  phase: TaskPhase;
}

interface ClaudeTaskRun {
  child: ClaudeRunHandle["child"];
  projectId: string;
  taskId: string;
  leaseToken: string;
  phase: TaskPhase;
}

const piTaskRuns = new Map<SharedPiSession, PiTaskRun>();
const claudeTaskRuns = new Map<string, ClaudeTaskRun>();

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

async function sessionCwd(project: ProjectRecord, sessionPath: string | undefined): Promise<string> {
  if (!sessionPath) return project.path;
  const task = (await listTasks(project.id)).find((candidate) => candidate.sessionPath === sessionPath);
  return task ? taskCwd(project, task) : project.path;
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

async function startTaskRun(project: ProjectRecord, task: TaskRecord, requestedPhase?: TaskPhase): Promise<void> {
  const local = await getClusterNode();
  if (task.currentNodeId !== local.id) return;
  const { task: claimed, leaseToken } = await claimTaskLease(project.id, task.id, local.id);
  let shared: SharedPiSession | undefined;
  try {
    const phase = requestedPhase ?? taskPhase(claimed);
    const config = taskConfig(claimed, phase);
    const cwd = taskCwd(project, claimed);
    const prompt = await taskPromptText(project, claimed, phase, config.engine);
    if (config.engine === "claude") {
      const run = runClaudePrompt({
        cwd,
        prompt,
        env: gitHubEnvironment(project.id),
        resumeSessionId: task.sessionPath?.startsWith("claude:") ? path.basename(task.sessionPath.replace(/^claude:/, ""), ".jsonl") : undefined,
        model: config.modelId || undefined,
        effort: config.effort && config.effort !== "default" ? config.effort : undefined,
        onEvent: () => undefined,
      });
      claudeTaskRuns.set(task.id, { child: run.child, projectId: project.id, taskId: claimed.id, leaseToken, phase });
      run.done
        .then(async (result) => {
          if (claudeTaskRuns.get(task.id)?.leaseToken !== leaseToken) {
            console.warn("Ignoring stale Claude task callback", task.id);
            return;
          }
          if (!result.ok) throw new Error("Claude task run failed");
          const sessionPath = result.sessionId ? `claude:${claudeSessionFilePath(cwd, result.sessionId)}` : null;
          await finishTaskPhase(project, claimed, phase, sessionPath, leaseToken);
          if (claudeTaskRuns.get(task.id)?.leaseToken === leaseToken) claudeTaskRuns.delete(task.id);
        })
        .catch((error) => {
          if (claudeTaskRuns.get(task.id)?.leaseToken !== leaseToken) {
            console.warn("Ignoring stale Claude task callback", task.id);
            return;
          }
          claudeTaskRuns.delete(task.id);
          console.warn("Claude task run failed", error);
          releaseTaskLease(project.id, claimed.id, local.id, leaseToken, "failed").catch((releaseError) => console.warn("Could not release Claude task lease", releaseError));
        });
      return;
    }

    const samePiSession = claimed.sessionPath && !claimed.sessionPath.startsWith("claude:") ? claimed.sessionPath : undefined;
    shared = await getSharedSession(project.id, cwd, samePiSession);
    if (config.provider && config.modelId) await setSessionModel(shared.handle.session, config.provider, config.modelId);
    piTaskRuns.set(shared, { projectId: project.id, taskId: claimed.id, leaseToken, phase });
    shared.handle.session.prompt(prompt)
      .then(async () => {
        if (piTaskRuns.get(shared!)?.leaseToken !== leaseToken) {
          console.warn("Ignoring stale Pi task callback", claimed.id);
          return;
        }
        await finishPiTaskRun({ projectId: project.id, taskId: claimed.id, leaseToken, phase }, shared!.handle.session.sessionFile ?? null);
        if (piTaskRuns.get(shared!)?.leaseToken === leaseToken) piTaskRuns.delete(shared!);
      })
      .catch((error) => {
        if (piTaskRuns.get(shared!)?.leaseToken !== leaseToken) {
          console.warn("Ignoring stale Pi task callback", claimed.id);
          return;
        }
        console.warn("Pi task run failed", error);
        piTaskRuns.delete(shared!);
        releaseTaskLease(project.id, claimed.id, local.id, leaseToken, "failed").catch((releaseError) => console.warn("Could not release Pi task lease", releaseError));
      });
  } catch (error) {
    if (shared && piTaskRuns.get(shared)?.leaseToken === leaseToken) piTaskRuns.delete(shared);
    if (claudeTaskRuns.get(task.id)?.leaseToken === leaseToken) claudeTaskRuns.delete(task.id);
    await releaseTaskLease(project.id, claimed.id, local.id, leaseToken, "failed");
    throw error;
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
    // New sessions get their file lazily; register the file-keyed entry as soon
    // as it exists so later connects attach to this live session.
    if (handle.session.sessionFile && !sharedSessions.has(sessionKey(session.cwd, handle.session.sessionFile))) {
      sharedSessions.set(sessionKey(session.cwd, handle.session.sessionFile), session);
    }
    broadcast(session, eventPayload(event));
    if (event.type === "message_end" || event.type === "turn_end" || event.type === "agent_end") {
      broadcast(session, { type: "status", status: getSessionStatus(handle.session, handle.safeguardsEnabled) });
      // Notify only when the whole task finished, not on every intermediate
      // assistant message within a turn.
      const finishedSessionPath = handle.session.sessionFile;
      if (event.type === "agent_end" && finishedSessionPath) {
        notifySessionFinished(session.projectId, finishedSessionPath, handle.session.sessionName || "Pi").catch((error) => console.warn("Push notification failed", error));
        broadcastToProject(session.projectId, { type: "sessionsChanged" });
      }
      if (!session.clients.size) scheduleIdleDispose(session);
    }
  });
}

async function getSharedSession(projectId: string, cwd: string, sessionPath: string | undefined): Promise<SharedPiSession> {
  if (sessionPath) {
    const existing = sharedSessions.get(sessionKey(cwd, sessionPath));
    if (existing) {
      clearIdleTimer(existing);
      return existing;
    }
  }

  const handle = await createPiSession({ cwd, projectId, sessionPath });
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

function promptDisplayText(message: string, imageNames: string[], textAttachmentNames: string[]): string {
  const body = message.trim();
  const attachmentNames = [...imageNames, ...textAttachmentNames];
  if (!attachmentNames.length) return body;
  const suffix = `Attached: ${attachmentNames.join(", ")}`;
  return body ? `${body}\n\n${suffix}` : suffix;
}

function promptTextWithAttachments(message: string, imageAttachments: Array<{ name: string; path: string }>, textAttachments: Array<{ name: string; content: string }>): string {
  const parts: string[] = [];
  const body = message.trim();
  if (body) parts.push(body);
  if (imageAttachments.length) {
    parts.push(`Image attachments:\n${imageAttachments.map((image) => `- ${image.name}: ${image.path}`).join("\n")}\nAnalyze them alongside the request. Use these paths when a tool needs the original image file.`);
  }
  for (const attachment of textAttachments) {
    parts.push(`Attachment: ${attachment.name}\n\n\`\`\`\n${attachment.content}\n\`\`\``);
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

type SocketPayload = z.infer<typeof socketMessageSchema>;

function claudeStatus(connection: ChatConnection): SessionStatus {
  return {
    sessionFile: connection.claude.filePath ? `claude:${connection.claude.filePath}` : undefined,
    sessionId: connection.claude.sessionId ?? "claude:new",
    sessionName: undefined,
    model: {
      provider: "claude",
      id: connection.claude.model ?? "default",
      label: (connection.claude.model ? CLAUDE_MODEL_LABELS.get(connection.claude.model) : undefined) ?? "Claude Code",
    },
    thinkingLevel: connection.claude.effort ?? "default",
    availableThinkingLevels: ["default", "low", "medium", "high", "xhigh", "max"],
    isStreaming: Boolean(connection.claude.child),
    isCompacting: false,
    isRetrying: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    messageCount: connection.claude.transcript.length,
    activeTools: [],
    promptTemplates: [],
  };
}

function sendClaudeStatus(connection: ChatConnection): void {
  send(connection.socket, { type: "status", status: claudeStatus(connection) });
}

function emptyClaudeState(): ClaudeChatState {
  return { sessionId: null, filePath: null, child: null, transcript: [], lastRunEndedAt: 0, model: null, effort: null };
}

function pushTranscript(connection: ChatConnection, role: string, text: string): void {
  connection.claude.transcript.push({ id: `${connection.claude.transcript.length}`, role, text });
}

function claudeConnectionKey(projectId: string, sessionId: string | null): string {
  return `${projectId}:${sessionId ?? "claude:new"}`;
}

async function runClaudeTurn(connection: ChatConnection, promptText: string, displayText: string): Promise<void> {
  if (connection.claude.child) throw new Error("Claude is still working — stop it first or wait");
  send(connection.socket, { type: "userMessage", text: displayText });
  pushTranscript(connection, "user", promptText);
  send(connection.socket, { type: "agent_start" });
  const fullPrompt = connection.handoffContext ? `${connection.handoffContext}${promptText}` : promptText;
  connection.handoffContext = null;
  const onEvent = (payload: Record<string, unknown>): void => send(connection.socket, payload);

  const runOptions = {
    model: connection.claude.model ?? undefined,
    effort: connection.claude.effort ?? undefined,
  };
  let run = runClaudePrompt({
    cwd: connection.cwd,
    prompt: fullPrompt,
    env: gitHubEnvironment(connection.project.id),
    resumeSessionId: connection.claude.sessionId ?? undefined,
    ...runOptions,
    onEvent,
  });
  connection.claude.child = run.child;
  const activeKey = claudeConnectionKey(connection.project.id, connection.claude.sessionId);
  activeClaudeConnections.set(activeKey, connection);
  sendClaudeStatus(connection);
  let result = await run.done;

  if (!result.ok && !result.sawOutput && connection.claude.sessionId) {
    // Resume can fail when a synchronized session lives under another node's
    // encoded project dir. Fall back to a fresh session seeded with
    // the transcript so the conversation continues.
    connection.claude.sessionId = null;
    const seeded = `${buildHandoffContext(connection.claude.transcript.slice(0, -1))}${promptText}`;
    run = runClaudePrompt({ cwd: connection.cwd, prompt: seeded, env: gitHubEnvironment(connection.project.id), ...runOptions, onEvent });
    connection.claude.child = run.child;
    result = await run.done;
  }

  connection.claude.child = null;
  if (activeClaudeConnections.get(activeKey) === connection) activeClaudeConnections.delete(activeKey);
  connection.claude.lastRunEndedAt = Date.now();
  if (result.sessionId) {
    connection.claude.sessionId = result.sessionId;
    connection.claude.filePath = claudeSessionFilePath(connection.cwd, result.sessionId);
    send(connection.socket, { type: "sessionFile", sessionId: connection.claude.sessionId, sessionFile: `claude:${connection.claude.filePath}` });
  }
  if (result.assistantText) pushTranscript(connection, "assistant", result.assistantText);
  send(connection.socket, { type: "agent_end" });
  sendClaudeStatus(connection);
  broadcastToProject(connection.project.id, { type: "sessionsChanged" });
  if (connection.claude.filePath) {
    notifySessionFinished(connection.project.id, `claude:${connection.claude.filePath}`, "Claude").catch((error) => console.warn("Push notification failed", error));
  }
}

async function handleClaudeCommand(connection: ChatConnection, payload: SocketPayload): Promise<void> {
  if (payload.type === "prompt") {
    const textAttachments = payload.textAttachments ?? [];
    const imageAttachments = await persistImageAttachments(connection.cwd, payload.images ?? []);
    const promptText = promptTextWithAttachments(payload.message ?? "", imageAttachments, textAttachments);
    if (!promptText) return;
    const displayText = promptDisplayText(payload.message ?? "", imageAttachments.map((image) => image.name), textAttachments.map((attachment) => attachment.name));
    await runClaudeTurn(connection, promptText, displayText);
    return;
  }
  if (payload.type === "abort") {
    connection.claude.child?.kill("SIGTERM");
    return;
  }
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
  }
  // Thinking/rename commands only apply to the Pi engine.
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
    connection.engine = "claude";
    connection.claude = { ...emptyClaudeState(), transcript };
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
  const sharedSession = await getSharedSession(connection.project.id, connection.cwd, undefined);
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

  if (payload.type === "setEngine") {
    if (!payload.engine) throw new Error("Missing engine");
    await switchEngine(connection, payload.engine);
    return;
  }

  if (connection.engine === "claude") {
    await handleClaudeCommand(connection, payload);
    return;
  }

  const shared = connection.shared;
  if (!shared) throw new Error("No active Pi session");
  await handlePiCommand(connection, shared, payload);
}

async function handlePiCommand(connection: ChatConnection, shared: SharedPiSession, payload: SocketPayload): Promise<void> {
  const handle = shared.handle;
  const socket = connection.socket;
  const cwd = connection.cwd;

  if (payload.type === "prompt") {
    await reloadPiAuth();
    const textAttachments = payload.textAttachments ?? [];
    const imageAttachments = await persistImageAttachments(cwd, payload.images ?? []);
    let promptText = promptTextWithAttachments(payload.message ?? "", imageAttachments, textAttachments);
    if (!promptText) return;
    if (connection.handoffContext) {
      promptText = `${connection.handoffContext}${promptText}`;
      connection.handoffContext = null;
    }
    send(socket, { type: "userMessage", text: promptDisplayText(payload.message ?? "", imageAttachments.map((image) => image.name), textAttachments.map((attachment) => attachment.name)) });
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
    await handle.session.prompt(promptText, options);
    send(socket, { type: "sessionsChanged" });
    sendStatus(socket, handle);
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
  const session = sessionForId(request.headers.cookie?.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith("mb_session="))?.slice("mb_session=".length));
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
    proxySocket(socket, new WebSocket(ownerUrl, { headers: { Authorization: `Bearer ${peer.token}` } }));
    return;
  }
  const requestedNodeId = url.searchParams.get("nodeId");
  if (browserAuthenticated && !task && requestedNodeId && requestedNodeId !== local.id) {
    const peer = await getClusterPeer(requestedNodeId);
    if (!peer) { socket.close(1008, "Execution node not found"); return; }
    const ownerUrl = new URL("/ws", peer.url);
    ownerUrl.protocol = ownerUrl.protocol === "https:" ? "wss:" : "ws:";
    for (const [key, value] of url.searchParams) ownerUrl.searchParams.set(key, value);
    ownerUrl.searchParams.delete("nodeId");
    ownerUrl.searchParams.set("nodeSession", "1");
    proxySocket(socket, new WebSocket(ownerUrl, { headers: { Authorization: `Bearer ${peer.token}` } }));
    return;
  }
  if (machineAuthenticated) {
    const routedSession = url.searchParams.get("nodeSession") === "1";
    if (!task && !routedSession) {
      socket.close(1008, "Unauthorized");
      return;
    }
  }

  let rawSessionPath = rawSessionPathFromUrl;
  const requestedSessionId = url.searchParams.get("sessionId");
  if (requestedSessionId && rawSessionPath !== "watch") {
    const sessions = await listHarnessSessions(project);
    const matching = sessions.find((candidate) => candidate.id === requestedSessionId);
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

  const requestedSessionPath = parseSessionPath(rawSessionPath);
  const cwd = await sessionCwd(project, requestedSessionPath);
  let connection: ChatConnection = {
    socket,
    project,
    cwd,
    engine: "pi",
    shared: null,
    claude: emptyClaudeState(),
    handoffContext: null,
  };

  if (requestedSessionPath?.startsWith("claude:")) {
    const requestedClaudeId = requestedSessionId
      ?? (requestedSessionPath === "claude:new" ? null : path.basename(requestedSessionPath.replace(/^claude:/, ""), ".jsonl"));
    const active = activeClaudeConnections.get(claudeConnectionKey(project.id, requestedClaudeId));
    if (active?.claude.child) {
      active.socket = socket;
      connection = active;
    } else {
      connection.engine = "claude";
      if (requestedSessionPath !== "claude:new") {
        try {
          connection.claude.transcript = await loadClaudeMessages(requestedSessionPath);
          connection.claude.filePath = path.resolve(requestedSessionPath.replace(/^claude:/, ""));
          connection.claude.sessionId = path.basename(connection.claude.filePath, ".jsonl");
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
      models: await listAvailableModels(),
    });
  } else {
    let sharedSession: SharedPiSession;
    try {
      sharedSession = await getSharedSession(project.id, cwd, requestedSessionPath);
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
      models: await listAvailableModels(),
    });
  }

  socket.on("message", async (raw) => {
    try {
      await handleChatMessage(connection, raw as Buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command failed";
      send(socket, { type: "error", error: message });
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
  });
});

async function initializeStartupReadiness(): Promise<void> {
  try {
    const projects = await listProjects();
    await reconcileSyncthingProjectFolders(projects);
    ensureGitHubCredentialMigration();
    startupReady = true;
    startupError = undefined;
  } catch (error) {
    startupError = error instanceof Error ? error : new Error("Startup reconciliation failed");
    console.warn("Startup reconciliation failed", startupError);
  }
}

async function configureTicketWorkspacePeer(peer: ClusterPeer, localDeviceId: string, localDeviceName: string): Promise<void> {
  const inventory = await fetchPeerInventory(peer);
  if (!inventory.syncDeviceId) throw new Error("Peer Syncthing device ID is unavailable");
  await ensureTicketWorkspaceFolder(ticketWorkspaceRoot(), inventory.syncDeviceId, inventory.node.name);
  await ensureEngineSyncFolders(undefined, inventory.syncDeviceId, inventory.node.name);
  for (const folderId of [TICKET_WORKSPACE_FOLDER_ID, PI_ENGINE_SYNC_FOLDER_ID]) {
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
    await ensureTicketWorkspaceFolder();
    await ensureEngineSyncFolders();
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

async function flushGitHubCredentialOutbox(): Promise<void> {
  if (githubCredentialFlushInProgress) return;
  githubCredentialFlushInProgress = true;
  try {
    for (const peer of await listClusterPeers()) {
      const events = await githubCredentialEventsForPeer(peer.id);
      if (!events.length) continue;
      try {
        const response = await fetch(`${peer.url}/api/cluster/github/events`, {
          method: "POST",
          headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ events }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Peer returned ${response.status}`);
        const receipt = replicationReceiptSchema.parse(await response.json());
        await recordGitHubCredentialReceipt(peer.id, receipt.received);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Peer GitHub credential replication failed";
        await recordGitHubCredentialFailure(peer.id, events.map((event) => event.id), message);
        console.warn(`GitHub credential replication to ${peer.id} failed: ${message}`);
      }
    }
  } finally {
    githubCredentialFlushInProgress = false;
  }
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
      .then(() => reconcileTicketWorkspaceSync())
      .catch((error) => console.warn("Ticket workspace sync failed", error));
    flushMembershipOutbox().catch((error) => console.warn("Membership flush failed", error));
    flushReplicationOutbox().catch((error) => console.warn("Replication flush failed", error));
    flushGitHubCredentialOutbox().catch((error) => console.warn("GitHub credential flush failed", error));
    reconcileTaskHandoffs().catch((error) => console.warn("Task handoff reconciliation failed", error));
    discoverMissingPeerProjects().catch((error) => console.warn("Project discovery failed", error));
    setInterval(() => discoverMissingPeerProjects().catch((error) => console.warn("Project discovery failed", error)), 10_000).unref();
    setInterval(() => {
      reconcileTicketWorkspaceSync().catch((error) => console.warn("Ticket workspace sync failed", error));
      flushMembershipOutbox().catch((error) => console.warn("Membership flush failed", error));
      flushReplicationOutbox().catch((error) => console.warn("Replication flush failed", error));
      flushGitHubCredentialOutbox().catch((error) => console.warn("GitHub credential flush failed", error));
      reconcileTaskHandoffs().catch((error) => console.warn("Task handoff reconciliation failed", error));
    }, 2_000).unref();
  });
}
