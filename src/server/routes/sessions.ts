import { revokeAgentCapabilities } from "../../agent-capabilities.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { mayReplicateEvent } from "../replication-v2.js";
import { conversationOfAnotherProject } from "./projects.js";
import { projectAdditionalPaths } from "../session-scope.js";
import { randomUUID } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { createByTheWayLease, deleteByTheWayLease, getByTheWayLease, getByTheWayLeaseByToken, listByTheWayLeases } from "../../by-the-way-leases.js";
import { type ClusterPeer, getClusterNode } from "../../cluster.js";
import { acceptOwnerTranscript, assertSharedTranscriptReady } from '../shared-transcripts.js';
import { getRuntimePeer, listRuntimePeers, runtimeFetch } from "../runtime-peers.js";
import { beginConversationRecovery, compareAndSetConversationOwnership, type ConversationEngine, type ConversationOwnership, finishConversationRecovery, getConversationOwnership, type OwnershipApplyResult, sameConversationOwnership } from "../../conversation-ownership.js";
import { deleteConversationRecord, getConversationRecord } from "../../conversation-records.js";
import { dropBrowserConversationGrants } from "../../browser-store.js";
import { markConversationReviewed, markConversationsReviewed } from "../../conversation-reviews.js";
import { notificationConversationId, setConversationNotification } from "../../conversation-notifications.js";
import { clearHarnessSessionCache, getHarness, listHarnessSessions } from "../../harnesses.js";
import { getNtfyService } from "../../ntfy.js";
import { deleteNtfySubscriptions, ntfySubscription, savePushSubscription } from "../../push.js";
import { queuedPromptSnapshot } from "../../prompt-queue.js";
import { receiveReplicationBatch, type ReplicationEvent } from "../../replication.js";
import { resolveLocalSessionPath } from "../../session-paths.js";
import { getProject, touchProject } from "../../store.js";
import { listTasks } from "../../tasks.js";
import type { ProjectRecord, SessionSummary } from "../../types.js";
import { TaskWorktreeError } from "../../worktrees.js";
import { promptQueueIsDraining } from "../chat.js";
import { conversationBelongsToDoneTask, peerMayRunHere } from "../cluster-helpers.js";
import { sendError } from "../http-auth.js";
import { flushReplicationOutbox } from "../maintenance.js";
import { flushPushSubscriptionOutbox } from "../push-flush.js";
import { ConversationForkError, forkLocalConversation } from "../conversation-fork.js";
import { assertProjectEditable, projectsWithSharedNames } from "../projects.js";
import { broadcastToAllClients, broadcastToProject, scheduleReviewNotifications, send } from "../realtime.js";
import { disposeHarnessSession, findHarnessSession, harnessSessionBusy } from "../harness-sessions.js";
import { ownershipSchema, registeredHarnessIdSchema, routedSessionTakeOwnershipSchema, sessionDeleteSchema, sessionNtfySchema, sessionRecoverySchema, sessionReviewedSchema, sessionReviewNotificationsSchema, sessionsReviewedSchema, sessionTakeOwnershipSchema } from "../schemas.js";
import { stopConversationBackgroundTasks } from "../background-tasks.js";
import { listProjectSessionsWithReviewState, listReviewScopeSessions, requireLocalConversationOwner, noteUnannouncedRunChanges, sharedProjectSessions } from "../sessions-helpers.js";
import { app } from "../state.js";

app.get("/api/projects/:projectId/sessions", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    await touchProject(project.id);
    const authSession = response.locals.authSession as AuthSession;
    const token = typeof request.query.byTheWayToken === "string" ? request.query.byTheWayToken : undefined;
    const temporary = token ? await getByTheWayLeaseByToken(project.id, token) : undefined;
    // Every open page asks for this after each change and every two seconds while something
    // runs, alongside the running list and the review inbox. Requests that overlap share one
    // listing, so a slow machine no longer builds the same list several times at once.
    response.json({ sessions: temporary
      ? await listProjectSessionsWithReviewState(project, authSession.userId, authSession.accountId, undefined, temporary.sessionId)
      : await sharedProjectSessions(project, authSession.userId, authSession.accountId, true) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/projects/:projectId/sessions/review-notifications", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const payload = sessionReviewNotificationsSchema.parse(request.body);
    const authSession = response.locals.authSession as AuthSession;
    const sessions = await listProjectSessionsWithReviewState(project, authSession.userId, authSession.accountId);
    const session = sessions.find((candidate) => (candidate.path === payload.sessionPath || candidate.segments?.some((segment) => segment.path === payload.sessionPath)) && !candidate.readOnly);
    if (!session) {
      sendError(response, 404, "Conversation not found");
      return;
    }
    const local = await getClusterNode();
    setConversationNotification(authSession.accountId, project.id, notificationConversationId(session), payload.enabled, local.id);
    flushReplicationOutbox().catch((error) => console.warn("Notification preference flush failed", error));
    broadcastToProject(project.id, { type: "sessionsChanged" });
    if (payload.enabled) scheduleReviewNotifications(project.id);
    response.json({ enabled: payload.enabled });
  } catch (error) {
    next(error);
  }
});

app.put("/api/projects/:projectId/sessions/ntfy", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const payload = sessionNtfySchema.parse(request.body);
    const authSession = response.locals.authSession as AuthSession;
    const sessions = await listProjectSessionsWithReviewState(project, authSession.userId, authSession.accountId);
    const session = sessions.find((candidate) => candidate.path === payload.sessionPath && !candidate.readOnly);
    if (!session) { sendError(response, 404, "Conversation not found"); return; }
    if (payload.enabled) {
      if (!payload.serviceId || !payload.topic) { sendError(response, 400, "Enabling ntfy publishing needs a service and a topic"); return; }
      const service = getNtfyService(payload.serviceId);
      if (!service) { sendError(response, 404, "ntfy service not found"); return; }
      const conversationId = notificationConversationId(session);
      await deleteNtfySubscriptions(authSession.userId, project.id, conversationId);
      await savePushSubscription(ntfySubscription(service.url, payload.topic, service.token, project.id, conversationId), authSession.userId, project.id, conversationId, session.title || project.name, authSession.accountId);
      // Publishing reviews is a review notification, so opting in implies the review preference.
      const local = await getClusterNode();
      setConversationNotification(authSession.accountId, project.id, conversationId, true, local.id);
      flushReplicationOutbox().catch((error) => console.warn("Notification preference flush failed", error));
      scheduleReviewNotifications(project.id);
    } else {
      await deleteNtfySubscriptions(authSession.userId, project.id, notificationConversationId(session));
    }
    flushPushSubscriptionOutbox().catch((error) => console.warn("Push subscription flush failed", error));
    broadcastToProject(project.id, { type: "sessionsChanged" });
    response.json({ enabled: payload.enabled });
  } catch (error) {
    next(error);
  }
});

