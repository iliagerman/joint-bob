export interface ProjectLocation {
  nodeId: string;
  path: string;
}

/** Project types are user-defined; the id doubles as the folder name under the managed home. */
export type ProjectType = string;

export interface ProjectTypeRecord {
  id: string;
  label: string;
  githubGroup: string | null;
}

/** A fixed palette keeps project accents legible in both themes. */
export const PROJECT_COLORS = ["slate", "teal", "blue", "violet", "magenta", "amber", "green", "red"] as const;

export type ProjectColor = (typeof PROJECT_COLORS)[number];

export type ProjectSyncState = "synced" | "syncing" | "paused" | "error" | "unavailable";

export interface ProjectSyncStatus {
  state: ProjectSyncState;
  remainingFiles: number;
  remainingBytes: number;
  message?: string;
}

export interface ProjectLock {
  nodeId: string;
  nodeName: string;
  lockedAt: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  type?: ProjectType;
  color?: string;
  path: string;
  macPath?: string;
  syncFolderId?: string;
  locations?: ProjectLocation[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectView extends ProjectRecord {
  syncStatus: ProjectSyncStatus;
  lock?: ProjectLock;
  /** True when another node holds the lock, so this node must not edit the project. */
  lockedElsewhere?: boolean;
}

export type HarnessId = "pi" | "claude";

export interface SessionSummary {
  id: string;
  path: string;
  harnessId: HarnessId;
  agentLabel: string;
  agentModel?: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  firstMessage?: string;
  taskStatus?: TaskStatus;
  taskId?: string;
  running?: boolean;
  reviewState?: "running" | "needs_review" | "reviewed";
}

export type TaskStatus = "backlog" | "planning" | "in_progress" | "review" | "done";

export type TaskEngine = "pi" | "claude";

export type TaskExecutionState = "idle" | "running" | "handoff_pending" | "failed";

export type TaskPhase = "planning" | "in_progress" | "review";

export interface TaskPhaseConfig {
  engine: TaskEngine;
  provider: string;
  modelId: string;
  effort: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  engine: TaskEngine;
  planMode: boolean;
  reviewMode: boolean;
  phaseConfig: Partial<Record<TaskPhase, TaskPhaseConfig>>;
  // Conversation created when the task was started (pi session file path or claude:<path>).
  sessionPath: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  mergedAt: string | null;
  currentNodeId: string;
  leaseOwnerNodeId: string | null;
  leaseExpiresAt: string | null;
  executionState: TaskExecutionState;
  handoffContext: string | null;
  originNodeId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: string;
  text: string;
  // Present on tool roles so the client can label the collapsed tool bubble.
  toolName?: string;
}

export interface ModelSummary {
  provider: string;
  id: string;
  label: string;
}

export interface SessionStatus {
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  model?: ModelSummary;
  thinkingLevel: string;
  availableThinkingLevels: string[];
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  isBashRunning: boolean;
  pendingMessageCount: number;
  messageCount: number;
  activeTools: string[];
  promptTemplates: string[];
  safeguardsEnabled?: boolean;
}

export interface ApiErrorBody {
  error: string;
}
