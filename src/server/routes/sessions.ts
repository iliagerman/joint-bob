import { randomUUID } from "node:crypto";
import { lstat, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { type ClusterPeer, getClusterMachineToken, getClusterNode, getClusterPeer, listClusterPeers } from "../../cluster.js";
import { beginConversationRecovery, compareAndSetConversationOwnership, type ConversationEngine, type ConversationOwnership, finishConversationRecovery, getConversationOwnership, type OwnershipApplyResult, sameConversationOwnership, takeConversationOwnership } from "../../conversation-ownership.js";
import { deleteConversationRecord, getConversationRecord } from "../../conversation-records.js";
import { markConversationReviewed, markConversationsReviewed } from "../../conversation-reviews.js";
import { listHarnessSessions } from "../../harnesses.js";
import { queuedPromptSnapshot } from "../../prompt-queue.js";
import { receiveReplicationBatch, type ReplicationEvent } from "../../replication.js";
import { capturePiRecoverySnapshot, recoverPiSessionDirectory, resolveLocalSessionPath } from "../../session-paths.js";
import { getProject, touchProject } from "../../store.js";
import { listTasks } from "../../tasks.js";
import type { ProjectRecord, SessionSummary } from "../../types.js";
import { TaskWorktreeError } from "../../worktrees.js";
import { claudeConnectionKey, promptQueueIsDraining } from "../chat.js";
import { conversationBelongsToDoneTask } from "../cluster-helpers.js";
import { sendError } from "../http-auth.js";
import { assertProjectEditable, projectsWithSharedNames } from "../projects.js";
import { broadcastToProject } from "../realtime.js";
import { ownershipSchema, registeredHarnessIdSchema, routedSessionTakeOwnershipSchema, sessionDeleteSchema, sessionRecoverySchema, sessionReviewedSchema, sessionsReviewedSchema, sessionTakeOwnershipSchema } from "../schemas.js";
import { listProjectSessionsWithReviewState, requireLocalConversationOwner } from "../sessions-helpers.js";
import { activeClaudeConnections, app, sharedSessions } from "../state.js";

app.get("/api/projects/:projectId/sessions", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    await touchProject(project.id);
    const authSession = response.locals.authSession as AuthSession;
    response.json({ sessions: await listProjectSessionsWithReviewState(project, authSession.userId, authSession.username) });
  } catch (error) {
    next(error);
  }
});

function ownershipEvent(record: ConversationOwnership, originNodeId: string) {
  return {
    id: randomUUID(), originNodeId, entityType: "conversation.ownership", entityKey: `${record.engine}:${record.sessionId}`,
    operation: "upsert", payload: { ...record, originNodeId }, createdAt: new Date().toISOString(),
  };
}

class OwnershipAcknowledgementError extends Error {}