const sessionForkSchema = z.object({ engine: registeredHarnessIdSchema, sessionId: z.string().min(1).max(240) }).strict();

app.post("/api/projects/:projectId/sessions/fork", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const payload = sessionForkSchema.parse(request.body);
    const local = await getClusterNode();
    const ownership = await getConversationOwnership(payload.engine, payload.sessionId);
    if (ownership && ownership.ownerNodeId !== local.id) {
      const peer = await getRuntimePeer(ownership.ownerNodeId);
      if (!peer) throw new ConversationForkError(409, "Conversation owner is unavailable");
      let routed: globalThis.Response;
      try {
        routed = await runtimeFetch(`${peer.url}/api/cluster/sessions/fork`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, projectId: project.id }), signal: AbortSignal.timeout(30_000),
        });
      } catch { throw new ConversationForkError(409, "Conversation owner is unavailable; fork was not confirmed"); }
      response.status(routed.status).json(await routed.json());
      if (routed.ok) broadcastToProject(project.id, { type: "sessionsChanged" });
      return;
    }
    const authSession = response.locals.authSession as AuthSession;
    const session = await forkLocalConversation(project, payload.engine, payload.sessionId, "[F]", { userId: authSession.userId, username: authSession.accountId });
    broadcastToProject(project.id, { type: "sessionsChanged" });
    response.status(201).json({ session });
  } catch (error) {
    if (error instanceof ConversationForkError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.post(["/api/cluster/sessions/fork", "/api/cluster/v2/runtime/sessions/fork"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = sessionForkSchema.extend({ projectId: z.string().min(1) }).parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const session = await forkLocalConversation(project, payload.engine, payload.sessionId);
    broadcastToProject(project.id, { type: "sessionsChanged" });
    response.status(201).json({ session });
  } catch (error) {
    if (error instanceof ConversationForkError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

const byTheWayCloseSchema = sessionForkSchema.extend({ token: z.string().uuid(), nodeId: z.string().uuid().optional() });

async function createLocalByTheWay(project: ProjectRecord, engine: ConversationEngine, sessionId: string, viewer?: { userId: string; username: string }): Promise<{ session: SessionSummary; token: string }> {
  const session = await forkLocalConversation(project, engine, sessionId, "[BTW]", viewer);
  try {
    const lease = await createByTheWayLease(project.id, session.harnessId, session.id);
    return { session, token: lease.token };
  } catch (error) {
    await deleteLocalConversation(project, session.harnessId, session.id).catch((cleanupError) => console.warn("Could not roll back By the Way fork", cleanupError));
    throw error;
  }
}

async function closeLocalByTheWay(project: ProjectRecord, engine: ConversationEngine, sessionId: string, token: string): Promise<void> {
  const lease = await getByTheWayLease(project.id, engine, sessionId, token);
  if (!lease) throw new ConversationDeleteError(404, "By the Way conversation not found");
  const shared = findHarnessSession(project.id, engine, sessionId);
  if (shared && harnessSessionBusy(shared)) {
    await shared.session.cancel();
    const deadline = Date.now() + 10_000;
    while (harnessSessionBusy(shared) && Date.now() < deadline) await delay(20);
    if (harnessSessionBusy(shared)) throw new ConversationDeleteError(409, "By the Way conversation is still stopping");
  }
  try {
    await deleteLocalConversation(project, engine, sessionId);
  } catch (error) {
    if (!(error instanceof ConversationDeleteError) || error.status !== 404) throw error;
  }
  await deleteByTheWayLease(lease);
}

export async function cleanupAbandonedByTheWayConversations(): Promise<void> {
  for (const lease of await listByTheWayLeases()) {
    try {
      const project = await getProject(lease.projectId);
      if (project) await closeLocalByTheWay(project, lease.engine, lease.sessionId, lease.token);
      else await deleteByTheWayLease(lease);
    } catch (error) {
      console.warn(`Could not delete abandoned By the Way conversation ${lease.sessionId}`, error);
    }
  }
}

async function byTheWayOwner(engine: ConversationEngine, sessionId: string, requestedNodeId?: string): Promise<ClusterPeer | undefined> {
  const local = await getClusterNode();
  const ownership = await getConversationOwnership(engine, sessionId);
  const ownerNodeId = requestedNodeId ?? ownership?.ownerNodeId;
  if (!ownerNodeId || ownerNodeId === local.id) return undefined;
  const peer = await getRuntimePeer(ownerNodeId);
  if (!peer) throw new ConversationDeleteError(409, "Conversation owner is unavailable");
  return peer;
}

app.post("/api/projects/:projectId/sessions/by-the-way", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const payload = sessionForkSchema.parse(request.body);
    const peer = await byTheWayOwner(payload.engine, payload.sessionId);
    if (peer) {
      const routed = await runtimeFetch(`${peer.url}/api/cluster/sessions/by-the-way`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, projectId: project.id }), signal: AbortSignal.timeout(30_000),
      });
      const body = await routed.json();
      if (routed.ok) {
        const result = z.object({ session: z.object({ harnessId: registeredHarnessIdSchema, id: z.string().min(1) }).passthrough(), token: z.string().uuid() }).parse(body);
        try {
          await createByTheWayLease(project.id, result.session.harnessId, result.session.id, result.token);
        } catch (error) {
          await runtimeFetch(`${peer.url}/api/cluster/sessions/by-the-way/close`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId: project.id, engine: result.session.harnessId, sessionId: result.session.id, token: result.token }), signal: AbortSignal.timeout(30_000),
          }).catch((cleanupError) => console.warn("Could not roll back remote By the Way fork", cleanupError));
          throw error;
        }
      }
      response.status(routed.status).json(body);
      return;
    }
    const authSession = response.locals.authSession as AuthSession;
    response.status(201).json(await createLocalByTheWay(project, payload.engine, payload.sessionId, { userId: authSession.userId, username: authSession.accountId }));
  } catch (error) {
    if (error instanceof ConversationForkError || error instanceof ConversationDeleteError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.post(["/api/cluster/sessions/by-the-way", "/api/cluster/v2/runtime/sessions/by-the-way"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = sessionForkSchema.extend({ projectId: z.string().min(1) }).parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    response.status(201).json(await createLocalByTheWay(project, payload.engine, payload.sessionId));
  } catch (error) {
    if (error instanceof ConversationForkError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.post("/api/projects/:projectId/sessions/by-the-way/close", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const payload = byTheWayCloseSchema.parse(request.body);
    const peer = await byTheWayOwner(payload.engine, payload.sessionId, payload.nodeId);
    if (peer) {
      const routed = await runtimeFetch(`${peer.url}/api/cluster/sessions/by-the-way/close`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, projectId: project.id }), signal: AbortSignal.timeout(30_000),
      });
      const body = await routed.json();
      if (routed.ok) {
        const shadow = await getByTheWayLease(project.id, payload.engine, payload.sessionId, payload.token);
        if (shadow) await deleteByTheWayLease(shadow);
      }
      response.status(routed.status).json(body);
      return;
    }
    await closeLocalByTheWay(project, payload.engine, payload.sessionId, payload.token);
    response.json({ closed: true });
  } catch (error) {
    if (error instanceof ConversationDeleteError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.post(["/api/cluster/sessions/by-the-way/close", "/api/cluster/v2/runtime/sessions/by-the-way/close"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = byTheWayCloseSchema.extend({ projectId: z.string().min(1) }).parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await closeLocalByTheWay(project, payload.engine, payload.sessionId, payload.token);
    response.json({ closed: true });
  } catch (error) {
    if (error instanceof ConversationDeleteError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

function ownershipEvent(record: ConversationOwnership, originNodeId: string) {
  return {
    id: randomUUID(), originNodeId, entityType: "conversation.ownership", entityKey: `${record.engine}:${record.sessionId}`,
    operation: "upsert", payload: { ...record, originNodeId }, createdAt: new Date().toISOString(),
  };
}

// Peers reached through a Tailscale relay take several seconds per request.
const TAKEOVER_PEER_TIMEOUT_MS = 15_000;

class OwnershipAcknowledgementError extends Error {}

async function applyOwnershipToPeer(peer: ClusterPeer, record: ConversationOwnership, originNodeId: string): Promise<OwnershipApplyResult> {
  const response = await runtimeFetch(`${peer.url}/api/cluster/sessions/ownership/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ record, originNodeId }), signal: AbortSignal.timeout(TAKEOVER_PEER_TIMEOUT_MS),
  });
  const result = await response.json() as OwnershipApplyResult & { error?: string };
  if (!response.ok) throw new OwnershipAcknowledgementError(result.error || `Ownership acknowledgement failed from ${peer.name}`);
  return result;
}

app.get(["/api/cluster/sessions/ownership", "/api/cluster/v2/runtime/sessions/ownership"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const engine = registeredHarnessIdSchema.parse(request.query.engine);
    const sessionId = z.string().min(1).max(240).parse(request.query.sessionId);
    response.json({ ownership: await getConversationOwnership(engine, sessionId) ?? null });
  } catch (error) { next(error); }
});

app.post(["/api/cluster/sessions/ownership/apply", "/api/cluster/v2/runtime/sessions/ownership/apply"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = z.object({ record: ownershipSchema, originNodeId: z.string().uuid() }).parse(request.body);
    const originNodeId = response.locals.machineNodeId as string;
    if (payload.originNodeId !== originNodeId) { sendError(response, 403, "Ownership origin does not match authenticated peer"); return; }
    await receiveReplicationBatch({ events: [ownershipEvent(payload.record, originNodeId)] });
    const current = await getConversationOwnership(payload.record.engine, payload.record.sessionId) ?? null;
    response.json({ accepted: sameConversationOwnership(current ?? undefined, payload.record), current });
  } catch (error) { next(error); }
});

interface ConversationTranscriptPresence { found: boolean; hasTranscript: boolean }

/** Worktree conversations live outside the project folder; a lookup that misses them sees only their draft record. */
async function listProjectScopeSessions(project: ProjectRecord): Promise<SessionSummary[]> {
  return listHarnessSessions({ ...project, additionalPaths: await projectAdditionalPaths(project.id) });
}

async function localConversationTranscriptPresence(project: ProjectRecord, engine: ConversationEngine, sessionId: string): Promise<ConversationTranscriptPresence> {
  const session = (await listProjectScopeSessions(project)).find((candidate) => candidate.harnessId === engine && candidate.id === sessionId);
  return { found: Boolean(session), hasTranscript: Boolean(session && !session.draft) };
}

app.get(["/api/cluster/sessions/transcript-presence", "/api/cluster/v2/runtime/sessions/transcript-presence"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const query = z.object({ projectId: z.string().min(1), engine: registeredHarnessIdSchema, sessionId: z.string().min(1).max(240) }).parse(request.query);
    const project = await getProject(query.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    response.json(await localConversationTranscriptPresence(project, query.engine, query.sessionId));
  } catch (error) { next(error); }
});

function conversationIsActive(projectId: string, engine: ConversationEngine, sessionId: string, _sessionPath: string): boolean {
  const shared = findHarnessSession(projectId, engine, sessionId);
  return Boolean(shared && harnessSessionBusy(shared));
}

function conversationSessionIsOpen(projectId: string, engine: ConversationEngine, sessionId: string, _sessionPath: string): boolean {
  return Boolean(findHarnessSession(projectId, engine, sessionId));
}

async function replicateExactOwnership(peers: ClusterPeer[], record: ConversationOwnership, originNodeId: string): Promise<void> {
  const results = await Promise.all(peers.map((peer) => applyOwnershipToPeer(peer, record, originNodeId)));
  const rejected = results.find((result) => !result.accepted || !sameConversationOwnership(result.current ?? undefined, record));
  if (rejected) throw new Error(`Peer rejected ownership state: ${JSON.stringify(rejected.current)}`);
}

async function assertDraftTakeoverReady(project: ProjectRecord, matching: SessionSummary, localId: string, peers: ClusterPeer[]): Promise<void> {
  if (!matching.draft) return;
  const ownership = await getConversationOwnership(matching.harnessId, matching.id);
  if (!ownership || ownership.ownerNodeId === localId) return;
  const owner = peers.find((peer) => peer.id === ownership.ownerNodeId);
  if (!owner) throw new TaskWorktreeError("Conversation owner is not a peer for this project; cannot verify transcript synchronization");
  const url = new URL("/api/cluster/sessions/transcript-presence", owner.url);
  url.searchParams.set("projectId", project.id);
  url.searchParams.set("engine", matching.harnessId);
  url.searchParams.set("sessionId", matching.id);
  let response: globalThis.Response;
  try {
    response = await runtimeFetch(url, { signal: AbortSignal.timeout(TAKEOVER_PEER_TIMEOUT_MS) });
  } catch (error) {
    if (!peerIsUnreachable(error)) throw error;
    throw new TaskWorktreeError(`${owner.name} did not answer the transcript check; cannot verify transcript synchronization`);
  }
  if (!response.ok) throw new Error(`Transcript presence check failed on ${owner.name}`);
  const presence = z.object({ found: z.boolean(), hasTranscript: z.boolean() }).parse(await response.json());
  if (!presence.found || presence.hasTranscript) throw new TaskWorktreeError("Wait for the conversation transcript to synchronize to this node before taking ownership");
}

app.post(["/api/cluster/sessions/queue-transfer", "/api/cluster/v2/runtime/sessions/queue-transfer"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = z.object({ projectId: z.string().min(1), engine: registeredHarnessIdSchema, sessionId: z.string().min(1) }).parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const listed = await listProjectScopeSessions(project);
    if (!listed.some((session) => session.id === payload.sessionId && session.harnessId === payload.engine)) throw new Error("Queue conversation is not the active segment in this project");
    const local = await getClusterNode();
    const destination = response.locals.machineNodeId as string;
    const current = await getConversationOwnership(payload.engine, payload.sessionId);
    if (!current || current.ownerNodeId !== local.id || !["owned", "transferring", "conflict"].includes(current.status)) throw new Error("Queue transfer requires its current owner");
    if (current.status === "transferring" && current.transferToNodeId !== destination) throw new Error("Conversation is transferring to another node");
    const record = await getConversationRecord(project.id, payload.engine, payload.sessionId);
    const key = `${project.id}:${record?.conversationId ?? payload.sessionId}`;
    const transferSession = async () => (await listProjectSessionsWithReviewState(project, "", "")).find(session => session.id === payload.sessionId);
    let listedSession = await transferSession();
    if (promptQueueIsDraining(key) || listedSession?.turnRunning) throw new Error("Wait for the current queue dispatch to finish before transferring");
    // Background tasks belong to the node that runs them and cannot follow the
    // conversation, so the owner stops them rather than refusing the transfer.
    if (listedSession?.running) {
      await stopConversationBackgroundTasks(record?.conversationId ?? payload.sessionId);
      listedSession = await transferSession();
      if (promptQueueIsDraining(key) || listedSession?.running) throw new Error("Background work is still running in this conversation; wait for it to finish before transferring");
    }
    const fenced = { ...current, status: "transferring" as const, transferToNodeId: destination };
    const result = await compareAndSetConversationOwnership(current, fenced, local.id);
    if (!result.accepted) throw new Error("Conversation owner changed during queue transfer");
    if (promptQueueIsDraining(key)) {
      await compareAndSetConversationOwnership(fenced, { ...fenced, epoch: fenced.epoch + 1, status: "owned", transferToNodeId: null }, local.id);
      throw new Error("Queue dispatch is settling; retry transfer");
    }
    response.json({ events: [ownershipEvent(fenced, local.id), ...queuedPromptSnapshot(key)] });
  } catch (error) { next(error); }
});

// The source arbitrates completion against cancellation using the exact fence.
// A destination must not commit independently at the same epoch as a cancellation.
app.post(["/api/cluster/sessions/queue-transfer/cancel", "/api/cluster/v2/runtime/sessions/queue-transfer/cancel", "/api/cluster/sessions/queue-transfer/complete", "/api/cluster/v2/runtime/sessions/queue-transfer/complete"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const { projectId, record } = z.object({ projectId: z.string().min(1), record: ownershipSchema }).parse(request.body);
    if (!await getConversationRecord(projectId, record.engine, record.sessionId)) { sendError(response, 404, "Conversation not found in this project"); return; }
    const local = await getClusterNode();
    if (record.ownerNodeId !== local.id || record.status !== "transferring" || record.transferToNodeId !== response.locals.machineNodeId) {
      sendError(response, 403, "Only the transfer destination may cancel its fence"); return;
    }
    const restored = { ...record, ownerNodeId: request.path.endsWith("/complete") ? record.transferToNodeId! : local.id, epoch: record.epoch + 1, status: "owned" as const, transferToNodeId: null };
    response.json(await compareAndSetConversationOwnership(record, restored, local.id));
  } catch (error) { next(error); }
});

async function settleQueueTransfer(projectId: string, record: ConversationOwnership, peers: ClusterPeer[], action: "cancel" | "complete"): Promise<OwnershipApplyResult> {
  const source = peers.find(peer => peer.id === record.ownerNodeId);
  if (!source) throw new Error(`Cannot ${action} transfer: source node is unavailable`);
  const response = await runtimeFetch(`${source.url}/api/cluster/sessions/queue-transfer/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, record }), signal: AbortSignal.timeout(TAKEOVER_PEER_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Could not ${action} transfer (${response.status})`);
  const result = await response.json() as OwnershipApplyResult;
  if (result.current) await receiveReplicationBatch({ events: [ownershipEvent(result.current, source.id)] });
  return result;
}

function peerIsUnreachable(error: unknown): boolean {
  return error instanceof TypeError || error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name);
}

async function synchronizeQueueBeforeTakeover(projectId: string, engine: ConversationEngine, sessionId: string, localId: string, peers: ClusterPeer[], requireOnline = false): Promise<Set<string>> {
  const unavailable = new Set<string>();
  const current = await getConversationOwnership(engine, sessionId);
  if (current?.ownerNodeId === localId && current.status === "owned") return unavailable;
  await Promise.all(peers.map(async (peer) => {
    const url = new URL("/api/cluster/sessions/ownership", peer.url);
    url.searchParams.set("engine", engine); url.searchParams.set("sessionId", sessionId);
    let body: unknown;
    try {
      const reply = await runtimeFetch(url, { signal: AbortSignal.timeout(TAKEOVER_PEER_TIMEOUT_MS) });
      if (!reply.ok) {
        const refusal = await reply.json().catch(() => ({})) as { error?: string };
        throw new TaskWorktreeError(`Cannot verify queue ownership on ${peer.name} (${reply.status}${refusal.error ? `: ${refusal.error}` : ""})`);
      }
      body = await reply.json();
    } catch (error) {
      if (!peerIsUnreachable(error)) throw error;
      unavailable.add(peer.id);
      return;
    }
    const remote = z.object({ ownership: ownershipSchema.nullable() }).parse(body).ownership;
    if (remote) await receiveReplicationBatch({ events: [ownershipEvent(remote, peer.id)] });
  }));
  if (requireOnline && unavailable.size) throw new TaskWorktreeError("Scheduled ownership transfer requires all peers online");
  const previous = await getConversationOwnership(engine, sessionId);
  if (requireOnline && previous && previous.ownerNodeId !== localId && !peers.some(peer => peer.id === previous.ownerNodeId)) throw new TaskWorktreeError("Conversation owner is unavailable");
  if (!previous || previous.ownerNodeId === localId) return unavailable;
  const source = peers.find((peer) => peer.id === previous.ownerNodeId);
  // Offline takeover uses the last replicated queue. The higher ownership epoch
  // and its durable outbox event fence the old owner when it reconnects.
  if (!source || unavailable.has(source.id)) return unavailable;
  let snapshot: { events: ReplicationEvent[] };
  let acknowledged = false;
  try {
    const response = await runtimeFetch(`${source.url}/api/cluster/sessions/queue-transfer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      // The owner may stop background tasks first, which can take several seconds.
      body: JSON.stringify({ projectId, engine, sessionId }), signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const refusal = await response.json().catch(() => ({})) as { error?: string };
      throw new TaskWorktreeError(`Queue transfer was not acknowledged by its owner${refusal.error ? `: ${refusal.error}` : "; wait for dispatch to finish and retry"}`);
    }
    acknowledged = true;
    snapshot = await response.json() as { events: ReplicationEvent[] };
    // The source answers with this conversation's ownership and queue, and nothing else.
    const db = await clusterV2Database();
    const events = snapshot.events.filter(event => ["conversation.ownership", "conversation.queue"].includes(event.entityType)
      && event.originNodeId === source.id && mayReplicateEvent(db, localId, source.id, event));
    await receiveReplicationBatch({ ...snapshot, events });
  } catch (error) {
    if (peerIsUnreachable(error) && !requireOnline) { unavailable.add(source.id); return unavailable; }
    if (acknowledged || peerIsUnreachable(error)) {
      await settleQueueTransfer(projectId, { ...previous, status: "transferring", transferToNodeId: localId }, peers, "cancel");
    }
    throw error;
  }
  return unavailable;
}

const transferringSessions = new Set<string>();

export async function takeLocalSessionOwnership(project: ProjectRecord, payload: z.infer<typeof routedSessionTakeOwnershipSchema>, requireOnline = false, signal?: AbortSignal): Promise<{ sessionPath: string; ownership: ConversationOwnership; pendingPeerIds: string[]; saved?: string }> {
  const [local, sessions, peers] = await Promise.all([getClusterNode(), listProjectScopeSessions(project), listRuntimePeers(project.id)]);
  if (payload.peerId !== local.id) throw new Error("Takeover destination is not this node");
  const matching = payload.sessionId ? sessions.find((session) => session.id === payload.sessionId) : sessions.find((session) => session.path === payload.sessionPath);
  if (!matching) throw new TaskWorktreeError("Conversation was not found on the destination node");
  await assertDraftTakeoverReady(project, matching, local.id, peers);
  const engine: ConversationEngine = matching.harnessId;
  const sessionId = matching.id;
  if (conversationIsActive(project.id, engine, sessionId, matching.path)) throw new TaskWorktreeError("Wait for the current turn to finish before taking ownership");
  const key = `${engine}:${sessionId}`;
  if (transferringSessions.has(key)) throw new TaskWorktreeError("A transfer is already in progress for this conversation");
  transferringSessions.add(key);
  try {
  signal?.throwIfAborted();
  const unavailable = await synchronizeQueueBeforeTakeover(project.id, engine, sessionId, local.id, peers, requireOnline);
  const expected = await getConversationOwnership(engine, sessionId);
  let saved: string | undefined;
  let ownership: ConversationOwnership;
  let committing = false;
  try {
    signal?.throwIfAborted();
    // An explicit history choice is bound to the owner the person selected.
    if (payload.historyOwnerNodeId && (expected?.ownerNodeId !== payload.historyOwnerNodeId || unavailable.has(payload.historyOwnerNodeId))) throw new TaskWorktreeError("The selected history owner changed or is unavailable; check again");
    if (!matching.draft && !(expected && unavailable.has(expected.ownerNodeId))) {
      try { await assertSharedTranscriptReady(project.id, matching.path, undefined, signal); }
      catch (error) {
        if (!payload.historyOwnerNodeId || !(error instanceof Error) || !/Divergent transcript requires review/.test(error.message)) throw error;
        signal?.throwIfAborted();
        const live = findHarnessSession(project.id, engine, sessionId);
        if (live && harnessSessionBusy(live)) throw new TaskWorktreeError("This conversation is running on this machine; stop it first");
        ({ saved } = await acceptOwnerTranscript(payload.historyOwnerNodeId, project.id, engine, sessionId, signal));
        if (live) disposeHarnessSession(live);
        await assertSharedTranscriptReady(project.id, matching.path, undefined, signal);
      }
    }
    signal?.throwIfAborted();
    committing = true;
    if (expected?.status === "transferring" && expected.ownerNodeId !== local.id && !unavailable.has(expected.ownerNodeId)) {
      const result = await settleQueueTransfer(project.id, expected, peers, "complete");
      if (!result.accepted || result.current?.ownerNodeId !== local.id) throw new TaskWorktreeError("Conversation transfer was cancelled or ownership changed; check again");
      ownership = result.current;
    } else {
      ownership = expected?.ownerNodeId === local.id && expected.status === "owned" ? expected
        : { engine, sessionId, ownerNodeId: local.id, epoch: (expected?.epoch ?? 0) + 1, status: "owned", transferToNodeId: null };
      const result = await compareAndSetConversationOwnership(expected, ownership, local.id);
      if (!result.accepted) throw new TaskWorktreeError("Conversation ownership changed during transfer; check again");
    }
  } catch (error) {
    if (committing) throw new TaskWorktreeError(`Transfer completion could not be confirmed. Reopen the conversation to check its owner. ${error instanceof Error ? error.message : error}`);
    if (expected && expected.ownerNodeId !== local.id && (expected.status === "transferring" && expected.transferToNodeId === local.id || unavailable.has(expected.ownerNodeId))) {
      // The owner may have fenced the queue even if its reply was lost.
      const fence = { ...expected, status: "transferring" as const, transferToNodeId: local.id };
      try { await settleQueueTransfer(project.id, fence, peers, "cancel"); }
      catch (failure) { throw new Error(`${error instanceof Error ? error.message : error}. Transfer cancellation failed: ${failure instanceof Error ? failure.message : failure}`); }
    }
    throw error;
  }
  const reachable = peers.filter((peer) => !unavailable.has(peer.id));
  const settled = await Promise.allSettled(reachable.map((peer) => applyOwnershipToPeer(peer, ownership, local.id)));
  const pendingPeerIds = [...unavailable];
  for (const [index, result] of settled.entries()) {
    if (result.status === "rejected") {
      const error = result.reason;
      if (peerIsUnreachable(error)) { pendingPeerIds.push(reachable[index].id); continue; }
      throw new Error(`Ownership transferred, but peer acknowledgement failed: ${error instanceof Error ? error.message : error}`);
    }
    if (!result.value.accepted || !sameConversationOwnership(result.value.current ?? undefined, ownership)) {
      throw new Error("Ownership transferred, but a peer reports a different owner; reopen the conversation to check");
    }
  }
  return { sessionPath: matching.path, ownership, pendingPeerIds, ...(saved ? { saved } : {}) };
  } finally { transferringSessions.delete(key); }
}

app.put("/api/projects/:projectId/sessions/reviewed", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const submitted = sessionReviewedSchema.parse(request.body);
    const authSession = response.locals.authSession as AuthSession;
    const sessions = await listReviewScopeSessions(project, authSession.userId, authSession.accountId);
    const session = sessions.find((candidate) => candidate.path === submitted.sessionPath);
    if (!session) { sendError(response, 404, "Conversation not found"); return; }
    if (!session.updatedAt || submitted.updatedAt > session.updatedAt) { sendError(response, 409, "Conversation review watermark is newer than current activity"); return; }
    const local = await getClusterNode();
    markConversationReviewed(authSession.userId, authSession.accountId, project.id, { path: session.path, engine: session.harnessId, sessionId: session.id, updatedAt: submitted.updatedAt }, local.id);
    // Review marks are the person's own: only their pages refresh.
    broadcastToAllClients({ type: "sessionsChanged" }, authSession.accountId);
    flushReplicationOutbox().catch((error) => console.warn("Review watermark flush failed", error));
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.put("/api/projects/:projectId/sessions/reviewed-all", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const { sessions: submitted } = sessionsReviewedSchema.parse(request.body);
    const authSession = response.locals.authSession as AuthSession;
    const sessions = await listReviewScopeSessions(project, authSession.userId, authSession.accountId);
    const currentByPath = new Map(sessions.map((session) => [session.path, session]));
    const invalid = submitted.find((watermark) => {
      const current = currentByPath.get(watermark.sessionPath);
      return !current || !current.updatedAt || watermark.updatedAt > current.updatedAt;
    });
    if (invalid) { sendError(response, 409, `Conversation review watermark is stale or missing: ${invalid.sessionPath}`); return; }
    const local = await getClusterNode();
    markConversationsReviewed(authSession.userId, authSession.accountId, project.id, submitted.flatMap((watermark) => {
      const current = currentByPath.get(watermark.sessionPath)!;
      return [{ path: watermark.sessionPath, engine: current.harnessId, sessionId: current.id, updatedAt: watermark.updatedAt }];
    }), local.id);
    // Review marks are the person's own: only their pages refresh.
    broadcastToAllClients({ type: "sessionsChanged" }, authSession.accountId);
    flushReplicationOutbox().catch((error) => console.warn("Review watermark flush failed", error));
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

/**
 * The review inbox spans every project, so it scans them all. Sessions without an `updatedAt`
 * carry no watermark and could never be marked reviewed, so they are left out.
 */
app.get("/api/reviews/pending", async (_request, response, next) => {
  try {
    const authSession = response.locals.authSession as AuthSession;
    const [projects] = await Promise.all([projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false }), noteUnannouncedRunChanges()]);
    const groups = await Promise.all(projects.map(async (project) => {
      const sessions = await sharedProjectSessions(project, authSession.userId, authSession.accountId);
      return {
        projectId: project.id,
        projectName: project.name,
        sessions: sessions
          .filter((session) => session.reviewState === "needs_review" && !session.running && session.updatedAt)
          .map((session) => ({
            id: session.id,
            path: session.path,
            title: session.title,
            agentId: session.agentId,
            agentLabel: session.agentLabel,
            updatedAt: session.updatedAt,
          })),
      };
    }));
    response.json({ projects: groups.filter((group) => group.sessions.length > 0) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/running", async (_request, response, next) => {
  try {
    const authSession = response.locals.authSession as AuthSession;
    const [projects] = await Promise.all([projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false }), noteUnannouncedRunChanges()]);
    const groups = await Promise.all(projects.map(async (project) => {
      const sessions = await sharedProjectSessions(project, authSession.userId, authSession.accountId);
      return {
        projectId: project.id,
        projectName: project.name,
        sessions: sessions.filter((session) => session.running).map((session) => ({
          id: session.id,
          path: session.path,
          color: session.color,
          harnessId: session.harnessId,
          title: session.title,
          agentId: session.agentId,
          agentLabel: session.agentLabel,
          agentModel: session.agentModel,
          updatedAt: session.updatedAt,
          executionNodeId: session.executionNodeId,
          turnRunning: session.turnRunning,
          backgroundRunning: session.backgroundRunning,
          running: true,
        })),
      };
    }));
    response.json({ projects: groups.filter((group) => group.sessions.length > 0) });
  } catch (error) {
    next(error);
  }
});

function takeoverSignal(response: import("express").Response): AbortSignal {
  const controller = new AbortController();
  if (response.destroyed) controller.abort(new Error("Transfer cancelled by the caller"));
  response.once("close", () => { if (!response.writableEnded) controller.abort(new Error("Transfer cancelled by the caller")); });
  return controller.signal;
}

app.post(["/api/cluster/sessions/take-ownership", "/api/cluster/v2/runtime/sessions/take-ownership"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    if (!await peerMayRunHere(response.locals.machineNodeId)) { sendError(response, 403, "This node does not accept runs from other nodes"); return; }
    const payload = routedSessionTakeOwnershipSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    response.json(await takeLocalSessionOwnership(project, payload, false, takeoverSignal(response)));
  } catch (error) {
    if (error instanceof TaskWorktreeError) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

app.post("/api/projects/:projectId/sessions/take-ownership", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const payload = sessionTakeOwnershipSchema.parse(request.body);
    const local = await getClusterNode();
    const signal = takeoverSignal(response);
    if (payload.peerId === local.id) { response.json(await takeLocalSessionOwnership(project, { ...payload, projectId: project.id }, false, signal)); return; }
    const peer = await getRuntimePeer(payload.peerId);
    if (!peer) { sendError(response, 404, "Peer not found"); return; }
    const routed = await runtimeFetch(`${peer.url}/api/cluster/sessions/take-ownership`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, projectId: project.id }), signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    response.status(routed.status).json(await routed.json());
  } catch (error) { next(error); }
});

app.post("/api/projects/:projectId/sessions/recover", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const payload = sessionRecoverySchema.parse(request.body);
    if (await conversationOfAnotherProject(project, payload.engine, payload.sessionId)) { sendError(response, 404, "Conversation not found"); return; }
    const local = await getClusterNode();
    const mapped = resolveLocalSessionPath(payload.sessionPath);
    if (payload.engine !== mapped.engine) throw new Error("Recovery engine does not match the transcript");
    const adapter = getHarness(mapped.engine);
    if (!adapter.sessions.recover) throw new Error(`${adapter.label} does not support transcript conflict recovery`);
    if (conversationSessionIsOpen(project.id, payload.engine, payload.sessionId, mapped.path)) throw new Error("Close the local conversation before recovery");
    await requireLocalConversationOwner(payload.engine, payload.sessionId);
    const peers = await listRuntimePeers(project.id);
    const fenced = await beginConversationRecovery(payload.engine, payload.sessionId, local.id);
    await replicateExactOwnership(peers, fenced, local.id);
    if (conversationSessionIsOpen(project.id, payload.engine, payload.sessionId, mapped.path)) throw new Error("Conversation opened during recovery fencing");
    await adapter.sessions.recover(mapped.path, project.path);
    const owned = await finishConversationRecovery(payload.engine, payload.sessionId, local.id);
    await replicateExactOwnership(peers, owned, local.id);
    response.json({ ownership: owned, sessionPath: mapped.path });
  } catch (error) { next(error); }
});

export class ConversationDeleteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function deleteLocalConversation(project: ProjectRecord, engine: ConversationEngine, sessionId: string, taskId?: string): Promise<void> {
  await assertProjectEditable(project);
  const tasks = await listTasks(project.id);
  const ticket = taskId ? tasks.find((task) => task.id === taskId) : undefined;
  if (ticket?.status === "done" || await conversationBelongsToDoneTask(project.id, engine, sessionId)) {
    throw new ConversationDeleteError(409, "Done ticket conversations are read-only");
  }
  const sessions = await listHarnessSessions({ ...project, additionalPaths: await projectAdditionalPaths(project.id, tasks) });
  const session = sessions.find((candidate) => candidate.id === sessionId && candidate.harnessId === engine);
  if (!session) throw new ConversationDeleteError(404, "Session not found");
  await requireLocalConversationOwner(engine, sessionId);
  const local = await getClusterNode();
  // Harness-switched segments are one conversation; removing it removes every segment.
  const targets: Array<{ engine: ConversationEngine; sessionId: string; path: string; draft?: boolean }> = [
    { engine, sessionId, path: session.path, ...(session.draft ? { draft: true } : {}) },
    ...(session.segments ?? []).filter((segment) => !(segment.sessionId === sessionId && segment.engine === engine)),
  ];
  for (const [index, target] of targets.entries()) {
    const shared = findHarnessSession(project.id, target.engine, target.sessionId);
    if (shared && harnessSessionBusy(shared)) throw new ConversationDeleteError(409, "Wait for the current turn to finish before deleting");
    if (shared) {
      for (const client of shared.clients) { send(client, { type: "sessionFileChanged" }); client.close(1008, "Conversation deleted"); }
      disposeHarnessSession(shared);
    }
    if (target.draft || target.path.startsWith("draft:")) {
      await deleteConversationRecord(project.id, target.engine, target.sessionId, local.id);
      continue;
    }
    const adapter = getHarness(target.engine);
    if (!adapter.paths.transcriptFile) throw new ConversationDeleteError(400, `${adapter.label} does not expose transcript files`);
    const filePath = adapter.paths.transcriptFile(target.path);
    try {
      const fileStats = await lstat(filePath);
      if (!fileStats.isFile() || fileStats.isSymbolicLink()) throw new ConversationDeleteError(400, "Session path is not a regular file");
      await unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // The primary transcript must exist; an already-synchronized-away segment still drops its record.
        if (index === 0) throw new ConversationDeleteError(404, "Session not found");
      } else {
        throw error;
      }
    }
    await deleteConversationRecord(project.id, target.engine, target.sessionId, local.id);
  }
  // A deleted conversation's browser profile assignments go with it. Harness-switched
  // segments are one conversation, so every segment id and the logical conversation id
  // drop their grants; the profile entities themselves stay durable.
  for (const conversationId of new Set([sessionId, ...(session.conversationId ? [session.conversationId] : []), ...targets.map(target => target.sessionId)])) {
    dropBrowserConversationGrants(project.id, conversationId);
    revokeAgentCapabilities(project.id, conversationId);
  }
  clearHarnessSessionCache(project.id);
  broadcastToProject(project.id, { type: "sessionsChanged" });
}

app.delete("/api/projects/:projectId/sessions", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const payload = sessionDeleteSchema.parse({ projectId: project.id, engine: request.query.engine, sessionId: request.query.sessionId, taskId: request.query.taskId });
    const local = await getClusterNode();
    const ownership = await getConversationOwnership(payload.engine, payload.sessionId);
    if (ownership && ownership.ownerNodeId !== local.id) {
      const peer = await getRuntimePeer(ownership.ownerNodeId);
      if (!peer) throw new ConversationDeleteError(409, "Conversation owner is unavailable");
      const routed = await runtimeFetch(`${peer.url}/api/cluster/sessions/delete`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000),
      });
      if (routed.status === 204) { response.status(204).send(); return; }
      const body = await routed.json().catch(() => null) as { error?: unknown } | null;
      sendError(response, routed.status, typeof body?.error === "string" ? body.error : "Conversation owner delete failed");
      return;
    }
    await deleteLocalConversation(project, payload.engine, payload.sessionId, payload.taskId);
    response.status(204).send();
  } catch (error) {
    if (error instanceof ConversationDeleteError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

const sessionTransferSchema = sessionForkSchema.extend({ destinationProjectId: z.string().min(1), mode: z.enum(["copy", "move"]) });

/** Copy writes a fresh-identity snapshot into the destination project. Move then deletes the
 * source; if that fails (busy turn, done ticket) the copy is rolled back so nothing is duplicated.
 * Session ids change because peers refuse an id that moves between projects. */
export async function transferLocalConversation(source: ProjectRecord, destination: ProjectRecord, engine: ConversationEngine, sessionId: string, mode: "copy" | "move", viewer?: { userId: string; username: string }): Promise<SessionSummary> {
  if (source.id === destination.id) throw new ConversationForkError(400, "Choose a different project");
  if (mode === "move") {
    const shared = findHarnessSession(source.id, engine, sessionId);
    if (shared && harnessSessionBusy(shared)) throw new ConversationDeleteError(409, "Wait for the current turn to finish before moving");
  }
  const copy = await forkLocalConversation(source, engine, sessionId, "", viewer, destination);
  if (mode === "copy") return copy;
  try {
    await deleteLocalConversation(source, engine, sessionId);
  } catch (error) {
    await deleteLocalConversation(destination, copy.harnessId, copy.id).catch((cleanupError) => console.warn("Could not roll back moved conversation copy", cleanupError));
    throw error;
  }
  broadcastToProject(source.id, { type: "sessionsChanged" });
  return copy;
}

app.post("/api/projects/:projectId/sessions/transfer", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const payload = sessionTransferSchema.parse(request.body);
    const destination = await getProject(payload.destinationProjectId);
    if (!destination) { sendError(response, 404, "Destination project not found"); return; }
    const local = await getClusterNode();
    const ownership = await getConversationOwnership(payload.engine, payload.sessionId);
    if (ownership && ownership.ownerNodeId !== local.id) {
      const peer = await getRuntimePeer(ownership.ownerNodeId);
      if (!peer) throw new ConversationForkError(409, "Conversation owner is unavailable");
      let routed: globalThis.Response;
      try {
        routed = await runtimeFetch(`${peer.url}/api/cluster/sessions/transfer`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, projectId: project.id }), signal: AbortSignal.timeout(30_000),
        });
      } catch { throw new ConversationForkError(409, "Conversation owner is unavailable; transfer was not confirmed"); }
      response.status(routed.status).json(await routed.json());
      if (routed.ok) { broadcastToProject(project.id, { type: "sessionsChanged" }); broadcastToProject(destination.id, { type: "sessionsChanged" }); }
      return;
    }
    const authSession = response.locals.authSession as AuthSession;
    const session = await transferLocalConversation(project, destination, payload.engine, payload.sessionId, payload.mode, { userId: authSession.userId, username: authSession.accountId });
    broadcastToProject(destination.id, { type: "sessionsChanged" });
    response.status(201).json({ session, projectId: destination.id });
  } catch (error) {
    if (error instanceof ConversationForkError || error instanceof ConversationDeleteError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.post(["/api/cluster/sessions/transfer", "/api/cluster/v2/runtime/sessions/transfer"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = sessionTransferSchema.extend({ projectId: z.string().min(1) }).parse(request.body);
    const project = await getProject(payload.projectId);
    const destination = await getProject(payload.destinationProjectId);
    if (!project || !destination) { sendError(response, 404, "Project not found"); return; }
    const session = await transferLocalConversation(project, destination, payload.engine, payload.sessionId, payload.mode);
    broadcastToProject(destination.id, { type: "sessionsChanged" });
    response.status(201).json({ session, projectId: destination.id });
  } catch (error) {
    if (error instanceof ConversationForkError || error instanceof ConversationDeleteError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.delete(["/api/cluster/sessions/delete", "/api/cluster/v2/runtime/sessions/delete"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = sessionDeleteSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await deleteLocalConversation(project, payload.engine, payload.sessionId, payload.taskId);
    response.status(204).send();
  } catch (error) {
    if (error instanceof ConversationDeleteError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});
