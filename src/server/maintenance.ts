import { agentWorkActive, listConversationWork, refreshConversationWork } from "../conversation-work.js";
import { AGENT_RESOURCES_FOLDER_ID, agentResourcesRoot, reconcileAgentResources } from "../agent-resources.js";
import { type ClusterPeer, dueMembershipDeliveries, getClusterMachineToken, getClusterMembership, getClusterNode, getClusterPeer, listClusterPeers, recordMembershipDelivered, recordMembershipFailure } from "../cluster.js";
import { getConversationOwnership } from "../conversation-ownership.js";
import { abandonedShellReason, backgroundTaskConversationId, readActiveBackgroundTaskIdentities, readImplicitShellTasks } from "../background-tasks.js";
import { resolveDataDirectory } from "../data-directory.js";
import { ensureConversationRecord, latestConversationSegment } from "../conversation-records.js";
import { conversationRuntimeDatabase, type RuntimeLeaseInput, sweepExpiredRuntimeLeases } from "../conversation-runtime.js";
import { getHarnessRuntime, harnessForSessionPath, listHarnesses, listHarnessSyncFolders } from "../harnesses.js";
import { eventsForPeer, recordPeerFailure, recordPeerReceipt } from "../replication.js";
import { enqueueSecretCredentialSync, recordSecretCredentialFailure, recordSecretCredentialReceipt, secretCredentialEventsForPeer } from "../secret-replication.js";
import { currentRoutingConfigTarget, dueRoutingConfigDeliveries, dropRoutingConfigDelivery, recordRoutingConfigDeliveryFailure, recordRoutingConfigDeliverySuccess, routingConfigDatabase, type PendingRoutingConfigDelivery } from "../routing-configs.js";
import { supervisorRequest } from "../../scripts/supervisor-client.mjs";
import { signedPost } from "./cluster-v2.js";
import { selectiveSharingActive } from "../cluster-v2-mode.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { mayReplicateEvent, replicationPeers, sendReplicationV2 } from "./replication-v2.js";
import { getRuntimePeer, listRuntimePeers, runtimeFetch } from "./runtime-peers.js";
import { listSecretAccounts, type SecretAccount } from "../secrets.js";
import { listProjects } from "../store.js";
import { ensureAgentResourcesFolder, ensureConversationSyncFolders, ensureTicketWorkspaceFolder, pauseEngineSyncFolders, reconcileSyncthingProjectFolders, syncthingDeviceId } from "../syncthing.js";
import { TICKET_WORKSPACE_FOLDER_ID, ticketWorkspaceRoot } from "../task-workspaces.js";
import { listTasks, listUnfinishedOutgoingTaskHandoffs } from "../tasks.js";
import type { HarnessId } from "../types.js";
import { fetchPeerInventory } from "./cluster-helpers.js";
import { broadcastSessionsChangedToAllProjects, scheduleReviewNotifications, wakeQueuedConversations } from "./realtime.js";
import { replicationReceiptSchema } from "./schemas.js";
import { harnessSessions, harnessTurnBusy, reapInactiveHarnessSessions } from "./harness-sessions.js";
import { configuredTicketWorkspacePeers, flags } from "./state.js";
import { reconcileOutgoingTaskHandoff } from "./task-handoff.js";

/* Syncthing is often still binding its API port when the node boots beside it. A
   single failed attempt used to leave the node "starting" for its whole lifetime,
   which silently disables peer project discovery, so the attempt repeats from the
   maintenance interval until it succeeds. Repeats of the same failure stay quiet;
   the completion line is what says the node recovered. */
