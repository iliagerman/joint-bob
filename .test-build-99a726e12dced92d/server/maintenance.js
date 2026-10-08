import { agentWorkActive, failStaleConversationWork, listConversationWork, refreshConversationWork } from "../conversation-work.js";
import { reconcileAgentResources } from "../agent-resources.js";
import { getClusterNode } from "../cluster.js";
import { getConversationOwnership } from "../conversation-ownership.js";
import { abandonedShellReason, backgroundTaskConversationId, readActiveBackgroundTaskIdentities, readImplicitShellTasks } from "../background-tasks.js";
import { resolveDataDirectory } from "../data-directory.js";
import { ensureConversationRecord, latestConversationSegment } from "../conversation-records.js";
import { conversationLeaseRunning, conversationRuntimeDatabase, sweepExpiredRuntimeLeases } from "../conversation-runtime.js";
import { getHarnessRuntime, harnessForSessionPath, listHarnesses } from "../harnesses.js";
import { eventsForPeer, recordPeerFailure, recordPeerReceipt } from "../replication.js";
import { currentRoutingConfigTarget, dueRoutingConfigDeliveries, dropRoutingConfigDelivery, recordRoutingConfigDeliveryFailure, recordRoutingConfigDeliverySuccess, routingConfigDatabase } from "../routing-configs.js";
import { supervisorRequest } from "../../scripts/supervisor-client.mjs";
import { signedPost } from "./cluster-v2.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { isTrustedTwin } from "../cluster-sharing-policy.js";
import { mayReplicateEvent, replicationPeers, sendReplicationV2, signedPeerPost } from "./replication-v2.js";
import { getRuntimePeer, listRuntimePeers, runtimeFetch } from "./runtime-peers.js";
import { listProjects } from "../store.js";
import { reconcileSyncthingProjectFolders } from "../syncthing.js";
import { ensureLegacySkillSyncPaused, refreshSharedSkills } from "./skill-sharing.js";
import { listTasks, listUnfinishedOutgoingTaskHandoffs, releaseStaleTaskLease } from "../tasks.js";
import { broadcastSessionsChangedToAllProjects, broadcastToProject, scheduleReviewNotifications, wakeQueuedConversations } from "./realtime.js";
import { replicationReceiptSchema } from "./schemas.js";
import { dropZombieHarnessSessions, harnessSessions, harnessTurnBusy, reapInactiveHarnessSessions } from "./harness-sessions.js";
import { flags } from "./state.js";
import { measureOperation } from "./performance-diagnostics.js";
import { reconcileOutgoingTaskHandoff } from "./task-handoff.js";
import { harnessTaskRuns } from "./task-runs.js";
async function reconcileTaskConversationRecords() {
  const local = await getClusterNode();
  for (const project of await listProjects()) {
    for (const task of await listTasks(project.id)) {
      if (task.currentNodeId !== local.id || !task.sessionPath) continue;
      let adapter;
      let sessionId;
      try {
        adapter = harnessForSessionPath(task.sessionPath);
        sessionId = adapter.paths.sessionId(task.sessionPath);
        if (!sessionId) throw new Error("session path has no transcript identity");
      } catch (error) {
        console.warn(`Task conversation record backfill skipped for ${task.id}: ${error instanceof Error ? error.message : "malformed session path"}`);
        continue;
      }
      await ensureConversationRecord(project.id, adapter.id, sessionId, local.id, task.id);
    }
  }
}
async function reconcileManagedAgentResources() {
  await ensureLegacySkillSyncPaused();
  const resources = await reconcileAgentResources();
  if (resources.conflicts.length) console.warn(`Agent resource reconciliation found ${resources.conflicts.length} conflict(s)`);
  try {
    await refreshSharedSkills();
  } catch (error) {
    console.warn("Selective skill refresh failed", error);
  }
}
async function initializeStartupReadiness() {
  if (flags.startupReady || flags.startupReadinessInProgress) return;
  flags.startupReadinessInProgress = true;
  try {
    const projects = await listProjects();
    await measureOperation("startup.syncthing", () => reconcileSyncthingProjectFolders(projects));
    await measureOperation("startup.agentResources", () => reconcileManagedAgentResources());
    flags.startupReady = true;
    flags.startupError = void 0;
    console.log("Startup reconciliation completed.");
  } catch (error) {
    const failure = error instanceof Error ? error : new Error("Startup reconciliation failed");
    if (flags.startupError?.message !== failure.message) console.warn("Startup reconciliation failed, retrying", failure);
    flags.startupError = failure;
  } finally {
    flags.startupReadinessInProgress = false;
  }
}
async function reconcileTaskHandoffs() {
  if (flags.taskHandoffReconciliationInProgress) return;
  flags.taskHandoffReconciliationInProgress = true;
  try {
    for (const record of await listUnfinishedOutgoingTaskHandoffs()) {
      const peer = await getRuntimePeer(record.destinationNodeId);
      if (!peer) {
        console.warn(`Task handoff ${record.handoffId} reconciliation failed: peer not found`);
        continue;
      }
      try {
        await reconcileOutgoingTaskHandoff(record, peer);
      } catch (error) {
        console.warn(`Task handoff ${record.handoffId} reconciliation failed`, error);
      }
    }
  } finally {
    flags.taskHandoffReconciliationInProgress = false;
  }
}
class RevokedDeliveryTargetError extends Error {
  constructor() {
    super("Target is no longer an eligible member");
  }
}
async function pushPendingRoutingConfigDelivery(localNodeId, delivery) {
  const db = routingConfigDatabase();
  const current = currentRoutingConfigTarget(db, localNodeId, delivery.nodeId);
  if (!current) throw new RevokedDeliveryTargetError();
  if (current.kind === "twin") {
    await signedPeerPost(current, "/api/cluster/v2/routing-configs", { events: [delivery.event] });
    return;
  }
  await signedPost(db, localNodeId, current.nodeId, current.clusterId, "/api/cluster/v2/routing-configs", { events: [delivery.event] });
}
let routingConfigFlushInProgress = false;
async function flushRoutingConfigDeliveries(configId) {
  if (routingConfigFlushInProgress) return [];
  routingConfigFlushInProgress = true;
  try {
    const local = await getClusterNode();
    const db = routingConfigDatabase();
    const results = [];
    for (const delivery of dueRoutingConfigDeliveries(db, /* @__PURE__ */ new Date(), configId)) {
      try {
        await pushPendingRoutingConfigDelivery(local.id, delivery);
        recordRoutingConfigDeliverySuccess(db, delivery.id);
        results.push({ nodeId: delivery.nodeId, name: delivery.name, delivered: true });
      } catch (error) {
        if (error instanceof RevokedDeliveryTargetError) {
          dropRoutingConfigDelivery(db, delivery.id);
          continue;
        }
        const message = error instanceof Error ? error.message : "Distribution failed";
        recordRoutingConfigDeliveryFailure(db, delivery.id, delivery.attempts + 1, message);
        console.warn(`Routing configuration delivery to ${delivery.nodeId} failed: ${message}`);
        results.push({ nodeId: delivery.nodeId, name: delivery.name, delivered: false, error: message });
      }
    }
    return results;
  } finally {
    routingConfigFlushInProgress = false;
  }
}
const RUNTIME_LEASE_TTL_MS = 15e3;
async function buildRuntimeLeaseSnapshot(localNodeId) {
  if (await refreshConversationWork()) {
    broadcastSessionsChangedToAllProjects();
    wakeQueuedConversations();
    for (const project of await listProjects()) scheduleReviewNotifications(project.id);
  }
  const now = /* @__PURE__ */ new Date();
  const updatedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + RUNTIME_LEASE_TTL_MS).toISOString();
  const entries = /* @__PURE__ */ new Map();
  const epochFor = async (engine, sessionId) => {
    const ownership = await getConversationOwnership(engine, sessionId);
    if (ownership && ownership.ownerNodeId !== localNodeId) return null;
    return ownership?.epoch ?? 1;
  };
  for (const shared of harnessSessions.values()) {
    if (!harnessTurnBusy(shared)) continue;
    const sessionId = shared.session.id;
    const key = `${shared.engine}
${sessionId}`;
    const ownershipEpoch = await epochFor(shared.engine, sessionId);
    if (ownershipEpoch === null) continue;
    entries.set(key, { engine: shared.engine, sessionId, ownerNodeId: localNodeId, ownershipEpoch, runId: sessionId, updatedAt, expiresAt });
  }
  for (const work of listConversationWork()) {
    if (!agentWorkActive(work.summary)) continue;
    const key = `${work.engine}
${work.sessionId}`;
    if (entries.has(key)) continue;
    const ownershipEpoch = await epochFor(work.engine, work.sessionId);
    if (ownershipEpoch === null) continue;
    entries.set(key, {
      engine: work.engine,
      sessionId: work.sessionId,
      ownerNodeId: localNodeId,
      ownershipEpoch,
      runId: work.summary.runId,
      backgroundRunning: true,
      updatedAt,
      expiresAt
    });
  }
  for (const identity of readActiveBackgroundTaskIdentities(resolveDataDirectory())) {
    const conversationId = backgroundTaskConversationId(identity);
    if (!conversationId) continue;
    const segment = await latestConversationSegment(conversationId);
    if (!segment) continue;
    const key = `${segment.engine}
${segment.sessionId}`;
    if (entries.has(key)) continue;
    const ownershipEpoch = await epochFor(segment.engine, segment.sessionId);
    if (ownershipEpoch === null) continue;
    entries.set(key, {
      engine: segment.engine,
      sessionId: segment.sessionId,
      ownerNodeId: localNodeId,
      ownershipEpoch,
      runId: conversationId,
      backgroundRunning: true,
      updatedAt,
      expiresAt
    });
  }
  for (const adapter of listHarnesses()) {
    if (!adapter.runtime) continue;
    const external = (await getHarnessRuntime(adapter.id)).externalRunning;
    if (!external) continue;
    for (const run of await external()) {
      const key = `${adapter.id}
${run.sessionId}`;
      if (entries.has(key)) continue;
      const ownershipEpoch = await epochFor(adapter.id, run.sessionId);
      if (ownershipEpoch === null) continue;
      entries.set(key, { engine: adapter.id, sessionId: run.sessionId, ownerNodeId: localNodeId, ownershipEpoch, runId: run.runId, updatedAt, expiresAt });
    }
  }
  return [...entries.values()];
}
let runtimeLeaseBuildInProgress = false;
const runtimeLeasePushesInFlight = /* @__PURE__ */ new Set();
let localRuntimeLeaseSignature = "[]";
async function pushRuntimeLeaseSnapshot(peer, body) {
  try {
    const response = await runtimeFetch(`${peer.url}/api/cluster/sessions/runtime-snapshot`, {
      method: "POST",
      // Our own machine token, so the receiving peer can bind the snapshot to
      // this node's identity instead of trusting the declared nodeId.
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(5e3)
    });
    if (!response.ok) throw new Error(`Peer returned ${response.status}`);
  } catch (error) {
    console.warn(`Runtime lease push to ${peer.id} failed: ${error instanceof Error ? error.message : "lease replication failed"}`);
  }
}
function pushToIdlePeers(peers, push) {
  for (const peer of peers) {
    if (runtimeLeasePushesInFlight.has(peer.id)) continue;
    runtimeLeasePushesInFlight.add(peer.id);
    void push(peer).finally(() => runtimeLeasePushesInFlight.delete(peer.id));
  }
}
async function pushRuntimeLeaseSnapshots() {
  if (runtimeLeaseBuildInProgress) return;
  runtimeLeaseBuildInProgress = true;
  try {
    const local = await getClusterNode();
    const leases = await buildRuntimeLeaseSnapshot(local.id);
    const signature = JSON.stringify(leases.map(({ engine, sessionId, runId, ownershipEpoch, backgroundRunning }) => [engine, sessionId, runId, ownershipEpoch, Boolean(backgroundRunning)]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
    if (signature !== localRuntimeLeaseSignature) {
      localRuntimeLeaseSignature = signature;
      broadcastSessionsChangedToAllProjects();
      for (const project of await listProjects()) scheduleReviewNotifications(project.id);
    }
    const peers = await listRuntimePeers();
    if (!peers.length) return;
    const generatedAt = leases.length ? leases[0].updatedAt : (/* @__PURE__ */ new Date()).toISOString();
    const body = JSON.stringify({ nodeId: local.id, generatedAt, leases });
    pushToIdlePeers(peers, (peer) => pushRuntimeLeaseSnapshot(peer, body));
  } finally {
    runtimeLeaseBuildInProgress = false;
  }
}
let shellReapInProgress = false;
async function reapInactiveConversations(now = Date.now(), data = resolveDataDirectory()) {
  if (shellReapInProgress) return;
  shellReapInProgress = true;
  try {
    const shells = readImplicitShellTasks(data);
    const liveCallers = new Set(shells.filter((shell) => shell.callerUntil > now).map((shell) => shell.identity));
    await reapInactiveHarnessSessions(now, liveCallers);
    for (const shell of shells) {
      if (shell.callerUntil > now) continue;
      const conversationId = backgroundTaskConversationId(shell.identity);
      const exists = Boolean(conversationId) && Boolean(await latestConversationSegment(conversationId));
      const reason = abandonedShellReason(shell.startedAt, shell.lastOutputAt, exists, now);
      if (!reason) continue;
      try {
        await supervisorRequest(data, { action: "stop", id: shell.id });
        console.warn(`Stopped abandoned shell task ${shell.id}: ${reason}`);
      } catch (error) {
        console.warn(`Could not stop abandoned shell task ${shell.id}`, error);
      }
    }
  } finally {
    shellReapInProgress = false;
  }
}
const STALE_WORK_MS = 15 * 6e4;
const STALE_TASK_RUN_MS = 5 * 6e4;
const staleTaskRunsSince = /* @__PURE__ */ new Map();
let staleSweepInProgress = false;
async function sweepStaleConversations(now = Date.now()) {
  if (staleSweepInProgress) return 0;
  staleSweepInProgress = true;
  try {
    const zombies = dropZombieHarnessSessions(now);
    const alive = /* @__PURE__ */ new Set();
    for (const shared of harnessSessions.values()) if (harnessTurnBusy(shared)) alive.add(`${shared.engine}
${shared.session.id}`);
    for (const adapter of listHarnesses()) {
      if (!adapter.runtime) continue;
      const external = (await getHarnessRuntime(adapter.id)).externalRunning;
      if (external) for (const run of await external()) alive.add(`${adapter.id}
${run.sessionId}`);
    }
    for (const identity of readActiveBackgroundTaskIdentities(resolveDataDirectory())) {
      const conversationId = backgroundTaskConversationId(identity);
      const segment = conversationId ? await latestConversationSegment(conversationId) : void 0;
      if (segment) alive.add(`${segment.engine}
${segment.sessionId}`);
    }
    const failedWork = failStaleConversationWork((engine, sessionId) => alive.has(`${engine}
${sessionId}`) || conversationLeaseRunning(engine, sessionId), STALE_WORK_MS, now);
    for (const work of failedWork) console.warn(`Cleared stale background work for ${work.engine} conversation ${work.sessionId}`);
    const local = await getClusterNode();
    const liveShared = new Set(harnessSessions.values());
    const seen = /* @__PURE__ */ new Set();
    let clearedTasks = 0;
    for (const project of await listProjects()) {
      for (const task of await listTasks(project.id)) {
        const run = harnessTaskRuns.get(task.id);
        const abandoned = task.executionState === "running" && task.leaseOwnerNodeId === local.id && (!run || !liveShared.has(run.shared)) && (!task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) <= now);
        if (!abandoned) continue;
        seen.add(task.id);
        const since = staleTaskRunsSince.get(task.id) ?? now;
        staleTaskRunsSince.set(task.id, since);
        if (now - since < STALE_TASK_RUN_MS) continue;
        if (run) harnessTaskRuns.delete(task.id);
        if (!await releaseStaleTaskLease(project.id, task.id, local.id, new Date(now))) continue;
        console.warn(`Marked stuck ticket run ${task.id} failed: its lease expired and no agent is running it`);
        clearedTasks += 1;
        broadcastToProject(project.id, { type: "tasksChanged" });
      }
    }
    for (const taskId of staleTaskRunsSince.keys()) if (!seen.has(taskId)) staleTaskRunsSince.delete(taskId);
    const cleared = zombies.length + failedWork.length + clearedTasks;
    if (cleared) {
      broadcastSessionsChangedToAllProjects();
      for (const project of await listProjects()) scheduleReviewNotifications(project.id);
    }
    return cleared;
  } finally {
    staleSweepInProgress = false;
  }
}
function sweepRuntimeLeases() {
  if (sweepExpiredRuntimeLeases(conversationRuntimeDatabase()).length) broadcastSessionsChangedToAllProjects();
}
async function flushReplicationOutbox() {
  if (flags.replicationFlushInProgress) return;
  flags.replicationFlushInProgress = true;
  try {
    const db = await clusterV2Database(), local = await getClusterNode();
    for (const peer of replicationPeers(db, local.id).filter((peer2) => isTrustedTwin(db, local.id, peer2.nodeId))) {
      const events = await eventsForPeer(peer.nodeId, /* @__PURE__ */ new Date(), (event) => event.originNodeId === local.id && mayReplicateEvent(db, local.id, peer.nodeId, event));
      if (!events.length) continue;
      try {
        const receipt = replicationReceiptSchema.parse(await sendReplicationV2(peer, events));
        await recordPeerReceipt(peer.nodeId, receipt.received);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Peer replication failed";
        await recordPeerFailure(peer.nodeId, events.map((event) => event.id), message);
        console.warn(`Replication to ${peer.nodeId} failed: ${message}`);
      }
    }
  } finally {
    flags.replicationFlushInProgress = false;
  }
}
export {
  STALE_TASK_RUN_MS,
  STALE_WORK_MS,
  buildRuntimeLeaseSnapshot,
  flushReplicationOutbox,
  flushRoutingConfigDeliveries,
  initializeStartupReadiness,
  pushRuntimeLeaseSnapshots,
  pushToIdlePeers,
  reapInactiveConversations,
  reconcileManagedAgentResources,
  reconcileTaskConversationRecords,
  reconcileTaskHandoffs,
  sweepRuntimeLeases,
  sweepStaleConversations
};
