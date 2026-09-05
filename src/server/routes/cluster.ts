import { createClusterInvitation, createClusterPeer, getClusterMachineToken, getClusterMembership, getClusterNode, getClusterPeer, listClusterPeers, markClusterPeerSeen, mergeClusterMembership, saveClusterPeer, updateClusterNode } from "../../cluster.js";
import { getConversationOwnership, takeConversationOwnership } from "../../conversation-ownership.js";
import { applyRuntimeLeaseSnapshot, conversationRuntimeDatabase, type RuntimeLeaseInput } from "../../conversation-runtime.js";
import { receiveReplicationBatch, type ReplicationBatch } from "../../replication.js";
import { receiveSecretCredentialEvents, type SecretCredentialEvent } from "../../secret-replication.js";
import { getSettings } from "../../settings.js";
import { getProject, listProjects, projectAliasIds, updateProjectSyncFolderId } from "../../store.js";
import { syncthingDeviceId, syncthingFolderIdForPath } from "../../syncthing.js";
import { abortPreparedTaskHandoff, acknowledgeIncomingTaskHandoff, commitPreparedTaskHandoff, getTaskHandoff, isTaskHandoffRejected, listTasks, prepareTaskHandoff, rejectTaskHandoff, reserveTaskHandoff, taskHandoffDeletion } from "../../tasks.js";
import type { HarnessId, TaskRecord } from "../../types.js";
import { type PreparedTaskWorktree, prepareTaskWorktreeFromBundle, removePreparedTaskWorktree } from "../../worktrees.js";
import { assertTaskFilesReady, projectWithLocalLocation, publicClusterPeer, syncPairedProjects, taskConversationIdentity, taskHandoffEligibility } from "../cluster-helpers.js";
import { canonicalClusterUrl, parseClusterInvitationLink, prospectiveClusterNode, sendError } from "../http-auth.js";
import { broadcastReplicationInvalidations, broadcastSessionsChangedToAllProjects, broadcastToProject } from "../realtime.js";
import { clusterInvitationRedemptionSchema, clusterJoinSchema, clusterMembershipMemberSchema, clusterMembershipSnapshotSchema, clusterNodeSchema, clusterPeerSchema, preparedTaskSchema, replicationBatchSchema, runtimeSnapshotSchema, secretCredentialBatchSchema, taskEligibilitySchema, taskHandoffActionSchema, taskHandoffStatusSchema } from "../schemas.js";
import { app } from "../state.js";

