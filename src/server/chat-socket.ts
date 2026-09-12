import { randomUUID } from "node:crypto";
import path from "node:path";
import WebSocket from "ws";
import { sessionCookieName, sessionForId } from "../auth.js";
import { buildHandoffContext, claudeRunIdFromSessionPath, claudeSessionContextUsage, loadClaudeMessages } from "../claude-service.js";
import { getClusterMachineToken, getClusterNode, getClusterPeer } from "../cluster.js";
import { type ConversationEngine, ConversationOwnershipError, getConversationOwnership } from "../conversation-ownership.js";
import { ensureConversationRecord, getConversationRecord, parseConversationDraftPath } from "../conversation-records.js";
import { conversationTranscriptPayload } from "../conversation-segments.js";
import { listHarnessSessions } from "../harnesses.js";
import { getSessionStatus, simplifyMessages } from "../pi-service.js";
import { getProjectLock } from "../project-locks.js";
import { listQueuedPrompts } from "../prompt-queue.js";
import { resolveLocalSessionPath } from "../session-paths.js";
import { getProject } from "../store.js";
import { listTasks } from "../tasks.js";
import { attachTerminalSession } from "../terminal-session.js";
import type { SessionSummary } from "../types.js";
import { webSocketCloseReason } from "../websocket.js";
import { chatConnections, refreshPromptQueue, restoreClaudeQueueSettings, claudeConnectionKey, claudeQueueKey, claudeRunKey, claudeStatus, drainClaudePromptQueue, emptyClaudeState, getSharedSession, handleChatMessage, proxySocket, sessionWatcher } from "./chat.js";
import { conversationBelongsToDoneTask, taskConversationIdentity } from "./cluster-helpers.js";
import { machineCredentialNodeId, machineTokenMatches } from "./http-auth.js";
import { attachBrowserViewer } from "./browser.js";
import { broadcastToProject, chatErrorMessage, parseSessionPath, scheduleIdleDispose, send, sendStatus } from "./realtime.js";
import { socketSecretAccountIdsSchema, socketTaskIdSchema } from "./schemas.js";
import { describeConversationOwner, type ForeignConversationOwner, openConversationOwnership } from "./sessions-helpers.js";
import { activeClaudeConnections, type ChatConnection, claudeClients, recoveredClaudeChats, type SharedPiSession, watchClients, webSocketServer } from "./state.js";
import { ownerPeer } from "./task-handoff.js";
import { mergeReservations, taskCwd, taskHandoffContext, taskTerminalCounts } from "./task-runs.js";