async function applyOwnershipToPeer(peer: ClusterPeer, record: ConversationOwnership, originNodeId: string): Promise<OwnershipApplyResult> {
  const token = await getClusterMachineToken();
  const response = await fetch(`${peer.url}/api/cluster/sessions/ownership/apply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ record, originNodeId }), signal: AbortSignal.timeout(3_000),
  });
  const result = await response.json() as OwnershipApplyResult & { error?: string };
  if (!response.ok) throw new OwnershipAcknowledgementError(result.error || `Ownership acknowledgement failed from ${peer.name}`);
  return result;
}

app.get("/api/cluster/sessions/ownership", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const engine = registeredHarnessIdSchema.parse(request.query.engine);
    const sessionId = z.string().min(1).max(240).parse(request.query.sessionId);
    response.json({ ownership: await getConversationOwnership(engine, sessionId) ?? null });
  } catch (error) { next(error); }
});

app.post("/api/cluster/sessions/ownership/apply", async (request, response, next) => {
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

async function localConversationTranscriptPresence(project: ProjectRecord, engine: ConversationEngine, sessionId: string): Promise<ConversationTranscriptPresence> {
  const session = (await listHarnessSessions(project)).find((candidate) => candidate.harnessId === engine && candidate.id === sessionId);
  return { found: Boolean(session), hasTranscript: Boolean(session && !session.draft) };
}

app.get("/api/cluster/sessions/transcript-presence", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const query = z.object({ projectId: z.string().min(1), engine: registeredHarnessIdSchema, sessionId: z.string().min(1).max(240) }).parse(request.query);
    const project = await getProject(query.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    response.json(await localConversationTranscriptPresence(project, query.engine, query.sessionId));
  } catch (error) { next(error); }
});

function conversationIsActive(projectId: string, engine: ConversationEngine, sessionId: string, sessionPath: string): boolean {
  if (engine === "claude") return Boolean(activeClaudeConnections.get(claudeConnectionKey(projectId, sessionId))?.claude.child);
  const active = [...new Set(sharedSessions.values())].find((session) => session.projectId === projectId && session.handle.session.sessionFile === sessionPath);
  return Boolean(active?.handle.session.isStreaming);
}

function conversationSessionIsOpen(projectId: string, engine: ConversationEngine, sessionId: string, sessionPath: string): boolean {
  if (engine === "claude") return activeClaudeConnections.has(claudeConnectionKey(projectId, sessionId));
  return [...new Set(sharedSessions.values())].some((session) => session.projectId === projectId && session.handle.session.sessionFile === sessionPath);
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
  if (!owner) throw new TaskWorktreeError("Conversation owner is unavailable; cannot verify transcript synchronization");
  const url = new URL("/api/cluster/sessions/transcript-presence", owner.url);
  url.searchParams.set("projectId", project.id);
  url.searchParams.set("engine", matching.harnessId);
  url.searchParams.set("sessionId", matching.id);
  let response: globalThis.Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${await getClusterMachineToken()}` }, signal: AbortSignal.timeout(3_000) });
  } catch {
    throw new TaskWorktreeError("Conversation owner is unavailable; cannot verify transcript synchronization");
  }
  if (!response.ok) throw new Error(`Transcript presence check failed on ${owner.name}`);
  const presence = z.object({ found: z.boolean(), hasTranscript: z.boolean() }).parse(await response.json());
  if (!presence.found || presence.hasTranscript) throw new TaskWorktreeError("Wait for the conversation transcript to synchronize to this node before taking ownership");
}

app.post("/api/cluster/sessions/queue-transfer", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = z.object({ projectId: z.string().min(1), engine: registeredHarnessIdSchema, sessionId: z.string().min(1) }).parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const listed = await listHarnessSessions(project);
    if (!listed.some((session) => session.id === payload.sessionId && session.harnessId === payload.engine)) throw new Error("Queue conversation is not the active segment in this project");
    const local = await getClusterNode();
    const destination = response.locals.machineNodeId as string;
    const current = await getConversationOwnership(payload.engine, payload.sessionId);
    if (!current || current.ownerNodeId !== local.id || !["owned", "transferring", "conflict"].includes(current.status)) throw new Error("Queue transfer requires its current owner");
    if (current.status === "transferring" && current.transferToNodeId !== destination) throw new Error("Conversation is transferring to another node");
    const record = await getConversationRecord(project.id, payload.engine, payload.sessionId);
    const key = `${project.id}:${record?.conversationId ?? payload.sessionId}`;
    if (promptQueueIsDraining(key)) throw new Error("Wait for the current queue dispatch to finish before transferring");
    const fenced = { ...current, status: "transferring" as const, transferToNodeId: destination };
    const result = await compareAndSetConversationOwnership(current, fenced, local.id);
    if (!result.accepted) throw new Error("Conversation owner changed during queue transfer");
    if (promptQueueIsDraining(key)) throw new Error("Queue dispatch is settling; retry transfer");
    response.json({ events: [ownershipEvent(fenced, local.id), ...queuedPromptSnapshot(key)] });
  } catch (error) { next(error); }
});

async function synchronizeQueueBeforeTakeover(projectId: string, engine: ConversationEngine, sessionId: string, localId: string, peers: ClusterPeer[]): Promise<void> {
  const current = await getConversationOwnership(engine, sessionId);
  if (current?.ownerNodeId === localId && current.status === "owned") return;
  for (const peer of peers) {
    const url = new URL("/api/cluster/sessions/ownership", peer.url);
    url.searchParams.set("engine", engine); url.searchParams.set("sessionId", sessionId);
    const reply = await fetch(url, { headers: { Authorization: `Bearer ${await getClusterMachineToken()}` }, signal: AbortSignal.timeout(5_000) });
    if (!reply.ok) throw new TaskWorktreeError("Cannot verify queue ownership on peer");
    const remote = z.object({ ownership: ownershipSchema.nullable() }).parse(await reply.json()).ownership;
    if (remote) await receiveReplicationBatch({ events: [ownershipEvent(remote, peer.id)] });
  }
  const previous = await getConversationOwnership(engine, sessionId);
  if (!previous || previous.ownerNodeId === localId) return;
  const source = peers.find((peer) => peer.id === previous.ownerNodeId);
  if (!source) throw new TaskWorktreeError("Queue owner is unavailable; cannot safely transfer pending prompts");
  const response = await fetch(`${source.url}/api/cluster/sessions/queue-transfer`, {
    method: "POST", headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, engine, sessionId }), signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new TaskWorktreeError("Queue transfer was not acknowledged by its owner; wait for dispatch to finish and retry");
  const snapshot = await response.json() as { events: ReplicationEvent[] };
  await receiveReplicationBatch(snapshot);
}

