import { agentWorkActive, listConversationWork, refreshConversationWork } from "../conversation-work.js";
import { AGENT_RESOURCES_FOLDER_ID, agentResourcesRoot, reconcileAgentResources } from "../agent-resources.js";
import { listRunningClaudeSessions } from "../claude-runtime.js";
import { listRunningPiSessions } from "../pi-runtime.js";
import { type ClusterPeer, dueMembershipDeliveries, getClusterMachineToken, getClusterMembership, getClusterNode, getClusterPeer, listClusterPeers, recordMembershipDelivered, recordMembershipFailure } from "../cluster.js";
import { getConversationOwnership } from "../conversation-ownership.js";
import { ensureConversationRecord } from "../conversation-records.js";
import { conversationRuntimeDatabase, type RuntimeLeaseInput, sweepExpiredRuntimeLeases } from "../conversation-runtime.js";
import { harnessForSessionPath, listHarnessSyncFolders } from "../harnesses.js";
import { eventsForPeer, recordPeerFailure, recordPeerReceipt } from "../replication.js";
import { enqueueSecretCredentialSync, recordSecretCredentialFailure, recordSecretCredentialReceipt, secretCredentialEventsForPeer } from "../secret-replication.js";
import { listSecretAccounts, type SecretAccount } from "../secrets.js";
import { listProjects } from "../store.js";
import { ensureAgentResourcesFolder, ensureConversationSyncFolders, ensureTicketWorkspaceFolder, pauseEngineSyncFolders, reconcileSyncthingProjectFolders, syncthingDeviceId } from "../syncthing.js";
import { TICKET_WORKSPACE_FOLDER_ID, ticketWorkspaceRoot } from "../task-workspaces.js";
import { listTasks, listUnfinishedOutgoingTaskHandoffs } from "../tasks.js";
import type { HarnessId } from "../types.js";
import { claudeRunKey } from "./chat.js";
import { fetchPeerInventory } from "./cluster-helpers.js";
import { broadcastSessionsChangedToAllProjects, scheduleReviewNotifications } from "./realtime.js";
import { replicationReceiptSchema } from "./schemas.js";
import { claudeClients, configuredTicketWorkspacePeers, flags, recoveredClaudeChats, runningClaudeSessionPaths, sharedSessions } from "./state.js";
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
      const peer = await getClusterPeer(record.destinationNodeId);
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
  for (const shared of new Set(sharedSessions.values())) {
    const work = listConversationWork("pi", shared.handle.session.sessionId);
    for (const tracked of work) {
      const run = shared.agentRuns.get(tracked.summary.runId);
      if (run) run.summary = tracked.summary;
    }
    const runningAgentRun = [...shared.agentRuns.values()].find((run) => agentWorkActive(run.summary));
    if (!shared.handle.session.isStreaming && shared.turnInFlight === 0 && !runningAgentRun) continue;
    const sessionId = shared.handle.session.sessionId;
    const key = `pi\n${sessionId}`;
    if (entries.has(key)) continue;
    const ownershipEpoch = await epochFor("pi", sessionId);
    if (ownershipEpoch === null) continue;
    entries.set(key, {
      engine: "pi", sessionId, ownerNodeId: localNodeId,
      ownershipEpoch,
      runId: runningAgentRun?.descriptor.runId ?? sessionId, updatedAt, expiresAt,
    });
  }
  for (const work of listConversationWork()) {
    if (!agentWorkActive(work.summary)) continue;
    const ownershipEpoch = await epochFor(work.engine, work.sessionId);
    if (ownershipEpoch === null) continue;
    entries.set(`${work.engine}\n${work.sessionId}`, {
      engine: work.engine, sessionId: work.sessionId, ownerNodeId: localNodeId,
      ownershipEpoch, runId: work.summary.runId, updatedAt, expiresAt,
    });
  }
  for (const connection of claudeClients.values()) {
    const claude = connection.claude;
    if (!claude.sessionId) continue;
    const runningKey = claudeRunKey(connection.project.id, `claude:${claude.filePath ?? ""}`);
    if (!claude.child && !(claude.filePath && runningClaudeSessionPaths.has(runningKey))) continue;
    const key = `claude\n${claude.sessionId}`;
    if (entries.has(key)) continue;
    const ownershipEpoch = await epochFor("claude", claude.sessionId);
    if (ownershipEpoch === null) continue;
    entries.set(key, {
      engine: "claude", sessionId: claude.sessionId, ownerNodeId: localNodeId,
      ownershipEpoch,
      runId: claude.sessionId, updatedAt, expiresAt,
    });
  }
  for (const recovered of recoveredClaudeChats.values()) {
    if (!recovered.claude.sessionId) continue;
    const key = `claude\n${recovered.claude.sessionId}`;
    if (entries.has(key)) continue;
    const ownershipEpoch = await epochFor("claude", recovered.claude.sessionId);
    if (ownershipEpoch === null) continue;
    entries.set(key, {
      engine: "claude", sessionId: recovered.claude.sessionId, ownerNodeId: localNodeId,
      ownershipEpoch,
      runId: recovered.claude.sessionId, updatedAt, expiresAt,
    });
  }
  for (const hook of listRunningClaudeSessions()) {
    const key = `claude\n${hook.sessionId}`;
    if (entries.has(key)) continue;
    const ownershipEpoch = await epochFor("claude", hook.sessionId);
    if (ownershipEpoch === null) continue;
    entries.set(key, {
      engine: "claude", sessionId: hook.sessionId, ownerNodeId: localNodeId,
      ownershipEpoch,
      runId: hook.sessionId, updatedAt, expiresAt,
    });
  }
  for (const terminal of listRunningPiSessions()) {
    const key = `pi\n${terminal.sessionId}`;
    if (entries.has(key)) continue;
    const ownershipEpoch = await epochFor("pi", terminal.sessionId);
    if (ownershipEpoch === null) continue;
    entries.set(key, {
      engine: "pi", sessionId: terminal.sessionId, ownerNodeId: localNodeId,
      ownershipEpoch, runId: terminal.runId, updatedAt, expiresAt,
    });
  }
  return [...entries.values()];
}

