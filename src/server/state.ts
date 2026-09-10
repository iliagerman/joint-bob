import { execFile } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import type { AgentRunDescriptor } from "../agent-run-monitor.js";
import type { ClaudeRunHandle } from "../claude-service.js";
import { createPiSession } from "../pi-service.js";
import type { QueuedPrompt } from "../prompt-queue.js";
import type { AgentRunSummary, ChatMessage, ContextUsage, HarnessId, ProjectRecord } from "../types.js";

/** Node-wide mutable flags shared by several server modules. */
export const flags = {
  updatePreparing: false,
  updatePreparation: null as Promise<number> | null,
  replicationFlushInProgress: false,
  secretCredentialFlushInProgress: false,
  membershipFlushInProgress: false,
  taskHandoffReconciliationInProgress: false,
  ticketWorkspaceSyncInProgress: false,
  projectDiscoveryInProgress: false,
  ticketWorkspaceSyncRetryAt: 0,
  startupReady: true,
  startupError: undefined as Error | undefined,
  startupReadinessInProgress: false,
};

export type PiSessionHandle = Awaited<ReturnType<typeof createPiSession>>;

export interface SharedPiSession {
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

export type ChatEngine = HarnessId;

interface ClaudeQueuedPrompt extends QueuedPrompt {
  acknowledged: boolean;
}

export interface ClaudeChatState {
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
export const CLAUDE_MODEL_LABELS = new Map([
  ["fable", "Claude Fable"],
  ["claude-opus-5", "Claude Opus 5"],
  ["sonnet", "Claude Sonnet"],
  ["haiku", "Claude Haiku 4.5"],
]);
export const CLAUDE_MODELS = [...CLAUDE_MODEL_LABELS.keys()];
// A new chat starts on Opus 5 rather than the CLI default, so the toolbar
// always names the model that is actually running.
export const CLAUDE_DEFAULT_MODEL = "claude-opus-5";

export interface ChatConnection {
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
  // A read-only transcript (Claude sub-agent sidechain); the send fence rejects writes.
  readOnly?: boolean;
}

export const port = Number(process.env.PORT ?? 8790);
export const machineRoutes = new Set([
  "GET /cluster/node",
  "GET /cluster/local-inventory",
  "POST /cluster/peers/accept",
  "POST /cluster/membership/sync",
  "POST /cluster/membership/leave",
  "POST /cluster/projects/import",
  "POST /cluster/projects/map",
  "GET /cluster/filesystem/directories",
  "GET /cluster/project-file",
  "GET /cluster/project-file-resolution",
  "GET /cluster/project-file-content",
  "PUT /cluster/project-file-content",
  "POST /cluster/sync/share",
  "DELETE /cluster/sessions/delete",
  "POST /cluster/sessions/fork",
  "POST /cluster/sessions/take-ownership",
  "POST /cluster/sessions/queue-transfer",
  "GET /cluster/sessions/transcript-presence",
  "GET /cluster/sessions/ownership",
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
  "POST /cluster/tasks/merge-action",
  "GET /cluster/tasks/merge-conflicts",
  "POST /cluster/tasks/handoff",
  "POST /cluster/update/install",
  "POST /update/prepare",
]);
export const app = express();
export function createApp(): express.Express {
  return app;
}
export const server = createServer(app);
export const webSocketServer = new WebSocketServer({ server, path: "/ws" });
const dirname = path.dirname(fileURLToPath(import.meta.url));
export const publicDir = path.resolve(dirname, "../../public");
export const codemirrorDir = path.resolve(dirname, "../../node_modules/codemirror");
export const sharedSessions = new Map<string, SharedPiSession>();
export const execFileAsync = promisify(execFile);
export const idleSessionTimeoutMs = 30 * 60 * 1000;
// A session file change within this window of local agent activity is our own
// write, not an external Syncthing sync.
export const localWriteGraceMs = 15_000;
export const watchClients = new Map<string, Set<WebSocket>>();
export const claudeClients = new Map<WebSocket, ChatConnection>();
export const activeClaudeConnections = new Map<string, ChatConnection>();
// Interactive Claude turns run on a socket connection, not in `sharedSessions`,
// so the conversation list needs its own record of which files are streaming.
export const runningClaudeSessionPaths = new Set<string>();
export interface RecoveredClaudeChat {
  claude: ClaudeChatState;
  connection: ChatConnection | null;
}

export const recoveredClaudeChats = new Map<string, RecoveredClaudeChat>();
export const updateContinuationPrompt = "A service update interrupted this turn. Inspect the transcript and working tree, continue unfinished work, and do not repeat completed side effects.";
export const configuredTicketWorkspacePeers = new Set<string>();
