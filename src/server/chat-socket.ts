import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { sessionCookieName, sessionForId } from "../auth.js";
import { getClusterMachineToken, getClusterNode, getClusterPeer } from "../cluster.js";
import { type ConversationEngine, getConversationOwnership } from "../conversation-ownership.js";
import { ensureConversationRecord, getConversationRecord, parseConversationDraftPath } from "../conversation-records.js";
import { findHarnessSession, harnessForSessionPath, listHarnesses, listHarnessSessions } from "../harnesses.js";
import { getProjectLock } from "../project-locks.js";
import { resolveLocalSessionPath } from "../session-paths.js";
import { getProject } from "../store.js";
import { getSettings } from "../settings.js";
import { listTasks } from "../tasks.js";
import { attachTerminalSession } from "../terminal-session.js";
import type { ProjectRecord, SessionSummary } from "../types.js";
import { webSocketCloseReason } from "../websocket.js";
import { proxySocket, sessionWatcher } from "./chat.js";
import { attachHarnessChat } from "./harness-chat.js";
import { conversationBelongsToDoneTask, taskConversationIdentity } from "./cluster-helpers.js";
import { machineCredentialNodeId, machineTokenMatches } from "./http-auth.js";
import { attachBrowserViewer } from "./browser.js";
import { broadcastToProject, send } from "./realtime.js";
import { socketSecretAccountIdsSchema, socketTaskIdSchema } from "./schemas.js";
import { type ForeignConversationOwner, openConversationOwnership } from "./sessions-helpers.js";
import { watchClients, webSocketServer } from "./state.js";
import { ownerPeer } from "./task-handoff.js";
import { mergeReservations, taskCwd, taskHandoffContext, taskTerminalCounts } from "./task-runs.js";

function describeSessionRequest(rawSessionPath: string | null) {
  const selected = rawSessionPath ?? listHarnesses()[0].paths.newSession;
  const draft = parseConversationDraftPath(selected);
  const adapter = draft ? listHarnesses().find(({ id }) => id === draft.engine) : harnessForSessionPath(selected);
  if (!adapter) throw new Error(`No harness registered for conversation engine: ${draft!.engine}`);
  return { draft, engine: adapter.id, sessionPath: draft || selected === adapter.paths.newSession ? undefined : selected };
}

function isNewSessionPath(value: string | null): boolean {
  return Boolean(value && listHarnesses().some((adapter) => adapter.paths.newSession === value));
}

async function directSessionForOpen(project: ProjectRecord, sessionPath: string, sessionId: string): Promise<SessionSummary | undefined> {
  const request = describeSessionRequest(sessionPath);
  if (!request.sessionPath || request.draft) return undefined;
  const record = await getConversationRecord(project.id, request.engine, sessionId);
  if (record?.conversationId) return undefined;
  return findHarnessSession(project, request.engine, sessionPath, sessionId);
}