async function takeLocalSessionOwnership(project: ProjectRecord, payload: z.infer<typeof routedSessionTakeOwnershipSchema>): Promise<{ sessionPath: string; ownership: ConversationOwnership; pendingPeerIds: string[] }> {
  const [local, sessions, peers] = await Promise.all([getClusterNode(), listHarnessSessions(project), listClusterPeers()]);
  if (payload.peerId !== local.id) throw new Error("Takeover destination is not this node");
  const matching = payload.sessionId ? sessions.find((session) => session.id === payload.sessionId) : sessions.find((session) => session.path === payload.sessionPath);
  if (!matching) throw new TaskWorktreeError("Conversation was not found on the destination node");
  await assertDraftTakeoverReady(project, matching, local.id, peers);
  const engine: ConversationEngine = matching.harnessId;
  const sessionId = matching.id;
  if (conversationIsActive(project.id, engine, sessionId, matching.path)) throw new TaskWorktreeError("Wait for the current turn to finish before taking ownership");
  await synchronizeQueueBeforeTakeover(project.id, engine, sessionId, local.id, peers);
  const ownership = await takeConversationOwnership(engine, sessionId, local.id);
  const settled = await Promise.allSettled(peers.map((peer) => applyOwnershipToPeer(peer, ownership, local.id)));
  const pendingPeerIds: string[] = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === "rejected") {
      const error = result.reason;
      if (error instanceof TypeError || error instanceof DOMException && error.name === "TimeoutError") { pendingPeerIds.push(peers[index].id); continue; }
      throw error;
    }
    if (!result.value.accepted || !sameConversationOwnership(result.value.current ?? undefined, ownership)) {
      throw new Error(`Peer rejected ownership state: ${JSON.stringify(result.value.current)}`);
    }
  }
  return { sessionPath: matching.path, ownership, pendingPeerIds };
}

app.put("/api/projects/:projectId/sessions/reviewed", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const submitted = sessionReviewedSchema.parse(request.body);
    const tasks = await listTasks(project.id);
    const sessions = await listHarnessSessions({
      ...project,
      additionalPaths: tasks.flatMap((task) => task.worktreePath ? [task.worktreePath] : []),
    });
    const session = sessions.find((candidate) => candidate.path === submitted.sessionPath);
    if (!session) { sendError(response, 404, "Conversation not found"); return; }
    if (!session.updatedAt || submitted.updatedAt > session.updatedAt) { sendError(response, 409, "Conversation review watermark is newer than current activity"); return; }
    const authSession = response.locals.authSession as AuthSession;
    const local = await getClusterNode();
    markConversationReviewed(authSession.userId, authSession.username, project.id, { path: session.path, engine: session.harnessId, sessionId: session.id, updatedAt: submitted.updatedAt }, local.id);
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
    const tasks = await listTasks(project.id);
    const sessions = await listHarnessSessions({
      ...project,
      additionalPaths: tasks.flatMap((task) => task.worktreePath ? [task.worktreePath] : []),
    });
    const currentByPath = new Map(sessions.map((session) => [session.path, session]));
    const invalid = submitted.find((watermark) => {
      const current = currentByPath.get(watermark.sessionPath);
      return !current || !current.updatedAt || watermark.updatedAt > current.updatedAt;
    });
    if (invalid) { sendError(response, 409, `Conversation review watermark is stale or missing: ${invalid.sessionPath}`); return; }
    const authSession = response.locals.authSession as AuthSession;
    const local = await getClusterNode();
    markConversationsReviewed(authSession.userId, authSession.username, project.id, submitted.flatMap((watermark) => {
      const current = currentByPath.get(watermark.sessionPath)!;
      return [{ path: watermark.sessionPath, engine: current.harnessId, sessionId: current.id, updatedAt: watermark.updatedAt }];
    }), local.id);
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
    const projects = await projectsWithSharedNames(false);
    const groups = await Promise.all(projects.map(async (project) => {
      const sessions = await listProjectSessionsWithReviewState(project, authSession.userId, authSession.username);
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
    const projects = await projectsWithSharedNames(false);
    const groups = await Promise.all(projects.map(async (project) => {
      const sessions = await listProjectSessionsWithReviewState(project, authSession.userId, authSession.username);
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
          running: true,
        })),
      };
    }));
    response.json({ projects: groups.filter((group) => group.sessions.length > 0) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/sessions/take-ownership", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = routedSessionTakeOwnershipSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    response.json(await takeLocalSessionOwnership(project, payload));
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
    if (payload.peerId === local.id) { response.json(await takeLocalSessionOwnership(project, { ...payload, projectId: project.id })); return; }
    const peer = await getClusterPeer(payload.peerId);
    if (!peer) { sendError(response, 404, "Peer not found"); return; }
    const routed = await fetch(`${peer.url}/api/cluster/sessions/take-ownership`, {
      method: "POST", headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, projectId: project.id }), signal: AbortSignal.timeout(35_000),
    });
    response.status(routed.status).json(await routed.json());
  } catch (error) { next(error); }
});

