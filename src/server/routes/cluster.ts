import { assertClusterDepartureAllowed, clusterProjectGrantFor, createClusterInvitation, createClusterPeer, getClusterMachineToken, getClusterMembership, getClusterNode, getClusterPeer, leaveCluster, listClusterPeers, markClusterPeerSeen, mergeClusterMembership, removeClusterPeer, saveClusterPeer, setClusterInviter, updateClusterNode } from "../../cluster.js";
import { getConversationOwnership, takeConversationOwnership } from "../../conversation-ownership.js";
import { applyRuntimeLeaseSnapshot, conversationRuntimeDatabase, type RuntimeLeaseInput } from "../../conversation-runtime.js";
import { receiveReplicationBatch, type ReplicationBatch } from "../../replication.js";
import { receiveSecretCredentialEvents, type SecretCredentialEvent } from "../../secret-replication.js";
import { getSettings } from "../../settings.js";
import { canonicalProjectId, getProject, listProjects, projectAliasIds, updateProjectSyncFolderId } from "../../store.js";
import { syncthingDeviceId, syncthingFolderIdForPath } from "../../syncthing.js";
import { abortPreparedTaskHandoff, acknowledgeIncomingTaskHandoff, commitPreparedTaskHandoff, getTaskHandoff, isTaskHandoffRejected, listTasks, prepareTaskHandoff, rejectTaskHandoff, reserveTaskHandoff, taskHandoffDeletion } from "../../tasks.js";
import { z } from "zod";
import type { HarnessId, TaskRecord } from "../../types.js";
import { type PreparedTaskWorktree, prepareTaskWorktreeFromBundle, removePreparedTaskWorktree } from "../../worktrees.js";
import { assertTaskFilesReady, projectWithLocalLocation, publicClusterPeer, syncPairedProjects, taskConversationIdentity, taskHandoffEligibility } from "../cluster-helpers.js";
import { canonicalClusterUrl, parseClusterInvitationLink, prospectiveClusterNode, sendError } from "../http-auth.js";
import { broadcastReplicationInvalidations, broadcastSessionsChangedToAllProjects, broadcastToProject } from "../realtime.js";
import { clusterInvitationCreateSchema, clusterInvitationRedemptionSchema, clusterJoinSchema, clusterMembershipLeaveSchema, clusterMembershipMemberSchema, clusterMembershipSnapshotSchema, clusterNodeSchema, clusterPeerSchema, preparedTaskSchema, replicationBatchSchema, runtimeSnapshotSchema, secretCredentialBatchSchema, taskEligibilitySchema, taskHandoffActionSchema, taskHandoffStatusSchema } from "../schemas.js";
import { app } from "../state.js";

app.post("/api/cluster/invitations", async (request, response, next) => {
  try {
    const payload = clusterInvitationCreateSchema.parse(request.body);
    const node = await getClusterNode();
    if (!node.url) { sendError(response, 409, "Configure this node's public Tailscale URL before generating an invitation"); return; }
    if ((await listClusterPeers()).length >= 4) { sendError(response, 409, "A cluster supports at most five nodes"); return; }
    // Selection is canonicalised here and frozen server-side: the link carries no project
    // ids, so the joining node can never widen its own access.
    const canonical: string[] = [];
    for (const projectId of payload.projectIds) {
      const resolved = await canonicalProjectId(projectId);
      if (!resolved) { sendError(response, 400, `Unknown project: ${projectId}`); return; }
      if (!canonical.includes(resolved)) canonical.push(resolved);
    }
    if (!canonical.length) { sendError(response, 400, "Share at least one project"); return; }
    const invitation = await createClusterInvitation(canonical);
    const link = new URL("/join", `${node.url}/`);
    link.hash = `${invitation.id}.${invitation.secret}`;
    response.status(201).json({ link: link.href, projectIds: canonical });
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
    // Preflight validates the invitation without consuming it, so a node already in a
    // cluster only leaves after it knows the new invitation is usable. A failed preflight
    // leaves the current cluster untouched.
    const preflightResponse = await fetch(`${invitation.inviterUrl}/api/cluster/invitations/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationId: invitation.invitationId, secret: invitation.secret, nodeId: currentNode.id }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!preflightResponse.ok) {
      const body = await preflightResponse.json().catch(() => ({})) as { error?: string };
      sendError(response, preflightResponse.status, body.error ?? `Inviting node returned ${preflightResponse.status}`);
      return;
    }
    const preflight = z.object({ status: z.enum(["accepted", "active", "expired", "invalid", "used", "retry"]), inviterNodeId: z.string().uuid(), inviterName: z.string(), projectIds: z.array(z.string()) }).parse(await preflightResponse.json());
    if (preflight.status === "invalid") { sendError(response, 401, "Invalid cluster invitation"); return; }
    if (preflight.status === "expired") { sendError(response, 410, "Cluster invitation has expired"); return; }
    if (preflight.status === "used") { sendError(response, 410, "Cluster invitation has already been used"); return; }
    const alreadyMemberHere = peers.some((peer) => canonicalClusterUrl(peer.url) === invitation.inviterUrl);
    // Accepting a new invitation always means leaving the current cluster first: a retry
    // against the cluster this node already belongs to keeps its existing membership.
    if (peers.length && !(alreadyMemberHere && preflight.status === "retry")) {
      // Validate the departure before telling anyone: a leave that would fail locally after
      // the peers already dropped this node strands it between two clusters.
      try {
        await assertClusterDepartureAllowed();
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Transfer owned tasks and settle handoffs")) {
          sendError(response, 409, error.message);
          return;
        }
        throw error;
      }
      const leftAt = new Date().toISOString();
      for (const peer of peers) {
        // Best-effort notice so peers drop this node immediately; membership tombstones
        // converge the rest even when a peer is unreachable. `leftAt` lets a peer that
        // receives this late, after a re-pairing, ignore it instead of rolling the
        // membership back.
        await fetch(`${peer.url}/api/cluster/membership/leave`, {
          method: "POST",
          headers: { Authorization: `Bearer ${machineToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ nodeId: currentNode.id, leftAt }),
          signal: AbortSignal.timeout(3_000),
        }).catch(() => undefined);
      }
      await leaveCluster();
    }
    const prospective = prospectiveClusterNode(currentNode, payload.name, payload.url);
    // A fresh version timestamp clears this node's removal tombstones on the inviter, and
    // leaving rotated the credential, so the token is read after the leave.
    const member = { ...prospective, updatedAt: new Date().toISOString(), token: await getClusterMachineToken() };
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
    await setClusterInviter(redemption.inviterNodeId);
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