webSocketServer.on("connection", async (socket, request) => {
  const host = request.headers.host;
  const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : "";
  const machineBearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  const url = new URL(request.url ?? "/", `http://${host || "localhost"}`);
  const browserMode = url.searchParams.get("mode");
  const browserMachineId = machineBearer && browserMode === "browser" ? await machineCredentialNodeId(machineBearer) : undefined;
  const machineAuthenticated = Boolean(browserMachineId || (machineBearer && machineTokenMatches(machineBearer, await getClusterMachineToken())));
  const origin = request.headers.origin;
  const cookiePrefix = `${sessionCookieName}=`;
  const session = sessionForId(request.headers.cookie?.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(cookiePrefix))?.slice(cookiePrefix.length));
  let browserAuthenticated = false;
  try {
    browserAuthenticated = Boolean(host && typeof origin === "string" && new URL(origin).host === host && session && !session.mustChangePassword);
  } catch {
    browserAuthenticated = false;
  }
  if (!machineAuthenticated && !browserAuthenticated) {
    socket.close(1008, "Unauthorized");
    return;
  }

  if (browserMode && !["browser", "terminal"].includes(browserMode)) { socket.close(1008, "Unsupported socket mode"); return; }
  if (browserMode === "browser") {
    const controllerId = browserMachineId ? url.searchParams.get("controllerId") : session?.userId;
    if (!controllerId || controllerId.length > 500) { socket.close(1008, "Browser controller identity required"); return; }
    await attachBrowserViewer(socket, url, { kind: "human", id: browserMachineId ? controllerId : `${(await getClusterNode()).id}:${controllerId}` }, browserMachineId);
    return;
  }
  const projectId = url.searchParams.get("projectId") ?? "";
  const project = await getProject(projectId);
  if (!project) {
    socket.close(1008, "Project not found");
    return;
  }
  const taskIdResult = socketTaskIdSchema.safeParse(url.searchParams.get("taskId"));
  if (url.searchParams.has("taskId") && !taskIdResult.success) {
    socket.close(1008, "Invalid task ID");
    return;
  }
  const taskId = taskIdResult.success ? taskIdResult.data : undefined;
  const rawSessionPathFromUrl = url.searchParams.get("sessionPath");
  const suppliedSessionId = url.searchParams.get("sessionId");
  const sourceTaskIdResult = socketTaskIdSchema.safeParse(url.searchParams.get("sourceTaskId"));
  if (url.searchParams.has("sourceTaskId") && !sourceTaskIdResult.success) {
    socket.close(1008, "Invalid source task ID");
    return;
  }
  const sourceTaskId = sourceTaskIdResult.success ? sourceTaskIdResult.data : undefined;
  const canMatchTaskSession = rawSessionPathFromUrl && rawSessionPathFromUrl !== "watch" && !isNewSessionPath(rawSessionPathFromUrl);
  const tasks = taskId || sourceTaskId || canMatchTaskSession ? await listTasks(project.id) : [];
  const task = taskId
    ? tasks.find((candidate) => candidate.id === taskId)
    : tasks.find((candidate) => candidate.sessionPath === rawSessionPathFromUrl);
  const taskIdentity = task && rawSessionPathFromUrl !== "watch" ? taskConversationIdentity(task) : null;
  const requestedSessionId = suppliedSessionId ?? taskIdentity?.sessionId ?? null;
  const sourceTask = sourceTaskId ? tasks.find((candidate) => candidate.id === sourceTaskId) : undefined;
  if (sourceTaskId && (!sourceTask || sourceTask.status !== "done")) {
    socket.close(1008, "Source ticket is not Done");
    return;
  }
  if (sourceTaskId && !isNewSessionPath(rawSessionPathFromUrl)) {
    socket.close(1008, "A follow-up must start a new conversation");
    return;
  }
  if (taskId && !task) {
    socket.close(1008, "Task not found");
    return;
  }
  const local = await getClusterNode();
  if (task?.executionState === "handoff_pending") {
    socket.close(1008, "Task handoff is awaiting destination commit");
    return;
  }
  if (task && task.currentNodeId !== local.id) {
    const peer = await ownerPeer(task, local.id);
    if (!peer) {
      socket.close(1011, "Task owner is unavailable");
      return;
    }
    const ownerUrl = new URL("/ws", peer.url);
    ownerUrl.protocol = ownerUrl.protocol === "https:" ? "wss:" : "ws:";
    ownerUrl.searchParams.set("projectId", project.id);
    ownerUrl.searchParams.set("sessionPath", rawSessionPathFromUrl ?? "new");
    ownerUrl.searchParams.set("taskId", task.id);
    if (requestedSessionId) ownerUrl.searchParams.set("sessionId", requestedSessionId);
    // A terminal socket must stay a terminal socket on the owner, not become a session.
    if (url.searchParams.get("mode") === "terminal") ownerUrl.searchParams.set("mode", "terminal");
    proxySocket(socket, new WebSocket(ownerUrl, { headers: { Authorization: `Bearer ${peer.token}` } }));
    return;
  }
  const requestedNodeId = url.searchParams.get("nodeId");
  let routingEngine: ConversationEngine;
  try {
    routingEngine = rawSessionPathFromUrl === "watch" ? listHarnesses()[0].id : describeSessionRequest(rawSessionPathFromUrl).engine;
  } catch (error) {
    socket.close(1008, webSocketCloseReason(error instanceof Error ? error.message : "Invalid conversation path"));
    return;
  }
  if (browserAuthenticated && !task) {
    const ownership = requestedSessionId ? await getConversationOwnership(routingEngine, requestedSessionId) : undefined;
    const targetNodeId = requestedNodeId || ownership?.ownerNodeId;
    if (targetNodeId && targetNodeId !== local.id) {
      const peer = await getClusterPeer(targetNodeId);
      if (!peer) { socket.close(1011, "Execution node is unavailable"); return; }
      const ownerUrl = new URL("/ws", peer.url);
      ownerUrl.protocol = ownerUrl.protocol === "https:" ? "wss:" : "ws:";
      for (const [key, value] of url.searchParams) ownerUrl.searchParams.set(key, value);
      if (!requestedSessionId && isNewSessionPath(rawSessionPathFromUrl)) {
        const sessionId = randomUUID();
        await ensureConversationRecord(project.id, routingEngine, sessionId, local.id);
        ownerUrl.searchParams.set("sessionId", sessionId);
      }
      ownerUrl.searchParams.delete("nodeId");
      ownerUrl.searchParams.set("nodeSession", "1");
      proxySocket(socket, new WebSocket(ownerUrl, { headers: { Authorization: `Bearer ${peer.token}` } }));
      return;
    }
  }
  if (machineAuthenticated) {
    const routedSession = url.searchParams.get("nodeSession") === "1";
    if (!task && !routedSession) {
      socket.close(1008, "Unauthorized");
      return;
    }
  }
  // Only a browser sitting on this node is blocked. A socket routed here by a peer already
  // passed that peer's check, and the read-only `watch` socket below is never blocked.
  const heldLock = browserAuthenticated ? await getProjectLock(project.id) : undefined;
  const lockedByPeer = heldLock && heldLock.nodeId !== local.id ? heldLock : undefined;

  if (url.searchParams.get("mode") === "terminal") {
    if (lockedByPeer) {
      socket.close(1008, `Project is locked by ${lockedByPeer.nodeName}`);
      return;
    }
    if (task) {
      const mergeBusy = task.mergeState === "conflicts" || task.mergeState === "resolved" || mergeReservations.has(task.id);
      if (mergeBusy) {
        socket.close(4030, "Ticket merge in progress");
        return;
      }
      const count = (taskTerminalCounts.get(task.id) ?? 0) + 1;
      taskTerminalCounts.set(task.id, count);
      socket.once("close", () => {
        const remaining = (taskTerminalCounts.get(task.id) ?? 1) - 1;
        if (remaining <= 0) taskTerminalCounts.delete(task.id);
        else taskTerminalCounts.set(task.id, remaining);
      });
    }
    attachTerminalSession(socket, task ? taskCwd(project, task) : project.path, local.id);
    return;
  }

  let rawSessionPath = rawSessionPathFromUrl;
  const sessionSearchProject = { ...project, additionalPaths: tasks.flatMap((candidate) => candidate.worktreePath ? [candidate.worktreePath] : []) };
  let listedSessions: SessionSummary[] | undefined;
  // Chosen in the new-conversation dialog; a conversation has no id yet at this point, so the
  // accounts travel with the connection until the engine reports one (FR9.4).
  const secretAccountIds = socketSecretAccountIdsSchema.parse((url.searchParams.get("secretAccountIds") ?? "").split(",").filter(Boolean));
  if (requestedSessionId && rawSessionPath && rawSessionPath !== "watch") {
    const direct = await directSessionForOpen(sessionSearchProject, rawSessionPath, requestedSessionId);
    listedSessions = direct ? [direct] : await listHarnessSessions(sessionSearchProject);
    const listedIdentity = listedSessions.some((candidate) => candidate.id === requestedSessionId || candidate.conversationId === requestedSessionId
      || candidate.segments?.some((segment) => segment.sessionId === requestedSessionId));
    if (!listedIdentity) {
      const recovered = await findHarnessSession(sessionSearchProject, routingEngine, rawSessionPath, requestedSessionId);
      if (recovered) listedSessions = [recovered];
    }
    if (task?.sessionPath && taskIdentity?.sessionId === requestedSessionId) rawSessionPath = resolveLocalSessionPath(task.sessionPath).path;
    else {
      const matching = listedSessions.find((candidate) => candidate.id === requestedSessionId);
      if (matching) rawSessionPath = matching.path;
    }
  }
  if (rawSessionPath === "watch") {
    // Session dirs may have appeared since startup (first session, new sync).
    sessionWatcher.ensureProject(project);
    const clients = watchClients.get(project.id) ?? new Set<WebSocket>();
    clients.add(socket);
    watchClients.set(project.id, clients);
    send(socket, { type: "watchReady" });
    socket.on("message", (raw) => {
      const payload = JSON.parse((raw as Buffer).toString()) as { type?: string };
      if (payload.type === "ping") send(socket, { type: "pong" });
    });
    socket.on("close", () => clients.delete(socket));
    return;
  }

  if (lockedByPeer) {
    socket.close(1008, `Project is locked by ${lockedByPeer.nodeName}`);
    return;
  }

  let sessionRequest: ReturnType<typeof describeSessionRequest>;
  try { sessionRequest = describeSessionRequest(rawSessionPath); }
  catch (error) { socket.close(1008, webSocketCloseReason(error instanceof Error ? error.message : "Invalid conversation path")); return; }
  let requestedTask = sessionRequest.sessionPath ? tasks.find((candidate) => candidate.sessionPath === sessionRequest.sessionPath) : undefined;
  let cwd = requestedTask ? taskCwd(project, requestedTask) : project.path;
  // Ticket conversations live in the ticket workspace, not the project directory,
  // so this must search the same paths the conversation list searches.
  if ((sessionRequest.sessionPath || sessionRequest.draft) && !listedSessions) listedSessions = await listHarnessSessions(sessionSearchProject);
  let listedSession = listedSessions?.find((candidate) => candidate.path === (sessionRequest.draft ? rawSessionPath : sessionRequest.sessionPath)
    || Boolean(!sessionRequest.draft && taskIdentity && requestedSessionId === taskIdentity.sessionId && candidate.harnessId === taskIdentity.engine && candidate.id === taskIdentity.sessionId)
    || Boolean(sessionRequest.sessionPath && candidate.segments?.some((segment) => segment.path === sessionRequest.sessionPath)));
  if ((sessionRequest.sessionPath || sessionRequest.draft) && !listedSession) {
    socket.close(1008, "Conversation not found");
    return;
  }
  // A conversation that switched harness lists only its newest segment; opening
  // any older segment's path opens the conversation itself. A path that is not
  // part of a listed group (an undiscovered ticket transcript) stays authoritative.
  const openedStaleSegment = Boolean(sessionRequest.sessionPath && listedSession?.segments?.some((segment) => segment.path === sessionRequest.sessionPath && segment.path !== listedSession.path));
  if (openedStaleSegment && listedSession) {
    rawSessionPath = listedSession.path;
    sessionRequest = describeSessionRequest(rawSessionPath);
    const redirectedTask = sessionRequest.sessionPath ? tasks.find((candidate) => candidate.sessionPath === sessionRequest.sessionPath) : undefined;
    if (redirectedTask) {
      requestedTask = redirectedTask;
      cwd = taskCwd(project, redirectedTask);
    }
  }
  if (sessionRequest.draft && (!listedSession?.draft || listedSession.id !== sessionRequest.draft.sessionId || !await getConversationRecord(project.id, sessionRequest.draft.engine, sessionRequest.draft.sessionId))) {
    socket.close(1008, "Conversation not found");
    return;
  }
  let spinOffContext: string | null = null;
  if (sourceTask) {
    if (!sourceTask.sessionPath) {
      socket.close(1008, "Source ticket has no conversation");
      return;
    }
    try {
      const localSessionPath = resolveLocalSessionPath(sourceTask.sessionPath).path;
      spinOffContext = sourceTask.handoffContext ?? await taskHandoffContext(project, { ...sourceTask, sessionPath: localSessionPath });
    } catch (error) {
      socket.close(1008, webSocketCloseReason(error instanceof Error ? error.message : "Source conversation is unavailable"));
      return;
    }
  }
  const validRequestedSessionId = requestedSessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedSessionId) ? requestedSessionId : undefined;
  const ownershipSessionId = listedSession && !listedSession.draft ? listedSession.id : sessionRequest.draft?.sessionId ?? validRequestedSessionId ?? randomUUID();
  const sessionReadOnly = listedSession?.readOnly === true;
  let foreignOwner: ForeignConversationOwner | null = null;
  if (!sessionReadOnly) {
    try {
      foreignOwner = await openConversationOwnership(sessionRequest.engine, ownershipSessionId, local.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Conversation ownership claim failed";
      // A new conversation with no owner is unusable, but an existing one still
      // reads fine: the send-time fence catches whatever the claim could not.
      if (!listedSession) {
        socket.close(1008, webSocketCloseReason(message));
        return;
      }
      console.warn("Conversation ownership claim failed on open", error);
    }
  }
  const refreshSessionsAfterReady = !listedSession || listedSession.draft;
  if (refreshSessionsAfterReady) {
    try {
      await ensureConversationRecord(project.id, sessionRequest.engine, ownershipSessionId, local.id);
    } catch (error) {
      // A browser still naming a conversation that was deleted (here or on a peer)
      // must get a close, not an unhandled rejection that kills the node.
      if (error instanceof Error && error.message === "Conversation record was deleted") {
        socket.close(1008, webSocketCloseReason("Conversation not found"));
        return;
      }
      throw error;
    }
  }
  const conversationReadOnly = sessionReadOnly || task?.status === "done" || await conversationBelongsToDoneTask(project.id, sessionRequest.engine, ownershipSessionId);
  try {
    const startCommand = getSettings().conversationCommands.start;
    await attachHarnessChat({
      socket, project, taskId: task?.id ?? null, cwd, engine: sessionRequest.engine,
      sessionId: ownershipSessionId, sessionPath: sessionRequest.sessionPath,
      accountIds: secretAccountIds, readOnly: conversationReadOnly, ownership: foreignOwner,
      listedSessions, handoffContext: spinOffContext,
      autoStartPrompt: refreshSessionsAfterReady && !sessionRequest.draft && startCommand.enabled ? startCommand.prompt : null,
    });
    if (refreshSessionsAfterReady) broadcastToProject(project.id, { type: "sessionsChanged" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start conversation";
    send(socket, { type: "error", error: message });
    socket.close(1011, webSocketCloseReason(message));
  }

});
