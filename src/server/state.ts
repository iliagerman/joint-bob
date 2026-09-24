import { execFile } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";

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

export const port = Number(process.env.PORT ?? 8790);
export const machineRoutes = new Set([
  "POST /cluster/cron",
  "POST /cluster/quick-notes/prepare",
  "POST /cluster/routing-configs/events",
  "GET /cluster/node",
  "POST /cluster/background-tasks",
  "POST /cluster/browser/status",
  "POST /cluster/browser/config",
  "POST /cluster/browser/preferences",
  "POST /cluster/browser/operation",
  "POST /cluster/browser/download",
  "POST /cluster/browser/monitor-manage",
  "POST /cluster/browser/monitor-read",
  "POST /cluster/browser/monitor-authorize",
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
  "GET /cluster/project-files",
  "POST /cluster/project-file-delete",
  "POST /cluster/project-file-copy",
  "GET /cluster/git/status",
  "GET /cluster/git/diff",
  "GET /cluster/git/history",
  "GET /cluster/git/commit",
  "GET /cluster/git/commit-diff",
  "POST /cluster/git/ask",
  "POST /cluster/git/reviews/ask",
  "POST /cluster/sync/share",
  "DELETE /cluster/sessions/delete",
  "POST /cluster/sessions/fork",
  "POST /cluster/sessions/by-the-way",
  "POST /cluster/sessions/by-the-way/close",
  "POST /cluster/sessions/take-ownership",
  "POST /cluster/sessions/queue-transfer",
  "GET /cluster/sessions/transcript-presence",
  "GET /cluster/sessions/ownership",
  "POST /cluster/sessions/ownership/apply",
  "POST /cluster/sessions/runtime-snapshot",
  "POST /cluster/events",
  "POST /cluster/github/events",
  "POST /cluster/ntfy/services",
  "POST /cluster/secrets/events",
  "POST /cluster/push/events",
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
export const execFileAsync = promisify(execFile);
export const idleSessionTimeoutMs = 30 * 60 * 1000;
// A session file change within this window of local agent activity is our own
// write, not an external Syncthing sync.
export const localWriteGraceMs = 15_000;
export const watchClients = new Map<string, Set<WebSocket>>();
export const updateContinuationPrompt = "A service update interrupted this turn. Inspect the transcript and working tree, continue unfinished work, and do not repeat completed side effects.";
export const configuredTicketWorkspacePeers = new Set<string>();