export async function reconcileTaskConversationRecords(): Promise<void> {
  const local = await getClusterNode();
  for (const project of await listProjects()) {
    for (const task of await listTasks(project.id)) {
      if (task.currentNodeId !== local.id || !task.sessionPath) continue;
      let adapter: ReturnType<typeof harnessForSessionPath>;
      let sessionId: string | undefined;
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

export async function reconcileManagedAgentResources(): Promise<void> {
  const resources = await reconcileAgentResources();
  if (resources.conflicts.length) console.warn(`Agent resource reconciliation found ${resources.conflicts.length} conflict(s)`);
}

export async function initializeStartupReadiness(): Promise<void> {
  if (flags.startupReady || flags.startupReadinessInProgress) return;
  flags.startupReadinessInProgress = true;
  try {
    const projects = await listProjects();
    await reconcileSyncthingProjectFolders(projects);
    await reconcileManagedAgentResources();
    flags.startupReady = true;
    flags.startupError = undefined;
    console.log("Startup reconciliation completed.");
  } catch (error) {
    const failure = error instanceof Error ? error : new Error("Startup reconciliation failed");
    if (flags.startupError?.message !== failure.message) console.warn("Startup reconciliation failed, retrying", failure);
    flags.startupError = failure;
  } finally {
    flags.startupReadinessInProgress = false;
  }
}

async function configureTicketWorkspacePeer(peer: ClusterPeer, localDeviceId: string, localDeviceName: string): Promise<void> {
  const inventory = await fetchPeerInventory(peer);
  if (!inventory.syncDeviceId) throw new Error("Peer Syncthing device ID is unavailable");
  await ensureTicketWorkspaceFolder(ticketWorkspaceRoot(), inventory.syncDeviceId, inventory.node.name);
  await ensureAgentResourcesFolder(agentResourcesRoot(), inventory.syncDeviceId, inventory.node.name);
  const conversationFolders = listHarnessSyncFolders();
  await ensureConversationSyncFolders(conversationFolders, inventory.syncDeviceId, inventory.node.name);
  for (const folderId of [
    TICKET_WORKSPACE_FOLDER_ID,
    AGENT_RESOURCES_FOLDER_ID,
    ...conversationFolders.map((folder) => folder.id),
  ]) {
    const response = await fetch(`${peer.url}/api/cluster/sync/share`, {
      method: "POST",
      headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ folderId, deviceId: localDeviceId, deviceName: localDeviceName }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Peer managed folder share failed: ${response.status}`);
  }
}

export async function reconcileTicketWorkspaceSync(): Promise<void> {
  if(await selectiveSharingActive())return;
  if (flags.ticketWorkspaceSyncInProgress || Date.now() < flags.ticketWorkspaceSyncRetryAt) return;
  flags.ticketWorkspaceSyncInProgress = true;
  let failed = false;
  try {
    const peers = await listClusterPeers();
    const localDeviceId = await syncthingDeviceId();
    if (!localDeviceId) return;
    await pauseEngineSyncFolders();
    await ensureTicketWorkspaceFolder();
    await ensureConversationSyncFolders(listHarnessSyncFolders());
    await ensureAgentResourcesFolder(agentResourcesRoot());
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
    if (failed) flags.ticketWorkspaceSyncRetryAt = Date.now() + 60_000;
    flags.ticketWorkspaceSyncInProgress = false;
  }
}

export async function flushMembershipOutbox(): Promise<void> {
  if (flags.membershipFlushInProgress) return;
  flags.membershipFlushInProgress = true;
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
    flags.membershipFlushInProgress = false;
  }
}

export async function reconcileTaskHandoffs(): Promise<void> {
  if (flags.taskHandoffReconciliationInProgress) return;
  flags.taskHandoffReconciliationInProgress = true;
  try {
    for (const record of await listUnfinishedOutgoingTaskHandoffs()) {
      const peer = await getRuntimePeer(record.destinationNodeId);
      if (!peer) {
        console.warn(`Task handoff ${record.handoffId} reconciliation failed: peer not found`);
        continue;
      }
      try { await reconcileOutgoingTaskHandoff(record, peer); }
      catch (error) { console.warn(`Task handoff ${record.handoffId} reconciliation failed`, error); }
    }
  } finally {
    flags.taskHandoffReconciliationInProgress = false;
  }
}

/** Pushes everything currently enrolled for this peer, one 100-event batch at a time,
    until the peer has acknowledged all of it or a batch fails. */
export async function pushSecretCredentialsToPeer(peer: ClusterPeer): Promise<{ delivered: number; error?: string }> {
  let delivered = 0;
  for (;;) {
    const events = await secretCredentialEventsForPeer(peer.id);
    if (!events.length) return { delivered };
    try {
      const response = await fetch(`${peer.url}/api/cluster/secrets/events`, {
        method: "POST",
        headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Peer returned ${response.status}`);
      const receipt = replicationReceiptSchema.parse(await response.json());
      // A peer that acknowledges nothing would loop forever on the same batch.
      if (!receipt.received.length) throw new Error("Peer acknowledged no events");
      await recordSecretCredentialReceipt(peer.id, receipt.received);
      delivered += receipt.received.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Peer secret credential replication failed";
      await recordSecretCredentialFailure(peer.id, events.map((event) => event.id), message);
      console.warn(`Secret credential replication to ${peer.id} failed: ${message}`);
      return { delivered, error: message };
    }
  }
}

class RevokedDeliveryTargetError extends Error {
  constructor() { super("Target is no longer an eligible member"); }
}

/** Pushes one pending routing-configuration delivery. Eligibility is re-resolved at
    push time against the node's current clusters and pairings — not the cluster the
    delivery was enrolled under — so a peer that left one shared cluster but remains in
    another still receives its pending event through that one, while a peer with no
    current membership (or a legacy pending after selective mode activated) is dropped
    rather than retried or transmitted. */
async function pushPendingRoutingConfigDelivery(localNodeId: string, delivery: PendingRoutingConfigDelivery): Promise<void> {
  const db = routingConfigDatabase();
  const peers = await listClusterPeers();
  const current = currentRoutingConfigTarget(db, localNodeId, peers, delivery.nodeId);
  if (!current) throw new RevokedDeliveryTargetError();
  if (current.kind === "legacy") {
    const peer = peers.find((candidate) => candidate.id === current.nodeId)!;
    const response = await fetch(`${peer.url}/api/cluster/routing-configs/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${peer.token}` },
      body: JSON.stringify({ events: [delivery.event] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Peer returned ${response.status}`);
    return;
  }
  await signedPost(db, localNodeId, current.nodeId, current.clusterId!, "/api/cluster/v2/routing-configs", { events: [delivery.event] });
}

let routingConfigFlushInProgress = false;

/** Delivers every due pending routing-configuration event: used by the share, update,
    and delete handlers for an immediate attempt and by the maintenance interval for
    retries while a receiver is offline. A configuration id scopes the flush so one
    share's result reporting describes only that configuration's targets; the
    maintenance interval flushes everything due. */
export async function flushRoutingConfigDeliveries(configId?: string): Promise<Array<{ nodeId: string; name: string; delivered: boolean; error?: string }>> {
  if (routingConfigFlushInProgress) return [];
  routingConfigFlushInProgress = true;
  try {
    const local = await getClusterNode();
    const db = routingConfigDatabase();
    const results: Array<{ nodeId: string; name: string; delivered: boolean; error?: string }> = [];
    for (const delivery of dueRoutingConfigDeliveries(db, new Date(), configId)) {
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

/** Retries deliveries an enrolled event still owes a peer, whether a save or a manual sync
    enrolled it. */
export async function flushSecretCredentialOutbox(): Promise<void> {
  if (flags.secretCredentialFlushInProgress) return;
  flags.secretCredentialFlushInProgress = true;
  try {
    for (const peer of await listClusterPeers()) await pushSecretCredentialsToPeer(peer);
  } finally {
    flags.secretCredentialFlushInProgress = false;
  }
}

/** A saved account marked to replicate leaves for every paired node right away, so the
    checkbox means what it says. The manual "Sync to nodes" action remains for retries and
    for nodes paired after the save. */
export async function replicateWorkspaceSecretChanges(accountIds: string[], actorId: string): Promise<void> {
  const changed = new Set(accountIds);
  const account = (await listSecretAccounts()).find((candidate) => candidate.replicate && changed.has(candidate.id));
  if (account) await replicateSecretAccount(account, actorId);
}

export async function replicateSecretAccount(account: SecretAccount, actorId: string): Promise<Array<{ peerId: string; name: string; delivered: number; error?: string }> | undefined> {
  if (!account.replicate) return undefined;
  const peers = await listClusterPeers();
  if (!peers.length) return [];
  await enqueueSecretCredentialSync(peers.map((peer) => peer.id), actorId);
  const results: Array<{ peerId: string; name: string; delivered: number; error?: string }> = [];
  for (const peer of peers) {
    const outcome = await pushSecretCredentialsToPeer(peer);
    results.push({ peerId: peer.id, name: peer.name, delivered: outcome.delivered, ...(outcome.error ? { error: outcome.error } : {}) });
  }
  return results;
}

/** A peer's current conversation running set. See conversation-runtime.ts for the lease rules. */
const RUNTIME_LEASE_TTL_MS = 15_000;

export async function buildRuntimeLeaseSnapshot(localNodeId: string): Promise<RuntimeLeaseInput[]> {
  if (await refreshConversationWork()) {
    broadcastSessionsChangedToAllProjects();
    wakeQueuedConversations();
    for (const project of await listProjects()) scheduleReviewNotifications(project.id);
  }
  const now = new Date();
  const updatedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + RUNTIME_LEASE_TTL_MS).toISOString();
  const entries = new Map<string, RuntimeLeaseInput>();
  // Advertise only conversations this node is allowed to run: a stale in-flight
  // turn must not borrow the new owner's epoch after a transfer.
  const epochFor = async (engine: HarnessId, sessionId: string): Promise<number | null> => {
    const ownership = await getConversationOwnership(engine, sessionId);
    if (ownership && ownership.ownerNodeId !== localNodeId) return null;
    return ownership?.epoch ?? 1;
  };
  for (const shared of harnessSessions.values()) {
    if (!harnessTurnBusy(shared)) continue;
    const sessionId = shared.session.id;
    const key = `${shared.engine}\n${sessionId}`;
    const ownershipEpoch = await epochFor(shared.engine, sessionId);
    if (ownershipEpoch === null) continue;
    entries.set(key, { engine: shared.engine, sessionId, ownerNodeId: localNodeId, ownershipEpoch, runId: sessionId, updatedAt, expiresAt });
  }
  for (const work of listConversationWork()) {
    if (!agentWorkActive(work.summary)) continue;
    const key = `${work.engine}\n${work.sessionId}`;
    if (entries.has(key)) continue;
    const ownershipEpoch = await epochFor(work.engine, work.sessionId);
    if (ownershipEpoch === null) continue;
    entries.set(key, {
      engine: work.engine, sessionId: work.sessionId, ownerNodeId: localNodeId,
      ownershipEpoch, runId: work.summary.runId, backgroundRunning: true, updatedAt, expiresAt,
    });
  }
  // A supervised command outlives the turn that started it, so the conversation it
  // belongs to keeps advertising background work until the command ends. The task
  // identity names the logical conversation; the lease names the segment facing it.
  for (const identity of readActiveBackgroundTaskIdentities(resolveDataDirectory())) {
    const conversationId = backgroundTaskConversationId(identity);
    if (!conversationId) continue;
    const segment = await latestConversationSegment(conversationId);
    if (!segment) continue;
    const key = `${segment.engine}\n${segment.sessionId}`;
    if (entries.has(key)) continue;
    const ownershipEpoch = await epochFor(segment.engine, segment.sessionId);
    if (ownershipEpoch === null) continue;
    entries.set(key, {
      engine: segment.engine, sessionId: segment.sessionId, ownerNodeId: localNodeId,
      ownershipEpoch, runId: conversationId, backgroundRunning: true, updatedAt, expiresAt,
    });
  }
  for (const adapter of listHarnesses()) {
    if (!adapter.runtime) continue;
    const external = (await getHarnessRuntime(adapter.id)).externalRunning;
    if (!external) continue;
    for (const run of await external()) {
      const key = `${adapter.id}\n${run.sessionId}`;
      if (entries.has(key)) continue;
      const ownershipEpoch = await epochFor(adapter.id, run.sessionId);
      if (ownershipEpoch === null) continue;
      entries.set(key, { engine: adapter.id, sessionId: run.sessionId, ownerNodeId: localNodeId, ownershipEpoch, runId: run.runId, updatedAt, expiresAt });
    }
  }
  return [...entries.values()];
}

let runtimeLeasePushInProgress = false;
let localRuntimeLeaseSignature = "[]";

export async function pushRuntimeLeaseSnapshots(): Promise<void> {
  // Snapshots must be applied in generation order; a push still in flight when the
  // interval fires again is skipped rather than overlapped.
  if (runtimeLeasePushInProgress) return;
  runtimeLeasePushInProgress = true;
  try {
    const local = await getClusterNode();
    const leases = await buildRuntimeLeaseSnapshot(local.id);
    const signature = JSON.stringify(leases
      .map(({ engine, sessionId, runId, ownershipEpoch, backgroundRunning }) => [engine, sessionId, runId, ownershipEpoch, Boolean(backgroundRunning)])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
    if (signature !== localRuntimeLeaseSignature) {
      localRuntimeLeaseSignature = signature;
      broadcastSessionsChangedToAllProjects();
      for (const project of await listProjects()) scheduleReviewNotifications(project.id);
    }
    const peers = await listRuntimePeers();
    if (!peers.length) return;
    const generatedAt = leases.length ? leases[0].updatedAt : new Date().toISOString();
    // One slow peer must not delay the others past the lease TTL.
    await Promise.all(peers.map(async (peer) => {
      try {
        const response = await runtimeFetch(`${peer.url}/api/cluster/sessions/runtime-snapshot`, {
          method: "POST",
          // Our own machine token, so the receiving peer can bind the snapshot to
          // this node's identity instead of trusting the declared nodeId.
          headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ nodeId: local.id, generatedAt, leases }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`Peer returned ${response.status}`);
      } catch (error) {
        console.warn(`Runtime lease push to ${peer.id} failed: ${error instanceof Error ? error.message : "lease replication failed"}`);
      }
    }));
  } finally {
    runtimeLeasePushInProgress = false;
  }
}

let shellReapInProgress = false;

/* Reaps tool-call shells whose turn is never coming back. A job started with
   `joint-bob-task start` is meant to be long-lived and is never reaped. */
export async function reapInactiveConversations(now = Date.now(), data = resolveDataDirectory()): Promise<void> {
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

/** Notify browsers of expired crash heartbeats. */
export function sweepRuntimeLeases(): void {
  if (sweepExpiredRuntimeLeases(conversationRuntimeDatabase()).length) broadcastSessionsChangedToAllProjects();
}

export async function flushReplicationOutbox(): Promise<void> {
  if (flags.replicationFlushInProgress) return;
  flags.replicationFlushInProgress = true;
  try {
    const selective = await selectiveSharingActive();
    const db = await clusterV2Database(), local = await getClusterNode();
    const peers = selective ? replicationPeers(db, local.id).map((peer) => ({ ...peer, id: peer.nodeId, token: "" })) : await listClusterPeers();
    for (const peer of peers) {
      const events = await eventsForPeer(peer.id, new Date(), selective
        ? (event) => event.originNodeId === local.id && mayReplicateEvent(db, local.id, peer.id, event) : undefined);
      if (!events.length) continue;
      try {
        const result = selective ? await sendReplicationV2({ nodeId: peer.id, name: peer.name, url: peer.url }, events) : await (async () => {
        const response = await fetch(`${peer.url}/api/cluster/events`, {
          method: "POST",
          headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ events }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Peer returned ${response.status}`);
        return response.json();
        })();
        const receipt = replicationReceiptSchema.parse(result);
        await recordPeerReceipt(peer.id, receipt.received);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Peer replication failed";
        await recordPeerFailure(peer.id, events.map((event) => event.id), message);
        console.warn(`Replication to ${peer.id} failed: ${message}`);
      }
    }
  } finally {
    flags.replicationFlushInProgress = false;
  }
}