function describeSessionRequest(rawSessionPath: string | null) {
  const draft = parseConversationDraftPath(rawSessionPath);
  return {
    draft,
    engine: (draft?.engine ?? (rawSessionPath?.startsWith("claude:") ? "claude" : "pi")) as ConversationEngine,
    sessionPath: draft ? undefined : parseSessionPath(rawSessionPath),
  };
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
  const canMatchTaskSession = rawSessionPathFromUrl && !["new", "watch", "claude:new"].includes(rawSessionPathFromUrl);
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
  if (sourceTaskId && !["new", "claude:new"].includes(rawSessionPathFromUrl ?? "")) {
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
  const routingDraft = parseConversationDraftPath(rawSessionPathFromUrl);
  const routingEngine: ConversationEngine = routingDraft?.engine ?? (rawSessionPathFromUrl?.startsWith("claude:") ? "claude" : "pi");
  if (browserAuthenticated && !task) {
    const ownership = requestedSessionId ? await getConversationOwnership(routingEngine, requestedSessionId) : undefined;
    const targetNodeId = requestedNodeId || ownership?.ownerNodeId;
    if (targetNodeId && targetNodeId !== local.id) {
      const peer = await getClusterPeer(targetNodeId);
      if (!peer) { socket.close(1011, "Execution node is unavailable"); return; }
      const ownerUrl = new URL("/ws", peer.url);
      ownerUrl.protocol = ownerUrl.protocol === "https:" ? "wss:" : "ws:";
      for (const [key, value] of url.searchParams) ownerUrl.searchParams.set(key, value);
      if (!requestedSessionId && ["new", "claude:new"].includes(rawSessionPathFromUrl ?? "")) {
        const sessionId = randomUUID();
        await ensureConversationRecord(project.id, routingEngine, sessionId, local.id);
        broadcastToProject(project.id, { type: "sessionsChanged" });
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
  if (requestedSessionId && rawSessionPath !== "watch") {
    listedSessions = await listHarnessSessions(sessionSearchProject);
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

  let sessionRequest = describeSessionRequest(rawSessionPath);
  let recovered = sessionRequest.sessionPath ? recoveredClaudeChats.get(claudeRunKey(project.id, sessionRequest.sessionPath)) : undefined;
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
    recovered = sessionRequest.sessionPath ? recoveredClaudeChats.get(claudeRunKey(project.id, sessionRequest.sessionPath)) : undefined;
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
  if (!listedSession || listedSession.draft) {
    try {
      await ensureConversationRecord(project.id, sessionRequest.engine, ownershipSessionId, local.id);
      broadcastToProject(project.id, { type: "sessionsChanged" });
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
  let connection: ChatConnection = {
    socket, project, taskId: task?.id ?? null, cwd, engine: "pi", shared: null,
    claude: emptyClaudeState(ownershipSessionId, !sessionRequest.sessionPath), handoffContext: spinOffContext, secretAccountIds, readOnly: sessionReadOnly,
  };

  if (sessionRequest.engine === "claude") {
    // The client sends the conversation-list summary id (`claude:<id>.jsonl`),
    // which never matches the bare run id, so resolve the id from the path.
    const requestedClaudeId = sessionRequest.sessionPath ? claudeRunIdFromSessionPath(sessionRequest.sessionPath) : ownershipSessionId;
    const active = activeClaudeConnections.get(claudeConnectionKey(project.id, requestedClaudeId));
    if (recovered) {
      connection = {
        socket, project, taskId: task?.id ?? null, cwd, engine: "claude", shared: null,
        claude: recovered.claude, handoffContext: null, secretAccountIds,
      };
      connection.claude.sessionName = listedSession?.title ?? null;
      recovered.connection = connection;
    } else if (active?.claude.child) {
      active.socket = socket;
      connection = active;
    } else {
      connection.engine = "claude";
      if (sessionRequest.sessionPath) {
        try {
          connection.claude.transcript = await loadClaudeMessages(sessionRequest.sessionPath);
          connection.claude.contextUsage = await claudeSessionContextUsage(sessionRequest.sessionPath) ?? null;
          connection.claude.filePath = path.resolve(sessionRequest.sessionPath.replace(/^claude:/, ""));
          connection.claude.sessionId = path.basename(connection.claude.filePath, ".jsonl");
          connection.claude.sessionName = listedSession?.title ?? null;
        } catch (error) {
          send(socket, { type: "error", error: error instanceof Error ? error.message : "Could not load Claude session" });
        }
      }
    }
    restoreClaudeQueueSettings(connection);
    claudeClients.set(socket, connection);
    const transcript = await conversationTranscriptPayload(project.id, "claude", connection.claude.sessionId, listedSessions, connection.claude.transcript);
    if (sessionRequest.draft && transcript.segments.length > 1) connection.handoffContext = buildHandoffContext(transcript.messages);
    send(socket, {
      type: "ready",
      project,
      engine: "claude",
      sessionId: connection.claude.sessionId ?? "claude:new",
      sessionFile: connection.claude.filePath ? `claude:${connection.claude.filePath}` : null,
      messages: transcript.messages,
      conversationId: transcript.conversationId ?? connection.claude.sessionId ?? undefined,
      ...(transcript.segments.length > 1 ? { segments: transcript.segments } : {}),
      status: claudeStatus(connection),
      ownership: foreignOwner,
      executionNodeId: local.id,
      readOnly: conversationReadOnly,
    });
    // Replay the in-flight turn so a reconnecting client sees the text and tool
    // calls that streamed while its socket was down.
    for (const event of connection.claude.liveEvents) send(socket, event);
    // The queue belongs to the conversation, not to the socket that typed into
    // it, so a reconnect sees what is still pending and a node that restarted
    // with prompts on disk picks them up here.
    refreshPromptQueue(connection);
  } else {
    let sharedSession: SharedPiSession;
    try {
      sharedSession = await getSharedSession(project.id, cwd, sessionRequest.sessionPath, ownershipSessionId, secretAccountIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start Pi session";
      send(socket, { type: "error", error: message });
      socket.close(1011, webSocketCloseReason(message));
      return;
    }

    connection.shared = sharedSession;
    sharedSession.clients.add(socket);
    const transcript = await conversationTranscriptPayload(project.id, "pi", sharedSession.handle.session.sessionId, listedSessions, simplifyMessages(sharedSession.handle.session.messages as unknown[]));
    // A fork can materialize an empty Pi segment to preserve its model/tools.
    // It still needs the preceding harness history on its first prompt.
    if ((sessionRequest.draft || sharedSession.handle.session.messages.length === 0) && transcript.segments.length > 1) connection.handoffContext = buildHandoffContext(transcript.messages);
    send(socket, {
      type: "ready",
      project,
      engine: "pi",
      sessionId: sharedSession.handle.session.sessionId,
      sessionFile: sharedSession.handle.session.sessionFile,
      messages: transcript.messages,
      conversationId: transcript.conversationId ?? sharedSession.handle.session.sessionId,
      ...(transcript.segments.length > 1 ? { segments: transcript.segments } : {}),
      status: getSessionStatus(sharedSession.handle.session, sharedSession.handle.safeguardsEnabled),
      ownership: foreignOwner,
      executionNodeId: local.id,
      readOnly: conversationReadOnly,
    });
  }

  chatConnections.add(connection);
  refreshPromptQueue(connection);
  if (!foreignOwner && !conversationReadOnly) void drainClaudePromptQueue(connection).catch((error) => send(socket, { type: "error", error: chatErrorMessage(error) }));

  socket.on("message", async (raw) => {
    try {
      await handleChatMessage(connection, raw as Buffer);
    } catch (error) {
      const message = chatErrorMessage(error);
      send(socket, { type: "error", error: message });
      if (error instanceof ConversationOwnershipError) {
        send(socket, { type: "ownership", ownership: await describeConversationOwner(error.ownership, local.id) });
      }
      if (connection.engine === "pi" && connection.shared) sendStatus(socket, connection.shared.handle);
    }
  });

  socket.on("close", () => {
    chatConnections.delete(connection);
    if (connection.shared) {
      connection.shared.clients.delete(socket);
      scheduleIdleDispose(connection.shared);
    }
    // Claude owns its child process on this execution node. Browser and proxy
    // disconnects must not cancel an in-flight turn.
    claudeClients.delete(socket);
    if (recovered && recovered.connection === connection) recovered.connection = null;
  });
});
