// Composition root. Route modules register on the shared Express app when they
// load, so they are imported here in the original registration order: the /api
// auth gate in routes/core must run before every protected route, and the error
// handler in routes/updates must come last.
import { openMergeTransactionCount, recoverMergeTransactions } from "./merge-journal.js";
import { getProject } from "./store.js";
import { listTasks, updateTask } from "./tasks.js";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverMissingPeerProjects } from "./server/cluster-helpers.js";
import { flushMembershipOutbox, flushReplicationOutbox, flushSecretCredentialOutbox, initializeStartupReadiness, pushRuntimeLeaseSnapshots, reconcileManagedAgentResources, reconcileTaskConversationRecords, reconcileTaskHandoffs, reconcileTicketWorkspaceSync, sweepRuntimeLeases } from "./server/maintenance.js";
import { reconcileUpdateJobs, startUpdateScheduler } from "./updater.js";
import { flags, port, server } from "./server/state.js";
import { browserRuntime, closeBrowserRuntime } from "./server/browser.js";
import { recoverPendingUpdateRuns } from "./server/task-runs.js";
import "./server/schemas.js";
import "./server/http-auth.js";
import "./server/task-handoff.js";
import "./server/projects.js";
import "./server/realtime.js";
import "./server/task-runs.js";
import "./server/chat.js";
import "./server/chat-socket.js";
import "./server/maintenance.js";
import "./server/routes/core.js";
import "./server/routes/preferences.js";
import "./server/routes/cluster.js";
import "./server/routes/cluster-tasks.js";
import "./server/routes/platform.js";
import "./server/routes/secrets.js";
import "./server/routes/browser.js";
import "./server/routes/projects.js";
import "./server/routes/sessions.js";
import { startCronScheduler } from "./server/cron.js";
import "./server/routes/cron.js";
import "./server/routes/tasks.js";
import "./server/routes/project-files.js";
import "./server/routes/search.js";
import "./server/routes/updates.js";
export { app, createApp, server } from "./server/state.js";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Playwright installs signal handlers of its own. Explicitly finish node shutdown
  // after closing Chrome rather than leaving the HTTP server alive after SIGTERM.
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close();
    const timeout = setTimeout(() => process.exit(0), 8000); timeout.unref();
    void closeBrowserRuntime().catch(error => console.warn("Browser shutdown failed", error)).finally(() => process.exit(0));
  });
  flags.startupReady = false;
  flags.startupError = undefined;
  // Interrupted merge transactions roll back before the node accepts any traffic
  // (TICKET-MERGE-PLAN.md §8); committed ones reconcile their task records.
  const recoverMerges = async (): Promise<void> => {
    const recovered = await recoverMergeTransactions(async (projectId) => {
      const project = await getProject(projectId);
      return project ? await realpath(project.path) : null;
    });
    for (const outcome of recovered) {
      const task = (await listTasks(outcome.projectId)).find((candidate) => candidate.id === outcome.taskId);
      if (!task) continue;
      // Rolled-back rows keep returning until reconciled; skip settled tasks.
      if (task.mergeTx !== "open") continue;
      if (outcome.outcome === "rolled-back") {
        await updateTask(outcome.projectId, task.id, { mergeState: "conflicts", mergeTx: null, mergeWarning: "Merge transaction was interrupted and rolled back" });
      } else {
        await updateTask(outcome.projectId, task.id, { mergedAt: task.mergedAt ?? new Date().toISOString(), mergeState: "merged", mergeTx: null, mergeDigests: null });
      }
    }
  };
  openMergeTransactionCount().then((count) => {
    if (count > 0) console.log(`Recovering ${count} interrupted merge transaction(s) before accepting traffic`);
  }).catch(() => undefined);
  recoverMerges()
    .then(() => {
  const bindHost = process.env.JOINT_BOB_BIND_HOST || "0.0.0.0";
  server.listen(port, bindHost, () => {
    const address = server.address();
    const listeningPort = typeof address === "object" && address ? address.port : port;
    console.log(`Joint Bob listening on http://${bindHost}:${listeningPort}`);
    void browserRuntime().ready().catch(error => console.warn("Browser profile recovery failed", error));
    reconcileUpdateJobs();
    startUpdateScheduler();
    void startCronScheduler().catch(error => console.error("Scheduled task recovery failed; scheduler not started", error));
    initializeStartupReadiness()
      .then(async () => { await recoverPendingUpdateRuns(); await reconcileTicketWorkspaceSync(); await reconcileTaskConversationRecords(); })
      .catch((error) => console.warn("Ticket workspace sync failed", error));
    flushMembershipOutbox().catch((error) => console.warn("Membership flush failed", error));
    flushReplicationOutbox().catch((error) => console.warn("Replication flush failed", error));
    pushRuntimeLeaseSnapshots().catch((error) => console.warn("Runtime lease push failed", error));
    flushSecretCredentialOutbox().catch((error) => console.warn("Secret credential flush failed", error));
    reconcileTaskHandoffs().catch((error) => console.warn("Task handoff reconciliation failed", error));
    discoverMissingPeerProjects().catch((error) => console.warn("Project discovery failed", error));
    setInterval(() => discoverMissingPeerProjects().catch((error) => console.warn("Project discovery failed", error)), 10_000).unref();
    setInterval(() => reconcileManagedAgentResources().catch((error) => console.warn("Agent resource reconciliation failed", error)), 30_000).unref();
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
  })
    .catch((error) => {
      // Fail closed: a node that cannot settle its merge transactions must not
      // accept mutating traffic (TICKET-MERGE-PLAN.md §8).
      console.error("Merge transaction recovery failed; refusing to start", error);
      process.exit(1);
    });
}