app.post("/api/cluster/invitations", async (_request, response, next) => {
  try {
    const node = await getClusterNode();
    if (!node.url) { sendError(response, 409, "Configure this node's public Tailscale URL before generating an invitation"); return; }
    if ((await listClusterPeers()).length >= 4) { sendError(response, 409, "A cluster supports at most five nodes"); return; }
    const invitation = await createClusterInvitation();
    const link = new URL("/join", `${node.url}/`);
    link.hash = `${invitation.id}.${invitation.secret}`;
    response.status(201).json({ link: link.href });
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/join", async (request, response, next) => {
  try {
    const payload = clusterJoinSchema.parse(request.body);
    let invitation: ReturnType<typeof parseClusterInvitationLink>;
    try {
      invitation = parseClusterInvitationLink(payload.link);
    } catch {
      sendError(response, 400, "Cluster invitation link is invalid");
      return;
    }
    const [currentNode, peers, machineToken] = await Promise.all([getClusterNode(), listClusterPeers(), getClusterMachineToken()]);
    if (peers.length && !peers.some((peer) => canonicalClusterUrl(peer.url) === invitation.inviterUrl)) {
      sendError(response, 409, "This node already belongs to a different cluster");
      return;
    }
    const member = { ...prospectiveClusterNode(currentNode, payload.name, payload.url), token: machineToken };
    const redeemResponse = await fetch(`${invitation.inviterUrl}/api/cluster/invitations/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationId: invitation.invitationId, secret: invitation.secret, member }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!redeemResponse.ok) {
      const body = await redeemResponse.json().catch(() => ({})) as { error?: string };
      sendError(response, redeemResponse.status, body.error ?? `Inviting node returned ${redeemResponse.status}`);
      return;
    }
    const redemption = clusterInvitationRedemptionSchema.parse(await redeemResponse.json());
    const localNode = await updateClusterNode(payload.name, payload.url);
    await mergeClusterMembership(redemption.membership, redemption.inviterNodeId);
    const inviter = await getClusterPeer(redemption.inviterNodeId);
    if (!inviter) throw new Error("Inviting node was not added to cluster membership");
    const confirmation = await fetch(`${inviter.url}/api/cluster/membership/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${inviter.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(await getClusterMembership()),
      signal: AbortSignal.timeout(5_000),
    });
    if (!confirmation.ok) throw new Error(`Cluster membership confirmation failed: inviting node returned ${confirmation.status}`);
    const localImport = await syncPairedProjects(inviter, localNode.id);
    response.status(201).json({ peers: (await listClusterPeers()).map(publicClusterPeer), pending: localImport.pending });
  } catch (error) {
    next(error);
  }
});

app.get("/api/cluster/invite", async (_request, response, next) => {
  try {
    response.json({ token: await getClusterMachineToken() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/cluster/node", async (_request, response, next) => {
  try {
    response.json({ node: await getClusterNode() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/cluster/node", async (request, response, next) => {
  try {
    const payload = clusterNodeSchema.parse(request.body);
    response.json({ node: await updateClusterNode(payload.name, payload.url) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/cluster/local-inventory", async (_request, response, next) => {
  try {
    const node = await getClusterNode();
    const projects = await listProjects();
    let syncDeviceId: string | undefined;
    let syncError: string | undefined;
    try {
      syncDeviceId = await syncthingDeviceId();
      for (const project of projects) {
        if (project.syncFolderId) continue;
        const folderId = await syncthingFolderIdForPath(project.path);
        if (folderId) Object.assign(project, await updateProjectSyncFolderId(project.id, folderId));
      }
    } catch (error) {
      syncError = error instanceof Error ? error.message : "Syncthing unavailable";
    }
    const inventory = await Promise.all(projects.map(async (project) => ({
      project: projectWithLocalLocation(project, node.id),
      aliases: await projectAliasIds(project.id),
      tasks: await listTasks(project.id),
    })));
    response.json({ node, syncDeviceId, syncError, projectRoot: getSettings().projects.homePath, projects: inventory, generatedAt: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/cluster/inventory", async (_request, response, next) => {
  try {
    const local = await getClusterNode();
    const peers = await listClusterPeers();
    const remote = await Promise.all(peers.map(async (peer) => {
      try {
        const peerResponse = await fetch(`${peer.url}/api/cluster/local-inventory`, {
          headers: { Authorization: `Bearer ${peer.token}` },
          signal: AbortSignal.timeout(3_000),
        });
        if (!peerResponse.ok) throw new Error(`Peer returned ${peerResponse.status}`);
        const inventory = await peerResponse.json();
        await markClusterPeerSeen(peer.id);
        return { peerId: peer.id, reachable: true, inventory };
      } catch (error) {
        return { peerId: peer.id, reachable: false, error: error instanceof Error ? error.message : "Peer unavailable" };
      }
    }));
    response.json({ local, remote, generatedAt: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/cluster/peers", async (_request, response, next) => {
  try {
    response.json({ peers: (await listClusterPeers()).map(publicClusterPeer) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/peers", async (request, response, next) => {
  try {
    const payload = clusterPeerSchema.parse(request.body);
    const peerUrl = payload.url.replace(/\/$/, "");
    const nodeResponse = await fetch(`${peerUrl}/api/cluster/node`, {
      headers: { Authorization: `Bearer ${payload.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!nodeResponse.ok) throw new Error(`Peer ${peerUrl} returned ${nodeResponse.status}`);
    const peerNode = clusterMembershipMemberSchema.omit({ token: true }).parse((await nodeResponse.json()).node);
    const localNode = await getClusterNode();
    if (!localNode.url) throw new Error("Configure this node's public Tailscale URL before pairing");
    await saveClusterPeer(createClusterPeer(peerNode, payload.token));
    const acceptResponse = await fetch(`${peerUrl}/api/cluster/peers/accept`, {
      method: "POST",
      headers: { Authorization: `Bearer ${payload.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(await getClusterMembership()),
      signal: AbortSignal.timeout(5_000),
    });
    if (!acceptResponse.ok) throw new Error(`Peer pairing failed: ${peerUrl} returned ${acceptResponse.status}`);
    const remoteSnapshot = clusterMembershipSnapshotSchema.parse(await acceptResponse.json());
    await mergeClusterMembership(remoteSnapshot, peerNode.id);
    const peer = await getClusterPeer(peerNode.id);
    if (!peer) throw new Error("Paired peer was not added to cluster membership");
    const confirmation = await fetch(`${peerUrl}/api/cluster/membership/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(await getClusterMembership()),
      signal: AbortSignal.timeout(5_000),
    });
    if (!confirmation.ok) throw new Error(`Peer membership confirmation failed: ${peerUrl} returned ${confirmation.status}`);
    const localImport = await syncPairedProjects(peer, localNode.id);
    response.status(201).json({ peer: publicClusterPeer(peer), pending: localImport.pending });
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/peers/accept", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const snapshot = clusterMembershipSnapshotSchema.parse(request.body);
    await mergeClusterMembership(snapshot, response.locals.machineNodeId as string | undefined);
    response.status(201).json(await getClusterMembership());
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/membership/sync", async (request, response, next) => {
  try {
    const snapshot = clusterMembershipSnapshotSchema.parse(request.body);
    await mergeClusterMembership(snapshot, response.locals.machineNodeId as string | undefined);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/events", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const batch = replicationBatchSchema.parse(request.body) as ReplicationBatch;
    const received = await receiveReplicationBatch(batch);
    broadcastReplicationInvalidations(batch.events.filter((event) => received.includes(event.id)));
    response.json({ received });
  } catch (error) {
    next(error);
  }
});

/** A peer's current conversation running set; see conversation-runtime.ts for the lease rules. */
app.post("/api/cluster/sessions/runtime-snapshot", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const snapshot = runtimeSnapshotSchema.parse(request.body);
    // The authenticated machine identity, not the payload, says whose leases these are.
    if (snapshot.nodeId !== response.locals.machineNodeId) {
      sendError(response, 403, "Runtime snapshot nodeId does not match the authenticated peer");
      return;
    }
    const ownerships = new Map(await Promise.all([...new Set(snapshot.leases.map((lease) => `${lease.engine}\n${lease.sessionId}`))]
      .map(async (key) => [key, await getConversationOwnership(key.slice(0, key.indexOf("\n")) as HarnessId, key.slice(key.indexOf("\n") + 1))] as const)));
    // Authoritative ownership beats stale heartbeats: keep a lease only when the
    // ownership table is absent, older than the lease's epoch, or agrees with it.
    const leases: RuntimeLeaseInput[] = snapshot.leases.flatMap((lease) => {
      const ownership = ownerships.get(`${lease.engine}\n${lease.sessionId}`);
      const allowed = !ownership
        || ownership.epoch < lease.ownershipEpoch
        || (ownership.epoch === lease.ownershipEpoch && ownership.ownerNodeId === snapshot.nodeId);
      return allowed ? [{ ...lease, ownerNodeId: snapshot.nodeId }] : [];
    });
    const changed = applyRuntimeLeaseSnapshot(conversationRuntimeDatabase(), snapshot.nodeId, snapshot.generatedAt, leases);
    if (changed.length) broadcastSessionsChangedToAllProjects();
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Kept for one release as a clean refusal: a peer on an older build gets 410 rather than a
// half-applied write into tables this build no longer has.
app.post("/api/cluster/github/events", (request, response) => {
  if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
  sendError(response, 410, "GitHub credential groups were replaced by secret accounts; upgrade this peer");
});

app.post("/api/cluster/secrets/events", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = secretCredentialBatchSchema.parse(request.body);
    response.json({ received: await receiveSecretCredentialEvents(payload.events as SecretCredentialEvent[]) });
  } catch (error) { next(error); }
});

app.post("/api/cluster/tasks/eligibility", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = taskEligibilitySchema.parse(request.body);
    const eligibility = await taskHandoffEligibility(payload.projectId, payload.task as TaskRecord, !payload.source);
    response.json({ eligible: eligibility.reasons.length === 0, ...eligibility });
  } catch (error) { next(error); }
});

app.post("/api/cluster/tasks/status", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = taskHandoffStatusSchema.parse(request.body);
    const record = await getTaskHandoff(payload.handoffId);
    if (!record) { sendError(response, 404, "Handoff not found"); return; }
    response.json({ status: record.status, taskId: record.taskId, projectId: record.protocolProjectId, sourceNodeId: record.sourceNodeId, destinationNodeId: record.destinationNodeId });
  } catch (error) { next(error); }
});

app.post("/api/cluster/tasks/prepare", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = preparedTaskSchema.parse(request.body);
    if (await isTaskHandoffRejected(payload.handoffId)) { sendError(response, 409, `Handoff ${payload.handoffId} is rejected`); return; }
    const task = payload.task as TaskRecord;
    const source = await getClusterPeer(task.currentNodeId);
    if (!source) { sendError(response, 403, "Task owner is not a known peer"); return; }
    const eligibility = await taskHandoffEligibility(payload.projectId, task);
    if (eligibility.reasons.length) { sendError(response, 409, eligibility.reasons.join("; ")); return; }
    if (task.worktreeBranch && !payload.bundle) { sendError(response, 400, "Task worktree handoff requires a branch bundle"); return; }
    if (!task.worktreeBranch && payload.bundle) { sendError(response, 400, "Task has no worktree branch for this bundle"); return; }
    const project = await getProject(payload.projectId);
    if (!project) throw new Error("Eligible project disappeared");
    const local = await getClusterNode();
    await assertTaskFilesReady(project, task);
    const reservation = await reserveTaskHandoff(payload.handoffId, project.id, payload.projectId, task, local.id, payload.handoffContext, payload.handoffVersion);
    if (reservation.status === "prepared" || reservation.status === "committed") {
      response.status(201).json({ task: (await listTasks(project.id)).find((candidate) => candidate.id === task.id) });
      return;
    }
    let worktree: PreparedTaskWorktree | null = null;
    try {
      worktree = task.worktreeBranch && payload.bundle ? await prepareTaskWorktreeFromBundle(project.path, task.id, task.worktreeBranch, payload.bundle) : null;
      const prepared = await prepareTaskHandoff(payload.handoffId, project.id, payload.projectId, task, local.id, worktree, payload.handoffContext, payload.handoffVersion);
      broadcastToProject(project.id, { type: "tasksChanged" });
      response.status(201).json({ task: prepared });
    } catch (error) {
      try { await abortPreparedTaskHandoff(payload.handoffId, local.id); }
      catch (abortError) { console.warn(`Prepared handoff abort failed for ${payload.handoffId}`, abortError); }
      if (worktree?.created) {
        try { await removePreparedTaskWorktree(project.path, worktree.path, worktree.branch); }
        catch (cleanupError) { console.warn(`Prepared worktree cleanup failed for ${payload.handoffId}`, cleanupError); }
      }
      throw error;
    }
  } catch (error) { next(error); }
});

app.post("/api/cluster/tasks/commit", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = taskHandoffActionSchema.parse(request.body);
    const record = await getTaskHandoff(payload.handoffId);
    if (!record) { sendError(response, 404, "Prepared handoff not found"); return; }
    const project = await getProject(record.projectId);
    if (!project) throw new Error("Prepared handoff project is not mapped on this node");
    await assertTaskFilesReady(project, record.task);
    const local = await getClusterNode();
    const task = await commitPreparedTaskHandoff(payload.handoffId, local.id);
    const identity = task ? taskConversationIdentity(task) : null;
    if (identity) await takeConversationOwnership(identity.engine, identity.sessionId, local.id);
    broadcastToProject(record.projectId, { type: "tasksChanged" });
    response.json(task ? { task } : { task: null, deleted: await taskHandoffDeletion(payload.handoffId) });
  } catch (error) { next(error); }
});

app.post("/api/cluster/tasks/settle", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = taskHandoffActionSchema.parse(request.body);
    const local = await getClusterNode();
    await acknowledgeIncomingTaskHandoff(payload.handoffId, local.id);
    response.json({ ok: true });
  } catch (error) { next(error); }
});

app.post("/api/cluster/tasks/abort", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = taskHandoffActionSchema.parse(request.body);
    const record = await getTaskHandoff(payload.handoffId);
    if (!record) {
      await rejectTaskHandoff(payload.handoffId);
      response.json({ task: null });
      return;
    }
    const local = await getClusterNode();
    const restored = await abortPreparedTaskHandoff(payload.handoffId, local.id);
    if (record.worktreeCreated && record.worktreePath && record.worktreeBranch) {
      const project = await getProject(record.projectId);
      if (!project) throw new Error("Prepared task project is not mapped on this node");
      try { await removePreparedTaskWorktree(project.path, record.worktreePath, record.worktreeBranch); } catch (error) { console.warn(`Prepared worktree cleanup failed for ${payload.handoffId}`, error); }
    }
    if (record) broadcastToProject(record.projectId, { type: "tasksChanged" });
    response.json({ task: restored ?? null });
  } catch (error) { next(error); }
});
