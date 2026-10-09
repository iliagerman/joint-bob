import { execFile } from "../subprocess.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import { performanceDiagnostics } from "./performance-diagnostics.js";
import { forwardAsyncRouteErrors } from "./error-capture.js";

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
  "GET /cluster/projects/presence",
  "POST /cluster/cron",
  "POST /cluster/quick-notes/prepare",
  "POST /cluster/background-tasks",
  "POST /cluster/resources/inventory",
  "POST /cluster/browser/status",
  "POST /cluster/browser/config",
  "POST /cluster/browser/cluster-default",
  "POST /cluster/browser/preferences",
  "POST /cluster/browser/operation",
  "POST /cluster/browser/download",
  "POST /cluster/browser/monitor-manage",
  "POST /cluster/browser/monitor-read",
  "POST /cluster/browser/monitor-authorize",
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
  "GET /cluster/git/reviews",
  "GET /cluster/git/review",
  "GET /cluster/git/scope",
  "POST /cluster/git/guide",
  "GET /cluster/git/guide-fresh",
  "GET /cluster/git/guide-latest",
  "POST /cluster/git/story",
  "GET /cluster/git/story-latest",
  "GET /cluster/git/pushes",
  "POST /cluster/git/ask",
  "POST /cluster/git/reviews/ask",
  "GET /cluster/git/github",
  "POST /cluster/git/github",
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
forwardAsyncRouteErrors();
export const app = express();
app.use("/api", performanceDiagnostics.middleware);
export function createApp(): express.Express {
  return app;
}
/** Handlers that may take a request before Express sees it (the relay's phone gateway). */
export const requestInterceptors: Array<(request: IncomingMessage, response: ServerResponse) => boolean> = [];
/** Handlers that may take a WebSocket upgrade before the app socket at /ws (relay connections). */
export const upgradeHandlers: Array<(request: IncomingMessage, socket: Duplex, head: Buffer) => boolean> = [];
export const server = createServer((request, response) => {
  for (const intercept of requestInterceptors) if (intercept(request, response)) return;
  app(request, response);
});
server.on("listening", performanceDiagnostics.start);
server.on("close", () => { void performanceDiagnostics.stop(); });
export const webSocketServer = new WebSocketServer({ noServer: true });
server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
  for (const handle of upgradeHandlers) if (handle(request, socket, head)) return;
  if (new URL(request.url ?? "/", "http://localhost").pathname !== "/ws") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  webSocketServer.handleUpgrade(request, socket, head, (client) => webSocketServer.emit("connection", client, request));
});
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

/** Cluster traffic and work wait for startup reconciliation so a restarting node can become
    ready, but never longer than this: a node whose reconciliation keeps failing must not cut
    itself off from its peers. */
const CLUSTER_STARTUP_GRACE_S = 300;
export function clusterWorkAllowed(): boolean { return flags.startupReady || process.uptime() > CLUSTER_STARTUP_GRACE_S; }
