import { failUnobservedConversationWorkAfterRestart, retireUnreachableConversationWorkAfterRestart } from "./conversation-work.js";
import { openMergeTransactionCount, recoverMergeTransactions } from "./merge-journal.js";
import { getProject } from "./store.js";
import { listTasks, updateTask } from "./tasks.js";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flushHubDeliveries, pullFromHubs } from "./server/cluster-hubs.js";
import { runReplicationHousekeeping } from "./server/replication-housekeeping.js";
import { removeAllDeletedTranscripts } from "./server/deleted-transcripts.js";
import { flushSuccessionNotices } from "./server/succession.js";
import { flushReplicationOutbox, flushRoutingConfigDeliveries, initializeStartupReadiness, pushRuntimeLeaseSnapshots, reconcileManagedAgentResources, reapInactiveConversations, reconcileTaskConversationRecords, reconcileTaskHandoffs, sweepRuntimeLeases, sweepStaleConversations } from "./server/maintenance.js";
import { runSyncCheck } from "./server/sync-check.js";
import { installBackendErrorCapture } from "./server/error-capture.js";
import { flushPushSubscriptionOutbox } from "./server/push-flush.js";
import { syncNtfyServiceShares } from "./server/ntfy-share.js";
import { flushV2ClusterAdministration } from "./server/cluster-manager.js";
import { reconcileUpdateJobs, startUpdateScheduler } from "./updater.js";
import { activateManagedHarnesses, startHarnessUpdateScheduler } from "./harness-updater.js";
import { clusterWorkAllowed, flags, port, server } from "./server/state.js";
import { browserRuntime, closeBrowserRuntime } from "./server/browser.js";
import { startBrowserMonitors, stopBrowserMonitors } from "./server/browser-monitors.js";
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
import "./server/routes/cluster-v2.js";
import "./server/routes/cluster-manager.js";
import "./server/routes/twins.js";
import "./server/routes/sharing.js";
import "./server/routes/resource-policy.js";
import "./server/routes/preferences.js";
import "./server/routes/routing.js";
import "./server/routes/cluster.js";
import "./server/routes/cluster-tasks.js";
import "./server/routes/platform.js";
import "./server/routes/secrets.js";
import "./server/routes/browser.js";
import "./server/routes/background-tasks.js";
import "./server/routes/browser-monitors.js";
import "./server/routes/projects.js";
import "./server/routes/resources.js";
import "./server/routes/quick-notes.js";
import { cleanupAbandonedByTheWayConversations } from "./server/routes/sessions.js";
import { sweepConversationRetention } from "./server/conversation-retention.js";
import { startCronScheduler } from "./server/cron.js";
import { startQuickNoteScheduler } from "./server/quick-note-dispatch.js";
import "./server/routes/cron.js";
import "./server/routes/tasks.js";
import "./server/routes/worktrees.js";
import "./server/routes/project-files.js";
import "./server/routes/git-review.js";
import "./server/routes/search.js";
import "./server/routes/usage.js";
import "./server/routes/updates.js";
import { app, createApp, server as server2 } from "./server/state.js";
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installBackendErrorCapture();
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close();
    const timeout = setTimeout(() => process.exit(0), 8e3);
    timeout.unref();
    stopBrowserMonitors();
    void closeBrowserRuntime().catch((error) => console.warn("Browser shutdown failed", error)).finally(() => process.exit(0));
  });
  flags.startupReady = false;
  flags.startupError = void 0;
  failUnobservedConversationWorkAfterRestart();
  const recoverMerges = async () => {
    const recovered = await recoverMergeTransactions(async (projectId) => {
      const project = await getProject(projectId);
      return project ? await realpath(project.path) : null;
    });
    for (const outcome of recovered) {
      const task = (await listTasks(outcome.projectId)).find((candidate) => candidate.id === outcome.taskId);
      if (!task) continue;
      if (task.mergeTx !== "open") continue;
      if (outcome.outcome === "rolled-back") {
        await updateTask(outcome.projectId, task.id, { mergeState: "conflicts", mergeTx: null, mergeWarning: "Merge transaction was interrupted and rolled back" });
      } else {
        await updateTask(outcome.projectId, task.id, { mergedAt: task.mergedAt ?? (/* @__PURE__ */ new Date()).toISOString(), mergeState: "merged", mergeTx: null, mergeDigests: null });
      }
    }
  };
  openMergeTransactionCount().then((count) => {
    if (count > 0) console.log(`Recovering ${count} interrupted merge transaction(s) before accepting traffic`);
  }).catch(() => void 0);
  recoverMerges().then(async () => {
    await cleanupAbandonedByTheWayConversations();
    const retired = await retireUnreachableConversationWorkAfterRestart();
    if (retired) console.log(`Retired ${retired} agent run(s) whose dashboard did not survive the restart`);
  }).then(() => {
    activateManagedHarnesses();
    const bindHost = process.env.JOINT_BOB_BIND_HOST || "0.0.0.0";
    server.listen(port, bindHost, () => {
      const address = server.address();
      const listeningPort = typeof address === "object" && address ? address.port : port;
      console.log(`Joint Bob listening on http://${bindHost}:${listeningPort}`);
      void browserRuntime().ready().catch((error) => console.warn("Browser profile recovery failed", error));
      reconcileUpdateJobs();
      startUpdateScheduler();
      startHarnessUpdateScheduler();
      void startCronScheduler().catch((error) => console.error("Scheduled task recovery failed; scheduler not started", error));
      void startQuickNoteScheduler().catch((error) => console.error("Quick note recovery failed; scheduler not started", error));
      void startBrowserMonitors().catch((error) => console.error("Browser monitor startup failed", error));
      const flushClusterWork = () => {
        flushV2ClusterAdministration().catch((error) => console.warn("V2 cluster administration flush failed", error));
        flushReplicationOutbox().catch((error) => console.warn("Replication flush failed", error));
        flushHubDeliveries().catch((error) => console.warn("Hub delivery failed", error));
        flushSuccessionNotices().catch((error) => console.warn("Succession notice delivery failed", error));
        pushRuntimeLeaseSnapshots().catch((error) => console.warn("Runtime lease push failed", error));
        flushRoutingConfigDeliveries().catch((error) => console.warn("Routing configuration flush failed", error));
        flushPushSubscriptionOutbox().catch((error) => console.warn("Push subscription flush failed", error));
        reconcileTaskHandoffs().catch((error) => console.warn("Task handoff reconciliation failed", error));
      };
      let clusterStarted = false;
      const runClusterWork = () => {
        if (!clusterWorkAllowed()) return;
        if (!clusterStarted) {
          clusterStarted = true;
          pullFromHubs().catch((error) => console.warn("Hub pull failed", error));
          removeAllDeletedTranscripts().catch((error) => console.warn("Removing deleted conversation transcripts failed", error));
          syncNtfyServiceShares().catch((error) => console.warn("ntfy service share sync failed", error));
        }
        flushClusterWork();
      };
      initializeStartupReadiness().then(runClusterWork).then(async () => {
        await recoverPendingUpdateRuns();
        await reconcileTaskConversationRecords();
      }).catch((error) => console.warn("Startup recovery failed", error));
      setInterval(() => {
        if (clusterWorkAllowed()) pullFromHubs().catch((error) => console.warn("Hub pull failed", error));
      }, 6e4).unref();
      setInterval(() => reapInactiveConversations().catch((error) => console.warn("Inactive conversation reap failed", error)), 6e4).unref();
      setInterval(() => sweepStaleConversations().catch((error) => console.warn("Stale conversation sweep failed", error)), 6e4).unref();
      setInterval(() => void runSyncCheck(), 5 * 6e4).unref();
      setInterval(() => {
        if (clusterWorkAllowed()) runReplicationHousekeeping().catch((error) => console.warn("Replication housekeeping failed", error));
      }, 15 * 6e4).unref();
      setInterval(() => reconcileManagedAgentResources().catch((error) => console.warn("Agent resource reconciliation failed", error)), 3e4).unref();
      const sweepRetention = () => {
        sweepConversationRetention().catch((error) => console.warn("Conversation retention sweep failed", error));
      };
      setTimeout(sweepRetention, 5 * 6e4).unref();
      setInterval(sweepRetention, 60 * 6e4).unref();
      setInterval(() => {
        void initializeStartupReadiness();
        sweepRuntimeLeases();
        runClusterWork();
      }, 2e3).unref();
    });
  }).catch((error) => {
    console.error("Merge transaction recovery failed; refusing to start", error);
    process.exit(1);
  });
}
export {
  app,
  createApp,
  server2 as server
};
