import { execFile } from "../subprocess.js";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import express from "express";
import { WebSocketServer } from "ws";
import { performanceDiagnostics } from "./performance-diagnostics.js";
import { forwardAsyncRouteErrors } from "./error-capture.js";
const flags = {
  updatePreparing: false,
  updatePreparation: null,
  replicationFlushInProgress: false,
  secretCredentialFlushInProgress: false,
  membershipFlushInProgress: false,
  taskHandoffReconciliationInProgress: false,
  ticketWorkspaceSyncInProgress: false,
  projectDiscoveryInProgress: false,
  ticketWorkspaceSyncRetryAt: 0,
  startupReady: true,
  startupError: void 0,
  startupReadinessInProgress: false
};
const port = Number(process.env.PORT ?? 8790);
const machineRoutes = /* @__PURE__ */ new Set([
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
  "POST /update/prepare"
]);
forwardAsyncRouteErrors();
const app = express();
app.use("/api", performanceDiagnostics.middleware);
function createApp() {
  return app;
}
const server = createServer(app);
server.on("listening", performanceDiagnostics.start);
server.on("close", () => {
  void performanceDiagnostics.stop();
});
const webSocketServer = new WebSocketServer({ server, path: "/ws" });
const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../../public");
const codemirrorDir = path.resolve(dirname, "../../node_modules/codemirror");
const execFileAsync = promisify(execFile);
const idleSessionTimeoutMs = 30 * 60 * 1e3;
const localWriteGraceMs = 15e3;
const watchClients = /* @__PURE__ */ new Map();
const updateContinuationPrompt = "A service update interrupted this turn. Inspect the transcript and working tree, continue unfinished work, and do not repeat completed side effects.";
const CLUSTER_STARTUP_GRACE_S = 300;
function clusterWorkAllowed() {
  return flags.startupReady || process.uptime() > CLUSTER_STARTUP_GRACE_S;
}
export {
  app,
  clusterWorkAllowed,
  codemirrorDir,
  createApp,
  execFileAsync,
  flags,
  idleSessionTimeoutMs,
  localWriteGraceMs,
  machineRoutes,
  port,
  publicDir,
  server,
  updateContinuationPrompt,
  watchClients,
  webSocketServer
};