let runtimeLeasePushInProgress = false;

export async function pushRuntimeLeaseSnapshots(): Promise<void> {
  // Snapshots must be applied in generation order; a push still in flight when the
  // interval fires again is skipped rather than overlapped.
  if (runtimeLeasePushInProgress) return;
  runtimeLeasePushInProgress = true;
  try {
    const local = await getClusterNode();
    const leases = await buildRuntimeLeaseSnapshot(local.id);
    const peers = await listClusterPeers();
    if (!peers.length) return;
    const generatedAt = leases.length ? leases[0].updatedAt : new Date().toISOString();
    // One slow peer must not delay the others past the lease TTL.
    await Promise.all(peers.map(async (peer) => {
      try {
        const response = await fetch(`${peer.url}/api/cluster/sessions/runtime-snapshot`, {
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

let runningPiSessionIds = "";

/** Notify browsers of terminal lifecycle changes, including expired crash heartbeats. */
export function sweepRuntimeLeases(): void {
  const expired = sweepExpiredRuntimeLeases(conversationRuntimeDatabase());
  const current = [...new Set(listRunningPiSessions().map((session) => session.sessionId))].sort().join("\n");
  const terminalChanged = current !== runningPiSessionIds;
  runningPiSessionIds = current;
  if (expired.length || terminalChanged) broadcastSessionsChangedToAllProjects();
}

export async function flushReplicationOutbox(): Promise<void> {
  if (flags.replicationFlushInProgress) return;
  flags.replicationFlushInProgress = true;
  try {
    for (const peer of await listClusterPeers()) {
      const events = await eventsForPeer(peer.id);
      if (!events.length) continue;
      try {
        const response = await fetch(`${peer.url}/api/cluster/events`, {
          method: "POST",
          headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ events }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Peer returned ${response.status}`);
        const receipt = replicationReceiptSchema.parse(await response.json());
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