app.post("/api/projects/:projectId/sessions/recover", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const payload = sessionRecoverySchema.parse(request.body);
    const local = await getClusterNode();
    const mapped = resolveLocalSessionPath(payload.sessionPath);
    if (mapped.engine !== "pi") throw new Error("Only Pi transcripts support conflict recovery");
    if (conversationSessionIsOpen(project.id, "pi", payload.sessionId, mapped.path)) throw new Error("Close the local conversation before recovery");
    await requireLocalConversationOwner("pi", payload.sessionId);
    const peers = await listClusterPeers();
    const fenced = await beginConversationRecovery("pi", payload.sessionId, local.id);
    await replicateExactOwnership(peers, fenced, local.id);
    if (conversationSessionIsOpen(project.id, "pi", payload.sessionId, mapped.path)) throw new Error("Conversation opened during recovery fencing");
    const snapshot = await capturePiRecoverySnapshot(mapped.path);
    const names = await readdir(path.dirname(mapped.path));
    await recoverPiSessionDirectory(path.dirname(mapped.path), names, snapshot, project.path);
    const owned = await finishConversationRecovery("pi", payload.sessionId, local.id);
    await replicateExactOwnership(peers, owned, local.id);
    response.json({ ownership: owned, sessionPath: mapped.path });
  } catch (error) { next(error); }
});

class ConversationDeleteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function deleteLocalConversation(project: ProjectRecord, engine: ConversationEngine, sessionId: string, taskId?: string): Promise<void> {
  await assertProjectEditable(project);
  const tasks = await listTasks(project.id);
  const ticket = taskId ? tasks.find((task) => task.id === taskId) : undefined;
  if (ticket?.status === "done" || await conversationBelongsToDoneTask(project.id, engine, sessionId)) {
    throw new ConversationDeleteError(409, "Done ticket conversations are read-only");
  }
  const sessions = await listHarnessSessions({ ...project, additionalPaths: tasks.flatMap((task) => task.worktreePath ? [task.worktreePath] : []) });
  const session = sessions.find((candidate) => candidate.id === sessionId && (candidate.path.startsWith("draft:claude:") || candidate.path.startsWith("claude:") ? "claude" : "pi") === engine);
  if (!session) throw new ConversationDeleteError(404, "Session not found");
  await requireLocalConversationOwner(engine, sessionId);
  const local = await getClusterNode();
  // Harness-switched segments are one conversation; removing it removes every segment.
  const targets: Array<{ engine: ConversationEngine; sessionId: string; path: string; draft?: boolean }> = [
    { engine, sessionId, path: session.path, ...(session.draft ? { draft: true } : {}) },
    ...(session.segments ?? []).filter((segment) => !(segment.sessionId === sessionId && segment.engine === engine)),
  ];
  for (const [index, target] of targets.entries()) {
    if (target.draft || target.path.startsWith("draft:")) {
      await deleteConversationRecord(project.id, target.engine, target.sessionId, local.id);
      continue;
    }
    const filePath = target.path.startsWith("claude:") ? target.path.slice("claude:".length) : target.path;
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
      const peer = await getClusterPeer(ownership.ownerNodeId);
      if (!peer) throw new ConversationDeleteError(409, "Conversation owner is unavailable");
      const routed = await fetch(`${peer.url}/api/cluster/sessions/delete`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" },
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

app.delete("/api/cluster/sessions/delete", async (request, response, next) => {
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
