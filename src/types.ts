export interface ProjectLocation {
  nodeId: string;
  path: string;
}

/** Workspaces are user-defined; the id doubles as the folder name under the managed home. */
export type WorkspaceId = string;

export interface WorkspaceRecord {
  id: string;
  label: string;
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
  type?: WorkspaceId;
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

export type AgentRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type AgentTaskStatus = AgentRunStatus;

export interface AgentRunTaskSummary {
  name: string;
  role: string;
  status: AgentTaskStatus;
  /** Why a failed task failed, as the dashboard reported it. Absent unless the task failed. */
  error?: string;
}

export interface AgentRunSummary {
  runId: string;
  status: AgentRunStatus;
  tasks: AgentRunTaskSummary[];
}

export interface SessionSummary {
  id: string;
  path: string;
  color?: ProjectColor;
  harnessId: HarnessId;
  /** The agent that last drove the conversation: its own harness, or a task engine that overrode it. */
  agentId: HarnessId;
  agentLabel: string;
  agentModel?: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  firstMessage?: string;
  /** Parent Pi transcript path when another conversation created this one. */
  parentSessionPath?: string;
  taskStatus?: TaskStatus;
  taskId?: string;
  running?: boolean;
  reviewState?: "running" | "needs_review" | "reviewed";
  draft?: boolean;
  /** Node owning conversation execution. */
  executionNodeId?: string;
  agentRuns?: AgentRunSummary[];
}

export type TaskStatus = "backlog" | "planning" | "in_progress" | "review" | "done";

export type TaskEngine = "pi" | "claude";

export type TaskExecutionState = "idle" | "running" | "handoff_pending" | "failed";

export type TaskPhase = "planning" | "in_progress" | "review";

export type TaskMergeState = "none" | "conflicts" | "resolved" | "merged";

export type TaskMergeTx = "open" | "committed" | "rolled_back";

export type TaskRunKind = "phase" | "merge";

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
  // Ticket-workspace merge-back state (TICKET-MERGE-PLAN.md §10).
  mergeState: TaskMergeState;
  conflictCount: number;
  mergeWarning: string | null;
  mergeTx: TaskMergeTx | null;
  // Trusted digests of the workspace merge artifacts, captured by server code at prepare.
  mergeDigests: Record<string, string> | null;
  runKind: TaskRunKind | null;
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

/** How much of the model's context window the conversation currently occupies. */
export interface ContextUsage {
  usedTokens: number;
  contextWindow: number;
  /** Whole percent of the window in use, so every harness reports one comparable number. */
  percent: number;
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
  /** Absent while the harness has not reported a measurable context reading yet. */
  contextUsage?: ContextUsage;
}

export interface ApiErrorBody {
  error: string;
}
