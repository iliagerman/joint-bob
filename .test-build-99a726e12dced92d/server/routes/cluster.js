import { getClusterNode, updateClusterNode } from "../../cluster.js";
import { getConversationOwnership, takeConversationOwnership } from "../../conversation-ownership.js";
import { applyRuntimeLeaseSnapshot, conversationRuntimeDatabase, holdEndedRun, liveRuntimeLeases, releaseEndedRun } from "../../conversation-runtime.js";
import { receiveReplicationBatch } from "../../replication.js";
import { removeTranscriptsDeletedBy } from "../deleted-transcripts.js";
import { catchUpSharedTranscript } from "../shared-transcripts.js";
import { receivePushSubscriptionEvents } from "../../push.js";
import { getProject } from "../../store.js";
import { abortPreparedTaskHandoff, acknowledgeIncomingTaskHandoff, commitPreparedTaskHandoff, getTaskHandoff, isTaskHandoffRejected, listTasks, prepareTaskHandoff, rejectTaskHandoff, reserveTaskHandoff, taskHandoffDeletion } from "../../tasks.js";
import { getRuntimePeer } from "../runtime-peers.js";
import { prepareTaskWorktreeFromBundle, removePreparedTaskWorktree } from "../../worktrees.js";
import { assertTaskFilesReady, taskConversationIdentity, taskHandoffEligibility } from "../cluster-helpers.js";
import { sendError } from "../http-auth.js";
import { broadcastReplicationInvalidations, broadcastSessionsChangedToAllProjects, broadcastToProject } from "../realtime.js";
import { clusterNodeSchema, preparedTaskSchema, pushSubscriptionBatchSchema, replicationBatchSchema, runtimeSnapshotSchema, taskEligibilitySchema, taskHandoffActionSchema, taskHandoffStatusSchema } from "../schemas.js";
import { app } from "../state.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { mayReplicateEvent, replicationPeers, signedPeerPost } from "../replication-v2.js";
import { listTwinUpdateTargets } from "../../twin-updates.js";
import { publishNodeDescriptor } from "../cluster-v2.js";
import { receiveRelay, relayPage, relayPullSchema, relayRequestSchema } from "../cluster-hubs.js";
import { ClusterV2HttpError } from "../../cluster-v2-errors.js";
import { isTrustedTwin } from "../../cluster-sharing-policy.js";
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
    const node = await updateClusterNode(payload.name, payload.url);
    await publishNodeDescriptor();
    response.json({ node });
  } catch (error) {
    next(error);
  }
});
app.get("/api/cluster/inventory", async (_request, response, next) => {
  try {
    const local = await getClusterNode();
    const remote = await Promise.all(listTwinUpdateTargets(await clusterV2Database(), local.id).map(async (twin) => {
      const identity = { peerId: twin.nodeId, name: twin.name, url: twin.url };
      try {
        return { ...identity, reachable: true, inventory: await signedPeerPost(twin, "/api/cluster/v2/update/inventory", {}) };
      } catch (error) {
        return { ...identity, reachable: false, error: error instanceof Error ? error.message : "Peer unavailable" };
      }
    }));
    response.json({ local, remote, generatedAt: (/* @__PURE__ */ new Date()).toISOString() });
  } catch (error) {
    next(error);
  }
});
app.post("/api/cluster/v2/events", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const batch = replicationBatchSchema.parse(request.body);
    const db = await clusterV2Database(), local = await getClusterNode(), sender = response.locals.machineNodeId;
    if (!replicationPeers(db, local.id).some((peer) => peer.nodeId === sender) || batch.events.some((event) => event.originNodeId !== sender || !mayReplicateEvent(db, local.id, sender, event))) {
      sendError(response, 403, "Replication event is outside the authenticated peer's sharing scope");
      return;
    }
    const received = await receiveReplicationBatch(batch);
    const applied = batch.events.filter((event) => received.includes(event.id));
    await removeTranscriptsDeletedBy(applied);
    broadcastReplicationInvalidations(applied);
    response.json({ received });
  } catch (error) {
    next(error);
  }
});
async function catchUpEndedRuns(nodeId, ended) {
  for (const lease of ended) holdEndedRun(lease.engine, lease.sessionId, Boolean(lease.backgroundRunning));
  await Promise.all(ended.map(async (lease) => {
    try {
      await catchUpSharedTranscript(nodeId, lease.engine, lease.sessionId);
    } catch (error) {
      console.warn(`Transcript catch-up for ${lease.engine} conversation ${lease.sessionId} failed: ${error instanceof Error ? error.message : "transfer failed"}`);
    } finally {
      releaseEndedRun(lease.engine, lease.sessionId);
    }
  }));
  broadcastSessionsChangedToAllProjects();
}
app.post(["/api/cluster/sessions/runtime-snapshot", "/api/cluster/v2/runtime/sessions/runtime-snapshot"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const snapshot = runtimeSnapshotSchema.parse(request.body);
    if (snapshot.nodeId !== response.locals.machineNodeId) {
      sendError(response, 403, "Runtime snapshot nodeId does not match the authenticated peer");
      return;
    }
    const ownerships = new Map(await Promise.all([...new Set(snapshot.leases.map((lease) => `${lease.engine}
${lease.sessionId}`))].map(async (key) => [key, await getConversationOwnership(key.slice(0, key.indexOf("\n")), key.slice(key.indexOf("\n") + 1))])));
    const leases = snapshot.leases.flatMap((lease) => {
      const ownership = ownerships.get(`${lease.engine}
${lease.sessionId}`);
      const allowed = !ownership || ownership.epoch < lease.ownershipEpoch || ownership.epoch === lease.ownershipEpoch && ownership.ownerNodeId === snapshot.nodeId;
      return allowed ? [{ ...lease, ownerNodeId: snapshot.nodeId }] : [];
    });
    const db = conversationRuntimeDatabase();
    const before = liveRuntimeLeases(db, snapshot.nodeId);
    const changed = new Set(applyRuntimeLeaseSnapshot(db, snapshot.nodeId, snapshot.generatedAt, leases));
    const continuing = new Set(leases.map((lease) => `${lease.engine}
${lease.sessionId}`));
    const ended = before.filter((lease) => changed.has(`${lease.engine}
${lease.sessionId}`) && !continuing.has(`${lease.engine}
${lease.sessionId}`));
    if (ended.length) catchUpEndedRuns(snapshot.nodeId, ended).catch((error) => console.warn("Ended run catch-up failed", error));
    if (changed.size) broadcastSessionsChangedToAllProjects();
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
app.post("/api/cluster/v2/relay", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    response.json({ received: await receiveRelay(response.locals.machineNodeId, relayRequestSchema.parse(request.body)) });
  } catch (error) {
    if (error instanceof ClusterV2HttpError) {
      sendError(response, error.statusCode, error.message);
      return;
    }
    next(error);
  }
});
app.post("/api/cluster/v2/relay/pull", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    response.json(await relayPage(response.locals.machineNodeId, relayPullSchema.parse(request.body)));
  } catch (error) {
    if (error instanceof ClusterV2HttpError) {
      sendError(response, error.statusCode, error.message);
      return;
    }
    next(error);
  }
});
app.post("/api/cluster/v2/push/events", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const db = await clusterV2Database(), local = await getClusterNode();
    if (!isTrustedTwin(db, local.id, response.locals.machineNodeId)) {
      sendError(response, 403, "Push subscriptions replicate only between twins");
      return;
    }
    const payload = pushSubscriptionBatchSchema.parse(request.body);
    response.json({ received: await receivePushSubscriptionEvents(payload.events) });
  } catch (error) {
    next(error);
  }
});
app.post(["/api/cluster/tasks/eligibility", "/api/cluster/v2/runtime/tasks/eligibility"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const payload = taskEligibilitySchema.parse(request.body);
    const eligibility = await taskHandoffEligibility(payload.projectId, payload.task, !payload.source);
    response.json({ eligible: eligibility.reasons.length === 0, ...eligibility });
  } catch (error) {
    next(error);
  }
});
app.post(["/api/cluster/tasks/status", "/api/cluster/v2/runtime/tasks/status"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const payload = taskHandoffStatusSchema.parse(request.body);
    const record = await getTaskHandoff(payload.handoffId);
    if (!record) {
      sendError(response, 404, "Handoff not found");
      return;
    }
    response.json({ status: record.status, taskId: record.taskId, projectId: record.protocolProjectId, sourceNodeId: record.sourceNodeId, destinationNodeId: record.destinationNodeId });
  } catch (error) {
    next(error);
  }
});
app.post(["/api/cluster/tasks/prepare", "/api/cluster/v2/runtime/tasks/prepare"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const payload = preparedTaskSchema.parse(request.body);
    if (await isTaskHandoffRejected(payload.handoffId)) {
      sendError(response, 409, `Handoff ${payload.handoffId} is rejected`);
      return;
    }
    const task = payload.task;
    if (response.locals.machineProtocol === 2 && task.currentNodeId !== response.locals.machineNodeId) {
      sendError(response, 403, "Task owner does not match authenticated peer");
      return;
    }
    const source = await getRuntimePeer(task.currentNodeId);
    if (!source) {
      sendError(response, 403, "Task owner is not a known peer");
      return;
    }
    const eligibility = await taskHandoffEligibility(payload.projectId, task);
    if (eligibility.reasons.length) {
      sendError(response, 409, eligibility.reasons.join("; "));
      return;
    }
    if (task.worktreeBranch && !payload.bundle) {
      sendError(response, 400, "Task worktree handoff requires a branch bundle");
      return;
    }
    if (!task.worktreeBranch && payload.bundle) {
      sendError(response, 400, "Task has no worktree branch for this bundle");
      return;
    }
    const project = await getProject(payload.projectId);
    if (!project) throw new Error("Eligible project disappeared");
    const local = await getClusterNode();
    await assertTaskFilesReady(project, task);
    const reservation = await reserveTaskHandoff(payload.handoffId, project.id, payload.projectId, task, local.id, payload.handoffContext, payload.handoffVersion);
    if (reservation.status === "prepared" || reservation.status === "committed") {
      response.status(201).json({ task: (await listTasks(project.id)).find((candidate) => candidate.id === task.id) });
      return;
    }
    let worktree = null;
    try {
      worktree = task.worktreeBranch && payload.bundle ? await prepareTaskWorktreeFromBundle(project.path, task.id, task.worktreeBranch, payload.bundle) : null;
      const prepared = await prepareTaskHandoff(payload.handoffId, project.id, payload.projectId, task, local.id, worktree, payload.handoffContext, payload.handoffVersion);
      broadcastToProject(project.id, { type: "tasksChanged" });
      response.status(201).json({ task: prepared });
    } catch (error) {
      try {
        await abortPreparedTaskHandoff(payload.handoffId, local.id);
      } catch (abortError) {
        console.warn(`Prepared handoff abort failed for ${payload.handoffId}`, abortError);
      }
      if (worktree?.created) {
        try {
          await removePreparedTaskWorktree(project.path, worktree.path, worktree.branch);
        } catch (cleanupError) {
          console.warn(`Prepared worktree cleanup failed for ${payload.handoffId}`, cleanupError);
        }
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});
app.post(["/api/cluster/tasks/commit", "/api/cluster/v2/runtime/tasks/commit"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const payload = taskHandoffActionSchema.parse(request.body);
    const record = await getTaskHandoff(payload.handoffId);
    if (!record) {
      sendError(response, 404, "Prepared handoff not found");
      return;
    }
    const project = await getProject(record.projectId);
    if (!project) throw new Error("Prepared handoff project is not mapped on this node");
    await assertTaskFilesReady(project, record.task);
    const local = await getClusterNode();
    const task = await commitPreparedTaskHandoff(payload.handoffId, local.id);
    const identity = task ? taskConversationIdentity(task) : null;
    if (identity) await takeConversationOwnership(identity.engine, identity.sessionId, local.id);
    broadcastToProject(record.projectId, { type: "tasksChanged" });
    response.json(task ? { task } : { task: null, deleted: await taskHandoffDeletion(payload.handoffId) });
  } catch (error) {
    next(error);
  }
});
app.post(["/api/cluster/tasks/settle", "/api/cluster/v2/runtime/tasks/settle"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const payload = taskHandoffActionSchema.parse(request.body);
    const local = await getClusterNode();
    await acknowledgeIncomingTaskHandoff(payload.handoffId, local.id);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
app.post(["/api/cluster/tasks/abort", "/api/cluster/v2/runtime/tasks/abort"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
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
      try {
        await removePreparedTaskWorktree(project.path, record.worktreePath, record.worktreeBranch);
      } catch (error) {
        console.warn(`Prepared worktree cleanup failed for ${payload.handoffId}`, error);
      }
    }
    if (record) broadcastToProject(record.projectId, { type: "tasksChanged" });
    response.json({ task: restored ?? null });
  } catch (error) {
    next(error);
  }
});