app.get("/api/cluster/local-inventory", async (request, response, next) => {
  try {
    const node = await getClusterNode();
    let projects = await listProjects();
    // A granted machine peer only discovers the projects its invitation selected; session
    // users and legacy peers (no grant row) still see everything this node holds.
    if (response.locals.machineAuth && response.locals.machineNodeId !== node.id) {
      const grant = await clusterProjectGrantFor(response.locals.machineNodeId as string);
      if (grant) {
        const allowed = new Set(grant);
        const visible: typeof projects = [];
        for (const project of projects) {
          const aliases = await projectAliasIds(project.id);
          if (allowed.has(project.id) || aliases.some((alias) => allowed.has(alias))) visible.push(project);
        }
        projects = visible;
      }
    }
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
      // A peer that cannot answer still has to be identifiable: the settings list draws
      // one row per node, and a row can only name a node it was told the name of.
      const identity = { peerId: peer.id, name: peer.name, url: peer.url, lastSeenAt: peer.lastSeenAt };
      try {
        const peerResponse = await fetch(`${peer.url}/api/cluster/local-inventory`, {
          headers: { Authorization: `Bearer ${await getClusterMachineToken()}` },
          signal: AbortSignal.timeout(3_000),
        });
        if (!peerResponse.ok) throw new Error(`Peer returned ${peerResponse.status}`);
        const inventory = await peerResponse.json();
        await markClusterPeerSeen(peer.id);
        return { ...identity, lastSeenAt: new Date().toISOString(), reachable: true, inventory };
      } catch (error) {
        return { ...identity, reachable: false, error: error instanceof Error ? error.message : "Peer unavailable" };
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

app.post("/api/cluster/membership/leave", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = clusterMembershipLeaveSchema.parse(request.body);
    const callerNodeId = response.locals.machineNodeId as string;
    const localNode = await getClusterNode();
    if (payload.nodeId === callerNodeId && payload.nodeId !== localNode.id) {
      // Voluntary leave: the authenticated caller announces its own departure. A notice
      // that lost a race against the caller's re-pairing (peer row newer than the notice)
      // must not tear down the fresh membership.
      const departing = await getClusterPeer(callerNodeId);
      if (departing && departing.updatedAt > payload.leftAt) {
        response.status(204).send();
        return;
      }
      await removeClusterPeer(callerNodeId);
      response.status(204).send();
      return;
    }
    if (payload.nodeId === localNode.id && localNode.invitedByNodeId === callerNodeId) {
      // Forced drop: only the node that created this node's invitation may end it.
      await leaveCluster();
      response.status(204).send();
      return;
    }
    sendError(response, 403, "Only the node that created this member's invitation can remove it");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Transfer owned tasks and settle handoffs")) {
      sendError(response, 409, error.message);
      return;
    }
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
